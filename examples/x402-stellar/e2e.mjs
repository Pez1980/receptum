// Paid HTTP job over x402 `exact` on Stellar TESTNET (never mainnet), with a Receptum receipt.
//
//   pnpm build && node examples/x402-stellar/e2e.mjs
//
// Starts a local seller (`@receptum/server` handlePaidJob, facilitator https://x402.org/facilitator,
// which sponsors fees on stellar:testnet), then buys one job as an agent (`@receptum/client` over
// `@x402/fetch` + `@x402/stellar`), and finally checks the receipt with `@receptum/verify`
// (signature + the USDC transfer to the payee in the settlement transaction).
//
// Keys: $RECEPTUM_WALLETS_DIR/stellar-testnet.json (buyer, seller) and seller-ed25519.pem.
// Public results only: examples/x402-stellar-testnet.json and the x402 section of
// packages/adapter-stellar/E2E_RESULTS.md.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClient } from "@x402/stellar/exact/client";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { sellerKeyFromPem, sha256Hex } from "@receptum/core";
import { handlePaidJob } from "@receptum/server";
import { createReceptumFetch } from "@receptum/client";
import { verify } from "@receptum/verify";
import { TESTNET_USDC_SAC, explorerTxUrl } from "@receptum/adapter-stellar";
import { writeSection } from "../../packages/adapter-stellar/scripts/testnet-common.mjs";

const NETWORK = "stellar:testnet";
const FACILITATOR = "https://x402.org/facilitator";
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "stellar-testnet.json"), "utf8"));
const buyer = { publicKey: () => wallets.buyer.publicKey, secret: () => wallets.buyer.secret };
const seller = { publicKey: () => wallets.seller.publicKey };
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));

// The facilitator must advertise exact on stellar:testnet.
const supported = await (await fetch(`${FACILITATOR}/supported`)).json();
const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
if (!kind) throw new Error(`${FACILITATOR} does not support exact on ${NETWORK}`);
console.log("facilitator supports", JSON.stringify(kind));

// ─── Seller ────────────────────────────────────────────────────────────────
const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(
  NETWORK,
  new ExactStellarServer(),
);
await x402.initialize();

const render = (prompt) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#0F1115"/><text x="80" y="330" fill="#F7F5EF" font-family="sans-serif" font-size="56">${prompt.replace(/[<>&"]/g, "").slice(0, 80)}</text><text x="80" y="400" fill="#8A8F98" font-family="monospace" font-size="24">paid on Stellar testnet · receipt attached</text></svg>`,
  );

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const input = Buffer.concat(chunks);
    const prompt = input.length ? String(JSON.parse(input.toString()).prompt ?? "") : "Hello";
    const port = server.address().port;
    const result = await handlePaidJob(
      (name) => req.headers[name.toLowerCase()],
      async () => ({
        jobId: `stellar-render-${Date.now()}`,
        inputSha256: [sha256Hex(input)],
        output: render(prompt),
        contentType: "image/svg+xml",
      }),
      {
        x402,
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            payTo: seller.publicKey(),
            price: "$0.01",
            maxTimeoutSeconds: 120,
          },
        ],
        resource: {
          url: `http://localhost:${port}/render`,
          description: "Render a title card",
          mimeType: "image/svg+xml",
        },
        seller: { ...sellerKey, name: "render.example (stellar)" },
        acceptance: { mode: "auto", reviewWindowSeconds: 0 },
        remedy: { kind: "rerender", withinDays: 30 },
      },
    );
    res.writeHead(result.status, result.headers).end(result.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/render`;
console.log("seller listening on", url);

// ─── Buyer agent ───────────────────────────────────────────────────────────
try {
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: NETWORK,
        client: new ExactStellarClient(createEd25519Signer(buyer.secret(), NETWORK)),
      },
    ],
  });
  const buy = createReceptumFetch({
    paidFetch,
    networks: [NETWORK], // what paidFetch is registered to pay on (required)
    allowedSellers: [sellerKey.did],
    expected: {
      network: NETWORK,
      asset: TESTNET_USDC_SAC,
      maxAmount: "100000", // 0.01 USDC
      payee: `${NETWORK}:${seller.publicKey()}`,
      payer: buyer.publicKey(),
    },
  });
  const result = await buy(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Know what you paid for." }),
  });
  console.log("client check:", result.check);
  console.log("settlement:", result.settlement?.transaction, "on", result.settlement?.network);

  const report = await verify(result.receipt, { file: result.body });
  for (const c of report.checks) console.log(`[${c.status}] L${c.level} ${c.name} — ${c.detail}`);
  // x402 cannot commit receiptHash on its rail, so without an anchor the best verdict is
  // PARTIALLY VERIFIED (SPEC §6); everything else, including the settlement, must pass.
  const payment = report.checks.find((c) => c.name.startsWith("Payment"));
  if (!report.ok || payment?.status !== "pass" || report.missing.some((m) => !/committed/.test(m)))
    throw new Error(`receipt did not verify: ${report.missing.join("; ")}`);
  console.log(report.verdict);

  const hash = result.settlement.transaction;
  const record = {
    network: NETWORK,
    facilitator: FACILITATOR,
    settlement: result.settlement,
    settlementUrl: explorerTxUrl(hash),
    signedReceipt: result.receipt,
    check: result.check,
    verify: {
      verdict: report.verdict,
      ok: report.ok,
      complete: report.complete,
      missing: report.missing,
      checks: report.checks,
    },
  };
  const json = JSON.stringify(record, null, 2);
  if (/\bS[A-Z2-7]{55}\b/.test(json)) throw new Error("refusing to write a secret");
  writeFileSync(join(here, "..", "x402-stellar-testnet.json"), json + "\n");
  writeFileSync(join(here, "..", "x402-stellar-testnet-output.svg"), result.body);
  const short = (h) => `[\`${h.slice(0, 12)}…\`](${explorerTxUrl(h)})`;
  writeSection(
    join(here, "..", "..", "packages", "adapter-stellar", "E2E_RESULTS.md"),
    "x402",
    [
      "## x402 exact on Stellar testnet",
      "",
      `Generated by \`examples/x402-stellar/e2e.mjs\` on ${new Date().toISOString()}. A local \`@receptum/server\` seller sold one render for **0.01 USDC** to a \`@receptum/client\` buyer over x402 \`exact\` on \`${NETWORK}\`; facilitator \`${FACILITATOR}\` (advertises \`${JSON.stringify(kind.extra)}\`, i.e. it pays the fees).`,
      "",
      "| | |",
      "| --- | --- |",
      `| Settlement (SAC \`transfer\` buyer → seller) | ${short(hash)} |`,
      `| Asset | testnet USDC, Stellar Asset Contract \`${result.receipt.receipt.payment.asset}\` |`,
      `| Payer → payee | \`${result.receipt.receipt.payment.payer}\` → \`${result.receipt.receipt.payment.payee}\` |`,
      `| receiptHash | \`${result.receipt.receiptHash}\` |`,
      `| Client check | ${result.check.ok ? "accepted" : "REJECTED"} (signature, output hash, settlement = receipt reference, seller allow-list, buyer expectations) |`,
      `| \`receptum-verify\` | **${report.verdict}** — ${payment.detail}${report.missing.length ? ` (missing: ${report.missing.join("; ")})` : ""} |`,
      "",
      "Files: `examples/x402-stellar-testnet.json` (settlement + signed receipt), `examples/x402-stellar-testnet-output.svg` (the delivered bytes).",
    ].join("\n"),
  );
  console.log("wrote examples/x402-stellar-testnet.json and the x402 section of E2E_RESULTS.md");
} finally {
  server.close();
}
