# @receptum/mcp

Signed receipts for paid MCP tools.

- Server: `withReceipts(paid(handler), { seller, price })` wraps an `@x402/mcp` payment-wrapped tool and adds a seller-signed receipt to `result._meta["receptum/receipt"]` on every settled call. The output hash is SHA-256 of `JCS(result.content)`.
- Bindings: pass `bindings` (SPEC §4.1) to `withReceipts` to attach them to every receipt; on the client, `verifyToolResult(result, allowedSellers, { requireBinding: true, bindingVerifiers: [evmBindingVerifier] })` requires one that covers the payee (set `price.payTo` so receipts name it).
- Client: `verifyToolResult(result, allowedSellers)`; `captureReceipts(x402McpClient)` recovers `_meta`, which the x402 MCP client doesn't return.

Live run: [E2E_RESULTS.md](E2E_RESULTS.md).

Mainnet: `withReceipts` runs after settlement, so it has no gate of its own — the gate is the x402 resource server you hand to `@x402/mcp`. Configure it with `facilitatorUrlFor` from `@receptum/server` (explicit mainnet facilitator + `allowMainnet`); see [docs/MAINNET.md](../../docs/MAINNET.md).
