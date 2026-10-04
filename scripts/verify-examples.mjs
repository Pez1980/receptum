// Re-verifies every published testnet receipt against live chains (needs network; not in CI).
//   pnpm build && node scripts/verify-examples.mjs
// verifiers/python/scripts/verify_examples.py lists exactly the same cases, labels and expected
// verdicts, and prints the same lines.
import { readFileSync } from "node:fs";
import { verify } from "../packages/verify/dist/index.js";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const json = (p) => JSON.parse(read(p).toString("utf8"));
const wrapper = (doc) => ({
  signed: doc.signedReceipt ?? doc,
  anchors: [doc.anchor ?? []].flat(),
});
const soroban = json("packages/adapter-stellar/e2e-soroban-results.json").flows;
const claimable = json("packages/adapter-stellar/e2e-claimable-results.json").flows;
const arc = json("packages/adapter-evm/e2e-results.json").flows;
const arbitrum = json("packages/adapter-evm/e2e-results.arbitrum-sepolia.json").flows;
const mcp = json("packages/mcp/e2e-results.json");

const cases = [
  [
    "x402 · Base Sepolia, anchored on Arc",
    wrapper(json("examples/x402-base-sepolia.json")),
    "examples/x402-base-sepolia-output.svg",
    "VERIFIED",
  ],
  [
    "x402 · Stellar testnet, anchored on Arc",
    wrapper(json("examples/x402-stellar-testnet.json")),
    "examples/x402-stellar-testnet-output.svg",
    "VERIFIED",
  ],
  [
    "x402 · XRPL testnet, memo anchor",
    wrapper(json("examples/x402-xrpl-testnet.json")),
    "examples/x402-xrpl-testnet-output.svg",
    "VERIFIED",
  ],
  [
    "x402 · XRPL testnet, issued token (RCPT), memo anchor",
    wrapper(json("examples/x402-xrpl-token-testnet.json")),
    "examples/x402-xrpl-token-testnet-output.svg",
    "VERIFIED",
  ],
  [
    "x402-paid MCP tool · Base Sepolia, anchored on Arc",
    { signed: mcp.receipt, anchors: [mcp.anchor] },
    "examples/deliverables/mcp-base-sepolia-tool-result.json",
    "VERIFIED",
  ],
  [
    "ReceptumEscrow · Arc · buyer accepts",
    wrapper(json("examples/arc-testnet-escrow-a.json")),
    "examples/deliverables/arc-testnet-escrow-a.txt",
    "VERIFIED",
  ],
  [
    "ReceptumEscrow · Arc · auto-release",
    { signed: arc[1].signedReceipt, anchors: [] },
    "examples/deliverables/arc-testnet-escrow-b.txt",
    "VERIFIED",
  ],
  [
    "ReceptumEscrow · Arc · standalone anchor demo (no escrow behind it)",
    { signed: arc[3].signedReceipt, anchors: [`eip155:5042002:${arc[3].txs.anchor}`] },
    null,
    "NOT VERIFIED",
  ],
  [
    "ReceptumEscrow · Arbitrum Sepolia · buyer accepts",
    wrapper(json("examples/arbitrum-sepolia-escrow-a.json")),
    "examples/deliverables/arbitrum-sepolia-escrow-a.txt",
    "VERIFIED",
  ],
  [
    "ReceptumEscrow · Arbitrum Sepolia · auto-release",
    { signed: arbitrum[1].signedReceipt, anchors: [] },
    "examples/deliverables/arbitrum-sepolia-escrow-b.txt",
    "VERIFIED",
  ],
  [
    "ReceptumEscrow · Arbitrum Sepolia · standalone anchor demo (no escrow behind it)",
    { signed: arbitrum[3].signedReceipt, anchors: [`eip155:421614:${arbitrum[3].txs.anchor}`] },
    null,
    "NOT VERIFIED",
  ],
  [
    "XRPL Escrow · crypto-condition release",
    wrapper(json("examples/xrpl-testnet-escrow-a.json")),
    "examples/deliverables/xrpl-testnet-escrow-a.txt",
    "VERIFIED",
  ],
  [
    "XRPL TokenEscrow · issued token (RCT, 3-character code), crypto-condition release",
    wrapper(json("examples/xrpl-testnet-escrow-c.json")),
    "examples/deliverables/xrpl-testnet-escrow-c.txt",
    "VERIFIED",
  ],
  [
    "XRPL Escrow · evaluator finishes from its own account",
    wrapper(json("examples/xrpl-testnet-escrow-evaluator.json")),
    "examples/deliverables/xrpl-testnet-escrow-evaluator.txt",
    "VERIFIED",
  ],
  [
    "XRPL TokenEscrow · issued token (RCPT), buyer accepts",
    wrapper(json("examples/xrpl-testnet-escrow-token.json")),
    "examples/deliverables/xrpl-testnet-escrow-token.txt",
    "VERIFIED",
  ],
  [
    "Soroban escrow · buyer accepts",
    { signed: soroban.A.signedReceipt, anchors: [] },
    Buffer.from(soroban.A.deliverable),
    "VERIFIED",
  ],
  [
    "Soroban escrow · auto-release",
    { signed: soroban.B.signedReceipt, anchors: [] },
    Buffer.from(soroban.B.deliverable),
    "VERIFIED",
  ],
  [
    "Soroban escrow · evaluator rejected (refunded)",
    { signed: soroban.D.signedReceipt, anchors: [] },
    Buffer.from(soroban.D.deliverable),
    "NOT VERIFIED",
  ],
  [
    "Soroban escrow · seller refunded voluntarily",
    { signed: soroban.E.signedReceipt, anchors: [] },
    Buffer.from(soroban.E.deliverable),
    "NOT VERIFIED",
  ],
  [
    "Stellar claimable balance · auto-release",
    { signed: claimable.A.signedReceipt, anchors: [] },
    "examples/deliverables/stellar-claimable-a.txt",
    "VERIFIED",
  ],
  [
    "Stellar claimable balance · buyer accepts",
    { signed: claimable.B.signedReceipt, anchors: [] },
    "examples/deliverables/stellar-claimable-b.txt",
    "VERIFIED",
  ],
  [
    "Stellar claimable balance · buyer rejected (refunded)",
    { signed: claimable.D.signedReceipt, anchors: [] },
    "examples/deliverables/stellar-claimable-d.txt",
    "NOT VERIFIED",
  ],
  [
    "x402 · Solana devnet, memo anchor",
    wrapper(json("examples/x402-solana-devnet.json")),
    "examples/x402-solana-devnet-output.svg",
    "VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · buyer accepts",
    wrapper(json("examples/solana-devnet-escrow-a.json")),
    "examples/deliverables/solana-devnet-escrow-a.txt",
    "VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · auto-release",
    wrapper(json("examples/solana-devnet-escrow-b.json")),
    "examples/deliverables/solana-devnet-escrow-b.txt",
    "VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · evaluator accepts",
    wrapper(json("examples/solana-devnet-escrow-f.json")),
    "examples/deliverables/solana-devnet-escrow-f.txt",
    "VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · missed deadline (refunded, nothing delivered)",
    wrapper(json("examples/solana-devnet-escrow-c.json")),
    "examples/deliverables/solana-devnet-escrow-c.txt",
    "NOT VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · evaluator rejected (refunded)",
    wrapper(json("examples/solana-devnet-escrow-d.json")),
    "examples/deliverables/solana-devnet-escrow-d.txt",
    "NOT VERIFIED",
  ],
  [
    "receptum_escrow · Solana devnet · seller refunded voluntarily",
    wrapper(json("examples/solana-devnet-escrow-e.json")),
    "examples/deliverables/solana-devnet-escrow-e.txt",
    "NOT VERIFIED",
  ],
  [
    "Tampered x402 receipt (amount edited)",
    wrapper(json("examples/x402-base-sepolia-tampered.json")),
    "examples/x402-base-sepolia-output.svg",
    "NOT VERIFIED",
  ],
];

let bad = 0;
for (const [label, { signed, anchors }, file, want] of cases) {
  const bytes =
    file === null
      ? undefined
      : typeof file === "string"
        ? new Uint8Array(read(file))
        : new Uint8Array(file);
  const r = await verify(signed, { ...(bytes ? { file: bytes } : {}), anchors });
  const ok = r.verdict === want;
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${r.verdict.padEnd(18)} ${label}${ok ? "" : ` (expected ${want}; missing: ${r.missing.join("; ")})`}`,
  );
}
process.exit(bad ? 1 : 0);
