# @receptum/server

Sell one job per request over [x402](https://www.x402.org/) and return a seller-signed Receptum receipt with every result.

`handlePaidJob(getHeader, run, config)` answers `402` with x402 requirements, verifies the buyer's payment, runs your job, settles, and returns the output with `PAYMENT-RESPONSE`, `Receptum-Receipt` (base64url JSON) and `Receptum-Receipt-Hash`. **If settlement fails, the output is withheld.** Pass an `anchor` (EVM, XRPL or Stellar) to commit the `receiptHash` on-chain. Pass `bindings` (account bindings, SPEC §4.1) to attach proof that your did:key controls `payTo`; with `bindingVerifiers` the server checks them before settlement and refuses to charge if they don't cover the payee, or if the covering binding expires within `BINDING_EXPIRY_MARGIN_SECONDS` (300 s) of the receipt's `deliveredAt`. `deliveredAt` is fixed once, before settlement, and used in the final receipt, so a binding valid at the preflight also covers the receipt the buyer receives.

Bring an initialized `x402ResourceServer` with the schemes you accept. See [`examples/toy-renderer`](../../examples/toy-renderer/server.mjs).
