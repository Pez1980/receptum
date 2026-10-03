import { describe, expect, it } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
import { verify } from "./index.js";

const seller = generateSellerKey();
const file = new TextEncoder().encode("delivered bytes");
const signed = signReceipt(
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
      reference: "0x00",
    },
  }),
  seller,
);

describe("verify (offline)", () => {
  it("passes the genuine file and signature", async () => {
    const r = await verify(signed, { file, offline: true });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  it("fails a different file", async () => {
    const r = await verify(signed, { file: new TextEncoder().encode("other"), offline: true });
    expect(r.ok).toBe(false);
  });

  it("explains when the file is an input rather than the output", async () => {
    const r = await verify(signed, { file: new TextEncoder().encode("source"), offline: true });
    expect(r.checks[0]?.detail).toMatch(/one of the inputs/);
  });

  it("fails a tampered receipt", async () => {
    const tampered = structuredClone(signed);
    tampered.receipt.payment.amount = "999";
    expect((await verify(tampered, { offline: true })).ok).toBe(false);
  });
});

describe("verify (Stellar, no network needed)", () => {
  const stellarReceipt = (payment: Partial<Parameters<typeof createReceipt>[0]["payment"]>) =>
    signReceipt(
      createReceipt({
        jobId: "s",
        seller: { id: seller.did },
        inputSha256: [sha256Hex("source")],
        outputSha256: sha256Hex(file),
        payment: {
          rail: "escrow:receptum-soroban",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "1000000",
          reference: "not-an-escrow-id",
          ...payment,
        },
      }),
      seller,
    );

  it("fails a Soroban escrow receipt whose reference isn't a Soroban escrow id", async () => {
    const r = await verify(stellarReceipt({}));
    expect(r.ok).toBe(false);
    expect(r.checks.at(-1)?.detail).toMatch(/invalid Soroban escrowId/);
  });

  it("refuses to fully verify a Stellar x402 payment that names no payee", async () => {
    const r = await verify(stellarReceipt({ rail: "x402:exact", reference: "ab".repeat(32) }));
    expect(r.complete).toBe(false);
    expect(r.checks.at(-1)?.status).toBe("pending");
  });
});
