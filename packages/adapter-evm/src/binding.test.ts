import {
  bindingMessage,
  createAccountBinding,
  sellerKeyFromSeed,
  verifyAccountBinding,
} from "@receptum/core";
import { recoverMessageAddress, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { evmAccountSigner, evmBindingVerifier } from "./binding.js";

// PUBLIC test values: anvil/hardhat default account #0 and the RFC 8032 §7.1 TEST 1 seed.
const ANVIL_0 = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const key = sellerKeyFromSeed(
  Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
);
const verifiers = [evmBindingVerifier];

describe("EVM account bindings", () => {
  it("signs with EIP-191 and verifies offline; viem agrees", async () => {
    const b = await createAccountBinding({
      key,
      signer: evmAccountSigner(ANVIL_0, "eip155:84532"),
      issuedAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(b.statement.account).toBe(`eip155:84532:${ANVIL_0.address}`);
    expect(verifyAccountBinding(b, { verifiers })).toMatchObject({ ok: true });
    const message = { raw: bindingMessage(b.statement) };
    const signature = b.accountProof.signature as `0x${string}`;
    expect(await recoverMessageAddress({ message, signature })).toBe(ANVIL_0.address);
    expect(await verifyMessage({ address: ANVIL_0.address, message, signature })).toBe(true);
  });

  it("rejects a signature by another account, a malformed or high-s signature", async () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // anvil #1 (public)
    );
    const b = await createAccountBinding({ key, signer: evmAccountSigner(other, "eip155:84532") });
    const forged = structuredClone(b);
    forged.statement.account = `eip155:84532:${ANVIL_0.address}`;
    // did signature breaks first; re-sign the did part to isolate the account check
    const { signDetachedJws, bindingBytes, BINDING_JWS_TYP } = await import("@receptum/core");
    forged.didProof = signDetachedJws(bindingBytes(forged.statement), key, BINDING_JWS_TYP);
    expect(verifyAccountBinding(forged, { verifiers })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not 0xf39F/i),
    });

    const upper = structuredClone(b);
    upper.accountProof.signature = upper.accountProof.signature.toUpperCase().replace("0X", "0x");
    expect(verifyAccountBinding(upper, { verifiers }).ok).toBe(false);

    // Flip s to n - s (and v) — same signer, but malleable: rejected.
    const n = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const sig = b.accountProof.signature;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = parseInt(sig.slice(130), 16);
    const high = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    expect(
      verifyAccountBinding(
        { ...b, accountProof: { type: "eip191", signature: high } },
        { verifiers },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/high-s/) });
  });

  it("compares EVM accounts case-insensitively", async () => {
    const { sameAccount } = await import("@receptum/core");
    expect(
      sameAccount(
        `eip155:84532:${ANVIL_0.address}`,
        `eip155:84532:${ANVIL_0.address.toLowerCase()}`,
        verifiers,
      ),
    ).toBe(true);
    expect(
      sameAccount(`eip155:1:${ANVIL_0.address}`, `eip155:84532:${ANVIL_0.address}`, verifiers),
    ).toBe(false);
  });
});
