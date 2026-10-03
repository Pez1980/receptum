import { createHash, sign, verify } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { compareTimestamps, isCaip10, isUtcTimestamp } from "./receipt.js";
import {
  ed25519PublicKeyFromRaw,
  sellerKeyFromSeed,
  signDetachedJws,
  verifyDetachedJws,
  type JwsProof,
  type SellerKey,
  type SignedReceipt,
} from "./signing.js";

/**
 * Account binding attestations (SPEC §4.1): a statement signed by BOTH the seller's did:key and
 * the payout account's own chain key, proving one party controls both.
 */
export const ACCOUNT_BINDING_TYPE = "receptum/account-binding/1" as const;
/** JWS `typ` of the did:key signature over a binding statement. */
export const BINDING_JWS_TYP = "receptum-binding+jws";
/** Allowed clock skew for `issuedAt` in the future. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** Bindings examined per receipt — verifiers MAY stop after the first 16 (SPEC §4). */
export const MAX_BINDINGS = 16;

export interface AccountBindingStatement {
  type: typeof ACCOUNT_BINDING_TYPE;
  /** The seller's did:key (the receipt signer). */
  did: string;
  /** CAIP-10 payout account, e.g. `eip155:84532:0x…`, `xrpl:1:r…`, `stellar:testnet:G…`. */
  account: string;
  /** When the binding was made (strict UTC timestamp, SPEC §2). */
  issuedAt: string;
  /** Optional expiry; receipts delivered at or after it are not covered. */
  expiresAt?: string;
}

/** The payout account's signature over the statement's JCS bytes. Shape depends on `type`. */
export interface AccountProof {
  /** `eip191` (eip155), `xrpl` (xrpl), `sep53` (stellar). */
  type: string;
  signature: string;
  /** Signing public key, where the address alone doesn't reveal it (XRPL). */
  publicKey?: string;
}

export interface AccountBinding {
  statement: AccountBindingStatement;
  /** Detached JWS by `statement.did` over JCS(statement), `typ` = `receptum-binding+jws`. */
  didProof: JwsProof;
  accountProof: AccountProof;
}

const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;
const STATEMENT_MEMBERS = ["type", "did", "account", "issuedAt", "expiresAt"];

/** Validates a binding statement exactly (only the listed members, correct types, no nulls). */
export function assertValidBindingStatement(statement: AccountBindingStatement): void {
  const fail = (msg: string): never => {
    throw new TypeError(`invalid account binding: ${msg}`);
  };
  const s = statement as unknown as Record<string, unknown>;
  if (typeof s !== "object" || s === null || Array.isArray(s)) fail("statement must be an object");
  const proto = Object.getPrototypeOf(s);
  if (proto !== Object.prototype && proto !== null) fail("statement must be a plain object");
  for (const k of Object.keys(s)) {
    if (!STATEMENT_MEMBERS.includes(k)) fail(`statement.${k} is not allowed`);
    if (typeof s[k] !== "string") fail(`statement.${k} must be a string`);
  }
  if (s.type !== ACCOUNT_BINDING_TYPE) fail("unknown statement type");
  if (!DID_KEY.test(s.did as string)) fail("did must be a did:key");
  if (!isCaip10(s.account)) fail("account must be a CAIP-10 account");
  if (typeof s.issuedAt !== "string" || !isUtcTimestamp(s.issuedAt)) fail("issuedAt");
  if (s.expiresAt !== undefined) {
    if (!isUtcTimestamp(s.expiresAt as string)) fail("expiresAt");
    if (compareTimestamps(s.expiresAt as string, s.issuedAt as string) <= 0)
      fail("expiresAt must be after issuedAt");
  }
}

/** JCS (RFC 8785) of the statement — what both keys sign. */
export function bindingBytes(statement: AccountBindingStatement): string {
  assertValidBindingStatement(statement);
  return canonicalJson(statement);
}

/** UTF-8 bytes of `bindingBytes(statement)`: the message every chain key signs. */
export function bindingMessage(statement: AccountBindingStatement): Uint8Array {
  return new TextEncoder().encode(bindingBytes(statement));
}

// ─── Chain-agnostic signer / verifier interfaces ─────────────────────────────

/** Signs binding messages with a payout account's chain key. Adapters provide these. */
export interface AccountSigner {
  /** CAIP-10 account being bound. */
  account: string;
  signBinding(message: Uint8Array): AccountProof | Promise<AccountProof>;
}

export type BindingProofResult = { ok: true; detail: string } | { ok: false; reason: string };

/** Verifies account proofs for one CAIP-2 namespace (`eip155`, `xrpl`, `stellar`…). Offline. */
export interface BindingVerifier {
  namespace: string;
  verifyProof(account: string, message: Uint8Array, proof: AccountProof): BindingProofResult;
  /** Canonical comparison form of a CAIP-10 account (e.g. lower-case EVM). Default: as is. */
  normalize?(account: string): string;
}

