# x402 + Receptum end-to-end (Base Sepolia, anchored on Arc testnet)

Run 2026-10-03 · `toy-renderer` sold one render for **$0.25 USDC** via x402 (`exact`, facilitator `https://x402.org/facilitator`) to `agent-buyer`.

| Step                                        | Network                      | Reference                                                                                                                     |
| ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| x402 settlement (0.25 USDC buyer → seller)  | Base Sepolia `eip155:84532`  | [`0x83359ec2…dfeface`](https://sepolia.basescan.org/tx/0x83359ec2790a984cb904b103648521b787b785312b04a2029e91cb126dfeface)    |
| Receipt anchor (`receptum/1` ‖ receiptHash) | Arc testnet `eip155:5042002` | [`0x178192fa…faa6103`](https://explorer.testnet.arc.io/tx/0x178192fa86acc85fb2b33189708703a96125feb5bef6c6817f8faedeefaa6103) |

- receiptHash `8c73f5d882b31360a12da942d7ceaef47a59613e94fb64bf00b5af9989476149`
- seller `did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t`
- The buyer's client accepted the result only after: seller signature ✓, SHA-256 of the delivered bytes = `outputSha256` ✓, receipt `payment.reference` = settlement transaction ✓, seller on allow-list ✓.

Files: `x402-base-sepolia.json` (settlement + signed receipt), `x402-base-sepolia-output.svg` (the delivered bytes — hash it and compare with `outputSha256`).
