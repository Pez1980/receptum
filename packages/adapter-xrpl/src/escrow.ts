import type {
  EscrowHandle,
  EscrowRail,
  EscrowState,
  EscrowStatus,
  Sha256Hex,
} from "@receptum/core";
import { isSha256Hex } from "@receptum/core";
import {
  isDeletedNode,
  rippleTimeToISOTime,
  unixTimeToRippleTime,
  type Client,
  type LedgerEntry,
  type Wallet,
} from "xrpl";
import { fulfillmentMatches } from "./condition.js";
import {
  formatEscrowId,
  fromXrplAmount,
  parseEscrowId,
  parseReceiptMemos,
  receiptMemos,
  toXrplAmount,
  type XrplAmount,
} from "./encoding.js";
import {
  accountTxs,
  compareTx,
  errorCode,
  getTx,
  submit,
  validatedCloseTime,
  XRPL_TESTNET,
  type LedgerTx,
} from "./ledger.js";

export const XRPL_ESCROW_RAIL = "escrow:xrpl";

export interface XrplEscrowRailOptions {
  /** A connected xrpl.js client. */
  client: Client;
  /** Signs deliver/release/refund (and createEscrow). Keys stay with the integrator. */
  wallet?: Wallet;
  /** CAIP-2 id of the network the client is connected to. Default `xrpl:1` (testnet). */
  network?: string;
  /**
   * Returns the PREIMAGE-SHA-256 fulfillment for an escrow, once the buyer has
   * accepted delivery. Required to release.
   */
  fulfillment?: (escrowId: string) => string | undefined | Promise<string | undefined>;
  /** Fractional digits that map issued-token values to integer amounts. Default 6. */
  iouDecimals?: number;
  /** account_tx pages (200 txs each) scanned when looking for deliveries. Default 10. */
  maxHistoryPages?: number;
}

export interface CreateEscrowParams {
  /** Seller's classic address (the escrow Destination). */
  seller: string;
  /** Integer amount in the asset's smallest unit (drops for XRP). */
  amount: string;
  /** "XRP" or "<currency>.<issuer>" (issued tokens need the TokenEscrow amendment). */
  asset: string;
  /** Latest delivery time the buyer agreed to. */
  deliverBy: Date;
  /** Buyer's review window after `deliverBy`; CancelAfter = deliverBy + review window. */
  reviewWindowSeconds: number;
  /** PREIMAGE-SHA-256 condition (hex) from `newEscrowSecret()`; the buyer keeps the preimage. */
  condition: string;
}

type EscrowFields = Pick<LedgerEntry.Escrow, "Account" | "Destination" | "CancelAfter"> & {
  Amount: XrplAmount;
  Condition?: string;
  FinishAfter?: number;
  /** For an Escrow entry: the EscrowCreate that made it (escrows are never modified). */
  PreviousTxnID?: string;
};

/** Ripple-epoch seconds of a validated transaction's ledger close, if known. */
const rippleCloseTime = (t: LedgerTx): number | undefined =>
  t.closeTime ? unixTimeToRippleTime(Date.parse(t.closeTime)) : undefined;

/**
 * XRPL native Escrow as a Receptum `EscrowRail`.
 *
 * Each escrow is conditional (PREIMAGE-SHA-256) and cancellable: the seller can
 * only finish with the buyer's fulfillment, and the buyer can cancel after
 * CancelAfter. Delivery is a memo transaction from the seller that commits the
 * receiptHash and names the escrow. See README for the design and trade-offs.
 */
export class XrplEscrowRail implements EscrowRail {
  readonly id = XRPL_ESCROW_RAIL;
  readonly network: string;
  private readonly client: Client;
  private readonly decimals: number;
  private readonly maxPages: number;

  constructor(private readonly opts: XrplEscrowRailOptions) {
    this.client = opts.client;
    this.network = opts.network ?? XRPL_TESTNET;
    this.decimals = opts.iouDecimals ?? 6;
    this.maxPages = opts.maxHistoryPages ?? 10;
  }

