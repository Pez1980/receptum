# Receptum

**Pay-per-job for AI agents and services, with escrow and verifiable proof of delivery.**

Receptum is an open-source TypeScript SDK that lets any service charge per unit of work in stablecoins and prove what it delivered:

1. **Quote and pay** — the seller prices a job and answers with HTTP `402 Payment Required` ([x402](https://www.x402.org/)). Humans or AI agents pay in USDC or RLUSD.
2. **Escrow** — funds are held on-chain until the work is delivered, so the buyer can be refunded if it isn't.
3. **Receipt** — on delivery, the seller publishes a _delivery receipt_: SHA-256 hashes of the inputs, the output and any QA evidence, tied to the payment. Only hashes go on-chain — never the content.
4. **Verify** — anyone holding the file can hash it and check, on-chain, who delivered it, when and for how much.

It was built for AI video rendering, but works for any job with a digital deliverable: transcription, design, code generation, data enrichment, or MCP tool calls.

## Packages

| Package                                                 | What it does                                                | Status           |
| ------------------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| [`@receptum/core`](packages/core)                       | Receipts, canonical hashing, job lifecycle, rail interfaces | Usable (pre-1.0) |
| [`@receptum/server`](packages/server)                   | Seller-side x402 middleware for Fastify / Express           | Planned          |
| [`@receptum/client`](packages/client)                   | Buyer / agent client with spending limits                   | Planned          |
| [`@receptum/mcp`](packages/mcp)                         | Paid MCP tools                                              | Planned          |
| [`@receptum/verify`](packages/verify)                   | CLI + web page to verify a file against its receipt         | Planned          |
| [`@receptum/adapter-evm`](packages/adapter-evm)         | Base and Arc: USDC, escrow contract, receipt anchoring      | Planned          |
| [`@receptum/adapter-stellar`](packages/adapter-stellar) | Stellar: USDC, Soroban escrow                               | Planned          |
| [`@receptum/adapter-xrpl`](packages/adapter-xrpl)       | XRP Ledger: RLUSD, native Escrow                            | Planned          |

See the [architecture](docs/ARCHITECTURE.md) and [roadmap](docs/ROADMAP.md).

## Quick look

```ts
import { createReceipt, receiptHash, sha256File } from "@receptum/core";

const receipt = createReceipt({
  jobId: "render-8841",
  inputSha256: [await sha256File("source.mp4")],
  outputSha256: await sha256File("final.mp4"),
  payment: { rail: "evm:base", asset: "USDC", amount: "2500000", reference: "0x…" },
});

receiptHash(receipt); // the one value anchored on-chain
```

## Development

Requires Node 22 and pnpm 9.

```sh
pnpm install
pnpm check   # format, lint, typecheck, test, build
```

## Security

Receptum moves money. Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Escrow contracts are **unaudited** until stated otherwise; don't use them with significant funds.

## License

[Apache-2.0](LICENSE). Copyright 2026 Swiftleads AI, Inc. and contributors.
