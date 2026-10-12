import { createPublicClient, http, type Chain, type PublicClient } from "viem";

/**
 * History RPCs per network (CAIP-2), tried in order when the primary RPC does not know a
 * transaction. Some public RPCs prune old transactions: since October 2026 Arc testnet's own
 * endpoints (`rpc.testnet.arc.network` — viem's default — its QuickNode and Blockdaemon mirrors,
 * and `rpc.testnet.arc.io`) answer `null` for older transactions, while dRPC still serves them.
 * The Python verifier (`HISTORY_RPCS`) and the browser verifier (`EVM_HISTORY_RPCS`) use the
 * same list.
 */
export const EVM_HISTORY_RPCS: Readonly<Record<string, readonly string[]>> = {
  "eip155:5042002": ["https://rpc.drpc.testnet.arc.network", "https://arc-testnet.drpc.org"],
};

/** viem's errors for a `null` `eth_getTransactionByHash` / `eth_getTransactionReceipt`. */
export function isTransactionNotFound(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TransactionNotFoundError" || name === "TransactionReceiptNotFoundError";
}

export interface HistoryLookup<T> {
  value: T;
  /** The history RPC that answered, when the primary RPC did not know the transaction. */
  historyRpc?: string;
}

export interface HistoryLookupOptions {
  /** History RPCs to try, in order (default: `EVM_HISTORY_RPCS[network.caip2]`). */
  historyRpcs?: readonly string[];
}

/**
 * Runs `lookup` on `primary`; only when that RPC does not know the transaction (viem's
 * not-found errors) is it retried on the network's history RPCs, in order. SPEC §7.3: a history
 * RPC's answer is used only when the RPC reports the chain id of the network's CAIP-2 reference
 * and every hash in `hashesOf(answer)` is `hash`. A history RPC that serves another chain,
 * errors, does not know the transaction either, or answers for another transaction is ignored.
 * When none finds it, the primary's not-found error is rethrown: a fallback can turn "not found"
 * into an answer only by returning that same transaction from that same chain. Any other error
 * from the primary is rethrown unchanged.
 */
export async function lookupWithHistory<T>(
  network: { caip2: string; chain: Chain },
  primary: PublicClient,
  hash: string,
  lookup: (client: PublicClient) => Promise<T>,
  hashesOf: (value: T) => readonly (string | null | undefined)[],
  options: HistoryLookupOptions = {},
): Promise<HistoryLookup<T>> {
  try {
    return { value: await lookup(primary) };
  } catch (err) {
    if (!isTransactionNotFound(err)) throw err;
    const want = Number(network.caip2.slice("eip155:".length));
    const same = (h: string | null | undefined) =>
      typeof h === "string" && h.toLowerCase() === hash.toLowerCase();
    for (const url of options.historyRpcs ?? EVM_HISTORY_RPCS[network.caip2] ?? []) {
      try {
        const client = createPublicClient({
          chain: network.chain,
          transport: http(url, { retryCount: 1 }),
        }) as PublicClient;
        if ((await client.getChainId()) !== want) continue;
        const value = await lookup(client);
        const hashes = hashesOf(value);
        if (hashes.length > 0 && hashes.every(same)) return { value, historyRpc: url };
      } catch {
        // This history RPC can't answer: try the next one.
      }
    }
    throw err;
  }
}
