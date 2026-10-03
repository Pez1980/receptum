# Changelog

All packages are versioned together. Testnet only; contracts are unaudited.

## Unreleased

### Added — mainnet readiness (opt-in; testnet stays the default)

- `@receptum/core`: `networkClass`, `assertNetworkAllowed`, `mainnetAllowed`, `MainnetNotAllowedError`. Signing on a mainnet or unknown network requires `allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`.
- `@receptum/adapter-evm`: Base (`eip155:8453`) and Arc (`eip155:5042`) mainnet entries (`MAINNETS`), gated in `clientsFor` and every signing path; `scripts/deploy-mainnet.mjs` (refuses without the flag and an audit report, plan + interactive confirmation, never reads wallet files).
- `@receptum/adapter-xrpl`: `assertNetwork(client, expected, { allowMainnet })` replaces `assertTestnet()` (kept as a deprecated alias); `xrpl:0` endpoints; `network`/`allowMainnet` on the escrow rail and anchor.
- `@receptum/adapter-stellar`: `STELLAR_PUBNET`, Circle mainnet USDC (`PUBNET_USDC`, `PUBNET_USDC_SAC`), `network: "pubnet"` + opt-in on every client and rail; network-qualified Soroban escrow ids; `scripts/deploy-soroban-mainnet.mjs`.
- `@receptum/verify` and the Python verifier: mainnet endpoints, empty mainnet `TRUSTED_ESCROWS` entries (mainnet escrow receipts report `untrusted deployment`), `network`/`networkClass` in reports and a MAINNET/TESTNET header line in both CLIs.
- `@receptum/server`: `facilitatorUrlFor` (no default mainnet facilitator) and `allowMainnet` in `handlePaidJob`. `@receptum/client`: `networks` + `allowMainnet` in `createReceptumFetch`.

### Changed

- Both verifier CLIs now print the network label as the first line of human-readable output (the verdict moves to the second line; `--json` is unchanged apart from the new `network`/`networkClass` members).
- `parseSorobanEscrowId` also returns `network`, and accepts `stellar:pubnet` ids.

Nothing has been deployed to a mainnet.

## 0.2.0 — October 2026

### Added

- **Account bindings** (SPEC §4.1): a statement signed by the seller's `did:key` and by the payout account's own key (EIP-191 on EVM, ripple-keypairs on XRPL, SEP-53 on Stellar) proves the seller controls `payment.payee`. Carried in `SignedReceipt.bindings`, outside the hashed receipt. Verifier level 2.5; `requireBinding` in `@receptum/client` and `@receptum/mcp`; `@receptum/server` can refuse to charge when its bindings don't cover `payTo`.
- **Soroban `ReceptumEscrow`** on Stellar testnet (`@receptum/adapter-stellar`, `SorobanEscrowRail`), same state machine as the EVM contract.
- **x402 `exact` on Stellar testnet and XRPL testnet** (XRP), with settlement checks in `@receptum/verify`.
- **Independent Python verifier** (`verifiers/python`, `receptum-verify-py`) written from the spec and vectors.
- Negative test vectors (`spec/vectors/rrf-v1.json` `invalid`), account-binding vectors, XRPL currency vectors.
- `scripts/verify-examples.mjs`: re-verifies every published testnet receipt against live chains.
- **XRPL issued tokens in RRF v1 receipts** (SPEC §7.3), for x402 `exact` on XRPL and `escrow:xrpl` (TokenEscrow): `payment.asset` = `<currency>.<issuer>` with the on-ledger currency code, `payment.amount` = the value in integer 10^-15 units. Exact, float-free conversion in `@receptum/core` (`xrplValueToUnits`, `xrplUnitsToValue`, handles exponent forms like `1e-2`); vectors in `spec/vectors/xrpl-issued-amount-v1.json`. Live x402 run through the public facilitator and a TokenEscrow run, both VERIFIED.
- **Evaluator mode on XRPL native Escrow**: the evaluator is an `xrpl:` account and finishes the escrow itself (`XrplEscrowRail.accept(escrowId, { evaluator })`); the verifier passes only when the `EscrowFinish` `Account` is the evaluator. `XrplEscrowState.xrpl.settledBy` / `settlementTx`, `XRPL_ESCROW_CAPABILITIES`. Live run VERIFIED.

### Changed (verifier behaviour)

- **VERIFIED** now requires the delivered file, the seller signature, a payee binding (or `--allow-unbound`), settlement on the rail **and** `receiptHash` committed on-chain (by the escrow, or a mined anchor for x402). Otherwise `PARTIALLY VERIFIED` with each missing piece listed (SPEC §6).
- Checks that cannot run (RPC down, unsupported rail, unvalidated ledger, truncated history) are `unavailable`, never pass or fail.
- Strict input: I-JSON only (duplicate keys rejected), exact signed-receipt envelope, strict JWS header, `did:` values never parsed as CAIP-10.
- Anchors carried in the input wrapper (`anchor`) are checked automatically.
- Only `x402:exact` is recognised; on EVM, `payment.asset` must be the token contract address.

### Fixed

- Review round 2 items 3 (Soroban escrow), 13 (history-derived delivery on XRPL and Stellar) and 14 (Stellar batch claims).
- Review round 3 (Codex): XRPL currency identity comparison (case-sensitive, protocol bytes), nonstandard XRPL currencies, incomplete XRPL history, binding expiry during settlement, malformed EVM `Transfer` logs, XRPL escrow acceptance terms. See [SECURITY.md](SECURITY.md).
- `@receptum/server` records XRPL issued-token x402 requirements as `<currency>.<issuer>` + 10^-15 units and refuses, before charging, values that are not exactly representable (and issued-token requirements on other networks).
- `@receptum/client`: `expected.amount` / `maxAmount` must be integers in the receipt's unit (10^-15 units for XRPL issued tokens); XRPL assets compare by currency identity and issuer; non-EVM payees compare case-sensitively.

### Breaking (unreleased since the 0.2.0 draft)

- `@receptum/adapter-xrpl`: `iouDecimals` is removed — issued-token amounts are always 10^-15 units; `toXrplAmount(asset, amount)` and `fromXrplAmount(amount)` lose their `decimals` argument; `parseXrplAsset` and the escrow rail refuse display symbols (`RLUSD.r…`) — use the 40-hex code. `spec/vectors/xrpl-currency-v1.json` marks display symbols invalid.

## 0.1.0 — October 2026

First release: RRF v1 receipts, x402 server/client, MCP receipts, `receptum-verify`, `ReceptumEscrow` on Arc testnet, XRPL and Stellar claimable-balance escrows.
