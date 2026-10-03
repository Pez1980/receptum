# @receptum/adapter-evm

`ReceptumEscrow` (Solidity 0.8.30) and a viem rail for **Arc testnet** (`eip155:5042002`) and **Base Sepolia** (`eip155:84532`), both with Circle USDC.

- `open` (buyer, after ERC-20 approval) → `deliver(id, receiptHash)` (seller, before the deadline) → `accept` / `reject` (buyer or evaluator; reject only within the review window) → `release` (anyone, after the window) / `refund` (anyone, after the deadline with no delivery).
- Sellers are paid in full on release. Events: `Opened`, `Delivered(id, receiptHash)`, `Released`, `Refunded`.
- `EvmAnchor` anchors a receiptHash as calldata `utf8("receptum/1") ‖ receiptHash` in a zero-value self-transaction (for x402 payments without escrow).

Tests: 13 Foundry tests incl. a funds-conservation fuzz test (`forge test`), plus an anvil integration test for the TypeScript rail.
Deployed (testnet): `0x468d4e3fdbd8186a9c9b226ef830ef103e98859a` on Arc — see [E2E_RESULTS.md](E2E_RESULTS.md).

**Threat notes.** A buyer can reject a genuine delivery within the review window (buyer-acceptance risk — use an evaluator for high-value jobs). Funds can't be released before delivery or refunded after delivery except by rejection. Unaudited; testnet only.
