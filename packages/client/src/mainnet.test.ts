// Buying on a mainnet x402 network: the networks you register are declared, mainnet needs the
// opt-in, and receipts are checked against them. `paidFetch` is a stub — nothing is paid.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReceipt,
  generateSellerKey,
  MainnetNotAllowedError,
  sha256Hex,
  signReceipt,
} from "@receptum/core";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { checkDelivery, createReceptumFetch, ReceiptError } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const seller = generateSellerKey();
const body = new TextEncoder().encode("output");
const receiptOn = (network: string) =>
  signReceipt(
    createReceipt({
      jobId: "j",
      seller: { id: seller.did },
      inputSha256: [sha256Hex("in")],
      outputSha256: sha256Hex(body),
      payment: {
        rail: "x402:exact",
        network,
        asset: USDC,
        amount: "250000",
        reference: "0xsettle",
        payee: `${network}:0xSeller`,
        payer: `${network}:0xBuyer`,
      },
    }),
    seller,
  );
const respond = (network: string) =>
  vi.fn(
    async () =>
      new Response(body, {
        headers: {
          "Receptum-Receipt": Buffer.from(JSON.stringify(receiptOn(network))).toString("base64url"),
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: "0xsettle",
            network,
            payer: "0xBuyer",
          } as never),
        },
      }),
  );

describe("createReceptumFetch with mainnet networks", () => {
  it("refuses to be created for a mainnet without the opt-in (nothing is paid)", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const paidFetch = respond(BASE);
    expect(() => createReceptumFetch({ paidFetch, networks: [BASE] })).toThrow(
      MainnetNotAllowedError,
    );
    expect(() =>
      createReceptumFetch({ paidFetch, networks: ["eip155:84532", BASE], allowMainnet: false }),
    ).toThrow(/explicit opt-in/);
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it("buys on eip155:8453 with the opt-in and pins the expected network", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const buy = createReceptumFetch({
      paidFetch: respond(BASE),
      networks: [BASE],
      allowMainnet: true,
      allowedSellers: [seller.did],
      expected: { network: BASE, asset: USDC, amount: "250000" },
    });
    const res = await buy("https://render.example/render");
    expect(res.check.ok).toBe(true);
    expect(res.receipt.receipt.payment.network).toBe(BASE);
  });

  it("rejects a receipt on a network the client didn't register", async () => {
    const buy = createReceptumFetch({
      paidFetch: respond("eip155:84532"),
      networks: [BASE],
      allowMainnet: true,
    });
    await expect(buy("https://render.example/render")).rejects.toThrow(ReceiptError);
    await expect(buy("https://render.example/render")).rejects.toThrow(/not registered to pay on/);
  });

  it("testnets need no opt-in; RECEPTUM_ALLOW_MAINNET=1 also works", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() =>
      createReceptumFetch({ paidFetch: respond("x"), networks: ["eip155:84532"] }),
    ).not.toThrow();
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    expect(() => createReceptumFetch({ paidFetch: respond("x"), networks: [BASE] })).not.toThrow();
  });

  it("checkDelivery pins mainnet vs testnet with expected.network", () => {
    const settlement = {
      success: true,
      transaction: "0xsettle",
      network: "eip155:84532",
      payer: "0xBuyer",
    };
    const r = checkDelivery(body, receiptOn("eip155:84532"), settlement, undefined, {
      expected: { network: BASE },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("unexpected network");
  });
});
