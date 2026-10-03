# @receptum/verify

Library and CLI to verify a Receptum receipt at every level (SPEC §6):

1. **File ↔ receipt** — SHA-256 of the delivered file equals `outputSha256` (offline).
2. **Receipt ↔ seller** — the JWS proof verifies against `seller.id` (offline).
3. **Receipt ↔ chain** — the x402 settlement transfer (EVM and Stellar testnet), `ReceptumEscrow` state with the committed `receiptHash` (EVM and Soroban: genuine code, a trusted deployment, matching terms, `released`), XRPL escrows, Stellar claimable-balance escrows (history-derived delivery and settlement), and anchors on EVM, XRPL testnet and Stellar testnet.

```sh
receptum-verify <receipt.json> [delivered-file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract-id>]... [--offline] [--json]
```

Exit code 0 only when nothing fails. Results across all chains: [E2E_RESULTS.md](E2E_RESULTS.md).
