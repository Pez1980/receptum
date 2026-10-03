import {
  createReceipt,
  generateSellerKey,
  signReceipt,
  type DeliveryReceipt,
  type SignedReceipt,
} from "@receptum/core";
import { XrplHistoryIncompleteError, type XrplEscrowState } from "@receptum/adapter-xrpl";
import { describe, expect, it } from "vitest";
import { checkXrplEscrow, verifyXrplEscrowPayment } from "./xrpl-escrow.js";

const BUYER = "rfy1FurqCy5P7ads54PCxGUbqJyeK1LX7r";
const SELLER = "rUuUZJXy7qQhZkpr8ovFBgBT5JrPv3nnFf";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const ESCROW = `${BUYER}:21239409`;
const CONDITION = "A0258020" + "AB".repeat(32) + "810120";
const USD = "0000000000000000000000005553440000000000";
const key = generateSellerKey();

const receipt = (
  acceptance: DeliveryReceipt["acceptance"] = { mode: "buyer", reviewWindowSeconds: 600 },
  asset = "XRP",
): SignedReceipt =>
  signReceipt(
    createReceipt({
      jobId: "job",
      seller: { id: key.did },
      inputSha256: ["00".repeat(32)],
      outputSha256: "11".repeat(32),
      payment: {
        rail: "escrow:xrpl",
        network: "xrpl:1",
        asset,
        amount: "2000000",
        reference: ESCROW,
        payer: `xrpl:1:${BUYER}`,
        payee: `xrpl:1:${SELLER}`,
      },
      acceptance,
    }),
    key,
  );

const state = (
  signed: SignedReceipt,
  over: Partial<XrplEscrowState> = {},
  xrpl: Record<string, string | number | undefined> = {},
): XrplEscrowState => ({
  rail: "escrow:xrpl",
  network: "xrpl:1",
  escrowId: ESCROW,
  amount: "2000000",
  asset: "XRP",
  buyer: BUYER,
  seller: SELLER,
  refundableAfter: "2026-10-03T15:33:27.000Z",
  status: "released",
  receiptHash: signed.receiptHash,
  ...over,
  xrpl: Object.fromEntries(
    Object.entries({
      currency: "XRP",
      condition: CONDITION,
      cancelAfter: 844_356_807,
      deliveryCloseTime: 844_355_620, // 1187 s before CancelAfter
      ...xrpl,
    }).filter(([, v]) => v !== undefined),
  ) as XrplEscrowState["xrpl"],
});

