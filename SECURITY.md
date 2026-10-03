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

## Independent review (Codex, 3 Oct 2026)

An adversarial pre-audit review found no critical issues. Status of every finding:

| #   | Severity | Finding                                                                      | Status                                                                                                                                                             |
| --- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | High     | Escrow could record funding it never received (EOA / fee-on-transfer tokens) | **Fixed** — token must be a contract, balance delta must equal `amount`, reentrancy lock                                                                           |
| 2   | High     | XRPL adapter didn't refuse mainnet inside the library                        | **Fixed** — `assertTestnet()` before every signature                                                                                                               |
| 3   | High     | Stellar buyer's refund right expires if the buyer misses its claim window    | **Open (design)** — documented; needs a Soroban escrow contract (roadmap M6); buyers must monitor                                                                  |
| 4   | High     | Client/MCP checks passed without (or with a failed) settlement               | **Fixed** — fail closed; buyer-supplied expectations (network, asset, amount, payee, payer, inputs)                                                                |
| 5   | High     | Verifier accepted delivered-but-unreleased or counterfeit escrows            | **Fixed** — genuine runtime code, reference network, token/payer/payee/amount, `released` required                                                                 |
| 6   | High     | Verifier accepted x402 transfers to any recipient                            | **Fixed** — receipts carry `payment.payee`; transfer must go to it                                                                                                 |
| 7   | Medium   | Unsupported rails / anchors-only reported as fully verified                  | **Fixed** — VERIFIED vs PARTIALLY VERIFIED; EVM anchors must be mined and successful                                                                               |
| 8   | Medium   | Buyer could be charged before receipt/anchor failure                         | **Fixed** — receipt data validated before settlement; anchor failure no longer withholds paid output. Persistent idempotent recovery is still the integrator's job |
| 9   | Medium   | One payment authorization could back several concurrent jobs                 | **Fixed (per process)** — in-flight payments are locked; multi-instance deployments need a shared lock                                                             |
| 10  | Medium   | Receipt validation accepted members/types the spec forbids                   | **Fixed** — exact members, types, no nulls, own properties, Crockford ids, RFC 3339 UTC                                                                            |
| 11  | Medium   | Canonicalization accepted lone surrogates, sparse arrays, non-plain objects  | **Fixed**; duplicate JSON keys at the wire are still collapsed by `JSON.parse` (documented)                                                                        |
| 12  | Medium   | MCP receipts didn't cover `structuredContent` / `isError`                    | **Fixed** — output = SHA-256(JCS({content, structuredContent?, isError?}))                                                                                         |
| 13  | Medium   | XRPL/Stellar delivery state derived from mutable current data                | **Open** — derive from chronological history (planned)                                                                                                             |
| 14  | Medium   | Stellar batch claims could count one payment against two escrows             | **Open** — planned; affects only status derivation, not funds                                                                                                      |
| 15  | Medium   | Blocked seller could leave delivered funds stuck                             | **Fixed** — `sellerRefund`                                                                                                                                         |
| 16  | Low      | JWS envelope malleability (extra segments, typ, kid fragment, extra params)  | **Fixed**                                                                                                                                                          |
| 17  | Low      | Example server crash / memory DoS on bad input                               | **Fixed** — body limit, validation, controlled errors                                                                                                              |
| 18  | Info     | EVM acceptance modes are one hybrid state machine                            | **Documented** in SPEC §7.2                                                                                                                                        |

Not yet addressed and required before any audit: binding the seller's signing DID to its chain payout account (today the receipt names both; nothing proves the same party controls them).
