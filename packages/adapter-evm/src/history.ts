import {
  createPublicClient,
  http,
  type Block,
  type Chain,
  type Hex,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from "viem";

/**
 * History RPCs per network (CAIP-2), tried in order when the primary RPC's transaction index
 * does not know a transaction. Some public RPCs prune that index: since October 2026 Arc
 * testnet's own endpoints (`rpc.testnet.arc.network` — viem's default — its QuickNode and
 * Blockdaemon mirrors, and `rpc.testnet.arc.io`) answer `null` for older transaction hashes,
 * although they still serve the blocks and block receipts; dRPC still indexes them. History RPCs
 * are only locators (`locateWithHistory`). The Python verifier (`HISTORY_RPCS`) and the browser
 * verifier (`EVM_HISTORY_RPCS`) use the same list.
 */
export const EVM_HISTORY_RPCS: Readonly<Record<string, readonly string[]>> = {
  "eip155:5042002": ["https://rpc.drpc.testnet.arc.network", "https://arc-testnet.drpc.org"],
};

/** viem's errors for a `null` `eth_getTransactionByHash` / `eth_getTransactionReceipt`. */
export function isTransactionNotFound(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TransactionNotFoundError" || name === "TransactionReceiptNotFoundError";
}

export interface HistoryLookupOptions {
  /** History RPCs to try, in order (default: `EVM_HISTORY_RPCS[network.caip2]`). */
  historyRpcs?: readonly string[];
}

/** A mined transaction and its receipt, both read from the primary RPC. */
export interface MinedTransaction {
  transaction: Transaction;
  receipt: TransactionReceipt;
  /**
   * Set when the primary's transaction index did not know the hash: the history RPC that located
   * the block. Every field of `transaction` and `receipt` still comes from the primary RPC.
   */
  locatedBy?: string;
}

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Finds transaction `hash` in `primary`'s blocks with the help of the network's history RPCs.
 * Trust model (SPEC §7.3): a history RPC is only a locator. It must report the chain id of the
 * network's CAIP-2 reference, and its receipt for `hash` gives a block number and block hash —
 * nothing else from it is used. The block (with its transactions) and the block's receipts are
 * then read from `primary`; the primary's block hash must equal the located one and the
 * transaction must be in that block, and the transaction and receipt returned are the primary's.
 * A history RPC on another chain, failing, not knowing the hash, or pointing at a block the
 * primary does not serve or that does not hold the transaction leads nowhere, and the next one is
 * tried. Returns null when none leads to the transaction on the primary.
 */
export async function locateWithHistory(
  network: { caip2: string; chain: Chain },
  primary: PublicClient,
  hash: Hex,
  options: HistoryLookupOptions = {},
): Promise<(Required<MinedTransaction> & { block: Block }) | null> {
  const want = Number(network.caip2.slice("eip155:".length));
  for (const url of options.historyRpcs ?? EVM_HISTORY_RPCS[network.caip2] ?? []) {
    let located: { blockNumber: bigint; blockHash: Hex };
    try {
      const history = createPublicClient({
        chain: network.chain,
        transport: http(url, { retryCount: 1 }),
      }) as PublicClient;
      if ((await history.getChainId()) !== want) continue;
      const pointer = await history.getTransactionReceipt({ hash });
      if (!same(pointer.transactionHash, hash) || typeof pointer.blockNumber !== "bigint") continue;
      if (typeof pointer.blockHash !== "string") continue;
      located = { blockNumber: pointer.blockNumber, blockHash: pointer.blockHash };
    } catch {
      continue; // This history RPC can't locate it: try the next one.
    }
    try {
      // From here on, only the primary RPC's data is used.
      const block = await primary.getBlock({
        blockNumber: located.blockNumber,
        includeTransactions: true,
      });
      if (!same(block.hash, located.blockHash)) continue;
      const transaction = (block.transactions as readonly (Transaction | Hex)[]).find(
        (t): t is Transaction => typeof t === "object" && same(t.hash, hash),
      );
      if (!transaction) continue;
      const receipts = await primary.getBlockReceipts({ blockNumber: located.blockNumber });
      const receipt = receipts.find((r) => same(r.transactionHash, hash));
      if (!receipt || !same(receipt.blockHash, located.blockHash)) continue;
      return { transaction, receipt, block: block as Block, locatedBy: url };
    } catch {
      continue; // The primary doesn't serve that block: not confirmed.
    }
  }
  return null;
}

/**
 * Transaction `hash` and its receipt from `primary`. Only when the primary's transaction index
 * does not know the hash (viem's not-found errors) are the network's history RPCs used, as
 * locators (`locateWithHistory`); when they don't lead to the transaction on the primary either,
 * the primary's not-found error is rethrown. Other errors are rethrown unchanged.
 */
export async function getMinedTransaction(
  network: { caip2: string; chain: Chain },
  primary: PublicClient,
  hash: Hex,
  options: HistoryLookupOptions = {},
): Promise<MinedTransaction> {
  try {
    const transaction = await primary.getTransaction({ hash });
    const receipt = await primary.getTransactionReceipt({ hash });
    return { transaction, receipt };
  } catch (err) {
    if (!isTransactionNotFound(err)) throw err;
    const found = await locateWithHistory(network, primary, hash, options);
    if (!found) throw err;
    return { transaction: found.transaction, receipt: found.receipt, locatedBy: found.locatedBy };
  }
}

/** The receipt of `hash` from `primary`, with the same history-RPC rule as `getMinedTransaction`. */
export async function getMinedReceipt(
  network: { caip2: string; chain: Chain },
  primary: PublicClient,
  hash: Hex,
  options: HistoryLookupOptions = {},
): Promise<{ receipt: TransactionReceipt; locatedBy?: string }> {
  try {
    return { receipt: await primary.getTransactionReceipt({ hash }) };
  } catch (err) {
    if (!isTransactionNotFound(err)) throw err;
    const found = await locateWithHistory(network, primary, hash, options);
    if (!found) throw err;
    return { receipt: found.receipt, locatedBy: found.locatedBy };
  }
}
