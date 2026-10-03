import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { createReceipt, receiptHash, type ReceiptInput } from "./receipt.js";

const input: ReceiptInput = {
  jobId: "job-123",
  inputSha256: [sha256Hex("source")],
  outputSha256: sha256Hex("output"),
  evidence: { qaReport: sha256Hex("qa") },
  payment: { rail: "evm:base", asset: "USDC", amount: "2500000", reference: "0xabc" },
  deliveredAt: new Date("2026-10-04T12:00:00Z"),
};

describe("createReceipt", () => {
  it("never publishes the raw job id", () => {
    const receipt = createReceipt(input);
    expect(receipt.jobIdHash).toBe(sha256Hex("job-123"));
    expect(JSON.stringify(receipt)).not.toContain("job-123");
  });

  it("rejects malformed hashes", () => {
    expect(() => createReceipt({ ...input, outputSha256: "nope" })).toThrow(/outputSha256/);
  });

  it("requires at least one input", () => {
    expect(() => createReceipt({ ...input, inputSha256: [] })).toThrow(/input hash/);
  });

  it("rejects non-integer amounts", () => {
    expect(() => createReceipt({ ...input, payment: { ...input.payment, amount: "2.5" } })).toThrow(
      /amount/,
    );
  });
});

describe("receiptHash", () => {
  it("is stable for the same receipt", () => {
    expect(receiptHash(createReceipt(input))).toBe(receiptHash(createReceipt(input)));
  });

  it("changes when the output changes", () => {
    const other = createReceipt({ ...input, outputSha256: sha256Hex("other") });
    expect(receiptHash(other)).not.toBe(receiptHash(createReceipt(input)));
  });
});
