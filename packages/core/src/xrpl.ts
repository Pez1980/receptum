// XRPL issued tokens in RRF v1 receipts (SPEC §7.3, "XRPL issued tokens"). Exact and float-free:
// every conversion is decimal-string and BigInt arithmetic.
import { createHash } from "node:crypto";

/**
 * RRF v1 records an XRPL issued-token amount as an integer number of 10^-15 token units:
 * value "0.25" ↔ amount "250000000000000". 15 is the precision XRPL documents for issued values.
 */
export const XRPL_ISSUED_SCALE = 15;

/** Largest mantissa precision of an XRPL issued amount (rippled: 10^15 ≤ mantissa < 10^16). */
export const XRPL_MAX_SIGNIFICANT_DIGITS = 16;
/** Exponent range of a normalized (16-digit mantissa) XRPL issued amount. */
export const XRPL_MIN_EXPONENT = -96;
export const XRPL_MAX_EXPONENT = 80;

/** Issued-value strings as rippled and xrpl.js write them: decimal or `<decimal>e<exponent>`. */
const VALUE = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const UNITS = /^(0|[1-9][0-9]*)$/;

/** A non-zero value as `digits × 10^exponent`, digits without leading or trailing zeros. */
interface Decimal {
  digits: string;
  exponent: number;
}

/** Throws unless the value has an exact XRPL issued-amount encoding. */
function assertOnLedger(d: Decimal, what: string): void {
  if (d.digits.length > XRPL_MAX_SIGNIFICANT_DIGITS)
    throw new RangeError(
      `${what} has ${d.digits.length} significant digits; XRPL issued amounts hold at most ${XRPL_MAX_SIGNIFICANT_DIGITS}`,
    );
  // Normalized form: a 16-digit mantissa, so the exponent is shifted by the padding.
  const exponent = d.exponent - (XRPL_MAX_SIGNIFICANT_DIGITS - d.digits.length);
  if (exponent < XRPL_MIN_EXPONENT || exponent > XRPL_MAX_EXPONENT)
    throw new RangeError(`${what} is outside the XRPL issued-amount range`);
}

function parseValue(value: string): Decimal | null {
  const m = VALUE.exec(value);
  if (!m) throw new TypeError(`not an XRPL issued value: ${JSON.stringify(value)}`);
  const frac = m[2] ?? "";
  const expText = m[3] ?? "0";
  // Any exponent this long is far outside the ledger's range (and would be costly to expand).
  if (expText.replace(/^[+-]?0*/, "").length > 6)
    throw new RangeError(`${value} is outside the XRPL issued-amount range`);
  let digits = ((m[1] ?? "") + frac).replace(/^0+/, "");
  if (!digits) return null; // zero
  let exponent = Number(expText) - frac.length;
  const trimmed = digits.replace(/0+$/, "");
  exponent += digits.length - trimmed.length;
  digits = trimmed;
  return { digits, exponent };
}

/**
 * XRPL issued value (e.g. `"0.25"`, `"1e-2"`, `"1.5E3"`, as in `Amount.value` or
 * `delivered_amount.value`) → RRF v1 `payment.amount`: the integer number of 10^-15 units.
 *
 * Throws TypeError for anything but `digits[.digits][(e|E)[+|-]digits]` (so a sign, `-0.5` or
 * `.5`, is refused) and RangeError when the value is not an exact multiple of 10^-15, has more
 * significant digits than an XRPL amount holds (16), or is outside the ledger's range.
 */
export function xrplValueToUnits(value: string): string {
  const d = parseValue(value);
  if (!d) return "0";
  assertOnLedger(d, value);
  const shift = d.exponent + XRPL_ISSUED_SCALE;
  if (shift < 0)
    throw new RangeError(`${value} is not a whole number of 10^-${XRPL_ISSUED_SCALE} units`);
  return d.digits + "0".repeat(shift);
}

/**
 * RRF v1 `payment.amount` (integer 10^-15 units) → the plain decimal XRPL issued value:
 * `"250000000000000"` → `"0.25"`. No exponent, no trailing fractional zeros, `"0"` for zero.
 * Throws when the integer has no exact XRPL amount (more than 16 significant digits, or beyond
 * the ledger's range).
 */
