import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { receiptBytes, receiptHash, type DeliveryReceipt } from "./receipt.js";
import { isSha256Hex, type Sha256Hex } from "./hash.js";
import { parseStrictJsonBytes } from "./json.js";
import type { AccountBinding } from "./binding.js";

// ─── base58btc / base64url ─────────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btcEncode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58btcDecode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new TypeError("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const b64u = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const B64U = /^[A-Za-z0-9_-]+$/;

// ─── did:key (Ed25519) ─────────────────────────────────────────────────────

const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function didKeyFromPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(ED25519_SPKI_PREFIX.length);
  return `did:key:z${base58btcEncode(Buffer.concat([ED25519_MULTICODEC, raw]))}`;
}

export function publicKeyFromDidKey(did: string): KeyObject {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did.split("#")[0] ?? "");
  if (!m?.[1]) throw new TypeError("not a did:key");
  const bytes = base58btcDecode(m[1]);
  if (bytes[0] !== 0xed || bytes[1] !== 0x01 || bytes.length !== 34) {
    throw new TypeError("only Ed25519 did:key is supported");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(2)]),
    format: "der",
    type: "spki",
  });
}

/** KeyObject for a raw 32-byte Ed25519 public key. */
export function ed25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new TypeError("Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export interface SellerKey {
  did: string;
  privateKey: KeyObject;
}

