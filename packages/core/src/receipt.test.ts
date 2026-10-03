import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { createReceipt, receiptHash, type ReceiptInput } from "./receipt.js";

export const sampleInput: ReceiptInput = {
  jobId: "job-123",
  receiptId: "RCPT-7F3A-21C9",
  seller: {
    id: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    name: "render.example",
  },
  inputSha256: [sha256Hex("source")],
  outputSha256: sha256Hex("output"),
  evidence: { qaReport: sha256Hex("qa") },
  payment: {
    rail: "x402:exact",
    network: "eip155:84532",
    asset: "USDC",
    amount: "2500000",
    reference: "0xabc",
  },
  acceptance: { mode: "auto", reviewWindowSeconds: 259_200 },
  remedy: { kind: "rerender", withinDays: 30 },
  deliveredAt: new Date("2026-10-04T12:00:00Z"),
};

function without<K extends keyof ReceiptInput>(input: ReceiptInput, key: K): ReceiptInput {
  const copy = { ...input };
  delete copy[key];
  return copy;
}

describe("createReceipt", () => {
  it("never publishes the raw job id", () => {
    const receipt = createReceipt(sampleInput);
    expect(receipt.jobIdHash).toBe(sha256Hex("job-123"));
    expect(JSON.stringify(receipt)).not.toContain("job-123");
  });

  it("defaults acceptance to auto-release after 24h", () => {
    const rest = without(sampleInput, "acceptance");
    expect(createReceipt(rest).acceptance).toEqual({ mode: "auto", reviewWindowSeconds: 86_400 });
  });

  it("generates readable receipt ids", () => {
    const rest = without(sampleInput, "receiptId");
    expect(createReceipt(rest).receiptId).toMatch(/^RCPT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("rejects malformed hashes", () => {
    expect(() => createReceipt({ ...sampleInput, outputSha256: "nope" })).toThrow(/outputSha256/);
  });

  it("requires at least one input", () => {
    expect(() => createReceipt({ ...sampleInput, inputSha256: [] })).toThrow(/input hash/);
  });

  it("rejects non-integer amounts", () => {
    expect(() =>
      createReceipt({ ...sampleInput, payment: { ...sampleInput.payment, amount: "2.5" } }),
    ).toThrow(/amount/);
  });

  it("requires a CAIP-2 network", () => {
    expect(() =>
      createReceipt({ ...sampleInput, payment: { ...sampleInput.payment, network: "base" } }),
    ).toThrow(/CAIP-2/);
  });

  it("requires an evaluator in evaluator mode", () => {
    expect(() => createReceipt({ ...sampleInput, acceptance: { mode: "evaluator" } })).toThrow(
      /evaluator/,
    );
  });

  it("requires a terms hash for terms remedies", () => {
    expect(() => createReceipt({ ...sampleInput, remedy: { kind: "terms" } })).toThrow(
      /termsSha256/,
    );
  });

  it("links re-render receipts to the original", () => {
    const first = createReceipt(sampleInput);
    const fix = createReceipt({
      ...sampleInput,
      receiptId: "RCPT-7F3A-21CA",
      supersedes: receiptHash(first),
    });
    expect(fix.supersedes).toBe(receiptHash(first));
  });
});

describe("receiptHash", () => {
  it("is stable for the same receipt", () => {
    expect(receiptHash(createReceipt(sampleInput))).toBe(receiptHash(createReceipt(sampleInput)));
  });

  it("changes when the output changes", () => {
    const other = createReceipt({ ...sampleInput, outputSha256: sha256Hex("other") });
    expect(receiptHash(other)).not.toBe(receiptHash(createReceipt(sampleInput)));
  });
});
