# Example: x402 on XRPL testnet

One paid HTTP job over x402 `exact` on `xrpl:1` (XRPL testnet), end to end, with a Receptum receipt:

- a local seller built on `@receptum/server` (`handlePaidJob`) prices a render at **0.01 XRP** (`10000` drops) and settles through the public facilitator `https://x402.org/facilitator`, which advertises `exact` on `xrpl:1` with `areFeesSponsored: false`, so the buyer pays the XRPL fee. The receipt carries the seller's account binding (`examples/bindings/xrpl-testnet-x402.json`). Before charging, the server checks that this binding covers `payTo`. After settlement it anchors the receipt hash with `XrplAnchor` (a `receptum/1` memo on a seller `AccountSet`);
- a buyer agent built on `@receptum/client` + `@x402/fetch` + `@x402/xrpl` signs an XRPL `Payment`. It accepts the result only if the receipt, output hash, settlement, binding (`requireBinding`) and its own expectations all match. Its expectations are the network, `asset: "XRP"`, the max drops, the payee and the payer. XRP isn't an x402 "default asset", so the buyer opts in with `spendControls.allowedAssets`, capped in drops;
- `@receptum/verify` then confirms the validated `Payment` (tesSUCCESS, Account = payer, Destination = payee, `delivered_amount` = the receipt's drops) and the anchor memo. The rule is in [SPEC §7.3](../../docs/SPEC.md#73-settlement-level-3).

```sh
pnpm install && pnpm build
node examples/x402-xrpl/setup-wallets.mjs   # once: faucet-funded buyer + seller, and the seller binding
node examples/x402-xrpl/e2e.mjs
node packages/verify/dist/cli.js examples/x402-xrpl-testnet.json examples/x402-xrpl-testnet-output.svg \
  --anchor "$(node -p 'require("./examples/x402-xrpl-testnet.json").anchor')"
```

Testnet only. Keys stay in `~/.config/receptum/wallets` (`xrpl-x402-testnet.json` with mode 600, plus `seller-ed25519.pem`); the scripts print addresses only and refuse to write a seed into the repo. Results: `examples/x402-xrpl-testnet.json` (settlement, anchor, signed receipt) and `examples/x402-xrpl-testnet-output.svg` (the delivered bytes). See [examples/E2E_RESULTS.md](../E2E_RESULTS.md).

**Issued tokens** (`e2e-token.mjs`, after `setup-token.mjs`): the same job priced at **0.25** of a self-issued, RLUSD-style token (`RCPT`, 40-hex currency code) from a fresh issuer account (`asfDefaultRipple`, trust lines for buyer and seller, buyer funded). `@x402/xrpl` expresses the price as `asset` = the currency code, `extra.issuer` = the issuer and `amount` = the decimal value `"0.25"`; `handlePaidJob` records `payment.asset` = `<currency>.<issuer>` and `payment.amount` = `"250000000000000"` (10^-15 units, SPEC §7.3) and refuses, before charging, values that are not whole 10^-15 units. The buyer caps the price in the same integer units (a requirements selector before signing, `expected.maxAmount` on the receipt). The public facilitator accepted the issued currency and the receipt is VERIFIED (`examples/x402-xrpl-token-testnet.json`).

```sh
node examples/x402-xrpl/setup-token.mjs   # once: fresh issuer + evaluator, trust lines, buyer funded
node examples/x402-xrpl/e2e-token.mjs
node packages/verify/dist/cli.js examples/x402-xrpl-token-testnet.json examples/x402-xrpl-token-testnet-output.svg
```
