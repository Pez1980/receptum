import { Asset, Memo, StrKey } from "@stellar/stellar-sdk";
import { isSha256Hex, type Sha256Hex } from "@receptum/core";

// ─── Escrow ids ────────────────────────────────────────────────────────────

/** Horizon's claimable-balance id: 4-byte type (`00000000` = V0) + 32-byte hash, hex. */
const BALANCE_ID_HEX = /^00000000[0-9a-f]{64}$/;

/**
 * Normalises an escrow id to Horizon's hex balance id. Accepts the hex form
 * (any case) or a SEP-23 `B…` claimable-balance strkey.
 */
export function parseEscrowId(escrowId: string): string {
  const id = escrowId.trim();
  if (BALANCE_ID_HEX.test(id.toLowerCase())) return id.toLowerCase();
  if (id.startsWith("B") && StrKey.isValidClaimableBalance(id)) {
    const raw = Buffer.from(StrKey.decodeClaimableBalance(id));
    // The strkey payload is a 1-byte type (0 = V0) followed by the 32-byte hash.
    if (raw.length === 33 && raw[0] === 0) return `00000000${raw.subarray(1).toString("hex")}`;
  }
  throw new TypeError(`invalid Stellar escrow id: ${escrowId}`);
}

/** The SEP-23 strkey (`B…`) of an escrow id, for explorers and wallets. */
export function escrowIdToStrKey(escrowId: string): string {
  const hash = Buffer.from(parseEscrowId(escrowId).slice(8), "hex");
  return StrKey.encodeClaimableBalance(Buffer.concat([Buffer.from([0]), hash]));
}

/**
 * Name of the seller-account data entry that records a delivery: the 64-hex
 * balance hash (exactly the 64-byte limit of a data entry name).
 */
export function deliveryDataKey(escrowId: string): string {
  return parseEscrowId(escrowId).slice(8);
}

// ─── Receipt hashes in memos and data entries ──────────────────────────────

function assertHash(receiptHash: string): asserts receiptHash is Sha256Hex {
  if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be 64 lower-case hex");
}

/** SPEC §7: the anchor is `MEMO_HASH = receiptHash` (32 raw bytes). */
export function receiptMemo(receiptHash: Sha256Hex): Memo {
  assertHash(receiptHash);
  return Memo.hash(receiptHash);
}

/** The 32 raw bytes of a receipt hash (stored as a data entry value). */
export function receiptHashBytes(receiptHash: Sha256Hex): Buffer {
  assertHash(receiptHash);
  return Buffer.from(receiptHash, "hex");
}

/** Decodes a base64 32-byte value (Horizon's hash `memo`, or a data entry value). */
export function receiptHashFromBase64(value: string | undefined | null): Sha256Hex | null {
  if (!value) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) return null;
  return bytes.toString("hex");
}

// ─── Assets and amounts ────────────────────────────────────────────────────

/** Parses `native` / `XLM` or `CODE:ISSUER`. */
export function parseAsset(asset: string): Asset {
  if (asset === "native" || asset === "XLM") return Asset.native();
  const [code, issuer, extra] = asset.split(":");
  if (!code || !issuer || extra !== undefined) {
    throw new TypeError(`invalid Stellar asset: ${asset}`);
  }
  return new Asset(code, issuer);
}

/** Canonical string form: `native` or `CODE:ISSUER` (as Horizon reports it). */
export function assetToString(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}

const STROOPS_PER_UNIT = 10_000_000n;
const MAX_INT64 = 2n ** 63n - 1n;

/** Smallest-unit integer string (7 decimals) → Stellar decimal amount, e.g. `"1.2500000"`. */
export function toStellarAmount(smallestUnits: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(smallestUnits)) {
    throw new TypeError("amount must be a non-negative integer string");
  }
  const n = BigInt(smallestUnits);
  if (n === 0n || n > MAX_INT64) throw new RangeError("amount out of range");
  const whole = n / STROOPS_PER_UNIT;
  const frac = (n % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/** Stellar decimal amount → smallest-unit integer string. */
export function fromStellarAmount(amount: string): string {
  const m = /^([0-9]+)(?:\.([0-9]{1,7}))?$/.exec(amount);
  if (!m?.[1]) throw new TypeError(`invalid Stellar amount: ${amount}`);
  return (BigInt(m[1]) * STROOPS_PER_UNIT + BigInt((m[2] ?? "").padEnd(7, "0"))).toString();
}
