// End-to-end run of @receptum/adapter-xrpl on the XRPL TESTNET. Not run in CI.
//
//   pnpm --filter @receptum/adapter-xrpl build && node packages/adapter-xrpl/scripts/e2e-testnet.mjs
//
// Wallets and the seller key live OUTSIDE the repo, in $RECEPTUM_WALLETS_DIR
// (default ~/.config/receptum/wallets, dir 0700, files 0600). Only public data
// (addresses, tx hashes, receipts) is printed and written to E2E_RESULTS.md, the published
// receipts examples/xrpl-testnet-escrow-{a,c}.json (with the seller binding of
// examples/bindings/xrpl-testnet.json, matched on the payee) and their synthetic delivered bytes
// examples/deliverables/xrpl-testnet-escrow-{a,c}.txt. Every released escrow must be VERIFIED.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createReceipt,
  generateSellerKey,
  sellerKeyFromPem,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
} from "@receptum/core";
import { AccountSetAsfFlags, Client, isoTimeToRippleTime, Wallet } from "xrpl";
import {
  caip10,
  currencyCode,
  newEscrowSecret,
  XrplAnchor,
  XrplEscrowRail,
} from "../dist/index.js";
import { verify } from "../../verify/dist/index.js";

const TESTNET = "wss://s.altnet.rippletest.net:51233";
const NETWORK = "xrpl:1";
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"; // Ripple's RLUSD testnet issuer
const TOKEN = "RCT"; // self-issued test token for the TokenEscrow path
const EXAMPLES = new URL("../../../examples/", import.meta.url);
const BINDINGS = ["xrpl-testnet.json"].map((n) =>
  JSON.parse(readFileSync(new URL(`bindings/${n}`, EXAMPLES), "utf8")),
);

// ─── secrets: outside the repo, owner-only ─────────────────────────────────

const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config", "receptum", "wallets");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

