# Receptum

**Know what you paid for.** Receptum is an open receipt format for paid agent work: each receipt binds a payment to SHA-256 hashes of the exact inputs and output, signed by the seller and verifiable by anyone — on Base, Arc, Stellar, the XRP Ledger, or offline.

> Payment receipts say you were served. Receptum says what you got.

- **Spec:** [Receptum Receipt Format v1](docs/SPEC.md) with [test vectors](spec/vectors/rrf-v1.json)
- **Independent verifier:** [Python `receptum-verify`](verifiers/python), written from the spec alone — check receipts without trusting the TypeScript code
- **Status:** v0.2.0, working end to end on **four testnets** (October 2026): x402 payments on Base, Stellar and the XRP Ledger, escrow on Arc, Stellar (Soroban) and the XRP Ledger. Every published receipt re-verifies in full with `node scripts/verify-examples.mjs`. Escrow contracts are **unaudited** — do not use with real funds. Mainnet plan: [docs/MAINNET.md](docs/MAINNET.md).

## Install

```sh
npm install @receptum/core          # receipts, signing, verification
npm install @receptum/server @receptum/client   # x402 paid jobs
npx @receptum/verify receipt.json delivered-file # verify any receipt
```

All packages: [npmjs.com/org/receptum](https://www.npmjs.com/org/receptum) · v0.2.0 · testnet-only, unaudited.

## How it works

1. **Quote** — a service prices a job; the agent pays through x402 or opens an escrow.
2. **Held** — escrowed funds wait on-chain until delivery is accepted, rejected, or the deadline passes.
3. **Delivered** — the seller signs a receipt binding the payment to hashes of the inputs and output and commits its `receiptHash` on-chain. Only hashes are published. A pseudonymous [account binding](docs/SPEC.md) proves the seller's signing key controls the wallet that was paid.
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

Every receipt below is published in this repository with its delivered bytes and verifies against the live testnets — file hash, seller signature, seller ↔ payout-wallet binding, settlement on the rail, and `receiptHash` committed on-chain (SPEC §6):

```sh
pnpm build && node scripts/verify-examples.mjs
```

| Receipt                                                                             | Network                    | Verdict                                        | Evidence                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| x402 render, 0.25 USDC, receipt anchored cross-chain                                | Base Sepolia → Arc testnet | VERIFIED                                       | [examples/E2E_RESULTS.md](examples/E2E_RESULTS.md)                                                               |
| x402 render, 0.01 USDC, anchored on Arc                                             | Stellar testnet → Arc      | VERIFIED                                       | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md#x402-exact-on-stellar-testnet) |
| x402 render, 0.01 XRP, memo anchor                                                  | XRPL testnet               | VERIFIED                                       | [examples/x402-xrpl](examples/x402-xrpl)                                                                         |
| Paid MCP tool call with receipt, anchored on Arc                                    | Base Sepolia → Arc testnet | VERIFIED                                       | [packages/mcp/E2E_RESULTS.md](packages/mcp/E2E_RESULTS.md)                                                       |
| `ReceptumEscrow`: buyer accepts · auto-release (also refund, standalone anchor)     | Arc testnet                | VERIFIED                                       | [packages/adapter-evm/E2E_RESULTS.md](packages/adapter-evm/E2E_RESULTS.md)                                       |
| Native Escrow with crypto-condition: release (also refund, issued-token escrow)     | XRPL testnet               | VERIFIED                                       | [packages/adapter-xrpl/E2E_RESULTS.md](packages/adapter-xrpl/E2E_RESULTS.md)                                     |
| Soroban escrow (USDC): buyer accepts · auto-release                                 | Stellar testnet            | VERIFIED                                       | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md)                               |
| Soroban escrow: evaluator rejected → refunded (also missed deadline, seller refund) | Stellar testnet            | NOT VERIFIED (correct: the seller wasn't paid) | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md)                               |
| Claimable-balance escrow (USDC): auto-release, accept, refund, reject               | Stellar testnet            | see results                                    | [packages/adapter-stellar/E2E_RESULTS.md](packages/adapter-stellar/E2E_RESULTS.md)                               |
| Tampered receipt (amount edited)                                                    | —                          | NOT VERIFIED                                   | [examples/x402-base-sepolia-tampered.json](examples/x402-base-sepolia-tampered.json)                             |

Full per-check detail: [packages/verify/E2E_RESULTS.md](packages/verify/E2E_RESULTS.md). The [Python verifier](verifiers/python) independently reaches the same verdicts for the x402 receipts on Base Sepolia and XRPL; it does not implement escrow rails or Stellar settlement and reports those `PARTIALLY VERIFIED` rather than guessing.

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
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
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
node packages/verify/dist/cli.js examples/x402-base-sepolia.json examples/x402-base-sepolia-output.svg
# the anchor carried in the file is checked automatically; add more with --anchor <caip2>:<tx>
```

or, independently of the TypeScript code, with the [Python verifier](verifiers/python):

```sh
python -m receptum_verify examples/x402-base-sepolia.json examples/x402-base-sepolia-output.svg
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
