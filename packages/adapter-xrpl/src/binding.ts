// Account bindings (SPEC §4.1) for xrpl accounts, signed with ripple-keypairs over JCS(statement).
import type { AccountProof, AccountSigner, BindingVerifier } from "@receptum/core";
import { deriveAddress, sign, verify } from "ripple-keypairs";
import type { Client, Wallet } from "xrpl";
import { XRPL_TESTNET } from "./ledger.js";

const PUBLIC_KEY = /^(ED[0-9A-F]{64}|0[23][0-9A-F]{64})$/;
const SIGNATURE = /^[0-9A-F]{16,144}$/;
const LSF_DISABLE_MASTER = 0x00100000;

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
  const data = result.account_data as { Flags?: number; RegularKey?: string };
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
