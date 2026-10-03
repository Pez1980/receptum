#!/usr/bin/env node
// End-to-end run of the Soroban ReceptumEscrow on Stellar TESTNET (never mainnet). Not in CI.
//   pnpm build
//   node packages/adapter-stellar/scripts/e2e-soroban-testnet.mjs
//
// Five escrows on the deployed contract (contracts/receptum-escrow/deployment.testnet.json):
//   A  buyer accepts after delivery            → released
//   B  nobody acts; released after the window  → released (permissionless)
//   C  seller misses the deadline              → refunded (permissionless)
//   D  evaluator rejects within the window     → refunded
//   E  seller refunds voluntarily              → refunded
// plus negative checks (contract rejections), balance conservation, and every receipt checked with
// @receptum/verify. Public results only: E2E_RESULTS.md (Soroban section) and
// e2e-soroban-results.json (signed receipts, for `receptum-verify`).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReceipt, sha256Hex, signReceipt, verifySignedReceipt } from "@receptum/core";
import { verify } from "../../verify/dist/index.js";
import {
  SOROBAN_ESCROW_RAIL,
  STELLAR_TESTNET,
  SorobanEscrowRail,
  TESTNET_USDC_SAC,
  caip10,
  explorerTxUrl,
  keypairSigner,
} from "../dist/index.js";
import {
  assertNoSecrets,
  ensureUsdc,
  fund,
  loadSellerReceiptKey,
  loadThirdParty,
  loadWallets,
  log,
  sleep,
  usdcBalance,
  writeSection,
} from "./testnet-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const deployment = JSON.parse(
  readFileSync(join(here, "..", "contracts", "receptum-escrow", "deployment.testnet.json"), "utf8"),
);
const contractId = deployment.contractId;
const AMOUNT = "1000000"; // 0.1 USDC (7 decimals)

async function untilIso(iso, extraSeconds, why) {
  const ms = Date.parse(iso) + extraSeconds * 1000 - Date.now();
  if (ms > 0) {
    log(`waiting ${Math.ceil(ms / 1000)}s ${why}`);
    await sleep(ms);
  }
}

async function expectRejected(label, fn) {
  try {
    const r = await fn();
    throw new Error(`${label}: expected a rejection but got ${JSON.stringify(r)}`);
  } catch (err) {
    if (String(err.message).startsWith(`${label}: expected a rejection`)) throw err;
    log(`ok (rejected) ${label}: ${err.message}${err.hash ? ` (tx ${err.hash})` : ""}`);
    return { check: label, message: err.message, ...(err.hash ? { hash: err.hash } : {}) };
  }
}

function receiptFor(sellerKey, escrow, mode, label, evaluator) {
  const output = `rendered output for ${label} ${randomBytes(8).toString("hex")}`;
  const receipt = createReceipt({
    jobId: `e2e-soroban-${label}-${randomBytes(6).toString("hex")}`,
    seller: { id: sellerKey.did, name: "receptum e2e seller" },
    buyer: { id: caip10(escrow.buyer) },
    inputSha256: [sha256Hex(`input for ${label}`)],
    outputSha256: sha256Hex(output),
    payment: {
      rail: SOROBAN_ESCROW_RAIL,
      network: STELLAR_TESTNET.caip2,
      asset: escrow.token,
      amount: escrow.amount,
      reference: escrow.escrowId,
      payer: caip10(escrow.buyer),
      payee: caip10(escrow.seller),
    },
    acceptance: {
      mode,
      reviewWindowSeconds: escrow.reviewWindowSeconds,
      ...(evaluator ? { evaluator: caip10(evaluator) } : {}),
    },
    remedy: { kind: "rerender", withinDays: 7 },
  });
  const signed = signReceipt(receipt, sellerKey);
  if (!verifySignedReceipt(signed).ok) throw new Error("receipt does not verify offline");
  return { signed, output };
}

