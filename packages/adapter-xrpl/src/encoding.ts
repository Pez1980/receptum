import {
  isSha256Hex,
  parseXrplIssuedAsset,
  RECEIPT_VERSION,
  xrplCanonicalCurrency,
  xrplCurrencyId,
  xrplIssuedAsset,
  xrplUnitsToValue,
  xrplValueToUnits,
  type Sha256Hex,
} from "@receptum/core";
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

/** 160-bit standard layout: 12 zero bytes, the 3 code bytes, 5 zero bytes. */
const STANDARD_LAYOUT = /^0{24}([0-9A-F]{6})0{10}$/;

/**
 * Wire currency code for a display symbol: 3-character standard codes as-is (case preserved),
 * longer symbols (4–20 characters) as the 40-hex of their UTF-8 bytes, 40-hex codes upper-cased.
 * A helper for building amounts; receipts carry the on-ledger code (`xrplCanonicalCurrency`).
 */
export function currencyCode(symbol: string): string {
  if (symbol === "XRP") throw new TypeError("XRP is not an issued currency");
  if (/^[0-9A-F]{40}$/i.test(symbol)) return symbol.toUpperCase();
  if (symbol.length === 3) return symbol;
  if (symbol.length < 3 || symbol.length > 20) throw new TypeError(`bad currency: ${symbol}`);
  return hex(symbol).padEnd(40, "0");
}

/**
 * The 160-bit protocol identity of an on-ledger currency code (XRPL binary format), as 40
 * upper-case hex: a 3-character code byte for byte in the standard layout (case-sensitive, so
 * `usd` ≠ `USD`), a 40-hex code as itself (only its hex spelling is normalized). A standard-layout
 * 40-hex code therefore IS that standard code, while a nonstandard code whose bytes merely spell
 * `USD` is a different currency. Throws on `XRP`, characters outside the standard set, display
 * symbols (use `currencyCode` first) and 0x00-prefixed codes not in the standard layout.
 */
export const currencyId = xrplCurrencyId;

/** Protocol identity of an escrowed or delivered asset: XRP, or (160-bit currency, issuer). */
export type XrplAssetId = { currency: "XRP" } | { currency: string; issuer: string };

/**
 * Parses a receipt's `payment.asset` — `XRP`, or `<currency>.<issuer>` with the currency as on
 * the ledger (a 3-character code or 40-hex; display symbols such as `RLUSD` are refused) and a
 * classic issuer address — into its protocol identity (SPEC §7.3). Throws TypeError otherwise.
 */
export function parseXrplAsset(asset: string): XrplAssetId {
  if (asset === "XRP") return { currency: "XRP" };
  return parseXrplIssuedAsset(asset);
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

/**
 * Converts a receipt amount to an XRPL amount (SPEC §7.3): XRP drops as-is; an issued token's
 * integer 10^-15 units as its decimal value, e.g. `"250000000000000"` → `"0.25"`. `asset` is
 * `XRP` or `<currency>.<issuer>` (on-ledger currency). Throws when the amount has no exact XRPL
 * issued amount.
 */
export function toXrplAmount(asset: string, amount: string): XrplAmount {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new TypeError("amount must be an integer string");
  if (asset === "XRP") return amount;
  const { issuer } = parseXrplIssuedAsset(asset);
  const currency = xrplCanonicalCurrency(asset.slice(0, asset.indexOf(".")));
  return { currency, issuer, value: xrplUnitsToValue(amount) };
}

/**
 * A ledger amount as a receipt's `asset` and `amount`: XRP drops, or `<currency>.<issuer>` with the
 * currency as rippled writes it and the value as integer 10^-15 units. Throws RangeError when the
 * value is not a whole number of 10^-15 units, TypeError on an invalid currency.
 */
export function fromXrplAmount(amount: XrplAmount): { asset: string; amount: string } {
  if (typeof amount === "string") return { asset: "XRP", amount };
  return {
    asset: xrplIssuedAsset(amount.currency, amount.issuer),
    amount: xrplValueToUnits(amount.value),
  };
}
