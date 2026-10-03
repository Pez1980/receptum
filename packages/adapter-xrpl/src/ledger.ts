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

const resultCode = (meta: unknown): string | undefined =>
  (meta as { TransactionResult?: string } | null)?.TransactionResult;

const succeeded = (meta: unknown): meta is TransactionMetadata => resultCode(meta) === "tesSUCCESS";

/** Autofills, signs, submits and waits for validation; throws unless tesSUCCESS. */
export async function submit(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction,
): Promise<LedgerTx> {
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
    };
  } catch (err) {
    if (errorCode(err) === "txnNotFound") return null;
    throw err;
  }
}

/** Validated, successful transactions affecting `account`, newest first. */
export async function* accountTxs(
  client: Client,
  account: string,
  maxPages: number,
): AsyncGenerator<LedgerTx> {
  let marker: unknown;
  for (let page = 0; page < maxPages; page++) {
    const { result } = await client.request({
      command: "account_tx",
      account,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 200,
      ...(marker ? { marker } : {}),
    });
    for (const t of result.transactions) {
      if (!t.validated || !t.tx_json || !t.hash || !succeeded(t.meta)) continue;
      const closeTime = (t as { close_time_iso?: string }).close_time_iso;
      yield {
        hash: t.hash,
        tx: t.tx_json as LedgerTx["tx"],
        meta: t.meta,
        ...(closeTime ? { closeTime } : {}),
      };
    }
    marker = result.marker;
    if (!marker) return;
  }
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