function secretFile(name, create) {
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, create(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return readFileSync(path, "utf8");
}

const seeds = JSON.parse(
  secretFile("xrpl-testnet.json", () =>
    JSON.stringify(
      {
        network: "testnet",
        buyer: Wallet.generate().seed,
        seller: Wallet.generate().seed,
        issuer: Wallet.generate().seed,
      },
      null,
      2,
    ),
  ),
);
const buyer = Wallet.fromSeed(seeds.buyer);
const seller = Wallet.fromSeed(seeds.seller);
const issuer = Wallet.fromSeed(seeds.issuer);
const sellerKey = sellerKeyFromPem(
  secretFile("seller-ed25519.pem", () => generateSellerKey().privateKeyPem),
);

// ─── helpers ───────────────────────────────────────────────────────────────

const log = [];
const step = (label, hash) => {
  log.push({ label, hash });
  console.log(`  ${label}: ${EXPLORER}${hash}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, msg) => {
  if (!ok) throw new Error(`assertion failed: ${msg}`);
};
async function expectError(promise, label) {
  try {
    await promise;
  } catch (err) {
    console.log(`  (expected) ${label}: ${err.message}`);
    return err.message;
  }
  throw new Error(`expected failure: ${label}`);
}
async function submit(client, wallet, tx) {
  const res = await client.submitAndWait(tx, { wallet, autofill: true });
  assert(res.result.meta.TransactionResult === "tesSUCCESS", res.result.meta.TransactionResult);
  return res.result.hash;
}
const closeTime = async (client) =>
  (await client.request({ command: "ledger", ledger_index: "validated" })).result.ledger.close_time;

function makeReceipt(handle, jobId, reviewWindowSeconds) {
  const output = `output for ${jobId} ${randomBytes(8).toString("hex")}`;
  const receipt = createReceipt({
    jobId,
    seller: { id: sellerKey.did, name: "receptum e2e seller" },
    buyer: { id: caip10(NETWORK, handle.buyer) },
    inputSha256: [sha256Hex(`input for ${jobId}`)],
    outputSha256: sha256Hex(output),
    payment: {
      rail: handle.rail,
      network: handle.network,
      asset: handle.asset,
      amount: handle.amount,
      reference: handle.escrowId,
      payer: caip10(NETWORK, handle.buyer),
      payee: caip10(NETWORK, handle.seller),
    },
    acceptance: { mode: "buyer", reviewWindowSeconds },
  });
  const signed = signReceipt(receipt, sellerKey);
  // The seller binding sits outside the hashed receipt (SPEC §4.1).
  const binding = BINDINGS.find((b) => b.statement.account === receipt.payment.payee);
  return { signed: binding ? { ...signed, bindings: [binding] } : signed, output };
}

/** create → deliver → buyer verifies and hands over the fulfillment → seller releases. */
async function releaseFlow(client, name, params) {
  const secret = newEscrowSecret();
  const accepted = new Map();
  const buyerRail = new XrplEscrowRail({ client, wallet: buyer, network: NETWORK });
  const sellerRail = new XrplEscrowRail({
    client,
    wallet: seller,
    network: NETWORK,
    fulfillment: (id) => accepted.get(id),
  });

  const handle = await buyerRail.createEscrow({
    ...params,
    seller: seller.address,
    condition: secret.condition,
  });
  step(`${name} EscrowCreate (${handle.escrowId})`, handle.reference);
  assert((await buyerRail.getEscrow(handle.escrowId)).status === "open", "open");
  await expectError(sellerRail.release(handle.escrowId), `${name} release before acceptance`);

  const { signed, output } = makeReceipt(handle, `${name}-job`, params.reviewWindowSeconds);
  const delivered = await sellerRail.deliver(handle.escrowId, signed.receiptHash);
  step(`${name} deliver (receipt memo)`, delivered.reference);

  // Buyer side: verify the receipt offline and its commitment on-chain, then accept.
  const state = await buyerRail.getEscrow(handle.escrowId);
  assert(state.status === "delivered", "delivered");
  assert(state.receiptHash === signed.receiptHash, "on-chain receiptHash matches");
  assert(verifySignedReceipt(signed).ok, "seller signature verifies");
  accepted.set(handle.escrowId, secret.fulfillment);

  const released = await sellerRail.release(handle.escrowId);
  step(`${name} EscrowFinish (release)`, released.reference);
  const final = await buyerRail.getEscrow(handle.escrowId);
  assert(final.status === "released" && final.receiptHash === signed.receiptHash, "released");
  // Delivered bytes (not a path) + seller binding + the escrow's own commitment: VERIFIED.
  const report = await verify(signed, { file: new TextEncoder().encode(output) });
  assert(
    report.verdict === "VERIFIED",
    `${name} VERIFIED, got ${report.verdict}: ${report.missing.join("; ")}`,
  );
  console.log(`  ${name}: receptum-verify ${report.verdict}`);
  return { handle, signed, output, report, delivered, released, final };
}

// ─── run ───────────────────────────────────────────────────────────────────

const client = new Client(TESTNET);
await client.connect();
try {
  const info = (await client.request({ command: "server_info" })).result.info;
  assert(info.network_id === 1, "connected to XRPL testnet (NetworkID 1) — refusing anything else");
  const features = (await client.request({ command: "feature" })).result.features;
  const tokenEscrow = Object.values(features).find((f) => f.name === "TokenEscrow");
  const rlusd = await client.request({
    command: "account_info",
    account: RLUSD_ISSUER,
    ledger_index: "validated",
  });
  const rlusdLocking = rlusd.result.account_flags.allowTrustLineLocking;
  console.log(
    `TokenEscrow enabled: ${tokenEscrow?.enabled}; RLUSD issuer allowTrustLineLocking: ${rlusdLocking}`,
  );

  console.log("Funding wallets from the testnet faucet…");
  for (const w of [buyer, seller, issuer]) await client.fundWallet(w);
  console.log(`  buyer ${buyer.address}\n  seller ${seller.address}\n  issuer ${issuer.address}`);

  // Dry-run (simulate — nothing is submitted) an RLUSD escrow to record what the ledger says.
  const rlusdProbe = await client.simulate(
    await client.autofill({
      TransactionType: "EscrowCreate",
      Account: buyer.address,
      Destination: seller.address,
      Amount: { currency: currencyCode("RLUSD"), issuer: RLUSD_ISSUER, value: "1" },
      CancelAfter: isoTimeToRippleTime(new Date(Date.now() + 600_000).toISOString()),
      Condition: newEscrowSecret().condition,
    }),
  );
  const rlusdResult = rlusdProbe.result.engine_result;
  console.log(`  simulated RLUSD EscrowCreate: ${rlusdResult}`);

  // Escrow B (refund) first so its clock runs while A and C settle.
  console.log("B: XRP escrow, no delivery → refund after CancelAfter");
  const secretB = newEscrowSecret();
  const buyerRail = new XrplEscrowRail({ client, wallet: buyer, network: NETWORK });
  const handleB = await buyerRail.createEscrow({
    seller: seller.address,
    amount: "1000000",
    asset: "XRP",
    deliverBy: new Date(Date.now() + 60_000),
    reviewWindowSeconds: 60,
    condition: secretB.condition,
  });
  step(`B EscrowCreate (${handleB.escrowId})`, handleB.reference);
  console.log(`  refundableAfter ${handleB.refundableAfter}`);
  await expectError(buyerRail.refund(handleB.escrowId), "B refund before CancelAfter");

  console.log("A: XRP escrow → deliver → release");
  const a = await releaseFlow(client, "A", {
    amount: "2000000",
    asset: "XRP",
    deliverBy: new Date(Date.now() + 600_000),
    reviewWindowSeconds: 600,
  });

  console.log("Anchor: standalone receipt-hash anchor (anchor:xrpl)");
  const anchor = new XrplAnchor({ client, wallet: seller, network: NETWORK });
  const anchored = await anchor.anchor(a.signed.receiptHash);
  step("anchor AccountSet (receipt memo)", anchored.reference);
  const byRef = await anchor.find(a.signed.receiptHash, { reference: anchored.reference });
  const byScan = await new XrplAnchor({ client, account: seller.address }).find(
    a.signed.receiptHash,
  );
  const deliverFound = await anchor.find(a.signed.receiptHash, {
    reference: a.delivered.reference,
  });
  assert(byRef?.reference === anchored.reference, "find by reference");
  assert(byScan !== null, "find by account scan");
  assert(deliverFound?.reference === a.delivered.reference, "delivery memo is a valid anchor");
  assert(
    (await anchor.find(sha256Hex("not anchored"), { reference: anchored.reference })) === null,
    "wrong hash is not found",
  );

  console.log(`C: issued-token escrow (${TOKEN}, TokenEscrow) → deliver → release`);
  const flagTx = await submit(client, issuer, {
    TransactionType: "AccountSet",
    Account: issuer.address,
    SetFlag: AccountSetAsfFlags.asfAllowTrustLineLocking,
  });
  step("C issuer AccountSet asfAllowTrustLineLocking", flagTx);
  const currency = currencyCode(TOKEN);
  for (const [who, w] of [
    ["buyer", buyer],
    ["seller", seller],
  ]) {
    const h = await submit(client, w, {
      TransactionType: "TrustSet",
      Account: w.address,
      LimitAmount: { currency, issuer: issuer.address, value: "1000000" },
    });
    step(`C ${who} TrustSet ${TOKEN}`, h);
  }
  const issueTx = await submit(client, issuer, {
    TransactionType: "Payment",
    Account: issuer.address,
    Destination: buyer.address,
    Amount: { currency, issuer: issuer.address, value: "100" },
  });
  step(`C issuer pays buyer 100 ${TOKEN}`, issueTx);
  const c = await releaseFlow(client, "C", {
    amount: "5000000000000000", // 5 tokens in 10^-15 units (SPEC §7.3)
    asset: `${TOKEN}.${issuer.address}`,
    deliverBy: new Date(Date.now() + 600_000),
    reviewWindowSeconds: 600,
  });

  console.log("B: waiting for the ledger close time to pass CancelAfter…");
  const stateB = await buyerRail.getEscrow(handleB.escrowId);
  assert(stateB.status === "open", "B still open");
  const cancelAfter = isoTimeToRippleTime(handleB.refundableAfter);
  while ((await closeTime(client)) <= cancelAfter) await sleep(5_000);
  const refunded = await buyerRail.refund(handleB.escrowId);
  step("B EscrowCancel (refund)", refunded.reference);
  const finalB = await buyerRail.getEscrow(handleB.escrowId);
  assert(finalB.status === "refunded", "refunded");
  await expectError(
    new XrplEscrowRail({
      client,
      wallet: seller,
      network: NETWORK,
      fulfillment: () => secretB.fulfillment,
    }).release(handleB.escrowId),
    "B release after refund",
  );

  // ─── public results ───────────────────────────────────────────────────────
  const rows = log.map(({ label, hash }) => `| ${label} | [\`${hash}\`](${EXPLORER}${hash}) |`);
  const md = `# adapter-xrpl — testnet E2E results

Generated by \`scripts/e2e-testnet.mjs\` on ${new Date().toISOString()} against \`${TESTNET}\`
(rippled ${info.build_version}, NetworkID ${info.network_id}). Public data only — no seeds or keys.

## Network facts

- \`TokenEscrow\` amendment enabled on testnet: **${tokenEscrow?.enabled}**
- RLUSD testnet issuer \`${RLUSD_ISSUER}\` has \`allowTrustLineLocking\`: **${rlusdLocking}**
- Simulated (not submitted) RLUSD EscrowCreate from the buyer: **\`${rlusdResult}\`**
${
  rlusdLocking
    ? ""
    : "\nRLUSD cannot be escrowed natively on testnet until its issuer sets `asfAllowTrustLineLocking`. The issued-token (TokenEscrow) path is proven below with a self-issued test token instead.\n"
}

## Accounts

| Role | Address |
| --- | --- |
| Buyer | \`${buyer.address}\` |
| Seller | \`${seller.address}\` |
| Test-token issuer | \`${issuer.address}\` |
| Seller signing key | \`${sellerKey.did}\` |

## Transactions

| Step | Transaction |
| --- | --- |
${rows.join("\n")}

## Final escrow states

\`\`\`json
${JSON.stringify({ A: a.final, B: finalB, C: c.final }, null, 2)}
\`\`\`

## Signed receipts

Every released escrow was re-verified with \`@receptum/verify\` from the delivered bytes and the seller binding: A **${a.report.verdict}**, C **${c.report.verdict}**. Published as \`examples/xrpl-testnet-escrow-a.json\` and \`examples/xrpl-testnet-escrow-c.json\` (deliverables in \`examples/deliverables/\`).

Escrow A (XRP), receiptHash \`${a.signed.receiptHash}\`:

\`\`\`json
${JSON.stringify(a.signed, null, 2)}
\`\`\`

Escrow C (${TOKEN} via TokenEscrow, 5 tokens = \`${c.signed.receipt.payment.amount}\` units of 10^-15), receiptHash \`${c.signed.receiptHash}\`:

\`\`\`json
${JSON.stringify(c.signed, null, 2)}
\`\`\`
`;
  // Keep the later sections (evaluator mode, TokenEscrow) written by e2e-evaluator-token.mjs.
  const path = new URL("../E2E_RESULTS.md", import.meta.url);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const keep = previous.indexOf("\n## Evaluator mode");
  const text = md + (keep >= 0 ? previous.slice(keep) : "");
  for (const secret of [seeds.buyer, seeds.seller, seeds.issuer])
    assert(!text.includes(secret), "results must not contain a seed");
  writeFileSync(path, text);
  for (const [k, flow] of [
    ["a", a],
    ["c", c],
  ]) {
    writeFileSync(
      new URL(`xrpl-testnet-escrow-${k}.json`, EXAMPLES),
      JSON.stringify(flow.signed, null, 2) + "\n",
    );
    writeFileSync(new URL(`deliverables/xrpl-testnet-escrow-${k}.txt`, EXAMPLES), flow.output);
  }
  console.log("All checks passed. Wrote packages/adapter-xrpl/E2E_RESULTS.md");
} finally {
  await client.disconnect();
}
