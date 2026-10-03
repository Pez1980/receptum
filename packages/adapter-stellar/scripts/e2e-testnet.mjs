#!/usr/bin/env node
// End-to-end run of @receptum/adapter-stellar on Stellar TESTNET (never mainnet).
// Not part of CI. Usage:
//   pnpm --filter @receptum/adapter-stellar build
//   node packages/adapter-stellar/scripts/e2e-testnet.mjs
//
// Keys live outside the repo in $RECEPTUM_WALLETS_DIR (default ~/.config/receptum/wallets):
//   stellar-testnet.json   buyer + seller testnet keypairs (created on first run, mode 600)
//   seller-ed25519.pem     seller receipt-signing key (shared with other adapters' scripts)
// Public results (no secrets) are written to packages/adapter-stellar/E2E_RESULTS.md and
// e2e-claimable-results.json; the synthetic delivered bytes go to
// examples/deliverables/stellar-claimable-<flow>.txt so the receipts verify at level 1.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Horizon, Keypair, Operation } from "@stellar/stellar-sdk";
import {
  createReceipt,
  generateSellerKey,
  sellerKeyFromPem,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
} from "@receptum/core";
import {
  HorizonClient,
  STELLAR_ESCROW_RAIL,
  STELLAR_TESTNET,
  StellarAnchor,
  StellarClaimableEscrowRail,
  TESTNET_USDC_ISSUER,
  caip10,
  escrowIdToStrKey,
  explorerTxUrl,
  keypairSigner,
} from "../dist/index.js";
import { verify } from "../../verify/dist/index.js";
import { assertNoSecrets, writeSection } from "./testnet-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DELIVERABLES = join(here, "..", "..", "..", "examples", "deliverables");
// Public seller bindings (examples/bindings), matched on the receipt's payee.
const BINDINGS = ["stellar-testnet.json"].map((n) =>
  JSON.parse(readFileSync(join(here, "..", "..", "..", "examples", "bindings", n), "utf8")),
);
const walletsDir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const horizon = new Horizon.Server(STELLAR_TESTNET.horizonUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ─── Keys (outside the repo, never printed) ─────────────────────────────────

function ensureWalletsDir() {
  mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
  chmodSync(walletsDir, 0o700);
}

/** Creates `path` atomically with mode 600, or returns the existing content. */
function createOrRead(path, make, parse) {
  if (!existsSync(path)) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, make(), { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path); // atomic; fails with EEXIST if another process won the race
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    } finally {
      unlinkSync(tmp);
    }
  }
  chmodSync(path, 0o600);
  return parse(readFileSync(path, "utf8"));
}

function loadWallets() {
  return createOrRead(
    join(walletsDir, "stellar-testnet.json"),
    () => {
      const kp = () => {
        const k = Keypair.random();
        return { publicKey: k.publicKey(), secret: k.secret() };
      };
      return JSON.stringify(
        { network: "stellar:testnet", note: "TESTNET ONLY", buyer: kp(), seller: kp() },
        null,
        2,
      );
    },
    (text) => {
      const w = JSON.parse(text);
      return {
        buyer: Keypair.fromSecret(w.buyer.secret),
        seller: Keypair.fromSecret(w.seller.secret),
      };
    },
  );
}

function loadSellerReceiptKey() {
  return createOrRead(
    join(walletsDir, "seller-ed25519.pem"),
    () => generateSellerKey().privateKeyPem,
    (pem) => sellerKeyFromPem(pem),
  );
}

// ─── Testnet funding ────────────────────────────────────────────────────────

async function fund(kp) {
  try {
    await horizon.loadAccount(kp.publicKey());
    return "existing";
  } catch {
    const res = await fetch(`${STELLAR_TESTNET.friendbotUrl}?addr=${kp.publicKey()}`);
    if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
    return "friendbot";
  }
}

const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);
const usdcBalance = async (address) => {
  const acct = await horizon.loadAccount(address);
  const line = acct.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER,
  );
  return line ? line.balance : null;
};

