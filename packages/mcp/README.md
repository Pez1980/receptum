# @receptum/mcp

Signed receipts for paid MCP tools.

- Server: `withReceipts(paid(handler), { seller, price })` wraps an `@x402/mcp` payment-wrapped tool and adds a seller-signed receipt to `result._meta["receptum/receipt"]` on every settled call. The output hash is SHA-256 of `JCS(result.content)`.
- Client: `verifyToolResult(result, allowedSellers)`; `captureReceipts(x402McpClient)` recovers `_meta`, which the x402 MCP client doesn't return.

Live run: [E2E_RESULTS.md](E2E_RESULTS.md).
