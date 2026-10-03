# @receptum/verify

Library and CLI to verify a Receptum receipt at every level (SPEC §6):

1. **File ↔ receipt** — SHA-256 of the delivered file equals `outputSha256` (offline).
2. **Receipt ↔ seller** — the JWS proof verifies against `seller.id` (offline).
   - **L2.5 Seller controls payee** — an account binding in `bindings` (SPEC §4.1) proves the seller's did:key controls `payment.payee`. EVM and Stellar are offline; XRPL also checks the account's current master/regular key online. With a payee but no binding the result is `PARTIALLY VERIFIED` (exit 3); pass `--allow-unbound` to accept legacy receipts. Invalid bindings always fail.
3. **Receipt ↔ chain** — the x402 settlement transfer (EVM, Stellar testnet, and XRPL: a validated `Payment` whose `delivered_amount` matches, see `docs/rails/x402-xrpl.md`), `ReceptumEscrow` state with the committed `receiptHash` (EVM and Soroban: genuine code, a trusted deployment, matching terms, `released`), XRPL escrows, Stellar claimable-balance escrows (history-derived delivery and settlement), and anchors on EVM, XRPL testnet and Stellar testnet.

```sh
receptum-verify <receipt.json> [delivered-file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract-id>]... [--allow-unbound] [--offline] [--json]
```

Exit code 0 only when the receipt is fully verified (1 = something failed, 3 = partial). Results across all chains: [E2E_RESULTS.md](E2E_RESULTS.md).
