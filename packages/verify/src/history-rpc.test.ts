// History RPCs (EVM_HISTORY_RPCS) are only locators: when the primary RPC's transaction index
// doesn't know a hash, a history RPC on the right chain may say which block holds it, and the
// block and its receipts are then read from the PRIMARY RPC — every checked field is the
// primary's. Every RPC is mocked (global fetch keyed by URL).
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
const BLOCK_NO = "0x3e4abfc"; // 65317884
const BLOCK_HASH = `0x${"2a".repeat(32)}`;
const OTHER_HASH = `0x${"ee".repeat(32)}`;

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
      const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      calls.push(`${found.url} ${body.method}`);
      const h = found.h[body.method];
      const out = h
        ? { jsonrpc: "2.0", id: body.id, result: h(body.params) }
        : { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: body.method } };
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const txFields = (hash: string, input: string, over: Record<string, unknown> = {}) => ({
  accessList: [],
  blockHash: BLOCK_HASH,
  blockNumber: BLOCK_NO,
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
  ...over,
});

const receiptFields = (hash: string, logs: unknown[] = [], over: Record<string, unknown> = {}) => ({
  blockHash: BLOCK_HASH,
  blockNumber: BLOCK_NO,
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
  ...over,
});

const transfer = (amount = 250000n) => ({
  address: USDC,
  topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAYEE)],
  data: pad(toHex(amount)),
  blockHash: BLOCK_HASH,
  blockNumber: BLOCK_NO,
  logIndex: "0x0",
  transactionHash: TX,
  transactionIndex: "0x0",
  removed: false,
});

const blockFields = (hash: string, transactions: unknown[]) => ({
  baseFeePerGas: "0x1",
  difficulty: "0x0",
  extraData: "0x",
  gasLimit: "0x1",
  gasUsed: "0x1",
  hash,
  logsBloom: `0x${"00".repeat(256)}`,
  miner: PAYEE,
  mixHash: hash,
  nonce: "0x0000000000000000",
  number: BLOCK_NO,
  parentHash: hash,
  receiptsRoot: hash,
  sha3Uncles: hash,
  size: "0x1",
  stateRoot: hash,
  timestamp: "0x6a1f5e40",
  totalDifficulty: "0x0",
  transactions,
  transactionsRoot: hash,
  uncles: [],
});

interface View {
  chainId?: string;
  /** Answers eth_getTransactionByHash / eth_getTransactionReceipt for the two hashes. */
  index?: boolean;
  /** Serves block BLOCK_NO (with transactions) and its receipts. */
  blocks?: boolean;
  /** This node's hash for block BLOCK_NO. */
  blockHash?: string;
  /** Block BLOCK_NO without the anchor transaction. */
  withoutAnchor?: boolean;
  anchorTx?: Record<string, unknown>;
  anchorReceipt?: Record<string, unknown>;
  settlementReceipt?: Record<string, unknown>;
}

/** One node's view of the chain: block BLOCK_NO holds the settlement and the anchor transaction. */
function node(v: View = {}): Handlers {
  const blockHash = v.blockHash ?? BLOCK_HASH;
  const inBlock = { blockHash, blockNumber: BLOCK_NO };
  const txs = [
    txFields(TX, "0x", { ...inBlock, to: USDC }),
    ...(v.withoutAnchor
      ? []
      : [txFields(ANCHOR_TX, anchorCalldata(signed.receiptHash), { ...inBlock, ...v.anchorTx })]),
  ];
  const receipts = [
    receiptFields(TX, [{ ...transfer(), blockHash }], { ...inBlock, ...v.settlementReceipt }),
    ...(v.withoutAnchor ? [] : [receiptFields(ANCHOR_TX, [], { ...inBlock, ...v.anchorReceipt })]),
  ];
  return {
    eth_chainId: () => v.chainId ?? ARC_CHAIN,
    eth_getTransactionByHash: ([h]) => (v.index ? (txs.find((t) => t.hash === h) ?? null) : null),
    eth_getTransactionReceipt: ([h]) =>
      v.index ? (receipts.find((r) => r.transactionHash === h) ?? null) : null,
    eth_getBlockByNumber: ([n]) =>
      v.blocks && n === BLOCK_NO ? blockFields(blockHash, txs) : null,
    eth_getBlockReceipts: ([n]) => (v.blocks && n === BLOCK_NO ? receipts : null),
  };
}

/** The usual case: the primary serves the block but its transaction index lost the hashes. */
const prunedPrimary = (v: View = {}) => node({ blocks: true, ...v });
const historyNode = (v: View = {}) => node({ index: true, ...v });

const NOT_FOUND = { status: "fail", detail: "transaction not found or not mined" };
const run = () => verify(signed, { file, anchors: [`${ARC}:${ANCHOR_TX}`], allowUnbound: true });
const anchorOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.checks.find((c) => c.name === `Anchor on ${ARC}`);
const paymentOf = (r: Awaited<ReturnType<typeof run>>) =>
  r.checks.find((c) => c.name === `Payment on ${ARC}`);
const LOCATED_BY_DRPC = expect.stringMatching(
  /block located via history RPC rpc\.drpc\.testnet\.arc\.network/,
);