  /** Buyer locks funds for the seller. Returns the handle and the EscrowCreate tx hash. */
  async createEscrow(params: CreateEscrowParams): Promise<EscrowHandle & { reference: string }> {
    const wallet = this.wallet();
    if (!Number.isSafeInteger(params.reviewWindowSeconds) || params.reviewWindowSeconds < 0) {
      throw new TypeError("reviewWindowSeconds must be a non-negative integer");
    }
    const cancelAfter =
      unixTimeToRippleTime(params.deliverBy.getTime()) + params.reviewWindowSeconds;
    const tx = await submit(this.client, wallet, {
      TransactionType: "EscrowCreate",
      Account: wallet.address,
      Destination: params.seller,
      Amount: toXrplAmount(params.asset, params.amount, this.decimals),
      Condition: params.condition.toUpperCase(),
      CancelAfter: cancelAfter,
    });
    const sequence = tx.tx.TicketSequence || tx.tx.Sequence;
    if (!sequence) throw new Error("EscrowCreate has no sequence");
    return {
      ...this.handle(formatEscrowId(wallet.address, sequence), {
        Account: wallet.address,
        Destination: params.seller,
        Amount: toXrplAmount(params.asset, params.amount, this.decimals),
        CancelAfter: cancelAfter,
      }),
      reference: tx.hash,
    };
  }

  /**
   * Escrow state from chronological ledger history: settlement from the EscrowFinish /
   * EscrowCancel that removed the entry; delivery from the FIRST successful receipt memo the
   * seller sent for this escrow after its EscrowCreate, no later than CancelAfter and before
   * settlement. Later memos are ignored.
   */
  async getEscrow(escrowId: string): Promise<EscrowState> {
    const open = await this.entry(escrowId);
    const closed = open ? null : await this.closing(escrowId);
    const fields = open ?? closed?.fields;
    if (!fields) throw new Error(`escrow ${escrowId} not found`);
    const created = await this.creation(escrowId, fields);
    const delivery = await this.delivery(escrowId, fields, created, closed?.tx);
    const status: EscrowStatus = closed
      ? closed.type === "EscrowFinish"
        ? "released"
        : "refunded"
      : delivery
        ? "delivered"
        : "open";
    return {
      ...this.handle(escrowId, fields),
      status,
      ...(delivery ? { receiptHash: delivery.receiptHash } : {}),
      ...(fields.FinishAfter ? { releasableAfter: rippleTimeToISOTime(fields.FinishAfter) } : {}),
    };
  }

  /** Seller commits the receipt hash with a memo transaction naming the escrow. */
  async deliver(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }> {
    if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be hex64");
    const wallet = this.wallet();
    const entry = await this.requireOpen(escrowId);
    if (entry.Destination !== wallet.address) throw new Error("only the seller can deliver");
    if (entry.CancelAfter && (await validatedCloseTime(this.client)) > entry.CancelAfter) {
      throw new Error("escrow is past CancelAfter; delivery can no longer be paid");
    }
    const tx = await submit(this.client, wallet, {
      TransactionType: "AccountSet",
      Account: wallet.address,
      Memos: receiptMemos(receiptHash, escrowId),
    });
    return { reference: tx.hash };
  }

  /** EscrowFinish with the buyer's fulfillment. Anyone holding it may submit; funds go to the seller. */
  async release(escrowId: string): Promise<{ reference: string }> {
    const wallet = this.wallet();
    const entry = await this.requireOpen(escrowId);
    const { owner, sequence } = parseEscrowId(escrowId);
    const now = await validatedCloseTime(this.client);
    if (entry.CancelAfter && now > entry.CancelAfter) {
      throw new Error("escrow is past CancelAfter; only a refund is possible");
    }
    if (entry.FinishAfter && now <= entry.FinishAfter) {
      throw new Error(`escrow cannot be finished before ${rippleTimeToISOTime(entry.FinishAfter)}`);
    }
    let fulfillment: string | undefined;
    if (entry.Condition) {
      fulfillment = (await this.opts.fulfillment?.(escrowId))?.toUpperCase();
      if (!fulfillment) throw new Error("release needs the buyer's fulfillment (not accepted yet)");
      if (!fulfillmentMatches(entry.Condition, fulfillment)) {
        throw new Error("fulfillment does not match the escrow condition");
      }
    }
    const tx = await submit(this.client, wallet, {
      TransactionType: "EscrowFinish",
      Account: wallet.address,
      Owner: owner,
      OfferSequence: sequence,
      ...(entry.Condition && fulfillment
        ? { Condition: entry.Condition, Fulfillment: fulfillment }
        : {}),
    });
    return { reference: tx.hash };
  }

