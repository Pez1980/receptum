# Rail: `x402:exact` on XRPL (`xrpl:*`)

This draft has been merged into the specification: see
[SPEC §7.3, "`x402:exact` on `xrpl:*`"](../SPEC.md#73-settlement-level-3).

In short: RRF v1 x402 receipts on XRPL settle in **XRP drops only**. The verifier confirms a
validated `tesSUCCESS` `Payment` from `payment.payer` to `payment.payee` whose `delivered_amount`
(never `Amount`) equals `payment.amount`, and the receipt needs an `anchor:xrpl` memo to be
VERIFIED. **Issued-token x402 is unsupported in RRF v1**: `payment.amount` is an integer in the
asset's smallest unit, which an XRPL issued value (a decimal) does not have. The reference server
refuses issued-token requirements before charging; verifiers fail a delivery in another currency
(compared by 160-bit protocol identity, 3-character codes case-sensitive) and report a matching
one `unavailable`, never `pass`. A versioned amount representation for issued tokens is an open
item for a later RRF version.

Implementations: `packages/verify/src/xrpl-x402.ts` (`verifyXrplX402Payment`) and
`verifiers/python/src/receptum_verify/xrpl_x402.py` (`check_xrpl_x402_exact`,
`check_xrpl_anchor`). Live example: `examples/x402-xrpl-testnet.json`, produced by
`examples/x402-xrpl/e2e.mjs`.