describe("escrow:xrpl level 3", () => {
  it("passes a released conditional escrow in buyer mode whose terms the ledger proves", () => {
    const s = receipt();
    expect(checkXrplEscrow(s, state(s)).status).toBe("pass");
  });

  it("compares currencies by protocol bytes, not by the decoded symbol", () => {
    const s = receipt(undefined, `USD.${ISSUER}`);
    const standard = state(s, { asset: `USD.${ISSUER}` }, { currency: USD, issuer: ISSUER });
    expect(checkXrplEscrow(s, standard).status).toBe("pass");
    // A nonstandard code whose bytes spell "USD" is a different currency, whatever it displays as.
    const nonstandard = state(
      s,
      { asset: `USD.${ISSUER}` },
      { currency: "5553440000000000000000000000000000000000", issuer: ISSUER },
    );
    expect(checkXrplEscrow(s, nonstandard)).toMatchObject({ status: "fail" });
    expect(checkXrplEscrow(s, nonstandard).detail).toMatch(/asset differs/);
    // Case matters for standard codes.
    const lower = state(
      s,
      {},
      { currency: "0000000000000000000000007573640000000000", issuer: ISSUER },
    );
    expect(checkXrplEscrow(s, lower).status).toBe("fail");
    // XRP never matches an issued asset, and vice versa.
    expect(checkXrplEscrow(s, state(s)).status).toBe("fail");
    const x = receipt();
    expect(checkXrplEscrow(x, state(x, {}, { currency: USD, issuer: ISSUER })).status).toBe("fail");
  });

  it("fails a review window the ledger contradicts (more than CancelAfter − delivery)", () => {
    const absurd = receipt({ mode: "buyer", reviewWindowSeconds: 10 ** 12 });
    const r = checkXrplEscrow(absurd, state(absurd));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/reviewWindowSeconds/);
    const edge = receipt({ mode: "buyer", reviewWindowSeconds: 1187 });
    expect(checkXrplEscrow(edge, state(edge)).status).toBe("pass");
    const over = receipt({ mode: "buyer", reviewWindowSeconds: 1188 });
    expect(checkXrplEscrow(over, state(over)).status).toBe("fail");
  });

  it("never verifies a non-XRPL evaluator: holding the fulfillment doesn't prove who decided", () => {
    const s = receipt({
      mode: "evaluator",
      reviewWindowSeconds: 600,
      evaluator: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    });
    const r = checkXrplEscrow(s, state(s));
    expect(r.status).toBe("unavailable");
    expect(r.detail).toMatch(/evaluator/);
    // Contradictions still fail first.
    expect(checkXrplEscrow(s, state(s, { amount: "1" })).status).toBe("fail");
  });

  describe("evaluator mode: the EscrowFinish Account is the on-ledger decision (SPEC §7.3)", () => {
    const EVALUATOR = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
    const evaluated = (evaluator = `xrpl:1:${EVALUATOR}`) =>
      receipt({ mode: "evaluator", reviewWindowSeconds: 600, evaluator });
    const finished = (
      s: SignedReceipt,
      by: string | undefined,
      over: Partial<XrplEscrowState> = {},
    ) => state(s, over, { settledBy: by, settlementTx: "F".repeat(64) });

    it("passes when the evaluator's own account finished the escrow", () => {
      const s = evaluated();
      const r = checkXrplEscrow(s, finished(s, EVALUATOR));
      expect(r.status).toBe("pass");
      expect(r.detail).toContain(EVALUATOR);
    });

    it("fails when anyone else finished it — seller, buyer or a third party", () => {
      const s = evaluated();
      for (const by of [SELLER, BUYER, ISSUER]) {
        const r = checkXrplEscrow(s, finished(s, by));
        expect(r.status, by).toBe("fail");
        expect(r.detail).toMatch(/not by the evaluator/);
      }
    });

    it("is pending while delivered and fails once refunded (rejection)", () => {
      const s = evaluated();
      const pending = checkXrplEscrow(s, finished(s, undefined, { status: "delivered" }));
      expect(pending).toMatchObject({ status: "pending" });
      expect(pending.detail).toMatch(/evaluator's EscrowFinish/);
      expect(checkXrplEscrow(s, finished(s, BUYER, { status: "refunded" })).status).toBe("fail");
    });

    it("needs the same ledger terms as buyer mode: a Condition and the review-window bound", () => {
      const s = evaluated();
      const unconditional = state(s, {}, { settledBy: EVALUATOR, condition: undefined });
      expect(checkXrplEscrow(s, unconditional).status).toBe("fail");
      const long = receipt({
        mode: "evaluator",
        reviewWindowSeconds: 1188,
        evaluator: `xrpl:1:${EVALUATOR}`,
      });
      expect(checkXrplEscrow(long, finished(long, EVALUATOR)).status).toBe("fail");
    });

    it("fails an XRPL evaluator on another network, an invalid address, or the seller itself", () => {
      for (const ev of [`xrpl:0:${EVALUATOR}`, "xrpl:1:rNotAnAddress", `xrpl:1:${SELLER}`]) {
        const s = evaluated(ev);
        const by = ev.split(":")[2]!;
        expect(checkXrplEscrow(s, finished(s, by)).status, ev).toBe("fail");
      }
    });

    it("stays unavailable for an evaluator that is not an XRPL account", () => {
      for (const ev of [
        "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        "eip155:1:0x0000000000000000000000000000000000000001",
      ]) {
        const s = evaluated(ev);
        expect(checkXrplEscrow(s, finished(s, EVALUATOR)).status, ev).toBe("unavailable");
      }
    });

    it("is unavailable when the history doesn't say who finished", () => {
      const s = evaluated();
      expect(checkXrplEscrow(s, finished(s, undefined)).status).toBe("unavailable");
    });
  });

  it("fails an issued-token escrow whose value has no 10^-15 integer form", () => {
    const s = receipt(undefined, `USD.${ISSUER}`);
    const r = checkXrplEscrow(
      s,
      state(s, { amount: "" }, { currency: USD, issuer: ISSUER, value: "1e-16" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/10\^-15/);
  });

  it("fails auto mode on a conditional escrow, and acceptance modes on an unconditional one", () => {
    const auto = receipt({ mode: "auto", reviewWindowSeconds: 600 });
    expect(checkXrplEscrow(auto, state(auto)).status).toBe("fail");
    expect(checkXrplEscrow(auto, state(auto, {}, { condition: undefined })).status).toBe(
      "unavailable",
    );
    const buyer = receipt();
    const r = checkXrplEscrow(buyer, state(buyer, {}, { condition: undefined }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/Condition/);
  });

  it("keeps delivered escrows pending and refunded ones failing", () => {
    const s = receipt();
    expect(checkXrplEscrow(s, state(s, { status: "delivered" })).status).toBe("pending");
    expect(checkXrplEscrow(s, state(s, { status: "refunded" })).status).toBe("fail");
  });

  it("maps incomplete history to unavailable — never fail, never pass", async () => {
    const s = receipt();
    const r = await verifyXrplEscrowPayment(s, async () => {
      throw new XrplHistoryIncompleteError("account_tx page limit reached");
    });
    expect(r.status).toBe("unavailable");
    const missing = await verifyXrplEscrowPayment(s, async () => {
      throw new Error(`escrow ${ESCROW} not found`);
    });
    expect(missing.status).toBe("fail");
    const ok = await verifyXrplEscrowPayment(s, async () => state(s));
    expect(ok.status).toBe("pass");
  });
});
