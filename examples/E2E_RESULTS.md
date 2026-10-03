# x402 + Receptum end-to-end (Base Sepolia, anchored on Arc testnet)

Latest run 2026-10-03 (after the independent review fixes) · `toy-renderer` sold one render for **$0.25 USDC** via x402 (`exact`, facilitator `https://x402.org/facilitator`) to `agent-buyer`.

| Step                                        | Network                      | Reference                                                                                                                     |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| x402 settlement (0.25 USDC buyer → seller)  | Base Sepolia `eip155:84532`  | [`0x90a09ae1…4ff454f`](https://sepolia.basescan.org/tx/0x90a09ae1de82b87162cb03be1d7828df5af491ba695e930c1f984a0654ff454f)    |
| Receipt anchor (`receptum/1` ‖ receiptHash) | Arc testnet `eip155:5042002` | [`0xe708fdb7…e67e9f8`](https://explorer.testnet.arc.io/tx/0xe708fdb7858930c15e013e06133c1beddac5b3353723b3d5b1485f720e67e9f8) |

- receiptHash `cb27b5b6a98fdaecb96fbedf557acba67bdad3a2fa6505f9836c49fbc766ba4a`, payee `eip155:84532:0x6344D17a80775A71b51A61124767AbCD22B0328B`
- The buyer's client accepted the result only after: seller signature ✓, SHA-256 of the delivered bytes = `outputSha256` ✓, a successful settlement whose transaction = receipt `payment.reference` ✓, seller on allow-list ✓, and the buyer's own expectations (network, max amount, payer) ✓.
- The hardened server rejected malformed JSON (400), a non-string prompt (400) and a 40 KB body (413) without crashing.
- Earlier run (before the fixes): settlement [`0x83359ec2…dfeface`](https://sepolia.basescan.org/tx/0x83359ec2790a984cb904b103648521b787b785312b04a2029e91cb126dfeface) — its receipt predates the `payee` field, so today's verifier correctly refuses to call it verified.

Files: `x402-base-sepolia.json` (settlement + signed receipt), `x402-base-sepolia-output.svg` (the delivered bytes).
