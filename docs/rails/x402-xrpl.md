# Rail: `x402:exact` on XRPL (`xrpl:*`)

This draft has been merged into the specification: see
[SPEC §7.3, "`x402:exact` on `xrpl:*`"](../SPEC.md#73-settlement-level-3).

In short: the verifier confirms a validated `tesSUCCESS` `Payment` from `payment.payer` to
`payment.payee` whose `delivered_amount` (never `Amount`) matches the receipt, and the receipt needs
an `anchor:xrpl` memo to be VERIFIED. `payment.asset` is `XRP` (amount in drops) or an issued token
`<currency>.<issuer>` with the currency exactly as on the ledger (3-character code, case-sensitive,
or 40 hex digits — never a display symbol like `RLUSD`) and `payment.amount` its value as an
integer number of **10^-15 units** (`"0.25"` → `"250000000000000"`), converted exactly with no
floats. Currencies compare by 160-bit protocol identity, issuers exactly. Values that are not whole
10^-15 units (or need more than 16 significant digits) are refused by the reference server before
charging and fail verification. Conversion vectors: `spec/vectors/xrpl-issued-amount-v1.json`.

Implementations: `packages/verify/src/xrpl-x402.ts` (`verifyXrplX402Payment`) and
`verifiers/python/src/receptum_verify/xrpl_x402.py` (`check_xrpl_x402_exact`,
`check_xrpl_anchor`). Live examples: `examples/x402-xrpl-testnet.json` (XRP, `examples/x402-xrpl/e2e.mjs`) and
`examples/x402-xrpl-token-testnet.json` (0.25 of a self-issued token, `examples/x402-xrpl/e2e-token.mjs`).
