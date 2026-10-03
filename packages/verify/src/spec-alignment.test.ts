import { describe, expect, it } from "vitest";
import {
  createReceipt,
  generateSellerKey,
  sha256Hex,
  signReceipt,
  type SignedReceipt,
} from "@receptum/core";
import { parseAnchorRef, parseReceiptInput, verdictOf, verify, type Check } from "./index.js";

// Regression tests for the SPEC alignment with the Python verifier (Oct 2026). None of them
// needs the network: every online path below stops before its first RPC call.
const seller = generateSellerKey();
const file = new TextEncoder().encode("delivered bytes");
const receipt = (payment: Partial<Parameters<typeof createReceipt>[0]["payment"]> = {}) =>
  signReceipt(
    createReceipt({
      jobId: "j",
      seller: { id: seller.did },
      inputSha256: [sha256Hex("source")],
      outputSha256: sha256Hex(file),
      payment: {
        rail: "x402:exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        reference: "0x" + "ab".repeat(32),
        ...payment,
      },
    }),
    seller,
  );
const x402 = receipt();
const escrow = receipt({
  rail: "escrow:receptum-evm",
  reference: "eip155:84532:0x" + "11".repeat(20) + ":1",
});

const c = (level: Check["level"], name: string, status: Check["status"]): Check => ({
  level,
  name,
  status,
  detail: "d",
});
const allPass = [
  c(1, "File matches receipt", "pass"),
  c(2, "Seller signature", "pass"),
  c(2.5, "Seller controls payee", "pass"),
  c(3, "Payment on eip155:84532", "pass"),
];

describe("item 1: verdicts (SPEC §6)", () => {
  it("x402 needs a passing anchor: payment alone is PARTIALLY VERIFIED", () => {
    const v = verdictOf(x402, allPass);
    expect(v.verdict).toBe("PARTIALLY VERIFIED");
    expect(v.missing.join()).toMatch(/receiptHash is not committed on-chain/);
    expect(verdictOf(x402, [...allPass, c(3, "Anchor on eip155:5042002", "pass")]).verdict).toBe(
      "VERIFIED",
    );
  });
  it("an escrow rail commits receiptHash itself", () => {
    expect(verdictOf(escrow, allPass)).toEqual({ verdict: "VERIFIED", missing: [] });
  });
  it("needs the delivered file (L1 pass)", () => {
    const noFile = [c(1, "File matches receipt", "skipped"), ...allPass.slice(1)];
    const v = verdictOf(escrow, noFile);
    expect(v.verdict).toBe("PARTIALLY VERIFIED");
    expect(v.missing[0]).toMatch(/^L1:/);
  });
  it("L2.5 may be skipped (no payee / --allow-unbound) but not pending or unavailable", () => {
    const with25 = (s: Check["status"]) => [
      allPass[0]!,
      allPass[1]!,
      c(2.5, "Seller controls payee", s),
      allPass[3]!,
    ];
    expect(verdictOf(escrow, with25("skipped")).verdict).toBe("VERIFIED");
    expect(verdictOf(escrow, with25("pending")).missing.join()).toMatch(/--allow-unbound/);
    expect(verdictOf(escrow, with25("unavailable")).verdict).toBe("PARTIALLY VERIFIED");
  });
  it("any pending or unavailable check blocks VERIFIED; any failure is NOT VERIFIED", () => {
    const anchors = (s: Check["status"]) => [
      ...allPass,
      c(3, "Anchor on eip155:5042002", "pass"),
      c(3, "Anchor on xrpl:1", s),
    ];
    expect(verdictOf(x402, anchors("unavailable")).verdict).toBe("PARTIALLY VERIFIED");
    expect(verdictOf(x402, anchors("pending")).verdict).toBe("PARTIALLY VERIFIED");
    expect(verdictOf(x402, anchors("fail")).verdict).toBe("NOT VERIFIED");
    const unavailablePayment = [
      ...allPass.slice(0, 3),
      c(3, "Payment on eip155:84532", "unavailable"),
    ];
    expect(verdictOf(escrow, unavailablePayment).missing.join()).toMatch(
      /payment was not confirmed/,
    );
  });
  it("verify() reports the missing pieces offline", async () => {
    const r = await verify(x402, { file, offline: true });
    expect(r).toMatchObject({ verdict: "PARTIALLY VERIFIED", ok: true, complete: false });
    expect(r.missing.join("\n")).toMatch(/payment was not confirmed[\s\S]*not committed on-chain/);
    const noFile = await verify(x402, { offline: true });
    expect(noFile.checks[0]).toMatchObject({ level: 1, status: "skipped" });
    expect(noFile.missing[0]).toMatch(/^L1: no delivered file given/);
  });
  it("never reaches level 3 for an unauthenticated receipt", async () => {
    const t = structuredClone(x402);
    t.receipt.payment.amount = "2";
    const r = await verify(t, { file, anchors: ["eip155:5042002:0x" + "00".repeat(32)] });
    expect(r.verdict).toBe("NOT VERIFIED");
    expect(r.checks.filter((x) => x.level === 3).map((x) => x.status)).toEqual(["skipped"]);
  });
});

