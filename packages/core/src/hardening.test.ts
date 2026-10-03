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
    for (const bad of ["2026-10-03", "2026-02-30T00:00:00Z", "2026-10-03T24:00:00Z"]) {
      expect(() => assertValidReceipt(mutate((r) => (r.deliveredAt = bad)))).toThrow(/timestamp/);
    }
    expect(() =>
      assertValidReceipt(mutate((r) => (r.deliveredAt = "2028-02-29T12:00:00.5Z"))),
    ).not.toThrow();
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

describe("identity syntax and arrays", () => {
  it("requires DID or CAIP-10 identities and CAIP-10 payment accounts", () => {
    expect(() =>
      assertValidReceipt(mutate((r) => ((r.seller as Record<string, unknown>).id = "bob"))),
    ).toThrow(/seller.id/);
    expect(() =>
      assertValidReceipt(
        mutate((r) => ((r.payment as Record<string, unknown>).payee = "0xSeller")),
      ),
    ).toThrow(/payee/);
  });
  it("rejects sparse input arrays", () => {
    const r = mutate((x) => {
      const a: unknown[] = [];
      a[1] = sha256Hex("x");
      x.inputSha256 = a;
    });
    expect(() => assertValidReceipt(r)).toThrow(/missing/);
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
  it("rejects extra kid fragments and non-canonical signature encodings", () => {
    const s = signed();
    const extra = { ...s, proof: { ...s.proof, kid: `${s.proof.kid}#junk` } };
    expect(verifySignedReceipt(extra).ok).toBe(false);
    const [h, , sig] = s.proof.jws.split(".");
    const last = sig!.slice(-1);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const flipped = alphabet[(alphabet.indexOf(last) ^ 1) % 64]!;
    const t2 = { ...s, proof: { ...s.proof, jws: `${h}..${sig!.slice(0, -1)}${flipped}` } };
    expect(verifySignedReceipt(t2).ok).toBe(false);
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
