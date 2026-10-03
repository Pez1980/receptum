// Mainnet receipts: networks are labelled, x402 settlement checks work, and escrow receipts
// report an untrusted deployment while the mainnet registry is empty. Every RPC is mocked
// (global fetch / prototype stubs) — nothing reaches a real mainnet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
import { receptumEscrowAbi, receptumEscrowDeployedBytecode } from "@receptum/adapter-evm";
import {
  PUBNET_USDC_SAC,
  RECEPTUM_SOROBAN_WASM_HASH,
  SorobanRpcClient,
} from "@receptum/adapter-stellar";
import { encodeFunctionResult, pad, toHex } from "viem";
import { networkLabel, TRUSTED_ESCROWS, verify } from "./index.js";
import { TRANSFER_TOPIC } from "./evm-transfer.js";
import { XRPL_JSON_RPCS } from "./xrpl-x402.js";

const seller = generateSellerKey();
const file = new TextEncoder().encode("delivered bytes");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sign(payment: Record<string, unknown>, acceptance?: Record<string, unknown>) {
  return signReceipt(
    createReceipt({
      jobId: "j",
      seller: { id: seller.did },
      inputSha256: [sha256Hex("source")],
      outputSha256: sha256Hex(file),
      payment: payment as never,
      ...(acceptance ? { acceptance: acceptance as never } : {}),
    }),
    seller,
  );
}

/** A JSON-RPC fetch stub answering `handlers[method]`. */
function stubRpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as
        | { id: number; method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        calls.push(r.method);
        const h = handlers[r.method];
        if (!h) return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: r.method } };
        return { jsonrpc: "2.0", id: r.id, result: h(r.params) };
      };
      const out = Array.isArray(body) ? body.map(one) : one(body);
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const receiptFields = (logs: unknown[]) => ({
  blockHash: `0x${"cd".repeat(32)}`,
  blockNumber: "0x10",
  contractAddress: null,
  cumulativeGasUsed: "0x1",
  effectiveGasPrice: "0x1",
  from: PAYER,
  gasUsed: "0x1",
  logs,
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  to: USDC,
  transactionHash: TX,
  transactionIndex: "0x0",
  type: "0x2",
});

describe("network labels", () => {
  it("marks mainnet, testnet and unknown receipts distinctly", async () => {
    const main = await verify(
      sign({ rail: "x402:exact", network: "eip155:8453", asset: USDC, amount: "1", reference: TX }),
      { offline: true },
    );
    expect(main).toMatchObject({ network: "eip155:8453", networkClass: "mainnet" });
    expect(networkLabel(main)).toMatch(/^=== MAINNET receipt \(eip155:8453\)/);
    const test = await verify(
      sign({
        rail: "x402:exact",
        network: "eip155:84532",
        asset: USDC,
        amount: "1",
        reference: TX,
      }),
      { offline: true },
    );
    expect(test.networkClass).toBe("testnet");
    expect(networkLabel(test)).toMatch(/^=== TESTNET receipt/);
    expect(networkLabel({ networkClass: "unknown", network: "eip155:1" })).toMatch(
      /unrecognised network \(eip155:1\)/,
    );
    expect(networkLabel(main)).not.toBe(networkLabel(test));
  });
});

describe("mainnet trusted-deployment registry", () => {
  it("has entries for every escrow mainnet, all empty (nothing deployed yet)", () => {
    for (const n of ["eip155:8453", "eip155:5042", "eip155:42161", "stellar:pubnet"]) {
      expect(Object.hasOwn(TRUSTED_ESCROWS, n)).toBe(true);
      expect(TRUSTED_ESCROWS[n]).toEqual([]);
    }
    expect(TRUSTED_ESCROWS["eip155:5042002"]?.length).toBe(1);
    expect(TRUSTED_ESCROWS["eip155:421614"]?.length).toBe(1);
  });

  it("has mainnet XRPL JSON-RPC endpoints", () => {
    expect(XRPL_JSON_RPCS["xrpl:0"]).toMatch(/^https:\/\//);
  });
});

describe("x402 exact on Base mainnet (mock RPC)", () => {
  const signed = sign({
    rail: "x402:exact",
    network: "eip155:8453",
    asset: USDC,
    amount: "250000",
    reference: TX,
    payer: `eip155:8453:${PAYER}`,
    payee: `eip155:8453:${PAYEE}`,
  });
  const transfer = {
    address: USDC,
    topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAYEE)],
    data: pad(toHex(250000n)),
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x10",
    logIndex: "0x0",
    transactionHash: TX,
    transactionIndex: "0x0",
    removed: false,
  };

  it("passes a settlement out of the box", async () => {
    const calls = stubRpc({
      eth_chainId: () => "0x2105",
      eth_getTransactionReceipt: () => receiptFields([transfer]),
    });
    const r = await verify(signed, { file, allowUnbound: true });
    const pay = r.checks.find((c) => c.name === "Payment on eip155:8453");
    expect(pay).toMatchObject({ status: "pass" });
    expect(calls).toContain("eth_chainId");
    expect(r.networkClass).toBe("mainnet");
  });

  it("is unavailable when the RPC serves another chain", async () => {
    stubRpc({
      eth_chainId: () => "0x14a34", // 84532: a testnet RPC behind a mainnet receipt
      eth_getTransactionReceipt: () => receiptFields([transfer]),
    });
    const r = await verify(signed, { file, allowUnbound: true });
    expect(r.checks.find((c) => c.name === "Payment on eip155:8453")).toMatchObject({
      status: "unavailable",
      detail: expect.stringMatching(/serves chain 84532/),
    });
  });
});

