import {
  canonicalJson,
  createReceipt,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
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
 * `{ content, structuredContent?, isError? }` — everything a consumer may act on.
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
      ...(result.isError ? { isError: true } : {}),
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
    return {
      ...result,
      _meta: { ...result._meta, [RECEIPT_META_KEY]: signReceipt(receipt, options.seller) },
    };
  };
}

export interface ToolResultCheck {
  ok: boolean;
  receipt?: SignedReceipt;
  reasons: string[];
}

/** Client side: checks a paid tool result against its receipt. Pure; no network. Fails closed. */
export function verifyToolResult(
  result: ToolResult,
  allowedSellers?: readonly string[],
  options: {
    requireSettlement?: boolean;
    expectedArgsSha256?: Sha256Hex[];
    maxAmount?: string;
  } = {},
): ToolResultCheck {
  const signed = result._meta?.[RECEIPT_META_KEY] as SignedReceipt | undefined;
  if (!signed) return { ok: false, reasons: ["no Receptum receipt on the tool result"] };
  const reasons: string[] = [];
  const sig = verifySignedReceipt(signed);
  if (!sig.ok) reasons.push(`signature: ${sig.reason}`);
  if (toolOutputSha256(result) !== signed.receipt.outputSha256)
    reasons.push("tool result does not match the receipt");
  const settlement = result._meta?.[X402_SETTLEMENT_META_KEY] as Settlement | undefined;
  if (options.requireSettlement !== false) {
    if (!settlement) reasons.push("no settlement on the tool result");
    else {
      if (settlement.success !== true) reasons.push("settlement did not succeed");
      if (settlement.transaction !== signed.receipt.payment.reference)
        reasons.push("receipt references a different settlement");
      if (settlement.network !== signed.receipt.payment.network)
        reasons.push("settlement is on a different network");
    }
  }
  if (
    options.expectedArgsSha256 &&
    JSON.stringify(options.expectedArgsSha256) !== JSON.stringify(signed.receipt.inputSha256)
  ) {
    reasons.push("receipt is for different arguments");
  }
  if (options.maxAmount && BigInt(signed.receipt.payment.amount) > BigInt(options.maxAmount))
    reasons.push("amount exceeds the maximum");
  if (allowedSellers && !allowedSellers.includes(signed.receipt.seller.id))
    reasons.push("seller is not on the allow-list");
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
