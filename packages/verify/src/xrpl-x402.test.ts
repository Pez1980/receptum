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

  describe("issued tokens: payment.amount in integer 10^-15 units (SPEC §7.3)", () => {
    const RLUSD = "524C555344000000000000000000000000000000";
    const issued = (value: string, currency = RLUSD, issuer = ISSUER) =>
      txReply({ meta: { delivered_amount: { currency, issuer, value } } });
    const p = (amount: string, asset = `${RLUSD}.${ISSUER}`) => payment({ asset, amount });

    it("passes the exact delivered value at 10^-15 scale", async () => {
      const r = await run(p("250000000000000"), issued("0.25"));
      expect(r.status).toBe("pass");
      expect(r.detail).toContain("0.25");
      // rippled may write the same value in exponent form.
      expect((await run(p("250000000000000"), issued("25e-2"))).status).toBe("pass");
      expect((await run(p("10000000000000"), issued("1e-2"))).status).toBe("pass");
      expect((await run(p("1"), issued("1e-15"))).status).toBe("pass");
      // A 40-hex code compares by identity, hex case ignored.
      expect((await run(p("1", `${RLUSD.toLowerCase()}.${ISSUER}`), issued("1e-15"))).status).toBe(
        "pass",
      );
    });

    it("fails any other amount, even one unit off", async () => {
      for (const amount of ["249999999999999", "250000000000001", "25", "0"]) {
        const r = await run(p(amount), issued("0.25"));
        expect(r.status, amount).toBe("fail");
      }
    });

    it("fails a delivered value finer than 10^-15 (no receipt amount can name it)", async () => {
      const r = await run(p("0"), issued("1e-16"));
      expect(r.status).toBe("fail");
      expect(r.detail).toMatch(/10\^-15/);
    });

    it("fails a display-symbol asset (RLUSD is not an on-ledger code)", async () => {
      expect((await run(p("250000000000000", `RLUSD.${ISSUER}`), issued("0.25"))).status).toBe(
        "fail",
      );
    });

    it("fails another currency or issuer before looking at the amount", async () => {
      expect((await run(p("250000000000000"), issued("0.25", "USD"))).status).toBe("fail");
      expect((await run(p("250000000000000"), issued("0.25", RLUSD, BUYER))).status).toBe("fail");
      expect((await run(p("250000000000000"), txReply())).status).toBe("fail"); // XRP delivered
    });

    it("is unavailable, never pass, without delivered_amount", async () => {
      const r = await run(p("1"), txReply({ meta: { delivered_amount: "unavailable" } }));
      expect(r.status).toBe("unavailable");
    });
  });

  it("compares 3-character currency codes case-sensitively (finding 1)", async () => {
    const usd = { currency: "USD", issuer: ISSUER, value: "1" };
    const lower = await run(
      payment({ asset: `usd.${ISSUER}`, amount: "1" }),
      txReply({ meta: { delivered_amount: usd } }),
    );
    expect(lower.status).toBe("fail");
    const upper = await run(
      payment({ asset: `USD.${ISSUER}`, amount: "1" }),
      txReply({ meta: { delivered_amount: { ...usd, currency: "usd" } } }),
    );
    expect(upper.status).toBe("fail");
  });

  it("compares 160-bit currency identities: standard layout = the code, nonstandard ≠", async () => {
    const p = payment({ asset: `USD.${ISSUER}`, amount: "1" });
    const standard = {
      currency: "0000000000000000000000005553440000000000",
      issuer: ISSUER,
      value: "1",
    };
    expect(
      (
        await run(
          payment({ asset: `USD.${ISSUER}`, amount: "1000000000000000" }),
          txReply({ meta: { delivered_amount: standard } }),
        )
      ).status,
    ).toBe("pass");
    const nonstandard = { ...standard, currency: "5553440000000000000000000000000000000000" };
    expect((await run(p, txReply({ meta: { delivered_amount: nonstandard } }))).status).toBe(
      "fail",
    );
    const hexAsset = payment({
      asset: `5553440000000000000000000000000000000000.${ISSUER}`,
      amount: "1",
    });
    const usd = { currency: "USD", issuer: ISSUER, value: "1" };
    expect((await run(hexAsset, txReply({ meta: { delivered_amount: usd } }))).status).toBe("fail");
  });

  it("fails malformed currency codes without querying the ledger", async () => {
    for (const code of ["XRP", "U D", "0001" + "00".repeat(18), "00".repeat(20)]) {
      const r = await verifyXrplX402Payment(payment({ asset: `${code}.${ISSUER}`, amount: "1" }), {
        rpc: async () => {
          throw new Error("must not be called");
        },
      });
      expect(r.status, code).toBe("fail");
    }
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

  it("fails an issued-currency payment from a wrong issuer", async () => {
    const p = payment({ asset: `USD.${ISSUER}`, amount: "1" });
    const forged = { currency: "USD", issuer: BUYER, value: "1" };
    expect((await run(p, txReply({ meta: { delivered_amount: forged } }))).status).toBe("fail");
  });

  it("fails an issued-currency asset that doesn't name its issuer", async () => {
    expect((await run(payment({ asset: "USD", amount: "1" }), txReply())).status).toBe("fail");
  });

  it("is unavailable, never pass, when the ledger is not validated", async () => {
    const r = await run(payment(), txReply({ top: { validated: false } }));
    expect(r.status).toBe("unavailable");
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
    expect((await run(payment(), txReply(), 0)).status).toBe("unavailable");
    // not an XRPL CAIP-2 id at all
    expect((await run(payment({ network: "xrpl:testnet" }), txReply())).status).toBe("fail");
  });

  it("is unavailable when the lookup is unavailable or the tx is unknown to the server", async () => {
    const down: XrplRpc = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await verifyXrplX402Payment(payment(), { rpc: down })).status).toBe("unavailable");
    expect((await run(payment(), { error: "txnNotFound" })).status).toBe("unavailable");
    expect(
      (
        await verifyXrplX402Payment(
          payment({ network: "xrpl:0", payer: `xrpl:0:${BUYER}`, payee: `xrpl:0:${SELLER}` }),
          {},
        )
      ).status,
    ).toBe("unavailable");
  });

  it("fails a reply for a different transaction hash", async () => {
    const r = await run(payment(), txReply({ top: { hash: "B".repeat(64) } }));
    expect(r.status).toBe("fail");
  });
});
