// Account bindings (SPEC §4.1) for xrpl accounts, signed with ripple-keypairs over JCS(statement).
import {
  isCanonicalEd25519Signature,
  type AccountProof,
  type AccountSigner,
  type BindingVerifier,
} from "@receptum/core";
import { deriveAddress, sign, verify } from "ripple-keypairs";
import type { Client, Wallet } from "xrpl";
import { XRPL_TESTNET } from "./ledger.js";

const PUBLIC_KEY = /^(ED[0-9A-F]{64}|0[23][0-9A-F]{64})$/;
const SIGNATURE = /^[0-9A-F]{16,144}$/;
const LSF_DISABLE_MASTER = 0x00100000;

// secp256k1 group order; a canonical (low-s) signature has s <= n/2.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Strict DER ECDSA-Sig-Value (SPEC §4.1): SEQUENCE of two minimal, positive INTEGERs with no
 * trailing data, 1 <= r, s < n, and low-s (s <= n/2). Returns a reason, or null when canonical.
 */
export function xrplSecp256k1SignatureError(der: Uint8Array): string | null {
  const integer = (i: number): [bigint, number] | string => {
    if (i + 2 > der.length || der[i] !== 0x02) return "expected a DER INTEGER";
    const len = der[i + 1]!;
    if (len === 0 || len > 33 || i + 2 + len > der.length) return "bad DER INTEGER length";
    const body = der.subarray(i + 2, i + 2 + len);
    if (body[0]! & 0x80) return "negative DER INTEGER";
    if (len > 1 && body[0] === 0 && !(body[1]! & 0x80)) return "non-minimal DER INTEGER";
    let v = 0n;
    for (const b of body) v = (v << 8n) | BigInt(b);
    return [v, i + 2 + len];
  };
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2)
    return "not a DER SEQUENCE";
  const r = integer(2);
  if (typeof r === "string") return r;
  const s = integer(r[1]);
  if (typeof s === "string") return s;
  if (s[1] !== der.length) return "trailing bytes after the DER signature";
  if (r[0] < 1n || r[0] >= SECP256K1_N || s[0] < 1n || s[0] >= SECP256K1_N)
    return "signature r or s is out of range";
  if (s[0] > SECP256K1_N / 2n) return "signature is not low-s (not fully canonical)";
  return null;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex").toUpperCase();
const addressOf = (account: string) => account.slice(account.lastIndexOf(":") + 1);

type KeyPolicy = (
  address: string,
  keyAddress: string,
) => { ok: true; detail: string } | { ok: false; reason: string };

function makeVerifier(policy: KeyPolicy): BindingVerifier {
  return {
    namespace: "xrpl",
    verifyProof(account, message, proof) {
      if (proof.type !== "xrpl") return { ok: false, reason: "expected an xrpl proof" };
      if (Object.keys(proof).sort().join(",") !== "publicKey,signature,type")
        return { ok: false, reason: "unexpected xrpl proof members" };
      if (typeof proof.publicKey !== "string" || !PUBLIC_KEY.test(proof.publicKey))
        return { ok: false, reason: "publicKey must be 33 bytes, upper-case hex" };
      if (typeof proof.signature !== "string" || !SIGNATURE.test(proof.signature))
        return { ok: false, reason: "signature must be upper-case hex" };
      const sig = Buffer.from(proof.signature, "hex");
      if (proof.publicKey.startsWith("ED")) {
        if (sig.length !== 64) return { ok: false, reason: "Ed25519 signature must be 64 bytes" };
        if (!isCanonicalEd25519Signature(sig))
          return { ok: false, reason: "non-canonical Ed25519 signature (S >= L)" };
      } else {
        const bad = xrplSecp256k1SignatureError(sig);
        if (bad) return { ok: false, reason: bad };
      }
      let valid: boolean;
      try {
        valid = verify(hex(message), proof.signature, proof.publicKey);
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: "bad signature" };
      return policy(addressOf(account), deriveAddress(proof.publicKey));
    },
  };
}

/**
 * Offline `xrpl` verifier: the signature must verify AND the public key must be the account's
 * master key (it derives to the address). Regular-key bindings fail here — check them online with
 * `xrplOnlineBindingVerifier`. Offline cannot see whether the master key was later disabled.
 */
export const xrplBindingVerifier: BindingVerifier = makeVerifier((address, keyAddress) =>
  keyAddress === address
    ? {
        ok: true,
        detail: `signed by the master key of ${address} (offline; not checked for lsfDisableMaster)`,
      }
    : {
        ok: false,
        reason: `key ${keyAddress} is not the master key of ${address}; verify online (regular key)`,
      },
);

/**
 * Online `xrpl` verifier for one account, from its current `account_info` (validated ledger):
 * accepts the master key unless `lsfDisableMaster` is set, or the account's current RegularKey.
 * Reflects the account's keys now, not at delivery time.
 */
export async function xrplOnlineBindingVerifier(
  client: Client,
  address: string,
): Promise<BindingVerifier> {
  const { result } = await client.request({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  // Only a validated ledger counts (SPEC §6: anything else is `unavailable`, never pass or fail).
  if ((result as { validated?: boolean }).validated !== true)
    throw new Error("account_info did not come from a validated ledger");
  const data = result.account_data as { Account?: string; Flags?: number; RegularKey?: string };
  if (data?.Account !== address) throw new Error("account_info returned a different account");
  const masterDisabled = ((data.Flags ?? 0) & LSF_DISABLE_MASTER) !== 0;
  return makeVerifier((acct, keyAddress) => {
    if (acct !== address) return { ok: false, reason: `verifier was loaded for ${address}` };
    if (keyAddress === acct)
      return masterDisabled
        ? { ok: false, reason: `master key of ${acct} is disabled` }
        : { ok: true, detail: `signed by the (enabled) master key of ${acct}` };
    if (data.RegularKey && keyAddress === data.RegularKey)
      return { ok: true, detail: `signed by the current regular key of ${acct}` };
    return {
      ok: false,
      reason: `key ${keyAddress} is neither the master nor the regular key of ${acct}`,
    };
  });
}

/**
 * Signs bindings with an xrpl.js Wallet. Pass `account` when the wallet holds the account's
 * regular key rather than its master key.
 */
export function xrplAccountSigner(
  wallet: Wallet,
  options: { network?: string; account?: string } = {},
): AccountSigner {
  const network = options.network ?? XRPL_TESTNET;
  return {
    account: `${network}:${options.account ?? wallet.address}`,
    signBinding: (message): AccountProof => ({
      type: "xrpl",
      publicKey: wallet.publicKey.toUpperCase(),
      signature: sign(hex(message), wallet.privateKey).toUpperCase(),
    }),
  };
}
