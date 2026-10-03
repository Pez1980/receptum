import { describe, expect, it } from "vitest";
import { Asset, Memo, MemoHash } from "@stellar/stellar-sdk";
import { sha256Hex } from "@receptum/core";
import {
  assetToString,
  deliveryDataKey,
  escrowIdToStrKey,
  fromStellarAmount,
  parseAsset,
  parseEscrowId,
  receiptHashBytes,
  receiptHashFromBase64,
  receiptMemo,
  toStellarAmount,
} from "./codec.js";
import { TESTNET_USDC, TESTNET_USDC_ISSUER } from "./network.js";

const HASH = "36ff699ad95f74a767e1fd412b8d3d37e1174e0989cb0ae089a6cfacab40925f";
const ID = `00000000${HASH}`;

describe("escrow ids", () => {
  it("accepts Horizon hex ids and normalises case", () => {
    expect(parseEscrowId(ID)).toBe(ID);
    expect(parseEscrowId(` ${ID.toUpperCase()} `)).toBe(ID);
  });

  it("round-trips through the SEP-23 B… strkey", () => {
    const strkey = escrowIdToStrKey(ID);
    expect(strkey).toMatch(/^B[A-Z2-7]+$/);
    expect(parseEscrowId(strkey)).toBe(ID);
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", HASH, `00000001${HASH}`, `${ID}00`, "BAAAA", `0x${HASH}`]) {
      expect(() => parseEscrowId(bad)).toThrow(/invalid Stellar escrow id/);
    }
  });

  it("derives a 64-byte data entry key from the balance hash", () => {
    expect(deliveryDataKey(ID)).toBe(HASH);
    expect(deliveryDataKey(ID)).toHaveLength(64);
  });
});

describe("receipt hash memos", () => {
  const receiptHash = sha256Hex("receipt");

  it("encodes the receipt hash as a 32-byte MEMO_HASH", () => {
    const memo = receiptMemo(receiptHash);
    expect(memo.type).toBe(MemoHash);
    expect(Buffer.from(memo.value as Buffer).toString("hex")).toBe(receiptHash);
    // XDR round trip, as a verifier decoding the envelope would see it.
    const back = Memo.fromXDRObject(memo.toXDRObject());
    expect(Buffer.from(back.value as Buffer).toString("hex")).toBe(receiptHash);
  });

  it("decodes Horizon's base64 memo back to the receipt hash", () => {
    const b64 = receiptHashBytes(receiptHash).toString("base64");
    expect(receiptHashFromBase64(b64)).toBe(receiptHash);
    expect(receiptHashFromBase64(undefined)).toBeNull();
    expect(receiptHashFromBase64(Buffer.from("short").toString("base64"))).toBeNull();
  });

  it("refuses anything that is not lower-case hex64", () => {
    expect(() => receiptMemo(receiptHash.toUpperCase())).toThrow(/receiptHash/);
    expect(() => receiptMemo("abc")).toThrow(/receiptHash/);
  });
});

describe("assets and amounts", () => {
  it("parses native and issued assets", () => {
    expect(parseAsset("native").isNative()).toBe(true);
    expect(parseAsset("XLM").isNative()).toBe(true);
    const usdc = parseAsset(TESTNET_USDC);
    expect(usdc.getCode()).toBe("USDC");
    expect(usdc.getIssuer()).toBe(TESTNET_USDC_ISSUER);
    expect(assetToString(usdc)).toBe(TESTNET_USDC);
    expect(assetToString(Asset.native())).toBe("native");
    expect(() => parseAsset("USDC")).toThrow();
    expect(() => parseAsset("USDC:G:extra")).toThrow();
  });

  it("converts smallest units (7 decimals) to Stellar amounts and back", () => {
    expect(toStellarAmount("1")).toBe("0.0000001");
    expect(toStellarAmount("12500000")).toBe("1.2500000");
    expect(toStellarAmount("10000000000")).toBe("1000.0000000");
    expect(fromStellarAmount("1.2500000")).toBe("12500000");
    expect(fromStellarAmount("1.25")).toBe("12500000");
    expect(fromStellarAmount("7")).toBe("70000000");
    expect(() => toStellarAmount("0")).toThrow(RangeError);
    expect(() => toStellarAmount("-1")).toThrow(TypeError);
    expect(() => toStellarAmount("1.5")).toThrow(TypeError);
    expect(() => toStellarAmount((2n ** 63n).toString())).toThrow(RangeError);
    expect(() => fromStellarAmount("1.00000001")).toThrow();
  });
});
