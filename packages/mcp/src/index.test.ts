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
    expect(verifyToolResult(result).reasons).toContain("tool content does not match the receipt");
  });

  it("detects a receipt for another settlement", async () => {
    const result = await withReceipts(paid({ [X402_SETTLEMENT_META_KEY]: settled }), opts)({}, {});
    result._meta![X402_SETTLEMENT_META_KEY] = { ...settled, transaction: "0xother" };
    expect(verifyToolResult(result).ok).toBe(false);
  });

  it("reports missing receipts", () => {
    expect(verifyToolResult({ content: [] }).ok).toBe(false);
  });
});
