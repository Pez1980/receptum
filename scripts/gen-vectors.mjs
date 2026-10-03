// Regenerates spec/vectors/rrf-v1.json from the reference implementation.
// The seed below is a PUBLIC TEST VALUE — never use it for real receipts.
import { writeFileSync } from "node:fs";
import {
  createReceipt,
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
