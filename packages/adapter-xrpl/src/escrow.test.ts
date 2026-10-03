import { sha256Hex } from "@receptum/core";
import { beforeEach, describe, expect, it } from "vitest";
import { rippleTimeToISOTime, Wallet } from "xrpl";
import { XrplAnchor } from "./anchor.js";
import { newEscrowSecret } from "./condition.js";
import { parseReceiptMemos, receiptMemos } from "./encoding.js";
import { XrplEscrowRail } from "./escrow.js";
import { fakeLedger } from "./fake-ledger.test-util.js";
import { XrplHistoryIncompleteError, XrplTxError } from "./ledger.js";

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

  it("escrows issued tokens with integer 10^-15 amounts (SPEC §7.3)", async () => {
    const issuer = Wallet.generate().address;
    const RLUSD = "524C555344000000000000000000000000000000";
    const handle = await create(`${RLUSD}.${issuer}`, "1250000000000000");
    expect(ledger.state.submitted[0]!.Amount).toEqual({ currency: RLUSD, issuer, value: "1.25" });
    expect(handle).toMatchObject({ asset: `${RLUSD}.${issuer}`, amount: "1250000000000000" });
    expect(await rail(buyer).getEscrow(handle.escrowId)).toMatchObject({
      amount: "1250000000000000",
      xrpl: { currency: RLUSD, issuer, value: "1.25" },
    });
    await expect(create(`RLUSD.${issuer}`, "1")).rejects.toThrow(TypeError); // display symbol
    await expect(create(`USD.${issuer}`, "12345678901234567")).rejects.toThrow(RangeError);
  });

  it("reports an escrowed value finer than 10^-15 with an empty amount", async () => {
    const issuer = Wallet.generate().address;
    await ledger.client.submitAndWait(
      {
        TransactionType: "EscrowCreate",
        Account: buyer.address,
        Destination: seller.address,
        Amount: { currency: "USD", issuer, value: "1e-16" },
        Condition: secret.condition,
        CancelAfter: ledger.state.closeTime + 900,
      } as never,
      { wallet: buyer, autofill: true } as never,
    );
    const tx = ledger.state.submitted.at(-1)!;
    const state = await rail(buyer).getEscrow(`${buyer.address}:${tx.Sequence}`);
    expect(state).toMatchObject({ asset: `USD.${issuer}`, amount: "" });
    expect(state.xrpl.value).toBe("1e-16");
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

describe("XrplEscrowRail delivery from chronological history", () => {
  let ledger: ReturnType<typeof fakeLedger>;
  let secret: ReturnType<typeof newEscrowSecret>;
  const rail = (wallet: Wallet) =>
    new XrplEscrowRail({ client: ledger.client, wallet, fulfillment: () => secret.fulfillment });
  const create = () =>
    rail(buyer).createEscrow({
      seller: seller.address,
      amount: "1000000",
      asset: "XRP",
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });
  /** A raw memo transaction, bypassing deliver()'s own guards (as an attacker could). */
  const memo = (from: Wallet, hash: string, escrowId: string) =>
    ledger.client.submitAndWait(
      {
        TransactionType: "AccountSet",
        Account: from.address,
        Memos: receiptMemos(hash, escrowId),
      } as never,
      { wallet: from },
    );
  const first = sha256Hex("first");
  const later = sha256Hex("later");

  beforeEach(() => {
    ledger = fakeLedger();
    secret = newEscrowSecret();
  });

  it("keeps the first delivery memo and ignores later ones", async () => {
    const { escrowId } = await create();
    await rail(seller).deliver(escrowId, first);
    await memo(seller, later, escrowId);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({
      status: "delivered",
      receiptHash: first,
    });
    await rail(seller).release(escrowId);
    await memo(seller, later, escrowId);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({
      status: "released",
      receiptHash: first,
    });
  });

  it("ignores memos from anyone but the seller", async () => {
    const { escrowId } = await create();
    await memo(stranger, later, escrowId);
    await memo(buyer, later, escrowId);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({ status: "open" });
    expect((await rail(buyer).getEscrow(escrowId)).receiptHash).toBeUndefined();
  });

  it("ignores memos sent before the EscrowCreate (e.g. for a predicted escrow id)", async () => {
    // Predict the next escrow id (owner:sequence) and "deliver" to it before it exists.
    const predicted = `${buyer.address}:${101}`;
    await memo(seller, later, predicted);
    const { escrowId } = await create();
    expect(escrowId).toBe(predicted);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({ status: "open" });
  });

  it("ignores memos after CancelAfter, and a delivery after refund doesn't count", async () => {
    const { escrowId } = await create();
    ledger.state.closeTime += 901; // past CancelAfter
    await memo(seller, later, escrowId);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({ status: "open" });
    await rail(buyer).refund(escrowId);
    await memo(seller, later, escrowId);
    const state = await rail(buyer).getEscrow(escrowId);
    expect(state.status).toBe("refunded");
    expect(state.receiptHash).toBeUndefined();
  });

  it("counts a delivery at exactly CancelAfter but not one second later", async () => {
    const { escrowId } = await create();
    ledger.state.closeTime += 900; // == CancelAfter
    await memo(seller, first, escrowId);
    expect(await rail(buyer).getEscrow(escrowId)).toMatchObject({ receiptHash: first });
  });
});

describe("XrplEscrowRail protocol identity and terms", () => {
  let ledger: ReturnType<typeof fakeLedger>;
  let secret: ReturnType<typeof newEscrowSecret>;
  const rail = (wallet: Wallet) =>
    new XrplEscrowRail({ client: ledger.client, wallet, fulfillment: () => secret.fulfillment });

  beforeEach(() => {
    ledger = fakeLedger();
    secret = newEscrowSecret();
  });

  it("keeps the raw 160-bit currency, condition and ledger times in the escrow state", async () => {
    const issuer = Wallet.generate().address;
    const nonstandard = "5553440000000000000000000000000000000000"; // bytes spell "USD"
    const { escrowId } = await rail(buyer).createEscrow({
      seller: seller.address,
      amount: "1",
      asset: `${nonstandard}.${issuer}`,
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });
    ledger.state.closeTime += 10;
    await rail(seller).deliver(escrowId, receiptHash);
    const state = await rail(buyer).getEscrow(escrowId);
    expect(state.asset).toBe(`${nonstandard}.${issuer}`); // never displayed as "USD"
    expect(state.xrpl).toEqual({
      currency: nonstandard,
      issuer,
      value: "0.000000000000001",
      condition: secret.condition,
      cancelAfter: ledger.state.closeTime - 10 + 900,
      deliveryCloseTime: ledger.state.closeTime,
    });
  });

  it("reports XRP escrows as XRP", async () => {
    const { escrowId } = await rail(buyer).createEscrow({
      seller: seller.address,
      amount: "5",
      asset: "XRP",
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });
    expect((await rail(buyer).getEscrow(escrowId)).xrpl).toMatchObject({ currency: "XRP" });
  });
});

describe("XrplEscrowRail evaluator flow", () => {
  const evaluator = Wallet.generate();
  let ledger: ReturnType<typeof fakeLedger>;
  let secret: ReturnType<typeof newEscrowSecret>;
  let handedToEvaluator: string | undefined;
  const rail = (wallet: Wallet) =>
    new XrplEscrowRail({
      client: ledger.client,
      wallet,
      // Off-ledger: the buyer gave the fulfillment to the evaluator only.
      fulfillment: () => (wallet === evaluator ? handedToEvaluator : undefined),
    });

  beforeEach(() => {
    ledger = fakeLedger();
    secret = newEscrowSecret();
    handedToEvaluator = secret.fulfillment;
  });

  const open = () =>
    rail(buyer).createEscrow({
      seller: seller.address,
      amount: "2000000",
      asset: "XRP",
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });

  it("advertises buyer and evaluator acceptance, never auto", () => {
    expect(rail(buyer).capabilities).toEqual({
      acceptanceModes: ["buyer", "evaluator"],
      reviewWindowFromDelivery: false,
      refundAfterDelivery: true,
    });
  });

  it("open → deliver → evaluator finishes; the ledger records the evaluator as finisher", async () => {
    const { escrowId } = await open();
    await rail(seller).deliver(escrowId, receiptHash);
    // The seller can't release: it never had the fulfillment.
    await expect(rail(seller).release(escrowId)).rejects.toThrow(/fulfillment/);
    await expect(
      rail(seller).accept(escrowId, { evaluator: `xrpl:1:${evaluator.address}` }),
    ).rejects.toThrow(/only the evaluator/);
    await expect(
      rail(evaluator).accept(escrowId, { evaluator: `xrpl:0:${evaluator.address}` }),
    ).rejects.toThrow(/not an account on xrpl:1/);
    const { reference } = await rail(evaluator).accept(escrowId, {
      evaluator: `xrpl:1:${evaluator.address}`,
    });
    expect(ledger.state.submitted.at(-1)).toMatchObject({
      TransactionType: "EscrowFinish",
      Account: evaluator.address,
      Fulfillment: secret.fulfillment,
    });
    const state = await rail(buyer).getEscrow(escrowId);
    expect(state).toMatchObject({ status: "released", receiptHash });
    expect(state.xrpl).toMatchObject({ settledBy: evaluator.address, settlementTx: reference });
  });

  it("rejection is not finishing: after CancelAfter the buyer refunds, and the refund is recorded", async () => {
    const { escrowId } = await open();
    await rail(seller).deliver(escrowId, receiptHash);
    ledger.state.closeTime += 901;
    const { reference } = await rail(buyer).refund(escrowId);
    const state = await rail(seller).getEscrow(escrowId);
    expect(state.status).toBe("refunded");
    expect(state.xrpl).toMatchObject({ settledBy: buyer.address, settlementTx: reference });
    await expect(rail(evaluator).accept(escrowId)).rejects.toThrow(/not open/);
  });
});

describe("XrplEscrowRail bounded history", () => {
  let ledger: ReturnType<typeof fakeLedger>;
  let secret: ReturnType<typeof newEscrowSecret>;
  const rail = (wallet: Wallet, maxHistoryPages = 10) =>
    new XrplEscrowRail({
      client: ledger.client,
      wallet,
      fulfillment: () => secret.fulfillment,
      maxHistoryPages,
    });
  const create = () =>
    rail(buyer).createEscrow({
      seller: seller.address,
      amount: "1000000",
      asset: "XRP",
      deliverBy: new Date(rippleTimeToISOTime(ledger.state.closeTime + 600)),
      reviewWindowSeconds: 300,
      condition: secret.condition,
    });
  const noop = (from: Wallet) =>
    ledger.client.submitAndWait({ TransactionType: "AccountSet", Account: from.address } as never, {
      wallet: from,
    });

  beforeEach(() => {
    ledger = fakeLedger();
    secret = newEscrowSecret();
  });

  it("throws a dedicated incomplete-history error when the page limit leaves a marker", async () => {
    const { escrowId } = await create();
    await rail(seller).deliver(escrowId, receiptHash);
    await rail(seller).release(escrowId);
    for (let i = 0; i < 5; i++) await noop(buyer); // push the EscrowFinish back in history
    ledger.state.pageSize = 2;
    const err = await rail(buyer, 2)
      .getEscrow(escrowId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XrplHistoryIncompleteError);
    expect((err as Error).name).toBe("XrplHistoryIncompleteError");
    // With enough pages the same history is decisive.
    expect(await rail(buyer, 4).getEscrow(escrowId)).toMatchObject({ status: "released" });
  });

  it("stops early on decisive evidence even when more history remains", async () => {
    const { escrowId } = await create();
    await rail(seller).deliver(escrowId, receiptHash);
    await rail(seller).release(escrowId);
    for (let i = 0; i < 5; i++) await noop(seller);
    ledger.state.pageSize = 2;
    expect(await rail(buyer, 1).getEscrow(escrowId)).toMatchObject({
      status: "released",
      receiptHash,
    });
  });

  it("an incomplete delivery scan is incomplete, not 'nothing delivered'", async () => {
    const { escrowId } = await create();
    for (let i = 0; i < 5; i++) await noop(seller);
    await rail(seller).deliver(escrowId, receiptHash);
    ledger.state.pageSize = 2;
    await expect(rail(buyer, 2).getEscrow(escrowId)).rejects.toBeInstanceOf(
      XrplHistoryIncompleteError,
    );
  });

  it("'not found' only when the owner's history is complete back to its creation", async () => {
    const { escrowId } = await create();
    const unknown = `${buyer.address}:${Number(escrowId.split(":")[1]) + 50}`;
    await expect(rail(buyer).getEscrow(unknown)).rejects.toThrow(/^escrow \S+ not found$/);
    // A server that lacks the owner's early history can't prove the escrow never existed.
    ledger.state.firstLedger = 1_000_000;
    await expect(rail(buyer).getEscrow(unknown)).rejects.toBeInstanceOf(XrplHistoryIncompleteError);
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

describe("network guard", () => {
  it("refuses to sign when the connected server is not testnet", async () => {
    const { assertTestnet } = await import("./ledger.js");
    const ledger = fakeLedger();
    await expect(assertTestnet(ledger.client)).resolves.toBeUndefined();
    ledger.state.networkId = 0; // XRPL mainnet
    await expect(assertTestnet(ledger.client)).rejects.toThrow(/refusing to sign/);
    ledger.state.networkId = undefined;
    await expect(assertTestnet(ledger.client)).rejects.toThrow(/NetworkID none/);
  });
});
