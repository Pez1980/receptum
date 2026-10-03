# @receptum/verify

Library and CLI to verify a Receptum receipt at every level (SPEC §6):

1. **File ↔ receipt** — SHA-256 of the delivered file equals `outputSha256` (offline). Without a file this level is `skipped`, and the receipt can be at best `PARTIALLY VERIFIED`.
2. **Receipt ↔ seller** — the signed-receipt envelope is exact (`receipt`, `receiptHash`, `proof`, optional `bindings`), the receipt is valid RRF v1, `receiptHash` is recomputed, and the detached JWS (I-JSON header without duplicate members, canonical base64url, `S < L`) verifies against the seller's Ed25519 `did:key` (offline).
   - **L2.5 Seller controls payee** — an account binding in `bindings` (SPEC §4.1) proves the seller's did:key controls `payment.payee`. EVM and Stellar are offline; XRPL also checks the account's current master/regular key online (validated ledger only; a failed lookup is `unavailable`). With a payee but no binding the result is `PARTIALLY VERIFIED` (exit 3); pass `--allow-unbound` to accept legacy receipts. Invalid bindings always fail.
3. **Receipt ↔ chain** — the payment settled on its rail **and** `receiptHash` is committed on-chain: `x402:exact` settlement transfers (EVM, Stellar testnet and XRPL — a validated `Payment` whose `delivered_amount` matches; XRP drops only, SPEC §7.3) plus a mined anchor, since x402 cannot commit the hash; `ReceptumEscrow` state with the committed `receiptHash` (EVM and Soroban: genuine code, a trusted deployment, matching terms, `released`), XRPL escrows (assets by protocol currency bytes; buyer mode needs a `Condition` and a delivery leaving at least `reviewWindowSeconds` before `CancelAfter`; evaluator mode is never more than `unavailable`; incomplete history is `unavailable`), Stellar claimable-balance escrows (history-derived delivery and settlement); anchors on EVM, XRPL testnet and Stellar testnet (`<caip2>:<tx>`, SPEC §7.1).

```sh
receptum-verify <receipt.json> [delivered-file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract-id>]... [--allow-unbound] [--offline] [--json]
```

`receipt.json` is a bare signed receipt or a wrapper `{ "signedReceipt": …, "anchor": "<caip2>:<tx>" | [ … ], … }` (SPEC §6.1). Every anchor in the wrapper is checked, together with every `--anchor`; the wrapper's other members are informational and never trusted. The file must be I-JSON: duplicate member names (which `JSON.parse` would silently collapse), lone surrogates, out-of-range numbers and invalid UTF-8 are refused with exit 2.

Each check is `pass`, `fail`, `pending` (genuine but not final, e.g. an escrow awaiting release), `unavailable` (could not be performed: unsupported rail or network, RPC error, account not found, non-validated ledger — never a pass, never a failure) or `skipped`.

| Verdict                | When                                                                                                                                                                                                                                     | Exit |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **VERIFIED**           | nothing failed, pending or unavailable; L1 passed (file given); L2 passed; L2.5 passed or skipped (no payee, or `--allow-unbound`); L3 payment passed and `receiptHash` is committed (by the escrow rail, or by a mined anchor for x402) | 0    |
| **NOT VERIFIED**       | any check failed                                                                                                                                                                                                                         | 1    |
| **PARTIALLY VERIFIED** | otherwise; each missing piece is printed (`missing: …`)                                                                                                                                                                                  | 3    |

Exit 2 is a usage or input error. The library returns the same verdict: `verify(signed, options)` → `{ verdict, ok, complete, missing, checks, … }`, and `parseReceiptInput(bytes)` → `{ signed, anchors }` applies the input rules. Results across all chains: [E2E_RESULTS.md](E2E_RESULTS.md).