export function xrplUnitsToValue(units: string): string {
  if (!UNITS.test(units)) throw new TypeError(`amount must be an integer string: ${units}`);
  if (units === "0") return "0";
  const digits = units.replace(/0+$/, "");
  assertOnLedger({ digits, exponent: units.length - digits.length - XRPL_ISSUED_SCALE }, units);
  const padded = units.padStart(XRPL_ISSUED_SCALE + 1, "0");
  const whole = padded.slice(0, -XRPL_ISSUED_SCALE);
  const frac = padded.slice(-XRPL_ISSUED_SCALE).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ─── currencies and issuers ────────────────────────────────────────────────

/** Characters XRPL allows in a 3-character (standard) currency code. Case-sensitive. */
const STANDARD_CODE = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
/** 160-bit standard layout: 12 zero bytes, the 3 code bytes, 5 zero bytes. */
const STANDARD_LAYOUT = /^0{24}([0-9A-F]{6})0{10}$/;
const HEX40 = /^[0-9A-Fa-f]{40}$/;

/**
 * 160-bit protocol identity (40 upper-case hex) of an on-ledger currency code: a 3-character
 * standard code (case-sensitive, never `XRP`) in the standard layout, or a 40-hex code as itself
 * (hex case ignored). A 0x00-prefixed 40-hex code must be the standard layout of a valid standard
 * code. Throws TypeError for anything else — including 4–20 character symbols such as `RLUSD`,
 * which are display names, not on-ledger codes.
 */
export function xrplCurrencyId(code: string): string {
  let id: string;
  if (HEX40.test(code)) id = code.toUpperCase();
  else if (STANDARD_CODE.test(code))
    id = `${"00".repeat(12)}${Buffer.from(code, "latin1").toString("hex").toUpperCase()}${"00".repeat(5)}`;
  else throw new TypeError(`not an XRPL currency code: ${code}`);
  if (id.startsWith("00")) {
    const m = STANDARD_LAYOUT.exec(id);
    const text = m ? Buffer.from(m[1]!, "hex").toString("latin1") : "";
    if (!m || !STANDARD_CODE.test(text) || text === "XRP")
      throw new TypeError(`not a valid XRPL currency: ${code}`);
  }
  return id;
}

/**
 * The currency as rippled writes it: the 3-character code for the standard layout, otherwise the
 * 40 upper-case hex. This is the spelling sellers put in `payment.asset`.
 */
export function xrplCanonicalCurrency(code: string): string {
  const id = xrplCurrencyId(code);
  const std = STANDARD_LAYOUT.exec(id);
  return std ? Buffer.from(std[1]!, "hex").toString("latin1") : id;
}

const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** Is this a classic XRPL account address (base58check, version byte 0x00, 20-byte account id)? */
export function isXrplClassicAddress(address: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return false;
  let n = 0n;
  for (const c of address) {
    const i = RIPPLE_ALPHABET.indexOf(c);
    if (i < 0) return false;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const leading = /^r*/.exec(address)![0].length;
  const bytes = Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, "hex")]);
  if (bytes.length !== 25 || bytes[0] !== 0) return false;
  const sum = (b: Buffer) => createHash("sha256").update(b).digest();
  return sum(sum(bytes.subarray(0, 21)))
    .subarray(0, 4)
    .equals(bytes.subarray(21));
}

/** An issued asset by protocol identity: 160-bit currency (40 upper-case hex) and issuer. */
export interface XrplIssuedAssetId {
  currency: string;
  issuer: string;
}

/**
 * Parses an RRF v1 issued-token `payment.asset`, `<currency>.<issuer>` (currency as on the
 * ledger: 3-character code or 40-hex; issuer a classic address), into its protocol identity.
 * Throws TypeError on anything else.
 */
export function parseXrplIssuedAsset(asset: string): XrplIssuedAssetId {
  const dot = asset.indexOf(".");
  const issuer = asset.slice(dot + 1);
  if (dot <= 0 || !isXrplClassicAddress(issuer))
    throw new TypeError(`asset must be "<currency>.<issuer>": ${asset}`);
  return { currency: xrplCurrencyId(asset.slice(0, dot)), issuer };
}

/** The RRF v1 `payment.asset` of an issued token: `<canonical currency>.<issuer>`. */
export function xrplIssuedAsset(currency: string, issuer: string): string {
  if (!isXrplClassicAddress(issuer)) throw new TypeError(`not a classic XRPL address: ${issuer}`);
  return `${xrplCanonicalCurrency(currency)}.${issuer}`;
}
