/** Bitcoin-alphabet base58, as used for Solana addresses and signatures. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Decodes base58; throws on characters outside the alphabet. */
export function decodeBase58(text: string): Uint8Array {
  if (typeof text !== "string") throw new TypeError("base58 input must be a string");
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new TypeError("invalid base58 character");
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** True when `text` is base58 of exactly `length` bytes, in its canonical encoding. */
export function isBase58Of(text: unknown, length: number): text is string {
  if (typeof text !== "string" || text.length === 0 || text.length > 90) return false;
  try {
    const b = decodeBase58(text);
    return b.length === length && encodeBase58(b) === text;
  } catch {
    return false;
  }
}

/** A Solana address (32-byte public key or program-derived address) in base58. */
export const isSolanaAddress = (text: unknown): text is string => isBase58Of(text, 32);

/** A Solana transaction signature (64 bytes) in base58. */
export const isSolanaSignature = (text: unknown): text is string => isBase58Of(text, 64);
