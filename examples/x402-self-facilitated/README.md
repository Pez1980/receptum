# Example: x402 with a self-hosted, in-process facilitator (Arc, Base)

One paid HTTP job over x402 `exact` (EIP-3009 USDC), end to end, with a Receptum receipt anchored on the same network — and **no third-party facilitator**.

**Why self-hosted.** Arc has no public x402 facilitator: `https://x402.org/facilitator` serves testnets only and doesn't list Arc, and Receptum never defaults a mainnet facilitator (`facilitatorUrlFor`, [docs/MAINNET.md](../../docs/MAINNET.md) §2). So the seller runs the facilitator in its own process. The same code settles on Base, where it replaces a hosted facilitator account with the seller's own key. The trade-off is the same on both chains: the seller pays the settlement gas (USDC on Arc, ETH on Base).

**How it is wired** (`e2e.mjs`):

- **Facilitator**: `x402Facilitator` (`@x402/core/facilitator`) with the EVM `exact` facilitator scheme (`@x402/evm/exact/facilitator`), registered for the chosen network only. Its signer (`toFacilitatorEvmSigner`) reads through viem and writes with the **seller's EVM account**. It only ever submits USDC `transferWithAuthorization`, re-checks the mainnet opt-in and the RPC's chain id before every write (`assertSigningNetwork`), and never sends raw transactions (ERC-6492 wallet deployment is off).
- **In-process `FacilitatorClient`**: `{ verify, settle, getSupported }` calls the local facilitator directly, with no HTTP hop, and is passed to `x402ResourceServer` with `ExactEvmScheme` (`@x402/evm/exact/server`).
- **Seller**: `@receptum/server` `handlePaidJob` prices the render at an explicit USDC asset and EIP-712 domain (`name`, `version`), not x402's default table. Before charging, it checks that the seller's EIP-191 account binding covers `payTo`. After settlement it signs the receipt with its Ed25519 `did:key` and anchors `receiptHash` with `EvmAnchor` (a zero-value self-transaction) **on the same network**.
- **Buyer**: `@x402/fetch` + `ExactEvmScheme` (`@x402/evm/exact/client`). A payment policy lets it sign only for this seller, this USDC and at most the price. `@receptum/client` `createReceptumFetch` accepts the result only if the signature, output hash, settlement, allow-listed seller, binding (`requireBinding`) and the buyer's own expectations all check out. The expectations are network, asset, exact amount, payee, payer and input hash.
- **Verification**: `@receptum/verify` then checks the file, signature, binding, the ERC-20 `Transfer` of the settlement and the anchor (SPEC §7.3), and the script prints the verdict.

Before anything is signed the script checks, read-only: the RPC serves the chain; the USDC contract's `name()`, `version()`, `decimals()` and `DOMAIN_SEPARATOR()` match the expected EIP-712 domain; the seller holds gas (≥ 0.02 USDC on Arc, ≥ 0.00005 ETH on Base); and the buyer holds the price (on Arc, price + 0.02 USDC). It prints both parties' balances. Right before settling, it estimates the settlement and anchor (`eth_estimateGas`, plus the OP-stack L1 fee on Base). It refuses to settle if the seller can't cover the maximum cost.

| `--network`      | Chain              | USDC (EIP-712 name, version)                                   | Gas  | Output                       |
| ---------------- | ------------------ | -------------------------------------------------------------- | ---- | ---------------------------- |
| `eip155:5042002` | Arc testnet        | `0x3600…0000` (`USDC`, `2`)                                    | USDC | `examples/x402-arc-testnet`  |
| `eip155:84532`   | Base Sepolia       | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (`USDC`, `2`)     | ETH  | `examples/x402-base-testnet` |
| `eip155:5042`    | Arc (**mainnet**)  | `0x3600…0000` (`USDC`, `2`)                                    | USDC | `examples/x402-arc-mainnet`  |
| `eip155:8453`    | Base (**mainnet**) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`USD Coin`, `2`) | ETH  | `examples/x402-base-mainnet` |