async function main() {
  const { buyer, seller } = loadWallets();
  const third = loadThirdParty();
  const sellerKey = loadSellerReceiptKey();
  log("contract", contractId);
  log("buyer   ", buyer.publicKey());
  log("seller  ", seller.publicKey());
  log("third   ", third.publicKey(), "(evaluator of D; permissionless caller for B and C)");
  const funding = {
    buyer: await fund(buyer),
    seller: await fund(seller),
    third: await fund(third),
  };
  const setupTxs = await ensureUsdc(buyer, [buyer, seller], 2);

  const rail = (kp) => new SorobanEscrowRail({ contractId, signer: keypairSigner(kp) });
  const asBuyer = rail(buyer);
  const asSeller = rail(seller);
  const asThird = rail(third);

  const start = {
    buyer: await usdcBalance(buyer.publicKey()),
    seller: await usdcBalance(seller.publicKey()),
  };
  const deliverBy = new Date(Date.now() + 180_000);
  const plan = {
    A: { label: "A buyer accepts", mode: "buyer", window: 600 },
    B: { label: "B auto-release after the window", mode: "auto", window: 45 },
    C: { label: "C refund after a missed deadline", mode: "auto", window: 600 },
    D: { label: "D evaluator rejects within the window", mode: "evaluator", window: 600 },
    E: { label: "E seller refunds voluntarily", mode: "buyer", window: 600 },
  };
  const flows = {};
  for (const [k, p] of Object.entries(plan)) {
    const evaluator = k === "D" ? third.publicKey() : undefined;
    const escrow = await asBuyer.open({
      seller: seller.publicKey(),
      amount: AMOUNT,
      deliverBy,
      reviewWindowSeconds: p.window,
      ...(evaluator ? { evaluator } : {}),
    });
    flows[k] = {
      ...p,
      evaluator,
      escrow,
      txs: [{ step: "buyer opens (USDC into the contract)", hash: escrow.reference }],
    };
    log(`${k}: opened ${escrow.escrowId} (tx ${escrow.reference})`);
  }
  const { A, B, C, D, E } = flows;

  const negatives = [];
  negatives.push(
    await expectRejected("refund before the deadline", () => asThird.refund(C.escrow.escrowId)),
  );
  negatives.push(
    await expectRejected("release before any delivery", () => asThird.release(B.escrow.escrowId)),
  );
  negatives.push(
    await expectRejected("buyer accepts before any delivery", () =>
      asBuyer.accept(A.escrow.escrowId),
    ),
  );

  // Seller delivers A, B, D, E with signed receipts; C is never delivered.
  for (const f of [A, B, D, E]) {
    const { signed } = receiptFor(sellerKey, f.escrow, f.mode, f.label.split(" ")[0], f.evaluator);
    f.signed = signed;
    const { reference } = await asSeller.deliver(f.escrow.escrowId, signed.receiptHash);
    f.txs.push({ step: "seller delivers (commits receiptHash)", hash: reference });
    f.delivered = await asSeller.getEscrow(f.escrow.escrowId);
    log(`${f.label.split(" ")[0]}: delivered ${signed.receiptHash} (tx ${reference})`);
  }
  negatives.push(
    await expectRejected("redelivery with a different receipt hash", () =>
      asSeller.deliver(A.escrow.escrowId, sha256Hex("another receipt")),
    ),
  );
  negatives.push(
    await expectRejected("release during the review window", () =>
      asThird.release(A.escrow.escrowId),
    ),
  );
  negatives.push(
    await expectRejected("refund of a delivered escrow", () => asThird.refund(D.escrow.escrowId)),
  );
  negatives.push(
    await expectRejected("the seller accepts its own delivery", () =>
      asSeller.accept(A.escrow.escrowId),
    ),
  );
  negatives.push(
    await expectRejected("a stranger accepts (not buyer or evaluator)", () =>
      asThird.accept(A.escrow.escrowId),
    ),
  );
  negatives.push(
    await expectRejected("a stranger rejects (the escrow has no evaluator)", () =>
      asThird.reject(E.escrow.escrowId),
    ),
  );
  negatives.push(
    await expectRejected("a stranger calls sellerRefund (needs the seller's signature)", () =>
      asThird.sellerRefund(E.escrow.escrowId),
    ),
  );

  // A: buyer accepts. D: evaluator rejects. E: seller refunds.
  A.txs.push({
    step: "buyer accepts → released to seller",
    hash: (await asBuyer.accept(A.escrow.escrowId)).reference,
  });
  D.txs.push({
    step: "evaluator rejects within the window → refunded to buyer",
    hash: (await asThird.reject(D.escrow.escrowId)).reference,
  });
  E.txs.push({
    step: "seller refunds voluntarily → refunded to buyer",
    hash: (await asSeller.sellerRefund(E.escrow.escrowId)).reference,
  });
  log("A accepted, D rejected, E seller-refunded");
  negatives.push(
    await expectRejected("reject after acceptance", () => asBuyer.reject(A.escrow.escrowId)),
  );
  negatives.push(
    await expectRejected("release after a rejection", () => asThird.release(D.escrow.escrowId)),
  );

  // B: release by a third party once the window (from delivery) has passed.
  await untilIso(B.delivered.releasableAfter, 12, "for B's review window (from delivery)");
  B.txs.push({
    step: "third party releases after the window → released to seller",
    hash: (await asThird.release(B.escrow.escrowId)).reference,
  });
  negatives.push(
    await expectRejected("second release (double spend)", () => asThird.release(B.escrow.escrowId)),
  );
  log("B released");

  // C: refund by a third party after the missed deadline.
  await untilIso(C.escrow.refundableAfter, 12, "for C's delivery deadline");
  negatives.push(
    await expectRejected("late delivery after the deadline", () =>
      asSeller.deliver(C.escrow.escrowId, sha256Hex("late receipt")),
    ),
  );
  C.txs.push({
    step: "third party refunds after the missed deadline → refunded to buyer",
    hash: (await asThird.refund(C.escrow.escrowId)).reference,
  });
  negatives.push(
    await expectRejected("second refund (double spend)", () => asThird.refund(C.escrow.escrowId)),
  );
  log("C refunded");

  const expected = { A: "released", B: "released", C: "refunded", D: "refunded", E: "refunded" };
  for (const [k, f] of Object.entries(flows)) {
    f.final = await asBuyer.getEscrow(f.escrow.escrowId);
    if (f.final.status !== expected[k])
      throw new Error(`${k}: expected ${expected[k]}, got ${f.final.status}`);
    if (f.signed) {
      f.report = await verify(f.signed);
      const want = expected[k] === "released";
      if (f.report.complete !== want)
        throw new Error(
          `${k}: verifier complete=${f.report.complete}: ${JSON.stringify(f.report.checks)}`,
        );
    }
  }

  const end = {
    buyer: await usdcBalance(buyer.publicKey()),
    seller: await usdcBalance(seller.publicKey()),
  };
  const units = (s) => BigInt(Math.round(Number(s) * 1e7));
  const conservation = {
    buyerDelta: (units(end.buyer) - units(start.buyer)).toString(),
    sellerDelta: (units(end.seller) - units(start.seller)).toString(),
  };
  if (
    conservation.buyerDelta !== (-2n * BigInt(AMOUNT)).toString() ||
    conservation.sellerDelta !== (2n * BigInt(AMOUNT)).toString()
  )
    throw new Error(`balances not conserved: ${JSON.stringify(conservation)}`);
  log("balances conserved:", conservation);

  write({
    buyer,
    seller,
    third,
    sellerKey,
    funding,
    setupTxs,
    flows,
    negatives,
    conservation,
    deliverBy,
  });
  log("all Soroban flows passed");
}

