// Full x402 flow for an XRPL issued token with mocks (SPEC §7.3): @x402/xrpl's server scheme
// builds the requirement (decimal value + extra.issuer), @receptum/server records it in 10^-15
// units, @receptum/client checks it against the buyer's integer expectations, and the verifier
// confirms the validated Payment's delivered_amount at that scale.
import { generateSellerKey, sha256Hex, xrplValueToUnits } from "@receptum/core";
import { createReceptumFetch, ReceiptError } from "@receptum/client";
import { handlePaidJob, type PaidJobConfig } from "@receptum/server";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { describe, expect, it, vi } from "vitest";
import { verifyXrplX402Payment, type XrplRpc } from "./xrpl-x402.js";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const BUYER = "rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf";
const SELLER = "r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s";
const CURRENCY = "5243505455534400000000000000000000000000"; // "RCPTUSD", 40-hex
const TX = "C".repeat(64);
const key = generateSellerKey();

async function requirement(value: string) {
  const scheme = new ExactXrplScheme();
  const price = await scheme.parsePrice(
    { amount: value, asset: CURRENCY, extra: { issuer: ISSUER } },
    "xrpl:1",
  );
  return scheme.enhancePaymentRequirements(
    {
      scheme: "exact",
      network: "xrpl:1",
      payTo: SELLER,
      maxTimeoutSeconds: 120,
      extra: {},
      ...price,
    },
    { x402Version: 2, scheme: "exact", network: "xrpl:1" },
    [],
  );
}

function seller(req: Awaited<ReturnType<typeof requirement>>) {
  const x402 = {
    buildPaymentRequirements: vi.fn(async () => [req]),
    createPaymentRequiredResponse: vi.fn(async (accepts: unknown) => ({ x402Version: 2, accepts })),
    findMatchingRequirements: vi.fn(() => req),
    verifyPayment: vi.fn(async () => ({ isValid: true, payer: BUYER })),
    settlePayment: vi.fn(async () => ({
      success: true,
      transaction: TX,
      network: "xrpl:1",
      payer: BUYER,
    })),
  } as unknown as PaidJobConfig["x402"];
  const config: PaidJobConfig = {
    x402,
    accepts: [],
    resource: { url: "https://render.example/render" },
    seller: key,
  };
  return { x402, config };
}

/** A paying fetch that hands the request straight to the seller's handlePaidJob. */
const paidFetch = (config: PaidJobConfig) =>
  (async () => {
    const [accepted] = await config.x402.buildPaymentRequirements({} as never);
    const signature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { signedTxBlob: "00" },
    } as never);
    const res = await handlePaidJob(
      (name) => (name === "PAYMENT-SIGNATURE" ? signature : undefined),
      async () => ({
        jobId: "job",
        inputSha256: [sha256Hex("in")],
        output: new TextEncoder().encode("card"),
        contentType: "text/plain",
      }),
      config,
    );
    return new Response(res.body as ConstructorParameters<typeof Response>[0], {
      status: res.status,
      headers: res.headers,
    });
  }) as unknown as typeof fetch;

const ledger =
  (value: string, currency = CURRENCY): XrplRpc =>
  async (method) =>
    method === "server_info"
      ? { info: { network_id: 1 } }
      : {
          hash: TX,
          validated: true,
          ledger_index: 99,
          tx_json: { TransactionType: "Payment", Account: BUYER, Destination: SELLER },
          meta: {
            TransactionResult: "tesSUCCESS",
            delivered_amount: { currency, issuer: ISSUER, value },
          },
        };

const expected = (maxValue: string) => ({
  network: "xrpl:1",
  asset: `${CURRENCY}.${ISSUER}`,
  maxAmount: xrplValueToUnits(maxValue),
  payee: `xrpl:1:${SELLER}`,
  payer: BUYER,
});

describe("x402 exact on XRPL with an issued token, end to end (mocks)", () => {
  it("pays 0.25 RCPTUSD, receipts 250000000000000 units, and verifies the delivery", async () => {
    const { config } = seller(await requirement("0.25"));
    const buy = createReceptumFetch({
      paidFetch: paidFetch(config),
      networks: ["xrpl:1"],
      expected: expected("0.25"),
    });
    const { receipt, check } = await buy("https://render.example/render");
    expect(check.ok).toBe(true);
    expect(receipt.receipt.payment).toMatchObject({
      asset: `${CURRENCY}.${ISSUER}`,
      amount: "250000000000000",
      reference: TX,
    });
    const r = await verifyXrplX402Payment(receipt.receipt.payment, { rpc: ledger("0.25") });
    expect(r.status).toBe("pass");
    // The same value in rippled's exponent form is the same amount.
    expect(
      (await verifyXrplX402Payment(receipt.receipt.payment, { rpc: ledger("25e-2") })).status,
    ).toBe("pass");
    // One 10^-15 unit less on the ledger fails.
    expect(
      (await verifyXrplX402Payment(receipt.receipt.payment, { rpc: ledger("0.249999999999999") }))
        .status,
    ).toBe("fail");
  });

  it("the buyer's maxAmount compares integer units: 0.25 exceeds a 0.2 cap", async () => {
    const { config } = seller(await requirement("0.25"));
    const buy = createReceptumFetch({
      paidFetch: paidFetch(config),
      networks: ["xrpl:1"],
      expected: expected("0.2"),
    });
    await expect(buy("https://render.example/render")).rejects.toThrow(/exceeds the maximum/);
    const decimal = createReceptumFetch({
      paidFetch: paidFetch(config),
      networks: ["xrpl:1"],
      expected: { ...expected("0.25"), maxAmount: "0.25" },
    });
    await expect(decimal("https://render.example/render")).rejects.toThrow(ReceiptError);
  });

  it("the seller refuses, before charging, a price finer than 10^-15", async () => {
    const { x402, config } = seller(await requirement("0.0000000000000001"));
    await expect(paidFetch(config)("https://render.example/render")).rejects.toThrow(
      /issued-token/,
    );
    expect(x402.settlePayment).not.toHaveBeenCalled();
  });
});
