import { describe, expect, it } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { checkDelivery, createReceptumFetch, ReceiptError } from "./index.js";

const seller = generateSellerKey();
const body = new TextEncoder().encode("final.mp4 bytes");
const signed = signReceipt(
  createReceipt({
    jobId: "j",
    seller: { id: seller.did },
    inputSha256: [sha256Hex("in")],
    outputSha256: sha256Hex(body),
    payment: {
      rail: "x402:exact",
      network: "eip155:84532",
      asset: "0xUSDC",
      amount: "250000",
      reference: "0xsettle",
      payee: "eip155:84532:0xSeller",
      payer: "eip155:84532:0xBuyer",
    },
  }),
  seller,
);
const ok = { success: true, transaction: "0xsettle", network: "eip155:84532", payer: "0xBuyer" };
const header = Buffer.from(JSON.stringify(signed)).toString("base64url");

describe("checkDelivery", () => {
  it("accepts the genuine output with its settlement", () => {
    expect(checkDelivery(body, signed, ok)).toMatchObject({ ok: true });
  });
  it("flags swapped output", () => {
    expect(checkDelivery(new TextEncoder().encode("other"), signed, ok).outputMatches).toBe(false);
  });
  it("fails closed without a settlement, or with a failed one", () => {
    expect(checkDelivery(body, signed).reasons).toContain("no settlement was returned");
    expect(checkDelivery(body, signed, { ...ok, success: false }).reasons).toContain(
      "settlement did not succeed",
    );
  });
  it("flags a receipt for a different settlement, network or payer", () => {
    expect(checkDelivery(body, signed, { ...ok, transaction: "0xother" }).settlementMatches).toBe(
      false,
    );
    expect(checkDelivery(body, signed, { ...ok, network: "eip155:1" }).ok).toBe(false);
    expect(checkDelivery(body, signed, { ...ok, payer: "0xSomeoneElse" }).ok).toBe(false);
  });
  it("enforces the seller allow-list", () => {
    expect(checkDelivery(body, signed, ok, ["did:key:zNotThem"]).sellerAllowed).toBe(false);
  });
  it("checks the buyer's own expectations", () => {
    expect(
      checkDelivery(body, signed, ok, undefined, {
        expected: {
          payee: "eip155:84532:0xseller",
          amount: "250000",
          inputSha256: [sha256Hex("in")],
        },
      }).ok,
    ).toBe(true);
    expect(
      checkDelivery(body, signed, ok, undefined, { expected: { payee: "eip155:84532:0xAttacker" } })
        .reasons,
    ).toContain("unexpected payee");
    expect(
      checkDelivery(body, signed, ok, undefined, { expected: { maxAmount: "100000" } }).reasons,
    ).toContain("amount exceeds the maximum");
    expect(
      checkDelivery(body, signed, ok, undefined, {
        expected: { inputSha256: [sha256Hex("other")] },
      }).reasons,
    ).toContain("receipt is for different inputs");
  });
});

describe("createReceptumFetch", () => {
  const fake = (h: Record<string, string>, b: Uint8Array = body) =>
    (async () => new Response(b, { status: 200, headers: h })) as unknown as typeof fetch;
  const paid = {
    "Receptum-Receipt": header,
    "PAYMENT-RESPONSE": encodePaymentResponseHeader(ok as never),
  };

  it("returns the verified result", async () => {
    const r = await createReceptumFetch({ paidFetch: fake(paid) })("https://x");
    expect(r.check.ok).toBe(true);
  });
  it("refuses responses without a receipt", async () => {
    await expect(createReceptumFetch({ paidFetch: fake({}) })("https://x")).rejects.toThrow(
      ReceiptError,
    );
  });
  it("refuses responses without a settlement", async () => {
    await expect(
      createReceptumFetch({ paidFetch: fake({ "Receptum-Receipt": header }) })("https://x"),
    ).rejects.toThrow(/no settlement/);
  });
  it("refuses tampered output", async () => {
    await expect(
      createReceptumFetch({ paidFetch: fake(paid, new Uint8Array([1])) })("https://x"),
    ).rejects.toThrow(/output hash/);
  });
});

describe("requireBinding", async () => {
  const { createAccountBinding } = await import("@receptum/core");
  const { evmAccountSigner, evmBindingVerifier } = await import("@receptum/adapter-evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  // anvil default account #0 — a PUBLIC test key.
  const payeeAccount = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const bound = signReceipt(
    createReceipt({
      jobId: "j",
      seller: { id: seller.did },
      inputSha256: [sha256Hex("in")],
      outputSha256: sha256Hex(body),
      payment: {
        rail: "x402:exact",
        network: "eip155:84532",
        asset: "0xUSDC",
        amount: "250000",
        reference: "0xsettle",
        payee: `eip155:84532:${payeeAccount.address.toLowerCase()}`,
      },
    }),
    seller,
  );
  const binding = await createAccountBinding({
    key: seller,
    signer: evmAccountSigner(payeeAccount, "eip155:84532"),
  });
  const opts = { requireBinding: true, bindingVerifiers: [evmBindingVerifier] };

  it("accepts a receipt whose seller is bound to the payee", () => {
    const r = checkDelivery(body, { ...bound, bindings: [binding] }, ok, undefined, opts);
    expect(r).toMatchObject({ ok: true, payeeBound: true });
  });
  it("refuses a missing, foreign or unverifiable binding", async () => {
    expect(checkDelivery(body, bound, ok, undefined, opts).reasons).toContain(
      "account binding: receipt carries no account bindings",
    );
    const foreign = await createAccountBinding({
      key: generateSellerKey(),
      signer: evmAccountSigner(payeeAccount, "eip155:84532"),
    });
    expect(checkDelivery(body, { ...bound, bindings: [foreign] }, ok, undefined, opts).ok).toBe(
      false,
    );
    // Without the eip155 verifier, the binding can't be checked: fail closed.
    expect(
      checkDelivery(body, { ...bound, bindings: [binding] }, ok, undefined, {
        requireBinding: true,
      }).reasons.join(),
    ).toMatch(/no binding verifier for namespace eip155/);
  });
  it("only reports the binding when not required", () => {
    expect(checkDelivery(body, bound, ok)).toMatchObject({ ok: true, payeeBound: false });
  });
});