describe("EVM history RPCs are only locators (Arc testnet)", () => {
  it("lists the dRPC endpoints for Arc testnet, in order", () => {
    expect(EVM_HISTORY_RPCS[ARC]).toEqual([
      "https://rpc.drpc.testnet.arc.network",
      "https://arc-testnet.drpc.org",
    ]);
  });

  it("honest history RPC + the primary's block: pass, with the primary's data", async () => {
    const calls = stubRpcs({ [PRIMARY]: prunedPrimary(), [DRPC]: historyNode() });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({ status: "pass", detail: LOCATED_BY_DRPC });
    expect(paymentOf(r)).toMatchObject({ status: "pass", detail: LOCATED_BY_DRPC });
    expect(r.verdict).toBe("VERIFIED");
    // The history RPC is asked for the receipt (the locator) only; block data is the primary's.
    expect(calls.filter((c) => c.startsWith(DRPC)).map((c) => c.split(" ")[1])).toEqual(
      expect.arrayContaining(["eth_chainId", "eth_getTransactionReceipt"]),
    );
    expect(calls.some((c) => c.startsWith(DRPC) && /getBlock/.test(c))).toBe(false);
    expect(calls).toContain(`${PRIMARY} eth_getBlockByNumber`);
    expect(calls).toContain(`${PRIMARY} eth_getBlockReceipts`);
    expect(calls.some((c) => c.startsWith(DRPC_ORG))).toBe(false);
  });

  it("never takes checked fields from the history RPC", async () => {
    // The history RPC's own view would pass; the primary's block says otherwise.
    stubRpcs({
      [PRIMARY]: prunedPrimary({
        anchorTx: { input: "0x" },
        settlementReceipt: { logs: [{ ...transfer(1n) }] },
      }),
      [DRPC]: historyNode(),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "fail",
      detail: "anchor calldata is not utf8('receptum/1') ‖ receiptHash",
    });
    expect(paymentOf(r)).toMatchObject({
      status: "fail",
      detail: "no transfer of that amount to the payee in the settlement transaction",
    });
    stubRpcs({
      [PRIMARY]: prunedPrimary({ anchorReceipt: { status: "0x0" } }),
      [DRPC]: historyNode(),
    });
    expect(anchorOf(await run())).toMatchObject({
      status: "fail",
      detail: "anchor transaction reverted",
    });
  });

  it("rejects a history RPC whose block hash differs from the primary's", async () => {
    stubRpcs({
      [PRIMARY]: prunedPrimary(),
      [DRPC]: historyNode({ blockHash: OTHER_HASH }),
      [DRPC_ORG]: historyNode({ blockHash: OTHER_HASH }),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
    expect(r.verdict).toBe("NOT VERIFIED");
  });

  it("rejects a located block that doesn't hold the transaction on the primary", async () => {
    stubRpcs({
      [PRIMARY]: prunedPrimary({ withoutAnchor: true }),
      [DRPC]: historyNode(),
      [DRPC_ORG]: historyNode(),
    });
    expect(anchorOf(await run())).toMatchObject(NOT_FOUND);
  });

  it("stays not found when the primary doesn't serve the located block", async () => {
    stubRpcs({ [PRIMARY]: node(), [DRPC]: historyNode(), [DRPC_ORG]: historyNode() });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
  });

  it("ignores a history RPC that serves another chain", async () => {
    stubRpcs({
      [PRIMARY]: prunedPrimary(),
      [DRPC]: historyNode({ chainId: "0x14a34" }), // Base Sepolia
      [DRPC_ORG]: node(),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
  });

  it("moves on to the next history RPC after a wrong chain, a lie or a network error", async () => {
    stubRpcs({
      [PRIMARY]: prunedPrimary(),
      [DRPC]: historyNode({ chainId: "0x1" }),
      [DRPC_ORG]: historyNode(),
    });
    expect(anchorOf(await run())).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/block located via history RPC arc-testnet\.drpc\.org/),
    });
    stubRpcs({
      [PRIMARY]: prunedPrimary(),
      [DRPC]: historyNode({ blockHash: OTHER_HASH }),
      [DRPC_ORG]: historyNode(),
    });
    expect(anchorOf(await run())).toMatchObject({ status: "pass" });
    stubRpcs({ [PRIMARY]: prunedPrimary(), [DRPC_ORG]: historyNode() }); // DRPC unreachable
    expect(anchorOf(await run())).toMatchObject({ status: "pass" });
  });

  it("still fails when no RPC knows the transaction", async () => {
    stubRpcs({ [PRIMARY]: prunedPrimary(), [DRPC]: node(), [DRPC_ORG]: node() });
    const r = await run();
    expect(anchorOf(r)).toMatchObject(NOT_FOUND);
    expect(paymentOf(r)).toMatchObject(NOT_FOUND);
    expect(r.verdict).toBe("NOT VERIFIED");
  });

  it("never asks a history RPC when the primary's index knows the transaction", async () => {
    const calls = stubRpcs({
      [PRIMARY]: node({ index: true, anchorTx: { input: "0x" } }),
      [DRPC]: historyNode(),
    });
    const r = await run();
    expect(anchorOf(r)).toMatchObject({
      status: "fail",
      detail: "anchor calldata is not utf8('receptum/1') ‖ receiptHash",
    });
    expect(paymentOf(r)).toMatchObject({ status: "pass" });
    expect(calls.some((c) => c.startsWith(DRPC))).toBe(false);
  });

  it("keeps a primary on the wrong chain unavailable, without asking history RPCs", async () => {
    const calls = stubRpcs({
      [PRIMARY]: prunedPrimary({ chainId: "0x14a34" }),
      [DRPC]: historyNode(),
    });
    expect(anchorOf(await run())).toMatchObject({
      status: "unavailable",
      detail: expect.stringMatching(/serves chain 84532/),
    });
    expect(calls.some((c) => c.startsWith(DRPC))).toBe(false);
  });
});
