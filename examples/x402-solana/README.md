# Example: x402 on Solana devnet

One paid HTTP job over x402 `exact` on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet), end to end, with a Receptum receipt:

- a local seller built on `@receptum/server` (`handlePaidJob`) prices a render at **0.01 devnet USDC** (`10000` base units of Circle's devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) and settles through the public facilitator `https://x402.org/facilitator`, which advertises `exact` on Solana devnet and co-signs as fee payer (`extra.feePayer`). The receipt carries the seller's account binding (`examples/bindings/solana-devnet.json`, created on the first run); before charging, the server checks that it covers `payTo`. After settlement it anchors the receipt hash with `SolanaAnchor` (an SPL Memo `receptum/1:<receiptHash>` from the seller);
- a buyer agent built on `@receptum/client` + `@x402/fetch` + `@x402/svm` (2.28) partially signs the `transferChecked`. It accepts the result only if the receipt, output hash, settlement, binding (`requireBinding`) and its own expectations (network, mint, max amount, payee, payer) all match;
- `@receptum/verify` then confirms the transfer (SPEC §7.3: `transferChecked` of exactly the amount between token accounts owned by payer and payee, and the payee's net balance change) and the memo anchor (§7.1).

```sh
pnpm install && pnpm build
node examples/x402-solana/e2e.mjs
node packages/verify/dist/cli.js examples/x402-solana-devnet.json examples/x402-solana-devnet-output.svg
```

Devnet only. Keys stay in `~/.config/receptum/wallets` (`solana-devnet-buyer.json`, `solana-devnet-seller.json` — Solana CLI keypair files, mode 600 — plus `seller-ed25519.pem`); the scripts print addresses only and refuse to write key material into the repo. The buyer needs devnet USDC ([faucet.circle.com](https://faucet.circle.com), network "Solana Devnet"); the seller needs a little devnet SOL for its USDC token account (created once, since the x402 client pays into the payee's associated token account) and the anchor fee. Results: `examples/x402-solana-devnet.json` and `examples/x402-solana-devnet-output.svg`; see [packages/adapter-solana/E2E_RESULTS.md](../../packages/adapter-solana/E2E_RESULTS.md).
