import { describe, expect, it, vi } from "vitest";
import { generateSellerKey, sha256Hex, verifySignedReceipt } from "@receptum/core";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { handlePaidJob, RECEIPT_HEADER, type PaidJobConfig } from "./index.js";

const seller = generateSellerKey();
const req = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xUSDC",
  amount: "250000",
  payTo: "0xSeller",
  maxTimeoutSeconds: 60,
  extra: {},
};
const payload = { x402Version: 2, accepted: req, payload: { signature: "0x" } } as never;

function fakeX402(over: Partial<Record<string, unknown>> = {}) {
  return {
    buildPaymentRequirements: vi.fn(async () => [req]),
    createPaymentRequiredResponse: vi.fn(
      async (accepts: unknown, resource: unknown, error?: string) => ({
        x402Version: 2,
        accepts,
        resource,
        ...(error ? { error } : {}),
      }),
    ),
    findMatchingRequirements: vi.fn(() => req),
    verifyPayment: vi.fn(async () => ({ isValid: true, payer: "0xBuyer" })),
    settlePayment: vi.fn(async () => ({
      success: true,
      transaction: "0xsettle",
      network: "eip155:84532",
      payer: "0xBuyer",
    })),
    ...over,
  } as unknown as PaidJobConfig["x402"];
}

const config = (x402 = fakeX402()): PaidJobConfig => ({
  x402,
  accepts: [{ scheme: "exact", payTo: "0xSeller", price: "$0.25", network: "eip155:84532" }],
  resource: { url: "https://render.example/render" },
  seller: { ...seller, name: "render.example" },
});

const output = new TextEncoder().encode("rendered video bytes");
const job = vi.fn(async () => ({
  jobId: "job-1",
  inputSha256: [sha256Hex("in")],
  output,
  contentType: "video/mp4",
}));
const headers = (h: Record<string, string>) => (n: string) => h[n];

