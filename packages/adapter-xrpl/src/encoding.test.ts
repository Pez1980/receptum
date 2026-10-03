import { sha256Hex } from "@receptum/core";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import {
  caip10,
  currencyCode,
  currencySymbol,
  ESCROW_MEMO_TYPE,
  formatEscrowId,
  fromXrplAmount,
  parseEscrowId,
  parseReceiptMemos,
  RECEIPT_MEMO_TYPE,
  receiptMemos,
  toXrplAmount,
} from "./encoding.js";

const address = Wallet.generate().classicAddress;
const hash = sha256Hex("receipt");

describe("memos", () => {
  it("follows SPEC §7: MemoType = hex('receptum/1'), MemoData = receiptHash", () => {
    expect(RECEIPT_MEMO_TYPE).toBe("726563657074756D2F31");
    expect(receiptMemos(hash)).toEqual([
      { Memo: { MemoType: RECEIPT_MEMO_TYPE, MemoData: hash.toUpperCase() } },
    ]);
  });

  it("adds an escrow memo and round-trips both", () => {
    const id = formatEscrowId(address, 42);
    const memos = receiptMemos(hash, id);
    expect(memos[1]?.Memo.MemoType).toBe(ESCROW_MEMO_TYPE);
    expect(parseReceiptMemos(memos)).toEqual({ receiptHash: hash, escrowId: id });
  });

  it("ignores unrelated or malformed memos", () => {
    expect(parseReceiptMemos(undefined)).toEqual({});
    expect(
      parseReceiptMemos([
        { Memo: { MemoType: "6F74686572", MemoData: hash } },
        { Memo: { MemoType: RECEIPT_MEMO_TYPE, MemoData: "ABCD" } },
        { Memo: { MemoType: RECEIPT_MEMO_TYPE } },
      ]),
    ).toEqual({});
  });

  it("rejects non-hex64 receipt hashes", () => {
    expect(() => receiptMemos("XYZ")).toThrow(TypeError);
    expect(() => receiptMemos(hash.toUpperCase())).toThrow(TypeError);
  });
});

describe("escrow ids", () => {
  it("round-trips owner:sequence", () => {
    expect(parseEscrowId(formatEscrowId(address, 21239399))).toEqual({
      owner: address,
      sequence: 21239399,
    });
  });

  it.each([
    "",
    address,
    `${address}:0`,
    `${address}:-1`,
    `${address}:1.5`,
    "rBad:1",
    `${address}:99999999999`,
  ])("rejects %s", (id) => expect(() => parseEscrowId(id)).toThrow(TypeError));

  it("builds CAIP-10 accounts", () => {
    expect(caip10("xrpl:1", address)).toBe(`xrpl:1:${address}`);
  });
});

describe("amounts", () => {
  it("passes XRP drops through", () => {
    expect(toXrplAmount("XRP", "2000000", 6)).toBe("2000000");
    expect(fromXrplAmount("2000000", 6)).toEqual({ asset: "XRP", amount: "2000000" });
  });

  it("scales issued tokens by decimals and encodes long currency codes", () => {
    const amount = toXrplAmount(`RLUSD.${address}`, "1250000", 6);
    expect(amount).toEqual({
      currency: "524C555344000000000000000000000000000000",
      issuer: address,
      value: "1.25",
    });
    expect(fromXrplAmount(amount, 6)).toEqual({ asset: `RLUSD.${address}`, amount: "1250000" });
    expect(toXrplAmount(`USD.${address}`, "7", 6)).toEqual({
      currency: "USD",
      issuer: address,
      value: "0.000007",
    });
  });

  it("reads scientific notation from rippled", () => {
    const v = (value: string) => fromXrplAmount({ currency: "USD", issuer: address, value }, 6);
    expect(v("1e-6").amount).toBe("1");
    expect(v("1.5e3").amount).toBe("1500000000");
    expect(v("100").amount).toBe("100000000");
    expect(() => v("1e-7")).toThrow(RangeError);
  });

  it("rejects bad input", () => {
    expect(() => toXrplAmount("XRP", "1.5", 6)).toThrow(TypeError);
    expect(() => toXrplAmount("USD", "1", 6)).toThrow(TypeError);
    expect(() => toXrplAmount(`USD.${address}`, "1234567890123456", 0)).toThrow(RangeError);
  });

  it("maps currency codes both ways", () => {
    expect(currencyCode("USD")).toBe("USD");
    expect(() => currencyCode("XRP")).toThrow(TypeError);
    expect(currencySymbol(currencyCode("RLUSD"))).toBe("RLUSD");
    const opaque = "01" + "00".repeat(19);
    expect(currencySymbol(opaque)).toBe(opaque);
  });
});
