import { describe, expect, it } from "vitest";
import { verifyXrplX402Payment, type XrplRpc, type XrplX402Payment } from "./xrpl-x402.js";

const HASH = "A".repeat(64);
const BUYER = "rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf";
const SELLER = "r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

const payment = (over: Partial<XrplX402Payment> = {}): XrplX402Payment => ({
  network: "xrpl:1",
  asset: "XRP",
  amount: "10000",
  reference: HASH,
  payer: `xrpl:1:${BUYER}`,
  payee: `xrpl:1:${SELLER}`,
  ...over,
});

/** A rippled `tx` reply (API v2) for a validated XRP payment buyer → seller. */
const txReply = (
  over: { tx?: Record<string, unknown>; meta?: Record<string, unknown>; top?: object } = {},
) => ({
  hash: HASH,
  validated: true,
  ledger_index: 123,
  tx_json: {
    TransactionType: "Payment",
    Account: BUYER,
    Destination: SELLER,
    DeliverMax: "10000",
    ...over.tx,
  },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "10000", ...over.meta },
  ...over.top,
});

const mockRpc =
  (tx: unknown, networkId: number | undefined = 1): XrplRpc =>
  async (method) => {
    if (method === "server_info") return { info: { network_id: networkId } };
    if (method === "tx") return tx;
    throw new Error(`unexpected ${method}`);
  };

const run = (p: XrplX402Payment, tx: unknown, networkId?: number) =>
  verifyXrplX402Payment(p, { rpc: mockRpc(tx, networkId) });

describe("x402:exact on xrpl:*", () => {
  it("passes a validated tesSUCCESS XRP payment of the exact drops to the payee", async () => {
    const r = await run(payment(), txReply());
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("10000 drops");
  });

  it("passes an issued-currency payment with an equal decimal value", async () => {
    const delivered = { currency: "USD", issuer: ISSUER, value: "1e-2" };
    const r = await run(
      payment({ asset: `USD.${ISSUER}`, amount: "0.010" }),
      txReply({ meta: { delivered_amount: delivered } }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails a payment to another destination", async () => {
    const r = await run(payment(), txReply({ tx: { Destination: ISSUER } }));
    expect(r).toMatchObject({ status: "fail" });
    expect(r.detail).toContain("not payment.payee");
  });

  it("fails a payment from another account", async () => {
    const r = await run(payment(), txReply({ tx: { Account: ISSUER } }));
    expect(r.status).toBe("fail");
  });

  it("uses delivered_amount, not Amount: a partial payment delivering less fails", async () => {
    const r = await run(
      payment(),
      txReply({ tx: { DeliverMax: "10000", Flags: 131072 }, meta: { delivered_amount: "1" } }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("delivered 1 drops");
  });

  it("fails an issued-currency partial payment and a wrong issuer", async () => {
    const p = payment({ asset: `USD.${ISSUER}`, amount: "1" });
    const partial = { currency: "USD", issuer: ISSUER, value: "0.5" };
    expect((await run(p, txReply({ meta: { delivered_amount: partial } }))).status).toBe("fail");
    const forged = { currency: "USD", issuer: BUYER, value: "1" };
    expect((await run(p, txReply({ meta: { delivered_amount: forged } }))).status).toBe("fail");
  });

  it("fails an issued-currency asset that doesn't name its issuer", async () => {
    expect((await run(payment({ asset: "USD", amount: "1" }), txReply())).status).toBe("fail");
  });

  it("is pending, never pass, when the ledger is not validated", async () => {
    const r = await run(payment(), txReply({ top: { validated: false } }));
    expect(r.status).toBe("pending");
  });

  it("fails when tesSUCCESS is missing or the result is a tec code", async () => {
    const missing = txReply();
    delete (missing.meta as Record<string, unknown>).TransactionResult;
    expect((await run(payment(), missing)).status).toBe("fail");
    const tec = await run(
      payment(),
      txReply({ meta: { TransactionResult: "tecUNFUNDED_PAYMENT" } }),
    );
    expect(tec.status).toBe("fail");
  });

  it("fails a transaction that is not a Payment", async () => {
    const r = await run(payment(), txReply({ tx: { TransactionType: "AccountSet" } }));
    expect(r.status).toBe("fail");
  });

  it("rejects a wrong network", async () => {
    // payee/payer named on another network
    expect((await run(payment({ payee: `xrpl:0:${SELLER}` }), txReply())).status).toBe("fail");
    // transaction bound to another NetworkID
    expect((await run(payment(), txReply({ tx: { NetworkID: 21338 } }))).status).toBe("fail");
    // the RPC serves a different network: can't be checked here
    expect((await run(payment(), txReply(), 0)).status).toBe("pending");
    // not an XRPL CAIP-2 id at all
    expect((await run(payment({ network: "xrpl:testnet" }), txReply())).status).toBe("fail");
  });

  it("is pending when the lookup is unavailable or the tx is unknown to the server", async () => {
    const down: XrplRpc = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await verifyXrplX402Payment(payment(), { rpc: down })).status).toBe("pending");
    expect((await run(payment(), { error: "txnNotFound" })).status).toBe("pending");
    expect(
      (
        await verifyXrplX402Payment(
          payment({ network: "xrpl:0", payer: `xrpl:0:${BUYER}`, payee: `xrpl:0:${SELLER}` }),
          {},
        )
      ).status,
    ).toBe("pending");
  });

  it("fails a reply for a different transaction hash", async () => {
    const r = await run(payment(), txReply({ top: { hash: "B".repeat(64) } }));
    expect(r.status).toBe("fail");
  });
});
