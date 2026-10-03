# Changelog

All packages are versioned together. Testnet only; contracts are unaudited.

## Unreleased

### Added

- **Python verifier parity** (`verifiers/python`): level 3 for `x402:exact` on Stellar testnet, `escrow:receptum-evm` (runtime-code hash pinned to the artifact, trusted registry, `escrows(id)` via hand-encoded `eth_call`), `escrow:receptum-soroban` (wasm hash and escrow storage via `getLedgerEntries`, hand-written XDR, SAC ids), `escrow:xrpl` (history-derived delivery and settlement, incomplete history `unavailable`), `escrow:stellar-claimable` (memo + data-entry delivery, batch-claim allocation) and `anchor:stellar`; `--trust-escrow` and `--horizon` options; `verifiers/python/scripts/verify_examples.py` reaches the TypeScript verdict on every published receipt.

## 0.2.0 — October 2026

### Added

- **Account bindings** (SPEC §4.1): a statement signed by the seller's `did:key` and by the payout account's own key (EIP-191 on EVM, ripple-keypairs on XRPL, SEP-53 on Stellar) proves the seller controls `payment.payee`. Carried in `SignedReceipt.bindings`, outside the hashed receipt. Verifier level 2.5; `requireBinding` in `@receptum/client` and `@receptum/mcp`; `@receptum/server` can refuse to charge when its bindings don't cover `payTo`.
- **Soroban `ReceptumEscrow`** on Stellar testnet (`@receptum/adapter-stellar`, `SorobanEscrowRail`), same state machine as the EVM contract.
- **x402 `exact` on Stellar testnet and XRPL testnet** (XRP), with settlement checks in `@receptum/verify`.
- **Independent Python verifier** (`verifiers/python`, `receptum-verify-py`) written from the spec and vectors.
- Negative test vectors (`spec/vectors/rrf-v1.json` `invalid`), account-binding vectors, XRPL currency vectors.
- `scripts/verify-examples.mjs`: re-verifies every published testnet receipt against live chains.

### Changed (verifier behaviour)

- **VERIFIED** now requires the delivered file, the seller signature, a payee binding (or `--allow-unbound`), settlement on the rail **and** `receiptHash` committed on-chain (by the escrow, or a mined anchor for x402). Otherwise `PARTIALLY VERIFIED` with each missing piece listed (SPEC §6).
- Checks that cannot run (RPC down, unsupported rail, unvalidated ledger, truncated history) are `unavailable`, never pass or fail.
- Strict input: I-JSON only (duplicate keys rejected), exact signed-receipt envelope, strict JWS header, `did:` values never parsed as CAIP-10.
- Anchors carried in the input wrapper (`anchor`) are checked automatically.
- Only `x402:exact` is recognised; on EVM, `payment.asset` must be the token contract address.

### Fixed

- Review round 2 items 3 (Soroban escrow), 13 (history-derived delivery on XRPL and Stellar) and 14 (Stellar batch claims).
- Review round 3 (Codex): XRPL currency identity comparison (case-sensitive, protocol bytes), nonstandard XRPL currencies, incomplete XRPL history, binding expiry during settlement, malformed EVM `Transfer` logs, XRPL escrow acceptance terms. See [SECURITY.md](SECURITY.md).
- `@receptum/server` refuses issued-token x402 requirements, which RRF v1 amounts cannot record losslessly.

## 0.1.0 — October 2026

First release: RRF v1 receipts, x402 server/client, MCP receipts, `receptum-verify`, `ReceptumEscrow` on Arc testnet, XRPL and Stellar claimable-balance escrows.
