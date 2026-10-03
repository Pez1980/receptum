# @receptum/client

Pay for agent work over x402 and only accept results that come with a valid receipt.

`createReceptumFetch({ paidFetch, allowedSellers })` wraps a paying fetch (e.g. `@x402/fetch`) and throws `ReceiptError` unless: the seller signature verifies, SHA-256 of the received bytes equals `outputSha256`, the receipt's `payment.reference` is the x402 settlement transaction, and the seller is on your allow-list. `checkDelivery()` runs the same checks on data you already have.

See [`examples/agent-buyer`](../../examples/agent-buyer/buyer.mjs).
