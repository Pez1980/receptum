import type { Client, Memo, SubmittableTransaction, TransactionMetadata, Wallet } from "xrpl";

/** CAIP-2 ids of the public XRPL networks (by NetworkID). */
export const XRPL_TESTNET = "xrpl:1";

/** A validated transaction as seen through `tx` / `account_tx` (API v2). */
export interface LedgerTx {
  hash: string;
  tx: {
    TransactionType: string;
    Account: string;
    Memos?: Memo[];
    Owner?: string;
    OfferSequence?: number;
    Sequence?: number;
    TicketSequence?: number;
  };
  meta: TransactionMetadata;
  closeTime?: string;
  /** Validated ledger index; with `meta.TransactionIndex`, the canonical order of history. */
  ledgerIndex?: number;
}

/** Orders two validated transactions by (ledger index, transaction index). */
export function compareTx(a: LedgerTx, b: LedgerTx): number {
  const la = a.ledgerIndex ?? 0;
  const lb = b.ledgerIndex ?? 0;
  if (la !== lb) return la - lb;
  return (a.meta.TransactionIndex ?? 0) - (b.meta.TransactionIndex ?? 0);
}

export class XrplTxError extends Error {
  constructor(
    readonly code: string,
    readonly hash?: string,
  ) {
    super(`XRPL transaction failed: ${code}${hash ? ` (${hash})` : ""}`);
    this.name = "XrplTxError";
  }
}

/**
 * The ledger history needed to decide could not be read in full: the `account_tx` page limit
 * was reached with a `marker` remaining, or the server's history does not reach back far
 * enough. Absence of evidence in an incomplete history proves nothing, so verifiers report this
 * as `unavailable` — never as a failure and never as a pass.
 */
export class XrplHistoryIncompleteError extends Error {
  constructor(message: string) {
    super(`XRPL history incomplete: ${message}`);
    this.name = "XrplHistoryIncompleteError";
  }
}

/** Does this transaction create `account`'s AccountRoot (the start of its history)? */
export function createsAccount(t: LedgerTx, account: string): boolean {
  return t.meta.AffectedNodes.some(
    (n) =>
      "CreatedNode" in n &&
      n.CreatedNode.LedgerEntryType === "AccountRoot" &&
      (n.CreatedNode.NewFields as { Account?: string } | undefined)?.Account === account,
  );
}

/** Does `account` exist in the validated ledger? */
export async function accountExists(client: Client, account: string): Promise<boolean> {
  try {
    await client.request({ command: "account_info", account, ledger_index: "validated" });
    return true;
  } catch (err) {
    if (errorCode(err) === "actNotFound") return false;
    throw err;
  }
}

const resultCode = (meta: unknown): string | undefined =>
  (meta as { TransactionResult?: string } | null)?.TransactionResult;

const succeeded = (meta: unknown): meta is TransactionMetadata => resultCode(meta) === "tesSUCCESS";

/** Autofills, signs, submits and waits for validation; throws unless tesSUCCESS. */
/** XRPL testnet's NetworkID. Signing is refused on any other network. */
export const XRPL_TESTNET_NETWORK_ID = 1;

/** Throws unless the connected server reports XRPL testnet. Checked before every signature. */
export async function assertTestnet(client: Client): Promise<void> {
  const info = await client.request({ command: "server_info" });
  const id = (info.result.info as { network_id?: number }).network_id;
  if (id !== XRPL_TESTNET_NETWORK_ID) {
    throw new Error(
      `refusing to sign: connected XRPL server reports NetworkID ${id ?? "none"}, expected testnet (1)`,
    );
  }
}

export async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<LedgerTx> {
  await assertTestnet(client);
  const res = await client.submitAndWait(tx, { wallet, autofill: true });
  const { meta, hash, tx_json, close_time_iso } = res.result;
  if (!succeeded(meta)) throw new XrplTxError(resultCode(meta) ?? "unknown", hash);
  return {
    hash,
    tx: tx_json as LedgerTx["tx"],
    meta,
    ...(close_time_iso ? { closeTime: close_time_iso } : {}),
  };
}

/** A validated, successful transaction by hash, or null. */
export async function getTx(client: Client, hash: string): Promise<LedgerTx | null> {
  try {
    const { result } = await client.request({ command: "tx", transaction: hash });
    if (!result.validated || !succeeded(result.meta)) return null;
    return {
      hash: result.hash,
      tx: result.tx_json as LedgerTx["tx"],
      meta: result.meta,
      ...(result.close_time_iso ? { closeTime: result.close_time_iso } : {}),
      ...(typeof result.ledger_index === "number" ? { ledgerIndex: result.ledger_index } : {}),
    };
  } catch (err) {
    if (errorCode(err) === "txnNotFound") return null;
    throw err;
  }
}

/**
 * Validated, successful transactions affecting `account`, newest first — or oldest first from
 * `fromLedger` when `forward` is set (chronological history). Consumers may stop early once
 * they have decisive evidence; a scan that would need more than `maxPages` pages throws
 * `XrplHistoryIncompleteError` instead of ending as if the history were complete.
 */
export async function* accountTxs(
  client: Client,
  account: string,
  maxPages: number,
  options: { forward?: boolean; fromLedger?: number } = {},
): AsyncGenerator<LedgerTx> {
  let marker: unknown;
  for (let page = 0; page < maxPages; page++) {
    const { result } = await client.request({
      command: "account_tx",
      account,
      ledger_index_min: options.fromLedger ?? -1,
      ledger_index_max: -1,
      limit: 200,
      ...(options.forward ? { forward: true } : {}),
      ...(marker ? { marker } : {}),
    });
    for (const t of result.transactions) {
      if (!t.validated || !t.tx_json || !t.hash || !succeeded(t.meta)) continue;
      const closeTime = (t as { close_time_iso?: string }).close_time_iso;
      const ledgerIndex = (t as { ledger_index?: number }).ledger_index;
      yield {
        hash: t.hash,
        tx: t.tx_json as LedgerTx["tx"],
        meta: t.meta,
        ...(closeTime ? { closeTime } : {}),
        ...(typeof ledgerIndex === "number" ? { ledgerIndex } : {}),
      };
    }
    marker = result.marker;
    if (!marker) return;
  }
  throw new XrplHistoryIncompleteError(
    `account_tx for ${account} needs more than ${maxPages} page(s) (maxHistoryPages)`,
  );
}

/** Close time (Ripple epoch seconds) of the latest validated ledger. */
export async function validatedCloseTime(client: Client): Promise<number> {
  const { result } = await client.request({ command: "ledger", ledger_index: "validated" });
  return result.ledger.close_time;
}

export function errorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: string } } | null)?.data;
  return data?.error;
}
