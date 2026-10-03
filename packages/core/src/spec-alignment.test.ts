import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BINDING_JWS_TYP,
  bindingBytes,
  checkPayeeBinding,
  stellarAccountSigner,
  type AccountBinding,
  type AccountBindingStatement,
} from "./binding.js";
import { sha256Hex } from "./hash.js";
import { parseStrictJson, parseStrictJsonBytes } from "./json.js";
import {
  assertValidReceipt,
  compareTimestamps,
  createReceipt,
  isCaip10,
  isDid,
  isUtcTimestamp,
  receiptBytes,
  receiptHash,
  type DeliveryReceipt,
} from "./receipt.js";
import {
  RECEIPT_JWS_TYP,
  sellerKeyFromSeed,
  signDetachedJws,
  signReceipt,
  verifySignedReceipt,
  type SignedReceipt,
} from "./signing.js";

// Regression tests for the SPEC alignment between the TypeScript and Python verifiers (Oct 2026).
// RFC 8032 §7.1 TEST 1 seed: a PUBLIC test value, never a real key.
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const key = sellerKeyFromSeed(SEED);
const b64u = (d: Uint8Array | string) => Buffer.from(d).toString("base64url");
/** S… StrKey (version byte 18 << 3) of raw seed bytes, built at runtime from the public seed. */
const seedStrKey = (seed: Uint8Array) => {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const body = Uint8Array.from([18 << 3, ...seed]);
  let crc = 0;
  for (const b of body) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of [...body, crc & 0xff, crc >> 8]) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
};

const base = (over: Partial<Parameters<typeof createReceipt>[0]> = {}) =>
  createReceipt({
    jobId: "j",
    seller: { id: key.did },
    inputSha256: [sha256Hex("in")],
    outputSha256: sha256Hex("out"),
    payment: {
      rail: "x402:exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "1",
      reference: "0x" + "ab".repeat(32),
    },
    deliveredAt: new Date("2026-10-04T12:00:00Z"),
    ...over,
  });
const mutate = (fn: (r: Record<string, unknown>) => void) => {
  const r = structuredClone(base()) as unknown as Record<string, unknown>;
  fn(r);
  return r as unknown as DeliveryReceipt;
};

describe("item 7: strict I-JSON input", () => {
  it("rejects duplicate member names that JSON.parse would collapse", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/duplicate member name "a"/);
    expect(() => parseStrictJson('{"x":[{"b":1,"b":1}]}')).toThrow(/duplicate/);
    // Same key spelled with an escape is still the same member.
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow(/duplicate/);
  });
  it("rejects lone surrogates, out-of-range numbers, invalid UTF-8 and a BOM", () => {
    expect(() => parseStrictJson('{"a":"\\ud800"}')).toThrow(/lone surrogate/);
    expect(() => parseStrictJson('{"\\udc00":1}')).toThrow(/lone surrogate/);
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe("😀");
    expect(() => parseStrictJson("1e400")).toThrow(/IEEE 754/);
    expect(() => parseStrictJson("-1e400")).toThrow(/IEEE 754/);
    expect(() => parseStrictJson("NaN")).toThrow();
    expect(() => parseStrictJsonBytes(Uint8Array.from([0x22, 0xff, 0x22]))).toThrow(/UTF-8/);
    expect(() => parseStrictJsonBytes(Buffer.from('\uFEFF{"a":1}'))).toThrow(/byte order mark/);
  });
  it("parses ordinary JSON like JSON.parse, with __proto__ as a plain member", () => {
    const text = '{"b":[1,2.5,-0,true,null,"x"],"a":{"c":"\\n"}, "n": 1e3 }';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    const o = parseStrictJson('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.keys(o)).toEqual(["__proto__"]);
    expect(() => parseStrictJson('{"a":1} x')).toThrow(/after the JSON value/);
    expect(() => parseStrictJson("[1,]")).toThrow();
    expect(() => parseStrictJson("01")).toThrow();
  });
});

describe("item 5: signed-receipt envelope", () => {
  const signed = () => signReceipt(base(), key);
  it("rejects extra envelope and proof members, and a non-hex64 receiptHash", () => {
    expect(
      verifySignedReceipt({ ...signed(), extra: 1 } as unknown as SignedReceipt),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown members: extra/) });
    const s = signed();
    expect(
      verifySignedReceipt({
        ...s,
        proof: { ...s.proof, alg: "EdDSA" },
      } as unknown as SignedReceipt),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly type, kid, jws/) });
    expect(verifySignedReceipt({ ...s, receiptHash: s.receiptHash.toUpperCase() })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/receiptHash must be 64 lower-case hex/),
    });
    const noProof: Partial<SignedReceipt> = { ...s };
    delete noProof.proof;
    expect(verifySignedReceipt(noProof as SignedReceipt).ok).toBe(false);
  });
  it("treats bindings null and [] as absent, and rejects a non-array", () => {
    const s = signed();
    for (const bindings of [null, []])
      expect(verifySignedReceipt({ ...s, bindings } as unknown as SignedReceipt).ok).toBe(true);
    expect(verifySignedReceipt({ ...s, bindings: {} } as unknown as SignedReceipt)).toMatchObject({
      ok: false,
      reason: "bindings must be an array",
    });
    const withPayee = signReceipt(
      {
        ...s.receipt,
        payment: { ...s.receipt.payment, payee: "eip155:84532:0x" + "11".repeat(20) },
      },
      key,
    );
    for (const bindings of [null, []])
      expect(
        checkPayeeBinding({ ...withPayee, bindings } as unknown as SignedReceipt),
      ).toMatchObject({ ok: false, reason: "receipt carries no account bindings" });
  });
});

