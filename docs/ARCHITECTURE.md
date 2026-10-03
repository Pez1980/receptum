# Architecture

## Flow

```
buyer / agent                         seller service                       chain
     |  request job                         |                                  |
     |------------------------------------->|                                  |
     |  402 + quote (price, asset, payTo)   |                                  |
     |<-------------------------------------|                                  |
     |  pay (x402) or fund escrow ---------------------------------------------->|
     |  retry with payment proof            |                                  |
     |------------------------------------->|  verify payment / escrow ------->|
     |                                      |  ... does the work ...           |
     |                                      |  build DeliveryReceipt           |
     |                                      |  release escrow + anchor hash -->|
     |  output + receipt                    |                                  |
     |<-------------------------------------|                                  |
     |  verify: sha256(output) == receipt.outputSha256, receiptHash on-chain -->|
```

## Layers

- **core** — no chain code. Defines `DeliveryReceipt`, canonical hashing, the job state machine, and three interfaces every adapter implements:
  - `PaymentRail` — verify a direct payment against a quote.
  - `EscrowRail` — read, release (with a receipt hash) or refund an escrow.
  - `Anchor` — publish a receipt hash and find it again.
- **server / client / mcp** — HTTP and MCP integration, chain-agnostic, built on core.
- **adapters** — one per chain. Each maps the core interfaces to that chain's native primitives (EVM contracts, Soroban contracts, XRPL Escrow and memos).
- **verify** — reads only public chain data; needs no account or API key.

## Principles

- **Hashes only on-chain.** No media, prompts, customer data or raw job ids.
- **Deterministic receipts.** `canonicalJson` guarantees every party hashes the same bytes.
- **Buyer protection by default.** Escrow refunds after a deadline if delivery never happens.
- **No vendor lock-in.** Products integrate through the public packages; the SDK never depends on any product.
- **Keys stay with the integrator.** The SDK never stores private keys; signers are injected.
