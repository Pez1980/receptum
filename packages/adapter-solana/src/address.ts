import { createHash } from "node:crypto";
import { decodeBase58, encodeBase58, isSolanaAddress } from "./base58.js";

/** Well-known program ids. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** SPL Memo program v2 (the one anchors use). */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const BPF_LOADER_UPGRADEABLE_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

/** Circle's USDC mint on Solana devnet (6 decimals). */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** Circle's USDC mint on Solana mainnet (6 decimals). */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function addressBytes(address: string): Uint8Array {
  if (!isSolanaAddress(address)) throw new TypeError(`invalid Solana address: ${String(address)}`);
  return decodeBase58(address);
}

// ─── Ed25519 curve check (PDAs must be off the curve) ────────────────────────

const P = 2n ** 255n - 19n;
const D = (-121665n * modInverse(121666n)) % P;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function modInverse(a: bigint): bigint {
  return modPow(((a % P) + P) % P, P - 2n, P);
}

/**
 * Whether 32 bytes decompress to a point on edwards25519 (curve25519-dalek semantics: the sign
 * bit is ignored for validity and `y` is reduced mod p). Program-derived addresses never are.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y = mod(y);
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u v^3 (u v^7)^((p-5)/8); valid iff v x^2 = ±u.
  const v3 = mod(v * v * v);
  const x = mod(u * v3 * modPow(mod(u * v3 * v3 * v), (P - 5n) / 8n, P));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) return true; // x * sqrt(-1) is the root
  return false;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

/** `create_program_address`: throws when the result lies on the curve. */
export function createProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  if (seeds.length > 16 || seeds.some((s) => s.length > 32)) throw new TypeError("invalid seeds");
  const h = createHash("sha256");
  for (const s of seeds) h.update(s);
  h.update(addressBytes(programId)).update(PDA_MARKER);
  const out = new Uint8Array(h.digest());
  if (isOnCurve(out)) throw new Error("invalid seeds: address is on the curve");
  return encodeBase58(out);
}

/** `find_program_address`: the highest bump (255 → 0) whose address is off the curve. */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): { address: string; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return { address: createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump };
    } catch {
      // next bump
    }
  }
  throw new Error("no viable program-derived address");
}

/** The associated token account of `owner` for `mint` (classic SPL Token by default). */
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM_ID,
): string {
  return findProgramAddress(
    [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).address;
}
