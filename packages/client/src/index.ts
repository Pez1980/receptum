import { sha256Hex, verifySignedReceipt, type SignedReceipt } from "@receptum/core";
import { decodePaymentResponseHeader } from "@x402/core/http";

export const RECEIPT_HEADER = "Receptum-Receipt";

export function decodeReceiptHeader(value: string): SignedReceipt {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SignedReceipt;
}

/** What the buyer independently expects — never taken from the response itself. */
export interface Expected {
  network?: string;
  asset?: string;
  /** Exact amount in base units. */
  amount?: string;
  /** Upper bound in base units. */
  maxAmount?: string;
  /** CAIP-10 payee the buyer intended to pay. */
  payee?: string;
  /** Buyer's own account (bare address or CAIP-10). */
  payer?: string;
  /** Hashes of the inputs the buyer sent. */
  inputSha256?: string[];
}

export interface Settlement {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

export interface ReceiptCheck {
  ok: boolean;
  /** Seller signature verifies against receipt.seller.id. */
  signature: boolean;
  /** SHA-256 of the bytes received equals receipt.outputSha256. */
  outputMatches: boolean;
  /** A successful settlement is present and the receipt references it. */
  settlementMatches: boolean;
  /** Seller is on the caller's allow-list (true when no list is set). */
  sellerAllowed: boolean;
  /** The receipt matches what the buyer expected to pay for. */
  expectationsMet: boolean;
  reasons: string[];
}

const bare = (account?: string) => account?.split(":").pop()?.toLowerCase();

/**
 * Checks a delivered response against its Receptum receipt. Pure; no network.
 * Fails closed: without a successful settlement the delivery is not accepted
 * (pass `requireSettlement: false` only for receipts verified some other way).
 */
export function checkDelivery(
  body: Uint8Array,
  receipt: SignedReceipt,
  settlement?: Settlement,
  allowedSellers?: readonly string[],
  options: { expected?: Expected; requireSettlement?: boolean } = {},
): ReceiptCheck {
  const reasons: string[] = [];
  const sig = verifySignedReceipt(receipt);
  if (!sig.ok) {
    // A receipt that fails structural/signature checks can't be inspected further safely.
    return {
      ok: false,
      signature: false,
      outputMatches: false,
      settlementMatches: false,
      sellerAllowed: false,
      expectationsMet: false,
      reasons: [`signature: ${sig.reason}`],
    };
  }
  const r = receipt.receipt;
  const outputMatches = sha256Hex(body) === r.outputSha256;
  if (!outputMatches) reasons.push("output hash does not match the receipt");

  const settlementReasons: string[] = [];
  if (options.requireSettlement !== false) {
    if (!settlement) settlementReasons.push("no settlement was returned");
    else {
      if (settlement.success !== true) settlementReasons.push("settlement did not succeed");
      if (settlement.transaction !== r.payment.reference)
        settlementReasons.push("receipt references a different settlement");
      if (settlement.network && settlement.network !== r.payment.network)
        settlementReasons.push("settlement is on a different network");
      if (settlement.payer && r.payment.payer && bare(settlement.payer) !== bare(r.payment.payer))
        settlementReasons.push("receipt names a different payer");
    }
  }
  reasons.push(...settlementReasons);
  const settlementMatches = settlementReasons.length === 0;

  const sellerAllowed = !allowedSellers || allowedSellers.includes(r.seller.id);
  if (!sellerAllowed) reasons.push("seller is not on the allow-list");

  const e = options.expected ?? {};
  const before = reasons.length;
  if (e.network && r.payment.network !== e.network) reasons.push("unexpected network");
  if (e.asset && r.payment.asset.toLowerCase() !== e.asset.toLowerCase())
    reasons.push("unexpected asset");
  if (e.amount && r.payment.amount !== e.amount) reasons.push("unexpected amount");
  if (e.maxAmount && BigInt(r.payment.amount) > BigInt(e.maxAmount))
    reasons.push("amount exceeds the maximum");
  if (e.payee && r.payment.payee?.toLowerCase() !== e.payee.toLowerCase())
    reasons.push("unexpected payee");
  if (e.payer && bare(r.payment.payer) !== bare(e.payer)) reasons.push("unexpected payer");
  if (
    e.inputSha256 &&
    JSON.stringify([...r.inputSha256].sort()) !== JSON.stringify([...e.inputSha256].sort())
  ) {
    reasons.push("receipt is for different inputs");
  }
  const expectationsMet = reasons.length === before;

  return {
    ok: reasons.length === 0,
    signature: sig.ok,
    outputMatches,
    settlementMatches,
    sellerAllowed,
    expectationsMet,
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
  /** What you expect to pay for; checked against the receipt. */
  expected?: Expected;
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
 * successful settlement and a valid Receptum receipt matching the exact bytes delivered.
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
    const check = checkDelivery(
      body,
      receipt,
      settlement,
      options.allowedSellers,
      options.expected ? { expected: options.expected } : {},
    );
    if (!check.ok)
      throw new ReceiptError(`receipt check failed: ${check.reasons.join("; ")}`, check);
    return { response, body, receipt, check, ...(settlement ? { settlement } : {}) };
  };
}
