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
- `x402-stellar-testnet.json` (+ `x402-stellar-testnet-output.svg`): file, signature, SEP-53 binding and the Stellar settlement pass, and the receipt is anchored on Arc testnet ([`0xcdbf3c01…`](https://explorer.testnet.arc.io/tx/0xcdbf3c015e6db0607fb9c1bf55bfecba5d2154e3034762e2ce2f929cb472ae7b)) because x402 cannot commit `receiptHash` itself — **VERIFIED**.
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

Level 3 uses `delivered_amount`, never `Amount`, so partial payments can't pass. The rule is in [SPEC §7.3](../docs/SPEC.md#73-settlement-level-3). Files: `x402-xrpl-testnet.json`, `x402-xrpl-testnet-output.svg`.

## XRPL issued tokens and evaluator-mode escrows (2026-10-04)

RRF v1 now records XRPL issued tokens as `payment.asset` = `<currency>.<issuer>` (currency as on the ledger) and `payment.amount` = the value in integer 10^-15 units, and proves evaluator-mode XRPL escrows by the `EscrowFinish` `Account` ([SPEC §7.3](../docs/SPEC.md#73-settlement-level-3)). Test token: **RCPT**, 40-hex code `5243505400000000000000000000000000000000`, issuer `rHcy1VS1axUMqKcnUx7eM5k1hr5desdBGh` (self-issued from a fresh faucet account by `x402-xrpl/setup-token.mjs`; `asfDefaultRipple`, `asfAllowTrustLineLocking`, trust lines for buyer and seller — see `x402-xrpl/token-setup.json`). All three receipts carry the seller binding `bindings/xrpl-testnet-x402.json`.

| Flow                                                                                                                                                                                                                              | Receipt                                                            | Transactions                                                                                                                                                                                                                                                                                                                                                                                                                 | Result       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| x402 `exact` on `xrpl:1`, **0.25 RCPT** through `https://x402.org/facilitator` (it accepted the issued currency) — `x402-xrpl/e2e-token.mjs`                                                                                      | `3c4d7ba7…`, amount `250000000000000`                              | settlement [`FC8DAC064AF8…`](https://testnet.xrpl.org/transactions/FC8DAC064AF82AEF25025DE6E17CA7FD4C90655C8BCFC635861627BE9B5D6959), anchor [`43141CB714BA…`](https://testnet.xrpl.org/transactions/43141CB714BAB2D835CF723CC1CD4C81C879E049E787B6F026F9CAA55D0887A3)                                                                                                                                                       | **VERIFIED** |
| `escrow:xrpl` evaluator mode, 1 XRP: buyer gives the fulfillment to the evaluator, seller delivers, evaluator finishes from its own account `rJiEkxUmhX2GZ3XGmq3mnC85MAiuSo9XwT` — `adapter-xrpl/scripts/e2e-evaluator-token.mjs` | `4c5903be…`, evaluator `xrpl:1:rJiEkxUmhX2GZ3XGmq3mnC85MAiuSo9XwT` | create [`BE8239468A14…`](https://testnet.xrpl.org/transactions/BE8239468A14AD5531A0C533A96905918A86E3B22D85CC06898C4619CE458393), deliver [`6DB51BAC6748…`](https://testnet.xrpl.org/transactions/6DB51BAC67488605184F8B16BFF0136130ADE99FEA67E95F59AAFB513D7BCDD6), EscrowFinish by the evaluator [`DD570910469B…`](https://testnet.xrpl.org/transactions/DD570910469B6D6365A7124CDD2F50C0FC71391CD542AE2189D5837ABAA08C5E) | **VERIFIED** |
| `escrow:xrpl` TokenEscrow, buyer mode, **1.5 RCPT**                                                                                                                                                                               | `6cdc0f57…`, amount `1500000000000000`                             | create [`727933BF88DA…`](https://testnet.xrpl.org/transactions/727933BF88DA0662620DFF2F864BF48F6BB90334626CEC12C9D8BBCFDA935C44), deliver [`24C654BB1F33…`](https://testnet.xrpl.org/transactions/24C654BB1F332EAA3C4DADB9CF68A513895BB9897AB07D250F51B60BF1EAF287), finish [`BE08354B3430…`](https://testnet.xrpl.org/transactions/BE08354B3430E2B644B485F8B69BE88B46C4995E6719370050551220EDDDFA26)                        | **VERIFIED** |

```text
$ receptum-verify x402-xrpl-token-testnet.json x402-xrpl-token-testnet-output.svg
[PASS] L3 Payment on xrpl:1 — 0.25 5243505400000000000000000000000000000000.rHcy1VS1axUMqKcnUx7eM5k1hr5desdBGh (250000000000000 × 10^-15) delivered to r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s in ledger 21255605 (validated)
[PASS] L3 Anchor on xrpl:1 — memo anchored in validated ledger 21255607
VERIFIED

$ receptum-verify xrpl-testnet-escrow-evaluator.json deliverables/xrpl-testnet-escrow-evaluator.txt
[PASS] L3 Payment on xrpl:1 — escrow finished to the payee; amount, asset, parties and delivery memo match; finished by the evaluator's own account rJiEkxUmhX2GZ3XGmq3mnC85MAiuSo9XwT (EscrowFinish DD570910469B6D6365A7124CDD2F50C0FC71391CD542AE2189D5837ABAA08C5E) (delivered 1191 s before CancelAfter)
VERIFIED

$ receptum-verify xrpl-testnet-escrow-token.json deliverables/xrpl-testnet-escrow-token.txt
[PASS] L3 Payment on xrpl:1 — escrow finished to the payee; amount, asset, parties and delivery memo match; the buyer-held condition was fulfilled (delivered 1193 s before CancelAfter)
VERIFIED
```

(L1, L2 and L2.5 pass for all three; L2.5 online, signed by the enabled master key of the seller.) The buyer in the token x402 run capped the price before signing (a requirements selector comparing `xrplValueToUnits(amount)`) and after delivery (`expected.maxAmount: "250000000000000"`), since x402's own per-asset caps are atomic integers and XRPL issued values are decimals. Files: `x402-xrpl-token-testnet.json` (+ `-output.svg`), `xrpl-testnet-escrow-evaluator.json`, `xrpl-testnet-escrow-token.json`, `deliverables/xrpl-testnet-escrow-{evaluator,token}.txt`.

## Escrow receipts with bindings and deliverables

Bindings live outside the hashed receipt, so they can be added to receipts issued before bindings existed without changing `receiptHash`; the escrow e2e scripts now attach them (matched on `payment.payee`) and publish the synthetic delivered bytes in [`deliverables/`](deliverables).

| File                                                                                         | Receipt                                                                                   | Result                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `arc-testnet-escrow-a.json` (+ `bindings/evm-arc-testnet.json`)                              | Arc `ReceptumEscrow` flow A, escrow id `…:1` (binding attached afterwards)                | **VERIFIED** — L2.5 EIP-191 by `0x6344D17a80775A71b51A61124767AbCD22B0328B`                                                 |
| `xrpl-testnet-escrow-a.json` (+ `bindings/xrpl-testnet.json`)                                | XRPL escrow A (XRP), `43f0c114…02b1`, re-run 2026-10-03                                   | **VERIFIED** — L2.5 online: the enabled master key of `rUuUZJXy7qQhZkpr8ovFBgBT5JrPv3nnFf`                                  |
| `xrpl-testnet-escrow-c.json` (+ `bindings/xrpl-testnet.json`)                                | XRPL TokenEscrow C, 5 RCT (3-character code) = `5000000000000000` units, `4e297c7b…3a63`  | **VERIFIED** — replaces the first run's receipt C, which used the old six-decimal amount and no longer verifies (SPEC §7.3) |
| `../packages/adapter-stellar/e2e-claimable-results.json` (+ `bindings/stellar-testnet.json`) | Stellar claimable balances: A auto-release `3a22b001…`, B buyer accepts `5e1785d5…`       | **VERIFIED** — SEP-53 binding; delivery, settlement and batch-claim rules of SPEC §7.5                                      |
| same                                                                                         | Stellar claimable balance D: delivered, then rejected by the buyer (refunded) `1ee85a65…` | **NOT VERIFIED** (correct: the seller wasn't paid)                                                                          |

Deliverables: `arc-testnet-escrow-a.txt`, `xrpl-testnet-escrow-{a,c}.txt`, `stellar-claimable-{a,b,d}.txt` (plus the Soroban and evaluator/token ones). Re-runs: XRPL [`packages/adapter-xrpl/scripts/e2e-testnet.mjs`](../packages/adapter-xrpl/E2E_RESULTS.md) (C EscrowCreate [`600ED556865B…`](https://testnet.xrpl.org/transactions/600ED556865B1174CE8A8EAE1B01B24AD0A8E4CD2F27411D0A8332FA43396570), finish [`A1D134D0AA85…`](https://testnet.xrpl.org/transactions/A1D134D0AA85E9C263AADD733214432711072E716C8E9D78F39D77F07C64C7A8)) and Stellar [`packages/adapter-stellar/scripts/e2e-testnet.mjs`](../packages/adapter-stellar/E2E_RESULTS.md#claimable-balance-escrow-escrowstellar-claimable) — both scripts assert VERIFIED for every released flow. `node scripts/verify-examples.mjs` and `python verifiers/python/scripts/verify_examples.py` re-check every published receipt (the same 30 cases) and print identical lines.

Files: `x402-base-sepolia.json` (settlement + signed receipt with bindings), `x402-base-sepolia-output.svg` (the delivered bytes), `bindings/*.json` (public bindings for the testnet seller on Base Sepolia, Arc, XRPL and Stellar testnets — no secrets; regenerate with `bindings/create.mjs`).
