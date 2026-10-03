import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { isSha256Hex, sha256Hex, type Sha256Hex } from "./hash.js";

export const RECEIPT_VERSION = "receptum/1" as const;

export type AcceptanceMode = "buyer" | "evaluator" | "auto";

/**
 * Proof that a seller delivered a specific output for a specific paid job.
 * Only hashes are ever published — never the media, prompts or customer data.
 * The normative definition is docs/SPEC.md (Receptum Receipt Format v1).
 */
export interface DeliveryReceipt {
  version: typeof RECEIPT_VERSION;
  /** Stable reference for support, audits and agents. */
  receiptId: string;
  /** sha256 of the seller's internal job id, so the id itself is never published. */
  jobIdHash: Sha256Hex;
  /** Who stands behind the delivery. `id` is a DID (did:key) or a CAIP-10 account. */
  seller: { id: string; name?: string };
  /** Optional buyer identity (CAIP-10 account or DID). */
  buyer?: { id: string };
  /** Hash of each input the seller received (e.g. source video). */
  inputSha256: Sha256Hex[];
  /** Hash of the delivered artifact. */
  outputSha256: Sha256Hex;
  /** Optional hashes of supporting evidence, e.g. edit plan or QA report. */
  evidence?: Record<string, Sha256Hex>;
  /** The payment this receipt settles. */
  payment: {
    /** Payment or escrow rail, e.g. "x402:exact", "escrow:receptum-evm", "escrow:xrpl". */
    rail: string;
    /** CAIP-2 network id, e.g. "eip155:84532", "stellar:testnet", "xrpl:1". */
    network: string;
    /** Asset identifier, e.g. "USDC" or a contract address. */
    asset: string;
    /** Integer amount in the asset's smallest unit, as a decimal string. */
    amount: string;
    /** Rail-specific reference: tx hash, escrow id, or payment proof id. */
    reference: string;
    /** CAIP-10 account of the payer, when known. */
    payer?: string;
  };
  /** How the delivery is accepted before funds are released. */
  acceptance: {
    mode: AcceptanceMode;
    /** Seconds after delivery during which the buyer (or evaluator) may reject. */
    reviewWindowSeconds: number;
    /** Identity of the evaluator when mode is "evaluator". */
    evaluator?: string;
  };
  /** Seller's signed commitment for defects found after release. */
  remedy?: {
    kind: "rerender" | "refund" | "terms";
    withinDays?: number;
    /** sha256 of a terms document, when kind is "terms" or terms apply. */
    termsSha256?: Sha256Hex;
  };
  /** receiptHash of an earlier receipt this one replaces (e.g. a re-render). */
  supersedes?: Sha256Hex;
  /** ISO-8601 UTC delivery time. */
  deliveredAt: string;
}

export interface ReceiptInput {
  jobId: string;
  seller: DeliveryReceipt["seller"];
  buyer?: DeliveryReceipt["buyer"];
  inputSha256: Sha256Hex[];
  outputSha256: Sha256Hex;
  evidence?: Record<string, Sha256Hex>;
  payment: DeliveryReceipt["payment"];
  acceptance?: Partial<DeliveryReceipt["acceptance"]>;
  remedy?: DeliveryReceipt["remedy"];
  supersedes?: Sha256Hex;
  receiptId?: string;
  deliveredAt?: Date;
}

/** Default review window: 24 hours. Sellers set longer windows per job type. */
export const DEFAULT_REVIEW_WINDOW_SECONDS = 86_400;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short, human-readable receipt id such as RCPT-7F3A-21C9. */
export function newReceiptId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return `RCPT-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function createReceipt(input: ReceiptInput): DeliveryReceipt {
  const receipt: DeliveryReceipt = {
    version: RECEIPT_VERSION,
    receiptId: input.receiptId ?? newReceiptId(),
    jobIdHash: sha256Hex(input.jobId),
    seller: { ...input.seller },
    inputSha256: [...input.inputSha256],
    outputSha256: input.outputSha256,
    payment: { ...input.payment },
    acceptance: {
      mode: input.acceptance?.mode ?? "auto",
      reviewWindowSeconds: input.acceptance?.reviewWindowSeconds ?? DEFAULT_REVIEW_WINDOW_SECONDS,
      ...(input.acceptance?.evaluator ? { evaluator: input.acceptance.evaluator } : {}),
    },
    deliveredAt: (input.deliveredAt ?? new Date()).toISOString(),
    ...(input.buyer ? { buyer: { ...input.buyer } } : {}),
    ...(input.evidence ? { evidence: { ...input.evidence } } : {}),
    ...(input.remedy ? { remedy: { ...input.remedy } } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  assertValidReceipt(receipt);
  return receipt;
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export function assertValidReceipt(receipt: DeliveryReceipt): void {
  const fail = (msg: string): never => {
    throw new TypeError(`invalid receipt: ${msg}`);
  };
  if (receipt.version !== RECEIPT_VERSION) fail("unknown version");
  if (!/^RCPT-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(receipt.receiptId)) fail("receiptId");
  if (!isSha256Hex(receipt.jobIdHash)) fail("jobIdHash");
  if (!receipt.seller?.id) fail("seller.id is required");
  if (receipt.inputSha256.length === 0) fail("at least one input hash is required");
  receipt.inputSha256.forEach((h, i) => isSha256Hex(h) || fail(`inputSha256[${i}]`));
  if (!isSha256Hex(receipt.outputSha256)) fail("outputSha256");
  for (const [k, h] of Object.entries(receipt.evidence ?? {})) {
    if (!isSha256Hex(h)) fail(`evidence.${k}`);
  }
  const p = receipt.payment;
  if (!/^(0|[1-9][0-9]*)$/.test(p.amount)) fail("payment.amount");
  if (!p.rail || !p.asset || !p.reference) fail("payment rail, asset and reference are required");
  if (!CAIP2.test(p.network)) fail("payment.network must be a CAIP-2 id");
  const a = receipt.acceptance;
  if (!["buyer", "evaluator", "auto"].includes(a.mode)) fail("acceptance.mode");
  if (!Number.isSafeInteger(a.reviewWindowSeconds) || a.reviewWindowSeconds < 0) {
    fail("acceptance.reviewWindowSeconds");
  }
  if (a.mode === "evaluator" && !a.evaluator)
    fail("acceptance.evaluator is required for evaluator mode");
  if (receipt.remedy) {
    if (!["rerender", "refund", "terms"].includes(receipt.remedy.kind)) fail("remedy.kind");
    if (receipt.remedy.termsSha256 && !isSha256Hex(receipt.remedy.termsSha256))
      fail("remedy.termsSha256");
    if (receipt.remedy.kind === "terms" && !receipt.remedy.termsSha256)
      fail("remedy.termsSha256 is required");
  }
  if (receipt.supersedes && !isSha256Hex(receipt.supersedes)) fail("supersedes");
  if (Number.isNaN(Date.parse(receipt.deliveredAt))) fail("deliveredAt");
}

/** JCS (RFC 8785) bytes of a receipt — what gets hashed and signed. */
export function receiptBytes(receipt: DeliveryReceipt): string {
  assertValidReceipt(receipt);
  return canonicalJson(receipt);
}

/** The single value anchored on-chain for a receipt. */
export function receiptHash(receipt: DeliveryReceipt): Sha256Hex {
  return sha256Hex(receiptBytes(receipt));
}
