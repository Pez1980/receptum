# Receptum

**Know what you paid for.** Receptum is an open receipt format for paid agent work: each receipt binds a payment to SHA-256 hashes of the exact inputs and output, signed by the seller and verifiable by anyone — on Base, Arc, Stellar, the XRP Ledger, or offline.

> Payment receipts say you were served. Receptum says what you got.

- **Spec:** [Receptum Receipt Format v1](docs/SPEC.md) with [test vectors](spec/vectors/rrf-v1.json)
- **Status:** v0.1.0 on npm, working end to end on **testnets** (October 2026). Escrow contracts are **unaudited** — do not use with real funds.

## Install

```sh
npm install @receptum/core          # receipts, signing, verification
npm install @receptum/server @receptum/client   # x402 paid jobs
npx @receptum/verify receipt.json delivered-file # verify any receipt
```

All packages: [npmjs.com/org/receptum](https://www.npmjs.com/org/receptum) · v0.1.0 · testnet-only, unaudited.

## How it works

1. **Quote** — a service prices a job; the agent pays through x402 or opens an escrow.
2. **Held** — escrowed funds wait on-chain until delivery is accepted, rejected, or the deadline passes.
3. **Delivered** — the seller signs a receipt binding the payment to hashes of the inputs and output and commits its `receiptHash` on-chain. Only hashes are published.
4. **Released** — the buyer or evaluator accepts, or the review window closes. The receipt records which.

## Packages

| Package                                                 | What it does                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`@receptum/core`](packages/core)                       | RRF v1 receipts, JCS (RFC 8785) hashing, Ed25519 `did:key` signatures, lifecycle, rail interfaces                      |
| [`@receptum/server`](packages/server)                   | Sell a job over x402: verify → work → settle → return the output with a signed receipt                                 |
| [`@receptum/client`](packages/client)                   | Pay over x402 and reject results whose receipt, output hash or settlement don't match                                  |
| [`@receptum/mcp`](packages/mcp)                         | Signed receipts for x402-paid MCP tools (`@x402/mcp`)                                                                  |
| [`@receptum/verify`](packages/verify)                   | Library + `receptum-verify` CLI: file, signature, settlement and anchor checks                                         |
| [`@receptum/adapter-evm`](packages/adapter-evm)         | `ReceptumEscrow` contract + viem rail for Arc testnet and Base Sepolia                                                 |
| [`@receptum/adapter-xrpl`](packages/adapter-xrpl)       | XRPL native Escrow with crypto-conditions + memo anchors                                                               |
| [`@receptum/adapter-stellar`](packages/adapter-stellar) | Soroban `ReceptumEscrow` contract + rail, claimable-balance escrow (USDC), `MEMO_HASH` anchors, x402 settlement checks |

## Live on testnets

| What                                                                                 | Network                    | Evidence                                                                                                         |
| ------------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| x402 render sold for 0.25 USDC, receipt anchored cross-chain                         | Base Sepolia → Arc testnet | [examples/E2E_RESULTS.md](examples/E2E_RESULTS.md)                                                               |
| Paid MCP tool call with receipt                                                      | Base Sepolia               | [packages/mcp/E2E_RESULTS.md](packages/mcp/E2E_RESULTS.md)                                                       |
| Escrow: accept, auto-release, refund, anchor                                         | Arc testnet                | [packages/adapter-evm/E2E_RESULTS.md](packages/adapter-evm/E2E_RESULTS.md)                                       |
| Escrow: release, refund, issued-token escrow                                         | XRPL testnet               | [packages/adapter-xrpl/E2E_RESULTS.md](packages/adapter-xrpl/E2E_RESULTS.md)                                     |
| Soroban escrow (USDC): accept, auto-release, refund, evaluator reject, seller refund | Stellar testnet            | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md)                               |
| x402 render sold for 0.01 USDC with receipt                                          | Stellar testnet            | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md#x402-exact-on-stellar-testnet) |
| Claimable-balance escrow (USDC): auto-release, accept, refund, reject                | Stellar testnet            | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md)                               |
| Independent verification of all of the above                                         | all four                   | [packages/verify/E2E_RESULTS.md](packages/verify/E2E_RESULTS.md)                                                 |

## Quick look

```ts
import {
  createReceipt,
  generateSellerKey,
  sha256File,
  signReceipt,
  verifySignedReceipt,
} from "@receptum/core";

const seller = generateSellerKey(); // store privateKeyPem securely; never commit it
const signed = signReceipt(
  createReceipt({
    jobId: "render-8841",
    seller: { id: seller.did, name: "render.example" },
    inputSha256: [await sha256File("source.mp4")],
    outputSha256: await sha256File("final.mp4"),
    payment: {
      rail: "x402:exact",
      network: "eip155:84532",
      asset: "USDC",
      amount: "250000",
      reference: "0x…",
    },
    acceptance: { mode: "auto", reviewWindowSeconds: 259200 },
    remedy: { kind: "rerender", withinDays: 30 },
  }),
  seller,
);

verifySignedReceipt(signed); // { ok: true, seller: "did:key:…", receiptHash: "…" }
```

Verify any receipt:

```sh
node packages/verify/dist/cli.js examples/x402-base-sepolia.json examples/x402-base-sepolia-output.svg \
  --anchor eip155:5042002:0x178192fa86acc85fb2b33189708703a96125feb5bef6c6817f8faedeefaa6103
```

## Run the examples

```sh
pnpm install && pnpm build
node examples/toy-renderer/server.mjs        # sells renders for $0.25 on Base Sepolia
node examples/agent-buyer/buyer.mjs           # pays, then verifies the receipt before trusting the result
```

Testnet wallets are read from `~/.config/receptum/wallets` (override with `RECEPTUM_WALLETS_DIR`). Fund them from the Circle testnet faucet, the XRPL testnet faucet or Stellar friendbot. Keys never live in this repository.

## Development

Node 22, pnpm 9, Foundry for the EVM contract, Rust (`rustup`, pinned by `rust-toolchain.toml`) and `stellar-cli` for the Soroban contract.

```sh
pnpm install
pnpm check                                   # format, lint, build, typecheck, tests (incl. anvil)
(cd packages/adapter-evm && forge test)      # Solidity tests incl. fuzzing
(cd packages/adapter-stellar/contracts/receptum-escrow && cargo test)   # Soroban contract tests
git config core.hooksPath .githooks          # secret scan on commit, full check on push
```

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). The escrow contracts and adapters are unaudited and testnet-only.

## License

[Apache-2.0](LICENSE). Copyright 2026 Swiftleads AI, Inc. and contributors.
