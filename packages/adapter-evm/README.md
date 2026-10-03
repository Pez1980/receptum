# @receptum/adapter-evm

`ReceptumEscrow` (Solidity 0.8.30) and a viem rail for **Arc testnet** (`eip155:5042002`) and **Base Sepolia** (`eip155:84532`), both with Circle USDC.

- `open` (buyer, after ERC-20 approval) → `deliver(id, receiptHash)` (seller, before the deadline) → `accept` / `reject` (buyer or evaluator; reject only within the review window) → `release` (anyone, after the window) / `refund` (anyone, after the deadline with no delivery).
- Funding is checked by balance delta (fee-on-transfer/rebasing tokens and non-contract tokens are rejected), every fund-moving call is reentrancy-locked, the evaluator can't be the buyer or seller, and `sellerRefund` lets the seller return funds at any time before release.
- Sellers are paid in full on release. Events: `Opened`, `Delivered(id, receiptHash)`, `Released`, `Refunded`.
- `EvmAnchor` anchors a receiptHash as calldata `utf8("receptum/1") ‖ receiptHash` in a zero-value self-transaction (for x402 payments without escrow).

Tests: 24 Foundry tests incl. adversarial tokens (fee-on-transfer, no-return, malformed return, reentrant, blocklisting) and two fuzz tests (`forge test`), plus an anvil integration test for the TypeScript rail.
Deployed (testnet): `0x20d69c6c647559f48a7e6b0a3f922e99a4068f16` on Arc (hardened after the independent review; the earlier `0x468d4e3f…859a` deployment is superseded) — see [E2E_RESULTS.md](E2E_RESULTS.md).

**Threat notes.** A buyer can reject a genuine delivery within the review window (buyer-acceptance risk — use an evaluator for high-value jobs). Funds can't be released before delivery or refunded after delivery except by rejection. Unaudited; testnet only.
