import type { EscrowState, Sha256Hex } from "@receptum/core";
import { fromStellarAmount, receiptHashFromBase64 } from "./codec.js";
import { STELLAR_ESCROW_RAIL, STELLAR_TESTNET } from "./network.js";
import { parseEscrowTerms, type HorizonClaimant } from "./predicates.js";

/** Everything the chain says about one escrow balance, already fetched. */
export interface EscrowHistory {
  escrowId: string;
  create: {
    asset: string;
    /** Horizon decimal amount, e.g. "1.0000000". */
    amount: string;
    claimants: HorizonClaimant[];
    transactionHash: string;
  };
  /** The successful ClaimClaimableBalance, if the balance has been claimed. */
  claim?: {
    claimant: string;
    transactionHash: string;
    /** The claim transaction's memo (Horizon form). */
    memoType: string;
    memo?: string;
    /** Payments made in the same transaction (an atomic buyer acceptance pays the seller). */
    payments: { from: string; to: string; asset: string; amount: string }[];
  };
  /** Base64 value of the seller's delivery data entry, if present. */
  deliveryEntry?: string | null;
}

export interface StellarEscrowState extends EscrowState {
  /** Transaction that created the balance. */
  openedBy: string;
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
  const delivered = receiptHashFromBase64(h.deliveryEntry);
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
  };
  const withHash = (hash: Sha256Hex | null) => (hash ? { receiptHash: hash } : {});

  const claim = h.claim;
  if (!claim) return { ...base, status: delivered ? "delivered" : "open", ...withHash(delivered) };

  const memoHash = claim.memoType === "hash" ? receiptHashFromBase64(claim.memo) : null;
  const settled = { ...base, settledBy: claim.transactionHash };
  if (claim.claimant === terms.seller) {
    return {
      ...settled,
      status: "released",
      releasedBy: "seller",
      ...withHash(memoHash ?? delivered),
    };
  }
  if (claim.claimant !== terms.buyer) throw new Error("escrow claimed by an unknown account");
  const paidSeller = claim.payments.some(
    (p) =>
      p.from === terms.buyer &&
      p.to === terms.seller &&
      p.asset === h.create.asset &&
      BigInt(fromStellarAmount(p.amount)) >= BigInt(amount),
  );
  return paidSeller
    ? {
        ...settled,
        status: "released",
        releasedBy: "buyer-acceptance",
        ...withHash(memoHash ?? delivered),
      }
    : { ...settled, status: "refunded", ...withHash(delivered) };
}
