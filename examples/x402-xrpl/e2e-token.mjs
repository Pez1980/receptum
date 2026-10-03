// Paid HTTP job over x402 `exact` on XRPL TESTNET (xrpl:1, never mainnet) paid in an ISSUED TOKEN
// (a self-issued, RLUSD-style 40-hex currency), with a Receptum receipt (SPEC §7.3: payment.asset =
// `<currency>.<issuer>`, payment.amount = the value in integer 10^-15 units).
//
//   pnpm build && node examples/x402-xrpl/setup-wallets.mjs && node examples/x402-xrpl/setup-token.mjs
//   node examples/x402-xrpl/e2e-token.mjs
//
// The seller (`@receptum/server` handlePaidJob) prices a render at 0.25 RCPT and settles through
// the public facilitator https://x402.org/facilitator, which accepts issued currencies on xrpl:1
// (verified 2026-10-04). The buyer agent
// (`@receptum/client` over `@x402/fetch` + `@x402/xrpl`) caps the price in 10^-15 units. The receipt
// is anchored with XrplAnchor and checked with `@receptum/verify`.
//
// Keys: $RECEPTUM_WALLETS_DIR/xrpl-x402-testnet.json (buyer, seller), xrpl-token-testnet.json
// (issuer) and seller-ed25519.pem. Writes only public data: examples/x402-xrpl-token-testnet.json
// and examples/x402-xrpl-token-testnet-output.svg.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet } from "xrpl";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createXrplWalletSigner } from "@x402/xrpl";
import { ExactXrplScheme as ExactXrplClient } from "@x402/xrpl/exact/client";
import { ExactXrplScheme as ExactXrplServer } from "@x402/xrpl/exact/server";
import { sellerKeyFromPem, sha256Hex, xrplValueToUnits } from "@receptum/core";
import { handlePaidJob } from "@receptum/server";
import { createReceptumFetch } from "@receptum/client";
import { verify } from "@receptum/verify";
import { XrplAnchor, xrplBindingVerifier } from "@receptum/adapter-xrpl";

const NETWORK = "xrpl:1";
const WSS = "wss://s.altnet.rippletest.net:51233";
const FACILITATOR = "https://x402.org/facilitator";
const PRICE = "0.25"; // token value, as x402 writes it
const PRICE_UNITS = xrplValueToUnits(PRICE); // "250000000000000" — RRF v1 payment.amount
const explorer = (hash) => `https://testnet.xrpl.org/transactions/${hash}`;
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "xrpl-x402-testnet.json"), "utf8"));
const buyer = Wallet.fromSeed(wallets.buyer.seed);
const seller = Wallet.fromSeed(wallets.seller.seed);
const token = JSON.parse(readFileSync(join(here, "token-setup.json"), "utf8"));
const issuer = token.token.issuer;
const CURRENCY = token.token.currency;
const ASSET = token.asset; // `<40-hex>.<issuer>`
const tokenSecrets = JSON.parse(readFileSync(join(dir, "xrpl-token-testnet.json"), "utf8"));
const secrets = [
  wallets.buyer.seed,
  wallets.seller.seed,
  tokenSecrets.issuer.seed,
  tokenSecrets.evaluator.seed,
];
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));
const binding = JSON.parse(
  readFileSync(join(here, "..", "bindings", "xrpl-testnet-x402.json"), "utf8"),
);
if (binding.statement.account !== `${NETWORK}:${seller.classicAddress}`)
  throw new Error("examples/bindings/xrpl-testnet-x402.json is for another account");

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });

// The facilitator must advertise exact on xrpl:1.
const supported = await facilitator.getSupported();
const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
if (!kind) throw new Error(`${FACILITATOR} does not support exact on ${NETWORK}`);
console.log("facilitator", FACILITATOR, "supports", JSON.stringify(kind));

// ─── Seller ────────────────────────────────────────────────────────────────
const x402 = new x402ResourceServer(facilitator).register(NETWORK, new ExactXrplServer());
await x402.initialize();

const xrpl = new Client(WSS);
await xrpl.connect();
const anchor = new XrplAnchor({ client: xrpl, wallet: seller, network: NETWORK });
let anchored;

