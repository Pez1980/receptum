import type { Sha256Hex } from "./hash.js";

/** A price for one unit of work, in the asset's smallest unit. */
export interface Quote {
  jobId: string;
  rail: string;
  /** CAIP-2 network id. */
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  /** ISO-8601 UTC time after which the quote can't be paid. */
  expiresAt: string;
}

export interface PaymentProof {
  rail: string;
  network: string;
  reference: string;
  amount: string;
  asset: string;
  payer: string;
}

/** Direct payment (e.g. x402 "exact"): the buyer pays up front. */
export interface PaymentRail {
  readonly id: string;
  verify(quote: Quote, proof: unknown): Promise<PaymentProof>;
}

export type EscrowStatus = "open" | "delivered" | "released" | "refunded";

export interface EscrowHandle {
  rail: string;
  network: string;
  escrowId: string;
  amount: string;
  asset: string;
  buyer: string;
  seller: string;
  /** ISO-8601 UTC time after which the buyer may reclaim funds if nothing was delivered. */
  refundableAfter: string;
}

export interface EscrowState extends EscrowHandle {
  status: EscrowStatus;
  /** receiptHash committed by the seller on delivery, if any. */
  receiptHash?: Sha256Hex;
  /** ISO-8601 UTC time after which a delivered escrow auto-releases. */
  releasableAfter?: string;
}

/**
 * Funds held until delivery is accepted, then released to the seller or refunded.
 * Each chain adapter maps these calls to its native primitives.
 */
export interface EscrowRail {
  readonly id: string;
  getEscrow(escrowId: string): Promise<EscrowState>;
  /** Seller commits the receipt hash on delivery; starts the review window. */
  deliver(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }>;
  /** Seller collects after acceptance or once the review window has passed. */
  release(escrowId: string): Promise<{ reference: string }>;
  /** Buyer reclaims after the deadline when nothing was delivered. */
  refund(escrowId: string): Promise<{ reference: string }>;
}

export interface AnchorRecord {
  rail: string;
  network: string;
  receiptHash: Sha256Hex;
  reference: string;
  anchoredAt: string;
}

/** Publishes a receipt hash on-chain and finds it again for verification. */
export interface Anchor {
  readonly id: string;
  anchor(receiptHash: Sha256Hex): Promise<AnchorRecord>;
  find(receiptHash: Sha256Hex, hint?: { reference?: string }): Promise<AnchorRecord | null>;
}
