// EvmAnchor.find / locateWithHistory: when the configured RPC's transaction index doesn't know a
// hash, a history RPC (EVM_HISTORY_RPCS) on the right chain may only locate the block, which is then
// read from the configured RPC. RPCs are mocked (global fetch keyed by URL); nothing is sent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { anchorCalldata, clientsFor, EVM_HISTORY_RPCS, EvmAnchor } from "./index.js";

// A public, well-known dev key (anvil #0). Nothing is ever signed or sent.
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const ARC = "eip155:5042002";
const ARC_CHAIN = "0x4cef52";
const PRIMARY = "https://rpc.testnet.arc.network"; // viem's default for arcTestnet
const [DRPC, DRPC_ORG] = EVM_HISTORY_RPCS[ARC] as readonly [string, string];
const H = "ab".repeat(32);
const TX = `0x${"a5".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handlers = Record<string, (params: unknown[]) => unknown>;

function stubRpcs(byUrl: Record<string, Handlers>) {
  const calls: string[] = [];
  const href = (u: string) => new URL(u).href; // viem normalises `https://host` → `https://host/`
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

const tx = (hash: string) => ({
  accessList: [],
  blockHash: BLOCK,
  blockNumber: "0x3e4abfc",
  chainId: ARC_CHAIN,
  from: account.address,
  gas: "0x5208",
  gasPrice: "0x1",
  hash,
  input: anchorCalldata(H),
  maxFeePerGas: "0x1",
  maxPriorityFeePerGas: "0x1",
  nonce: "0x0",
  r: "0x1",
  s: "0x1",
  to: account.address,
  transactionIndex: "0x0",
  type: "0x2",
  v: "0x0",
  value: "0x0",
  yParity: "0x0",
});

const block = {
  baseFeePerGas: "0x1",
  difficulty: "0x0",
  extraData: "0x",
  gasLimit: "0x1",
  gasUsed: "0x1",
  hash: BLOCK,
  logsBloom: `0x${"00".repeat(256)}`,
  miner: account.address,
  mixHash: BLOCK,
  nonce: "0x0000000000000000",
  number: "0x3e4abfc",
  parentHash: BLOCK,
  receiptsRoot: BLOCK,
  sha3Uncles: BLOCK,
  size: "0x1",
  stateRoot: BLOCK,
  timestamp: "0x6a1f5e40",
  totalDifficulty: "0x0",
  transactions: [],
  transactionsRoot: BLOCK,
  uncles: [],
};

const receipt = (hash: string, blockHash = BLOCK) => ({
  blockHash,
  blockNumber: "0x3e4abfc",
  contractAddress: null,
  cumulativeGasUsed: "0x1",
  effectiveGasPrice: "0x1",
  from: account.address,
  gasUsed: "0x1",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  to: account.address,
  transactionHash: hash,
  transactionIndex: "0x0",
  type: "0x2",
});

/**
 * One node: `index` = its transaction index knows TX (by hash); `blocks` = it serves block
 * 0x3e4abfc (holding TX unless `without`) and its receipts; `blockHash` = its hash for that block.
 */
const node = (
  chainId: string,
  o: { index?: boolean; blocks?: boolean; blockHash?: string; without?: boolean } = {},
): Handlers => {
  const blockHash = o.blockHash ?? BLOCK;
  const txs = o.without ? [] : [{ ...tx(TX), blockHash }];
  return {
    eth_chainId: () => chainId,
    eth_getTransactionByHash: ([h]) => (o.index && h === TX ? { ...tx(TX), blockHash } : null),
    eth_getTransactionReceipt: ([h]) => (o.index && h === TX ? receipt(TX, blockHash) : null),
    eth_getBlockByNumber: ([n]) =>
      o.blocks && n === "0x3e4abfc" ? { ...block, hash: blockHash, transactions: txs } : null,
    eth_getBlockReceipts: ([n]) =>
      o.blocks && n === "0x3e4abfc" ? txs.map((t) => receipt(t.hash, blockHash)) : null,
    eth_getBlockByHash: () => block,
  };
};

const find = () =>
  new EvmAnchor(clientsFor(ARC, account)).find(H, {
    reference: TX,
  });

describe("EvmAnchor.find with history RPCs as locators", () => {
  it("finds an anchor in the configured RPC's block, located by a history RPC", async () => {
    const calls = stubRpcs({
      [PRIMARY]: node(ARC_CHAIN, { blocks: true }),
      [DRPC]: node(ARC_CHAIN, { index: true }),
    });
    await expect(find()).resolves.toMatchObject({
      rail: "anchor:evm",
      network: ARC,
      reference: TX,
      anchoredAt: new Date(0x6a1f5e40 * 1000).toISOString(),
    });
    expect(calls).toEqual([
      `${PRIMARY} eth_getTransactionByHash`,
      `${DRPC} eth_chainId`,
      `${DRPC} eth_getTransactionReceipt`,
      `${PRIMARY} eth_getBlockByNumber`,
      `${PRIMARY} eth_getBlockReceipts`,
    ]);
  });

  it("rejects history RPCs on another chain, with another block hash, or a block without it", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN, { blocks: true }),
      [DRPC]: node("0x14a34", { index: true }),
      [DRPC_ORG]: node(ARC_CHAIN, { index: true, blockHash: `0x${"ee".repeat(32)}` }),
    });
    await expect(find()).rejects.toMatchObject({ name: "TransactionNotFoundError" });
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN, { blocks: true, without: true }),
      [DRPC]: node(ARC_CHAIN, { index: true }),
    });
    await expect(find()).rejects.toMatchObject({ name: "TransactionNotFoundError" });
  });

  it("rethrows the primary's not-found error when no RPC leads to the transaction", async () => {
    stubRpcs({
      [PRIMARY]: node(ARC_CHAIN),
      [DRPC]: node(ARC_CHAIN, { index: true }), // the primary doesn't serve the block
      [DRPC_ORG]: node(ARC_CHAIN),
    });
    await expect(find()).rejects.toMatchObject({ name: "TransactionNotFoundError" });
  });
});
