import { describe, expect, it } from "vitest";
import {
  bindingBytes,
  checkPayeeBinding,
  createAccountBinding,
  decodeStrKey,
  encodeStellarAccount,
  registerBindingVerifier,
  stellarAccountSigner,
  verifyAccountBinding,
  type AccountBinding,
  type BindingVerifier,
} from "./binding.js";
import { sha256Hex } from "./hash.js";
import { createReceipt } from "./receipt.js";
import { generateSellerKey, signReceipt } from "./signing.js";

// RFC 8032 §7.1 TEST 1 seed: a PUBLIC test value, never a real key.
const RFC8032_SEED = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "hex",
);
const seedStrKey = (seed: Uint8Array) => {
  // Builds an S… StrKey (version byte 18 << 3) from raw seed bytes.
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const body = Uint8Array.from([18 << 3, ...seed]);
  let crc = 0;
  for (const b of body) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const bytes = [...body, crc & 0xff, crc >> 8];
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
};

const key = generateSellerKey();
const stellar = stellarAccountSigner(seedStrKey(RFC8032_SEED));

describe("Stellar StrKey", () => {
  it("encodes the RFC 8032 TEST 1 public key and round-trips", () => {
    const pub = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    );
    const g = encodeStellarAccount(pub);
    expect(stellar.account).toBe(`stellar:testnet:${g}`);
    expect(Buffer.from(decodeStrKey(g, "account")).equals(pub)).toBe(true);
    expect(() => decodeStrKey(g, "seed")).toThrow(/not a seed/);
    const flipped = g.slice(0, 10) + (g[10] === "A" ? "B" : "A") + g.slice(11);
    expect(() => decodeStrKey(flipped, "account")).toThrow(/checksum/);
  });
});

describe("account bindings", () => {
  it("creates and verifies a Stellar binding", async () => {
    const b = await createAccountBinding({ key, signer: stellar });
    expect(b.statement).toMatchObject({
      type: "receptum/account-binding/1",
      did: key.did,
      account: stellar.account,
    });
    expect(b.accountProof.type).toBe("sep53");
    expect(verifyAccountBinding(b)).toMatchObject({ ok: true, did: key.did });
  });

  it("rejects tampering with either signature or the statement", async () => {
    const b = await createAccountBinding({ key, signer: stellar });
    const other = generateSellerKey();
    const swappedDid: AccountBinding = structuredClone(b);
    swappedDid.statement.did = other.did;
    expect(verifyAccountBinding(swappedDid)).toMatchObject({ ok: false });

    const forgedAccount = structuredClone(b);
    forgedAccount.accountProof.signature = Buffer.alloc(64, 1).toString("base64");
    expect(verifyAccountBinding(forgedAccount)).toMatchObject({
      ok: false,
      reason: "account signature: bad signature",
    });

    // A did signature alone (attacker claims someone else's account) is not enough.
    const other2 = await createAccountBinding({ key: other, signer: stellar });
    const mixed = { ...b, accountProof: other2.accountProof };
    expect(verifyAccountBinding(mixed).ok).toBe(false);
    const extra = { ...b, note: "x" } as unknown as AccountBinding;
    expect(verifyAccountBinding(extra).ok).toBe(false);
  });

  it("enforces expiry and rejects future-dated bindings", async () => {
    const b = await createAccountBinding({
      key,
      signer: stellar,
      issuedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z"),
    });
    expect(verifyAccountBinding(b, { at: new Date("2026-01-15T00:00:00Z") }).ok).toBe(true);
    expect(verifyAccountBinding(b, { at: new Date("2026-02-01T00:00:00Z") }).ok).toBe(false);
    expect(verifyAccountBinding(b, { now: new Date("2025-12-01T00:00:00Z") })).toMatchObject({
      ok: false,
      reason: "binding is issued in the future",
    });
    await expect(
      createAccountBinding({
        key,
        signer: stellar,
        issuedAt: new Date("2026-02-01T00:00:00Z"),
        expiresAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow(/expiresAt must be after/);
  });

  it("rejects malformed statements", () => {
    const base = {
      type: "receptum/account-binding/1",
      did: key.did,
      account: stellar.account,
      issuedAt: "2026-01-01T00:00:00Z",
    } as const;
    expect(() => bindingBytes(base)).not.toThrow();
    expect(() => bindingBytes({ ...base, extra: "x" } as never)).toThrow(/not allowed/);
    expect(() => bindingBytes({ ...base, did: "did:web:x" })).toThrow(/did:key/);
    expect(() => bindingBytes({ ...base, account: "0xabc" })).toThrow(/CAIP-10/);
    expect(() => bindingBytes({ ...base, issuedAt: "2026-01-01" })).toThrow(/issuedAt/);
  });

  it("fails closed for namespaces without a verifier, and uses registered ones", async () => {
    const fake: BindingVerifier = {
      namespace: "fakenet",
      verifyProof: (_a, _m, p) =>
        p.signature === "ok" ? { ok: true, detail: "fake" } : { ok: false, reason: "nope" },
      normalize: (a) => a.toLowerCase(),
    };
    const signer = {
      account: "fakenet:1:ABC",
      signBinding: () => ({ type: "fake", signature: "ok" }),
    };
    const b = await createAccountBinding({ key, signer });
    expect(verifyAccountBinding(b)).toMatchObject({
      ok: false,
      reason: "no binding verifier for namespace fakenet",
    });
    expect(verifyAccountBinding(b, { verifiers: [fake] }).ok).toBe(true);
    registerBindingVerifier(fake);
    expect(verifyAccountBinding(b).ok).toBe(true);
  });
});

describe("checkPayeeBinding", () => {
  const receiptFor = (payee?: string) =>
    signReceipt(
      createReceipt({
        jobId: "j",
        seller: { id: key.did },
        inputSha256: [sha256Hex("in")],
        outputSha256: sha256Hex("out"),
        payment: {
          rail: "escrow:stellar-claimable",
          network: "stellar:testnet",
          asset: "XLM",
          amount: "1",
          reference: "x",
          ...(payee ? { payee } : {}),
        },
      }),
      key,
    );

  it("passes when a valid binding covers the payee", async () => {
    const signed = receiptFor(stellar.account);
    expect(checkPayeeBinding(signed)).toMatchObject({ ok: false });
    signed.bindings = [await createAccountBinding({ key, signer: stellar })];
    expect(checkPayeeBinding(signed)).toMatchObject({ ok: true });
  });

  it("fails without a payee, for another account, another seller, or an expired binding", async () => {
    expect(checkPayeeBinding(receiptFor())).toMatchObject({ reason: "receipt names no payee" });
    const otherAccount = stellarAccountSigner(seedStrKey(Buffer.alloc(32, 7)));
    const signed = receiptFor(stellar.account);
    signed.bindings = [await createAccountBinding({ key, signer: otherAccount })];
    expect(checkPayeeBinding(signed).ok).toBe(false);
    signed.bindings = [await createAccountBinding({ key: generateSellerKey(), signer: stellar })];
    expect(checkPayeeBinding(signed).ok).toBe(false);
    signed.bindings = [
      await createAccountBinding({
        key,
        signer: stellar,
        issuedAt: new Date("2020-01-01T00:00:00Z"),
        expiresAt: new Date("2020-02-01T00:00:00Z"),
      }),
    ];
    expect(checkPayeeBinding(signed)).toMatchObject({ ok: false, reason: /expired/ });
  });
});
