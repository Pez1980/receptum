import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { createReceipt } from "./receipt.js";
import {
  base58btcDecode,
  base58btcEncode,
  generateSellerKey,
  publicKeyFromDidKey,
  sellerKeyFromPem,
  signReceipt,
  verifySignedReceipt,
} from "./signing.js";
import { sampleInput } from "./receipt.test.js";

const key = generateSellerKey();
const receipt = () =>
  createReceipt({ ...sampleInput, seller: { id: key.did, name: "render.example" } });

describe("did:key", () => {
  it("round-trips through base58btc", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128]);
    expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes);
  });

  it("decodes the W3C did:key Ed25519 test vector", () => {
    const k = publicKeyFromDidKey("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK");
    expect(k.asymmetricKeyType).toBe("ed25519");
  });

  it("restores the same did from a PEM", () => {
    expect(sellerKeyFromPem(key.privateKeyPem).did).toBe(key.did);
  });
});

describe("signed receipts", () => {
  it("verifies a genuine receipt", () => {
    const result = verifySignedReceipt(signReceipt(receipt(), key));
    expect(result).toMatchObject({ ok: true, seller: key.did });
  });

  it("rejects a tampered output hash", () => {
    const signed = signReceipt(receipt(), key);
    signed.receipt.outputSha256 = sha256Hex("swapped");
    signed.receiptHash = sha256Hex("anything");
    expect(verifySignedReceipt(signed).ok).toBe(false);
  });

  it("rejects a re-hashed tampered receipt (signature no longer matches)", async () => {
    const { receiptHash } = await import("./receipt.js");
    const signed = signReceipt(receipt(), key);
    signed.receipt.payment.amount = "1";
    signed.receiptHash = receiptHash(signed.receipt);
    expect(verifySignedReceipt(signed)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a signature from someone other than the seller", () => {
    const other = generateSellerKey();
    expect(() => signReceipt(receipt(), other)).toThrow(/seller.id/);
  });
});
