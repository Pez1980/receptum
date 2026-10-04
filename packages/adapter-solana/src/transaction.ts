import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { addressBytes } from "./address.js";
import { encodeBase58 } from "./base58.js";
import type { SolanaRpc } from "./rpc.js";

/** An Ed25519 keypair. The secret never leaves the process and is never serialized. */
export interface SolanaKeypair {
  readonly address: string;
  sign(message: Uint8Array): Uint8Array;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A keypair from the 64-byte Solana CLI secret (`[seed ‖ public key]`, the JSON array in a
 * keypair file) or a 32-byte seed. The public half, when given, must match the seed.
 */
export function solanaKeypair(secret: Uint8Array | readonly number[]): SolanaKeypair {
  const bytes = Uint8Array.from(secret);
  if (bytes.length !== 64 && bytes.length !== 32)
    throw new TypeError("Solana secret key must be 64 bytes (or a 32-byte seed)");
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, bytes.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  const pub = Buffer.from(jwk.x ?? "", "base64url");
  if (bytes.length === 64 && !pub.equals(Buffer.from(bytes.subarray(32))))
    throw new TypeError("Solana secret key: public half does not match the seed");
  const address = encodeBase58(pub);
  return {
    address,
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

export interface AccountMeta {
  address: string;
  signer: boolean;
  writable: boolean;
}

export interface TransactionInstruction {
  programId: string;
  accounts: AccountMeta[];
  data: Uint8Array;
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return out;
  }
}

/**
 * Compiles a legacy transaction message: fee payer first, then writable signers, readonly
 * signers, writable non-signers, readonly non-signers (program ids are readonly non-signers).
 */
export function compileMessage(
  feePayer: string,
  instructions: readonly TransactionInstruction[],
  recentBlockhash: string,
): { message: Uint8Array; signers: string[] } {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (address: string, signer: boolean, writable: boolean) => {
    const m = metas.get(address);
    metas.set(address, {
      signer: signer || (m?.signer ?? false),
      writable: writable || (m?.writable ?? false),
    });
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const a of ix.accounts) add(a.address, a.signer, a.writable);
    add(ix.programId, false, false);
  }
  const all = [...metas.entries()];
  const rank = ([k, m]: [string, { signer: boolean; writable: boolean }]) =>
    k === feePayer ? 0 : m.signer ? (m.writable ? 1 : 2) : m.writable ? 3 : 4;
  all.sort((a, b) => rank(a) - rank(b));
  const keys = all.map(([k]) => k);
  const numSigners = all.filter(([, m]) => m.signer).length;
  const numReadonlySigned = all.filter(([, m]) => m.signer && !m.writable).length;
  const numReadonlyUnsigned = all.filter(([, m]) => !m.signer && !m.writable).length;
  const out: number[] = [numSigners, numReadonlySigned, numReadonlyUnsigned];
  out.push(...compactU16(keys.length));
  for (const k of keys) out.push(...addressBytes(k));
  out.push(...addressBytes(recentBlockhash));
  out.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.programId));
    out.push(...compactU16(ix.accounts.length));
    for (const a of ix.accounts) out.push(keys.indexOf(a.address));
    out.push(...compactU16(ix.data.length));
    out.push(...ix.data);
  }
  return { message: Uint8Array.from(out), signers: keys.slice(0, numSigners) };
}

/** Signs a compiled message with every required signer and serializes the transaction. */
export function signTransaction(
  message: Uint8Array,
  signerOrder: readonly string[],
  keypairs: readonly SolanaKeypair[],
): { wire: Uint8Array; signature: string } {
  const sigs = signerOrder.map((addr) => {
    const kp = keypairs.find((k) => k.address === addr);
    if (!kp) throw new Error(`missing signer ${addr}`);
    return kp.sign(message);
  });
  const wire = Uint8Array.from([
    ...compactU16(sigs.length),
    ...sigs.flatMap((s) => [...s]),
    ...message,
  ]);
  return { wire, signature: encodeBase58(sigs[0]!) };
}

export class SolanaTxError extends Error {
  constructor(
    message: string,
    readonly signature?: string,
    readonly logs?: string[],
  ) {
    super(message);
    this.name = "SolanaTxError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds, signs, sends and waits for a transaction to be `confirmed` (or `finalized`).
 * Throws `SolanaTxError` when it fails or is not confirmed before its blockhash expires.
 */
export async function sendAndConfirm(
  rpc: SolanaRpc,
  feePayer: SolanaKeypair,
  instructions: readonly TransactionInstruction[],
  extraSigners: readonly SolanaKeypair[] = [],
  options: { commitment?: "confirmed" | "finalized"; timeoutMs?: number } = {},
): Promise<{ signature: string; slot: number }> {
  const { value } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  const { message, signers } = compileMessage(feePayer.address, instructions, value.blockhash);
  const { wire, signature } = signTransaction(message, signers, [feePayer, ...extraSigners]);
  const wire64 = Buffer.from(wire).toString("base64");
  await rpc("sendTransaction", [
    wire64,
    { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 },
  ]);
  const want = options.commitment ?? "confirmed";
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await sleep(1500);
    const st = (await rpc("getSignatureStatuses", [[signature]])) as {
      value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[];
    };
    const s = st.value[0];
    if (s?.err)
      throw new SolanaTxError(
        `transaction ${signature} failed: ${JSON.stringify(s.err)}`,
        signature,
      );
    if (s && (s.confirmationStatus === want || s.confirmationStatus === "finalized"))
      return { signature, slot: s.slot };
    const height = (await rpc("getBlockHeight", [{ commitment: "confirmed" }])) as number;
    if (height > value.lastValidBlockHeight && !s)
      throw new SolanaTxError(`transaction ${signature} expired before confirmation`, signature);
  }
  throw new SolanaTxError(`transaction ${signature} not ${want} in time`, signature);
}
