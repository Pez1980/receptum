# Roadmap

| Milestone | Scope                                                                                                                     | Status                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0        | Repo, CI, secret scanning, `core` receipt model                                                                           | Done · Oct 2026                                                                                          |
| M1        | RRF v1 spec + JCS test vectors, Ed25519 seller signing, `server`/`client` over x402, `verify` CLI, Base Sepolia           | Done (testnet) · Oct 2026                                                                                |
| M2        | `ReceptumEscrow` on Arc testnet, paid MCP tools (`mcp`)                                                                   | Done (testnet) · Oct 2026                                                                                |
| M3        | Stellar adapter: claimable-balance escrow (USDC) + `MEMO_HASH` anchors                                                    | Done (testnet) · Oct 2026                                                                                |
| M4        | XRPL adapter: native Escrow with crypto-conditions + memo anchors                                                         | Done (testnet) · Oct 2026 · RLUSD escrow waits on the issuer enabling token locking                      |
| M5        | Upstream x402 extension proposal for input/output hashes                                                                  | Next · Oct–Nov 2026                                                                                      |
| M6        | Soroban escrow contract (evaluator mode, review window from delivery on Stellar) + Stellar x402 `exact`                   | Done (testnet, unaudited) · Oct 2026 · contract `CAFAWMTC…VWGG`, flows A–E and an x402 paid job verified |
| M7        | Independent audit of `ReceptumEscrow` (EVM and Soroban); second-language verifier; npm publish; 1.0 spec freeze; mainnets | Q1 2027                                                                                                  |

Each chain adapter is developed and funded independently; the shared core is not re-billed per chain.
