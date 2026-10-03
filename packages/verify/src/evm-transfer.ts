/**
 * SPEC §7.3 (`x402:exact` on `eip155:*`): the ERC-20 `Transfer` log a settlement must emit.
 * Decoded by hand, with exact shape checks, so that every conforming verifier reads the same
 * log the same way: a generic ABI decoder may tolerate extra topics, extra or short data, or
 * dirty upper bytes in address topics, and two verifiers would then disagree.
 */

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;

export interface EvmLog {
  address: string;
  topics: readonly string[];
  data: string;
  removed?: boolean;
}

/** Lower-cased address from a 32-byte topic whose upper 12 bytes are zero, else null. */
const topicAddress = (topic: string | undefined) => {
  const m = typeof topic === "string" ? ADDRESS_WORD.exec(topic) : null;
  return m ? `0x${m[1]!.toLowerCase()}` : null;
};

/**
 * Is `log` an ERC-20 `Transfer(from, to, value)` from the token `asset` of exactly `amount` to
 * `payee` (and from `payer`, when given)? Requires: not removed; exactly three topics — the
 * selector, `from`, `to`, each address topic a 32-byte word with 12 zero upper bytes; and
 * `data` exactly one 32-byte word (`value`). Addresses compare case-insensitively.
 */
export function erc20TransferMatches(
  log: EvmLog,
  want: { asset: string; amount: string; payee: string; payer?: string | undefined },
): boolean {
  if (log.removed) return false;
  if (typeof log.address !== "string" || log.address.toLowerCase() !== want.asset.toLowerCase())
    return false;
  if (!Array.isArray(log.topics) || log.topics.length !== 3) return false;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return false;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (!from || !to) return false;
  if (typeof log.data !== "string" || !WORD.test(log.data)) return false;
  if (BigInt(log.data).toString() !== want.amount) return false;
  if (to !== want.payee.toLowerCase()) return false;
  return !want.payer || from === want.payer.toLowerCase();
}
