import type { EscrowState, Sha256Hex } from "@receptum/core";
import { deliveryDataKey, fromStellarAmount, receiptHashFromBase64 } from "./codec.js";
import { STELLAR_ESCROW_RAIL, STELLAR_TESTNET } from "./network.js";
import { parseEscrowTerms, type EscrowTerms, type HorizonClaimant } from "./predicates.js";

/**
 * A transaction touching the seller's account after the escrow was created, as needed to find
 * the delivery anchor. Fetched in chronological (ledger) order.
 */
export interface DeliveryTxLike {
  hash: string;
  successful: boolean;
  /** Ledger close time (ISO). */
  createdAt: string;
  memoType: string;
  /** Horizon's base64 memo. */
  memo?: string;
  /** The transaction's ManageData operations. */
  dataOps: {
    /** Account the entry belongs to (the operation's source, else the transaction's). */
    account: string;
    name: string;
    /** Base64 value, or null for a deletion. */
    value: string | null;
  }[];
}

export interface DeliveryAnchor {
  receiptHash: Sha256Hex;
  transactionHash: string;
  deliveredAt: string;
}

/**
 * The delivery of escrow `escrowId`: the **first** successful seller transaction, after the
 * balance was created and strictly before the deadline, that has `MEMO_HASH = h` and writes the
 * seller data entry named by the balance with the value `h`. Later or mutable data — redeliveries,
 * entries written after the deadline, deleted or rewritten entries — never changes it.
 */
export function findDelivery(
  escrowId: string,
  terms: EscrowTerms,
  openedAt: string,
  txs: readonly DeliveryTxLike[],
): DeliveryAnchor | null {
  const key = deliveryDataKey(escrowId);
  const opened = Date.parse(openedAt) / 1000;
  for (const tx of txs) {
    const at = Date.parse(tx.createdAt) / 1000;
    if (!Number.isFinite(at) || at < opened) continue;
    if (at >= terms.deadline) break; // the buyer's window has opened: no later delivery counts
    if (!tx.successful || tx.memoType !== "hash") continue;
    const hash = receiptHashFromBase64(tx.memo);
    if (!hash) continue;
    const writes = tx.dataOps.some(
      (op) =>
        op.account === terms.seller &&
        op.name === key &&
        op.value !== null &&
        receiptHashFromBase64(op.value) === hash,
    );
    if (writes)
      return {
        receiptHash: hash,
        transactionHash: tx.hash,
        deliveredAt: new Date(at * 1000).toISOString(),
      };
  }
  return null;
}

/** A Receptum escrow balance claimed in a transaction, with its terms. */
export interface BatchClaim {
  escrowId: string;
  claimant: string;
  buyer: string;
  seller: string;
  asset: string;
  /** Horizon decimal amount. */
  amount: string;
}

export interface ClaimPayment {
  from: string;
  to: string;
  asset: string;
  /** Horizon decimal amount. */
  amount: string;
}

/**
 * Allocates a transaction's payments to the buyer-claimed escrows in it, in operation order:
 * each escrow takes the first unused payment from its buyer to its seller, in its asset, for
 * exactly its amount. One payment can back at most one escrow, so claiming two balances and paying
 * once counts as one acceptance, not two. Returns escrowId → index into `payments`.
 */
export function allocateClaimPayments(
  claims: readonly BatchClaim[],
  payments: readonly ClaimPayment[],
): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const c of claims) {
    if (c.claimant !== c.buyer || out.has(c.escrowId)) continue;
    const want = fromStellarAmount(c.amount);
    const i = payments.findIndex(
      (p, j) =>
        !used.has(j) &&
        p.from === c.buyer &&
        p.to === c.seller &&
        p.asset === c.asset &&
        fromStellarAmount(p.amount) === want,
    );
    if (i >= 0) {
      used.add(i);
      out.set(c.escrowId, i);
    }
  }
  return out;
}

/** Everything the chain says about one escrow balance, already fetched. */
export interface EscrowHistory {
  escrowId: string;
  create: {
    asset: string;
    /** Horizon decimal amount, e.g. "1.0000000". */
    amount: string;
    claimants: HorizonClaimant[];
    transactionHash: string;
    /** Ledger close time of the creating transaction (ISO). */
    createdAt: string;
  };
  /** Seller-account transactions after the creation, chronological, up to the deadline. */
  deliveryTxs: DeliveryTxLike[];
  /** The successful ClaimClaimableBalance, if the balance has been claimed. */
  claim?: {
    claimant: string;
    transactionHash: string;
    /** Payments made in the same transaction (an atomic buyer acceptance pays the seller). */
    payments: ClaimPayment[];
    /**
     * Every Receptum escrow claimed in the same transaction, in operation order (including this
     * one). When omitted, this is the only one.
     */
    batch?: BatchClaim[];
  };
}

export interface StellarEscrowState extends EscrowState {
  /** Transaction that created the balance. */
  openedBy: string;
  /** Transaction holding the delivery anchor, if delivered. */
  deliveredBy?: string;
  /** Ledger close time of the delivery anchor. */
  deliveredAt?: string;
  /** Transaction that claimed the balance (release or refund), if any. */
  settledBy?: string;
  /** How a released escrow was released. */
  releasedBy?: "seller" | "buyer-acceptance";
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** Pure state derivation: maps chain history to the core escrow lifecycle. */
export function deriveEscrowState(h: EscrowHistory): StellarEscrowState {
  const terms = parseEscrowTerms(h.create.claimants);
  const amount = fromStellarAmount(h.create.amount);
  const delivery = findDelivery(h.escrowId, terms, h.create.createdAt, h.deliveryTxs);
  const base = {
    rail: STELLAR_ESCROW_RAIL,
    network: STELLAR_TESTNET.caip2,
    escrowId: h.escrowId,
    amount,
    asset: h.create.asset,
    buyer: terms.buyer,
    seller: terms.seller,
    refundableAfter: iso(terms.deadline),
    releasableAfter: iso(terms.releaseAt),
    openedBy: h.create.transactionHash,
    ...(delivery
      ? {
          receiptHash: delivery.receiptHash,
          deliveredBy: delivery.transactionHash,
          deliveredAt: delivery.deliveredAt,
        }
      : {}),
  };

  const claim = h.claim;
  if (!claim) return { ...base, status: delivery ? "delivered" : "open" };

  const settled = { ...base, settledBy: claim.transactionHash };
  if (claim.claimant === terms.seller)
    return { ...settled, status: "released", releasedBy: "seller" };
  if (claim.claimant !== terms.buyer) throw new Error("escrow claimed by an unknown account");
  const self: BatchClaim = {
    escrowId: h.escrowId,
    claimant: claim.claimant,
    buyer: terms.buyer,
    seller: terms.seller,
    asset: h.create.asset,
    amount: h.create.amount,
  };
  const batch = claim.batch ?? [self];
  if (!batch.some((c) => c.escrowId === h.escrowId)) throw new Error("claim batch omits escrow");
  const accepted = allocateClaimPayments(batch, claim.payments).has(h.escrowId);
  return accepted
    ? { ...settled, status: "released", releasedBy: "buyer-acceptance" }
    : { ...settled, status: "refunded" };
}
