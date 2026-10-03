# Rail: `x402:exact` on XRPL (`xrpl:*`)

Draft text for SPEC §7.2 (rail differences) and the §6 level-3 rules. It will be folded into
`docs/SPEC.md` at merge.

## Receipt fields

The x402 `exact` scheme on XRPL settles one `Payment` that the payer signs and the facilitator
submits. The payer pays the XRPL fee, so facilitators advertise `extra.areFeesSponsored: false`.

| Field               | Value                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.rail`      | `x402:exact`                                                                                                                                                                                                                                                                                             |
| `payment.network`   | `xrpl:<NetworkID>` (CAIP-2), e.g. `xrpl:1` for testnet                                                                                                                                                                                                                                                   |
| `payment.reference` | hash of the settlement `Payment` (64 hex characters), as returned in the x402 settle response's `transaction`                                                                                                                                                                                            |
| `payment.asset`     | `XRP`, or `<currency>.<issuer>` for an issued currency, where `<currency>` is a 3-character code, a symbol of up to 20 characters (compared via its 40-hex encoding), or the 40-hex code itself, and `<issuer>` is the issuer's classic address. A bare currency code without an issuer MUST NOT verify. |
| `payment.amount`    | XRP: integer drops. Issued currency: the XRPL decimal `value`, as the x402 XRPL scheme uses it (`"10.5"`). Values compare numerically, so `0.010`, `0.01` and `1e-2` are equal                                                                                                                           |
| `payment.payer`     | `xrpl:<NetworkID>:<classic address>` of the transaction's `Account`                                                                                                                                                                                                                                      |
| `payment.payee`     | `xrpl:<NetworkID>:<classic address>` of the transaction's `Destination`                                                                                                                                                                                                                                  |

## Level 3 rule

A verifier looks up `payment.reference` with rippled `tx` and reports **pass** only if all of
these hold:

1. the server answered for the expected network (when `server_info` reports `network_id`, it
   equals `<NetworkID>`), and the reply is for `payment.reference`;
2. `validated` is `true`;
3. `meta.TransactionResult` is `tesSUCCESS`;
4. `TransactionType` is `Payment`;
5. if the transaction has a `NetworkID`, it equals `<NetworkID>`; on networks with an ID above
   1024 it MUST have one;
6. `Account` equals `payment.payer` and `Destination` equals `payment.payee` (both named, both on
   `payment.network`);
7. `meta.delivered_amount` equals `payment.amount` in `payment.asset`: for XRP the drops string,
   for an issued currency the same currency code, the same issuer and an equal value.

Verifiers MUST use `delivered_amount`, never `Amount`/`DeliverMax`. A partial payment
(`tfPartialPayment`) can deliver less than its `Amount`.

The result is **fail** when the validated ledger contradicts the receipt (rules 3–7, or a reply
for another hash). It is **pending**/**unavailable**, and never **pass**, when the check can't be
completed: no endpoint for the network, transport errors, a server on another network, a
transaction the server doesn't know (`txnNotFound`; servers may lack history), a ledger that isn't
validated yet, `delivered_amount` absent or `unavailable`, or a receipt that doesn't name both
payer and payee.

Destination tags are not part of the receipt and are not checked.

## Commitment

The settlement transaction exists before the receipt does, so it can't carry `receiptHash`. The
commitment is an `anchor:xrpl` anchor (§7): a validated `tesSUCCESS` transaction whose first
`receptum/1` memo (`MemoType` = hex("receptum/1")) has `MemoData` = the 32 `receiptHash` bytes.
`XrplAnchor` writes it on a no-op `AccountSet` from the seller.

## Implementations

- TypeScript: `packages/verify/src/xrpl-x402.ts` (`verifyXrplX402Payment`).
- Python: `verifiers/python/src/receptum_verify/xrpl_x402.py` (`check_xrpl_x402_exact`,
  `check_xrpl_anchor`).
- Live example: `examples/x402-xrpl-testnet.json`, produced by `examples/x402-xrpl/e2e.mjs`.
