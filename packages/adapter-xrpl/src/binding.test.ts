import {
  bindingMessage,
  createAccountBinding,
  sellerKeyFromSeed,
  verifyAccountBinding,
} from "@receptum/core";
import { describe, expect, it } from "vitest";
import type { Client } from "xrpl";
import { ECDSA, Wallet } from "xrpl";
import { xrplAccountSigner, xrplBindingVerifier, xrplOnlineBindingVerifier } from "./binding.js";

// RFC 8032 §7.1 TEST 1 seed — a PUBLIC test value, used for both the did:key and the XRPL key.
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const key = sellerKeyFromSeed(SEED);
const edWallet = Wallet.fromEntropy(SEED.subarray(0, 16), { algorithm: ECDSA.ed25519 });
const secpWallet = Wallet.fromEntropy(SEED.subarray(16, 32), { algorithm: ECDSA.secp256k1 });
const verifiers = [xrplBindingVerifier];

const accountInfo = (data: Record<string, unknown>) =>
  ({
    request: async () => ({ result: { account_data: data } }),
  }) as unknown as Client;

describe("XRPL account bindings", () => {
  it("verifies master-key bindings offline for ed25519 and secp256k1 accounts", async () => {
    expect(edWallet.publicKey).toMatch(/^ED/);
    expect(secpWallet.publicKey).toMatch(/^0[23]/);
    for (const w of [edWallet, secpWallet]) {
      const b = await createAccountBinding({ key, signer: xrplAccountSigner(w) });
      expect(b.statement.account).toBe(`xrpl:1:${w.address}`);
      expect(b.accountProof).toMatchObject({ type: "xrpl", publicKey: w.publicKey.toUpperCase() });
      expect(verifyAccountBinding(b, { verifiers })).toMatchObject({ ok: true });
    }
  });

  it("rejects a tampered message, a key that doesn't derive to the account offline", async () => {
    const b = await createAccountBinding({ key, signer: xrplAccountSigner(edWallet) });
    const sig = b.accountProof.signature;
    const bad = {
      ...b,
      accountProof: { ...b.accountProof, signature: (sig[0] === "A" ? "B" : "A") + sig.slice(1) },
    };
    expect(verifyAccountBinding(bad, { verifiers })).toMatchObject({ ok: false });

    // Signed with a regular key for someone else's account: offline can't accept it.
    const viaRegular = await createAccountBinding({
      key,
      signer: xrplAccountSigner(secpWallet, { account: edWallet.address }),
    });
    expect(verifyAccountBinding(viaRegular, { verifiers })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not the master key/),
    });
    expect(bindingMessage(viaRegular.statement).length).toBeGreaterThan(0);
  });

  it("accepts the current regular key online and refuses a disabled master key", async () => {
    const viaRegular = await createAccountBinding({
      key,
      signer: xrplAccountSigner(secpWallet, { account: edWallet.address }),
    });
    const withRegular = await xrplOnlineBindingVerifier(
      accountInfo({ RegularKey: secpWallet.address, Flags: 0 }),
      edWallet.address,
    );
    expect(verifyAccountBinding(viaRegular, { verifiers: [withRegular] })).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/regular key/),
    });
    const noRegular = await xrplOnlineBindingVerifier(accountInfo({ Flags: 0 }), edWallet.address);
    expect(verifyAccountBinding(viaRegular, { verifiers: [noRegular] }).ok).toBe(false);

    const master = await createAccountBinding({ key, signer: xrplAccountSigner(edWallet) });
    const disabled = await xrplOnlineBindingVerifier(
      accountInfo({ Flags: 0x00100000, RegularKey: secpWallet.address }),
      edWallet.address,
    );
    expect(verifyAccountBinding(master, { verifiers: [disabled] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/disabled/),
    });
  });
});
