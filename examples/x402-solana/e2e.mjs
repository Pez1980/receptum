// Paid HTTP job over x402 `exact` on Solana DEVNET (never mainnet), with a Receptum receipt.
//
//   pnpm build && node examples/x402-solana/e2e.mjs
//
// Starts a local seller (`@receptum/server` handlePaidJob, facilitator https://x402.org/facilitator,
// which advertises exact on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 and pays the fees as
// `extra.feePayer`), buys one job as an agent (`@receptum/client` over `@x402/fetch` +
// `@x402/svm`) paying 0.01 devnet USDC, anchors the receipt hash with SolanaAnchor (an SPL Memo
// `receptum/1:<receiptHash>` from the seller) and checks everything with `@receptum/verify`:
// signature, seller ↔ payee binding, the transferChecked to the payee and the anchor.
//
// Keys: $RECEPTUM_WALLETS_DIR/solana-devnet-{buyer,seller}.json and seller-ed25519.pem. The
// buyer needs devnet USDC (https://faucet.circle.com), the seller a little SOL for the anchor fee
// and its USDC token account. Writes only public data: examples/x402-solana-devnet.json, the
// delivered SVG, examples/bindings/solana-devnet.json and a section of E2E_RESULTS.md.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactSvmScheme as ExactSvmClient } from "@x402/svm/exact/client";
import { ExactSvmScheme as ExactSvmServer } from "@x402/svm/exact/server";
import { sha256Hex } from "@receptum/core";
import { handlePaidJob } from "@receptum/server";
import { createReceptumFetch } from "@receptum/client";
import { verify } from "@receptum/verify";
import {
  DEVNET_USDC_MINT,
  explorerTxUrl,
  SolanaAnchor,
  solanaBindingVerifier,
} from "@receptum/adapter-solana";
import {
  assertNoSecrets,
  ensureUsdcAccount,
  loadKeypair,
  NETWORK,
  rpc,
  sellerBinding,
  sellerKey as loadSellerKey,
  tokenBalance,
  walletsDir,
  writeSection,
} from "../../packages/adapter-solana/scripts/devnet-common.mjs";

const FACILITATOR = "https://x402.org/facilitator";
const PRICE = "10000"; // 0.01 USDC (6 decimals)
const here = dirname(fileURLToPath(import.meta.url));
const buyer = loadKeypair("buyer");
const seller = loadKeypair("seller");
const buyerSigner = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(join(walletsDir, "solana-devnet-buyer.json"), "utf8"))),
);
if (buyerSigner.address !== buyer.address) throw new Error("buyer keypair mismatch");
const sellerKey = loadSellerKey();
const binding = await sellerBinding(seller);

// The facilitator must advertise exact on Solana devnet.
const supported = await (await fetch(`${FACILITATOR}/supported`)).json();
const kind = supported.kinds.find(
  (k) => k.scheme === "exact" && k.network === NETWORK && k.x402Version === 2,
);
if (!kind) throw new Error(`${FACILITATOR} does not support exact on ${NETWORK}`);
console.log("facilitator supports", JSON.stringify(kind));

// The x402 exact client pays into the seller's associated token account; it must exist.
const created = await ensureUsdcAccount(seller, seller.address);
if (created) console.log("created the seller's USDC token account:", created);
const before = await tokenBalance(buyer.address);
if (before === null || before < BigInt(PRICE))
  throw new Error("the buyer needs devnet USDC first (https://faucet.circle.com, Solana Devnet)");

// ─── Seller ────────────────────────────────────────────────────────────────
const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(
  NETWORK,
  new ExactSvmServer(),
);
await x402.initialize();
const anchor = new SolanaAnchor({ network: NETWORK, rpc, signer: seller });
let anchored;

