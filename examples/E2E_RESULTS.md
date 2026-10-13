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

## x402 exact on mainnet: Arc and Base (2026-10-13)

The first mainnet receipts. `examples/x402-self-facilitated/e2e.mjs` sold one render for **0.01 USDC** on each chain over x402 `exact` (EIP-3009), settled by the in-process facilitator from the seller's account (which paid the gas: USDC on Arc, ETH on Base) and anchored on the same chain. Both were run with `RECEPTUM_ALLOW_MAINNET=1` and keys from the environment, each after a `--dry-run`. **Non-custodial**: USDC moved buyer → seller directly; no Receptum contract was involved. **The buyer and the seller are both our own wallets** (test purchases, no external users): buyer `0x1A04DB634477914f22BF06e7649bfE19eebEEfa1`, seller `0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602` (`did:key:z6MkvRemQnAGxzZyo1FTvg8EecFDiptuY4SuKysC6Kpi676M`, bound to the payout account by EIP-191 on each chain).

| Step                                          | Network            | Reference                                                                                                            |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| x402 settlement (seller-sent, block 25670947) | Arc `eip155:5042`  | [`0xaf71601a…47559a`](https://explorer.arc.io/tx/0xaf71601a58c80cb96395c367c670c74b3c300b11e1f7f06297af6517e647559a) |
| Receipt anchor (block 25670950)               | Arc `eip155:5042`  | [`0x3fff5a28…ccbe72`](https://explorer.arc.io/tx/0x3fff5a28ade79b13e758c5f38e9ebe8af83e6c516415c5128335f82ac4ccbe72) |
| x402 settlement (seller-sent, block 52531993) | Base `eip155:8453` | [`0xb455011d…ac12c2`](https://basescan.org/tx/0xb455011d69c09fb08eee81707789ee963efb6b9df256c36591cc3febf3ac12c2)    |
| Receipt anchor (block 52531994)               | Base `eip155:8453` | [`0x07b478da…d3f221`](https://basescan.org/tx/0x07b478dab94dce37241b9d4ecad6c5be6eef51b5540d94358e259f033bd3f221)    |

- Arc: receiptHash `f2e3f781f1f44c4662ed5d819d422d57d82386dbcf917068b17d5bf7290435bd` (`RCPT-SQ8W-YEJ5`). Base: receiptHash `8b3e76d1b5b16cca0063c2f768214db69c523b49b25b531618b7b5fe19f11395` (`RCPT-ZDAZ-RTTE`). Client check: all accepted, `payeeBound: true`, on both.

```text
$ receptum-verify x402-arc-mainnet.json x402-arc-mainnet-output.svg
=== MAINNET receipt (eip155:5042) — real funds ===
[PASS] L1 File matches receipt — SHA-256 efa690d9b09bddfb6bdcce5eaef4a8096fbbbfba81e0fd76b3d188c26ee93408 = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6MkvRemQnAGxzZyo1FTvg8EecFDiptuY4SuKysC6Kpi676M
[PASS] L2.5 Seller controls payee — did:key:z6MkvRemQnAGxzZyo1FTvg8EecFDiptuY4SuKysC6Kpi676M ↔ eip155:5042:0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602: EIP-191 signature by 0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602 (offline)
[PASS] L3 Payment on eip155:5042 — 10000 base units paid to 0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602 in block 25670947
[PASS] L3 Anchor on eip155:5042 — receiptHash anchored in 0x3fff5a28ade79b13e758c5f38e9ebe8af83e6c516415c5128335f82ac4ccbe72 (block 25670950, from 0x0e7d02f47b2add9a990ed7ec39ff36500ea17602)

VERIFIED

$ receptum-verify x402-base-mainnet.json x402-base-mainnet-output.svg
=== MAINNET receipt (eip155:8453) — real funds ===
[PASS] L1 File matches receipt — SHA-256 de48cad1421cc9c312d6dcf4ff25b131f50586d579a19544a389242b051025ca = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6MkvRemQnAGxzZyo1FTvg8EecFDiptuY4SuKysC6Kpi676M
[PASS] L2.5 Seller controls payee — did:key:z6MkvRemQnAGxzZyo1FTvg8EecFDiptuY4SuKysC6Kpi676M ↔ eip155:8453:0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602: EIP-191 signature by 0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602 (offline)
[PASS] L3 Payment on eip155:8453 — 10000 base units paid to 0x0e7D02f47B2adD9a990Ed7eC39fF36500ea17602 in block 52531993
[PASS] L3 Anchor on eip155:8453 — receiptHash anchored in 0x07b478dab94dce37241b9d4ecad6c5be6eef51b5540d94358e259f033bd3f221 (block 52531994, from 0x0e7d02f47b2add9a990ed7ec39ff36500ea17602)

VERIFIED
```

The Python verifier prints the same MAINNET header and VERIFIED for both (L3 settlement: `Transfer 10000` of the chain's USDC from the buyer to the seller). Files: `x402-arc-mainnet.json`, `x402-base-mainnet.json` (+ `-output.svg`).

## x402 exact with a self-hosted facilitator (Arc testnet)

Run 2026-10-13 · `examples/x402-self-facilitated/e2e.mjs` sold one render for **0.25 USDC** over x402 `exact` (EIP-3009) on `eip155:5042002`, settled by a facilitator running **in the seller's process**: `x402Facilitator` + the `@x402/evm` exact facilitator scheme, signing with the seller's EVM account, which paid the gas in USDC (Arc has no public x402 facilitator). The receipt carries the seller's binding (`bindings/evm-arc-testnet.json`) and is anchored on Arc testnet, the payment's own network.

| Step                                                       | Network                      | Reference                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| x402 settlement (`transferWithAuthorization`, seller-sent) | Arc testnet `eip155:5042002` | [`0x83384ce1…58ec0a`](https://explorer.testnet.arc.io/tx/0x83384ce1f5faa28c190d4733923bbac813c823fb6a684615716740714158ec0a) |
| Receipt anchor (`receptum/1` ‖ receiptHash)                | Arc testnet `eip155:5042002` | [`0xe557e482…301bf4`](https://explorer.testnet.arc.io/tx/0xe557e482aa22084c7dca6756c525ab3d6f3f20fdd04508f766fad83330301bf4) |

- receiptHash `53245ad6e944e16de216d1385aa629d356c616d4e171eece02fa4d6f123a5955` (`RCPT-M2CJ-EJ2W`), payer `eip155:5042002:0x62E5fFEcdc8be558F0a05031242ea1E9D3e921e5`, payee `eip155:5042002:0x6344D17a80775A71b51A61124767AbCD22B0328B`, blocks 66906844 (settlement) and 66906854 (anchor). Planned before settling: settlement ≈ 88,086 gas, anchor ≈ 23,016 gas, ≈ 0.0028 USDC together. Client check: all accepted, `payeeBound: true`.
- `--dry-run` was run first: the facilitator's verify (EIP-712 signature + `eth_call` simulation) passed and nothing was sent. A Base Sepolia dry run also passed verify and priced the settlement (≈ 86,655 gas, including the OP-stack L1 fee); the Base Sepolia leg was not run because the testnet seller holds no Base Sepolia ETH.

```text
$ receptum-verify x402-arc-testnet.json x402-arc-testnet-output.svg
[PASS] L1 File matches receipt — SHA-256 2bb19270f4c48b20299fcb37110822b9fb8e6b9d0d4e1317af0a9d7e4bd38b20 = outputSha256
[PASS] L2 Seller signature — signed by did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
[PASS] L2.5 Seller controls payee — did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t ↔ eip155:5042002:0x6344D17a80775A71b51A61124767AbCD22B0328B: EIP-191 signature by 0x6344D17a80775A71b51A61124767AbCD22B0328B (offline)
[PASS] L3 Payment on eip155:5042002 — 250000 base units paid to 0x6344D17a80775A71b51A61124767AbCD22B0328B in block 66906844
[PASS] L3 Anchor on eip155:5042002 — receiptHash anchored in 0xe557e482aa22084c7dca6756c525ab3d6f3f20fdd04508f766fad83330301bf4 (block 66906854, from 0x6344d17a80775a71b51a61124767abcd22b0328b)

VERIFIED

$ python -m receptum_verify x402-arc-testnet.json x402-arc-testnet-output.svg   # anchor read from the file
VERIFIED
  L3 settlement  PASS  tx 0x83384ce1…58ec0a succeeded; Transfer 250000 of 0x3600000000000000000000000000000000000000 0x62e5…21e5 -> 0x6344…328b (block 66906844)
  L3 anchor      PASS  eip155:5042002 tx 0xe557e482…301bf4 commits receiptHash (block 66906854)
```

Files: `x402-arc-testnet.json` (settlement, anchor, signed receipt, client check, verify report), `x402-arc-testnet-output.svg`.

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