describe("item 6: JWS header and signature", () => {
  const resign = (headerJson: string): SignedReceipt => {
    const s = signReceipt(base(), key);
    const h = b64u(headerJson);
    const sig = sign(null, Buffer.from(`${h}.${b64u(receiptBytes(s.receipt))}`), key.privateKey);
    return { ...s, proof: { ...s.proof, jws: `${h}..${b64u(sig)}` } };
  };
  it("rejects a correctly signed header with duplicate members", () => {
    const kid = signReceipt(base(), key).proof.kid;
    // JSON.parse keeps the last alg ("EdDSA"); an I-JSON verifier must reject the header.
    const dup = `{"alg":"none","alg":"EdDSA","kid":${JSON.stringify(kid)},"typ":"${RECEIPT_JWS_TYP}"}`;
    expect(verifySignedReceipt(resign(dup))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not I-JSON: .*duplicate member name "alg"/),
    });
    const fine = `{"alg":"EdDSA","kid":${JSON.stringify(kid)},"typ":"${RECEIPT_JWS_TYP}"}`;
    expect(verifySignedReceipt(resign(fine)).ok).toBe(true);
  });
  it("rejects a signature with S >= L (malleated)", () => {
    const s = signReceipt(base(), key);
    const [h, , sig] = s.proof.jws.split(".") as [string, string, string];
    const bytes = Buffer.from(sig, "base64url");
    const L = 2n ** 252n + 27742317777372353535851770400913936493n;
    let S = 0n;
    for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(bytes[i]!);
    let T = S + L;
    for (let i = 32; i < 64; i++) {
      bytes[i] = Number(T & 0xffn);
      T >>= 8n;
    }
    const m = { ...s, proof: { ...s.proof, jws: `${h}..${b64u(bytes)}` } };
    expect(verifySignedReceipt(m)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/S >= L/),
    });
  });
  it("requires a did:key seller: CAIP-10 sellers can't carry a JWS proof", () => {
    const r = mutate((x) => ((x.seller as Record<string, unknown>).id = "eip155:84532:0xabc"));
    expect(() => assertValidReceipt(r)).not.toThrow();
    const s = signReceipt(base(), key);
    const res = verifySignedReceipt({ ...s, receipt: r, receiptHash: receiptHash(r) });
    expect(res).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not an Ed25519 did:key/),
    });
  });
});

describe("item 8: identity syntax", () => {
  it("never treats did:* as CAIP-10, so payer/payee reject DIDs", () => {
    expect(isCaip10("did:key:z6Mkabc")).toBe(false);
    expect(isCaip10("eip155:1:0xabc")).toBe(true);
    for (const k of ["payer", "payee"])
      expect(() =>
        assertValidReceipt(mutate((r) => ((r.payment as Record<string, unknown>)[k] = key.did))),
      ).toThrow(new RegExp(`payment.${k} must be a CAIP-10`));
  });
  it("uses the W3C DID ABNF: a bare % is not pct-encoded", () => {
    expect(isDid("did:web:a%")).toBe(false);
    expect(isDid("did:web:a%2")).toBe(false);
    expect(isDid("did:web:a%20b")).toBe(true);
    expect(isDid("did:example::x")).toBe(true);
    expect(isDid("did:example:x:")).toBe(false);
    expect(() => assertValidReceipt(mutate((r) => (r.buyer = { id: "did:web:a%" })))).toThrow(
      /buyer.id/,
    );
  });
  it("requires seller.id to be an Ed25519 did:key or CAIP-10 (not any DID)", () => {
    expect(() =>
      assertValidReceipt(mutate((r) => ((r.seller as Record<string, unknown>).id = "did:web:x"))),
    ).toThrow(/seller.id must be an Ed25519 did:key/);
    expect(() =>
      assertValidReceipt(
        mutate((r) => ((r.seller as Record<string, unknown>).id = "did:key:z6MkInvalid")),
      ),
    ).toThrow(/seller.id/);
  });
});

describe("item 9: acceptance.evaluator only in evaluator mode", () => {
  it("rejects an evaluator when mode is not evaluator", () => {
    expect(() =>
      assertValidReceipt(
        mutate(
          (r) => (r.acceptance = { mode: "auto", reviewWindowSeconds: 0, evaluator: key.did }),
        ),
      ),
    ).toThrow(/only allowed when mode is "evaluator"/);
    expect(() =>
      assertValidReceipt(
        mutate(
          (r) =>
            (r.acceptance = { mode: "evaluator", reviewWindowSeconds: 0, evaluator: "did:web:qa" }),
        ),
      ),
    ).not.toThrow();
  });
  it("allows termsSha256 for any remedy kind but requires kind", () => {
    expect(() =>
      assertValidReceipt(
        mutate((r) => (r.remedy = { kind: "refund", termsSha256: sha256Hex("t") })),
      ),
    ).not.toThrow();
    expect(() => assertValidReceipt(mutate((r) => (r.remedy = { withinDays: 3 })))).toThrow(
      /remedy.kind/,
    );
  });
});