/** Trustlines for both parties; the buyer buys testnet USDC with XLM on the testnet DEX. */
async function setUpUsdc(client, buyer, seller, need) {
  const txs = [];
  for (const kp of [buyer, seller]) {
    if ((await usdcBalance(kp.publicKey())) === null) {
      const { hash } = await client.submit(keypairSigner(kp), [
        Operation.changeTrust({ asset: usdc }),
      ]);
      txs.push({ step: `USDC trustline (${kp === buyer ? "buyer" : "seller"})`, hash });
    }
  }
  if (Number(await usdcBalance(buyer.publicKey())) < need) {
    const { hash } = await client.submit(keypairSigner(buyer), [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "100",
        destination: buyer.publicKey(),
        destAsset: usdc,
        destAmount: String(need),
        path: [],
      }),
    ]);
    txs.push({ step: `buyer buys ${need} testnet USDC with XLM (DEX path payment)`, hash });
  }
  return txs;
}

// ─── Receipts ───────────────────────────────────────────────────────────────

function buildSignedReceipt(sellerKey, escrow, mode, label) {
  const output = `rendered output for ${label} ${randomBytes(8).toString("hex")}`;
  const receipt = createReceipt({
    jobId: `e2e-${label}-${randomBytes(6).toString("hex")}`,
    seller: { id: sellerKey.did, name: "receptum e2e seller" },
    buyer: { id: caip10(escrow.buyer) },
    inputSha256: [sha256Hex(`input for ${label}`)],
    outputSha256: sha256Hex(output),
    payment: {
      rail: STELLAR_ESCROW_RAIL,
      network: STELLAR_TESTNET.caip2,
      asset: escrow.asset,
      amount: escrow.amount,
      reference: escrow.escrowId,
      payer: caip10(escrow.buyer),
      payee: caip10(escrow.seller),
    },
    acceptance: { mode, reviewWindowSeconds: escrow.reviewWindowSeconds },
    remedy: { kind: "rerender", withinDays: 7 },
  });
  const signed = signReceipt(receipt, sellerKey);
  const check = verifySignedReceipt(signed);
  if (!check.ok) throw new Error(`receipt does not verify: ${check.reason}`);
  // The binding sits outside the hashed receipt (SPEC §4.1): attaching it changes no hash.
  const binding = BINDINGS.find((b) => b.statement.account === receipt.payment.payee);
  return { signed: binding ? { ...signed, bindings: [binding] } : signed, output };
}

const until = async (iso, extraSeconds, why) => {
  const ms = Date.parse(iso) + extraSeconds * 1000 - Date.now();
  if (ms > 0) {
    log(`waiting ${Math.ceil(ms / 1000)}s ${why}`);
    await sleep(ms);
  }
};

