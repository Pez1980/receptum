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

const vectors = cases.map(({ name, input }) => {
  const receipt = createReceipt(input);
  const signed = signReceipt(receipt, key);
  return {
    name,
    receipt,
    jcs: receiptBytes(receipt),
    receiptHash: receiptHash(receipt),
    proof: signed.proof,
  };
});

// ─── Negative vectors: every one MUST be rejected (SPEC §2, §4, §6.1) ────────
// `signedReceipt` cases MUST fail level 2; `text` cases MUST be rejected when parsed (not I-JSON).
const { canonicalJson, signDetachedJws, RECEIPT_JWS_TYP } =
  await import("../packages/core/dist/index.js");
const { sign } = await import("node:crypto");
const b64u = (d) => Buffer.from(d).toString("base64url");
const good = () => JSON.parse(JSON.stringify(vectors[0].receipt));
const goodSigned = () => ({
  receipt: good(),
  receiptHash: vectors[0].receiptHash,
  proof: { ...vectors[0].proof },
});
// Signs any receipt object, even one RRF v1 forbids, so only the targeted rule is broken.
const forceSign = (receipt) => {
  const jcs = canonicalJson(receipt);
  return {
    receipt,
    receiptHash: sha256Hex(jcs),
    proof: signDetachedJws(jcs, key, RECEIPT_JWS_TYP),
  };
};
const withHeader = (headerJson) => {
  const s = goodSigned();
  const h = b64u(headerJson);
  const sig = sign(null, Buffer.from(`${h}.${b64u(vectors[0].jcs)}`), key.privateKey);
  return { ...s, proof: { ...s.proof, jws: `${h}..${b64u(sig)}` } };
};
const malleated = () => {
  const s = goodSigned();
  const [h, , sig] = s.proof.jws.split(".");
  const bytes = Buffer.from(sig, "base64url");
  const L = 2n ** 252n + 27742317777372353535851770400913936493n;
  let S = 0n;
  for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(bytes[i]);
  let T = S + L;
  for (let i = 32; i < 64; i++) {
    bytes[i] = Number(T & 0xffn);
    T >>= 8n;
  }
  return { ...s, proof: { ...s.proof, jws: `${h}..${b64u(bytes)}` } };
};
const mutated = (fn) => {
  const r = good();
  fn(r);
  return forceSign(r);
};
const kid = vectors[0].proof.kid;
const invalid = [
  {
    name: "JWS header with a duplicate member (alg none, then EdDSA), validly signed",
    signedReceipt: withHeader(
      `{"alg":"none","alg":"EdDSA","kid":${JSON.stringify(kid)},"typ":"receptum+jws"}`,
    ),
  },
  { name: "Ed25519 signature with S + L (malleated, S >= L)", signedReceipt: malleated() },
  {
    name: "signed-receipt envelope with an extra member",
    signedReceipt: { ...goodSigned(), note: "x" },
  },
  { name: "bindings is not an array", signedReceipt: { ...goodSigned(), bindings: {} } },
  {
    name: "proof with an extra member",
    signedReceipt: { ...goodSigned(), proof: { ...vectors[0].proof, alg: "EdDSA" } },
  },
  {
    name: "acceptance.evaluator while mode is auto",
    signedReceipt: mutated((r) => (r.acceptance.evaluator = "did:web:qa.example")),
  },
  {
    name: "payment.payee is a DID, not a CAIP-10 account",
    signedReceipt: mutated((r) => (r.payment.payee = key.did)),
  },
  {
    name: "deliveredAt with 10 fractional digits",
    signedReceipt: mutated((r) => (r.deliveredAt = "2026-10-04T12:00:00.0000000000Z")),
  },
  { name: "remedy without kind", signedReceipt: mutated((r) => delete r.remedy.kind) },
  {
    name: "receipt file with a duplicate member name (JSON.parse would keep the last amount)",
    text: JSON.stringify(goodSigned()).replace(
      '"amount":"2500000"',
      '"amount":"1","amount":"2500000"',
    ),
  },
  {
    name: "receipt file with a lone surrogate",
    text: JSON.stringify(goodSigned()).replace('"render.example"', '"render.example\\ud800"'),
  },
  {
    name: "receipt file with a number outside the IEEE 754 double range",
    text: JSON.stringify(goodSigned()).replace(
      '"reviewWindowSeconds":259200',
      '"reviewWindowSeconds":1e400',
    ),
  },
];
for (const v of invalid)
  if (v.text && v.text === JSON.stringify(goodSigned())) throw new Error(v.name);

const out = {
  description:
    "Receptum Receipt Format v1 test vectors. testSeedHex is the RFC 8032 §7.1 TEST 1 seed — public, for testing only.",
  testSeedHex,
  sellerDid: key.did,
  vectors,
  invalidNote:
    "Every `invalid` entry MUST be rejected: a `signedReceipt` fails level 2 (SPEC §2, §4); a `text` is not I-JSON and MUST be refused when parsed as a receipt file (SPEC §6.1).",
  invalid,
};
writeFileSync(
  new URL("../spec/vectors/rrf-v1.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(`wrote ${out.vectors.length} vectors (+${invalid.length} invalid) for ${key.did}`);

// ─── Account binding vectors (SPEC §4.1) ────────────────────────────────────
const evm = await import("../packages/adapter-evm/dist/index.js");
const xrpl = await import("../packages/adapter-xrpl/dist/index.js");
const solana = await import("../packages/adapter-solana/dist/index.js");
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
  {
    name: 'solana (Ed25519 over SHA-256("Solana Signed Message:\\n" ‖ m)), devnet',
    chainKey: { kind: "Ed25519 seed (RFC 8032 TEST 1)", value: testSeedHex },
    signer: solana.solanaAccountSigner(
      solana.solanaKeypair(Buffer.from(testSeedHex, "hex")),
      solana.SOLANA_DEVNET,
    ),
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
const { BINDING_JWS_TYP } = await import("../packages/core/dist/index.js");
neg.didProof = signDetachedJws(bindingBytes(neg.statement), key, BINDING_JWS_TYP);

const bindingOut = {
  description:
    "Receptum account binding (receptum/account-binding/1) test vectors, SPEC §4.1. Every key here is a PUBLIC TEST VALUE: the RFC 8032 §7.1 TEST 1 seed (did:key, Stellar and Solana), anvil default account #0 (EVM), and the XRPL genesis key (passphrase masterpassphrase). Never use them for real funds.",
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