describe("item 3: x402:exact on eip155", () => {
  it("fails a symbolic asset or a malformed reference before any RPC call", async () => {
    const sym = await verify(receipt({ asset: "USDC" }), { file });
    expect(sym.checks.find((x) => x.name.startsWith("Payment"))).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/token contract address/),
    });
    const ref = await verify(receipt({ reference: "0x00" }), { file });
    expect(ref.checks.find((x) => x.name.startsWith("Payment"))?.detail).toMatch(
      /not an EVM transaction hash/,
    );
  });
  it("recognises only the exact scheme", async () => {
    const r = await verify(receipt({ rail: "x402:upto" }), { file });
    expect(r.checks.find((x) => x.name.startsWith("Payment"))).toMatchObject({
      status: "unavailable",
      detail: expect.stringMatching(/only the x402 "exact" scheme/),
    });
    expect(r.verdict).toBe("PARTIALLY VERIFIED");
  });
  it("treats an unsupported network as unavailable, never pass or fail", async () => {
    const r = await verify(receipt({ network: "eip155:1" }), { file });
    expect(r.checks.find((x) => x.name.startsWith("Payment"))?.status).toBe("unavailable");
  });
});

describe("item 4: anchor references", () => {
  // x402:upto makes the payment check return before any network call.
  const upto = receipt({ rail: "x402:upto" });
  const anchorCheck = async (ref: string) =>
    (await verify(upto, { file, anchors: [ref] })).checks.find((x) => x.name.startsWith("Anchor"));
  it("parses <caip2>:<tx>", () => {
    expect(parseAnchorRef("eip155:5042002:0xabc")).toEqual({
      network: "eip155:5042002",
      reference: "0xabc",
    });
    expect(parseAnchorRef("0xabc")).toBeNull();
    expect(parseAnchorRef("eip155:5042002:")).toBeNull();
    expect(parseAnchorRef("EIP155:1:0xabc")).toBeNull();
  });
  it("fails malformed references and is unavailable for unsupported networks", async () => {
    expect((await anchorCheck("not-an-anchor"))?.status).toBe("fail");
    expect(await anchorCheck("eip155:5042002:0x1234")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/malformed/),
    });
    expect(await anchorCheck("cosmos:hub-4:" + "ab".repeat(32))).toMatchObject({
      status: "unavailable",
    });
    expect((await anchorCheck("xrpl:1:XYZ"))?.status).toBe("fail");
    expect((await anchorCheck("stellar:testnet:" + "AB".repeat(32)))?.status).toBe("fail");
  });
});

describe("items 1 and 7: receipt files", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const bare = JSON.stringify(x402);
  it("accepts a bare signed receipt and a wrapper with one or several anchors", () => {
    expect(parseReceiptInput(enc(bare))).toEqual({ signed: x402, anchors: [] });
    const a = "eip155:5042002:0x" + "ab".repeat(32);
    expect(
      parseReceiptInput(enc(JSON.stringify({ signedReceipt: x402, anchor: a, note: "x" }))),
    ).toEqual({ signed: x402, anchors: [a] });
    expect(
      parseReceiptInput(enc(JSON.stringify({ signedReceipt: x402, anchor: [a, a] }))).anchors,
    ).toEqual([a, a]);
    expect(() =>
      parseReceiptInput(enc(JSON.stringify({ signedReceipt: x402, anchor: 7 }))),
    ).toThrow(/anchor/);
  });
  it("rejects duplicate member names anywhere in the file", () => {
    const dupInner = bare.replace('"amount":"1"', '"amount":"999","amount":"1"');
    expect(JSON.parse(dupInner)).toEqual(x402);
    expect(() => parseReceiptInput(enc(dupInner))).toThrow(/duplicate member name "amount"/);
    expect(() =>
      parseReceiptInput(enc(`{"signedReceipt":${bare},"signedReceipt":${bare}}`)),
    ).toThrow(/duplicate/);
  });
  it("rejects lone surrogates, out-of-range numbers and invalid UTF-8", () => {
    expect(() => parseReceiptInput(enc(bare.replace('"receptum/1"', '"\\ud800"')))).toThrow(
      /surrogate/,
    );
    expect(() =>
      parseReceiptInput(
        enc(bare.replace('"reviewWindowSeconds":86400', '"reviewWindowSeconds":1e400')),
      ),
    ).toThrow(/IEEE 754/);
    expect(() => parseReceiptInput(Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]))).toThrow(/UTF-8/);
  });
});

describe("item 5: envelope extras fail L2", () => {
  it("fails an unknown envelope member", async () => {
    const r = await verify({ ...x402, extra: true } as unknown as SignedReceipt, {
      file,
      offline: true,
    });
    expect(r.checks.find((x) => x.level === 2)).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/unknown members/),
    });
    expect(r.verdict).toBe("NOT VERIFIED");
  });
});
