import type { ParsedInstruction, ParsedTransaction, TokenBalance } from "./rpc.js";

/**
 * SPEC §7.3, `x402:exact` on `solana:*`: does a successful transaction move exactly `amount` of
 * `mint` from the payer to the payee?
 *
 * Pass only when (1) `meta.err` is null; (2) one SPL Token (`spl-token` or `spl-token-2022`)
 * `transferChecked` instruction — top level or inner — has `mint`, `tokenAmount.amount` =
 * `amount`, a destination token account owned by the payee and, when a payer is given, a source
 * token account owned by the payer (owners read from the transaction's own pre/post token
 * balances by account index); and (3) the payee's net balance of `mint`, summed over every token
 * account the payee owns in the transaction (post − pre, by owner + mint), rose by exactly
 * `amount`.
 */
export interface SolanaTransferQuery {
  mint: string;
  amount: string;
  payee: string;
  payer?: string;
}

export type TransferMatch = { ok: true; detail: string } | { ok: false; reason: string };

const TOKEN_PROGRAMS = ["spl-token", "spl-token-2022"];

function ownerOf(tx: ParsedTransaction, account: string): { owner?: string; mint?: string } {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const i = keys.indexOf(account);
  if (i < 0) return {};
  const bal =
    tx.meta?.postTokenBalances?.find((b) => b.accountIndex === i) ??
    tx.meta?.preTokenBalances?.find((b) => b.accountIndex === i);
  return { ...(bal?.owner ? { owner: bal.owner } : {}), ...(bal?.mint ? { mint: bal.mint } : {}) };
}

function netChange(tx: ParsedTransaction, owner: string, mint: string): bigint {
  const sum = (list: TokenBalance[] | undefined) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  return [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions),
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function findTokenTransfer(tx: ParsedTransaction, q: SolanaTransferQuery): TransferMatch {
  if (!tx.meta) return { ok: false, reason: "transaction has no status metadata" };
  if (tx.meta.err !== null) return { ok: false, reason: "settlement transaction failed" };
  const match = allInstructions(tx).find((ix) => {
    if (!TOKEN_PROGRAMS.includes(ix.program ?? "") || !isRecord(ix.parsed)) return false;
    if (ix.parsed.type !== "transferChecked" || !isRecord(ix.parsed.info)) return false;
    const info = ix.parsed.info;
    const amt = isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined;
    if (info.mint !== q.mint || amt !== q.amount) return false;
    if (typeof info.destination !== "string" || typeof info.source !== "string") return false;
    const dest = ownerOf(tx, info.destination);
    if (dest.owner !== q.payee || dest.mint !== q.mint) return false;
    if (q.payer !== undefined) {
      const src = ownerOf(tx, info.source);
      if (src.owner !== q.payer) return false;
    }
    return true;
  });
  if (!match)
    return {
      ok: false,
      reason: `no transferChecked of ${q.amount} ${q.mint} ${q.payer ? `from ${q.payer} ` : ""}to ${q.payee} in the settlement transaction`,
    };
  const delta = netChange(tx, q.payee, q.mint);
  if (delta !== BigInt(q.amount))
    return {
      ok: false,
      reason: `the payee's ${q.mint} balance changed by ${delta}, not ${q.amount}`,
    };
  return { ok: true, detail: `${q.amount} base units of ${q.mint} paid to ${q.payee}` };
}
