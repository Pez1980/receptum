import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sha256Hex } from "@receptum/core";
import { matchAnchor } from "./anchor.js";
import { receiptHashBytes } from "./codec.js";
import { TESTNET_USDC } from "./network.js";
import { escrowClaimants } from "./predicates.js";
import { deriveEscrowState, type EscrowHistory } from "./state.js";

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const terms = { buyer, seller, deadline: 1_800_000_000, releaseAt: 1_800_000_600 };
const receiptHash = sha256Hex("receipt");
const memo = receiptHashBytes(receiptHash).toString("base64");

// Horizon-shaped claimants (absolute times only, as the adapter creates them).
const claimants = escrowClaimants(terms).map((c, i) => ({
  destination: c.destination,
  predicate:
    i === 0
      ? { not: { abs_before_epoch: "1800000600", abs_before: "2027-01-15T08:10:00Z" } }
      : {
          and: [
            { not: { abs_before_epoch: "1800000000", abs_before: "2027-01-15T08:00:00Z" } },
            { abs_before_epoch: "1800000600", abs_before: "2027-01-15T08:10:00Z" },
          ],
        },
}));

const base: EscrowHistory = {
  escrowId: `00000000${"ab".repeat(32)}`,
  create: { asset: TESTNET_USDC, amount: "1.5000000", claimants, transactionHash: "c0" },
};

describe("deriveEscrowState", () => {
  it("is open until a delivery is recorded", () => {
    const s = deriveEscrowState(base);
    expect(s).toMatchObject({
      status: "open",
      rail: "escrow:stellar-claimable",
      network: "stellar:testnet",
      amount: "15000000",
      buyer,
      seller,
      refundableAfter: "2027-01-15T08:00:00.000Z",
      releasableAfter: "2027-01-15T08:10:00.000Z",
      openedBy: "c0",
    });
    expect(s.receiptHash).toBeUndefined();
  });

  it("is delivered when the seller's data entry holds a receipt hash", () => {
    const s = deriveEscrowState({ ...base, deliveryEntry: memo });
    expect(s.status).toBe("delivered");
    expect(s.receiptHash).toBe(receiptHash);
  });

  it("is released when the seller claims (entry removed, hash taken from the memo)", () => {
    const s = deriveEscrowState({
      ...base,
      claim: { claimant: seller, transactionHash: "r1", memoType: "hash", memo, payments: [] },
    });
    expect(s).toMatchObject({
      status: "released",
      releasedBy: "seller",
      settledBy: "r1",
      receiptHash,
    });
  });

  it("is released when the buyer claims and pays the seller atomically (acceptance)", () => {
    const s = deriveEscrowState({
      ...base,
      deliveryEntry: memo,
      claim: {
        claimant: buyer,
        transactionHash: "a1",
        memoType: "hash",
        memo,
        payments: [{ from: buyer, to: seller, asset: TESTNET_USDC, amount: "1.5000000" }],
      },
    });
    expect(s).toMatchObject({ status: "released", releasedBy: "buyer-acceptance", receiptHash });
  });

  it("is refunded when the buyer claims without paying the seller in full", () => {
    const underpaid = deriveEscrowState({
      ...base,
      claim: {
        claimant: buyer,
        transactionHash: "f1",
        memoType: "text",
        payments: [{ from: buyer, to: seller, asset: TESTNET_USDC, amount: "1.4999999" }],
      },
    });
    expect(underpaid.status).toBe("refunded");
    const wrongAsset = deriveEscrowState({
      ...base,
      claim: {
        claimant: buyer,
        transactionHash: "f2",
        memoType: "none",
        payments: [{ from: buyer, to: seller, asset: "native", amount: "100.0000000" }],
      },
    });
    expect(wrongAsset.status).toBe("refunded");
  });

  it("keeps the receipt hash of a rejected delivery", () => {
    const s = deriveEscrowState({
      ...base,
      deliveryEntry: memo,
      claim: { claimant: buyer, transactionHash: "x1", memoType: "text", payments: [] },
    });
    expect(s).toMatchObject({ status: "refunded", receiptHash });
  });

  it("rejects claims by strangers", () => {
    const stranger = Keypair.random().publicKey();
    expect(() =>
      deriveEscrowState({
        ...base,
        claim: { claimant: stranger, transactionHash: "z", memoType: "none", payments: [] },
      }),
    ).toThrow(/unknown account/);
  });
});

describe("matchAnchor", () => {
  const tx = {
    hash: "t1",
    successful: true,
    source_account: seller,
    memo_type: "hash",
    memo,
    created_at: "2026-10-03T10:00:00Z",
  };

  it("matches a successful MEMO_HASH transaction from the anchor account", () => {
    expect(matchAnchor(tx, receiptHash, seller)).toEqual({
      rail: "anchor:stellar",
      network: "stellar:testnet",
      receiptHash,
      reference: "t1",
      anchoredAt: "2026-10-03T10:00:00.000Z",
    });
    expect(matchAnchor(tx, receiptHash)).not.toBeNull();
  });

  it("ignores other memos, failed transactions and other accounts", () => {
    expect(matchAnchor(tx, sha256Hex("other"), seller)).toBeNull();
    expect(matchAnchor({ ...tx, successful: false }, receiptHash, seller)).toBeNull();
    expect(matchAnchor({ ...tx, memo_type: "text" }, receiptHash, seller)).toBeNull();
    expect(matchAnchor(tx, receiptHash, buyer)).toBeNull();
  });
});
