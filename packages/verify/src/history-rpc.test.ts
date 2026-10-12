// History RPC fallback (EVM_HISTORY_RPCS): when the primary RPC doesn't know a transaction, the
// lookup is retried on the network's history RPCs — used only when they serve the CAIP-2 chain id
// and return that same transaction. Every RPC is mocked (global fetch keyed by URL).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
import { anchorCalldata, EVM_HISTORY_RPCS } from "@receptum/adapter-evm";
import { pad, toHex } from "viem";
import { verify } from "./index.js";
import { TRANSFER_TOPIC } from "./evm-transfer.js";

const ARC = "eip155:5042002";
const ARC_CHAIN = "0x4cef52";
const PRIMARY = "https://rpc.testnet.arc.network"; // viem's default for arcTestnet
const [DRPC, DRPC_ORG] = EVM_HISTORY_RPCS[ARC] as readonly [string, string];
const USDC = "0x3600000000000000000000000000000000000000";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;
const ANCHOR_TX = `0x${"a5".repeat(32)}`;

const seller = generateSellerKey();
const file = new TextEncoder().encode("delivered bytes");
const signed = signReceipt(
  createReceipt({
    jobId: "j",
    seller: { id: seller.did },
    inputSha256: [sha256Hex("source")],
    outputSha256: sha256Hex(file),
    payment: {
      rail: "x402:exact",
      network: ARC,
      asset: USDC,
      amount: "250000",
      reference: TX,
      payer: `${ARC}:${PAYER}`,
      payee: `${ARC}:${PAYEE}`,
    },
  }),
  seller,
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handlers = Record<string, (params: unknown[]) => unknown>;

/** A JSON-RPC fetch stub per URL; an unknown URL is a network error. Returns the calls made. */
function stubRpcs(byUrl: Record<string, Handlers>) {
  const calls: string[] = [];
  // viem normalises URLs (`https://host` → `https://host/`): compare normalised hrefs.
  const href = (u: string) => new URL(u).href;
  const nodes = new Map(Object.entries(byUrl).map(([u, h]) => [href(u), { url: u, h }]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const found = nodes.get(href(String(url)));
      if (!found) throw new TypeError(`fetch failed: ${String(url)}`);
      const handlers = found.h;
      const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push(`${found.url} ${body.method}`);
      const h = handlers[body.method];
      const out = h
        ? { jsonrpc: "2.0", id: body.id, result: h(body.params) }
        : { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: body.method } };
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const txFields = (hash: string, input: string) => ({
  accessList: [],
  blockHash: `0x${"cd".repeat(32)}`,
  blockNumber: "0x3e4a8fc",
  chainId: ARC_CHAIN,
  from: PAYEE,
  gas: "0x5208",
  gasPrice: "0x1",
  hash,
  input,
  maxFeePerGas: "0x1",
  maxPriorityFeePerGas: "0x1",
  nonce: "0x0",
  r: "0x1",
  s: "0x1",
  to: PAYEE,
  transactionIndex: "0x0",
  type: "0x2",
  v: "0x0",
  value: "0x0",
  yParity: "0x0",
});

const receiptFields = (hash: string, logs: unknown[] = []) => ({
  blockHash: `0x${"cd".repeat(32)}`,
  blockNumber: "0x3e4a8fc",
  contractAddress: null,
  cumulativeGasUsed: "0x1",
  effectiveGasPrice: "0x1",
  from: PAYER,
  gasUsed: "0x1",
  logs,
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  to: USDC,
  transactionHash: hash,
  transactionIndex: "0x0",
  type: "0x2",
});

const transfer = {
  address: USDC,
  topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAYEE)],
  data: pad(toHex(250000n)),
  blockHash: `0x${"cd".repeat(32)}`,
  blockNumber: "0x3e4a8fc",
  logIndex: "0x0",
  transactionHash: TX,
  transactionIndex: "0x0",
  removed: false,
};

/** A node that serves `chainId` and knows the settlement and anchor transactions given. */
function node(
  chainId: string,
  known: { anchor?: boolean; settlement?: boolean; anchorHash?: string } = {},
): Handlers {
  const anchorHash = known.anchorHash ?? ANCHOR_TX;
  return {
    eth_chainId: () => chainId,
    eth_getTransactionByHash: ([h]) =>
      h === ANCHOR_TX && known.anchor
        ? txFields(anchorHash, anchorCalldata(signed.receiptHash))
        : null,
    eth_getTransactionReceipt: ([h]) =>
      h === ANCHOR_TX && known.anchor
        ? receiptFields(anchorHash)
        : h === TX && known.settlement
          ? receiptFields(TX, [transfer])
          : null,
  };
}

const NOT_FOUND = { status: "fail", detail: "transaction not found or not mined" };
const run = () => verify(signed, { file, anchors: [`${ARC}:${ANCHOR_TX}`], allowUnbound: true });
const anchorOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.checks.find((c) => c.name === `Anchor on ${ARC}`);
const paymentOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.checks.find((c) => c.name === `Payment on ${ARC}`);

describe("EVM history RPC fallback (Arc testnet)", () => {
  it("lists the dRPC endpoints for Arc testnet, in order", () => {
    expect(EVM_HISTORY_RPCS[ARC]).toEqual([
      "https://rpc.drpc.testnet.arc.network",
      "https://arc-testnet.drpc.org",
    ]);
  });

  it("primary doesn't know the transactions, a history RPC does: pass", async () => {
    const calls = stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node(ARC_CHAIN, { anchor: true, settlement: true }),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/via history RPC rpc\.drpc\.testnet\.arc\.network/),
    });
    expect(paymentOf(r)).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/via history RPC rpc\.drpc\.testnet\.arc\.network/),
    });
    expect(r.verdict).toBe("VERIFIED");
    expect(calls).toContain(`${DRPC} eth_chainId`);
    expect(calls.some((c) => c.startsWith(DRPC_ORG))).toBe(false);
  });

  it("ignores a history RPC that serves another chain", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node("0x14a34", { anchor: true, settlement: true }), // Base Sepolia
      [DRPC_ORG]: node(ARC_CHAIN),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
    expect(r.verdict).toBe("NOT VERIFIED");
  });

  it("moves on to the next history RPC after a wrong chain or a network error", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node("0x1", { anchor: true, settlement: true }),
      [DRPC_ORG]: node(ARC_CHAIN, { anchor: true, settlement: true }),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/via history RPC arc-testnet\.drpc\.org/),
    });
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      // DRPC unreachable (no handler: fetch throws)
      [DRPC_ORG]: node(ARC_CHAIN, { anchor: true, settlement: true }),
    });
    expect(anchorOf(await run())).toMatchObject({ status: "pass" });
  });

  it("ignores a history RPC that answers with another transaction", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node(ARC_CHAIN, { anchor: true, anchorHash: `0x${"ee".repeat(32)}` }),
      [DRPC_ORG]: node(ARC_CHAIN),
    });
    expect(anchorOf(await run())).toMatchObject(NOT_FOUND);
  });

  it("still fails when no RPC knows the transaction", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node(ARC_CHAIN),
      [DRPC_ORG]: node(ARC_CHAIN),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
    expect(r.verdict).toBe("NOT VERIFIED");
  });

  it("never asks a history RPC when the primary knows the transaction", async () => {
    const wrong = node(ARC_CHAIN, { settlement: true });
    const calls = stubRpcs({
      [PRIMARY]: {
        ...wrong,
        // The primary knows the anchor transaction, with other calldata: that answer stands.
        eth_getTransactionByHash: ([h]) => (h === ANCHOR_TX ? txFields(ANCHOR_TX, "0x") : null),
        eth_getTransactionReceipt: ([h]) =>
          h === ANCHOR_TX ? receiptFields(ANCHOR_TX) : receiptFields(TX, [transfer]),
      },
      [DRPC]: node(ARC_CHAIN, { anchor: true, settlement: true }),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "fail",
      detail: "anchor calldata is not utf8('receptum/1') ‖ receiptHash",
    });
    expect(paymentOf(r)).toMatchObject({ status: "pass" });
    expect(calls.some((c) => c.startsWith(DRPC))).toBe(false);
  });

  it("keeps an unavailable primary unavailable (no fallback for errors other than not found)", async () => {
    const calls = stubRpcs({
      [PRIMARY]: { eth_chainId: () => "0x14a34" }, // primary serves the wrong chain
      [DRPC]: node(ARC_CHAIN, { anchor: true, settlement: true }),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "unavailable",
      detail: expect.stringMatching(/serves chain 84532/),
    });
    expect(calls.some((c) => c.startsWith(DRPC))).toBe(false);
  });
});
