import {
  canonicalJson,
  checkPayeeBinding,
  createReceipt,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
  type AccountBinding,
  type BindingVerifier,
  type DeliveryReceipt,
  type SellerKey,
  type Sha256Hex,
  type SignedReceipt,
} from "@receptum/core";

/** `_meta` key that carries the Receptum receipt on a paid tool result. */
export const RECEIPT_META_KEY = "receptum/receipt";
/** `_meta` key where @x402/mcp puts the settlement response. */
export const X402_SETTLEMENT_META_KEY = "x402/payment-response";

/** The minimal shape of an MCP CallToolResult that we need. */
export interface ToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

interface Settlement {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
}

/**
 * The delivered output of a tool call: SHA-256 of the JCS of
 * `{ content, structuredContent?, isError? }` (each member present exactly when set) — everything
 * a consumer may act on.
 */
export function toolOutputSha256(
  result: Pick<ToolResult, "content" | "structuredContent" | "isError">,
): Sha256Hex {
  return sha256Hex(
    canonicalJson({
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    }),
  );
}

export interface ReceiptedToolOptions<A> {
  seller: SellerKey & { name?: string };
  /** Hashes of the inputs; defaults to the JCS hash of the tool arguments. */
  inputsFor?: (args: A) => Sha256Hex[];
  /** Asset id and amount as quoted (the settlement may only carry the amount for some schemes). */
  price: { asset: string; amount: string; payTo?: string; scheme?: string };
  acceptance?: DeliveryReceipt["acceptance"];
  remedy?: DeliveryReceipt["remedy"];
  /** Account bindings (SPEC §4.1) for this seller, attached to every receipt. */
  bindings?: AccountBinding[];
}

/**
 * Wraps an x402-paid MCP tool handler (from @x402/mcp's createPaymentWrapper) so every settled
 * call returns a seller-signed Receptum receipt in `_meta["receptum/receipt"]`.
 * Unpaid, failed or unsettled calls are passed through unchanged.
 */
export function withReceipts<A, E>(
  paidHandler: (args: A, extra: E) => Promise<ToolResult>,
  options: ReceiptedToolOptions<A>,
): (args: A, extra: E) => Promise<ToolResult> {
  return async (args, extra) => {
    const result = await paidHandler(args, extra);
    const settlement = result._meta?.[X402_SETTLEMENT_META_KEY] as Settlement | undefined;
    if (result.isError || !settlement?.success) return result;
    const receipt = createReceipt({
      jobId: `${settlement.network}:${settlement.transaction}`,
      seller: {
        id: options.seller.did,
        ...(options.seller.name ? { name: options.seller.name } : {}),
      },
      inputSha256: options.inputsFor
        ? options.inputsFor(args)
        : [sha256Hex(canonicalJson(args ?? {}))],
      outputSha256: toolOutputSha256(result),
      payment: {
        rail: `x402:${options.price.scheme ?? "exact"}`,
        network: settlement.network,
        asset: options.price.asset,
        amount: settlement.amount ?? options.price.amount,
        reference: settlement.transaction,
        ...(options.price.payTo ? { payee: `${settlement.network}:${options.price.payTo}` } : {}),
        ...(settlement.payer ? { payer: `${settlement.network}:${settlement.payer}` } : {}),
      },
      acceptance: options.acceptance ?? { mode: "auto", reviewWindowSeconds: 0 },
      ...(options.remedy ? { remedy: options.remedy } : {}),
    });
    const signed = signReceipt(receipt, options.seller);
    const bindings = options.bindings?.filter((b) => b.statement?.did === options.seller.did);
    return {
      ...result,
      _meta: {
        ...result._meta,
        [RECEIPT_META_KEY]: bindings?.length ? { ...signed, bindings } : signed,
      },
    };
  };
}

export interface ToolResultCheck {
  ok: boolean;
  receipt?: SignedReceipt;
  reasons: string[];
}