const render = (prompt) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#0F1115"/><text x="80" y="330" fill="#F7F5EF" font-family="sans-serif" font-size="56">${prompt.replace(/[<>&"]/g, "").slice(0, 80)}</text><text x="80" y="400" fill="#8A8F98" font-family="monospace" font-size="24">paid on Solana devnet · receipt attached</text></svg>`,
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
        jobId: `solana-render-${Date.now()}`,
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
            payTo: seller.address,
            price: { amount: PRICE, asset: DEVNET_USDC_MINT },
            maxTimeoutSeconds: 120,
          },
        ],
        resource: {
          url: `http://localhost:${port}/render`,
          description: "Render a title card",
          mimeType: "image/svg+xml",
        },
        seller: { ...sellerKey, name: "render.example (solana)" },
        acceptance: { mode: "auto", reviewWindowSeconds: 0 },
        remedy: { kind: "rerender", withinDays: 30 },
        anchor,
        bindings: [binding],
        bindingVerifiers: [solanaBindingVerifier],
      },
    );
    if (result.anchor) anchored = result.anchor;
    res.writeHead(result.status, result.headers).end(result.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/render`;
console.log("seller listening on", url, "payTo", seller.address);

// ─── Buyer agent ───────────────────────────────────────────────────────────
try {
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactSvmClient(buyerSigner) }],
  });
  const buy = createReceptumFetch({
    paidFetch,
    networks: [NETWORK], // what paidFetch is registered to pay on (required)
    allowedSellers: [sellerKey.did],
    requireBinding: true,
    bindingVerifiers: [solanaBindingVerifier],
    expected: {
      network: NETWORK,
      asset: DEVNET_USDC_MINT,
      maxAmount: PRICE,
      payee: `${NETWORK}:${seller.address}`,
      payer: buyer.address,
    },
  });
  const result = await buy(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Know what you paid for." }),
  });
  console.log("client check:", result.check);
  console.log("settlement:", result.settlement?.transaction, "on", result.settlement?.network);
  if (!anchored) throw new Error("receipt was not anchored");
  const anchorRef = `${NETWORK}:${anchored.reference}`;
  console.log("anchor:", anchorRef);

  // Wait for both transactions to be finalized before the published verification.
  await new Promise((r) => setTimeout(r, 20_000));
  const report = await verify(result.receipt, { file: result.body, anchors: [anchorRef] });
  for (const c of report.checks) console.log(`[${c.status}] L${c.level} ${c.name} — ${c.detail}`);
  if (!report.complete) throw new Error(`receipt did not fully verify: ${report.missing}`);
  console.log(report.verdict);

  const hash = result.settlement.transaction;
  const record = {
    network: NETWORK,
    facilitator: FACILITATOR,
    facilitatorKind: kind,
    settlement: result.settlement,
    settlementUrl: explorerTxUrl(hash),
    anchor: anchorRef,
    anchorUrl: explorerTxUrl(anchored.reference),
    signedReceipt: result.receipt,
    check: result.check,
    verify: {
      verdict: report.verdict,
      ok: report.ok,
      complete: report.complete,
      checks: report.checks,
    },
  };
  const json = JSON.stringify(record, null, 2) + "\n";
  assertNoSecrets(json);
  writeFileSync(join(here, "..", "x402-solana-devnet.json"), json);
  writeFileSync(join(here, "..", "x402-solana-devnet-output.svg"), result.body);
  const payment = report.checks.find((c) => c.name.startsWith("Payment"));
  const short = (h) => `[\`${h.slice(0, 12)}…\`](${explorerTxUrl(h)})`;
  writeSection(
    join(here, "..", "..", "packages", "adapter-solana", "E2E_RESULTS.md"),
    "x402",
    [
      "## x402 exact on Solana devnet",
      "",
      `Generated by \`examples/x402-solana/e2e.mjs\` on ${new Date().toISOString()}. A local \`@receptum/server\` seller sold one render for **0.01 devnet USDC** to a \`@receptum/client\` buyer over x402 \`exact\` (\`@x402/svm\` 2.28) on \`${NETWORK}\`; facilitator \`${FACILITATOR}\` (fee payer \`${kind.extra.feePayer}\`). The seller anchored the receipt with an SPL Memo.`,
      "",
      "| | |",
      "| --- | --- |",
      `| Settlement (\`transferChecked\` buyer → seller) | ${short(hash)} |`,
      `| Anchor (SPL Memo \`receptum/1:<receiptHash>\`) | ${short(anchored.reference)} |`,
      `| Asset | devnet USDC, mint \`${DEVNET_USDC_MINT}\` |`,
      `| Payer → payee | \`${result.receipt.receipt.payment.payer}\` → \`${result.receipt.receipt.payment.payee}\` |`,
      `| receiptHash | \`${result.receipt.receiptHash}\` |`,
      `| Client check | ${result.check.ok ? "accepted" : "REJECTED"} (signature, output hash, settlement = receipt reference, seller allow-list, binding, buyer expectations) |`,
      `| \`receptum-verify\` | **${report.verdict}** — ${payment.detail} |`,
      "",
      "Files: `examples/x402-solana-devnet.json` (settlement + signed receipt + anchor), `examples/x402-solana-devnet-output.svg` (the delivered bytes), `examples/bindings/solana-devnet.json` (seller binding).",
    ].join("\n"),
  );
  console.log("wrote examples/x402-solana-devnet.json and the x402 section of E2E_RESULTS.md");
} finally {
  server.close();
}
