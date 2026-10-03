import { sha256Hex } from "@receptum/core";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import {
  caip10,
  currencyCode,
  currencyId,
  currencySymbol,
  ESCROW_MEMO_TYPE,
  formatEscrowId,
  fromXrplAmount,
  parseEscrowId,
  parseXrplAsset,
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

describe("currency identity (XRPL binary format)", () => {
  const USD_STANDARD = "0000000000000000000000005553440000000000";
  const USD_NONSTANDARD = "5553440000000000000000000000000000000000";

  it("encodes 3-character codes case-sensitively into the standard 160-bit layout", () => {
    expect(currencyId("USD")).toBe(USD_STANDARD);
    expect(currencyId("usd")).toBe("0000000000000000000000007573640000000000");
    expect(currencyId("usd")).not.toBe(currencyId("USD"));
    expect(currencyId("U$D")).toBe("000000000000000000000000552444" + "00".repeat(5));
  });

  it("normalizes only the hex spelling of 40-hex codes", () => {
    expect(currencyId(USD_STANDARD.toLowerCase())).toBe(USD_STANDARD);
    // A 40-hex code with the standard layout IS that standard code on the ledger.
    expect(currencyId(USD_STANDARD)).toBe(currencyId("USD"));
    // A nonstandard code whose bytes spell "USD" is a different currency.
    expect(currencyId(USD_NONSTANDARD)).toBe(USD_NONSTANDARD);
    expect(currencyId(USD_NONSTANDARD)).not.toBe(currencyId("USD"));
  });

  it("rejects XRP, characters outside the standard set and malformed 0x00-prefixed codes", () => {
    expect(() => currencyId("XRP")).toThrow(TypeError);
    expect(() => currencyId("000000000000000000000000585250" + "00".repeat(5))).toThrow(TypeError);
    expect(() => currencyId("00".repeat(20))).toThrow(TypeError);
    expect(() => currencyId("U D")).toThrow(TypeError);
    expect(() => currencyId("0001" + "00".repeat(18))).toThrow(TypeError);
    expect(() => currencyId("USDC")).toThrow(TypeError);
  });

  it("parses receipt assets into protocol identities", () => {
    expect(parseXrplAsset("XRP")).toEqual({ currency: "XRP" });
    expect(parseXrplAsset(`usd.${address}`)).toEqual({
      currency: currencyId("usd"),
      issuer: address,
    });
    expect(parseXrplAsset(`RLUSD.${address}`)).toEqual({
      currency: "524C555344000000000000000000000000000000",
      issuer: address,
    });
    expect(() => parseXrplAsset("USD")).toThrow(TypeError);
    expect(() => parseXrplAsset(`USD.notanaddress`)).toThrow(TypeError);
    expect(() => parseXrplAsset(`XRP.${address}`)).toThrow(TypeError);
  });

  it("never displays a nonstandard code as the standard symbol it spells", () => {
    expect(currencySymbol(USD_NONSTANDARD)).toBe(USD_NONSTANDARD);
    expect(currencySymbol(USD_STANDARD)).toBe("USD");
    expect(currencySymbol("usd")).toBe("usd");
    expect(fromXrplAmount({ currency: USD_NONSTANDARD, issuer: address, value: "1" }, 0)).toEqual({
      asset: `${USD_NONSTANDARD}.${address}`,
      amount: "1",
    });
  });
});

describe("spec/vectors/xrpl-currency-v1.json", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(
    readFileSync(new URL("../../../spec/vectors/xrpl-currency-v1.json", import.meta.url), "utf8"),
  ) as { codes: { code: string; id: string | null }[] };
  it.each(doc.codes)("$code → $id", ({ code, id }) => {
    const asset = `${code}.${address}`;
    if (id === null) expect(() => parseXrplAsset(asset)).toThrow(TypeError);
    else expect(parseXrplAsset(asset)).toEqual({ currency: id, issuer: address });
  });
});
