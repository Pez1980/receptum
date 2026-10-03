# x402 + Receptum end-to-end (Base Sepolia, anchored on Arc testnet)

Latest run 2026-10-03 (with account bindings, SPEC §4.1) · `toy-renderer` sold one render for **$0.25 USDC** via x402 (`exact`, facilitator `https://x402.org/facilitator`) to `agent-buyer`. The receipt carries the seller's account binding (`bindings/evm-base-sepolia.json`) proving its `did:key` controls the payee.

| Step                                        | Network                      | Reference                                                                                                                      |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| x402 settlement (0.25 USDC buyer → seller)  | Base Sepolia `eip155:84532`  | [`0x778f0a7d…cf0b86b`](https://sepolia.basescan.org/tx/0x778f0a7de68fa9bf8aed9c96cfb5eaf7d050e1bfa9ee54315d3bef95bcf0b86b)     |
| Receipt anchor (`receptum/1` ‖ receiptHash) | Arc testnet `eip155:5042002` | [`0xa546047c…28e04b70`](https://explorer.testnet.arc.io/tx/0xa546047cd661ca4a22a6855a937143002dd251c7a4142204fd04469328e04b70) |

- receiptHash `11e739252cc2d6e76adf0819a9f3914c6c49fbdbc6a572c424786b792658ee5b` (`RCPT-5BSJ-PK8H`), payee `eip155:84532:0x6344D17a80775A71b51A61124767AbCD22B0328B`, block 47639359.
- Before charging, the server checked that its binding covers `payTo` (`bindingVerifiers`). The buyer's client accepted the result only after: seller signature ✓, SHA-256 of the delivered bytes = `outputSha256` ✓, a successful settlement whose transaction = receipt `payment.reference` ✓, seller on allow-list ✓, the buyer's own expectations (network, max amount, payer) ✓, and `requireBinding` — a valid binding of the seller to the payee ✓ (`payeeBound: true`).
- Independent check:

```text
$ receptum-verify x402-base-sepolia.json x402-base-sepolia-output.svg --anchor eip155:5042002:0xa546…4b70
[PASS] L1 File matches receipt — SHA-256 301917f6…234a = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
[PASS] L2.5 Seller controls payee — did:key:z6Mkqc7R…by4t ↔ eip155:84532:0x6344…328B: EIP-191 signature by 0x6344D17a80775A71b51A61124767AbCD22B0328B (offline)
[PASS] L3 Payment on eip155:84532 — 250000 base units paid to 0x6344D17a80775A71b51A61124767AbCD22B0328B in block 47639359
[PASS] L3 Anchor on eip155:5042002 — receiptHash anchored in 0xa546047cd661ca4a22a6855a937143002dd251c7a4142204fd04469328e04b70

VERIFIED
```

- `x402-base-sepolia-tampered.json` is the same file with `payment.amount` edited to `"1"`: `NOT VERIFIED` (receiptHash mismatch; the binding check is skipped once the signature fails).
- Earlier runs: [`0x90a09ae1…4ff454f`](https://sepolia.basescan.org/tx/0x90a09ae1de82b87162cb03be1d7828df5af491ba695e930c1f984a0654ff454f) (after the review fixes, no binding — today `PARTIALLY VERIFIED`, or `VERIFIED` with `--allow-unbound`) and [`0x83359ec2…dfeface`](https://sepolia.basescan.org/tx/0x83359ec2790a984cb904b103648521b787b785312b04a2029e91cb126dfeface) (before the fixes; its receipt predates the `payee` field, so the verifier refuses to call it verified).

## Bindings attached to earlier escrow receipts

Bindings live outside the hashed receipt, so they can be added to receipts issued before bindings existed without changing `receiptHash`:

| File                                                            | Receipt                                      | Result                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `xrpl-testnet-escrow-a.json` (+ `bindings/xrpl-testnet.json`)   | XRPL escrow A, `d4a1e567…0678`               | VERIFIED — L2.5 online: signed by the enabled master key of `rUuUZJXy7qQhZkpr8ovFBgBT5JrPv3nnFf` |
| `arc-testnet-escrow-a.json` (+ `bindings/evm-arc-testnet.json`) | Arc `ReceptumEscrow` flow A, escrow id `…:1` | VERIFIED — L2.5 EIP-191 by `0x6344D17a80775A71b51A61124767AbCD22B0328B`                          |

Files: `x402-base-sepolia.json` (settlement + signed receipt with bindings), `x402-base-sepolia-output.svg` (the delivered bytes), `bindings/*.json` (public bindings for the testnet seller on Base Sepolia, Arc, XRPL and Stellar testnets — no secrets; regenerate with `bindings/create.mjs`).