  /** EscrowCancel once the ledger close time is past CancelAfter. Returns funds to the buyer. */
  async refund(escrowId: string): Promise<{ reference: string }> {
    const wallet = this.wallet();
    const entry = await this.requireOpen(escrowId);
    const { owner, sequence } = parseEscrowId(escrowId);
    if (!entry.CancelAfter) throw new Error("escrow has no CancelAfter; it cannot be refunded");
    if ((await validatedCloseTime(this.client)) <= entry.CancelAfter) {
      throw new Error(`escrow is not refundable until ${rippleTimeToISOTime(entry.CancelAfter)}`);
    }
    const tx = await submit(this.client, wallet, {
      TransactionType: "EscrowCancel",
      Account: wallet.address,
      Owner: owner,
      OfferSequence: sequence,
    });
    return { reference: tx.hash };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private wallet(): Wallet {
    if (!this.opts.wallet) throw new Error("this operation needs a wallet");
    return this.opts.wallet;
  }

  private handle(escrowId: string, f: EscrowFields): EscrowHandle {
    const { asset, amount } = fromXrplAmount(f.Amount, this.decimals);
    return {
      rail: this.id,
      network: this.network,
      escrowId,
      amount,
      asset,
      buyer: f.Account,
      seller: f.Destination,
      refundableAfter: f.CancelAfter ? rippleTimeToISOTime(f.CancelAfter) : "",
    };
  }

  /** The open escrow ledger entry, or null once it was finished or cancelled. */
  private async entry(escrowId: string): Promise<EscrowFields | null> {
    const { owner, sequence } = parseEscrowId(escrowId);
    try {
      const { result } = await this.client.request({
        command: "ledger_entry",
        escrow: { owner, seq: sequence },
        ledger_index: "validated",
      });
      return result.node as unknown as EscrowFields;
    } catch (err) {
      if (errorCode(err) === "entryNotFound") return null;
      throw err;
    }
  }

  private async requireOpen(escrowId: string): Promise<EscrowFields> {
    const entry = await this.entry(escrowId);
    if (!entry)
      throw new Error(`escrow ${escrowId} is not open (already finished, cancelled or unknown)`);
    return entry;
  }

  /** The EscrowFinish/EscrowCancel that removed the escrow, with its final fields. */
  private async closing(
    escrowId: string,
  ): Promise<{ type: "EscrowFinish" | "EscrowCancel"; fields: EscrowFields; tx: LedgerTx } | null> {
    const { owner, sequence } = parseEscrowId(escrowId);
    for await (const t of accountTxs(this.client, owner, this.maxPages)) {
      const type = t.tx.TransactionType;
      if (type !== "EscrowFinish" && type !== "EscrowCancel") continue;
      if (t.tx.Owner !== owner || Number(t.tx.OfferSequence) !== sequence) continue;
      const node = t.meta.AffectedNodes.find(
        (n) => isDeletedNode(n) && n.DeletedNode.LedgerEntryType === "Escrow",
      );
      if (node && isDeletedNode(node)) {
        return { type, fields: node.DeletedNode.FinalFields as unknown as EscrowFields, tx: t };
      }
    }
    return null;
  }

  /** The validated EscrowCreate for this escrow (via PreviousTxnID, else the owner's history). */
  private async creation(escrowId: string, fields: EscrowFields): Promise<LedgerTx> {
    const { owner, sequence } = parseEscrowId(escrowId);
    const isCreate = (t: LedgerTx | null): t is LedgerTx =>
      !!t &&
      t.tx.TransactionType === "EscrowCreate" &&
      t.tx.Account === owner &&
      (t.tx.TicketSequence || t.tx.Sequence) === sequence;
    if (fields.PreviousTxnID) {
      const t = await getTx(this.client, fields.PreviousTxnID);
      if (isCreate(t)) return t;
    }
    for await (const t of accountTxs(this.client, owner, this.maxPages)) if (isCreate(t)) return t;
    throw new Error(`EscrowCreate for ${escrowId} not found in ledger history`);
  }

  /**
   * First delivery memo by the seller for this escrow, in ledger order, strictly after the
   * EscrowCreate, with a close time ≤ CancelAfter and before the settling transaction.
   */
  private async delivery(
    escrowId: string,
    fields: EscrowFields,
    created: LedgerTx,
    settled?: LedgerTx,
  ): Promise<{ receiptHash: Sha256Hex; tx: LedgerTx } | null> {
    const seller = fields.Destination;
    const history = accountTxs(this.client, seller, this.maxPages, {
      forward: true,
      ...(created.ledgerIndex !== undefined ? { fromLedger: created.ledgerIndex } : {}),
    });
    for await (const t of history) {
      if (compareTx(t, created) <= 0) continue;
      if (settled && compareTx(t, settled) >= 0) break;
      const closeTime = rippleCloseTime(t);
      // Unknown close time can't be placed before CancelAfter: stop rather than guess.
      if (fields.CancelAfter && (closeTime === undefined || closeTime > fields.CancelAfter)) break;
      if (t.tx.Account !== seller) continue;
      const memo = parseReceiptMemos(t.tx.Memos);
      if (memo.escrowId === escrowId && memo.receiptHash) {
        return { receiptHash: memo.receiptHash, tx: t };
      }
    }
    return null;
  }
}
