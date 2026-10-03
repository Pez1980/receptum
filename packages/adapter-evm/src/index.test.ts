import { describe, expect, it } from "vitest";
import { anchorCalldata, formatEscrowId, parseEscrowId, toBytes32 } from "./index.js";

const H = "ab".repeat(32);

describe("adapter-evm encoding", () => {
  it("round-trips escrow ids", () => {
    const id = formatEscrowId("eip155:5042002", "0x1111111111111111111111111111111111111111", 7n);
    expect(parseEscrowId(id)).toEqual({
      network: "eip155:5042002",
      contract: "0x1111111111111111111111111111111111111111",
      id: 7n,
    });
  });

  it("rejects malformed ids", () => {
    expect(() => parseEscrowId("nope")).toThrow(/invalid/);
    expect(() => parseEscrowId("eip155:1:0x12:1")).toThrow(/invalid/);
  });

  it("encodes receipt hashes as bytes32", () => {
    expect(toBytes32(H)).toBe(`0x${H}`);
    expect(() => toBytes32("XYZ")).toThrow();
  });

  it("prefixes anchor calldata with receptum/1", () => {
    expect(anchorCalldata(H)).toBe(`0x72656365707475 6d2f31${H}`.replace(" ", ""));
  });
});
