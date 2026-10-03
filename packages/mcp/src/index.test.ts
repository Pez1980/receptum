import { describe, expect, it } from "vitest";
import { generateSellerKey } from "@receptum/core";
import {
  RECEIPT_META_KEY,
  verifyToolResult,
  withReceipts,
  X402_SETTLEMENT_META_KEY,
  type ToolResult,
} from "./index.js";

const seller = generateSellerKey();
const settled = {
  success: true,
  transaction: "0xsettle",
  network: "eip155:84532",
  payer: "0xBuyer",
};
const paid =
  (meta?: Record<string, unknown>, isError = false) =>
  async (): Promise<ToolResult> => ({
    content: [{ type: "text", text: "analysis: AAPL looks fine" }],
    ...(isError ? { isError } : {}),
    ...(meta ? { _meta: meta } : {}),
  });
const opts = { seller, price: { asset: "0xUSDC", amount: "100000" } };

describe("withReceipts", () => {
  it("attaches a verifiable receipt to settled calls", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), opts)(
      { ticker: "AAPL" },
      {},
    );
    expect(result._meta?.[RECEIPT_META_KEY]).toBeTruthy();
    expect(verifyToolResult(result, [seller.did])).toMatchObject({ ok: true });
  });

  it("passes unsettled and failed calls through without a receipt", async () => {
    expect((await withReceipts(paid(), opts)({}, {}))._meta?.[RECEIPT_META_KEY]).toBeUndefined();
    const failed = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }, true), opts)(
      {},
      {},
    );
    expect(failed._meta?.[RECEIPT_META_KEY]).toBeUndefined();
  });
});

describe("verifyToolResult", () => {
  it("detects altered tool content", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), opts)({}, {});
    (result.content[0] as { text: string }).text = "something else";
    expect(verifyToolResult(result).reasons).toContain("tool result does not match the receipt");
  });

  it("detects a receipt for another settlement", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), opts)({}, {});
    result._meta![X402_SETTLEMENT_META_KEY] = { ...settled, transaction: "0xother" };
    expect(verifyToolResult(result).ok).toBe(false);
  });

  it("detects structured-output and error-status tampering", async () => {
    const result = await withReceipts(
      async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { approved: true },
        _meta: { [X402_SETTLEMENT_META_KEY]: settled },
      }),
      opts,
    )({}, {});
    expect(verifyToolResult(result).ok).toBe(true);
    result.structuredContent = { approved: false };
    expect(verifyToolResult(result).ok).toBe(false);
    result.structuredContent = { approved: true };
    result.isError = true;
    expect(verifyToolResult(result).ok).toBe(false);
  });

  it("fails closed without a successful settlement", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), opts)({}, {});
    delete result._meta![X402_SETTLEMENT_META_KEY];
    expect(verifyToolResult(result).reasons).toContain("no settlement on the tool result");
    result._meta![X402_SETTLEMENT_META_KEY] = { ...settled, success: false };
    expect(verifyToolResult(result).reasons).toContain("settlement did not succeed");
  });

  it("hashes isError:false distinctly from an absent isError", async () => {
    const { toolOutputSha256 } = await import("./index.js");
    expect(toolOutputSha256({ content: [], isError: false })).not.toBe(
      toolOutputSha256({ content: [] }),
    );
  });

  it("enforces the caller's expectations", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), {
      ...opts,
      price: { ...opts.price, payTo: "0xSeller" },
    })({}, {});
    expect(
      verifyToolResult(result, undefined, {
        expected: { network: "eip155:84532", payee: "eip155:84532:0xseller", maxAmount: "100000" },
      }).ok,
    ).toBe(true);
    expect(
      verifyToolResult(result, undefined, { expected: { payee: "eip155:84532:0xAttacker" } })
        .reasons,
    ).toContain("unexpected payee");
    expect(verifyToolResult(result, undefined, { expected: { amount: "1" } }).reasons).toContain(
      "unexpected amount",
    );
  });

  it("returns a failed check for malformed receipts instead of throwing", () => {
    expect(
      verifyToolResult({ content: [], _meta: { [RECEIPT_META_KEY]: { receipt: {} } } }).ok,
    ).toBe(false);
  });

  it("reports missing receipts", () => {
    expect(verifyToolResult({ content: [] }).ok).toBe(false);
  });
});
