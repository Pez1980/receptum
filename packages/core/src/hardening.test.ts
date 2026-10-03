import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";
import { assertValidReceipt, createReceipt, receiptHash, type DeliveryReceipt } from "./receipt.js";
import { generateSellerKey, signReceipt, verifySignedReceipt } from "./signing.js";

// Regression tests for the independent (Codex) review findings, Oct 2026.
const key = generateSellerKey();
const base = () =>
  createReceipt({
    jobId: "j",
    seller: { id: key.did },
    inputSha256: [sha256Hex("in")],
    outputSha256: sha256Hex("out"),
    payment: {
      rail: "x402:exact",
      network: "eip155:84532",
      asset: "USDC",
      amount: "1",
      reference: "0x1",
      payee: "eip155:84532:0xSeller",
    },
  });
const mutate = (fn: (r: Record<string, unknown>) => void) => {
  const r = structuredClone(base()) as unknown as Record<string, unknown>;
  fn(r);
  return r as unknown as DeliveryReceipt;
};

describe("strict receipt validation", () => {
  it("rejects members that are not part of RRF v1", () => {
    expect(() => assertValidReceipt(mutate((r) => (r.prompt = "secret prompt")))).toThrow(
      /not part of RRF v1/,
    );
    expect(() =>
      assertValidReceipt(mutate((r) => ((r.payment as Record<string, unknown>).memo = "x"))),
    ).toThrow(/not part/);
  });
  it("rejects nulls for optional members", () => {
    expect(() => assertValidReceipt(mutate((r) => (r.buyer = null)))).toThrow(/omitted, not null/);
  });
  it("rejects numeric amounts", () => {
    expect(() =>
      assertValidReceipt(mutate((r) => ((r.payment as Record<string, unknown>).amount = 1))),
    ).toThrow(/amount/);
  });
  it("rejects non-Crockford receipt ids and date-only timestamps", () => {
    expect(() => assertValidReceipt(mutate((r) => (r.receiptId = "RCPT-IIII-OOOO")))).toThrow(
      /receiptId/,
    );
    expect(() => assertValidReceipt(mutate((r) => (r.deliveredAt = "2026-10-03")))).toThrow(
      /RFC 3339/,
    );
  });
  it("rejects non-integer remedy periods", () => {
    expect(() =>
      assertValidReceipt(mutate((r) => (r.remedy = { kind: "rerender", withinDays: 1.5 }))),
    ).toThrow(/withinDays/);
  });
  it("rejects inherited (non-own) required properties", () => {
    const r = mutate((x) => (x.seller = Object.create({ id: key.did })));
    expect(() => assertValidReceipt(r)).toThrow(/plain object|seller\.id/);
  });
});

describe("JCS input constraints", () => {
  it("rejects lone surrogates in values and keys", () => {
    expect(() => canonicalJson({ a: "\uD800" })).toThrow(/surrogate/);
    expect(() => canonicalJson({ ["\uDC00"]: 1 })).toThrow(/surrogate/);
    expect(canonicalJson({ a: "😀" })).toBe('{"a":"😀"}');
  });
  it("rejects sparse arrays and non-plain objects", () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    expect(() => canonicalJson(sparse)).toThrow(/sparse/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
  });
});

describe("JWS envelope strictness", () => {
  const signed = () => signReceipt(base(), key);
  it("rejects extra compact segments", () => {
    const s = signed();
    s.proof.jws += ".ignored";
    expect(verifySignedReceipt(s)).toMatchObject({ ok: false, reason: "malformed detached JWS" });
  });
  it("rejects a wrong kid fragment", () => {
    const s = signed();
    s.proof.kid = `${key.did}#other`;
    expect(verifySignedReceipt(s).ok).toBe(false);
  });
  it("rejects unexpected header parameters and typ", () => {
    const s = signed();
    const [, , sig] = s.proof.jws.split(".");
    const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: s.proof.kid, typ: "JWT" })).toString(
      "base64url",
    );
    s.proof.jws = `${h}..${sig}`;
    expect(verifySignedReceipt(s)).toMatchObject({ ok: false, reason: "unexpected typ" });
    const h2 = Buffer.from(
      JSON.stringify({ alg: "EdDSA", kid: s.proof.kid, typ: "receptum+jws", crit: ["x"] }),
    ).toString("base64url");
    s.proof.jws = `${h2}..${sig}`;
    expect(verifySignedReceipt(s)).toMatchObject({
      ok: false,
      reason: "unexpected JWS header parameters",
    });
  });
  it("still verifies genuine receipts and their payee", () => {
    const s = signed();
    expect(verifySignedReceipt(s).ok).toBe(true);
    expect(s.receipt.payment.payee).toBe("eip155:84532:0xSeller");
    expect(receiptHash(s.receipt)).toBe(s.receiptHash);
  });
});
