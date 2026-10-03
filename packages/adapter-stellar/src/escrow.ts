import {
  FeeBumpTransaction,
  Memo,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { EscrowCapabilities, EscrowHandle, EscrowRail, Sha256Hex } from "@receptum/core";
import {
  assetToString,
  deliveryDataKey,
  parseAsset,
  parseEscrowId,
  receiptHashBytes,
  receiptMemo,
  toStellarAmount,
} from "./codec.js";
import { HorizonClient, isNotFound, type HorizonOptions } from "./horizon.js";
import { STELLAR_ESCROW_RAIL, STELLAR_TESTNET, TESTNET_USDC } from "./network.js";
import { escrowClaimants, parseEscrowTerms, type HorizonClaimant } from "./predicates.js";
import type { StellarSigner } from "./signer.js";
import {
  deriveEscrowState,
  type BatchClaim,
  type DeliveryTxLike,
  type EscrowHistory,
  type StellarEscrowState,
} from "./state.js";

/**
 * What the claimable-balance escrow enforces on-chain: buyer or auto acceptance, a review window
 * measured from the delivery deadline, and buyer refunds (or rejections) during the buyer window.
 */
export const CLAIMABLE_ESCROW_CAPABILITIES: EscrowCapabilities = {
  acceptanceModes: ["buyer", "auto"],
  reviewWindowFromDelivery: false,
  refundAfterDelivery: true,
};

export interface StellarEscrowOptions extends HorizonOptions {
  /** The account acting through this instance: the buyer or the seller. Omit for read-only use. */
  signer?: StellarSigner;
  /** Asset for escrows opened by this instance (`native` or `CODE:ISSUER`). Default: testnet USDC. */
  asset?: string;
  /**
   * When true (default) the seller's `release()` refuses to claim an escrow
   * with no delivery recorded. Claim predicates cannot see deliveries, so this
   * is client policy, not an on-chain rule — see the README.
   */
  requireDeliveryForRelease?: boolean;
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
  /**
   * Most seller transactions scanned between an escrow's creation and its deadline to find the
   * delivery anchor (default 1000). Exceeding it is an error, never a silent "not delivered".
   */
  maxHistory?: number;
}

export interface OpenEscrowParams {
  /** Seller's G… address. */
  seller: string;
  /** Amount in the asset's smallest unit (7 decimals on Stellar). */
  amount: string;
  /** Delivery deadline. The buyer may reclaim from here if nothing was delivered. */
  deadline: Date;
  /** Seconds after the deadline during which the buyer may reject, refund or accept. */
  reviewWindowSeconds: number;
}

export type OpenedEscrow = EscrowHandle & { releasableAfter: string; reference: string };

/**
 * `EscrowRail` on native Stellar claimable balances (no smart contract).
 *
 * One balance per job, with two claimants whose time windows never overlap:
 * the buyer in `[deadline, deadline + reviewWindow)` and the seller from
 * `deadline + reviewWindow`. Delivery is a seller transaction with
 * `MEMO_HASH = receiptHash` that also records the hash in a seller data entry
 * keyed by the balance id. See the package README for the full design and its
 * trade-offs.
 */
export class StellarClaimableEscrowRail implements EscrowRail {
  readonly id = STELLAR_ESCROW_RAIL;
  readonly network = STELLAR_TESTNET.caip2;
  readonly capabilities = CLAIMABLE_ESCROW_CAPABILITIES;
  private readonly horizon: HorizonClient;
  private readonly signerOrNone: StellarSigner | undefined;
  private readonly asset: string;
  private readonly requireDelivery: boolean;
  private readonly now: () => number;
  private readonly maxHistory: number;

  constructor(options: StellarEscrowOptions) {
    this.horizon = new HorizonClient(options);
    this.signerOrNone = options.signer;
    this.asset = assetToString(parseAsset(options.asset ?? TESTNET_USDC));
    this.requireDelivery = options.requireDeliveryForRelease ?? true;
    this.now = options.now ?? Date.now;
    this.maxHistory = options.maxHistory ?? 1000;
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Buyer: locks `amount` in a new claimable balance. The balance id is the escrowId. */
  async open(params: OpenEscrowParams): Promise<OpenedEscrow> {
    const deadline = Math.floor(params.deadline.getTime() / 1000);
    if (!Number.isSafeInteger(params.reviewWindowSeconds) || params.reviewWindowSeconds <= 0) {
      throw new TypeError("reviewWindowSeconds must be a positive integer");
    }
    if (deadline <= this.nowSeconds()) throw new TypeError("deadline must be in the future");
    const terms = {
      buyer: this.signer.publicKey,
      seller: params.seller,
      deadline,
      releaseAt: deadline + params.reviewWindowSeconds,
    };
    const op = Operation.createClaimableBalance({
      asset: parseAsset(this.asset),
      amount: toStellarAmount(params.amount),
      claimants: escrowClaimants(terms),
    });
    const { hash, tx } = await this.horizon.submit(this.signer, [op]);
    return {
      rail: this.id,
      network: this.network,
      escrowId: tx.getClaimableBalanceId(0),
      amount: params.amount,
      asset: this.asset,
      buyer: terms.buyer,
      seller: terms.seller,
      refundableAfter: new Date(terms.deadline * 1000).toISOString(),
      releasableAfter: new Date(terms.releaseAt * 1000).toISOString(),
      reference: hash,
    };
  }

  /** Reads the escrow from public chain data (needs no key). */
  async getEscrow(escrowId: string): Promise<StellarEscrowState> {
    return deriveEscrowState(await this.history(parseEscrowId(escrowId)));
  }

  /** Seller: anchors `receiptHash` (MEMO_HASH) and records it against this escrow. */
  async deliver(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }> {
    const state = await this.getEscrow(escrowId);
    this.assertRole(state, "seller", "deliver");
    if (state.status !== "open") {
      // Only the first delivery anchor counts (state is derived from history), so redelivering
      // could never change the committed receipt.
      throw new Error(`cannot deliver: escrow is ${state.status}`);
    }
    if (this.nowSeconds() >= Date.parse(state.refundableAfter) / 1000) {
      throw new Error(`cannot deliver: the delivery deadline ${state.refundableAfter} has passed`);
    }
    const op = Operation.manageData({
      name: deliveryDataKey(state.escrowId),
      value: receiptHashBytes(receiptHash),
    });
    const { hash } = await this.horizon.submit(this.signer, [op], receiptMemo(receiptHash));
    return { reference: hash };
  }

  /**
   * Pays the seller. Called by the seller, it claims the balance once the
   * review window has passed. Called by the buyer, it is early acceptance: one
   * atomic transaction claims the balance and pays the seller in full, which is
   * possible while the buyer's window is open.
   */
  async release(escrowId: string): Promise<{ reference: string }> {
    const state = await this.getEscrow(escrowId);
    const role = this.roleIn(state);
    const balanceId = state.escrowId;
    const now = this.nowSeconds();
    this.assertUnsettled(state, "release");
    if (role === "seller") {
      if (now < Date.parse(state.releasableAfter!) / 1000) {
        throw new Error(`cannot release yet: the seller may claim from ${state.releasableAfter}`);
      }
      if (this.requireDelivery && state.status !== "delivered") {
        throw new Error("cannot release: nothing was delivered (requireDeliveryForRelease)");
      }
      const ops: xdr.Operation[] = [Operation.claimClaimableBalance({ balanceId })];
      // Free the delivery entry's reserve in the same transaction.
      if ((await this.deliveryEntry(state.seller, balanceId)) !== null) {
        ops.push(Operation.manageData({ name: deliveryDataKey(balanceId), value: null }));
      }
      const memo = state.receiptHash ? receiptMemo(state.receiptHash) : undefined;
      return { reference: (await this.horizon.submit(this.signer, ops, memo)).hash };
    }
    if (state.status !== "delivered" || !state.receiptHash) {
      throw new Error("cannot accept: nothing was delivered");
    }
    this.assertBuyerWindow(state, "accept");
    const ops = [
      Operation.claimClaimableBalance({ balanceId }),
      Operation.payment({
        destination: state.seller,
        asset: parseAsset(state.asset),
        amount: toStellarAmount(state.amount),
      }),
    ];
    const memo = receiptMemo(state.receiptHash);
    return { reference: (await this.horizon.submit(this.signer, ops, memo)).hash };
  }

  /** Buyer: reclaims an undelivered escrow once the delivery deadline has passed. */
  async refund(escrowId: string): Promise<{ reference: string }> {
    const state = await this.getEscrow(escrowId);
    this.assertRole(state, "buyer", "refund");
    this.assertUnsettled(state, "refund");
    if (state.status === "delivered") {
      throw new Error("cannot refund: a receipt was delivered — use reject() during the window");
    }
    return this.buyerClaim(state, "refund");
  }

  /** Buyer: rejects a delivered receipt during the review window and reclaims the funds. */
  async reject(escrowId: string): Promise<{ reference: string }> {
    const state = await this.getEscrow(escrowId);
    this.assertRole(state, "buyer", "reject");
    this.assertUnsettled(state, "reject");
    if (state.status !== "delivered") throw new Error("cannot reject: nothing was delivered");
    return this.buyerClaim(state, "reject");
  }

  /**
   * Seller: removes the delivery data entry (and frees its 0.5 XLM reserve)
   * after the buyer settled the escrow by acceptance or rejection.
   */
  async clearDelivery(escrowId: string): Promise<{ reference: string }> {
    const state = await this.getEscrow(escrowId);
    this.assertRole(state, "seller", "clear the delivery of");
    const key = deliveryDataKey(state.escrowId);
    const account = await this.horizon.server.loadAccount(state.seller);
    if (state.status !== "released" && state.status !== "refunded") {
      throw new Error("cannot clear delivery: escrow is not settled");
    }
    if (account.data_attr[key] === undefined) throw new Error("no delivery entry to clear");
    const op = Operation.manageData({ name: key, value: null });
    return { reference: (await this.horizon.submit(this.signer, [op])).hash };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private get signer(): StellarSigner {
    if (!this.signerOrNone) throw new Error("this StellarClaimableEscrowRail has no signer");
    return this.signerOrNone;
  }

  private async buyerClaim(
    state: StellarEscrowState,
    action: "refund" | "reject",
  ): Promise<{ reference: string }> {
    this.assertBuyerWindow(state, action);
    const op = Operation.claimClaimableBalance({ balanceId: state.escrowId });
    const { hash } = await this.horizon.submit(this.signer, [op], Memo.text(`receptum:${action}`));
    return { reference: hash };
  }

  private roleIn(state: StellarEscrowState): "buyer" | "seller" {
    if (this.signer.publicKey === state.seller) return "seller";
    if (this.signer.publicKey === state.buyer) return "buyer";
    throw new Error("signer is neither the buyer nor the seller of this escrow");
  }

  private assertRole(state: StellarEscrowState, role: "buyer" | "seller", action: string): void {
    if (this.roleIn(state) !== role) throw new Error(`only the ${role} can ${action} an escrow`);
  }

  private assertUnsettled(state: StellarEscrowState, action: string): void {
    if (state.status === "released" || state.status === "refunded") {
      throw new Error(`cannot ${action}: escrow is already ${state.status}`);
    }
  }

  private assertBuyerWindow(state: StellarEscrowState, action: string): void {
    const now = this.nowSeconds();
    const from = Date.parse(state.refundableAfter) / 1000;
    const until = Date.parse(state.releasableAfter!) / 1000;
    if (now < from)
      throw new Error(`cannot ${action} yet: the buyer may claim from ${state.refundableAfter}`);
    if (now >= until) {
      throw new Error(`cannot ${action}: the buyer window closed at ${state.releasableAfter}`);
    }
  }

  private async history(balanceId: string): Promise<EscrowHistory> {
    const server = this.horizon.server;
    const create = await this.createRecord(balanceId);
    if (!create) throw new Error(`unknown escrow ${balanceId}`);
    const terms = parseEscrowTerms(create.claimants!);
    const createTx = await server.transactions().transaction(create.transaction_hash).call();
    const history: EscrowHistory = {
      escrowId: balanceId,
      create: {
        asset: create.asset!,
        amount: create.amount!,
        claimants: create.claimants!,
        transactionHash: create.transaction_hash,
        createdAt: createTx.created_at,
      },
      deliveryTxs: await this.deliveryTxs(terms.seller, createTx.paging_token, terms.deadline),
    };
    const claim = create.ops.find(
      (r) => r.type === "claim_claimable_balance" && r.transaction_successful !== false,
    );
    if (claim?.claimant) {
      const ops = (
        await server.operations().forTransaction(claim.transaction_hash).limit(200).call()
      ).records as unknown as OperationRecordLike[];
      const batch: BatchClaim[] = [];
      for (const op of ops) {
        if (op.type !== "claim_claimable_balance" || !op.balance_id || !op.claimant) continue;
        const id = op.balance_id.toLowerCase();
        const rec = id === balanceId ? create : await this.createRecord(id);
        if (!rec) continue;
        let t;
        try {
          t = parseEscrowTerms(rec.claimants!);
        } catch {
          continue; // not a Receptum escrow: it can't consume payments
        }
        batch.push({
          escrowId: id,
          claimant: op.claimant,
          buyer: t.buyer,
          seller: t.seller,
          asset: rec.asset!,
          amount: rec.amount!,
        });
      }
      history.claim = {
        claimant: claim.claimant,
        transactionHash: claim.transaction_hash,
        payments: ops
          .filter((r) => r.type === "payment" && r.from && r.to && r.amount)
          .map((r) => ({
            from: r.from!,
            to: r.to!,
            amount: r.amount!,
            asset: r.asset_type === "native" ? "native" : `${r.asset_code}:${r.asset_issuer}`,
          })),
        batch,
      };
    }
    return history;
  }

  /** The balance's create operation (with all its operations), or null if it isn't a balance. */
  private async createRecord(
    balanceId: string,
  ): Promise<(OperationRecordLike & { ops: OperationRecordLike[] }) | null> {
    let records: OperationRecordLike[];
    try {
      const page = await this.horizon.server
        .operations()
        .forClaimableBalance(balanceId)
        .order("asc")
        .limit(200)
        .call();
      records = page.records as unknown as OperationRecordLike[];
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const create = records.find((r) => r.type === "create_claimable_balance");
    if (!create?.claimants || !create.asset || !create.amount) return null;
    return { ...create, ops: records };
  }

  /**
   * The seller's transactions after `cursor` (the creating transaction), oldest first, until the
   * first one at or after the deadline. Delivery is derived from these, never from current data.
   */
  private async deliveryTxs(
    seller: string,
    cursor: string,
    deadline: number,
  ): Promise<DeliveryTxLike[]> {
    const out: DeliveryTxLike[] = [];
    let page = await this.horizon.server
      .transactions()
      .forAccount(seller)
      .cursor(cursor)
      .order("asc")
      .limit(200)
      .call();
    while (page.records.length > 0) {
      for (const tx of page.records) {
        if (Date.parse(tx.created_at) / 1000 >= deadline) return out;
        if (out.length >= this.maxHistory) {
          throw new Error(
            `seller has more than ${this.maxHistory} transactions before the deadline; raise maxHistory to derive delivery`,
          );
        }
        out.push(toDeliveryTx(tx));
      }
      page = await page.next();
    }
    return out;
  }

  private async deliveryEntry(seller: string, balanceId: string): Promise<string | null> {
    try {
      const account = await this.horizon.server.loadAccount(seller);
      return account.data_attr[deliveryDataKey(balanceId)] ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

/** The subset of Horizon operation records this adapter reads. */
interface OperationRecordLike {
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  asset?: string;
  amount?: string;
  claimants?: HorizonClaimant[];
  claimant?: string;
  balance_id?: string;
  from?: string;
  to?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** Horizon transaction record → the fields delivery derivation needs. */
export function toDeliveryTx(tx: {
  hash: string;
  successful: boolean;
  created_at: string;
  memo_type: string;
  memo?: string;
  source_account: string;
  envelope_xdr: string;
}): DeliveryTxLike {
  const dataOps: DeliveryTxLike["dataOps"] = [];
  if (tx.successful && tx.memo_type === "hash") {
    let parsed = TransactionBuilder.fromXDR(tx.envelope_xdr, STELLAR_TESTNET.networkPassphrase);
    if (parsed instanceof FeeBumpTransaction) parsed = parsed.innerTransaction;
    for (const op of (parsed as Transaction).operations) {
      if (op.type !== "manageData") continue;
      dataOps.push({
        account: op.source ?? (parsed as Transaction).source,
        name: op.name,
        value: op.value ? Buffer.from(op.value).toString("base64") : null,
      });
    }
  }
  return {
    hash: tx.hash,
    successful: tx.successful,
    createdAt: tx.created_at,
    memoType: tx.memo_type,
    ...(tx.memo !== undefined ? { memo: tx.memo } : {}),
    dataOps,
  };
}
