import {
  bindingMessage,
  createAccountBinding,
  sellerKeyFromSeed,
  verifyAccountBinding,
} from "@receptum/core";
import { describe, expect, it } from "vitest";
import type { Client } from "xrpl";
import { ECDSA, Wallet } from "xrpl";
import {
  xrplAccountSigner,
  xrplBindingVerifier,
  xrplOnlineBindingVerifier,
  xrplSecp256k1SignatureError,
} from "./binding.js";

// RFC 8032 §7.1 TEST 1 seed — a PUBLIC test value, used for both the did:key and the XRPL key.
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const key = sellerKeyFromSeed(SEED);
const edWallet = Wallet.fromEntropy(SEED.subarray(0, 16), { algorithm: ECDSA.ed25519 });
const secpWallet = Wallet.fromEntropy(SEED.subarray(16, 32), { algorithm: ECDSA.secp256k1 });
const verifiers = [xrplBindingVerifier];

const accountInfo = (data: Record<string, unknown>, validated = true) =>
  ({
    request: async () => ({
      result: { validated, account_data: { Account: edWallet.address, ...data } },
    }),
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

  it("refuses account_info that is not from a validated ledger (SPEC §6: unavailable)", async () => {
    await expect(
      xrplOnlineBindingVerifier(accountInfo({ Flags: 0 }, false), edWallet.address),
    ).rejects.toThrow(/validated/);
  });
});

describe("XRPL secp256k1 signature canonicality (SPEC §4.1: canonical DER, low-s)", () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const toBytes = (v: bigint) => {
    let h = v.toString(16);
    if (h.length % 2) h = "0" + h;
    const b = Buffer.from(h, "hex");
    return b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
  };
  const der = (r: Buffer, s: Buffer) =>
    Buffer.concat([
      Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
  const parse = (sig: Buffer) => {
    const rl = sig[3]!;
    const r = sig.subarray(4, 4 + rl);
    const s = sig.subarray(6 + rl);
    return { r, s: BigInt("0x" + s.toString("hex")) };
  };

  it("accepts the canonical signature and rejects its high-s twin and padded DER", async () => {
    const b = await createAccountBinding({ key, signer: xrplAccountSigner(secpWallet) });
    const sig = Buffer.from(b.accountProof.signature, "hex");
    expect(xrplSecp256k1SignatureError(sig)).toBeNull();
    expect(verifyAccountBinding(b, { verifiers })).toMatchObject({ ok: true });
    const { r, s } = parse(sig);

    const highS = der(r, toBytes(N - s));
    expect(xrplSecp256k1SignatureError(highS)).toMatch(/low-s/);
    const forged = {
      ...b,
      accountProof: { ...b.accountProof, signature: highS.toString("hex").toUpperCase() },
    };
    expect(verifyAccountBinding(forged, { verifiers })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/low-s/),
    });

    // r = 1 written as 00 01: a non-minimal INTEGER.
    const padded = der(Buffer.from([0, 1]), toBytes(s));
    expect(xrplSecp256k1SignatureError(padded)).toMatch(/non-minimal/);
    const trailing = Buffer.concat([sig, Buffer.from([0])]);
    expect(xrplSecp256k1SignatureError(trailing)).toMatch(/SEQUENCE|trailing/);
  });
});
