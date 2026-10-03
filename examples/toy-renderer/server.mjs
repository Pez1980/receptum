// A toy "render" service that sells one job per request through x402 and returns a
// seller-signed Receptum receipt with every result. Testnet only.
//
//   RECEPTUM_WALLETS_DIR=~/.config/receptum/wallets node server.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { sellerKeyFromPem, sha256Hex } from "@receptum/core";
import { handlePaidJob } from "@receptum/server";
import { clientsFor, EvmAnchor } from "@receptum/adapter-evm";

const PORT = Number(process.env.PORT ?? 4021);
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));

const x402 = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }),
).register("eip155:84532", new ExactEvmScheme());
await x402.initialize();

// Anchor receipt hashes on Arc testnet (the seller has Arc gas); payment settles on Base Sepolia.
const anchor =
  process.env.RECEPTUM_ANCHOR === "off"
    ? undefined
    : new EvmAnchor(clientsFor("eip155:5042002", privateKeyToAccount(wallets.seller.privateKey)));

/** The "render": a deterministic SVG card for the prompt. */
function render(prompt) {
  const safe = prompt.replace(/[<>&"]/g, "").slice(0, 80);
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#0F1115"/><text x="80" y="330" fill="#F7F5EF" font-family="sans-serif" font-size="56">${safe}</text><text x="80" y="400" fill="#8A8F98" font-family="monospace" font-size="24">rendered by render.example · receipt attached</text></svg>`,
  );
}

const MAX_BODY = 16 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/render") {
      res.writeHead(404).end();
      return;
    }
    const input = await readBody(req);
    let prompt = "Hello, Receptum";
    if (input.length) {
      const parsed = JSON.parse(input.toString());
      if (parsed.prompt !== undefined && typeof parsed.prompt !== "string")
        throw Object.assign(new Error("prompt must be a string"), { status: 400 });
      prompt = parsed.prompt ?? prompt;
    }

    const result = await handlePaidJob(
      (name) => req.headers[name.toLowerCase()],
      async () => ({
        jobId: `render-${Date.now()}`,
        inputSha256: [sha256Hex(input)],
        output: render(prompt),
        contentType: "image/svg+xml",
      }),
      {
        x402,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            payTo: wallets.seller.address,
            price: "$0.25",
            maxTimeoutSeconds: 120,
          },
        ],
        resource: {
          url: `http://localhost:${PORT}/render`,
          description: "Render a title card",
          mimeType: "image/svg+xml",
          serviceName: "render.example",
        },
        seller: { ...sellerKey, name: "render.example" },
        acceptance: { mode: "auto", reviewWindowSeconds: 0 },
        remedy: { kind: "rerender", withinDays: 30 },
        ...(anchor ? { anchor } : {}),
      },
    );
    if (result.anchor)
      res.setHeader("Receptum-Anchor", `${result.anchor.network}:${result.anchor.reference}`);
    res.writeHead(result.status, result.headers).end(result.body);
  } catch (err) {
    const status = err?.status ?? (err instanceof SyntaxError ? 400 : 500);
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: status === 500 ? "internal error" : err.message }));
    if (status === 500) console.error(err);
  }
});

server.listen(PORT, () =>
  console.log(
    `toy-renderer listening on http://localhost:${PORT}/render (seller ${sellerKey.did})`,
  ),
);
