import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  bindingBytes,
  createAccountBinding,
  sellerKeyFromSeed,
  verifyAccountBinding,
  type AccountBinding,
  type AccountSigner,
} from "@receptum/core";
import { evmAccountSigner } from "@receptum/adapter-evm";
import { xrplAccountSigner } from "@receptum/adapter-xrpl";
import { stellarAccountSigner } from "@receptum/core";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ECDSA, Wallet } from "xrpl";
import { BINDING_VERIFIERS } from "./index.js";

const file = JSON.parse(
  readFileSync(new URL("../../../spec/vectors/account-binding-v1.json", import.meta.url), "utf8"),
) as {
  testSeedHex: string;
  sellerDid: string;
  vectors: { name: string; chainKey: { value: string }; jcs: string; binding: AccountBinding }[];
  invalid: { name: string; binding: AccountBinding }[];
};

const key = sellerKeyFromSeed(Buffer.from(file.testSeedHex, "hex"));
const at = { verifiers: BINDING_VERIFIERS, now: new Date("2026-10-02T00:00:00Z") };

function signerFor(account: string, chainKey: string): AccountSigner {
  if (account.startsWith("eip155:"))
    return evmAccountSigner(privateKeyToAccount(chainKey as `0x${string}`), "eip155:84532");
  if (account.startsWith("xrpl:")) {
    const entropy = createHash("sha512").update(chainKey).digest().subarray(0, 16);
    return xrplAccountSigner(Wallet.fromEntropy(entropy, { algorithm: ECDSA.secp256k1 }));
  }

  const seed = Buffer.from(chainKey, "hex");
  const signer = stellarAccountSigner(strkeySeed(seed), "stellar:testnet");
  return signer;
}

function strkeySeed(seed: Uint8Array): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const body = Uint8Array.from([18 << 3, ...seed]);
  let crc = 0;
  for (const b of body) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  let bits = 0;
  let value = 0;
  let text = "";
  for (const b of [...body, crc & 0xff, crc >> 8]) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      text += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return text;
}

describe("published account binding vectors (SPEC §4.1)", () => {
  it("derive the published seller did", () => expect(key.did).toBe(file.sellerDid));
  for (const v of file.vectors) {
    it(`reproduce and verify "${v.name}"`, async () => {
      expect(bindingBytes(v.binding.statement)).toBe(v.jcs);
      expect(verifyAccountBinding(v.binding, at)).toMatchObject({ ok: true });
      const again = await createAccountBinding({
        key,
        signer: signerFor(v.binding.statement.account, v.chainKey.value),
        issuedAt: new Date(v.binding.statement.issuedAt),
        expiresAt: new Date(v.binding.statement.expiresAt!),
      });
      expect(again).toEqual(v.binding);
    });
  }
  for (const v of file.invalid) {
    it(`reject "${v.name}"`, () => {
      expect(verifyAccountBinding(v.binding, at).ok).toBe(false);
    });
  }
});
