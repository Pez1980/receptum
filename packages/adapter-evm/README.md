# @receptum/adapter-evm

`ReceptumEscrow` (Solidity 0.8.30) and a viem rail for **Arc testnet** (`eip155:5042002`), **Arbitrum Sepolia** (`eip155:421614`, USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, `https://sepolia.arbiscan.io`) and **Base Sepolia** (`eip155:84532`), all with Circle USDC — the default. **Base** (`eip155:8453`), **Arc** (`eip155:5042`) and **Arbitrum One** (`eip155:42161`) mainnet entries exist behind an explicit opt-in (below).

- `open` (buyer, after ERC-20 approval) → `deliver(id, receiptHash)` (seller, before the deadline) → `accept` / `reject` (buyer or evaluator; reject only within the review window) → `release` (anyone, after the window) / `refund` (anyone, after the deadline with no delivery).
- Funding is checked by balance delta (fee-on-transfer/rebasing tokens and non-contract tokens are rejected), every fund-moving call is reentrancy-locked, the evaluator can't be the buyer or seller, and `sellerRefund` lets the seller return funds at any time before release.
- Sellers are paid in full on release. Events: `Opened`, `Delivered(id, receiptHash)`, `Released`, `Refunded`.
- `evmAccountSigner(account, network)` / `evmBindingVerifier` — account bindings (SPEC §4.1) for EOAs: EIP-191 `personal_sign` over the statement's JCS, verified offline by address recovery (low-s, v ∈ {27, 28}). Contract wallets are not supported.
- `EvmAnchor` anchors a receiptHash as calldata `utf8("receptum/1") ‖ receiptHash` in a zero-value self-transaction (for x402 payments without escrow).

Tests: 24 Foundry tests incl. adversarial tokens (fee-on-transfer, no-return, malformed return, reentrant, blocklisting) and two fuzz tests (`forge test`), plus an anvil integration test for the TypeScript rail.
Deployed (testnet): `0x20d69c6c647559f48a7e6b0a3f922e99a4068f16` on Arc (hardened after the independent review; the earlier `0x468d4e3f…859a` deployment is superseded) and `0x1cd7ed69a10d5aafcf2fcb927a431183b3c43862` on Arbitrum Sepolia — the same runtime code (code hash `0x58c8beee…1af24861` = `receptumEscrowDeployedBytecode`), both in `TRUSTED_ESCROWS` — see [E2E_RESULTS.md](E2E_RESULTS.md).

End-to-end run (testnets only; mainnets are refused): `node scripts/e2e-testnet.mjs [eip155:5042002|eip155:421614]` — buyer accepts, auto-release, refund after the deadline and a standalone anchor; results go to `e2e-results[.<network>].json` and this network's section of `E2E_RESULTS.md`.

**Threat notes.** A buyer can reject a genuine delivery within the review window (buyer-acceptance risk — use an evaluator for high-value jobs). Funds can't be released before delivery or refunded after delivery except by rejection. Unaudited; testnet by default, mainnet only behind the opt-in and after an audit.

## Mainnet (opt-in)

`NETWORKS` = `TESTNETS` + `MAINNETS`. Mainnets: Base `eip155:8453` (USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `https://basescan.org`) Arc `eip155:5042` (USDC ERC-20 interface `0x3600000000000000000000000000000000000000`, 6 decimals, `https://explorer.arc.io`) and Arbitrum One `eip155:42161` (native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, not the bridged USDC.e; `https://arbiscan.io`). Every signing path throws `MainnetNotAllowedError` before signing unless you opt in:

```ts
const c = clientsFor("eip155:8453", account, { allowMainnet: true, rpcUrl }); // or RECEPTUM_ALLOW_MAINNET=1
await new EvmAnchor(c).anchor(receiptHash);
```

`deployEscrow`, every `EvmEscrowRail` write and `EvmAnchor.anchor` re-check the opt-in (`assertSigningAllowed`), including for hand-built `EvmClients` on chains Receptum doesn't know. Verifiers read mainnet without it.

`ReceptumEscrow` holds customer funds and goes to mainnet only after an independent audit (grant-funded, see [docs/MAINNET.md](../../docs/MAINNET.md)). `scripts/deploy-mainnet.mjs <eip155:8453|eip155:5042|eip155:42161> --audit-report <url> [--dry-run]` refuses unless `RECEPTUM_ALLOW_MAINNET=1`, reads the fresh deployer key only from `RECEPTUM_MAINNET_DEPLOYER_KEY` (never wallet files), prints the plan (network, deployer, balance, estimated gas and cost, code hash) and needs the typed confirmation phrase on an interactive terminal. No mainnet deployment exists yet; `TRUSTED_ESCROWS` in `@receptum/verify` has empty mainnet entries until one is published.
