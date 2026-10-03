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

/** Characters XRPL allows in a 3-character (standard) currency code. Case-sensitive. */
const STANDARD_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
/** 160-bit standard layout: 12 zero bytes, the 3 code bytes, 5 zero bytes. */
const STANDARD_LAYOUT = /^0{24}([0-9A-F]{6})0{10}$/;

/**
 * Currency code on the wire: 3-character standard codes as-is (case preserved), longer symbols
 * (4–20 characters) as the 40-hex of their UTF-8 bytes, 40-hex codes upper-cased.
 */
export function currencyCode(symbol: string): string {
  if (symbol === "XRP") throw new TypeError("XRP is not an issued currency");
  if (/^[0-9A-F]{40}$/i.test(symbol)) return symbol.toUpperCase();
  if (symbol.length === 3) return symbol;
  if (symbol.length < 3 || symbol.length > 20) throw new TypeError(`bad currency: ${symbol}`);
  return hex(symbol).padEnd(40, "0");
}

/**
 * The 160-bit protocol identity of a wire currency code (XRPL binary format), as 40 upper-case
 * hex. A 3-character code is encoded into the standard layout byte for byte, so `usd` and `USD`
 * are different currencies. A 40-hex code is its own identity; only its hex spelling is
 * normalized. A 40-hex code with the standard layout (first byte 0x00) therefore IS that
 * standard code, exactly as the ledger stores it, while a nonstandard code whose bytes merely
 * spell `USD` is a different currency. Throws on `XRP` (as a standard code or its encoding),
 * characters outside the standard set, longer symbols (use `currencyCode` first) and
 * 0x00-prefixed codes that are not in the standard layout.
 */
export function currencyId(code: string): string {
  let id: string;
  if (/^[0-9A-F]{40}$/i.test(code)) id = code.toUpperCase();
  else if (STANDARD_CODE.test(code)) id = `${"00".repeat(12)}${hex(code)}${"00".repeat(5)}`;
  else throw new TypeError(`not an XRPL currency code: ${code}`);
  if (id.startsWith("00")) {
    const m = STANDARD_LAYOUT.exec(id);
    const text = m ? Buffer.from(m[1]!, "hex").toString("latin1") : "";
    if (!m || !STANDARD_CODE.test(text) || text === "XRP")
      throw new TypeError(`not a valid XRPL currency: ${code}`);
  }
  return id;
}

/** Protocol identity of an escrowed or delivered asset: XRP, or (160-bit currency, issuer). */
export type XrplAssetId = { currency: "XRP" } | { currency: string; issuer: string };

/**
 * Parses a receipt's `payment.asset` — `XRP`, or `<currency>.<issuer>` with a 3-character code,
 * a 4–20 character symbol or a 40-hex code, and a classic issuer address — into its protocol
 * identity. Throws TypeError on anything else.
 */
export function parseXrplAsset(asset: string): XrplAssetId {
  if (asset === "XRP") return { currency: "XRP" };
  const dot = asset.lastIndexOf(".");
  const symbol = asset.slice(0, dot);
  const issuer = asset.slice(dot + 1);
  if (dot <= 0 || !isValidClassicAddress(issuer))
    throw new TypeError(`asset must be "XRP" or "<currency>.<issuer>": ${asset}`);
  return { currency: currencyId(currencyCode(symbol)), issuer };
}

/** Protocol identity of a ledger amount; null when its currency is not a valid code. */
export function xrplAmountId(amount: XrplAmount): XrplAssetId | null {
  if (typeof amount === "string") return { currency: "XRP" };
  try {
    return { currency: currencyId(amount.currency), issuer: amount.issuer };
  } catch {
    return null;
  }
}

/**
 * Display form of a wire currency code. Round-trip safe: a symbol is shown only when
 * `currencyCode(symbol)` has the same protocol identity, so a nonstandard code is never shown
 * as the standard code it spells (it stays 40-hex). Display only; compare with `currencyId`.
 */
export function currencySymbol(code: string): string {
  let id: string;
  try {
    id = currencyId(code);
  } catch {
    return code;
  }
  const std = STANDARD_LAYOUT.exec(id);
  if (std) return Buffer.from(std[1]!, "hex").toString("latin1");
  const text = unhex(id.replace(/(00)+$/, ""));
  if (!/^[\x21-\x7e]{3,20}$/.test(text)) return id;
  try {
    return currencyId(currencyCode(text)) === id ? text : id;
  } catch {
    return id;
  }
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
  const dot = asset.lastIndexOf(".");
  const symbol = dot > 0 ? asset.slice(0, dot) : "";
  const issuer = asset.slice(dot + 1);
  if (!symbol || !issuer || !isValidClassicAddress(issuer)) {
    throw new TypeError(`asset must be "XRP" or "<currency>.<issuer>": ${asset}`);
  }
  currencyId(currencyCode(symbol)); // validates the code
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
