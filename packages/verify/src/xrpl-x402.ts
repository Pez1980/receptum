/**
 * Level 3 for `x402:exact` receipts on XRPL (`xrpl:<NetworkID>`), see docs/rails/x402-xrpl.md.
 *
 * The x402 `exact` scheme on XRPL settles one payer-signed `Payment`. The receipt's
 * `payment.reference` is that transaction's hash. It is confirmed only from a validated ledger:
 * tesSUCCESS, TransactionType Payment, Account = payer, Destination = payee, and the
 * `delivered_amount` (never `Amount`: partial payments can deliver less) equal to
 * `payment.amount` in `payment.asset`. Lookups that can't be completed are `pending`, never `pass`.
 */
import { currencyCode } from "@receptum/adapter-xrpl";

export type XrplX402Status = "pass" | "fail" | "pending";

export interface XrplX402Result {
  status: XrplX402Status;
  detail: string;
}

/** Calls one rippled JSON-RPC method and returns its `result` object. */
export type XrplRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Public JSON-RPC endpoints, by CAIP-2 id. Testnet only by default. */
export const XRPL_JSON_RPCS: Readonly<Record<string, string>> = {
  "xrpl:1": "https://s.altnet.rippletest.net:51234",
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

/** Canonical (digits, exponent) of a non-negative decimal, accepting rippled's `1e-7` form. */
function decimalKey(value: string): string | null {
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!m) return null;
  const frac = m[2] ?? "";
  let digits = ((m[1] ?? "0") + frac).replace(/^0+/, "");
  let exp = Number(m[3] ?? 0) - frac.length;
  if (!digits) return "0";
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exp++;
  }
  return `${digits}e${exp}`;
}

/** Parses `payment.asset`: "XRP" (drops) or "<currency>.<issuer>" (issued value). */
function parseAsset(asset: string): { xrp: true } | { currency: string; issuer: string } | string {
  if (asset === "XRP") return { xrp: true };
  const dot = asset.lastIndexOf(".");
  if (dot <= 0) return `issued-currency asset must be "<currency>.<issuer>", got "${asset}"`;
  try {
    return {
      currency: currencyCode(asset.slice(0, dot)).toUpperCase(),
      issuer: asset.slice(dot + 1),
    };
  } catch {
    return `bad currency in asset "${asset}"`;
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
  const pending = (detail: string): XrplX402Result => ({ status: "pending", detail });
  const { network, reference, amount } = payment;

  const net = NETWORK.exec(network);
  if (!net) return fail(`${network} is not an XRPL network (xrpl:<NetworkID>)`);
  const networkId = Number(net[1]);
  if (!HASH.test(reference)) return fail("payment.reference is not an XRPL transaction hash");
  const payer = account(network, payment.payer);
  const payee = account(network, payment.payee);
  if (payer === null) return fail(`payment.payer is not an account on ${network}`);
  if (payee === null) return fail(`payment.payee is not an account on ${network}`);
  if (!payee) return pending("receipt does not name a payee, so the recipient can't be confirmed");
  if (!payer) return pending("receipt does not name a payer, so the sender can't be confirmed");
  const asset = parseAsset(payment.asset);
  if (typeof asset === "string") return fail(asset);
  if ("xrp" in asset && !/^(0|[1-9][0-9]*)$/.test(amount))
    return fail("XRP amount must be an integer number of drops");
  if (!("xrp" in asset) && !decimalKey(amount))
    return fail("issued-currency amount must be a decimal value");

  let rpc = options.rpc;
  if (!rpc) {
    const url = { ...XRPL_JSON_RPCS, ...options.rpcs }[network];
    if (!url) return pending(`no XRPL JSON-RPC endpoint configured for ${network}`);
    rpc = xrplJsonRpc(url);
  }

  let info: unknown;
  let result: unknown;
  try {
    info = await rpc("server_info", {});
    result = await rpc("tx", { transaction: reference, binary: false, api_version: 2 });
  } catch (err) {
    return pending(`XRPL lookup unavailable: ${errorText(err)}`);
  }
  const served = isRecord(info) && isRecord(info.info) ? info.info.network_id : undefined;
  if (served !== undefined && served !== networkId)
    return pending(`the XRPL server serves NetworkID ${String(served)}, not ${networkId}`);
  if (!isRecord(result)) return pending("malformed tx reply");
  if (result.error === "txnNotFound")
    return pending(`transaction ${reference} not found on this server (it may lack history)`);
  if (result.error) return pending(`tx lookup failed: ${String(result.error)}`);
  if (result.validated !== true) return pending("transaction is not in a validated ledger yet");

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
    return pending("the server does not report delivered_amount for this transaction");
  const ledger = typeof result.ledger_index === "number" ? ` in ledger ${result.ledger_index}` : "";
  if ("xrp" in asset) {
    if (typeof delivered !== "string") return fail("delivered an issued currency, not XRP");
    if (delivered !== amount) return fail(`delivered ${delivered} drops, receipt says ${amount}`);
    return { status: "pass", detail: `${amount} drops delivered to ${payee}${ledger} (validated)` };
  }
  if (!isRecord(delivered) || typeof delivered.value !== "string")
    return fail("delivered XRP, not an issued currency");
  if (String(delivered.currency).toUpperCase() !== asset.currency)
    return fail(`delivered currency ${String(delivered.currency)}, not ${payment.asset}`);
  if (delivered.issuer !== asset.issuer)
    return fail(`delivered issuer ${String(delivered.issuer)}, not ${asset.issuer}`);
  if (decimalKey(delivered.value) !== decimalKey(amount))
    return fail(`delivered ${delivered.value}, receipt says ${amount}`);
  return {
    status: "pass",
    detail: `${amount} ${payment.asset} delivered to ${payee}${ledger} (validated)`,
  };
}
