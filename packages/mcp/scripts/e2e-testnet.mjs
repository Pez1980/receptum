// Real paid MCP tool call on Base Sepolia: @x402/mcp handles payment, @receptum/mcp adds the receipt.
// Not part of CI. Wallets come from $RECEPTUM_WALLETS_DIR (default ~/.config/receptum/wallets).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPaymentWrapper, createx402MCPClient, x402ResourceServer } from "@x402/mcp";
import { ExactEvmScheme as ServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { sellerKeyFromPem } from "@receptum/core";
import { captureReceipts, verifyToolResult, withReceipts } from "../dist/index.js";

const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
const seller = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }),
);
resourceServer.register("eip155:84532", new ServerScheme());
await resourceServer.initialize();
const accepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: "eip155:84532",
  payTo: wallets.seller.address,
  price: "$0.10",
});
const paid = createPaymentWrapper(resourceServer, { accepts });

const server = new McpServer({ name: "render.example", version: "0.1.0" });
server.tool(
  "transcribe",
  "Transcribe an audio file. Costs $0.10; every result carries a Receptum receipt.",
  { audioSha256: z.string() },
  withReceipts(
    paid(async ({ audioSha256 }) => ({
      content: [
        {
          type: "text",
          text: `Transcript for ${audioSha256.slice(0, 12)}…: "Know what you paid for."`,
        },
      ],
    })),
    {
      seller: { ...seller, name: "render.example" },
      price: { asset: accepts[0].asset, amount: accepts[0].amount, payTo: accepts[0].payTo },
      inputsFor: ({ audioSha256 }) => [audioSha256],
    },
  ),
);

const client = createx402MCPClient({
  name: "agent-buyer",
  version: "0.1.0",
  schemes: [
    {
      network: "eip155:84532",
      client: new ClientScheme(privateKeyToAccount(wallets.buyer.privateKey)),
    },
  ],
  autoPayment: true,
  onPaymentRequested: async ({ paymentRequired }) =>
    BigInt(paymentRequired.accepts[0].amount) <= 200_000n,
});
const receipts = captureReceipts(client);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);

const result = await client.callTool("transcribe", { audioSha256: "a".repeat(64) });
const full = receipts.lastResult("transcribe");
const check = full
  ? verifyToolResult(full, [seller.did])
  : { ok: false, reasons: ["no paid result captured"] };
console.log("settlement:", result.paymentResponse?.transaction, "check:", check.ok, check.reasons);
writeFileSync(
  new URL("../e2e-results.json", import.meta.url),
  JSON.stringify(
    {
      settlement: result.paymentResponse,
      content: result.content,
      receipt: check.receipt,
      check: { ok: check.ok, reasons: check.reasons },
    },
    null,
    2,
  ) + "\n",
);
await client.close();
process.exit(check.ok ? 0 : 1);