describe("mainnet escrow receipts while no deployment is published", () => {
  it("EVM: genuine ReceptumEscrow code on Base reports an untrusted deployment", async () => {
    const contract = "0x3333333333333333333333333333333333333333";
    const signed = sign(
      {
        rail: "escrow:receptum-evm",
        network: "eip155:8453",
        asset: USDC,
        amount: "1000",
        reference: `eip155:8453:${contract}:1`,
        payer: `eip155:8453:${PAYER}`,
        payee: `eip155:8453:${PAYEE}`,
      },
      { mode: "buyer", reviewWindowSeconds: 600 },
    );
    const record = encodeFunctionResult({
      abi: receptumEscrowAbi,
      functionName: "escrows",
      result: [
        PAYER,
        PAYEE,
        "0x0000000000000000000000000000000000000000",
        USDC,
        1000n,
        1n,
        600,
        2n,
        3,
        `0x${signed.receiptHash}`,
      ] as never,
    });
    stubRpc({
      eth_chainId: () => "0x2105",
      eth_getCode: () => receptumEscrowDeployedBytecode,
      eth_call: () => record,
    });
    const r = await verify(signed, { file, allowUnbound: true });
    const pay = r.checks.find((c) => c.name === "Payment on eip155:8453");
    expect(pay).toMatchObject({
      status: "pending",
      detail: expect.stringMatching(
        /^untrusted deployment: no ReceptumEscrow code deployment has been published for mainnet eip155:8453/,
      ),
    });
    expect(r.verdict).toBe("PARTIALLY VERIFIED");
    // Trusting it explicitly is the caller's decision.
    const trusted = await verify(signed, { file, allowUnbound: true, trustedEscrows: [contract] });
    expect(trusted.checks.find((c) => c.name === "Payment on eip155:8453")?.status).toBe("pass");
  });

  it("Soroban: the published wasm on pubnet reports an untrusted deployment", async () => {
    // The TESTNET trusted deployment's id: trust on testnet must not carry over to pubnet.
    const contractId = TRUSTED_ESCROWS["stellar:testnet"]![0]!;
    const buyer = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    const payee = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV6OJP7TQSLX";
    const signed = sign(
      {
        rail: "escrow:receptum-soroban",
        network: "stellar:pubnet",
        asset: PUBNET_USDC_SAC,
        amount: "1000",
        reference: `stellar:pubnet:${contractId}:1`,
        payer: `stellar:pubnet:${buyer}`,
        payee: `stellar:pubnet:${payee}`,
      },
      { mode: "buyer", reviewWindowSeconds: 600 },
    );
    const networks: string[] = [];
    vi.spyOn(SorobanRpcClient.prototype, "contractWasmHash").mockImplementation(async function (
      this: SorobanRpcClient,
    ) {
      networks.push(this.network.caip2);
      return RECEPTUM_SOROBAN_WASM_HASH;
    });
    vi.spyOn(SorobanRpcClient.prototype, "readEscrow").mockResolvedValue({
      buyer,
      seller: payee,
      token: PUBNET_USDC_SAC,
      amount: 1000n,
      deliverBy: 1,
      reviewWindowSeconds: 600,
      deliveredAt: 2,
      status: "released",
      receiptHash: signed.receiptHash,
    });
    const r = await verify(signed, { file, allowUnbound: true });
    expect(networks).toEqual(["stellar:pubnet"]);
    expect(r.checks.find((c) => c.name === "Payment on stellar:pubnet")).toMatchObject({
      status: "pending",
      detail: expect.stringMatching(/^untrusted deployment: no ReceptumEscrow wasm deployment/),
    });
  });

  it("Soroban: refuses a reference on another network than the receipt", async () => {
    const contractId = TRUSTED_ESCROWS["stellar:testnet"]![0]!;
    const signed = sign({
      rail: "escrow:receptum-soroban",
      network: "stellar:pubnet",
      asset: PUBNET_USDC_SAC,
      amount: "1000",
      reference: `stellar:testnet:${contractId}:1`,
    });
    const r = await verify(signed, { file, allowUnbound: true });
    expect(r.checks.find((c) => c.name === "Payment on stellar:pubnet")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/is on stellar:testnet/),
    });
  });
});

describe("CLI header", () => {
  it(
    "prints the mainnet/testnet label first (offline, built CLI)",
    { timeout: 30_000 },
    async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const cli = new URL("../dist/cli.js", import.meta.url).pathname;
      const dir = mkdtempSync(join(tmpdir(), "receptum-cli-"));
      try {
        const run = (network: string) => {
          const path = join(dir, `${network.replace(/:/g, "-")}.json`);
          writeFileSync(
            path,
            JSON.stringify(
              sign({ rail: "x402:exact", network, asset: USDC, amount: "1", reference: TX }),
            ),
          );
          return spawnSync(process.execPath, [cli, path, "--offline"], { encoding: "utf8" }).stdout;
        };
        expect(run("eip155:8453").split("\n")[0]).toBe(
          "=== MAINNET receipt (eip155:8453) — real funds ===",
        );
        expect(run("eip155:84532").split("\n")[0]).toMatch(/^=== TESTNET receipt \(eip155:84532\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
