import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { receiptBytes, receiptHash } from "./receipt.js";
import { sellerKeyFromSeed, signReceipt, verifySignedReceipt } from "./signing.js";

const file = JSON.parse(
  readFileSync(new URL("../../../spec/vectors/rrf-v1.json", import.meta.url), "utf8"),
);

describe("published RRF v1 test vectors", () => {
  const key = sellerKeyFromSeed(Buffer.from(file.testSeedHex, "hex"));
  it("derive the published seller did", () => expect(key.did).toBe(file.sellerDid));
  for (const v of file.vectors) {
    it(`reproduce "${v.name}"`, () => {
      expect(receiptBytes(v.receipt)).toBe(v.jcs);
      expect(receiptHash(v.receipt)).toBe(v.receiptHash);
      expect(signReceipt(v.receipt, key).proof).toEqual(v.proof);
      expect(
        verifySignedReceipt({ receipt: v.receipt, receiptHash: v.receiptHash, proof: v.proof }).ok,
      ).toBe(true);
    });
  }
});
