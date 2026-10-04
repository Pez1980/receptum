# Changelog

All packages are versioned together. Testnet only; contracts are unaudited.

## 0.2.0 — October 2026

Not yet published; this release ships everything below. Testnets stay the default; nothing has been deployed to a mainnet.

### Added

- **Solana as a rail** (`@receptum/adapter-solana` 0.2.0, devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` behind the core opt-in):
  - `receptum_escrow`, a native Rust program with the hybrid state machine of the EVM/Soroban escrows (open with an SPL Token deposit into a PDA vault, `deliver(receiptHash)` once by the seller, accept/reject by buyer or evaluator, permissionless release after the review window and refund after a missed deadline, `seller_refund`; checked math; no admin; deployed immutable). Program tests run the published `.so` in LiteSVM. `SolanaEscrowRail` implements `EscrowRail`.
  - x402 `exact` on Solana devnet through the public facilitator (`@x402/svm` 2.28, devnet USDC) — `examples/x402-solana`.
  - SPL Memo anchors (`anchor:solana`, memo `receptum/1:<receiptHash>`) and `solana` account bindings (Ed25519 over SHA-256("Solana Signed Message:\n" ‖ m)), with a vector in `spec/vectors/account-binding-v1.json`.
  - Level 3 in `@receptum/verify` and the Python verifier: `x402:exact` (`transferChecked` + owner/mint balance deltas), `escrow:receptum-solana` (program hash and immutability, PDA, terms, released) and `anchor:solana`; SPEC §4.1, §7, §7.1, §7.3, §7.4.
- **Arbitrum**: `ReceptumEscrow` deployed on Arbitrum Sepolia (`eip155:421614`) at `0x1cd7ed69a10d5aafcf2fcb927a431183b3c43862` — byte-identical runtime code to the published artifact and the Arc deployment (code hash `0x58c8beee…1af24861`) — and added to `TRUSTED_ESCROWS` in `@receptum/verify` and the Python verifier. Live flows (buyer accepts, auto-release, refund after deadline, standalone anchor) with the seller's EVM binding (`examples/bindings/evm-arbitrum-sepolia.json`); released receipts VERIFIED in both verifiers. Arbitrum One (`eip155:42161`, native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) is a mainnet entry behind the opt-in, with an empty registry entry and `deploy-mainnet.mjs eip155:42161`. `scripts/e2e-testnet.mjs` takes the network as an argument (testnets only).
- **Account bindings** (SPEC §4.1): a statement signed by the seller's `did:key` and by the payout account's own key (EIP-191 on EVM, ripple-keypairs on XRPL, SEP-53 on Stellar) proves the seller controls `payment.payee`. Carried in `SignedReceipt.bindings`, outside the hashed receipt. Verifier level 2.5; `requireBinding` in `@receptum/client` and `@receptum/mcp`; `@receptum/server` can refuse to charge when its bindings don't cover `payTo`.
- **Soroban `ReceptumEscrow`** on Stellar testnet (`@receptum/adapter-stellar`, `SorobanEscrowRail`), same state machine as the EVM contract.
- **x402 `exact` on Stellar testnet and XRPL testnet** (XRP), with settlement checks in `@receptum/verify`.
- **XRPL issued tokens in RRF v1 receipts** (SPEC §7.3), for x402 `exact` on XRPL and `escrow:xrpl` (TokenEscrow): `payment.asset` = `<currency>.<issuer>` with the on-ledger currency code, `payment.amount` = the value in integer 10^-15 units. Exact, float-free conversion in `@receptum/core` (`xrplValueToUnits`, `xrplUnitsToValue`, handles exponent forms like `1e-2`); vectors in `spec/vectors/xrpl-issued-amount-v1.json`. Live x402 run through the public facilitator and TokenEscrow runs (40-hex RCPT and 3-character RCT), all VERIFIED.
- **Evaluator mode on XRPL native Escrow**: the evaluator is an `xrpl:` account and finishes the escrow itself (`XrplEscrowRail.accept(escrowId, { evaluator })`); the verifier passes only when the `EscrowFinish` `Account` is the evaluator. `XrplEscrowState.xrpl.settledBy` / `settlementTx`, `XRPL_ESCROW_CAPABILITIES`. Live run VERIFIED.
- **SPEC §7.5, the Stellar claimable-balance escrow**: reference format, claimant predicates, delivery data entry and derivation, batch-claim allocation, history bound — at the depth of the XRPL section.
- **Independent Python verifier** (`verifiers/python`, `receptum-verify-py`) written from the spec and vectors, at full parity with `@receptum/verify`: level 3 for `x402:exact` (EVM, Stellar, XRPL — XRP and issued tokens), `escrow:receptum-evm` (runtime-code hash pinned to the artifact, `escrows(id)` via hand-encoded `eth_call`), `escrow:receptum-soroban` (wasm hash and escrow storage via `getLedgerEntries`, hand-written XDR, SAC ids), `escrow:xrpl` (history-derived delivery and settlement, TokenEscrow amounts, evaluator mode, incomplete history `unavailable`), `escrow:stellar-claimable` (memo + data-entry delivery, batch-claim allocation) and every anchor, on the same testnets and mainnets; `xrpl_assets.py` pinned to both XRPL vector files; one trusted-deployment registry (`networks.TRUSTED_ESCROWS`); `--trust-escrow` and `--horizon` options.
- **Mainnet readiness, behind an explicit opt-in** (testnet stays the default):
  - `@receptum/core`: `networkClass`, `assertNetworkAllowed`, `mainnetAllowed`, `MainnetNotAllowedError`. Signing on a mainnet or unknown network requires `allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`.
  - `@receptum/adapter-evm`: Base (`eip155:8453`) and Arc (`eip155:5042`) mainnet entries (`MAINNETS`), gated in `clientsFor` and every signing path; `scripts/deploy-mainnet.mjs` (refuses without the flag and an audit report, plan + interactive confirmation, never reads wallet files).
  - `@receptum/adapter-xrpl`: `assertNetwork(client, expected, { allowMainnet })` replaces `assertTestnet()` (kept as a deprecated alias); `xrpl:0` endpoints; `network`/`allowMainnet` on the escrow rail and anchor.
  - `@receptum/adapter-stellar`: `STELLAR_PUBNET`, Circle mainnet USDC (`PUBNET_USDC`, `PUBNET_USDC_SAC`), `network: "pubnet"` + opt-in on every client and rail; network-qualified Soroban escrow ids; `scripts/deploy-soroban-mainnet.mjs`.
  - `@receptum/adapter-solana`: `scripts/deploy-mainnet.mjs` for `receptum_escrow` on mainnet-beta — refuses without `RECEPTUM_ALLOW_MAINNET=1` and an `https` audit report, takes the deployer keypair only from the path in `RECEPTUM_MAINNET_DEPLOYER_KEYPAIR` (never testnet wallets or `~/.config/solana`), checks the mainnet-beta genesis hash, refuses any `.so` but the canonical CI build (`b270e984…`, artifact `receptum_escrow-ci-build`), prints the plan with estimated rent and fees, refuses an underfunded deployer, requires the typed phrase, deploys with `--final` and verifies the on-chain ProgramData hash and the absence of an upgrade authority; raw CLI output is never printed. Nothing has been deployed with it.
  - `@receptum/verify` and the Python verifier: read-only mainnet endpoints, empty mainnet `TRUSTED_ESCROWS` entries (a genuine mainnet escrow is `pending`, `untrusted deployment`), `network`/`networkClass` in reports and a MAINNET/TESTNET header line in both CLIs.
  - `@receptum/server`: `facilitatorUrlFor` (no default mainnet facilitator) and `allowMainnet` in `handlePaidJob`. `@receptum/client`: `networks` + `allowMainnet` in `createReceptumFetch`.
- Negative test vectors (`spec/vectors/rrf-v1.json` `invalid`), account-binding vectors, XRPL currency and issued-amount vectors.
- `scripts/verify-examples.mjs` and `verifiers/python/scripts/verify_examples.py`: re-verify every published testnet receipt (30 cases, identical lists and output) against live chains.
- Published deliverables and seller bindings for every escrow receipt: the Stellar claimable-balance and XRPL escrow e2e runs were repeated so their released flows are VERIFIED (`packages/adapter-stellar/e2e-claimable-results.json`, `examples/xrpl-testnet-escrow-{a,c}.json`, `examples/deliverables/`).

### Changed (verifier behaviour)

- **VERIFIED** now requires the delivered file, the seller signature, a payee binding (or `--allow-unbound`), settlement on the rail **and** `receiptHash` committed on-chain (by the escrow, or a mined anchor for x402). Otherwise `PARTIALLY VERIFIED` with each missing piece listed (SPEC §6).
- Checks that cannot run (RPC down, unsupported rail, unvalidated ledger, truncated history) are `unavailable`, never pass or fail.
- Strict input: I-JSON only (duplicate keys rejected), exact signed-receipt envelope, strict JWS header, `did:` values never parsed as CAIP-10.
- Anchors carried in the input wrapper (`anchor`) are checked automatically.
- Only `x402:exact` is recognised; on EVM, `payment.asset` must be the token contract address.
- The contract escrows' commitment is their **storage** record (SPEC §7); events are informational and never decide.
- Payer and payee must be accounts on `payment.network` on every rail, before any query (stated generally in SPEC §7.3).
- A Soroban escrow reference to a contract that does not exist **fails** (as missing EVM code does) instead of `unavailable`.
- `escrow:stellar-claimable`: a malformed reference (anything but the hex balance id or its `B…` strkey) and a balance without exactly the Receptum claimant shape **fail** instead of `unavailable`; `parseEscrowTerms` errors all start with `not a Receptum escrow`.
- `escrow:xrpl` and `anchor:xrpl` in `@receptum/verify` check the server's NetworkID like the x402 path (another `network_id` is `unavailable`); an `anchor:xrpl` transaction unknown to the server is `unavailable` (servers may lack history) instead of a failure.
- Both verifier CLIs print the network label as the first line of human-readable output (the verdict moves to the second line; `--json` is unchanged apart from the new `network`/`networkClass` members).
- `parseSorobanEscrowId` also returns `network`, and accepts `stellar:pubnet` ids.

### Fixed

- Review round 2 items 3 (Soroban escrow), 13 (history-derived delivery on XRPL and Stellar) and 14 (Stellar batch claims).
- Review round 3 (Codex): XRPL currency identity comparison (case-sensitive, protocol bytes), nonstandard XRPL currencies, incomplete XRPL history, binding expiry during settlement, malformed EVM `Transfer` logs, XRPL escrow acceptance terms. See [SECURITY.md](SECURITY.md).
- Review round 4 (Codex, 4 Oct 2026), see [SECURITY.md](SECURITY.md#review-round-4-codex-4-oct-2026):
  - **Solana `receptum_escrow` donation lock (High):** payouts now move the whole vault (≥ `amount`) instead of requiring an exact balance. The fixed build (`e20b63d3…3e451b`) is a new immutable devnet program `4iUzsYkrzcUdc3aFsgXg5aocHWShMjQ3dCNSyg6dwgYC`; the first deployment `6VdZ7E96…` is superseded (removed from `TRUSTED_ESCROWS`, its build no longer verifies) and the Solana escrow receipts A–F were re-run and replaced. EVM and Soroban escrows were checked and are not affected (donation tests added).
  - **Signing gates verify the RPC's network (High):** Solana checks the genesis hash before every signature; EVM checks `eth_chainId`; Horizon checks its network passphrase; Soroban re-checks its passphrase before every signature (XRPL already checked NetworkID).
  - **Solana build reproducibility:** the deployed fix build `e20b63d3…` was built on macOS arm64 and does not reproduce on Linux. The canonical build is now Linux x86_64 with pinned Agave 4.3.0 (`b270e984…1467c3`), enforced by the CI job `solana-program`, and is deployed as a new immutable devnet program `2neqpNegEPy9zYppnbMtksNdoXLE9XDesAbBEqKUqTsg`; `4iUzsYkr…` is superseded like `6VdZ7E96…` (removed from `TRUSTED_ESCROWS`), and flows A–F were re-run against the new program.
  - `@receptum/client`: `createReceptumFetch` requires `networks` and gates `expected.network` (Medium).
  - `@receptum/verify`: `escrow:receptum-solana` is dispatched by rail first, so a non-Solana `payment.network` fails as in Python (Low).
  - The anvil integration test uses a free port with start-up failure detection and an awaited shutdown; the pre-push hook prints why `pnpm check` failed (Low).
- Review round 4b (Codex verification pass), see [SECURITY.md](SECURITY.md#review-round-4b-codex-verification-pass-4-oct-2026):
  - **Solana mainnet deploy TOCTOU (High):** `deploy-mainnet.mjs` reads the validated `.so` once, gives `solana program write-buffer` only a private mode-600 snapshot of those bytes and verifies the uploaded Buffer account's hash and authority before `deploy --final` (nothing is deployed on a mismatch; the temporary keys are kept). The Soroban script checks the uploaded wasm hash before creating the contract; the EVM script checks the deployed runtime code hash before writing the record.
  - **Solana `--so` path aliasing (Medium):** `--so` must be absolute and is canonicalized with `realpath` (symlinks, `..`) and refused before any read when inside a wallet directory (also by real path) or not a regular file.
- Verifier parity round: the Python verifier's XRPL issued-token, TokenEscrow and evaluator rules, its single trusted registry and identical mainnet escrow verdicts, and the TypeScript/SPEC gaps listed under _Changed_. See [SECURITY.md](SECURITY.md).
- `@receptum/server` records XRPL issued-token x402 requirements as `<currency>.<issuer>` + 10^-15 units and refuses, before charging, values that are not exactly representable (and issued-token requirements on other networks).
- `@receptum/client`: `expected.amount` / `maxAmount` must be integers in the receipt's unit (10^-15 units for XRPL issued tokens); XRPL assets compare by currency identity and issuer; non-EVM payees compare case-sensitively.

### Breaking (since the 0.2.0 draft)

- `@receptum/adapter-xrpl`: `iouDecimals` is removed — issued-token amounts are always 10^-15 units; `toXrplAmount(asset, amount)` and `fromXrplAmount(amount)` lose their `decimals` argument; `parseXrplAsset` and the escrow rail refuse display symbols (`RLUSD.r…`) — use the 40-hex code. `spec/vectors/xrpl-currency-v1.json` marks display symbols invalid.
- `@receptum/adapter-solana`: `sendAndConfirm(rpc, payer, instructions, options)` takes `{ network, allowMainnet?, extraSigners?, commitment?, timeoutMs? }` (the network is required; extra signers moved into the options). `RECEPTUM_SOLANA_PROGRAM_ID` / `RECEPTUM_SOLANA_PROGRAM_HASH` are the new deployment and build.
- `@receptum/client`: `createReceptumFetch` requires `networks` (the CAIP-2 networks `paidFetch` pays on).
- Python verifier: `xrpl_x402._currency_id` / `_asset_currency_id` and `xrpl_escrow.ISSUED_DECIMALS` are gone (use `xrpl_assets.currency_id`, `value_to_units`); `TRUSTED_EVM_ESCROWS` and `TRUSTED_SOROBAN_ESCROWS` are aliases of `networks.TRUSTED_ESCROWS`.

## 0.1.0 — October 2026

First release: RRF v1 receipts, x402 server/client, MCP receipts, `receptum-verify`, `ReceptumEscrow` on Arc testnet, XRPL and Stellar claimable-balance escrows.
