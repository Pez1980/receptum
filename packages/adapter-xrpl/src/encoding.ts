import { isSha256Hex, RECEIPT_VERSION, type Sha256Hex } from "@receptum/core";
import { isValidClassicAddress, type Memo } from "xrpl";

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();
const unhex = (data: string) => Buffer.from(data, "hex").toString("utf8");

/** SPEC §7: MemoType = hex("receptum/1"), MemoData = the 32 receiptHash bytes. */
export const RECEIPT_MEMO_TYPE = hex(RECEIPT_VERSION);
/** Binds a delivery memo to an escrow: MemoData = hex(utf8 escrowId). */
export const ESCROW_MEMO_TYPE = hex("receptum/escrow");

export function receiptMemos(receiptHash: Sha256Hex, escrowId?: string): Memo[] {
  if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be hex64");
  const memos: Memo[] = [
    { Memo: { MemoType: RECEIPT_MEMO_TYPE, MemoData: receiptHash.toUpperCase() } },
  ];
  if (escrowId) memos.push({ Memo: { MemoType: ESCROW_MEMO_TYPE, MemoData: hex(escrowId) } });
  return memos;
}

/** Reads Receptum memos from a transaction. Unknown or malformed memos are ignored. */
export function parseReceiptMemos(memos: Memo[] | undefined): {
  receiptHash?: Sha256Hex;
  escrowId?: string;
} {
  const out: { receiptHash?: Sha256Hex; escrowId?: string } = {};
  for (const { Memo: m } of memos ?? []) {
    const type = m?.MemoType?.toUpperCase();
    if (!m?.MemoData) continue;
    if (type === RECEIPT_MEMO_TYPE && out.receiptHash === undefined) {
      const h = m.MemoData.toLowerCase();
      if (isSha256Hex(h)) out.receiptHash = h;
    } else if (type === ESCROW_MEMO_TYPE && out.escrowId === undefined) {
      out.escrowId = unhex(m.MemoData);
    }
  }
  return out;
}

// ─── escrow ids ────────────────────────────────────────────────────────────

/** `<ownerAddress>:<OfferSequence>` — the pair XRPL uses to address an escrow. */
export function formatEscrowId(owner: string, sequence: number): string {
  return `${owner}:${sequence}`;
}

export function parseEscrowId(escrowId: string): { owner: string; sequence: number } {
  const m = /^(r[1-9A-HJ-NP-Za-km-z]{24,34}):([1-9][0-9]{0,9})$/.exec(escrowId);
  const sequence = Number(m?.[2]);
  if (!m?.[1] || !isValidClassicAddress(m[1]) || sequence > 0xffffffff) {
    throw new TypeError(`invalid XRPL escrow id: ${escrowId}`);
  }
  return { owner: m[1], sequence };
}

/** CAIP-10 account id, e.g. `xrpl:1:r…`. */
export const caip10 = (network: string, address: string) => `${network}:${address}`;

// ─── amounts ───────────────────────────────────────────────────────────────

export type XrplAmount = string | { currency: string; issuer: string; value: string };

/** Currency code on the wire: 3-letter ISO-style codes as-is, longer symbols as 40-hex. */
export function currencyCode(symbol: string): string {
  if (symbol.toUpperCase() === "XRP") throw new TypeError("XRP is not an issued currency");
  if (/^[0-9A-F]{40}$/i.test(symbol)) return symbol.toUpperCase();
  if (symbol.length === 3) return symbol;
  if (symbol.length < 3 || symbol.length > 20) throw new TypeError(`bad currency: ${symbol}`);
  return hex(symbol).padEnd(40, "0");
}

/** Inverse of currencyCode for display: printable 40-hex codes become their symbol. */
export function currencySymbol(code: string): string {
  if (!/^[0-9A-F]{40}$/i.test(code)) return code;
  const text = unhex(code.replace(/(00)+$/, ""));
  return /^[\x21-\x7e]{3,20}$/.test(text) ? text : code;
}

function scale(units: string, decimals: number): string {
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// rippled may render issued values in scientific notation, e.g. "1e-7".
function unscale(value: string, decimals: number): string {
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(value);
  if (!m) throw new TypeError(`unsupported amount value: ${value}`);
  const frac = m[2] ?? "";
  let digits = (m[1] ?? "0") + frac;
  let exp = Number(m[3] ?? 0) - frac.length + decimals;
  while (exp < 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exp++;
  }
  if (exp < 0) throw new RangeError(`${value} has more than ${decimals} decimals`);
  return BigInt(digits + "0".repeat(exp)).toString();
}

/**
 * Converts a Receptum amount (integer, smallest unit) to an XRPL amount.
 * `asset` is "XRP" (drops) or "<currency>.<issuer>" with `decimals` fractional digits.
 */
export function toXrplAmount(asset: string, amount: string, decimals: number): XrplAmount {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new TypeError("amount must be an integer string");
  if (asset === "XRP") return amount;
  const [symbol, issuer] = asset.split(".");
  if (!symbol || !issuer || !isValidClassicAddress(issuer)) {
    throw new TypeError(`asset must be "XRP" or "<currency>.<issuer>": ${asset}`);
  }
  const value = scale(amount, decimals);
  if (value.replace(/^[0.]+|\./g, "").length > 15) {
    throw new RangeError("issued amounts are limited to 15 significant digits");
  }
  return { currency: currencyCode(symbol), issuer, value };
}

export function fromXrplAmount(
  amount: XrplAmount,
  decimals: number,
): { asset: string; amount: string } {
  if (typeof amount === "string") return { asset: "XRP", amount };
  return {
    asset: `${currencySymbol(amount.currency)}.${amount.issuer}`,
    amount: unscale(amount.value, decimals),
  };
}
