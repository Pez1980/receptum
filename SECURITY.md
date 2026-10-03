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

Two adversarial review passes (pre-audit). The first found no critical issues; the second checked the fixes and found residual gaps, which were then addressed. Current status:

| #   | Severity | Finding                                                                   | Status                                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Escrow could record funding it never received                             | **Fixed** — contract tokens only, balance delta must equal `amount`, reentrancy lock. Assumes a standard, honest token (malicious or rebasing tokens are out of scope)                                                 |
| 2   | High     | XRPL adapter didn't refuse mainnet                                        | **Fixed** — `assertTestnet()` before every signature (trusts the server's reported NetworkID)                                                                                                                          |
| 3   | High     | Stellar buyer's refund right expires if the buyer misses its claim window | **Open (design)** — needs a Soroban escrow (roadmap M6); buyers must monitor                                                                                                                                           |
| 4   | High     | Client/MCP accepted missing or failed settlement                          | **Fixed** — fail closed; HTTP and MCP accept buyer-side expectations (network, asset, amount/max, payee, payer, inputs). These are consistency checks — independent chain proof is `receptum-verify`                   |
| 5   | High     | Verifier accepted unreleased or counterfeit escrows                       | **Fixed** — genuine runtime code **and** a published deployment registry (`TRUSTED_ESCROWS`, or `--trust-escrow`); network, token, parties, review window and evaluator must match; `released` required                |
| 6   | High     | Verifier accepted x402 transfers to any recipient                         | **Fixed** — `payment.payee` required for a full pass; payer/payee must be CAIP-10 accounts on the payment's network                                                                                                    |
| 7   | Medium   | Anchor-only / unsupported rails reported as verified                      | **Fixed** — VERIFIED vs PARTIALLY VERIFIED; anchors must be mined and successful                                                                                                                                       |
| 8   | Medium   | Buyer could be charged before a receipt failure                           | **Fixed** — receipt data and the seller's signing key are checked before settlement; anchor failures return a fixed header code and never withhold output. Durable recovery after crashes remains the integrator's job |
| 9   | Medium   | One payment authorization could back several concurrent jobs              | **Fixed per process** — lock keyed on authorization identity (EVM: network, token, authorizer, nonce). Multi-instance deployments need a shared lock                                                                   |
| 10  | Medium   | Receipt validation too loose                                              | **Fixed** — exact members and types, no nulls, DID/CAIP-10 identity syntax, no sparse arrays, calendar-valid timestamps in a strict profile (SPEC §2)                                                                  |
| 11  | Medium   | Canonicalization accepted inputs JCS forbids                              | **Fixed**; duplicate JSON keys on the wire are still collapsed by `JSON.parse` (documented)                                                                                                                            |
| 12  | Medium   | MCP receipts didn't cover `structuredContent` / `isError`                 | **Fixed** — both hashed exactly when present                                                                                                                                                                           |
| 13  | Medium   | XRPL/Stellar delivery state derived from mutable current data             | **Open** — derive delivery from chronological history (planned)                                                                                                                                                        |
| 14  | Medium   | Stellar batch claims could count one payment against two escrows          | **Open** — status derivation only, not funds                                                                                                                                                                           |
| 15  | Medium   | Blocked seller could leave delivered funds stuck                          | **Fixed** — `sellerRefund` (voluntary; funds only ever go to the buyer)                                                                                                                                                |
| 16  | Low      | JWS envelope malleability                                                 | **Fixed** — exact segments, header members, `typ`, single-fragment `kid`, canonical 64-byte signature encoding                                                                                                         |
| 17  | Low      | Example server crash / memory DoS                                         | **Fixed** — body limit, validation, controlled errors                                                                                                                                                                  |
| 18  | Info     | EVM acceptance is one hybrid state machine                                | **Documented** (SPEC §7.2)                                                                                                                                                                                             |

**Still open before a final audit:** items 3, 13 and 14; binding the seller's signing DID to its chain payout account (today a receipt names both, but nothing proves one party controls them); and a deployment-provenance check stronger than a published registry (e.g. a factory).
