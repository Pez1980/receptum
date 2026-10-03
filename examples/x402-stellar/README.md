# Example: x402 on Stellar testnet

One paid HTTP job over x402 `exact` on `stellar:testnet`, end to end, with a Receptum receipt:

- a local seller built on `@receptum/server` (`handlePaidJob`) prices a render at **$0.01 USDC** and settles through the public facilitator `https://x402.org/facilitator` (it advertises `exact` on `stellar:testnet` and sponsors the fees);
- a buyer agent built on `@receptum/client` + `@x402/fetch` + `@x402/stellar` pays by signing a Soroban authorization for the USDC contract's `transfer`, and accepts the result only if the receipt, output hash, settlement and its own expectations (network, asset, max amount, payee, payer) all match;
- `@receptum/verify` then confirms the settlement on chain: a USDC transfer of exactly the receipt's amount from the payer to `payment.payee`.

```sh
pnpm install && pnpm build
node examples/x402-stellar/e2e.mjs
```

Testnet only. Keys come from `~/.config/receptum/wallets` (`stellar-testnet.json`, `seller-ed25519.pem`; see `packages/adapter-stellar/README.md`). The buyer needs testnet USDC — `packages/adapter-stellar/scripts/e2e-testnet.mjs` sets that up. Results: `examples/x402-stellar-testnet.json` and the x402 section of [packages/adapter-stellar/E2E_RESULTS.md](../../packages/adapter-stellar/E2E_RESULTS.md).
