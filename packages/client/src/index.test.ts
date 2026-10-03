import { describe, expect, it } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
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
      asset: "USDC",
      amount: "1",
      reference: "0xsettle",
    },
  }),
  seller,
);
const header = Buffer.from(JSON.stringify(signed)).toString("base64url");

describe("checkDelivery", () => {
  it("accepts the genuine output", () => {
    expect(checkDelivery(body, signed, { transaction: "0xsettle" })).toMatchObject({ ok: true });
  });
  it("flags swapped output", () => {
    expect(checkDelivery(new TextEncoder().encode("other"), signed).outputMatches).toBe(false);
  });
  it("flags a receipt for a different settlement", () => {
    expect(checkDelivery(body, signed, { transaction: "0xother" }).settlementMatches).toBe(false);
  });
  it("enforces the seller allow-list", () => {
    expect(checkDelivery(body, signed, undefined, ["did:key:zNotThem"]).sellerAllowed).toBe(false);
  });
});

describe("createReceptumFetch", () => {
  const fake = (h: Record<string, string>, b: Uint8Array = body) =>
    (async () => new Response(b, { status: 200, headers: h })) as unknown as typeof fetch;

  it("returns the verified result", async () => {
    const r = await createReceptumFetch({ paidFetch: fake({ "Receptum-Receipt": header }) })(
      "https://x",
    );
    expect(r.check.ok).toBe(true);
  });
  it("refuses responses without a receipt", async () => {
    await expect(createReceptumFetch({ paidFetch: fake({}) })("https://x")).rejects.toThrow(
      ReceiptError,
    );
  });
  it("refuses tampered output", async () => {
    await expect(
      createReceptumFetch({ paidFetch: fake({ "Receptum-Receipt": header }, new Uint8Array([1])) })(
        "https://x",
      ),
    ).rejects.toThrow(/output hash/);
  });
});