const registry = new Map<string, BindingVerifier>();

/** Registers (or replaces) the process-wide verifier for a namespace. */
export function registerBindingVerifier(verifier: BindingVerifier): void {
  registry.set(verifier.namespace, verifier);
}

const namespaceOf = (caip10: string) => caip10.slice(0, caip10.indexOf(":"));

function verifierFor(
  account: string,
  extra?: readonly BindingVerifier[],
): BindingVerifier | undefined {
  const ns = namespaceOf(account);
  return (
    extra?.find((v) => v.namespace === ns) ??
    registry.get(ns) ??
    (ns === "stellar" ? stellarBindingVerifier : undefined)
  );
}

/** Compares two CAIP-10 accounts using the namespace's normalization. */
export function sameAccount(a: string, b: string, verifiers?: readonly BindingVerifier[]): boolean {
  if (namespaceOf(a) !== namespaceOf(b)) return false;
  const norm = verifierFor(a, verifiers)?.normalize ?? ((x: string) => x);
  return norm(a) === norm(b);
}

// ─── Create / verify ─────────────────────────────────────────────────────────

/** Builds a binding signed by both the seller's did:key and the payout account's key. */
export async function createAccountBinding(options: {
  key: SellerKey;
  signer: AccountSigner;
  issuedAt?: Date;
  expiresAt?: Date;
}): Promise<AccountBinding> {
  const statement: AccountBindingStatement = {
    type: ACCOUNT_BINDING_TYPE,
    did: options.key.did,
    account: options.signer.account,
    issuedAt: (options.issuedAt ?? new Date()).toISOString(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt.toISOString() } : {}),
  };
  const bytes = bindingBytes(statement);
  return {
    statement,
    didProof: signDetachedJws(bytes, options.key, BINDING_JWS_TYP),
    accountProof: await options.signer.signBinding(new TextEncoder().encode(bytes)),
  };
}

export interface BindingVerifyOptions {
  /** Verifiers to use before the process-wide registry. */
  verifiers?: readonly BindingVerifier[];
  /**
   * The binding must not have expired at this time. Default: now. A SPEC §2.2 timestamp string
   * (e.g. a receipt's `deliveredAt`) is compared exactly, at full fractional precision.
   */
  at?: Date | string;
  /** Current time, for rejecting future-dated bindings. Default: now. */
  now?: Date;
}

export type BindingResult =
  { ok: true; did: string; account: string; detail: string } | { ok: false; reason: string };

