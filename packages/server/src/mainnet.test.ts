// Registering mainnet x402 networks: explicit facilitator, explicit opt-in. Facilitator and
// settlement are mocks — nothing is sent anywhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSellerKey,
  MainnetNotAllowedError,
  sha256Hex,
  verifySignedReceipt,
} from "@receptum/core";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  facilitatorUrlFor,
  handlePaidJob,
  X402_TESTNET_FACILITATOR_URL,
  type PaidJobConfig,
} from "./index.js";

afterEach(() => vi.unstubAllEnvs());

const CDP = "https://facilitator.mainnet.example/x402";
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("facilitatorUrlFor", () => {
  it("defaults testnets to the public facilitator", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(facilitatorUrlFor("eip155:84532")).toBe(X402_TESTNET_FACILITATOR_URL);
    expect(facilitatorUrlFor("xrpl:1")).toBe("https://x402.org/facilitator");
    expect(
      facilitatorUrlFor("eip155:84532", {
        facilitators: { "eip155:84532": "http://localhost:4022" },
      }),
    ).toBe("http://localhost:4022");
  });

  it("has no default facilitator for mainnet", () => {
    expect(() => facilitatorUrlFor(BASE, { allowMainnet: true })).toThrow(/no default facilitator/);
    expect(() => facilitatorUrlFor("eip155:5042", { allowMainnet: true })).toThrow(
      /facilitators\["eip155:5042"\]/,
    );
  });

  it("requires the opt-in even with a configured mainnet facilitator", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() => facilitatorUrlFor(BASE, { facilitators: { [BASE]: CDP } })).toThrow(
      MainnetNotAllowedError,
    );
    expect(facilitatorUrlFor(BASE, { facilitators: { [BASE]: CDP }, allowMainnet: true })).toBe(
      CDP,
    );
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    expect(facilitatorUrlFor(BASE, { facilitators: { [BASE]: CDP } })).toBe(CDP);
  });

  it("refuses non-https facilitators and unknown networks without config", () => {
    expect(() =>
      facilitatorUrlFor(BASE, { facilitators: { [BASE]: "http://f.example" }, allowMainnet: true }),
    ).toThrow(/https/);
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() => facilitatorUrlFor("eip155:1")).toThrow(/unknown network/);
  });

  it("plugs into an x402 resource server for eip155:8453 (no network until initialize)", () => {
    const client = new HTTPFacilitatorClient({
      url: facilitatorUrlFor(BASE, { facilitators: { [BASE]: CDP }, allowMainnet: true }),
    });
    expect(client.url).toBe(CDP);
    expect(new x402ResourceServer(client)).toBeInstanceOf(x402ResourceServer);
  });
});

describe("handlePaidJob on a mainnet network", () => {
  const seller = generateSellerKey();
  const req = {
    scheme: "exact",
    network: BASE,
    asset: USDC,
    amount: "250000",
    payTo: "0x2222222222222222222222222222222222222222",
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const payload = { x402Version: 2, accepted: req, payload: { signature: "0x" } } as never;
  const fakeX402 = () =>
    ({
      buildPaymentRequirements: vi.fn(async () => [req]),
      createPaymentRequiredResponse: vi.fn(async (accepts: unknown) => ({
        x402Version: 2,
        accepts,
      })),
      findMatchingRequirements: vi.fn(() => req),
      verifyPayment: vi.fn(async () => ({ isValid: true, payer: "0x1111" })),
      settlePayment: vi.fn(async () => ({
        success: true,
        transaction: `0x${"ab".repeat(32)}`,
        network: BASE,
        payer: "0x1111111111111111111111111111111111111111",
      })),
    }) as unknown as PaidJobConfig["x402"] & {
      buildPaymentRequirements: ReturnType<typeof vi.fn>;
      settlePayment: ReturnType<typeof vi.fn>;
    };
  const config = (x402: PaidJobConfig["x402"], allowMainnet?: boolean): PaidJobConfig => ({
    x402,
    accepts: [{ scheme: "exact", payTo: req.payTo, price: "$0.25", network: BASE }],
    resource: { url: "https://render.example/render" },
    seller,
    ...(allowMainnet !== undefined ? { allowMainnet } : {}),
  });
  const output = new TextEncoder().encode("bytes");
  const job = async () => ({
    jobId: "j",
    inputSha256: [sha256Hex("in")],
    output,
    contentType: "text/plain",
  });
  const paid = (h: string) => (n: string) => (n === "PAYMENT-SIGNATURE" ? h : undefined);

  it("refuses before quoting or charging without the opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const x402 = fakeX402();
    await expect(handlePaidJob(() => undefined, job, config(x402))).rejects.toThrow(
      MainnetNotAllowedError,
    );
    await expect(
      handlePaidJob(paid(encodePaymentSignatureHeader(payload)), job, config(x402, false)),
    ).rejects.toThrow(/explicit opt-in/);
    expect(x402.buildPaymentRequirements).not.toHaveBeenCalled();
    expect(x402.settlePayment).not.toHaveBeenCalled();
  });

  it("sells on Base mainnet with the opt-in and signs an eip155:8453 receipt", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const x402 = fakeX402();
    const res = await handlePaidJob(
      paid(encodePaymentSignatureHeader(payload)),
      job,
      config(x402, true),
    );
    expect(res.status).toBe(200);
    expect(x402.settlePayment).toHaveBeenCalledOnce();
    expect(res.receipt?.receipt.payment).toMatchObject({
      rail: "x402:exact",
      network: BASE,
      asset: USDC,
      payee: `${BASE}:${req.payTo}`,
    });
    expect(verifySignedReceipt(res.receipt!).ok).toBe(true);
  });
});
