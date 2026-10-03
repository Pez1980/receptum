# Paid MCP tool call with a Receptum receipt (Base Sepolia)

Run 2026-10-03. An MCP server exposes `transcribe` for **$0.10 USDC**, paid through `@x402/mcp` (`exact`, facilitator `https://x402.org/facilitator`); `@receptum/mcp` attaches a seller-signed receipt to the result. Client and server talk over the MCP SDK's in-memory transport.

| Run | Settlement (Base Sepolia)                                                                                                 | Receipt verified by client                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | [`0xa17bd7ba…1ab613`](https://sepolia.basescan.org/tx/0xa17bd7ba0b9cce6b5fe29b1728f449dd949363032cc3bf9f5b5a071f551ab613) | no — the x402 MCP client strips `_meta`; fixed by `captureReceipts()`                                |
| 2   | [`0x3f668a0b…753873`](https://sepolia.basescan.org/tx/0x3f668a0b9bbdb7f5f96c8cea488abe1f5760790ce060ecb8a21e1da287753873) | yes — signature ✓, `outputSha256` = SHA-256(JCS(content)) ✓, settlement match ✓, seller allow-list ✓ |

Full result: `e2e-results.json`.
