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
    expect(r.checks.map((c) => c.status)).toEqual(["pass", "pass", "skipped"]);
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

describe("seller controls payee (L2.5)", async () => {
  const { createAccountBinding } = await import("@receptum/core");
  const { evmAccountSigner } = await import("@receptum/adapter-evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  // anvil default account #0 — a PUBLIC test key.
  const payTo = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const withPayee = signReceipt(
    {
      ...signed.receipt,
      payment: { ...signed.receipt.payment, payee: `eip155:84532:${payTo.address}` },
    },
    seller,
  );
  const binding = await createAccountBinding({
    key: seller,
    signer: evmAccountSigner(payTo, "eip155:84532"),
  });
  const level = (r: Awaited<ReturnType<typeof verify>>) => r.checks.find((c) => c.level === 2.5);

  it("passes with a valid binding", async () => {
    const r = await verify({ ...withPayee, bindings: [binding] }, { offline: true });
    expect(level(r)).toMatchObject({ status: "pass", name: "Seller controls payee" });
    expect(r.ok).toBe(true);
  });
  it("is pending (not complete) without a binding, skipped with allowUnbound", async () => {
    expect(level(await verify(withPayee, { offline: true }))?.status).toBe("pending");
    expect(level(await verify(withPayee, { offline: true, allowUnbound: true }))?.status).toBe(
      "skipped",
    );
  });
  it("fails a binding for another seller or account", async () => {
    const other = generateSellerKey();
    const foreign = await createAccountBinding({
      key: other,
      signer: evmAccountSigner(payTo, "eip155:84532"),
    });
    const r = await verify({ ...withPayee, bindings: [foreign] }, { offline: true });
    expect(level(r)?.status).toBe("fail");
    expect(r.ok).toBe(false);
    const forged = structuredClone(binding);
    forged.accountProof.signature = `0x${"11".repeat(64)}1b`;
    expect(
      level(await verify({ ...withPayee, bindings: [forged] }, { offline: true }))?.status,
    ).toBe("fail");
  });
});
