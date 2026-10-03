# @receptum/server

Sell one job per request over [x402](https://www.x402.org/) and return a seller-signed Receptum receipt with every result.

`handlePaidJob(getHeader, run, config)` answers `402` with x402 requirements, verifies the buyer's payment, runs your job, settles, and returns the output with `PAYMENT-RESPONSE`, `Receptum-Receipt` (base64url JSON) and `Receptum-Receipt-Hash`. **If settlement fails, the output is withheld.** Pass an `anchor` (EVM, XRPL or Stellar) to commit the `receiptHash` on-chain. Pass `bindings` (account bindings, SPEC §4.1) to attach proof that your did:key controls `payTo`; with `bindingVerifiers` the server checks them before settlement and refuses to charge if they don't cover the payee, or if the covering binding expires within `BINDING_EXPIRY_MARGIN_SECONDS` (300 s) of the receipt's `deliveredAt`. `deliveredAt` is fixed once, before settlement, and used in the final receipt, so a binding valid at the preflight also covers the receipt the buyer receives.

Bring an initialized `x402ResourceServer` with the schemes you accept. See [`examples/toy-renderer`](../../examples/toy-renderer/server.mjs).

## Mainnet x402 networks (opt-in)

Testnets are the default. To sell on a mainnet, register it explicitly with a mainnet facilitator you configure — there is no default mainnet facilitator — and opt in:

```ts
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { facilitatorUrlFor, handlePaidJob } from "@receptum/server";

const mainnet = {
  facilitators: { "eip155:8453": process.env.X402_FACILITATOR_URL! },
  allowMainnet: true,
};
const x402 = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrlFor("eip155:8453", mainnet) }),
).register("eip155:8453", new ExactEvmScheme());
await x402.initialize();

await handlePaidJob(getHeader, run, {
  x402,
  accepts: [{ scheme: "exact", network: "eip155:8453", payTo, price: "$0.25" }],
  allowMainnet: true, // or RECEPTUM_ALLOW_MAINNET=1
  resource,
  seller,
});
```

`facilitatorUrlFor(network, config)` returns `https://x402.org/facilitator` (`X402_TESTNET_FACILITATOR_URL`) for testnets only; for a mainnet it needs both `facilitators[network]` (https) and the opt-in. `handlePaidJob` throws `MainnetNotAllowedError` before quoting or charging when an `accepts` option is on a mainnet without `allowMainnet`. x402 `exact` moves funds buyer → seller directly; no Receptum contract holds money. See [docs/MAINNET.md](../../docs/MAINNET.md).