/** Generates a fresh Ed25519 seller key. Store the PKCS#8 PEM securely; never commit it. */
export function generateSellerKey(): SellerKey & { privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    did: didKeyFromPublicKey(publicKey),
    privateKey,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

// DER prefix of an Ed25519 PKCS#8 private key; the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Builds a seller key from a 32-byte Ed25519 seed (used for published test vectors). */
export function sellerKeyFromSeed(seed: Uint8Array): SellerKey {
  if (seed.length !== 32) throw new TypeError("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { did: didKeyFromPublicKey(createPublicKey(privateKey)), privateKey };
}

export function sellerKeyFromPem(pem: string): SellerKey {
  const privateKey = createPrivateKey(pem);
  return { did: didKeyFromPublicKey(createPublicKey(privateKey)), privateKey };
}

// ─── Signed receipts (detached JWS, RFC 7515 + RFC 7797-style detached payload) ─

export interface JwsProof {
  type: "jws";
  /** Verification method: the seller's did:key with a fragment. */
  kid: string;
  /** Compact JWS with a detached payload: `<header>..<signature>`. */
  jws: string;
}

export interface SignedReceipt {
  receipt: DeliveryReceipt;
  receiptHash: Sha256Hex;
  proof: JwsProof;
  /**
   * Account bindings (SPEC §4.1) proving the seller's did:key also controls its payout account(s).
   * Carried beside the receipt, not inside it: they are not part of `receiptHash`.
   */
  bindings?: AccountBinding[];
}

const kidFor = (did: string) => `${did}#${did.slice("did:key:".length)}`;

/** Detached compact JWS (`<header>..<signature>`) over `payload` with the given `typ`. */
export function signDetachedJws(payload: string, key: SellerKey, typ: string): JwsProof {
  const kid = kidFor(key.did);
  const header = b64u(JSON.stringify({ alg: "EdDSA", kid, typ }));
  const signature = sign(null, Buffer.from(`${header}.${b64u(payload)}`), key.privateKey);
  return { type: "jws", kid, jws: `${header}..${b64u(signature)}` };
}

// Order of the Ed25519 base point (RFC 8032 §5.1); a canonical signature has S < L.
const ED25519_L = 2n ** 252n + 27742317777372353535851770400913936493n;

/** True when the 64-byte Ed25519 signature's S (little-endian, second half) is below L. */
export function isCanonicalEd25519Signature(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
  return s < ED25519_L;
}

/**
 * Verifies a detached JWS made by `signDetachedJws` (SPEC §4): `proof` has exactly `type`,
 * `kid`, `jws`; unpadded canonical base64url segments; an I-JSON header with exactly `alg`,
 * `kid`, `typ` and no duplicate members; the expected `typ`; header `kid` = `proof.kid` =
 * `<did>#<multibase>` for the Ed25519 `expectedDid`; a 64-byte signature with S < L.
 */
export function verifyDetachedJws(
  proof: JwsProof,
  payload: string,
  expectedDid: string,
  typ: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof))
    return { ok: false, reason: "proof must be an object" };
  if (Object.keys(proof).sort().join(",") !== "jws,kid,type")
    return { ok: false, reason: "proof members must be exactly type, kid, jws" };
  if (proof.type !== "jws") return { ok: false, reason: "unsupported proof type" };
  if (typeof proof.jws !== "string" || typeof proof.kid !== "string")
    return { ok: false, reason: "malformed detached JWS" };
  const parts = proof.jws.split(".");
  if (parts.length !== 3 || parts[1] !== "") return { ok: false, reason: "malformed detached JWS" };
  const [header, , sig] = parts as [string, string, string];
  if (!B64U.test(header) || !B64U.test(sig))
    return { ok: false, reason: "JWS segments must be base64url" };
  if (b64u(Buffer.from(header, "base64url")) !== header)
    return { ok: false, reason: "non-canonical base64url header" };
  let h: Record<string, unknown>;
  try {
    const parsed = parseStrictJsonBytes(Buffer.from(header, "base64url"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ok: false, reason: "JWS header must be a JSON object" };
    h = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `JWS header is not I-JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const keys = Object.keys(h).sort().join(",");
  if (keys !== "alg,kid,typ") return { ok: false, reason: "unexpected JWS header parameters" };
  if (h.alg !== "EdDSA") return { ok: false, reason: "unsupported alg" };
  if (h.typ !== typ) return { ok: false, reason: "unexpected typ" };
  if (h.kid !== proof.kid) return { ok: false, reason: "kid mismatch" };
  const kidParts = proof.kid.split("#");
  const [did, fragment] = kidParts;
  if (kidParts.length !== 2 || !did || fragment !== did.slice("did:key:".length))
    return { ok: false, reason: "kid must be <did>#<multibase key>" };
  const sigBytes = Buffer.from(sig, "base64url");
  if (sigBytes.length !== 64 || b64u(sigBytes) !== sig)
    return { ok: false, reason: "non-canonical signature encoding" };
  if (!isCanonicalEd25519Signature(sigBytes))
    return { ok: false, reason: "non-canonical Ed25519 signature (S >= L)" };
  if (did !== expectedDid) return { ok: false, reason: "signer is not the expected did" };
  const valid = verify(
    null,
    Buffer.from(`${header}.${b64u(payload)}`),
    publicKeyFromDidKey(did),
    sigBytes,
  );
  return valid ? { ok: true } : { ok: false, reason: "bad signature" };
}

/**
 * Signs a receipt as the seller. The signed payload is the JCS bytes of the
 * receipt; `receipt.seller.id` must be the signer's did:key.
 */
export function signReceipt(receipt: DeliveryReceipt, key: SellerKey): SignedReceipt {
  if (receipt.seller.id !== key.did) {
    throw new Error("receipt.seller.id must equal the signing key's did:key");
  }
  return {
    receipt,
    receiptHash: receiptHash(receipt),
    proof: signDetachedJws(receiptBytes(receipt), key, RECEIPT_JWS_TYP),
  };
}

export const RECEIPT_JWS_TYP = "receptum+jws";

export type VerifyResult =
  { ok: true; seller: string; receiptHash: Sha256Hex } | { ok: false; reason: string };

const ENVELOPE_MEMBERS = ["bindings", "proof", "receipt", "receiptHash"];

/**
 * Checks the signed-receipt envelope (SPEC §4): exactly `receipt`, `receiptHash` (hex64),
 * `proof` and an optional `bindings` array (`null` and `[]` count as absent).
 */
export function signedReceiptEnvelopeError(signed: unknown): string | null {
  if (typeof signed !== "object" || signed === null || Array.isArray(signed))
    return "signed receipt must be an object";
  const s = signed as Record<string, unknown>;
  const extra = Object.keys(s).filter((k) => !ENVELOPE_MEMBERS.includes(k));
  if (extra.length) return `signed receipt has unknown members: ${extra.join(", ")}`;
  for (const k of ["receipt", "receiptHash", "proof"])
    if (!Object.hasOwn(s, k)) return `signed receipt is missing ${k}`;
  if (!isSha256Hex(s.receiptHash)) return "receiptHash must be 64 lower-case hex characters";
  if (s.bindings !== undefined && s.bindings !== null && !Array.isArray(s.bindings))
    return "bindings must be an array";
  return null;
}

/** Verifies a signed receipt offline: envelope, structure, hash, and the seller's signature. */
export function verifySignedReceipt(signed: SignedReceipt): VerifyResult {
  try {
    const envelope = signedReceiptEnvelopeError(signed);
    if (envelope) return { ok: false, reason: envelope };
    const hash = receiptHash(signed.receipt);
    if (hash !== signed.receiptHash)
      return { ok: false, reason: "receiptHash does not match the receipt" };
    const did = signed.receipt.seller.id;
    if (!did.startsWith("did:key:"))
      return {
        ok: false,
        reason:
          "seller.id is not an Ed25519 did:key; RRF v1 defines no proof a CAIP-10 seller can sign",
      };
    const res = verifyDetachedJws(signed.proof, receiptBytes(signed.receipt), did, RECEIPT_JWS_TYP);
    if (!res.ok)
      return {
        ok: false,
        reason:
          res.reason === "signer is not the expected did"
            ? "signer is not the receipt's seller"
            : res.reason,
      };
    return { ok: true, seller: did, receiptHash: hash };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