The domains were read on-chain on 13 Oct 2026, and every run reads them again. Default price: 0.25 USDC on testnets (like `toy-renderer`) and 0.01 USDC on mainnets (`--price <usdc>`, at most 1 USDC on a mainnet). `--rpc <url>` overrides the signing RPC; its chain id is checked.

## Testnet

```sh
pnpm install && pnpm build
node examples/x402-self-facilitated/e2e.mjs --dry-run   # Arc testnet; nothing is sent
node examples/x402-self-facilitated/e2e.mjs             # Arc testnet, 0.25 USDC
node packages/verify/dist/cli.js examples/x402-arc-testnet.json examples/x402-arc-testnet-output.svg
PYTHONPATH=verifiers/python/src python3 -m receptum_verify examples/x402-arc-testnet.json examples/x402-arc-testnet-output.svg
```

`--network eip155:84532` runs the same on Base Sepolia; the seller needs Base Sepolia ETH for gas. Testnet keys come from `$RECEPTUM_WALLETS_DIR` (default `~/.config/receptum/wallets`): `evm-testnet.json` (buyer, seller) and `seller-ed25519.pem`. The receipt carries the published binding (`examples/bindings/evm-arc-testnet.json`, `evm-base-sepolia.json`) when it matches those keys, otherwise a fresh one.

## `--dry-run`

`--dry-run` runs the whole flow up to and including the facilitator's **verify** step, then exits before anything is sent:

1. The read-only preflight described above.
2. The buyer's 402 round trip and its EIP-712 signature of an EIP-3009 authorization. The signature stays in this process and is never submitted.
3. The facilitator's verify: signature, recipient, amount and validity window, then an `eth_call` simulation of `transferWithAuthorization`. On failure it diagnoses balance, nonce (`authorizationState`) and token name/version.
4. The job, plus the receipt and binding preflight.
5. The planned settlement and anchor: `to`, calldata size, estimated gas, and expected and maximum cost in the chain's gas token.

The dry run then stops before `settle`, so there is no settlement and no anchor. If the preflight finds a problem, the dry run reports `WOULD REFUSE: …`, continues so it can still price the transactions, and exits 1.

## Mainnet (opt-in, real funds)

Mainnets follow the repo's opt-in ([docs/MAINNET.md](../../docs/MAINNET.md) §2). Without `RECEPTUM_ALLOW_MAINNET=1` the script refuses before reading any key. With it, it passes `allowMainnet: true` explicitly to `clientsFor`, `handlePaidJob` and `createReceptumFetch`.

Keys come **only from the environment**: `RECEPTUM_MAINNET_BUYER_KEY`, `RECEPTUM_MAINNET_SELLER_KEY` (0x-hex EVM keys) and `RECEPTUM_MAINNET_SELLER_PEM`. The PEM variable holds the absolute path of the seller's Ed25519 PKCS8 PEM; a path that resolves into the testnet wallet directory is refused. Wallet files are never read. Following §4, the script refuses a seller `did:key` or an EVM account that the repo's published testnet bindings or receipts use. The seller needs gas, the buyer the price. Run the dry run first:

```sh
RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_BUYER_KEY=0x… RECEPTUM_MAINNET_SELLER_KEY=0x… \
  RECEPTUM_MAINNET_SELLER_PEM=/abs/path/seller-ed25519.pem \
  node examples/x402-self-facilitated/e2e.mjs --network eip155:5042 --dry-run
```

Then run it without `--dry-run` (and with `--network eip155:8453` for Base). The script prints addresses, DIDs, balances and explorer links, never a key. Before writing `examples/x402-<arc|base>-mainnet.json` it refuses any output that contains a key.

Results: Arc testnet, 13 Oct 2026 ([examples/E2E_RESULTS.md](../E2E_RESULTS.md#x402-exact-with-a-self-hosted-facilitator-arc-testnet)). The same day it made the first mainnet receipts: 0.01 USDC on Arc and on Base, both VERIFIED by both verifiers (`examples/x402-arc-mainnet.json`, `examples/x402-base-mainnet.json`; [details](../E2E_RESULTS.md#x402-exact-on-mainnet-arc-and-base-2026-10-13)). The buyer and the seller in those runs are both our own wallets: they were test purchases, not customer transactions.