export interface ToolExpectations {
  network?: string;
  asset?: string;
  amount?: string;
  maxAmount?: string;
  /** CAIP-10 payee the caller intended to pay. */
  payee?: string;
  /** The caller's own account (bare or CAIP-10). */
  payer?: string;
  /** Expected input hashes (default for tools wrapped with defaults: JCS hash of the arguments). */
  argsSha256?: Sha256Hex[];
}

const bare = (account?: string) => account?.split(":").pop()?.toLowerCase();

/** Client side: checks a paid tool result against its receipt. Pure; no network. Fails closed. */
export function verifyToolResult(
  result: ToolResult,
  allowedSellers?: readonly string[],
  options: {
    requireSettlement?: boolean;
    expected?: ToolExpectations;
    /** Require a valid seller ↔ payee account binding (SPEC §4.1). */
    requireBinding?: boolean;
    /** Verifiers for the payee's namespace, e.g. `evmBindingVerifier`. */
    bindingVerifiers?: readonly BindingVerifier[];
  } = {},
): ToolResultCheck {
  const signed = result._meta?.[RECEIPT_META_KEY] as SignedReceipt | undefined;
  if (!signed) return { ok: false, reasons: ["no Receptum receipt on the tool result"] };
  const sig = verifySignedReceipt(signed);
  if (!sig.ok) return { ok: false, receipt: signed, reasons: [`signature: ${sig.reason}`] };
  const r = signed.receipt;
  const reasons: string[] = [];
  if (toolOutputSha256(result) !== r.outputSha256)
    reasons.push("tool result does not match the receipt");
  const settlement = result._meta?.[X402_SETTLEMENT_META_KEY] as Settlement | undefined;
  if (options.requireSettlement !== false) {
    if (!settlement) reasons.push("no settlement on the tool result");
    else {
      if (settlement.success !== true) reasons.push("settlement did not succeed");
      if (settlement.transaction !== r.payment.reference)
        reasons.push("receipt references a different settlement");
      if (settlement.network !== r.payment.network)
        reasons.push("settlement is on a different network");
      if (settlement.payer && r.payment.payer && bare(settlement.payer) !== bare(r.payment.payer))
        reasons.push("receipt names a different payer");
    }
  }
  const e = options.expected ?? {};
  if (e.network && r.payment.network !== e.network) reasons.push("unexpected network");
  if (e.asset && r.payment.asset.toLowerCase() !== e.asset.toLowerCase())
    reasons.push("unexpected asset");
  if (e.amount && r.payment.amount !== e.amount) reasons.push("unexpected amount");
  if (e.maxAmount && BigInt(r.payment.amount) > BigInt(e.maxAmount))
    reasons.push("amount exceeds the maximum");
  if (e.payee && r.payment.payee?.toLowerCase() !== e.payee.toLowerCase())
    reasons.push("unexpected payee");
  if (e.payer && bare(r.payment.payer) !== bare(e.payer)) reasons.push("unexpected payer");
  if (e.argsSha256 && JSON.stringify(e.argsSha256) !== JSON.stringify(r.inputSha256))
    reasons.push("receipt is for different arguments");
  if (allowedSellers && !allowedSellers.includes(r.seller.id))
    reasons.push("seller is not on the allow-list");
  if (options.requireBinding) {
    const bound = checkPayeeBinding(
      signed,
      options.bindingVerifiers ? { verifiers: options.bindingVerifiers } : {},
    );
    if (!bound.ok) reasons.push(`account binding: ${bound.reason}`);
  }
  return { ok: reasons.length === 0, receipt: signed, reasons };
}

/**
 * @x402/mcp's client returns tool results without `_meta`, but its after-payment hook sees the
 * full result. This captures paid results so their receipts can be verified.
 */
export function captureReceipts(client: {
  onAfterPayment(
    hook: (ctx: { toolName: string; result: unknown }) => Promise<void> | void,
  ): unknown;
}) {
  const last = new Map<string, ToolResult>();
  client.onAfterPayment(({ toolName, result }) => {
    last.set(toolName, result as ToolResult);
  });
  return { lastResult: (toolName: string) => last.get(toolName) };
}
