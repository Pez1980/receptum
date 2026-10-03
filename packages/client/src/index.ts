import { sha256Hex, verifySignedReceipt, type SignedReceipt } from "@receptum/core";
import { decodePaymentResponseHeader } from "@x402/core/http";

export const RECEIPT_HEADER = "Receptum-Receipt";

export function decodeReceiptHeader(value: string): SignedReceipt {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SignedReceipt;
}

export interface ReceiptCheck {
  ok: boolean;
  /** Seller signature verifies against receipt.seller.id. */
  signature: boolean;
  /** SHA-256 of the bytes received equals receipt.outputSha256. */
  outputMatches: boolean;
  /** The receipt's payment reference is the x402 settlement transaction we were given. */
  settlementMatches: boolean;
  /** Seller is on the caller's allow-list (true when no list is set). */
  sellerAllowed: boolean;
  reasons: string[];
}

/** Checks a delivered response against its Receptum receipt. Pure; no network. */
export function checkDelivery(
  body: Uint8Array,
  receipt: SignedReceipt,
  settlement?: { transaction?: string },
  allowedSellers?: readonly string[],
): ReceiptCheck {
  const reasons: string[] = [];
  const sig = verifySignedReceipt(receipt);
  if (!sig.ok) reasons.push(`signature: ${sig.reason}`);
  const outputMatches = sha256Hex(body) === receipt.receipt.outputSha256;
  if (!outputMatches) reasons.push("output hash does not match the receipt");
  const settlementMatches = settlement?.transaction
    ? settlement.transaction === receipt.receipt.payment.reference
    : true;
  if (!settlementMatches) reasons.push("receipt references a different settlement");
  const sellerAllowed = !allowedSellers || allowedSellers.includes(receipt.receipt.seller.id);
  if (!sellerAllowed) reasons.push("seller is not on the allow-list");
  return {
    ok: reasons.length === 0,
    signature: sig.ok,
    outputMatches,
    settlementMatches,
    sellerAllowed,
    reasons,
  };
}

export interface ReceiptedResponse {
  response: Response;
  body: Uint8Array;
  receipt: SignedReceipt;
  check: ReceiptCheck;
  settlement?: ReturnType<typeof decodePaymentResponseHeader>;
}

export interface ReceptumFetchOptions {
  /** A fetch that pays x402 requests, e.g. from @x402/fetch's wrapFetchWithPayment. */
  paidFetch: typeof fetch;
  /** Only accept receipts signed by these seller ids (did:key). */
  allowedSellers?: readonly string[];
}

export class ReceiptError extends Error {
  constructor(
    message: string,
    readonly check?: ReceiptCheck,
  ) {
    super(message);
  }
}

/**
 * Pays for a job through x402 and refuses to hand back the result unless it arrives with a
 * valid Receptum receipt that matches the exact bytes delivered and the settlement.
 */
export function createReceptumFetch(options: ReceptumFetchOptions) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<ReceiptedResponse> => {
    const response = await options.paidFetch(input, init);
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new ReceiptError(`request failed with ${response.status}`);
    const header = response.headers.get(RECEIPT_HEADER);
    if (!header) throw new ReceiptError("response has no Receptum receipt");
    const receipt = decodeReceiptHeader(header);
    const paymentHeader =
      response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
    const settlement = paymentHeader ? decodePaymentResponseHeader(paymentHeader) : undefined;
    const check = checkDelivery(body, receipt, settlement, options.allowedSellers);
    if (!check.ok)
      throw new ReceiptError(`receipt check failed: ${check.reasons.join("; ")}`, check);
    return { response, body, receipt, check, ...(settlement ? { settlement } : {}) };
  };
}