describe("handlePaidJob", () => {
  it("answers 402 with x402 requirements when unpaid", async () => {
    const res = await handlePaidJob(headers({}), job, config());
    expect(res.status).toBe(402);
    expect(res.headers["PAYMENT-REQUIRED"]).toBeTruthy();
    expect(job).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment without running the job", async () => {
    job.mockClear();
    const x402 = fakeX402({
      verifyPayment: vi.fn(async () => ({ isValid: false, invalidReason: "insufficient_funds" })),
    });
    const res = await handlePaidJob(
      headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
      job,
      config(x402),
    );
    expect(res.status).toBe(402);
    expect(JSON.parse(String(res.body)).error).toBe("insufficient_funds");
    expect(job).not.toHaveBeenCalled();
  });

  it("withholds the output when settlement fails", async () => {
    const x402 = fakeX402({
      settlePayment: vi.fn(async () => ({
        success: false,
        errorReason: "nonce used",
        transaction: "",
        network: "eip155:84532",
      })),
    });
    const res = await handlePaidJob(
      headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
      job,
      config(x402),
    );
    expect(res.status).toBe(402);
    expect(res.body).not.toBe(output);
    expect(res.receipt).toBeUndefined();
  });

  it("delivers the output with a signed receipt bound to the settlement", async () => {
    const res = await handlePaidJob(
      headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
      job,
      config(),
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe(output);
    const signed = JSON.parse(Buffer.from(res.headers[RECEIPT_HEADER]!, "base64url").toString());
    expect(verifySignedReceipt(signed).ok).toBe(true);
    expect(signed.receipt.outputSha256).toBe(sha256Hex(output));
    expect(signed.receipt.payment).toMatchObject({
      rail: "x402:exact",
      network: "eip155:84532",
      amount: "250000",
      reference: "0xsettle",
      payer: "eip155:84532:0xBuyer",
    });
    expect(JSON.stringify(signed)).not.toContain("job-1");
  });

  it("rejects bad job data before charging the buyer", async () => {
    const x402 = fakeX402();
    const bad = vi.fn(async () => ({
      jobId: "j",
      inputSha256: [],
      output,
      contentType: "video/mp4",
    }));
    await expect(
      handlePaidJob(
        headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
        bad,
        config(x402),
      ),
    ).rejects.toThrow(/input hash/);
    expect(x402.settlePayment).not.toHaveBeenCalled();
  });

  it("still delivers the paid output when anchoring fails", async () => {
    const anchor = {
      id: "anchor:test",
      anchor: vi.fn(async () => {
        throw new Error("rpc down");
      }),
      find: vi.fn(),
    };
    const res = await handlePaidJob(
      headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
      job,
      { ...config(), anchor },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe(output);
    expect(res.headers["Receptum-Anchor-Error"]).toBe("anchor_failed");
  });

  it("refuses a payment that is already backing another request", async () => {
    let release!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof job>>>((r) => {
          release = () =>
            r({ jobId: "j", inputSha256: [sha256Hex("in")], output, contentType: "video/mp4" });
        }),
    );
    const h = headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) });
    const first = handlePaidJob(h, slow, config());
    await new Promise((r) => setTimeout(r, 10));
    const second = await handlePaidJob(h, slow, config());
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("locks on the authorization, not the header encoding", async () => {
    const authPayload = {
      x402Version: 2,
      accepted: req,
      payload: { signature: "0xsig", authorization: { from: "0xBuyer", nonce: "0x01" } },
    } as never;
    let release!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof job>>>((r) => {
          release = () =>
            r({ jobId: "j", inputSha256: [sha256Hex("in")], output, contentType: "video/mp4" });
        }),
    );
    const compact = encodePaymentSignatureHeader(authPayload);
    const spaced = Buffer.from(JSON.stringify(authPayload, null, 2)).toString("base64");
    const first = handlePaidJob(headers({ "PAYMENT-SIGNATURE": compact }), slow, config());
    await new Promise((r) => setTimeout(r, 10));
    expect(
      (await handlePaidJob(headers({ "PAYMENT-SIGNATURE": spaced }), slow, config())).status,
    ).toBe(409);
    release();
    await first;
  });

  it("refuses issued-token requirements before charging", async () => {
    const issued = {
      ...req,
      network: "xrpl:1",
      asset: "USD",
      amount: "0.25",
      extra: { issuer: "rIssuer" },
    };
    const x402 = fakeX402({ findMatchingRequirements: vi.fn(() => issued) });
    const paid = headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) });
    await expect(handlePaidJob(paid, job, config(x402))).rejects.toThrow(/issued-token/);
    expect(x402.verifyPayment).not.toHaveBeenCalled();
    expect(x402.settlePayment).not.toHaveBeenCalled();
  });

  it("checks the seller key before charging", async () => {
    const x402 = fakeX402();
    const broken = { ...config(x402), seller: { ...seller, did: generateSellerKey().did } };
    await expect(
      handlePaidJob(
        headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }),
        job,
        broken,
      ),
    ).rejects.toThrow();
    expect(x402.settlePayment).not.toHaveBeenCalled();
  });
});

describe("account bindings", async () => {
  const { createAccountBinding } = await import("@receptum/core");
  const { evmAccountSigner, evmBindingVerifier } = await import("@receptum/adapter-evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  // anvil default accounts #0/#1 — PUBLIC test keys.
  const payTo = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const stranger = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const boundReq = { ...req, payTo: payTo.address };
  const bindingFor = (account = payTo) =>
    createAccountBinding({ key: seller, signer: evmAccountSigner(account, "eip155:84532") });
  const boundConfig = async (account = payTo, verify = true): Promise<PaidJobConfig> => {
    const x402 = fakeX402({
      buildPaymentRequirements: vi.fn(async () => [boundReq]),
      findMatchingRequirements: vi.fn(() => boundReq),
    });
    return {
      ...config(x402),
      bindings: [await bindingFor(account)],
      ...(verify ? { bindingVerifiers: [evmBindingVerifier] } : {}),
    };
  };
  const pay = headers({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) });

  it("attaches the seller's bindings to the receipt, outside the hashed receipt", async () => {
    const cfg = await boundConfig();
    const res = await handlePaidJob(pay, job, cfg);
    expect(res.status).toBe(200);
    expect(res.receipt?.bindings).toEqual(cfg.bindings);
    expect(verifySignedReceipt(res.receipt!).ok).toBe(true);
    const { checkPayeeBinding } = await import("@receptum/core");
    expect(checkPayeeBinding(res.receipt!, { verifiers: [evmBindingVerifier] }).ok).toBe(true);
  });

  it("refuses to charge when its bindings don't cover the payee", async () => {
    const cfg = await boundConfig(stranger);
    await expect(handlePaidJob(pay, job, cfg)).rejects.toThrow(/does not cover the payee/);
    expect(cfg.x402.settlePayment).not.toHaveBeenCalled();
  });
});