async function expectFailure(label, fn) {
  try {
    const r = await fn();
    throw new Error(`${label}: expected failure but got ${JSON.stringify(r)}`);
  } catch (err) {
    if (String(err.message).startsWith(`${label}: expected failure`)) throw err;
    log(`ok (expected failure) ${label}: ${err.message}${err.hash ? ` (tx ${err.hash})` : ""}`);
    return { message: err.message, hash: err.hash };
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main() {
  ensureWalletsDir();
  const { buyer, seller } = loadWallets();
  const sellerKey = loadSellerReceiptKey();
  log("buyer ", buyer.publicKey());
  log("seller", seller.publicKey());
  log("seller receipt key", sellerKey.did);

  const funding = { buyer: await fund(buyer), seller: await fund(seller) };
  const client = new HorizonClient();
  let asset = "native";
  let assetNote = "native XLM";
  let setupTxs = [];
  try {
    setupTxs = await setUpUsdc(client, buyer, seller, 5);
    asset = `USDC:${TESTNET_USDC_ISSUER}`;
    assetNote = `Circle testnet USDC (${asset})`;
  } catch (err) {
    log(`could not obtain testnet USDC, falling back to XLM: ${err.message}`);
  }
  log(`asset: ${assetNote}`);

  const buyerRail = new StellarClaimableEscrowRail({ signer: keypairSigner(buyer), asset });
  const sellerRail = new StellarClaimableEscrowRail({ signer: keypairSigner(seller), asset });
  const amount = "10000000"; // 1.0000000 units

  // Four escrows sharing one deadline: auto-release, buyer acceptance, refund, rejection.
  const deadline = new Date(Date.now() + 90_000);
  const scenarios = [
    { label: "auto-release", mode: "auto", reviewWindowSeconds: 60 },
    { label: "buyer-acceptance", mode: "buyer", reviewWindowSeconds: 120 },
    { label: "refund", mode: "auto", reviewWindowSeconds: 120 },
    { label: "reject", mode: "buyer", reviewWindowSeconds: 120 },
  ];
  const results = {};
  for (const s of scenarios) {
    const escrow = await buyerRail.open({
      seller: seller.publicKey(),
      amount,
      deadline,
      reviewWindowSeconds: s.reviewWindowSeconds,
    });
    escrow.reviewWindowSeconds = s.reviewWindowSeconds;
    results[s.label] = {
      scenario: s,
      escrow,
      txs: [{ step: "buyer opens escrow", hash: escrow.reference }],
    };
    log(`${s.label}: opened ${escrow.escrowId} (tx ${escrow.reference})`);
  }

  const A = results["auto-release"];
  const B = results["buyer-acceptance"];
  const C = results.refund;
  const D = results.reject;

  // Negative checks before the deadline.
  const negatives = [];
  negatives.push({
    check: "seller release before the review window (client guard)",
    error: await expectFailure("seller release early", () => sellerRail.release(A.escrow.escrowId)),
  });
  negatives.push({
    check: "buyer refund before the deadline (client guard)",
    error: await expectFailure("buyer refund early", () => buyerRail.refund(C.escrow.escrowId)),
  });
  // On-chain: bypass the client and submit raw claims — the predicates must reject them.
  negatives.push({
    check: "raw ClaimClaimableBalance by the buyer before the deadline (on-chain predicate)",
    error: await expectFailure("raw buyer claim before deadline", () =>
      client.submit(keypairSigner(buyer), [
        Operation.claimClaimableBalance({ balanceId: A.escrow.escrowId }),
      ]),
    ),
  });
  negatives.push({
    check:
      "raw ClaimClaimableBalance by the seller before the review window ends (on-chain predicate)",
    error: await expectFailure("raw seller claim before review window", () =>
      client.submit(keypairSigner(seller), [
        Operation.claimClaimableBalance({ balanceId: B.escrow.escrowId }),
      ]),
    ),
  });

  // Seller delivers A, B and D with signed receipts (MEMO_HASH = receiptHash).
  for (const r of [A, B, D]) {
    ({ signed: r.signed, output: r.output } = buildSignedReceipt(
      sellerKey,
      r.escrow,
      r.scenario.mode,
      r.scenario.label,
    ));
    const { reference } = await sellerRail.deliver(r.escrow.escrowId, r.signed.receiptHash);
    r.txs.push({ step: "seller delivers (MEMO_HASH = receiptHash + data entry)", hash: reference });
    r.deliverTx = reference;
    log(`${r.scenario.label}: delivered ${r.signed.receiptHash} (tx ${reference})`);
  }
  negatives.push({
    check: "buyer refund of a delivered escrow (client guard; reject() is the explicit path)",
    error: await expectFailure("refund delivered", async () => {
      await until(deadline.toISOString(), 8, "for the delivery deadline");
      return buyerRail.refund(B.escrow.escrowId);
    }),
  });

  // After the deadline: buyer accepts B and refunds C.
  await until(deadline.toISOString(), 8, "for the delivery deadline");
  const accepted = await buyerRail.release(B.escrow.escrowId);
  B.txs.push({ step: "buyer accepts: claim + pay seller atomically", hash: accepted.reference });
  log(`buyer-acceptance: released (tx ${accepted.reference})`);
  const cleared = await sellerRail.clearDelivery(B.escrow.escrowId);
  B.txs.push({
    step: "seller clears the delivery data entry (frees reserve)",
    hash: cleared.reference,
  });
  const refunded = await buyerRail.refund(C.escrow.escrowId);
  C.txs.push({ step: "buyer refunds undelivered escrow after deadline", hash: refunded.reference });
  log(`refund: refunded (tx ${refunded.reference})`);
  const rejected = await buyerRail.reject(D.escrow.escrowId);
  D.txs.push({
    step: "buyer rejects the delivery within the review window",
    hash: rejected.reference,
  });
  log(`reject: refunded (tx ${rejected.reference})`);
  const clearedD = await sellerRail.clearDelivery(D.escrow.escrowId);
  D.txs.push({
    step: "seller clears the delivery data entry (frees reserve)",
    hash: clearedD.reference,
  });

  // After deadline + review window: seller collects A.
  await until(A.escrow.releasableAfter, 8, "for A's review window to pass");
  const released = await sellerRail.release(A.escrow.escrowId);
  A.txs.push({
    step: "seller claims after review window (auto-release)",
    hash: released.reference,
  });
  log(`auto-release: released (tx ${released.reference})`);

  // Standalone anchor + verification of every receipt against the chain.
  const anchor = new StellarAnchor({ signer: keypairSigner(seller) });
  const standalone = await anchor.anchor(A.signed.receiptHash);
  A.txs.push({
    step: "StellarAnchor.anchor (standalone MEMO_HASH anchor)",
    hash: standalone.reference,
  });
  const verifier = new StellarAnchor({ account: seller.publicKey() });
  for (const r of [A, B, C, D]) {
    r.final = await buyerRail.getEscrow(r.escrow.escrowId);
    if (r.signed) {
      r.offline = verifySignedReceipt(r.signed);
      r.foundByReference = await verifier.find(r.signed.receiptHash, { reference: r.deliverTx });
      r.foundByScan = await verifier.find(r.signed.receiptHash);
      if (!r.offline.ok || !r.foundByReference || !r.foundByScan) {
        throw new Error(`${r.scenario.label}: verification failed`);
      }
      // Bytes, not a path: the delivered output itself (level 1), plus the seller binding.
      r.report = await verify(r.signed, { file: new TextEncoder().encode(r.output) });
    }
    log(`${r.scenario.label}: final status ${r.final.status}`);
  }
  const expected = {
    "auto-release": "released",
    "buyer-acceptance": "released",
    refund: "refunded",
    reject: "refunded",
  };
  for (const [label, status] of Object.entries(expected)) {
    if (results[label].final.status !== status) {
      throw new Error(`${label}: expected ${status}, got ${results[label].final.status}`);
    }
    const report = results[label].report;
    // The level-3 escrow settlement must pass exactly when the escrow was released; with the
    // delivered bytes and the seller binding, released flows are VERIFIED (SPEC §6) and the
    // rejected (refunded) one is NOT VERIFIED.
    const paid = report?.checks.find((c) => c.name.startsWith("Payment"))?.status === "pass";
    if (report && paid !== (status === "released")) {
      throw new Error(`${label}: verifier settlement=${paid}`);
    }
    const want = status === "released" ? "VERIFIED" : "NOT VERIFIED";
    if (report && report.verdict !== want) {
      throw new Error(`${label}: expected ${want}, got ${report.verdict}: ${report.missing}`);
    }
  }

  writeResults({ buyer, seller, sellerKey, funding, assetNote, setupTxs, results, negatives });
  log("all scenarios passed; results written to E2E_RESULTS.md");
}

function writeResults({
  buyer,
  seller,
  sellerKey,
  funding,
  assetNote,
  setupTxs,
  results,
  negatives,
}) {
  const link = (h) => `[\`${h.slice(0, 12)}…\`](${explorerTxUrl(h)})`;
  const txTable = (txs) =>
    [
      "| Step | Transaction |",
      "| --- | --- |",
      ...txs.map((t) => `| ${t.step} | ${link(t.hash)} |`),
    ].join("\n");
  const out = [
    "## Claimable-balance escrow (`escrow:stellar-claimable`)",
    "",
    `Generated by \`scripts/e2e-testnet.mjs\` on ${new Date().toISOString()}. Network: **Stellar testnet** (\`${STELLAR_TESTNET.caip2}\`). Public data only — no keys. Each receipt carries the seller binding \`examples/bindings/stellar-testnet.json\` and is verified from its delivered bytes (\`examples/deliverables/stellar-claimable-{a,b,d}.txt\`; machine-readable results in \`e2e-claimable-results.json\`): released flows are asserted VERIFIED, the rejected one NOT VERIFIED. Rail rules: SPEC §7.5.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Buyer | [\`${buyer.publicKey()}\`](https://stellar.expert/explorer/testnet/account/${buyer.publicKey()}) (${funding.buyer}) |`,
    `| Seller | [\`${seller.publicKey()}\`](https://stellar.expert/explorer/testnet/account/${seller.publicKey()}) (${funding.seller}) |`,
    `| Seller receipt key | \`${sellerKey.did}\` |`,
    `| Asset | ${assetNote} |`,
    "",
  ];
  if (setupTxs.length) out.push("### Setup", "", txTable(setupTxs), "");
  for (const r of Object.values(results)) {
    const e = r.escrow;
    out.push(
      `### Escrow: ${r.scenario.label}`,
      "",
      `- escrowId: \`${e.escrowId}\` (strkey \`${escrowIdToStrKey(e.escrowId)}\`)`,
      `- amount: ${e.amount} (smallest units) of \`${e.asset}\`; review window ${r.scenario.reviewWindowSeconds}s`,
      `- buyer window (refund / reject / accept): from ${e.refundableAfter} until ${e.releasableAfter}; seller window: from ${e.releasableAfter}`,
      `- final status: **${r.final.status}**${r.final.releasedBy ? ` (${r.final.releasedBy})` : ""}${r.report ? ` · \`receptum-verify\`: **${r.report.verdict}** — ${r.report.checks.find((c) => c.level === 3).detail}` : ""}`,
      "",
      txTable(r.txs),
      "",
    );
    if (r.signed) {
      out.push(
        `receiptHash: \`${r.signed.receiptHash}\` — offline signature check: ${r.offline.ok ? "valid" : "INVALID"}; on-chain anchor found by reference: ${r.foundByReference ? "yes" : "no"}, by account scan: ${r.foundByScan ? `yes (${link(r.foundByScan.reference)})` : "no"}`,
        "",
        "<details><summary>Signed receipt</summary>",
        "",
        "```json",
        JSON.stringify(r.signed, null, 2),
        "```",
        "",
        "</details>",
        "",
      );
    }
  }
  out.push(
    "### Negative checks",
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...negatives.map(
      (n) =>
        `| ${n.check} | rejected: \`${n.error.message.replace(/\|/g, "\\|")}\`${n.error.hash ? ` — failed tx on ledger: ${link(n.error.hash)}` : ""} |`,
    ),
    "",
  );
  writeSection(join(here, "..", "E2E_RESULTS.md"), "claimable", out.join("\n"));

  // Machine-readable results (scripts/verify-examples.mjs and verify_examples.py read them).
  const keys = { "auto-release": "A", "buyer-acceptance": "B", refund: "C", reject: "D" };
  const json = JSON.stringify(
    {
      network: STELLAR_TESTNET.caip2,
      flows: Object.fromEntries(
        Object.entries(results).map(([label, r]) => [
          keys[label],
          {
            label,
            escrowId: r.final.escrowId,
            status: r.final.status,
            ...(r.final.releasedBy ? { releasedBy: r.final.releasedBy } : {}),
            txs: r.txs,
            ...(r.signed
              ? { signedReceipt: r.signed, deliverable: r.output, verdict: r.report.verdict }
              : {}),
          },
        ]),
      ),
      negatives: negatives.map((n) => ({
        check: n.check,
        message: n.error.message,
        ...(n.error.hash ? { hash: n.error.hash } : {}),
      })),
    },
    null,
    2,
  );
  assertNoSecrets(json);
  writeFileSync(join(here, "..", "e2e-claimable-results.json"), json + "\n");
  // The delivered bytes are synthetic test text; publish them so receipts verify at level 1.
  for (const [label, r] of Object.entries(results))
    if (r.output)
      writeFileSync(
        join(DELIVERABLES, `stellar-claimable-${keys[label].toLowerCase()}.txt`),
        r.output,
      );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
