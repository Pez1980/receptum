# @receptum/client

Pay for agent work over x402 and only accept results that come with a valid receipt.

`createReceptumFetch({ paidFetch, allowedSellers })` wraps a paying fetch (e.g. `@x402/fetch`) and throws `ReceiptError` unless: the seller signature verifies, SHA-256 of the received bytes equals `outputSha256`, the receipt's `payment.reference` is the x402 settlement transaction, and the seller is on your allow-list. `checkDelivery()` runs the same checks on data you already have.

Pass `requireBinding: true` with `bindingVerifiers: [evmBindingVerifier]` (from `@receptum/adapter-evm`; Stellar is built in, XRPL has `xrplBindingVerifier`) to also require an account binding (SPEC §4.1) proving the seller controls the account you paid. Without a verifier for the payee's namespace the check fails closed. `check.payeeBound` reports the result either way.

See [`examples/agent-buyer`](../../examples/agent-buyer/buyer.mjs).

## Mainnet x402 networks (opt-in)

Register the mainnet scheme with your x402 client (e.g. `@x402/fetch` with `network: "eip155:8453"`) and declare it to Receptum:

```ts
const buy = createReceptumFetch({
  paidFetch,
  networks: ["eip155:8453"], // the networks paidFetch pays on
  allowMainnet: true, // or RECEPTUM_ALLOW_MAINNET=1
  allowedSellers: [sellerDid],
  expected: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
});
```

With `networks`, `createReceptumFetch` throws `MainnetNotAllowedError` at construction — before any request is paid — for a mainnet without the opt-in, and rejects receipts on networks outside the list. Pin `expected.network` so a testnet receipt can never stand in for a mainnet payment.
