# @receptum/server

Sell one job per request over [x402](https://www.x402.org/) and return a seller-signed Receptum receipt with every result.

`handlePaidJob(getHeader, run, config)` answers `402` with x402 requirements, verifies the buyer's payment, runs your job, settles, and returns the output with `PAYMENT-RESPONSE`, `Receptum-Receipt` (base64url JSON) and `Receptum-Receipt-Hash`. **If settlement fails, the output is withheld.** Pass an `anchor` (EVM, XRPL or Stellar) to commit the `receiptHash` on-chain.

Bring an initialized `x402ResourceServer` with the schemes you accept. See [`examples/toy-renderer`](../../examples/toy-renderer/server.mjs).
