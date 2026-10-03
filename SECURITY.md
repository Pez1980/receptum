# Security policy

Receptum handles payments and escrow.

## Reporting

Please **do not** open a public issue. Report privately via GitHub's
[private vulnerability reporting](https://github.com/Pez1980/receptum/security/advisories/new).
We aim to acknowledge reports within 3 business days.

## Scope

- `ReceptumEscrow` and the chain adapters (fund loss, unauthorized release or refund)
- Receipt construction, signing and verification (forged or mismatched receipts)
- Payment verification in `server` / `client` (paying less than quoted, replay, receipt substitution)

## Status

All contracts and adapters are **unaudited and testnet-only**. Mainnet support will not ship before an independent audit is published here.
