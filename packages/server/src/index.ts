import {
  createReceipt,
  sha256Hex,
  signReceipt,
  type Anchor,
  type AnchorRecord,
  type DeliveryReceipt,
  type SellerKey,
  type Sha256Hex,
  type SignedReceipt,
} from "@receptum/core";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";

/** Response headers that carry the Receptum receipt alongside x402's PAYMENT-RESPONSE. */
export const RECEIPT_HEADER = "Receptum-Receipt";
export const RECEIPT_HASH_HEADER = "Receptum-Receipt-Hash";

type ResourceServer = Pick<
  x402ResourceServer,
  | "buildPaymentRequirements"
  | "createPaymentRequiredResponse"
  | "findMatchingRequirements"
  | "verifyPayment"
  | "settlePayment"
>;
type ResourceConfig = Parameters<x402ResourceServer["buildPaymentRequirements"]>[0];
type ResourceInfo = Parameters<x402ResourceServer["createPaymentRequiredResponse"]>[1];

export interface PaidJobConfig {
  /** An initialized x402 resource server with the schemes you accept registered. */
  x402: ResourceServer;
  /** Payment options offered to the buyer (price, network, payTo…). */
  accepts: ResourceConfig[];
  resource: ResourceInfo;
  seller: SellerKey & { name?: string };
  acceptance?: DeliveryReceipt["acceptance"];
  remedy?: DeliveryReceipt["remedy"];
  /** Optional on-chain anchor for the receipt hash (e.g. EvmAnchor, XrplAnchor, StellarAnchor). */
  anchor?: Anchor;
}

export interface JobResult {
  /** Seller's internal job id. Only its hash is published. */
  jobId: string;
  /** Hashes of the inputs the job consumed. */
  inputSha256: Sha256Hex[];
  /** The delivered artifact. Its hash goes into the receipt; the bytes go to the buyer. */
  output: Uint8Array;
  contentType: string;
  evidence?: Record<string, Sha256Hex>;
}

export interface PaidJobResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
  receipt?: SignedReceipt;
  anchor?: AnchorRecord;
}

const json = (
  status: number,
  headers: Record<string, string>,
  value: unknown,
): PaidJobResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

/** base64url(JSON) — compact enough for a response header. */
export const encodeReceiptHeader = (signed: SignedReceipt) =>
  Buffer.from(JSON.stringify(signed)).toString("base64url");

/**
 * Runs one paid job: answers 402 with x402 requirements, verifies the buyer's payment,
 * runs the work, settles, then returns the output with a seller-signed Receptum receipt
 * that binds the settlement transaction to the exact bytes delivered.
 *
 * The output is never released if settlement fails.
 */
export async function handlePaidJob(
  getHeader: (name: string) => string | undefined,
  run: () => Promise<JobResult>,
  config: PaidJobConfig,
): Promise<PaidJobResponse> {
  const requirements = (
    await Promise.all(config.accepts.map((a) => config.x402.buildPaymentRequirements(a)))
  ).flat();

  const paymentRequired = async (error?: string) => {
    const pr = await config.x402.createPaymentRequiredResponse(
      requirements,
      config.resource,
      error,
    );
    return json(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }, pr);
  };

  const signature = getHeader("PAYMENT-SIGNATURE") ?? getHeader("X-PAYMENT");
  if (!signature) return paymentRequired();

  let payload: ReturnType<typeof decodePaymentSignatureHeader>;
  try {
    payload = decodePaymentSignatureHeader(signature);
  } catch {
    return paymentRequired("malformed payment header");
  }
  const matched = config.x402.findMatchingRequirements(requirements, payload);
  if (!matched) return paymentRequired("payment does not match any accepted option");

  const verified = await config.x402.verifyPayment(payload, matched);
  if (!verified.isValid) return paymentRequired(verified.invalidReason ?? "payment invalid");

  const job = await run();

  const settled = await config.x402.settlePayment(payload, matched);
  if (!settled.success) {
    return json(
      402,
      { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) },
      { error: settled.errorReason ?? "settlement failed" },
    );
  }

  const receipt = createReceipt({
    jobId: job.jobId,
    seller: { id: config.seller.did, ...(config.seller.name ? { name: config.seller.name } : {}) },
    inputSha256: job.inputSha256,
    outputSha256: sha256Hex(job.output),
    ...(job.evidence ? { evidence: job.evidence } : {}),
    payment: {
      rail: `x402:${matched.scheme}`,
      network: settled.network,
      asset: matched.asset,
      amount: settled.amount ?? matched.amount,
      reference: settled.transaction,
      ...(settled.payer ? { payer: `${settled.network}:${settled.payer}` } : {}),
    },
    acceptance: config.acceptance ?? { mode: "auto", reviewWindowSeconds: 0 },
    ...(config.remedy ? { remedy: config.remedy } : {}),
  });
  const signed = signReceipt(receipt, config.seller);
  const anchor = config.anchor ? await config.anchor.anchor(signed.receiptHash) : undefined;

  return {
    status: 200,
    headers: {
      "content-type": job.contentType,
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled),
      [RECEIPT_HEADER]: encodeReceiptHeader(signed),
      [RECEIPT_HASH_HEADER]: signed.receiptHash,
      "Access-Control-Expose-Headers": `PAYMENT-RESPONSE, ${RECEIPT_HEADER}, ${RECEIPT_HASH_HEADER}`,
    },
    body: job.output,
    receipt: signed,
    ...(anchor ? { anchor } : {}),
  };
}
