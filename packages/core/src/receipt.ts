import { canonicalJson } from "./canonical.js";
import { isSha256Hex, sha256Hex, type Sha256Hex } from "./hash.js";

export const RECEIPT_VERSION = "workreceipt/1" as const;

/**
 * Proof that a seller delivered a specific output for a specific paid job.
 * Only hashes go on-chain — never the media, prompts or customer data.
 */
export interface DeliveryReceipt {
  version: typeof RECEIPT_VERSION;
  /** sha256 of the seller's internal job id, so the id itself is never published. */
  jobIdHash: Sha256Hex;
  /** Hash of each input the seller received (e.g. source video). */
  inputSha256: Sha256Hex[];
  /** Hash of the delivered artifact. */
  outputSha256: Sha256Hex;
  /** Optional hashes of supporting evidence, e.g. edit plan or QA report. */
  evidence?: Record<string, Sha256Hex>;
  /** Payment the receipt settles, as recorded by the rail. */
  payment: {
    rail: string;
    asset: string;
    /** Integer amount in the asset's smallest unit, as a decimal string. */
    amount: string;
    reference: string;
  };
  /** ISO-8601 UTC delivery time. */
  deliveredAt: string;
}

export interface ReceiptInput {
  jobId: string;
  inputSha256: Sha256Hex[];
  outputSha256: Sha256Hex;
  evidence?: Record<string, Sha256Hex>;
  payment: DeliveryReceipt["payment"];
  deliveredAt?: Date;
}

export function createReceipt(input: ReceiptInput): DeliveryReceipt {
  const receipt: DeliveryReceipt = {
    version: RECEIPT_VERSION,
    jobIdHash: sha256Hex(input.jobId),
    inputSha256: [...input.inputSha256],
    outputSha256: input.outputSha256,
    payment: { ...input.payment },
    deliveredAt: (input.deliveredAt ?? new Date()).toISOString(),
    ...(input.evidence ? { evidence: { ...input.evidence } } : {}),
  };
  assertValidReceipt(receipt);
  return receipt;
}

export function assertValidReceipt(receipt: DeliveryReceipt): void {
  const fail = (msg: string): never => {
    throw new TypeError(`invalid receipt: ${msg}`);
  };
  if (receipt.version !== RECEIPT_VERSION) fail("unknown version");
  if (!isSha256Hex(receipt.jobIdHash)) fail("jobIdHash");
  if (receipt.inputSha256.length === 0) fail("at least one input hash is required");
  receipt.inputSha256.forEach((h, i) => isSha256Hex(h) || fail(`inputSha256[${i}]`));
  if (!isSha256Hex(receipt.outputSha256)) fail("outputSha256");
  for (const [k, h] of Object.entries(receipt.evidence ?? {})) {
    if (!isSha256Hex(h)) fail(`evidence.${k}`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(receipt.payment.amount)) fail("payment.amount");
  if (!receipt.payment.rail || !receipt.payment.asset || !receipt.payment.reference) {
    fail("payment rail, asset and reference are required");
  }
  if (Number.isNaN(Date.parse(receipt.deliveredAt))) fail("deliveredAt");
}

/** The single value anchored on-chain for a receipt. */
export function receiptHash(receipt: DeliveryReceipt): Sha256Hex {
  assertValidReceipt(receipt);
  return sha256Hex(canonicalJson(receipt));
}
