import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  conditionFromPreimage,
  fulfillmentFromPreimage,
  fulfillmentMatches,
  newEscrowSecret,
  preimageFromFulfillment,
} from "./condition.js";

describe("PREIMAGE-SHA-256", () => {
  it("matches the crypto-conditions draft vector for an empty preimage", () => {
    expect(fulfillmentFromPreimage("")).toBe("A0028000");
    expect(conditionFromPreimage("")).toBe(
      "A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100",
    );
  });

  it("encodes a 32-byte preimage the way XRPL expects", () => {
    const preimage = Buffer.alloc(32, 0xab);
    const digest = createHash("sha256").update(preimage).digest("hex").toUpperCase();
    expect(fulfillmentFromPreimage(preimage)).toBe("A0228020" + "AB".repeat(32));
    expect(conditionFromPreimage(preimage)).toBe(`A0258020${digest}810120`);
  });

  it("uses long-form DER lengths and a sign byte for larger preimages", () => {
    const preimage = Buffer.alloc(200, 1);
    const f = fulfillmentFromPreimage(preimage);
    expect(f.startsWith("A081CB8081C8")).toBe(true);
    expect(conditionFromPreimage(preimage).endsWith("810200C8")).toBe(true);
    expect(preimageFromFulfillment(f).equals(preimage)).toBe(true);
  });

  it("generates fresh secrets whose fulfillment satisfies the condition", () => {
    const a = newEscrowSecret();
    const b = newEscrowSecret();
    expect(a.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(a.preimage).not.toBe(b.preimage);
    expect(fulfillmentMatches(a.condition, a.fulfillment)).toBe(true);
    expect(fulfillmentMatches(a.condition.toLowerCase(), a.fulfillment.toLowerCase())).toBe(true);
    expect(fulfillmentMatches(a.condition, b.fulfillment)).toBe(false);
  });

  it("rejects malformed fulfillments", () => {
    expect(() => preimageFromFulfillment("A1028000")).toThrow();
    expect(() => preimageFromFulfillment("A00380")).toThrow();
    expect(fulfillmentMatches(newEscrowSecret().condition, "zz")).toBe(false);
  });
});
