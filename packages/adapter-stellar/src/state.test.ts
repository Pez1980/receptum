import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { sha256Hex } from "@receptum/core";
import { matchAnchor } from "./anchor.js";
import { deliveryDataKey, receiptHashBytes } from "./codec.js";
import { toDeliveryTx } from "./escrow.js";
import { TESTNET_USDC } from "./network.js";
import { escrowClaimants } from "./predicates.js";
import {
  allocateClaimPayments,
  deriveEscrowState,
  findDelivery,
  type BatchClaim,
  type DeliveryTxLike,
  type EscrowHistory,
} from "./state.js";

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

const key = deliveryDataKey(`00000000${"ab".repeat(32)}`);
const OPENED = "2027-01-15T07:00:00Z";
const deliveryTx = (over: Partial<DeliveryTxLike> = {}): DeliveryTxLike => ({
  hash: "d1",
  successful: true,
  createdAt: "2027-01-15T07:30:00Z",
  memoType: "hash",
  memo,
  dataOps: [{ account: seller, name: key, value: memo }],
  ...over,
});

const base: EscrowHistory = {
  escrowId: `00000000${"ab".repeat(32)}`,
  create: {
    asset: TESTNET_USDC,
    amount: "1.5000000",
    claimants,
    transactionHash: "c0",
    createdAt: OPENED,
  },
  deliveryTxs: [],
};
const delivered: EscrowHistory = { ...base, deliveryTxs: [deliveryTx()] };

