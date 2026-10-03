# x402 + Receptum end-to-end (Base Sepolia, anchored on Arc testnet)

Latest run 2026-10-03 (with account bindings, SPEC §4.1) · `toy-renderer` sold one render for **$0.25 USDC** via x402 (`exact`, facilitator `https://x402.org/facilitator`) to `agent-buyer`. The receipt carries the seller's account binding (`bindings/evm-base-sepolia.json`) proving its `did:key` controls the payee.

| Step                                        | Network                      | Reference                                                                                                                      |
| ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| x402 settlement (0.25 USDC buyer → seller)  | Base Sepolia `eip155:84532`  | [`0x778f0a7d…cf0b86b`](https://sepolia.basescan.org/tx/0x778f0a7de68fa9bf8aed9c96cfb5eaf7d050e1bfa9ee54315d3bef95bcf0b86b)     |
| Receipt anchor (`receptum/1` ‖ receiptHash) | Arc testnet `eip155:5042002` | [`0xa546047c…28e04b70`](https://explorer.testnet.arc.io/tx/0xa546047cd661ca4a22a6855a937143002dd251c7a4142204fd04469328e04b70) |

- receiptHash `11e739252cc2d6e76adf0819a9f3914c6c49fbdbc6a572c424786b792658ee5b` (`RCPT-5BSJ-PK8H`), payee `eip155:84532:0x6344D17a80775A71b51A61124767AbCD22B0328B`, block 47639359.
- Before charging, the server checked that its binding covers `payTo` (`bindingVerifiers`). The buyer's client accepted the result only after: seller signature ✓, SHA-256 of the delivered bytes = `outputSha256` ✓, a successful settlement whose transaction = receipt `payment.reference` ✓, seller on allow-list ✓, the buyer's own expectations (network, max amount, payer) ✓, and `requireBinding` — a valid binding of the seller to the payee ✓ (`payeeBound: true`).
- Independent check — the wrapper's `anchor` is checked automatically (SPEC §6.1), so `--anchor` is optional here; the Python verifier (`verifiers/python`) gives the same verdict:

```text
$ receptum-verify x402-base-sepolia.json x402-base-sepolia-output.svg
[PASS] L1 File matches receipt — SHA-256 301917f6…234a = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
[PASS] L2.5 Seller controls payee — did:key:z6Mkqc7R…by4t ↔ eip155:84532:0x6344…328B: EIP-191 signature by 0x6344D17a80775A71b51A61124767AbCD22B0328B (offline)
[PASS] L3 Payment on eip155:84532 — 250000 base units paid to 0x6344D17a80775A71b51A61124767AbCD22B0328B in block 47639359
[PASS] L3 Anchor on eip155:5042002 — receiptHash anchored in 0xa546047cd661ca4a22a6855a937143002dd251c7a4142204fd04469328e04b70 (block 65317884, from 0x6344…328b)

VERIFIED
```

- `x402-base-sepolia-tampered.json` is the same file with `payment.amount` edited to `"1"`: `NOT VERIFIED` (receiptHash mismatch; the binding and chain checks are skipped once the signature fails).
- `x402-stellar-testnet.json` (+ `x402-stellar-testnet-output.svg`): file, signature, SEP-53 binding and the Stellar settlement pass, but the receipt was never anchored and x402 cannot commit `receiptHash` itself, so it is **PARTIALLY VERIFIED** (`missing: L3: receiptHash is not committed on-chain`). Its embedded `verify` member is the output of the verifier at the time of the run, which predates this rule.
- Earlier runs: [`0x90a09ae1…4ff454f`](https://sepolia.basescan.org/tx/0x90a09ae1de82b87162cb03be1d7828df5af491ba695e930c1f984a0654ff454f) (after the review fixes, no binding — today `PARTIALLY VERIFIED`, or `VERIFIED` with `--allow-unbound`) and [`0x83359ec2…dfeface`](https://sepolia.basescan.org/tx/0x83359ec2790a984cb904b103648521b787b785312b04a2029e91cb126dfeface) (before the fixes; its receipt predates the `payee` field, so the verifier refuses to call it verified).

## x402 exact on XRPL testnet

Run 2026-10-03 · `examples/x402-xrpl/e2e.mjs` sold one render for **0.01 XRP** (`10000` drops) over x402 `exact` on `xrpl:1` through `https://x402.org/facilitator` (advertises `{"areFeesSponsored":false}`, so the buyer paid the XRPL fee). The receipt carries the seller's XRPL binding (`bindings/xrpl-testnet-x402.json`) and is anchored by a `receptum/1` memo.

| Step                                       | Network               | Reference                                                                                                                 |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| x402 settlement (`Payment` buyer → seller) | XRPL testnet `xrpl:1` | [`CEBA2DF49DE1…`](https://testnet.xrpl.org/transactions/CEBA2DF49DE13B89A6A5A9D79F4CB113724EACC02DE9E4F1B0F5C8ADE1F4CC1E) |
| Receipt anchor (`AccountSet` memo, seller) | XRPL testnet `xrpl:1` | [`C731592F3059…`](https://testnet.xrpl.org/transactions/C731592F3059F916685F7D5413575017167F5E25D6715780BB140B204D3932E1) |

- receiptHash `176bfff7bd79d27ae58f3e31a16f21dbdfd03415bb520f8d8662988f1c08433f`, payer `xrpl:1:rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf`, payee `xrpl:1:r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s`, ledger 21252639. Client check: all accepted, `payeeBound: true`.

```text
$ receptum-verify x402-xrpl-testnet.json x402-xrpl-testnet-output.svg --anchor xrpl:1:C731592F3059F916685F7D5413575017167F5E25D6715780BB140B204D3932E1
[PASS] L1 File matches receipt — SHA-256 317511c7…153c = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
[PASS] L2.5 Seller controls payee — did:key:z6Mkqc7R…by4t ↔ xrpl:1:r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s: signed by the (enabled) master key of r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s (online, current account keys)
[PASS] L3 Payment on xrpl:1 — 10000 drops delivered to r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s in ledger 21252639 (validated)
[PASS] L3 Anchor on xrpl:1 — memo anchored 2026-10-03T17:58:20Z

VERIFIED

$ python -m receptum_verify x402-xrpl-testnet.json x402-xrpl-testnet-output.svg   # anchor read from the file
VERIFIED
  L1 file        PASS  SHA-256(file) = outputSha256
  L2 signature   PASS  receiptHash recomputed and JWS verifies
  L2.5 binding   PASS  signed by the enabled master key of r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s (online)
  L3 settlement  PASS  tx CEBA2DF49DE1…: 10000 drops delivered to r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s in ledger 21252639 (validated)
  L3 anchor      PASS  xrpl:1 tx C731592F3059… commits receiptHash in a receptum/1 memo (2026-10-03T17:58:20Z)
```

Level 3 uses `delivered_amount`, never `Amount`, so partial payments can't pass. The rule is in [docs/rails/x402-xrpl.md](../docs/rails/x402-xrpl.md). Files: `x402-xrpl-testnet.json`, `x402-xrpl-testnet-output.svg`.

## Bindings attached to earlier escrow receipts

Bindings live outside the hashed receipt, so they can be added to receipts issued before bindings existed without changing `receiptHash`:

| File                                                            | Receipt                                      | Result                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `xrpl-testnet-escrow-a.json` (+ `bindings/xrpl-testnet.json`)   | XRPL escrow A, `d4a1e567…0678`               | L2, L3 settlement and L2.5 pass (online: signed by the enabled master key of `rUuUZJXy7qQhZkpr8ovFBgBT5JrPv3nnFf`) |
| `arc-testnet-escrow-a.json` (+ `bindings/evm-arc-testnet.json`) | Arc `ReceptumEscrow` flow A, escrow id `…:1` | L2, L3 settlement and L2.5 pass (EIP-191 by `0x6344D17a80775A71b51A61124767AbCD22B0328B`)                          |

Their delivered files were not published, so both are **PARTIALLY VERIFIED** (`missing: L1: no delivered file given`): SPEC §6 calls a receipt VERIFIED only when the delivered file was checked too.

Files: `x402-base-sepolia.json` (settlement + signed receipt with bindings), `x402-base-sepolia-output.svg` (the delivered bytes), `bindings/*.json` (public bindings for the testnet seller on Base Sepolia, Arc, XRPL and Stellar testnets — no secrets; regenerate with `bindings/create.mjs`).
