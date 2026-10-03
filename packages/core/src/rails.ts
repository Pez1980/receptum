import type { DeliveryReceipt } from "./receipt.js";
import type { Sha256Hex } from "./hash.js";

/** A price for one unit of work, in the asset's smallest unit. */
export interface Quote {
  jobId: string;
  rail: string;
  asset: string;
  amount: string;
  payTo: string;
  /** ISO-8601 UTC time after which the quote can't be paid. */
  expiresAt: string;
}

export interface PaymentProof {
  rail: string;
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

export interface EscrowHandle {
  rail: string;
  escrowId: string;
  amount: string;
  asset: string;
  /** ISO-8601 UTC time after which the buyer may reclaim funds. */
  refundableAfter: string;
}

/** Funds held until delivery is accepted, then released to the seller or refunded. */
export interface EscrowRail {
  readonly id: string;
  getEscrow(escrowId: string): Promise<EscrowHandle & { status: "open" | "released" | "refunded" }>;
  release(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }>;
  refund(escrowId: string): Promise<{ reference: string }>;
}

export interface AnchorRecord {
  rail: string;
  receiptHash: Sha256Hex;
  reference: string;
  anchoredAt: string;
}

/** Publishes a receipt hash on-chain and finds it again for verification. */
export interface Anchor {
  readonly id: string;
  anchor(receipt: DeliveryReceipt): Promise<AnchorRecord>;
  find(receiptHash: Sha256Hex): Promise<AnchorRecord | null>;
}
