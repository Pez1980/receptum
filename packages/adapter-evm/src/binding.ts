// Account bindings (SPEC §4.1) for eip155 accounts: EIP-191 personal_sign over the statement's JCS.
import { secp256k1 } from "@noble/curves/secp256k1";
import type { AccountProof, AccountSigner, BindingVerifier } from "@receptum/core";
import { getAddress, hashMessage, isAddress, toHex, type Account } from "viem";
import { publicKeyToAddress } from "viem/accounts";

const SIGNATURE = /^0x[0-9a-f]{130}$/;

/**
 * Verifies `eip191` proofs for `eip155:*` accounts offline: recovers the signer of
 * `personal_sign(JCS(statement))` and requires it to equal the account. EOAs only — contract
 * wallets (ERC-1271) are rejected. Signatures must be low-s with v ∈ {27, 28}.
 */
export const evmBindingVerifier: BindingVerifier = {
  namespace: "eip155",
  normalize: (account) => account.toLowerCase(),
  verifyProof(account, message, proof) {
    if (proof.type !== "eip191") return { ok: false, reason: "expected an eip191 proof" };
    if (Object.keys(proof).sort().join(",") !== "signature,type")
      return { ok: false, reason: "unexpected eip191 proof members" };
    if (typeof proof.signature !== "string" || !SIGNATURE.test(proof.signature))
      return { ok: false, reason: "signature must be 65 bytes, lower-case 0x-hex" };
    const address = account.slice(account.lastIndexOf(":") + 1);
    if (!isAddress(address, { strict: false }))
      return { ok: false, reason: "account is not an EVM address" };
    const v = parseInt(proof.signature.slice(130), 16);
    if (v !== 27 && v !== 28) return { ok: false, reason: "v must be 27 or 28" };
    try {
      const sig = secp256k1.Signature.fromCompact(proof.signature.slice(2, 130));
      if (sig.hasHighS()) return { ok: false, reason: "non-canonical (high-s) signature" };
      const digest = hashMessage({ raw: message }).slice(2);
      const pub = sig
        .addRecoveryBit(v - 27)
        .recoverPublicKey(digest)
        .toHex(false);
      const signer = publicKeyToAddress(`0x${pub}`);
      return getAddress(signer) === getAddress(address)
        ? { ok: true, detail: `EIP-191 signature by ${getAddress(address)}` }
        : { ok: false, reason: `signed by ${signer}, not ${getAddress(address)}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Signs bindings with a viem account that can `signMessage` (e.g. `privateKeyToAccount`).
 * `network` is the CAIP-2 chain the account is paid on, e.g. `eip155:84532`.
 */
export function evmAccountSigner(account: Account, network: string): AccountSigner {
  if (!network.startsWith("eip155:")) throw new TypeError("network must be an eip155 chain");
  const { signMessage } = account as { signMessage?: Account["signMessage"] };
  if (!signMessage) throw new TypeError("account cannot sign messages");
  return {
    account: `${network}:${account.address}`,
    async signBinding(message): Promise<AccountProof> {
      const signature = await signMessage({ message: { raw: toHex(message) } });
      return { type: "eip191", signature: signature.toLowerCase() };
    },
  };
}