describe("item 10: timestamps", () => {
  it("allows 1–9 fractional digits, years 0001–9999", () => {
    expect(isUtcTimestamp("2026-10-04T12:00:00.123456789Z")).toBe(true);
    expect(isUtcTimestamp("2026-10-04T12:00:00.1234567890Z")).toBe(false);
    expect(isUtcTimestamp("2026-10-04T12:00:00.Z")).toBe(false);
    expect(isUtcTimestamp("0000-01-01T00:00:00Z")).toBe(false);
    expect(isUtcTimestamp("0001-01-01T00:00:00Z")).toBe(true);
    expect(isUtcTimestamp("2026-10-04T12:00:60Z")).toBe(false);
  });
  it("compares exactly at full fractional precision", () => {
    expect(compareTimestamps("2026-10-04T12:00:00.0001Z", "2026-10-04T12:00:00.0005Z")).toBe(-1);
    expect(Date.parse("2026-10-04T12:00:00.0001Z")).toBe(Date.parse("2026-10-04T12:00:00.0005Z"));
    expect(compareTimestamps("2026-10-04T12:00:00.5Z", "2026-10-04T12:00:00.500000000Z")).toBe(0);
    expect(compareTimestamps("2026-10-04T12:00:01Z", "2026-10-04T12:00:00.999999999Z")).toBe(1);
  });
  it("covers a receipt delivered 0.4 µs before expiresAt (Date.parse would call it expired)", async () => {
    const stellar = stellarAccountSigner(seedStrKey(SEED));
    const r = mutate((x) => {
      (x.payment as Record<string, unknown>).rail = "x402:exact";
      (x.payment as Record<string, unknown>).network = "stellar:testnet";
      (x.payment as Record<string, unknown>).payee = stellar.account;
      x.deliveredAt = "2026-10-04T12:00:00.0001Z";
    });
    const statement: AccountBindingStatement = {
      type: "receptum/account-binding/1",
      did: key.did,
      account: stellar.account,
      issuedAt: "2026-10-01T00:00:00Z",
      expiresAt: "2026-10-04T12:00:00.0005Z",
    };
    const bytes = bindingBytes(statement);
    const binding: AccountBinding = {
      statement,
      didProof: signDetachedJws(bytes, key, BINDING_JWS_TYP),
      accountProof: await stellar.signBinding(new TextEncoder().encode(bytes)),
    };
    const signed = { ...signReceipt(r, key), bindings: [binding] };
    expect(checkPayeeBinding(signed)).toMatchObject({ ok: true });
    const late = mutate((x) => {
      (x.payment as Record<string, unknown>).network = "stellar:testnet";
      (x.payment as Record<string, unknown>).payee = stellar.account;
      x.deliveredAt = "2026-10-04T12:00:00.0005Z";
    });
    expect(checkPayeeBinding({ ...signReceipt(late, key), bindings: [binding] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/expired/),
    });
  });
});

describe("item 11: integers and strings", () => {
  it("accepts integral doubles and rejects out-of-range or fractional integers", () => {
    expect(() =>
      assertValidReceipt(
        mutate((r) => (r.acceptance = { mode: "auto", reviewWindowSeconds: 3.0 })),
      ),
    ).not.toThrow();
    for (const bad of [-1, 2 ** 53, 1.5])
      expect(() =>
        assertValidReceipt(
          mutate((r) => (r.acceptance = { mode: "auto", reviewWindowSeconds: bad })),
        ),
      ).toThrow(/reviewWindowSeconds/);
    expect(() =>
      assertValidReceipt(mutate((r) => (r.remedy = { kind: "refund", withinDays: 2 ** 53 - 1 }))),
    ).not.toThrow();
  });
  it("allows an empty evidence object and duplicate input hashes; rejects empty strings", () => {
    expect(() => assertValidReceipt(mutate((r) => (r.evidence = {})))).not.toThrow();
    expect(() =>
      assertValidReceipt(mutate((r) => (r.inputSha256 = [sha256Hex("a"), sha256Hex("a")]))),
    ).not.toThrow();
    for (const k of ["rail", "asset", "reference"])
      expect(() =>
        assertValidReceipt(mutate((r) => ((r.payment as Record<string, unknown>)[k] = ""))),
      ).toThrow(/non-empty/);
    expect(() =>
      assertValidReceipt(mutate((r) => ((r.seller as Record<string, unknown>).name = ""))),
    ).toThrow(/non-empty/);
    for (const amount of ["01", "-1", "1.0", " 1"])
      expect(() =>
        assertValidReceipt(mutate((r) => ((r.payment as Record<string, unknown>).amount = amount))),
      ).toThrow(/amount/);
  });
});
