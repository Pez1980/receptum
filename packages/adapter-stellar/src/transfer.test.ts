import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET_USDC, TESTNET_USDC_ISSUER } from "./network.js";
import { TESTNET_USDC_SAC } from "./soroban.js";
import { matchSacTransfer } from "./transfer.js";

const payer = Keypair.random().publicKey();
const payee = Keypair.random().publicKey();
const change = {
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: TESTNET_USDC_ISSUER,
  type: "transfer",
  from: payer,
  to: payee,
  amount: "0.0100000",
};
const ops = [{ type: "invoke_host_function", asset_balance_changes: [change] }];

describe("matchSacTransfer", () => {
  it("finds the exact transfer to the payee (asset as CODE:ISSUER or contract id)", () => {
    expect(matchSacTransfer(ops, { asset: TESTNET_USDC_SAC, amount: "100000", to: payee })).toBe(
      change,
    );
    expect(
      matchSacTransfer(ops, { asset: TESTNET_USDC, amount: "100000", to: payee, from: payer }),
    ).toBe(change);
  });

  it("rejects other amounts, recipients, payers, assets and operation types", () => {
    const want = { asset: TESTNET_USDC_SAC, amount: "100000", to: payee };
    expect(matchSacTransfer(ops, { ...want, amount: "99999" })).toBeNull();
    expect(matchSacTransfer(ops, { ...want, to: payer })).toBeNull();
    expect(matchSacTransfer(ops, { ...want, from: payee })).toBeNull();
    expect(matchSacTransfer(ops, { ...want, asset: "native" })).toBeNull();
    expect(
      matchSacTransfer([{ type: "payment", asset_balance_changes: [change] }], want),
    ).toBeNull();
    expect(
      matchSacTransfer(
        [{ type: "invoke_host_function", asset_balance_changes: [{ ...change, type: "mint" }] }],
        want,
      ),
    ).toBeNull();
  });
});
