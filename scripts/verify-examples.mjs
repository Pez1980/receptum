// Re-verifies every published testnet receipt against live chains (needs network; not in CI).
//   pnpm build && node scripts/verify-examples.mjs
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
const arc = json("packages/adapter-evm/e2e-results.json").flows;
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
    "XRPL Escrow · crypto-condition release",
    wrapper(json("examples/xrpl-testnet-escrow-a.json")),
    "examples/deliverables/xrpl-testnet-escrow-a.txt",
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
    "Tampered x402 receipt (amount edited)",
    wrapper(json("examples/x402-base-sepolia-tampered.json")),
    "examples/x402-base-sepolia-output.svg",
    "NOT VERIFIED",
  ],
];

let bad = 0;
for (const [label, { signed, anchors }, file, want] of cases) {
  const bytes = typeof file === "string" ? new Uint8Array(read(file)) : new Uint8Array(file);
  const r = await verify(signed, { file: bytes, anchors });
  const ok = r.verdict === want;
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${r.verdict.padEnd(18)} ${label}${ok ? "" : ` (expected ${want}; missing: ${r.missing.join("; ")})`}`,
  );
}
process.exit(bad ? 1 : 0);