const render = (prompt) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#0F1115"/><text x="80" y="330" fill="#F7F5EF" font-family="sans-serif" font-size="56">${prompt.replace(/[<>&"]/g, "").slice(0, 80)}</text><text x="80" y="400" fill="#8A8F98" font-family="monospace" font-size="24">paid in an issued token on XRPL testnet · receipt attached</text></svg>`,
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
        jobId: `xrpl-token-render-${Date.now()}`,
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
            payTo: seller.classicAddress,
            // @x402/xrpl issued asset: currency code + extra.issuer, decimal value.
            price: { amount: PRICE, asset: CURRENCY, extra: { issuer } },
            maxTimeoutSeconds: 120,
          },
        ],
        resource: {
          url: `http://localhost:${port}/render`,
          description: "Render a title card",
          mimeType: "image/svg+xml",
        },
        seller: { ...sellerKey, name: "render.example (xrpl, issued token)" },
        acceptance: { mode: "auto", reviewWindowSeconds: 0 },
        remedy: { kind: "rerender", withinDays: 30 },
        anchor,
        bindings: [binding],
        bindingVerifiers: [xrplBindingVerifier],
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
console.log("seller listening on", url, "payTo", seller.classicAddress);

// ─── Buyer agent ───────────────────────────────────────────────────────────
try {
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactXrplClient(createXrplWalletSigner(buyer)) }],
    // A self-issued token isn't an x402 "default asset": opt in. x402's per-asset caps are atomic
    // integers and XRPL issued values are decimals, so the cap is Receptum's expected.maxAmount
    // in 10^-15 units (checked on the receipt) plus the selector below (checked before signing).
    spendControls: { allowedAssets: [{ network: NETWORK, asset: CURRENCY }] },
    paymentRequirementsSelector: (_version, accepts) => {
      const ok = accepts.find(
        (a) =>
          a.network === NETWORK &&
          a.asset === CURRENCY &&
          a.extra?.issuer === issuer &&
          BigInt(xrplValueToUnits(a.amount)) <= BigInt(PRICE_UNITS),
      );
      if (!ok) throw new Error("no acceptable payment option (asset, issuer or price)");
      return ok;
    },
  });
  const buy = createReceptumFetch({
    paidFetch,
    allowedSellers: [sellerKey.did],
    requireBinding: true,
    bindingVerifiers: [xrplBindingVerifier],
    expected: {
      network: NETWORK,
      asset: ASSET,
      maxAmount: PRICE_UNITS,
      payee: `${NETWORK}:${seller.classicAddress}`,
      payer: buyer.classicAddress,
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

  const report = await verify(result.receipt, { file: result.body, anchors: [anchorRef] });
  for (const c of report.checks) console.log(`[${c.status}] L${c.level} ${c.name} — ${c.detail}`);
  if (!report.complete) throw new Error("receipt did not fully verify");
  console.log("VERIFIED");

  const hash = result.settlement.transaction;
  const record = {
    network: NETWORK,
    facilitator: FACILITATOR,
    asset: { ...token.token, value: PRICE, units: PRICE_UNITS },
    facilitatorKind: kind,
    settlement: result.settlement,
    settlementUrl: explorer(hash),
    anchor: anchorRef,
    anchorUrl: explorer(anchored.reference),
    signedReceipt: result.receipt,
    check: result.check,
    verify: { ok: report.ok, complete: report.complete, checks: report.checks },
  };
  const json = JSON.stringify(record, null, 2);
  if (secrets.some((s) => json.includes(s))) throw new Error("refusing to write a secret");
  writeFileSync(join(here, "..", "x402-xrpl-token-testnet.json"), json + "\n");
  writeFileSync(join(here, "..", "x402-xrpl-token-testnet-output.svg"), result.body);
  console.log(
    "wrote examples/x402-xrpl-token-testnet.json and examples/x402-xrpl-token-testnet-output.svg",
  );
  console.log("settlement", explorer(hash));
  console.log("anchor    ", explorer(anchored.reference));
} finally {
  server.close();
  await xrpl.disconnect();
}
