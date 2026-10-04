import { createHash } from "node:crypto";
import { isSha256Hex, type Sha256Hex } from "@receptum/core";
import {
  addressBytes,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  BPF_LOADER_UPGRADEABLE_ID,
  findProgramAddress,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./address.js";
import { encodeBase58, isSolanaAddress } from "./base58.js";
import { isSolanaNetwork, SOLANA_DEVNET, SOLANA_MAINNET } from "./network.js";
import type { TransactionInstruction } from "./transaction.js";

/**
 * The `receptum_escrow` program (packages/adapter-solana/program). Deployed immutable (no upgrade
 * authority) on devnet; see program/deployment.devnet.json. Supersedes the first immutable
 * deployment `6VdZ7E96YbZig648NFQ9sHwKTHQtY7cntYU1mZmv77wv` (build `b3964928…`), whose payouts
 * required an exact vault balance, so a 1-unit donation to a vault could lock that escrow forever
 * (review round 4). That deployment is no longer trusted and its build no longer verifies.
 */
export const RECEPTUM_SOLANA_PROGRAM_ID = "4iUzsYkrzcUdc3aFsgXg5aocHWShMjQ3dCNSyg6dwgYC";

/**
 * SHA-256 of the published build (program/receptum_escrow.so) with trailing zero bytes removed —
 * the same value `solana-verify get-executable-hash` prints, and what a verifier computes from the
 * deployed ProgramData (§7.4 of SPEC).
 */
export const RECEPTUM_SOLANA_PROGRAM_HASH =
  "e20b63d342e98ed1856e1d1df54fa7aaa9fabf8c2b26ac8f3e638e281d3e451b";

/** Published deployments by network (mainnet: none — escrows go to mainnet only after an audit). */
export const RECEPTUM_SOLANA_DEPLOYMENTS: Readonly<Record<string, readonly string[]>> = {
  [SOLANA_DEVNET]: [RECEPTUM_SOLANA_PROGRAM_ID],
  [SOLANA_MAINNET]: [],
};

export const SOLANA_ESCROW_RAIL = "escrow:receptum-solana";
export const ESCROW_DISCRIMINATOR = "rcptesc1";
export const ESCROW_ACCOUNT_LEN = 272;
/** Header of an upgradeable-loader ProgramData account before the ELF bytes. */
export const PROGRAMDATA_HEADER_LEN = 45;

export const ESCROW_ERRORS: Readonly<Record<number, string>> = {
  1: "BadState",
  2: "NotAllowed",
  3: "TooEarly",
  4: "TooLate",
  5: "InvalidArgs",
  6: "UnsupportedToken",
  7: "NotFound",
  8: "Overflow",
};

export type SolanaEscrowStatus = "open" | "delivered" | "released" | "refunded";
const STATUSES: Record<number, SolanaEscrowStatus> = {
  1: "open",
  2: "delivered",
  3: "released",
  4: "refunded",
};

/** Decoded `receptum_escrow` account (layout: program/src/lib.rs). */
export interface SolanaEscrowAccount {
  status: SolanaEscrowStatus;
  bump: number;
  vaultBump: number;
  buyer: string;
  seller: string;
  /** null when the escrow has no evaluator. */
  evaluator: string | null;
  mint: string;
  vault: string;
  /** The accepting/rejecting judge or the refunding seller; null for permissionless calls. */
  settledBy: string | null;
  id: bigint;
  amount: bigint;
  /** Unix seconds. */
  deliverBy: number;
  reviewWindowSeconds: number;
  /** Unix seconds, 0 until delivered. */
  deliveredAt: number;
  /** null until delivered. */
  receiptHash: Sha256Hex | null;
}

/** Decodes an escrow account's data; throws when it is not one. */
export function decodeEscrowAccount(data: Uint8Array): SolanaEscrowAccount {
  const b = Buffer.from(data);
  if (
    b.length !== ESCROW_ACCOUNT_LEN ||
    b.subarray(0, 8).toString("latin1") !== ESCROW_DISCRIMINATOR
  )
    throw new TypeError("not a receptum_escrow account");
  if (b[8] !== 1) throw new TypeError(`unsupported receptum_escrow account version ${b[8]}`);
  const status = STATUSES[b[9]!];
  if (!status) throw new TypeError(`invalid escrow status ${b[9]}`);
  const key = (o: number) => encodeBase58(b.subarray(o, o + 32));
  const opt = (o: number) => (b.subarray(o, o + 32).every((x) => x === 0) ? null : key(o));
  const rh = b.subarray(240, 272);
  return {
    status,
    bump: b[10]!,
    vaultBump: b[11]!,
    buyer: key(12),
    seller: key(44),
    evaluator: opt(76),
    mint: key(108),
    vault: key(140),
    settledBy: opt(172),
    id: b.readBigUInt64LE(204),
    amount: b.readBigUInt64LE(212),
    deliverBy: Number(b.readBigInt64LE(220)),
    reviewWindowSeconds: b.readUInt32LE(228),
    deliveredAt: Number(b.readBigInt64LE(232)),
    receiptHash: rh.every((x) => x === 0) ? null : rh.toString("hex"),
  };
}

/** Escrow PDA `["escrow", buyer, id u64 LE]`. */
export function escrowAddress(
  buyer: string,
  id: bigint,
  programId = RECEPTUM_SOLANA_PROGRAM_ID,
): { address: string; bump: number } {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(id);
  return findProgramAddress([Buffer.from("escrow"), addressBytes(buyer), le], programId);
}

/** Vault PDA `["vault", escrow]`. */
export function vaultAddress(
  escrow: string,
  programId = RECEPTUM_SOLANA_PROGRAM_ID,
): { address: string; bump: number } {
  return findProgramAddress([Buffer.from("vault"), addressBytes(escrow)], programId);
}

/** escrowId (= receipt `payment.reference`): `<caip2>:<programId>:<escrow account>`. */
export function formatSolanaEscrowId(network: string, programId: string, escrow: string): string {
  if (!isSolanaNetwork(network)) throw new TypeError(`not a Solana CAIP-2 id: ${network}`);
  if (!isSolanaAddress(programId) || !isSolanaAddress(escrow))
    throw new TypeError("program id and escrow must be Solana addresses");
  return `${network}:${programId}:${escrow}`;
}

export function parseSolanaEscrowId(escrowId: string): {
  network: string;
  programId: string;
  escrow: string;
} {
  const m =
    /^(solana:[1-9A-HJ-NP-Za-km-z]{32}):([1-9A-HJ-NP-Za-km-z]{32,44}):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(
      typeof escrowId === "string" ? escrowId : "",
    );
  if (!m || !isSolanaAddress(m[2]) || !isSolanaAddress(m[3]))
    throw new TypeError(`invalid Solana escrowId: ${String(escrowId)}`);
  return { network: m[1]!, programId: m[2]!, escrow: m[3]! };
}

/**
 * Hash of a deployed program, from its ProgramData account: SHA-256 of the bytes after the
 * 45-byte header with trailing zero bytes removed. Also returns the upgrade authority (null when
 * the program is immutable).
 */
export function programDataHash(programData: Uint8Array): {
  hash: Sha256Hex;
  upgradeAuthority: string | null;
} {
  const b = Buffer.from(programData);
  if (b.length < PROGRAMDATA_HEADER_LEN || b.readUInt32LE(0) !== 3)
    throw new TypeError("not an upgradeable-loader ProgramData account");
  const auth = b[12] === 1 ? encodeBase58(b.subarray(13, 45)) : null;
  if (b[12] !== 0 && b[12] !== 1) throw new TypeError("invalid ProgramData authority option");
  return { hash: elfHash(b.subarray(PROGRAMDATA_HEADER_LEN)), upgradeAuthority: auth };
}

/** SHA-256 of a program binary with trailing zero bytes removed. */
export function elfHash(bytes: Uint8Array): Sha256Hex {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
}

/** The ProgramData address of an upgradeable program, from its Program account data. */
export function programDataAddress(programAccountData: Uint8Array): string {
  const b = Buffer.from(programAccountData);
  if (b.length !== 36 || b.readUInt32LE(0) !== 2)
    throw new TypeError("not an upgradeable-loader Program account");
  return encodeBase58(b.subarray(4, 36));
}

export { BPF_LOADER_UPGRADEABLE_ID };

// ─── Instruction builders ────────────────────────────────────────────────────

const w = (address: string) => ({ address, signer: false, writable: true });
const r = (address: string) => ({ address, signer: false, writable: false });
const s = (address: string, writable = false) => ({ address, signer: true, writable });

export interface OpenParams {
  buyer: string;
  seller: string;
  mint: string;
  amount: bigint;
  /** Unix seconds. */
  deliverBy: number | bigint;
  reviewWindowSeconds: number;
  evaluator?: string | null;
  id: bigint;
  programId?: string;
}

export function openInstruction(p: OpenParams): TransactionInstruction {
  const programId = p.programId ?? RECEPTUM_SOLANA_PROGRAM_ID;
  const escrow = escrowAddress(p.buyer, p.id, programId).address;
  const vault = vaultAddress(escrow, programId).address;
  const d = Buffer.alloc(1 + 8 + 8 + 8 + 4 + 32);
  d[0] = 0;
  d.writeBigUInt64LE(p.id, 1);
  d.writeBigUInt64LE(p.amount, 9);
  d.writeBigInt64LE(BigInt(p.deliverBy), 17);
  d.writeUInt32LE(p.reviewWindowSeconds, 25);
  if (p.evaluator) Buffer.from(addressBytes(p.evaluator)).copy(d, 29);
  return {
    programId,
    accounts: [
      s(p.buyer, true),
      r(p.seller),
      w(escrow),
      w(vault),
      w(associatedTokenAddress(p.buyer, p.mint)),
      r(p.mint),
      r(TOKEN_PROGRAM_ID),
      r(SYSTEM_PROGRAM_ID),
    ],
    data: d,
  };
}

export function deliverInstruction(
  escrow: string,
  seller: string,
  receiptHash: Sha256Hex,
  programId = RECEPTUM_SOLANA_PROGRAM_ID,
): TransactionInstruction {
  if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be hex64");
  return {
    programId,
    accounts: [s(seller), w(escrow)],
    data: Buffer.concat([Buffer.of(1), Buffer.from(receiptHash, "hex")]),
  };
}

export type PayoutKind = "accept" | "reject" | "release" | "refund" | "sellerRefund";
const TAGS: Record<PayoutKind, number> = {
  accept: 2,
  reject: 3,
  release: 4,
  refund: 5,
  sellerRefund: 6,
};

/** accept / reject (signer = buyer or evaluator), release / refund (anyone), sellerRefund. */
export function payoutInstruction(
  kind: PayoutKind,
  escrowAddr: string,
  e: Pick<SolanaEscrowAccount, "buyer" | "seller" | "mint" | "vault">,
  signer?: string,
  programId = RECEPTUM_SOLANA_PROGRAM_ID,
): TransactionInstruction {
  const toSeller = kind === "accept" || kind === "release";
  const dest = associatedTokenAddress(toSeller ? e.seller : e.buyer, e.mint);
  const tail = [w(escrowAddr), w(e.vault), w(dest), w(e.buyer), r(e.mint), r(TOKEN_PROGRAM_ID)];
  const needsSigner = kind === "accept" || kind === "reject" || kind === "sellerRefund";
  if (needsSigner && !signer) throw new TypeError(`${kind} needs a signer`);
  return {
    programId,
    accounts: needsSigner ? [s(signer!), ...tail] : tail,
    data: Buffer.of(TAGS[kind]),
  };
}

/** CreateIdempotent for `owner`'s associated token account (payer pays the rent if missing). */
export function createAtaIdempotentInstruction(
  payer: string,
  owner: string,
  mint: string,
): TransactionInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      s(payer, true),
      w(associatedTokenAddress(owner, mint)),
      r(owner),
      r(mint),
      r(SYSTEM_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.of(1),
  };
}
