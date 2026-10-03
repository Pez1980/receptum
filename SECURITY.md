# Security policy

Receptum handles payments and escrow. We take vulnerabilities seriously.

## Reporting

Please **do not** open a public issue. Report privately via GitHub's
[private vulnerability reporting](https://github.com/Pez1980/receptum/security/advisories/new).
We aim to acknowledge reports within 3 business days.

## Scope

- Escrow contracts and chain adapters (fund loss, unauthorized release or refund)
- Receipt construction and verification (forged or mismatched receipts)
- Payment verification in `server` (paying less than quoted, replay)

## Status

Contracts are **unaudited** until this file says otherwise. Don't deploy them with significant funds.
