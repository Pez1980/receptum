import { fromStellarAmount } from "./codec.js";
import { HorizonClient, isNotFound, type HorizonOptions } from "./horizon.js";
import { tokenContractId } from "./soroban.js";

/** Horizon's `asset_balance_changes` entry on an `invoke_host_function` operation. */
export interface AssetBalanceChange {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  type: string;
  from?: string;
  to?: string;
  amount: string;
}

export interface TransferExpectation {
  /** `native`, `CODE:ISSUER` or the token's `C…` contract id. */
  asset: string;
  /** Smallest units (7 decimals). */
  amount: string;
  to: string;
  from?: string;
}

/**
 * Pure: does one of the operations move exactly `amount` of `asset` to `to` (from `from`, if
 * given) through a Stellar Asset Contract `transfer`? Horizon derives `asset_balance_changes`
 * from the asset contract's own events.
 */
export function matchSacTransfer(
  ops: readonly { type: string; asset_balance_changes?: AssetBalanceChange[] }[],
  want: TransferExpectation,
): AssetBalanceChange | null {
  const token = tokenContractId(want.asset);
  for (const op of ops) {
    if (op.type !== "invoke_host_function") continue;
    for (const c of op.asset_balance_changes ?? []) {
      const asset =
        c.asset_type === "native" ? "native" : `${c.asset_code ?? ""}:${c.asset_issuer ?? ""}`;
      let changeToken: string;
      try {
        changeToken = tokenContractId(asset);
      } catch {
        continue;
      }
      if (
        c.type === "transfer" &&
        changeToken === token &&
        c.to === want.to &&
        (!want.from || c.from === want.from) &&
        fromStellarAmount(c.amount) === BigInt(want.amount).toString()
      )
        return c;
    }
  }
  return null;
}

/**
 * Checks a settled Stellar transaction (e.g. an x402 `exact` settlement) for a transfer to the
 * payee. Reads Horizon, which keeps full history (Soroban RPC only keeps about a week).
 */
export async function findSacTransfer(
  hash: string,
  want: TransferExpectation,
  options: HorizonOptions = {},
): Promise<{ ok: true; ledger: number; createdAt: string } | { ok: false; reason: string }> {
  const server = new HorizonClient(options).server;
  let tx;
  try {
    tx = await server.transactions().transaction(hash).call();
  } catch (err) {
    if (isNotFound(err)) return { ok: false, reason: "settlement transaction not found" };
    throw err;
  }
  if (!tx.successful) return { ok: false, reason: "settlement transaction failed" };
  const ops = await server.operations().forTransaction(hash).limit(200).call();
  const hit = matchSacTransfer(
    ops.records as unknown as { type: string; asset_balance_changes?: AssetBalanceChange[] }[],
    want,
  );
  return hit
    ? { ok: true, ledger: tx.ledger_attr, createdAt: tx.created_at }
    : { ok: false, reason: "no transfer of that amount and asset to the payee in the settlement" };
}
