import {
  assertNetworkAllowed,
  checkPayeeBinding,
  parseXrplIssuedAsset,
  sha256Hex,
  verifySignedReceipt,
  type BindingVerifier,
  type SignedReceipt,
} from "@receptum/core";
import { decodePaymentResponseHeader } from "@x402/core/http";

export const RECEIPT_HEADER = "Receptum-Receipt";

/** Exact decimal ↔ integer 10^-15-unit conversion for XRPL issued tokens (SPEC §7.3). */
export { xrplUnitsToValue, xrplValueToUnits } from "@receptum/core";

export function decodeReceiptHeader(value: string): SignedReceipt {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SignedReceipt;
}

/** What the buyer independently expects — never taken from the response itself. */
export interface Expected {
  network?: string;
  /**
   * Asset as the receipt states it: an EVM token address (compared case-insensitively), XRPL
   * `XRP` or `<currency>.<issuer>` (compared by currency identity and issuer), or the rail's own
   * identifier (compared exactly).
   */
  asset?: string;
  /**
   * Exact amount, an integer in the receipt's unit: the token's smallest unit, XRP drops, or for
   * XRPL issued tokens 10^-15 units (`xrplValueToUnits("0.25")` = "250000000000000").
   */
  amount?: string;
  /** Upper bound, an integer in the same unit as `amount`. */
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
  /**
   * A valid account binding (SPEC §4.1) proves the seller controls `payment.payee`.
   * Only enforced with `requireBinding`; otherwise reported as checked (or false when absent).
   */
  payeeBound: boolean;
  reasons: string[];
}

export interface BindingOptions {
  /** Require a valid seller ↔ payee account binding (SPEC §4.1). */
  requireBinding?: boolean;
  /** Verifiers for the payee's namespace, e.g. `evmBindingVerifier` from @receptum/adapter-evm. */
  bindingVerifiers?: readonly BindingVerifier[];
}

const bare = (account?: string) => account?.split(":").pop()?.toLowerCase();
const INTEGER = /^(0|[1-9][0-9]*)$/;

/** Same asset on `network`: EVM addresses ignore case, XRPL compares protocol identity. */
function sameAsset(network: string, a: string, b: string): boolean {
  if (network.startsWith("eip155:")) return a.toLowerCase() === b.toLowerCase();
  if (network.startsWith("xrpl:") && a !== "XRP" && b !== "XRP") {
    try {
      const x = parseXrplIssuedAsset(a);
      const y = parseXrplIssuedAsset(b);
      return x.currency === y.currency && x.issuer === y.issuer;
    } catch {
      return false;
    }
  }
  return a === b;
}

/** Same CAIP-10 account: EVM addresses ignore case; other namespaces are case-sensitive. */
const sameAccount = (a?: string, b?: string) =>
  a !== undefined &&
  b !== undefined &&
  (a.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b);

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
  options: { expected?: Expected; requireSettlement?: boolean } & BindingOptions = {},
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
      payeeBound: false,
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
  if (e.asset && !sameAsset(r.payment.network, r.payment.asset, e.asset))
    reasons.push("unexpected asset");
  for (const [name, value] of [
    ["amount", e.amount],
    ["maxAmount", e.maxAmount],
  ] as const)
    if (value !== undefined && !INTEGER.test(value))
      reasons.push(
        `expected.${name} must be an integer in the receipt's unit (for XRPL issued tokens, 10^-15 units)`,
      );
  if (e.amount && INTEGER.test(e.amount) && r.payment.amount !== e.amount)
    reasons.push("unexpected amount");
  if (e.maxAmount && INTEGER.test(e.maxAmount) && BigInt(r.payment.amount) > BigInt(e.maxAmount))
    reasons.push("amount exceeds the maximum");
  if (e.payee && !sameAccount(r.payment.payee, e.payee)) reasons.push("unexpected payee");
  if (e.payer && bare(r.payment.payer) !== bare(e.payer)) reasons.push("unexpected payer");
  if (
    e.inputSha256 &&
    JSON.stringify([...r.inputSha256].sort()) !== JSON.stringify([...e.inputSha256].sort())
  ) {
    reasons.push("receipt is for different inputs");
  }
  const expectationsMet = reasons.length === before;

  const bound = checkPayeeBinding(
    receipt,
    options.bindingVerifiers ? { verifiers: options.bindingVerifiers } : {},
  );
  if (options.requireBinding && !bound.ok) reasons.push(`account binding: ${bound.reason}`);

  return {
    ok: reasons.length === 0,
    signature: sig.ok,
    outputMatches,
    settlementMatches,
    sellerAllowed,
    expectationsMet,
    payeeBound: bound.ok,
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

export interface ReceptumFetchOptions extends BindingOptions {
  /** A fetch that pays x402 requests, e.g. from @x402/fetch's wrapFetchWithPayment. */
  paidFetch: typeof fetch;
  /** Only accept receipts signed by these seller ids (did:key). */
  allowedSellers?: readonly string[];
  /** What you expect to pay for; checked against the receipt. */
  expected?: Expected;
  /**
   * The CAIP-2 networks your `paidFetch` is registered to pay on (the schemes you registered with
   * `@x402/fetch`, e.g. `["eip155:8453"]`). Declaring them lets `createReceptumFetch` refuse — at
   * construction, before any request is paid — a mainnet (or unknown) network without the opt-in,
   * and rejects a receipt on any network outside the list.
   */
  networks?: readonly string[];
  /** Required (or `RECEPTUM_ALLOW_MAINNET=1`) when `networks` names a mainnet. */
  allowMainnet?: boolean;
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
  for (const n of options.networks ?? []) assertNetworkAllowed(n, options.allowMainnet, "pay");
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
    const check = checkDelivery(body, receipt, settlement, options.allowedSellers, {
      ...(options.expected ? { expected: options.expected } : {}),
      ...(options.requireBinding ? { requireBinding: true } : {}),
      ...(options.bindingVerifiers ? { bindingVerifiers: options.bindingVerifiers } : {}),
    });
    if (options.networks && !options.networks.includes(receipt?.receipt?.payment?.network)) {
      check.ok = false;
      check.expectationsMet = false;
      check.reasons.push("receipt is on a network this client is not registered to pay on");
    }
    if (!check.ok)
      throw new ReceiptError(`receipt check failed: ${check.reasons.join("; ")}`, check);
    return { response, body, receipt, check, ...(settlement ? { settlement } : {}) };
  };
}
