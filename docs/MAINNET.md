# Mainnet readiness

Everything in Receptum runs on testnets today. This is the checklist for moving each rail to mainnet. Nothing here has been deployed to a mainnet.

## 0. The audit promise

[`SECURITY.md`](../SECURITY.md) states that mainnet escrow support will not ship before an independent audit is published. Moving **escrow contracts** to mainnet first means either commissioning that audit or changing the public statement — decide before deploying, and say which in the release notes. Rails that hold **no funds** (receipt signing, x402 `exact` receipts, anchors, the verifiers) carry far less risk and can move first.

## 1. By rail

| Rail                                                             | Mainnet change                                                                                                                                                                        | Risk                                                                 | Blockers                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Receipts, signing, verifiers (`core`, `verify`, Python verifier) | none — chain-neutral                                                                                                                                                                  | none                                                                 | —                                                                                                                     |
| x402 `exact` receipts (`server`, `client`, `mcp`)                | register mainnet networks in the x402 resource server (e.g. `eip155:8453` Base); use a mainnet facilitator (Coinbase CDP or self-hosted)                                              | funds move buyer → seller directly; no Receptum contract holds money | facilitator account/API key for mainnet                                                                               |
| EVM anchors (`EvmAnchor`)                                        | add mainnet `NETWORKS` entries; needs native gas                                                                                                                                      | none (zero-value self tx)                                            | gas funding                                                                                                           |
| `ReceptumEscrow` (EVM: Base, Arc)                                | deploy per chain; add deployments to `TRUSTED_ESCROWS`; add mainnet entries to `NETWORKS` (USDC: Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; Arc mainnet USDC per Circle docs) | **holds customer funds**                                             | audit decision (§0); deployment provenance (registry today)                                                           |
| XRPL Escrow (`adapter-xrpl`)                                     | relax `assertTestnet()` behind an explicit `allowMainnet` opt-in; NetworkID 0                                                                                                         | holds funds on-ledger (native XRPL escrow — protocol code, not ours) | RLUSD escrow needs the RLUSD issuer to enable token locking (not enabled on mainnet as of Oct 2026); XRP escrow works |
| Stellar claimable balances (`adapter-stellar`)                   | mainnet passphrase + Horizon behind an explicit opt-in                                                                                                                                | buyer refund window can lapse (SECURITY #3)                          | prefer the Soroban escrow                                                                                             |
| Soroban escrow (`adapter-stellar`)                               | deploy contract on mainnet; mainnet USDC SAC                                                                                                                                          | **holds customer funds**                                             | audit decision (§0)                                                                                                   |

## 2. Code changes required (all behind explicit opt-in, never defaults)

1. `adapter-evm`: add mainnet entries to `NETWORKS`, gated by `RECEPTUM_ALLOW_MAINNET=1` (or a constructor flag) so testnet remains the default.
2. `adapter-xrpl`: `assertTestnet()` → `assertNetwork(expected)` with mainnet requiring an explicit flag.
3. `adapter-stellar`: same pattern for the network passphrase and Horizon/RPC endpoints.
4. `verify` and the Python verifier: add mainnet RPC endpoints and the mainnet trusted-deployment registry.
5. Website: label mainnet receipts distinctly from testnet ones.

## 3. Operational requirements

- Seller keys in a hardware wallet or KMS — never in files on a laptop. Separate keys per chain.
- Account bindings (SPEC §4.1) published for every mainnet payout account.
- Monitoring: alerts on escrows approaching deadlines (especially Stellar claimable-balance refund windows) and on anchor failures.
- Caps: per-escrow and total-value-locked limits until an audit is complete, enforced off-chain by the seller service and stated publicly.
- Incident plan: who can pause new escrows (the contracts have no admin key by design; pausing = stop opening new escrows client-side).
