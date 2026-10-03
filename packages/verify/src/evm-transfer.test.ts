import { describe, expect, it } from "vitest";
import { erc20TransferMatches, TRANSFER_TOPIC } from "./evm-transfer.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x62E5fFEcdc8be558F0a05031242ea1E9D3e921e5";
const PAYEE = "0x6344D17a80775A71b51A61124767AbCD22B0328B";
const word = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
const value = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const log = (over: Record<string, unknown> = {}) => ({
  address: ASSET.toLowerCase(),
  topics: [TRANSFER_TOPIC, word(PAYER), word(PAYEE)],
  data: value(250000),
  removed: false,
  ...over,
});
const want = { asset: ASSET, amount: "250000", payee: PAYEE, payer: PAYER };

describe("ERC-20 Transfer log (SPEC §7.3)", () => {
  it("matches exactly three topics and exactly 32 bytes of data", () => {
    expect(erc20TransferMatches(log(), want)).toBe(true);
    expect(erc20TransferMatches(log(), { ...want, payer: undefined })).toBe(true);
  });

  it("rejects a fourth topic (e.g. an ERC-721 Transfer with an indexed tokenId)", () => {
    const topics = [TRANSFER_TOPIC, word(PAYER), word(PAYEE), value(250000)];
    expect(erc20TransferMatches(log({ topics, data: "0x" }), want)).toBe(false);
    expect(erc20TransferMatches(log({ topics }), want)).toBe(false);
  });

  it("rejects fewer topics", () => {
    expect(erc20TransferMatches(log({ topics: [TRANSFER_TOPIC, word(PAYER)] }), want)).toBe(false);
  });

  it("rejects data that is not exactly one 32-byte word", () => {
    const amount = 250000n.toString(16);
    expect(erc20TransferMatches(log({ data: `0x${amount}` }), want)).toBe(false);
    expect(
      erc20TransferMatches(log({ data: `0x${"00".repeat(32)}${value(250000).slice(2)}` }), want),
    ).toBe(false);
    expect(erc20TransferMatches(log({ data: `${value(250000)}00` }), want)).toBe(false);
    expect(erc20TransferMatches(log({ data: `0x_${value(250000).slice(3)}` }), want)).toBe(false);
  });

  it("rejects address topics with non-zero upper bytes", () => {
    const dirty = `0x${"0".repeat(23)}1${PAYEE.slice(2).toLowerCase()}`;
    const topics = [TRANSFER_TOPIC, word(PAYER), dirty];
    expect(erc20TransferMatches(log({ topics }), want)).toBe(false);
  });

  it("rejects removed logs, other contracts, other selectors, amounts and parties", () => {
    expect(erc20TransferMatches(log({ removed: true }), want)).toBe(false);
    expect(erc20TransferMatches(log({ address: PAYEE }), want)).toBe(false);
    const approval = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    expect(erc20TransferMatches(log({ topics: [approval, word(PAYER), word(PAYEE)] }), want)).toBe(
      false,
    );
    expect(erc20TransferMatches(log({ data: value(250001) }), want)).toBe(false);
    expect(erc20TransferMatches(log(), { ...want, payee: PAYER })).toBe(false);
    expect(erc20TransferMatches(log(), { ...want, payer: PAYEE })).toBe(false);
  });
});