/** Verifies both signatures of a binding and its validity window. Offline. */
export function verifyAccountBinding(
  binding: AccountBinding,
  options: BindingVerifyOptions = {},
): BindingResult {
  try {
    if (typeof binding !== "object" || binding === null)
      return { ok: false, reason: "binding must be an object" };
    const extra = Object.keys(binding).filter(
      (k) => !["statement", "didProof", "accountProof"].includes(k),
    );
    if (extra.length) return { ok: false, reason: `unexpected binding members: ${extra}` };
    const { statement, didProof, accountProof } = binding;
    const bytes = bindingBytes(statement);
    const now = (options.now ?? new Date()).getTime();
    const latest = new Date(now + MAX_FUTURE_SKEW_MS).toISOString();
    const at =
      typeof options.at === "string" ? options.at : (options.at ?? new Date(now)).toISOString();
    if (compareTimestamps(statement.issuedAt, latest) > 0)
      return { ok: false, reason: "binding is issued in the future" };
    if (statement.expiresAt && compareTimestamps(at, statement.expiresAt) >= 0)
      return { ok: false, reason: `binding expired at ${statement.expiresAt}` };
    const jws = verifyDetachedJws(didProof, bytes, statement.did, BINDING_JWS_TYP);
    if (!jws.ok) return { ok: false, reason: `did signature: ${jws.reason}` };
    const verifier = verifierFor(statement.account, options.verifiers);
    if (!verifier)
      return {
        ok: false,
        reason: `no binding verifier for namespace ${namespaceOf(statement.account)}`,
      };
    if (typeof accountProof !== "object" || accountProof === null)
      return { ok: false, reason: "accountProof must be an object" };
    const res = verifier.verifyProof(
      statement.account,
      new TextEncoder().encode(bytes),
      accountProof,
    );
    if (!res.ok) return { ok: false, reason: `account signature: ${res.reason}` };
    return { ok: true, did: statement.did, account: statement.account, detail: res.detail };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export type PayeeBindingResult =
  { ok: true; binding: AccountBinding; detail: string } | { ok: false; reason: string };

/**
 * Checks that `signed.bindings` holds a valid binding between the receipt's seller and its
 * `payment.payee`, unexpired at `deliveredAt`. Offline. Does not verify the receipt signature
 * itself (use `verifySignedReceipt`).
 */
export function checkPayeeBinding(
  signed: SignedReceipt,
  options: Omit<BindingVerifyOptions, "at"> = {},
): PayeeBindingResult {
  const payee = signed.receipt?.payment?.payee;
  if (!payee) return { ok: false, reason: "receipt names no payee" };
  const seller = signed.receipt.seller.id;
  const bindings = signed.bindings;
  // null and [] are the same as no bindings at all (SPEC §4).
  if (bindings === undefined || bindings === null || (Array.isArray(bindings) && !bindings.length))
    return { ok: false, reason: "receipt carries no account bindings" };
  if (!Array.isArray(bindings)) return { ok: false, reason: "bindings must be an array" };
  if (!verifierFor(payee, options.verifiers))
    return { ok: false, reason: `no binding verifier for namespace ${namespaceOf(payee)}` };
  const candidates = bindings
    .slice(0, MAX_BINDINGS)
    .filter(
      (b) =>
        typeof b?.statement?.account === "string" &&
        b.statement.did === seller &&
        sameAccount(b.statement.account, payee, options.verifiers),
    );
  if (!candidates.length) return { ok: false, reason: `no binding of ${seller} to ${payee}` };
  const reasons: string[] = [];
  for (const b of candidates) {
    const res = verifyAccountBinding(b, { ...options, at: signed.receipt.deliveredAt });
    if (res.ok) return { ok: true, binding: b, detail: res.detail };
    reasons.push(res.reason);
  }
  return { ok: false, reason: reasons.join("; ") };
}

// ─── Stellar (SEP-53), built in: the G… address is the Ed25519 public key ────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STRKEY_ACCOUNT = 6 << 3; // 'G'
const STRKEY_SEED = 18 << 3; // 'S'
const SEP53_PREFIX = "Stellar Signed Message:\n";

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Decodes a 56-character Stellar StrKey (G… / S…) to its 32-byte payload. */
export function decodeStrKey(text: string, version: "account" | "seed"): Uint8Array {
  if (!/^[A-Z2-7]{56}$/.test(text)) throw new TypeError("not a Stellar StrKey");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new TypeError("non-canonical StrKey");
  const bytes = Uint8Array.from(out);
  if (bytes.length !== 35) throw new TypeError("StrKey has the wrong length");
  const want = version === "account" ? STRKEY_ACCOUNT : STRKEY_SEED;
  if (bytes[0] !== want) throw new TypeError(`StrKey is not a ${version} key`);
  const crc = crc16xmodem(bytes.subarray(0, 33));
  if ((bytes[33]! | (bytes[34]! << 8)) !== crc) throw new TypeError("StrKey checksum mismatch");
  return bytes.slice(1, 33);
}

/** Encodes a 32-byte Ed25519 public key as a Stellar G… address. */
export function encodeStellarAccount(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new TypeError("Ed25519 public key must be 32 bytes");
  const body = Uint8Array.from([STRKEY_ACCOUNT, ...publicKey]);
  const crc = crc16xmodem(body);
  const bytes = Uint8Array.from([...body, crc & 0xff, crc >> 8]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const sep53Hash = (message: Uint8Array) =>
  createHash("sha256").update(SEP53_PREFIX).update(message).digest();

const CANONICAL_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** Verifies SEP-53 (`sep53`) proofs for `stellar:*` accounts against the G… key itself. */
export const stellarBindingVerifier: BindingVerifier = {
  namespace: "stellar",
  verifyProof(account, message, proof) {
    if (proof.type !== "sep53") return { ok: false, reason: "expected a sep53 proof" };
    if (Object.keys(proof).sort().join(",") !== "signature,type")
      return { ok: false, reason: "unexpected sep53 proof members" };
    if (typeof proof.signature !== "string" || !CANONICAL_B64.test(proof.signature))
      return { ok: false, reason: "signature must be 64 bytes, base64" };
    const sig = Buffer.from(proof.signature, "base64");
    if (sig.toString("base64") !== proof.signature)
      return { ok: false, reason: "non-canonical base64 signature" };
    const address = account.slice(account.lastIndexOf(":") + 1);
    const key = ed25519PublicKeyFromRaw(decodeStrKey(address, "account"));
    return verify(null, sep53Hash(message), key, sig)
      ? { ok: true, detail: `SEP-53 signature by ${address}` }
      : { ok: false, reason: "bad signature" };
  },
};

/** Signs bindings with a Stellar account's secret seed (S…). The seed never leaves the process. */
export function stellarAccountSigner(secret: string, network = "stellar:testnet"): AccountSigner {
  const seed = decodeStrKey(secret, "seed");
  const { privateKey } = sellerKeyFromSeed(seed);
  const pub = createPublicKeyRaw(privateKey);
  return {
    account: `${network}:${encodeStellarAccount(pub)}`,
    signBinding: (message) => ({
      type: "sep53",
      signature: sign(null, sep53Hash(message), privateKey).toString("base64"),
    }),
  };
}

function createPublicKeyRaw(privateKey: SellerKey["privateKey"]): Uint8Array {
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url");
}
