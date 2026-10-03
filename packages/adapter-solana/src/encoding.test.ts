import {
  createAccountBinding,
  MainnetNotAllowedError,
  sellerKeyFromSeed,
  verifyAccountBinding,
} from "@receptum/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  associatedTokenAddress,
  DEVNET_USDC_MINT,
  findProgramAddress,
  isOnCurve,
} from "./address.js";
import { anchorMemo, SolanaAnchor } from "./anchor.js";
import { decodeBase58, encodeBase58, isSolanaAddress, isSolanaSignature } from "./base58.js";
import { solanaAccountSigner, solanaBindingVerifier } from "./binding.js";
import { SolanaEscrowRail } from "./escrow.js";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "./network.js";
import {
  formatSolanaEscrowId,
  parseSolanaEscrowId,
  RECEPTUM_SOLANA_PROGRAM_ID,
} from "./program.js";
import { compileMessage, solanaKeypair } from "./transaction.js";

afterEach(() => vi.unstubAllEnvs());

describe("base58", () => {
  it("round-trips and keeps leading zeros", () => {
    for (const b of [new Uint8Array(32), Uint8Array.of(0, 0, 1, 2), new Uint8Array(64).fill(255)])
      expect(decodeBase58(encodeBase58(b))).toEqual(b);
    expect(encodeBase58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(isSolanaAddress(DEVNET_USDC_MINT)).toBe(true);
    expect(isSolanaAddress("0x" + "ab".repeat(20))).toBe(false);
    expect(isSolanaAddress("1" + DEVNET_USDC_MINT)).toBe(false); // 33 bytes
    expect(isSolanaSignature(DEVNET_USDC_MINT)).toBe(false);
  });
});

describe("addresses", () => {
  it("derives the associated token account Solana does", () => {
    // Created on devnet by Circle's faucet for this owner.
    expect(
      associatedTokenAddress("H1QWkpBSkGndggiLQqu7Eosuupu6oxFFzHK5HofUf4yc", DEVNET_USDC_MINT),
    ).toBe("JBj9Wa3frnoxP3qG8MjAp49C8NP4y6WerSjNdaoCSEoq");
  });
  it("puts PDAs off the curve and wallets on it", () => {
    const pda = findProgramAddress([Buffer.from("x")], RECEPTUM_SOLANA_PROGRAM_ID);
    expect(isOnCurve(decodeBase58(pda.address))).toBe(false);
    expect(isOnCurve(decodeBase58(solanaKeypair(new Uint8Array(32).fill(1)).address))).toBe(true);
  });
});

describe("transactions", () => {
  it("orders accounts: payer, signers, writable, readonly", () => {
    const a = solanaKeypair(new Uint8Array(32).fill(1)).address;
    const b = solanaKeypair(new Uint8Array(32).fill(2)).address;
    const { message, signers } = compileMessage(
      a,
      [
        {
          programId: RECEPTUM_SOLANA_PROGRAM_ID,
          accounts: [
            { address: DEVNET_USDC_MINT, signer: false, writable: false },
            { address: b, signer: true, writable: false },
          ],
          data: Uint8Array.of(9),
        },
      ],
      DEVNET_USDC_MINT,
    );
    expect(signers).toEqual([a, b]);
    expect([...message.subarray(0, 4)]).toEqual([2, 1, 2, 4]);
  });
  it("rejects a secret whose public half doesn't match", () => {
    const kp = new Uint8Array(64).fill(1);
    expect(() => solanaKeypair(kp)).toThrow(/does not match/);
  });
});

describe("escrow ids and anchors", () => {
  it("formats and parses escrow ids", () => {
    const id = formatSolanaEscrowId(SOLANA_DEVNET, RECEPTUM_SOLANA_PROGRAM_ID, DEVNET_USDC_MINT);
    expect(parseSolanaEscrowId(id)).toEqual({
      network: SOLANA_DEVNET,
      programId: RECEPTUM_SOLANA_PROGRAM_ID,
      escrow: DEVNET_USDC_MINT,
    });
    expect(() => parseSolanaEscrowId("solana:devnet:abc:def")).toThrow();
  });
  it("anchors as receptum/1:<hash>", () => {
    expect(anchorMemo("ab".repeat(32))).toBe(`receptum/1:${"ab".repeat(32)}`);
    expect(() => anchorMemo("AB".repeat(32))).toThrow();
  });
  it("refuses to sign on mainnet without the opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const signer = solanaKeypair(new Uint8Array(32).fill(1));
    const rpc = async () => {
      throw new Error("must not be called");
    };
    await expect(
      new SolanaAnchor({ network: SOLANA_MAINNET, signer, rpc }).anchor("ab".repeat(32)),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
    await expect(
      new SolanaEscrowRail({ network: SOLANA_MAINNET, signer, rpc }).deliver(
        formatSolanaEscrowId(SOLANA_MAINNET, RECEPTUM_SOLANA_PROGRAM_ID, DEVNET_USDC_MINT),
        "ab".repeat(32),
      ),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
  });
});

describe("solana account bindings", () => {
  const key = sellerKeyFromSeed(new Uint8Array(32).fill(7));
  const kp = solanaKeypair(new Uint8Array(32).fill(8));
  const opts = { verifiers: [solanaBindingVerifier] };

  it("verifies offline against the address", async () => {
    const b = await createAccountBinding({ key, signer: solanaAccountSigner(kp) });
    expect(verifyAccountBinding(b, opts)).toMatchObject({ ok: true });
  });

  it("rejects another key, another account, odd members and non-canonical encodings", async () => {
    const b = await createAccountBinding({ key, signer: solanaAccountSigner(kp) });
    const other = await createAccountBinding({
      key,
      signer: solanaAccountSigner(solanaKeypair(new Uint8Array(32).fill(9))),
    });
    expect(verifyAccountBinding({ ...b, accountProof: other.accountProof }, opts).ok).toBe(false);
    expect(
      verifyAccountBinding({ ...b, accountProof: { ...b.accountProof, publicKey: "x" } }, opts).ok,
    ).toBe(false);
    const sig = Buffer.from(b.accountProof.signature, "base64");
    expect(
      verifyAccountBinding(
        { ...b, accountProof: { type: "solana", signature: sig.toString("base64url") } },
        opts,
      ).ok,
    ).toBe(false);
    expect(
      verifyAccountBinding({ ...b, accountProof: { ...b.accountProof, type: "sep53" } }, opts).ok,
    ).toBe(false);
  });
});
