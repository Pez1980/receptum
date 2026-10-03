import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { receiptBytes, receiptHash, type DeliveryReceipt } from "./receipt.js";
import type { Sha256Hex } from "./hash.js";

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
}

/**
 * Signs a receipt as the seller. The signed payload is the JCS bytes of the
 * receipt; `receipt.seller.id` must be the signer's did:key.
 */
export function signReceipt(receipt: DeliveryReceipt, key: SellerKey): SignedReceipt {
  if (receipt.seller.id !== key.did) {
    throw new Error("receipt.seller.id must equal the signing key's did:key");
  }
  const kid = `${key.did}#${key.did.slice("did:key:".length)}`;
  const header = b64u(JSON.stringify({ alg: "EdDSA", kid, typ: "receptum+jws" }));
  const payload = b64u(receiptBytes(receipt));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key.privateKey);
  return {
    receipt,
    receiptHash: receiptHash(receipt),
    proof: { type: "jws", kid, jws: `${header}..${b64u(signature)}` },
  };
}

export type VerifyResult =
  { ok: true; seller: string; receiptHash: Sha256Hex } | { ok: false; reason: string };

/** Verifies a signed receipt offline: structure, hash, and the seller's signature. */
export function verifySignedReceipt(signed: SignedReceipt): VerifyResult {
  try {
    const hash = receiptHash(signed.receipt);
    if (hash !== signed.receiptHash)
      return { ok: false, reason: "receiptHash does not match the receipt" };
    if (signed.proof?.type !== "jws") return { ok: false, reason: "unsupported proof type" };
    const [header, empty, sig] = signed.proof.jws.split(".");
    if (!header || empty !== "" || !sig) return { ok: false, reason: "malformed detached JWS" };
    const h = JSON.parse(Buffer.from(header, "base64url").toString()) as {
      alg?: string;
      kid?: string;
    };
    if (h.alg !== "EdDSA") return { ok: false, reason: "unsupported alg" };
    if (h.kid !== signed.proof.kid) return { ok: false, reason: "kid mismatch" };
    const did = signed.proof.kid.split("#")[0] ?? "";
    if (did !== signed.receipt.seller.id)
      return { ok: false, reason: "signer is not the receipt's seller" };
    const payload = b64u(receiptBytes(signed.receipt));
    const valid = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKeyFromDidKey(did),
      Buffer.from(sig, "base64url"),
    );
    return valid
      ? { ok: true, seller: did, receiptHash: hash }
      : { ok: false, reason: "bad signature" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