describe("deriveEscrowState", () => {
  it("is open until a delivery is anchored", () => {
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

  it("is delivered by the first anchor transaction before the deadline", () => {
    const s = deriveEscrowState(delivered);
    expect(s).toMatchObject({
      status: "delivered",
      receiptHash,
      deliveredBy: "d1",
      deliveredAt: "2027-01-15T07:30:00.000Z",
    });
  });

  it("is released when the seller claims; the hash comes from the delivery, not the claim", () => {
    const s = deriveEscrowState({
      ...delivered,
      claim: { claimant: seller, transactionHash: "r1", payments: [] },
    });
    expect(s).toMatchObject({
      status: "released",
      releasedBy: "seller",
      settledBy: "r1",
      receiptHash,
    });
    // A seller claim without a delivery anchor is a release with no receipt.
    const bare = deriveEscrowState({
      ...base,
      claim: { claimant: seller, transactionHash: "r2", payments: [] },
    });
    expect(bare.status).toBe("released");
    expect(bare.receiptHash).toBeUndefined();
  });

  it("is released when the buyer claims and pays the seller atomically (acceptance)", () => {
    const s = deriveEscrowState({
      ...delivered,
      claim: {
        claimant: buyer,
        transactionHash: "a1",
        payments: [{ from: buyer, to: seller, asset: TESTNET_USDC, amount: "1.5000000" }],
      },
    });
    expect(s).toMatchObject({ status: "released", releasedBy: "buyer-acceptance", receiptHash });
  });

  it("is refunded when the buyer claims without paying the seller exactly", () => {
    for (const p of [
      { from: buyer, to: seller, asset: TESTNET_USDC, amount: "1.4999999" },
      { from: buyer, to: seller, asset: "native", amount: "1.5000000" },
      { from: seller, to: seller, asset: TESTNET_USDC, amount: "1.5000000" },
      { from: buyer, to: buyer, asset: TESTNET_USDC, amount: "1.5000000" },
    ]) {
      const s = deriveEscrowState({
        ...base,
        claim: { claimant: buyer, transactionHash: "f1", payments: [p] },
      });
      expect(s.status).toBe("refunded");
    }
  });

  it("keeps the receipt hash of a rejected delivery", () => {
    const s = deriveEscrowState({
      ...delivered,
      claim: { claimant: buyer, transactionHash: "x1", payments: [] },
    });
    expect(s).toMatchObject({ status: "refunded", receiptHash });
  });

  it("rejects claims by strangers", () => {
    const stranger = Keypair.random().publicKey();
    expect(() =>
      deriveEscrowState({
        ...base,
        claim: { claimant: stranger, transactionHash: "z", payments: [] },
      }),
    ).toThrow(/unknown account/);
  });
});

describe("findDelivery (review item 13: chronological history, not mutable data)", () => {
  const find = (txs: DeliveryTxLike[]) => findDelivery(base.escrowId, terms, OPENED, txs);
  const other = sha256Hex("other receipt");
  const otherMemo = receiptHashBytes(other).toString("base64");

  it("takes the first valid anchor and ignores later redeliveries", () => {
    const later = deliveryTx({
      hash: "d2",
      createdAt: "2027-01-15T07:40:00Z",
      memo: otherMemo,
      dataOps: [{ account: seller, name: key, value: otherMemo }],
    });
    expect(find([deliveryTx(), later])?.receiptHash).toBe(receiptHash);
    expect(find([later, deliveryTx({ createdAt: "2027-01-15T07:50:00Z" })])?.receiptHash).toBe(
      other,
    );
  });

  it("ignores entry deletions and rewrites that aren't anchors", () => {
    const deletion = deliveryTx({
      hash: "x",
      dataOps: [{ account: seller, name: key, value: null }],
    });
    const noMemo = deliveryTx({ hash: "y", memoType: "none" });
    delete noMemo.memo;
    const mismatch = deliveryTx({ hash: "z", memo: otherMemo });
    expect(find([deletion, noMemo, mismatch])).toBeNull();
    expect(find([deletion, deliveryTx()])?.transactionHash).toBe("d1");
  });

  it("only counts deliveries strictly before the deadline", () => {
    expect(find([deliveryTx({ createdAt: "2027-01-15T07:59:59Z" })])).not.toBeNull();
    expect(find([deliveryTx({ createdAt: "2027-01-15T08:00:00Z" })])).toBeNull();
    expect(find([deliveryTx({ createdAt: "2027-01-15T09:00:00Z" })])).toBeNull();
  });

  it("ignores anchors from before the balance existed (predictable balance ids)", () => {
    expect(find([deliveryTx({ createdAt: "2027-01-15T06:59:59Z" })])).toBeNull();
  });

  it("ignores failed transactions, other accounts and other escrows", () => {
    expect(find([deliveryTx({ successful: false })])).toBeNull();
    const stranger = Keypair.random().publicKey();
    expect(
      find([deliveryTx({ dataOps: [{ account: stranger, name: key, value: memo }] })]),
    ).toBeNull();
    expect(
      find([deliveryTx({ dataOps: [{ account: seller, name: "cd".repeat(32), value: memo }] })]),
    ).toBeNull();
  });
});

describe("allocateClaimPayments (review item 14: one payment backs one escrow)", () => {
  const claim = (escrowId: string, amount = "1.5000000", claimant = buyer): BatchClaim => ({
    escrowId,
    claimant,
    buyer,
    seller,
    asset: TESTNET_USDC,
    amount,
  });
  const pay = (amount = "1.5000000") => ({ from: buyer, to: seller, asset: TESTNET_USDC, amount });

  it("one payment for two claimed balances accepts only the first", () => {
    const a = allocateClaimPayments([claim("e1"), claim("e2")], [pay()]);
    expect([...a.entries()]).toEqual([["e1", 0]]);
  });

  it("two exact payments accept both", () => {
    const a = allocateClaimPayments([claim("e1"), claim("e2")], [pay(), pay()]);
    expect([...a.entries()]).toEqual([
      ["e1", 0],
      ["e2", 1],
    ]);
  });

  it("matches exact amounts so different sizes can't steal each other's payment", () => {
    const a = allocateClaimPayments(
      [claim("small", "1.0000000"), claim("big", "2.0000000")],
      [pay("2.0000000"), pay("1.0000000")],
    );
    expect(a.get("small")).toBe(1);
    expect(a.get("big")).toBe(0);
  });

  it("seller claims never consume payments", () => {
    const a = allocateClaimPayments([claim("s", "1.5000000", seller), claim("b")], [pay()]);
    expect([...a.entries()]).toEqual([["b", 0]]);
  });

  it("derives a batch: the second escrow paid by the same single payment is refunded", () => {
    const second = `00000000${"cd".repeat(32)}`;
    const history = (escrowId: string): EscrowHistory => ({
      ...base,
      escrowId,
      claim: {
        claimant: buyer,
        transactionHash: "batch",
        payments: [pay()],
        batch: [claim(base.escrowId), claim(second)],
      },
    });
    expect(deriveEscrowState(history(base.escrowId)).status).toBe("released");
    expect(deriveEscrowState(history(second)).status).toBe("refunded");
  });
});

describe("toDeliveryTx", () => {
  it("extracts ManageData operations from the envelope", () => {
    const kp = Keypair.random();
    const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: key, value: receiptHashBytes(receiptHash) }))
      .addOperation(Operation.manageData({ name: "x", value: null, source: seller }))
      .addMemo(Memo.hash(receiptHash))
      .setTimeout(0)
      .build();
    const d = toDeliveryTx({
      hash: "h",
      successful: true,
      created_at: "2027-01-15T07:30:00Z",
      memo_type: "hash",
      memo,
      source_account: kp.publicKey(),
      envelope_xdr: tx.toXDR(),
    });
    expect(d.dataOps).toEqual([
      { account: kp.publicKey(), name: key, value: memo },
      { account: seller, name: "x", value: null },
    ]);
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
