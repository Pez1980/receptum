/**
 * Level 3 for `x402:exact` receipts on XRPL (`xrpl:<NetworkID>`), SPEC §7.3.
 *
 * The x402 `exact` scheme on XRPL settles one payer-signed `Payment`. The receipt's
 * `payment.reference` is that transaction's hash. It is confirmed only from a validated ledger:
 * tesSUCCESS, TransactionType Payment, Account = payer, Destination = payee, and the
 * `delivered_amount` (never `Amount`: partial payments can deliver less) equal to
 * `payment.amount` XRP drops. Issued tokens are unsupported in RRF v1 (an integer
 * `payment.amount` has no defined unit for an XRPL issued value): a delivery in another currency
 * or from another issuer fails, a matching one is `unavailable`. Currencies compare by 160-bit
 * protocol identity (`currencyId`). Lookups that can't be completed are `unavailable`, never `pass`.
 */
import { parseXrplAsset, xrplAmountId, type XrplAssetId } from "@receptum/adapter-xrpl";

export type XrplX402Status = "pass" | "fail" | "unavailable";

export interface XrplX402Result {
  status: XrplX402Status;
  detail: string;
}

/** Calls one rippled JSON-RPC method and returns its `result` object. */
export type XrplRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Public JSON-RPC endpoints, by CAIP-2 id: testnet `xrpl:1` and mainnet `xrpl:0`. Verification is
 * read-only, so mainnet needs no opt-in; the server's NetworkID is still checked against the
 * receipt.
 */
export const XRPL_JSON_RPCS: Readonly<Record<string, string>> = {
  "xrpl:1": "https://s.altnet.rippletest.net:51234",
  "xrpl:0": "https://xrplcluster.com",
};

export interface XrplX402Payment {
  network: string;
  asset: string;
  amount: string;
  reference: string;
  payee?: string;
  payer?: string;
}

export interface XrplX402Options {
  /** Override the JSON-RPC transport (tests, private nodes). */
  rpc?: XrplRpc;
  /** CAIP-2 → JSON-RPC URL; merged over XRPL_JSON_RPCS. */
  rpcs?: Record<string, string>;
}

/** Plain fetch JSON-RPC client for rippled. Network/HTTP failures throw. */
export function xrplJsonRpc(url: string, timeoutMs = 20_000): XrplRpc {
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} via ${url}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown };
    return body.result;
  };
}

const HASH = /^[0-9A-Fa-f]{64}$/;
const NETWORK = /^xrpl:(0|[1-9][0-9]{0,9})$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses `payment.asset` into its protocol identity, or an error message. */
function parseAsset(asset: string): XrplAssetId | string {
  try {
    return parseXrplAsset(asset);
  } catch (err) {
    return `payment.asset must be "XRP" or "<currency>.<issuer>" with a valid XRPL currency code and issuer address (${err instanceof Error ? err.message : String(err)})`;
  }
}

