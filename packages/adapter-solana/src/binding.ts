import { createHash, createPublicKey, verify } from "node:crypto";
import type { AccountSigner, BindingVerifier } from "@receptum/core";
import { addressBytes } from "./address.js";
import { isSolanaAddress } from "./base58.js";
import { isSolanaNetwork, SOLANA_DEVNET } from "./network.js";
import type { SolanaKeypair } from "./transaction.js";

/**
 * Account bindings for `solana:*` accounts (SPEC §4.1), domain-separated like SEP-53:
 * `accountProof = { type: "solana", signature }`, an Ed25519 signature by the account's own key
 * over SHA-256("Solana Signed Message:\n" ‖ m), where m = UTF-8(JCS(statement)). `signature` is
 * the 64 bytes in standard padded base64. The key is the account's address itself, so the check
 * is offline. The prefix and the hash make the signed bytes unusable as a Solana transaction
 * message (which a wallet would also refuse to sign blind) or as any other Receptum statement.
 */
export const SOLANA_BINDING_PREFIX = "Solana Signed Message:\n";
export const SOLANA_PROOF_TYPE = "solana";

/** The 32 bytes the account key signs for binding message `m`. */
export function solanaBindingDigest(message: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(SOLANA_BINDING_PREFIX).update(message).digest(),
  );
}

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const CANONICAL_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** Verifies `solana` proofs against the account's address (its Ed25519 public key). Offline. */
export const solanaBindingVerifier: BindingVerifier = {
  namespace: "solana",
  verifyProof(account, message, proof) {
    if (proof.type !== SOLANA_PROOF_TYPE) return { ok: false, reason: "expected a solana proof" };
    if (Object.keys(proof).sort().join(",") !== "signature,type")
      return { ok: false, reason: "unexpected solana proof members" };
    const i = account.lastIndexOf(":");
    const network = account.slice(0, i);
    const address = account.slice(i + 1);
    if (!isSolanaNetwork(network) || !isSolanaAddress(address))
      return { ok: false, reason: "account is not a solana:<genesis>:<base58 address> account" };
    if (typeof proof.signature !== "string" || !CANONICAL_B64.test(proof.signature))
      return { ok: false, reason: "signature must be 64 bytes, base64" };
    const sig = Buffer.from(proof.signature, "base64");
    if (sig.toString("base64") !== proof.signature)
      return { ok: false, reason: "non-canonical base64 signature" };
    // S < L (RFC 8032 §5.1.7); node's verify also enforces it, checked here explicitly.
    let s = 0n;
    for (let k = 63; k >= 32; k--) s = (s << 8n) | BigInt(sig[k]!);
    if (s >= 2n ** 252n + 27742317777372353535851770400913936493n)
      return { ok: false, reason: "non-canonical signature (S >= L)" };
    let key;
    try {
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI, addressBytes(address)]),
        format: "der",
        type: "spki",
      });
    } catch {
      return { ok: false, reason: "address is not an Ed25519 public key" };
    }
    return verify(null, solanaBindingDigest(message), key, sig)
      ? { ok: true, detail: `Ed25519 signature by ${address}` }
      : { ok: false, reason: "bad signature" };
  },
};

/** Signs bindings with a Solana keypair. The secret never leaves the keypair object. */
export function solanaAccountSigner(
  keypair: SolanaKeypair,
  network = SOLANA_DEVNET,
): AccountSigner {
  if (!isSolanaNetwork(network)) throw new TypeError(`not a Solana CAIP-2 id: ${network}`);
  return {
    account: `${network}:${keypair.address}`,
    signBinding: (message) => ({
      type: SOLANA_PROOF_TYPE,
      signature: Buffer.from(keypair.sign(solanaBindingDigest(message))).toString("base64"),
    }),
  };
}
