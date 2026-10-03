import { sha256Hex } from "@receptum/core";
import { beforeEach, describe, expect, it } from "vitest";
import { rippleTimeToISOTime, Wallet } from "xrpl";
import { XrplAnchor } from "./anchor.js";
import { newEscrowSecret } from "./condition.js";
import { parseReceiptMemos } from "./encoding.js";
import { XrplEscrowRail } from "./escrow.js";
import { fakeLedger } from "./fake-ledger.test-util.js";
import { XrplTxError } from "./ledger.js";

const buyer = Wallet.generate();
const seller = Wallet.generate();
const stranger = Wallet.generate();
const receiptHash = sha256Hex("receipt");

describe("XrplEscrowRail", () => {
  let ledger: ReturnType<typeof fakeLedger>;
  let secret: ReturnType<typeof newEscrowSecret>;
  let accepted: string | undefined;
  const rail = (wallet: Wallet) =>
    new XrplEscrowRail({ client: ledger.client, wallet, fulfillment: () => accepted });

  const create = (asset = "XRP", amount = "2000000") =>
    rail(buyer).createEscrow({
      seller: seller.address,
      amount,
      asset,
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });

  beforeEach(() => {
    ledger = fakeLedger();
    secret = newEscrowSecret();
    accepted = undefined;
  });

  it("creates a conditional, cancellable escrow with CancelAfter = deliverBy + review window", async () => {
    const handle = await create();
    const tx = ledger.state.submitted[0]!;
    expect(tx).toMatchObject({
      TransactionType: "EscrowCreate",
      Account: buyer.address,
      Destination: seller.address,
      Amount: "2000000",
      Condition: secret.condition,
      CancelAfter: ledger.state.closeTime + 900,
    });
    expect(tx.FinishAfter).toBeUndefined();
    expect(handle).toMatchObject({
      rail: "escrow:xrpl",
      network: "xrpl:1",
      escrowId: `${buyer.address}:${tx.Sequence}`,
      asset: "XRP",
      amount: "2000000",
      buyer: buyer.address,
      seller: seller.address,
      refundableAfter: rippleTimeToISOTime(ledger.state.closeTime + 900),
    });
    expect(await rail(seller).getEscrow(handle.escrowId)).toMatchObject({ status: "open" });
  });

  it("delivers, then releases only with the buyer's fulfillment", async () => {
    const { escrowId } = await create();
    await expect(rail(stranger).deliver(escrowId, receiptHash)).rejects.toThrow(/only the seller/);

    const { reference } = await rail(seller).deliver(escrowId, receiptHash);
    const memoTx = ledger.state.submitted.at(-1)!;
    expect(memoTx.TransactionType).toBe("AccountSet");
    expect(parseReceiptMemos(memoTx.Memos as never)).toEqual({ receiptHash, escrowId });
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({
      status: "delivered",
      receiptHash,
    });

    await expect(rail(seller).release(escrowId)).rejects.toThrow(/fulfillment/);
    accepted = newEscrowSecret().fulfillment;
    await expect(rail(seller).release(escrowId)).rejects.toThrow(/does not match/);

    accepted = secret.fulfillment;
    await rail(seller).release(escrowId);
    expect(ledger.state.submitted.at(-1)).toMatchObject({
      TransactionType: "EscrowFinish",
      Owner: buyer.address,
      Condition: secret.condition,
      Fulfillment: secret.fulfillment,
    });
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({
      status: "released",
      receiptHash,
    });
    await expect(rail(buyer).refund(escrowId)).rejects.toThrow(/not open/);

    const anchor = new XrplAnchor({ client: ledger.client });
    expect(await anchor.find(receiptHash, { reference })).toMatchObject({ reference });
  });

  it("refunds only after the ledger close time passes CancelAfter", async () => {
    const { escrowId } = await create();
    await expect(rail(buyer).refund(escrowId)).rejects.toThrow(/not refundable until/);
    ledger.state.closeTime += 900;
    await expect(rail(buyer).refund(escrowId)).rejects.toThrow(/not refundable until/);
    ledger.state.closeTime += 1;
    await expect(rail(seller).deliver(escrowId, receiptHash)).rejects.toThrow(/CancelAfter/);
    accepted = secret.fulfillment;
    await expect(rail(seller).release(escrowId)).rejects.toThrow(/only a refund/);

    await rail(buyer).refund(escrowId);
    expect(ledger.state.submitted.at(-1)).toMatchObject({ TransactionType: "EscrowCancel" });
    expect(await rail(seller).getEscrow(escrowId)).toMatchObject({ status: "refunded" });
  });

  it("escrows issued tokens with integer amounts", async () => {
    const issuer = Wallet.generate().address;
    const handle = await create(`RLUSD.${issuer}`, "1250000");
    expect(ledger.state.submitted[0]!.Amount).toEqual({
      currency: "524C555344000000000000000000000000000000",
      issuer,
      value: "1.25",
    });
    expect(handle).toMatchObject({ asset: `RLUSD.${issuer}`, amount: "1250000" });
    expect(await rail(buyer).getEscrow(handle.escrowId)).toMatchObject({ amount: "1250000" });
  });

  it("surfaces failed engine results and unknown escrows", async () => {
    ledger.state.nextResult = "tecNO_PERMISSION";
    await expect(create()).rejects.toThrow(XrplTxError);
    await expect(rail(buyer).getEscrow(`${buyer.address}:7`)).rejects.toThrow(/not found/);
    await expect(rail(buyer).getEscrow("nope")).rejects.toThrow(TypeError);
    await expect(new XrplEscrowRail({ client: ledger.client }).refund("x")).rejects.toThrow(
      /wallet/,
    );
  });
});

describe("XrplAnchor", () => {
  it("anchors a receipt hash and finds it by reference or account history", async () => {
    const { client, state } = fakeLedger();
    const anchor = new XrplAnchor({ client, wallet: seller });
    const record = await anchor.anchor(receiptHash);
    expect(state.submitted[0]).toMatchObject({
      TransactionType: "AccountSet",
      Account: seller.address,
    });
    expect(record).toMatchObject({ rail: "anchor:xrpl", network: "xrpl:1", receiptHash });

    expect(await anchor.find(receiptHash, { reference: record.reference })).toMatchObject(record);
    expect(
      await new XrplAnchor({ client, account: seller.address }).find(receiptHash),
    ).toMatchObject({
      reference: record.reference,
    });
    expect(await anchor.find(sha256Hex("other"), { reference: record.reference })).toBeNull();
    expect(await anchor.find(receiptHash, { reference: "00".repeat(32) })).toBeNull();
    expect(await new XrplAnchor({ client }).find(receiptHash)).toBeNull();
  });
});
