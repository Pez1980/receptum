// Regenerates spec/vectors/rrf-v1.json and spec/vectors/account-binding-v1.json from the
// reference implementation. Run `pnpm build` first.
// Every key below is a PUBLIC TEST VALUE — never use any of them for real receipts or funds.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  bindingBytes,
  createAccountBinding,
  createReceipt,
  stellarAccountSigner,
  receiptBytes,
  receiptHash,
  sellerKeyFromSeed,
  sha256Hex,
  signReceipt,
} from "../packages/core/dist/index.js";

const testSeedHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // RFC 8032 §7.1 test 1
const key = sellerKeyFromSeed(Buffer.from(testSeedHex, "hex"));

const cases = [
  {
    name: "auto-release, x402 exact on Base Sepolia",
    input: {
      jobId: "render-8841",
      receiptId: "RCPT-7F3A-21C9",
      seller: { id: key.did, name: "render.example" },
      inputSha256: [sha256Hex("source.mp4 bytes")],
      outputSha256: sha256Hex("final.mp4 bytes"),
      payment: {
        rail: "x402:exact",
        network: "eip155:84532",
        asset: "USDC",
        amount: "2500000",
        reference: "0x" + "ab".repeat(32),
      },
      acceptance: { mode: "auto", reviewWindowSeconds: 259200 },
      remedy: { kind: "rerender", withinDays: 30 },
      deliveredAt: new Date("2026-10-04T12:00:00Z"),
    },
  },
  {
    name: "evaluator acceptance, XRPL escrow, with evidence and supersedes",
    input: {
      jobId: "dub-0042",
      receiptId: "RCPT-9B04-E117",
      seller: { id: key.did },
      buyer: { id: "xrpl:1:rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY" },
      inputSha256: [sha256Hex("a"), sha256Hex("b")],
      outputSha256: sha256Hex("dubbed.mp4 bytes"),
      evidence: { qaReport: sha256Hex("qa ok") },
      payment: {
        rail: "escrow:xrpl",
        network: "xrpl:1",
        asset: "XRP",
        amount: "4000000",
        reference: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY:42",
      },
      acceptance: {
        mode: "evaluator",
        reviewWindowSeconds: 86400,
        evaluator: "did:web:qa.example",
      },
      supersedes: sha256Hex("earlier receipt"),
      deliveredAt: new Date("2026-10-05T08:30:00Z"),
    },
  },
];

const out = {
  description:
    "Receptum Receipt Format v1 test vectors. testSeedHex is the RFC 8032 §7.1 TEST 1 seed — public, for testing only.",
  testSeedHex,
  sellerDid: key.did,
  vectors: cases.map(({ name, input }) => {
    const receipt = createReceipt(input);
    const signed = signReceipt(receipt, key);
    return {
      name,
      receipt,
      jcs: receiptBytes(receipt),
      receiptHash: receiptHash(receipt),
      proof: signed.proof,
    };
  }),
};
writeFileSync(
  new URL("../spec/vectors/rrf-v1.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(`wrote ${out.vectors.length} vectors for ${key.did}`);

// ─── Account binding vectors (SPEC §4.1) ────────────────────────────────────
const evm = await import("../packages/adapter-evm/dist/index.js");
const xrpl = await import("../packages/adapter-xrpl/dist/index.js");
const fromEvm = createRequire(new URL("../packages/adapter-evm/package.json", import.meta.url));
const fromXrpl = createRequire(new URL("../packages/adapter-xrpl/package.json", import.meta.url));
const { privateKeyToAccount } = await import(fromEvm.resolve("viem/accounts"));
const { Wallet } = await import(fromXrpl.resolve("xrpl"));

// Public test keys: anvil/hardhat default account #0; the XRPL genesis account, whose secp256k1
// key comes from the well-known passphrase "masterpassphrase" (entropy = first 16 bytes of its
// SHA-512); the RFC 8032 TEST 1 seed as a Stellar key.
const anvilAccount0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const xrplGenesisPassphrase = "masterpassphrase";
const { createHash } = await import("node:crypto");
const xrplGenesis = Wallet.fromEntropy(
  createHash("sha512").update(xrplGenesisPassphrase).digest().subarray(0, 16),
  { algorithm: "ecdsa-secp256k1" },
);
const stellarSeedHex = testSeedHex;
const strkeySeed = (seed) => {
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
};

const issuedAt = new Date("2026-10-01T00:00:00Z");
const expiresAt = new Date("2027-10-01T00:00:00Z");
const bindingCases = [
  {
    name: "eip155 (EIP-191 personal_sign), Base Sepolia",
    chainKey: { kind: "secp256k1 private key (anvil #0)", value: anvilAccount0 },
    signer: evm.evmAccountSigner(privateKeyToAccount(anvilAccount0), "eip155:84532"),
  },
  {
    name: "xrpl (ripple-keypairs secp256k1, master key), testnet",
    chainKey: {
      kind: "XRPL secp256k1 key from passphrase (entropy = SHA-512(passphrase)[0..16])",
      value: xrplGenesisPassphrase,
    },
    signer: xrpl.xrplAccountSigner(xrplGenesis, { network: "xrpl:1" }),
  },
  {
    name: "stellar (SEP-53), testnet",
    chainKey: { kind: "Ed25519 seed (RFC 8032 TEST 1)", value: stellarSeedHex },
    signer: stellarAccountSigner(strkeySeed(Buffer.from(stellarSeedHex, "hex")), "stellar:testnet"),
  },
];

const bindingVectors = [];
for (const { name, chainKey, signer } of bindingCases) {
  const binding = await createAccountBinding({ key, signer, issuedAt, expiresAt });
  bindingVectors.push({ name, chainKey, jcs: bindingBytes(binding.statement), binding });
}
// Negative vector: the eip155 binding with its statement re-pointed at another account (and the
// did signature redone). The account signature no longer recovers to the account: MUST fail.
const neg = JSON.parse(JSON.stringify(bindingVectors[0].binding));
neg.statement.account = "eip155:84532:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const { signDetachedJws, BINDING_JWS_TYP } = await import("../packages/core/dist/index.js");
neg.didProof = signDetachedJws(bindingBytes(neg.statement), key, BINDING_JWS_TYP);

const bindingOut = {
  description:
    "Receptum account binding (receptum/account-binding/1) test vectors, SPEC §4.1. Every key here is a PUBLIC TEST VALUE: the RFC 8032 §7.1 TEST 1 seed (did:key and Stellar), anvil default account #0 (EVM), and the XRPL genesis key (passphrase masterpassphrase). Never use them for real funds.",
  testSeedHex,
  sellerDid: key.did,
  vectors: bindingVectors,
  invalid: [
    {
      name: "eip155 account swapped (did signature valid, account signature by someone else)",
      binding: neg,
    },
  ],
};
writeFileSync(
  new URL("../spec/vectors/account-binding-v1.json", import.meta.url),
  JSON.stringify(bindingOut, null, 2) + "\n",
);
console.log(`wrote ${bindingVectors.length} account binding vectors`);