function write({
  buyer,
  seller,
  third,
  sellerKey,
  funding,
  setupTxs,
  flows,
  negatives,
  conservation,
  deliverBy,
}) {
  const link = (h) => `[\`${h.slice(0, 12)}…\`](${explorerTxUrl(h)})`;
  const acct = (a) => `[\`${a}\`](https://stellar.expert/explorer/testnet/account/${a})`;
  const table = (txs) =>
    [
      "| Step | Transaction |",
      "| --- | --- |",
      ...txs.map((t) => `| ${t.step} | ${link(t.hash)} |`),
    ].join("\n");
  const out = [
    "## Soroban escrow (`escrow:receptum-soroban`)",
    "",
    `Generated by \`scripts/e2e-soroban-testnet.mjs\` on ${new Date().toISOString()}. Network: **Stellar testnet**. Public data only — no keys. Contract is **unaudited**.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Contract | [\`${contractId}\`](${deployment.contract}) |`,
    `| Wasm SHA-256 | \`${deployment.wasmHash}\` |`,
    `| Deployment | upload ${link(deployment.transactions.uploadWasm.hash)} · create ${link(deployment.transactions.createContract.hash)} |`,
    `| Buyer | ${acct(buyer.publicKey())} (${funding.buyer}) |`,
    `| Seller | ${acct(seller.publicKey())} (${funding.seller}) |`,
    `| Evaluator / third party | ${acct(third.publicKey())} (${funding.third}) |`,
    `| Seller receipt key | \`${sellerKey.did}\` |`,
    `| Asset | Circle testnet USDC via its Stellar Asset Contract \`${TESTNET_USDC_SAC}\` |`,
    `| Amount per escrow | ${AMOUNT} (0.1 USDC); shared deadline ${deliverBy.toISOString()} |`,
    `| Conservation | buyer ${conservation.buyerDelta}, seller +${conservation.sellerDelta} (two released, three refunded) |`,
    "",
  ];
  if (setupTxs.length) out.push("### Setup", "", table(setupTxs), "");
  for (const f of Object.values(flows)) {
    const e = f.final;
    out.push(
      `### ${f.label}`,
      "",
      `- escrowId: \`${e.escrowId}\``,
      `- acceptance: \`${f.mode}\`, review window ${f.window}s from delivery${f.evaluator ? `, evaluator \`${f.evaluator}\`` : ""}`,
      `- final status: **${e.status}**${f.report ? ` · \`receptum-verify\`: **${!f.report.ok ? "NOT VERIFIED" : f.report.complete ? "VERIFIED" : "PARTIALLY VERIFIED"}** — ${f.report.checks.find((c) => c.level === 3).detail}` : " (no receipt: nothing was delivered)"}`,
      "",
      table(f.txs),
      "",
    );
    if (f.signed)
      out.push(
        `receiptHash \`${f.signed.receiptHash}\``,
        "",
        "<details><summary>Signed receipt</summary>",
        "",
        "```json",
        JSON.stringify(f.signed, null, 2),
        "```",
        "",
        "</details>",
        "",
      );
  }
  out.push(
    "### Negative checks (rejected by the contract)",
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...negatives.map(
      (n) =>
        `| ${n.check} | \`${n.message.replace(/\|/g, "\\|")}\`${n.hash ? ` — failed tx ${link(n.hash)}` : " (simulation)"} |`,
    ),
  );
  writeSection(join(here, "..", "E2E_RESULTS.md"), "soroban", out.join("\n"));
  const json = JSON.stringify(
    {
      network: STELLAR_TESTNET.caip2,
      contractId,
      flows: Object.fromEntries(
        Object.entries(flows).map(([k, f]) => [
          k,
          {
            label: f.label,
            escrowId: f.final.escrowId,
            status: f.final.status,
            txs: f.txs,
            ...(f.signed ? { signedReceipt: f.signed } : {}),
          },
        ]),
      ),
      negatives,
    },
    null,
    2,
  );
  assertNoSecrets(json);
  writeFileSync(join(here, "..", "e2e-soroban-results.json"), json + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