const account = (network: string, caip10: string | undefined): string | null | undefined => {
  if (caip10 === undefined) return undefined;
  const i = caip10.lastIndexOf(":");
  return i > 0 && caip10.slice(0, i) === network ? caip10.slice(i + 1) : null;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Level 3 for `x402:exact` on `xrpl:*`. */
export async function verifyXrplX402Payment(
  payment: XrplX402Payment,
  options: XrplX402Options = {},
): Promise<XrplX402Result> {
  const fail = (detail: string): XrplX402Result => ({ status: "fail", detail });
  const unavailable = (detail: string): XrplX402Result => ({ status: "unavailable", detail });
  const { network, reference, amount } = payment;

  const net = NETWORK.exec(network);
  if (!net) return fail(`${network} is not an XRPL network (xrpl:<NetworkID>)`);
  const networkId = Number(net[1]);
  if (!HASH.test(reference)) return fail("payment.reference is not an XRPL transaction hash");
  const payer = account(network, payment.payer);
  const payee = account(network, payment.payee);
  if (payer === null) return fail(`payment.payer is not an account on ${network}`);
  if (payee === null) return fail(`payment.payee is not an account on ${network}`);
  if (!payee)
    return unavailable("receipt does not name a payee, so the recipient can't be confirmed");
  if (!payer) return unavailable("receipt does not name a payer, so the sender can't be confirmed");
  const asset = parseAsset(payment.asset);
  if (typeof asset === "string") return fail(asset);
  const xrp = asset.currency === "XRP";
  if (!/^(0|[1-9][0-9]*)$/.test(amount))
    return fail("payment.amount must be an integer (XRP drops)");

  let rpc = options.rpc;
  if (!rpc) {
    const url = { ...XRPL_JSON_RPCS, ...options.rpcs }[network];
    if (!url) return unavailable(`no XRPL JSON-RPC endpoint configured for ${network}`);
    rpc = xrplJsonRpc(url);
  }

  let info: unknown;
  let result: unknown;
  try {
    info = await rpc("server_info", {});
    result = await rpc("tx", { transaction: reference, binary: false, api_version: 2 });
  } catch (err) {
    return unavailable(`XRPL lookup unavailable: ${errorText(err)}`);
  }
  const served = isRecord(info) && isRecord(info.info) ? info.info.network_id : undefined;
  if (served !== undefined && served !== networkId)
    return unavailable(`the XRPL server serves NetworkID ${String(served)}, not ${networkId}`);
  if (!isRecord(result)) return unavailable("malformed tx reply");
  if (result.error === "txnNotFound")
    return unavailable(`transaction ${reference} not found on this server (it may lack history)`);
  if (result.error) return unavailable(`tx lookup failed: ${String(result.error)}`);
  if (result.validated !== true) return unavailable("transaction is not in a validated ledger yet");

  const tx = isRecord(result.tx_json) ? result.tx_json : result;
  const hash = typeof result.hash === "string" ? result.hash : tx.hash;
  if (typeof hash !== "string" || hash.toUpperCase() !== reference.toUpperCase())
    return fail("server returned a different transaction");
  const meta = isRecord(result.meta) ? result.meta : undefined;
  if (meta?.TransactionResult !== "tesSUCCESS")
    return fail(
      `transaction result is ${String(meta?.TransactionResult ?? "missing")}, not tesSUCCESS`,
    );
  if (tx.TransactionType !== "Payment")
    return fail(`transaction is a ${String(tx.TransactionType)}, not a Payment`);
  const txNetwork = tx.NetworkID === undefined ? undefined : Number(tx.NetworkID);
  if (txNetwork !== undefined && txNetwork !== networkId)
    return fail(`transaction NetworkID ${txNetwork} does not match ${network}`);
  if (networkId > 1024 && txNetwork === undefined)
    return fail(`transaction carries no NetworkID, required on ${network}`);
  if (tx.Account !== payer) return fail(`sender ${String(tx.Account)} is not payment.payer`);
  if (tx.Destination !== payee)
    return fail(`destination ${String(tx.Destination)} is not payment.payee`);

  const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
  if (delivered === undefined || delivered === "unavailable")
    return unavailable("the server does not report delivered_amount for this transaction");
  const ledger = typeof result.ledger_index === "number" ? ` in ledger ${result.ledger_index}` : "";
  if (xrp) {
    if (typeof delivered !== "string") return fail("delivered an issued currency, not XRP");
    if (delivered !== amount) return fail(`delivered ${delivered} drops, receipt says ${amount}`);
    return { status: "pass", detail: `${amount} drops delivered to ${payee}${ledger} (validated)` };
  }
  if (!isRecord(delivered) || typeof delivered.currency !== "string")
    return fail("delivered XRP, not an issued currency");
  const got = xrplAmountId(delivered as { currency: string; issuer: string; value: string });
  if (!got || got.currency !== asset.currency)
    return fail(
      `delivered currency ${String(delivered.currency)}, not the currency of ${payment.asset} (compared by protocol bytes; 3-character codes are case-sensitive)`,
    );
  if (!("issuer" in got) || !("issuer" in asset) || got.issuer !== asset.issuer)
    return fail(
      `delivered issuer ${String(delivered.issuer)}, not ${String("issuer" in asset ? asset.issuer : "")}`,
    );
  return unavailable(
    `issued-token x402 is not supported in RRF v1: ${payment.asset} was delivered${ledger}, but an integer payment.amount has no defined unit for an XRPL issued value, so the amount can't be confirmed`,
  );
}
