// End-to-end run of the receptum_escrow program on Solana DEVNET. Not run in CI.
//
//   pnpm --filter @receptum/adapter-solana build && node packages/adapter-solana/scripts/e2e-devnet.mjs [A B C D E F]
//
// Flows (devnet USDC, 0.10 per escrow):
//   A  buyer accepts            → released   (receipt VERIFIED)
//   B  auto-release             → released after the review window by a bystander (VERIFIED)
//   C  missed deadline          → refunded by anyone after deliverBy (nothing delivered)
//   D  evaluator rejects        → refunded within the window (receipt NOT VERIFIED)
//   E  seller refund            → refunded by the seller after delivering (NOT VERIFIED)
//   F  evaluator accepts        → released (VERIFIED)
// Keys: $RECEPTUM_WALLETS_DIR/solana-devnet-{buyer,seller,evaluator}.json, seller-ed25519.pem.
// Writes only public data: examples/solana-devnet-escrow-*.json, examples/deliverables/solana-devnet-*.txt,
// and the escrow section of E2E_RESULTS.md.
import { writeFileSync } from "node:fs";
import { createReceipt, sha256Hex, signReceipt } from "@receptum/core";
import { verify } from "../../verify/dist/index.js";
import {
  DEVNET_USDC_MINT,
  explorerAddressUrl,
  explorerTxUrl,
  parseSolanaEscrowId,
  RECEPTUM_SOLANA_PROGRAM_ID,
  SolanaEscrowRail,
} from "../dist/index.js";
import {
  assertNoSecrets,
  lamports,
  loadKeypair,
  NETWORK,
  rpc,
  sellerBinding,
  sellerKey as loadSellerKey,
  tokenBalance,
  topUp,
  writeSection,
} from "./devnet-common.mjs";

const AMOUNT = "100000"; // 0.10 USDC
const buyer = loadKeypair("buyer");
const seller = loadKeypair("seller");
const evaluator = loadKeypair("evaluator");
const sellerKey = loadSellerKey();
const binding = await sellerBinding(seller);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rail = (signer) => new SolanaEscrowRail({ network: NETWORK, rpc, signer });
const asBuyer = rail(buyer);
const asSeller = rail(seller);
const asEvaluator = rail(evaluator);
const caip = (a) => `${NETWORK}:${a}`;

// Fees and rent come from the deployer wallet (devnet SOL), topped up per party.
const deployer = loadKeypair("deployer");
for (const [k, min] of [
  [buyer, 50_000_000n],
  [seller, 20_000_000n],
  [evaluator, 10_000_000n],
]) {
  const sig = await topUp(deployer, k.address, min);
  if (sig) console.log("funded", k.address, sig);
  if ((await lamports(k.address)) < min) throw new Error(`${k.address} needs devnet SOL`);
}
const usdc = await tokenBalance(buyer.address);
if (usdc === null || usdc < 6n * BigInt(AMOUNT)) throw new Error("buyer needs devnet USDC");

function receiptFor(flow, escrowId, acceptance, output) {
  const receipt = createReceipt({
    jobId: `solana-escrow-${flow}-${Date.now()}`,
    seller: { id: sellerKey.did, name: "receptum e2e seller (solana)" },
    buyer: { id: caip(buyer.address) },
    inputSha256: [sha256Hex(`input for ${flow}-job`)],
    outputSha256: sha256Hex(output),
    payment: {
      rail: "escrow:receptum-solana",
      network: NETWORK,
      asset: DEVNET_USDC_MINT,
      amount: AMOUNT,
      reference: escrowId,
      payer: caip(buyer.address),
      payee: caip(seller.address),
    },
    acceptance,
  });
  return { ...signReceipt(receipt, sellerKey), bindings: [binding] };
}

const results = {};
const flows = process.argv.slice(2).length ? process.argv.slice(2) : ["A", "B", "C", "D", "E", "F"];

async function run(flow, { window, deliverIn = 1200, evaluated = false, mode }) {
  const steps = [];
  const deliverBy = new Date(Date.now() + deliverIn * 1000);
  const opened = await asBuyer.open({
    seller: seller.address,
    mint: DEVNET_USDC_MINT,
    amount: AMOUNT,
    deliverBy,
    reviewWindowSeconds: window,
    ...(evaluated ? { evaluator: evaluator.address } : {}),
  });
  steps.push(["open (buyer)", opened.reference]);
  const escrowId = opened.escrowId;
  console.log(flow, "opened", escrowId);
  const output = `output for ${flow}-job (solana devnet)\n`;
  const acceptance = {
    mode,
    reviewWindowSeconds: window,
    ...(evaluated ? { evaluator: caip(evaluator.address) } : {}),
  };
  const signed = receiptFor(flow, escrowId, acceptance, output);
  return { steps, escrowId, output, signed, deliverBy };
}

async function deliver(r) {
  const d = await asSeller.deliver(r.escrowId, r.signed.receiptHash);
  r.steps.push(["deliver(receiptHash) (seller)", d.reference]);
}

for (const flow of flows) {
  let r;
  if (flow === "A") {
    r = await run("A", { window: 600, mode: "buyer" });
    await deliver(r);
    r.steps.push(["accept (buyer)", (await asBuyer.accept(r.escrowId)).reference]);
  } else if (flow === "B") {
    r = await run("B", { window: 20, mode: "auto" });
    await deliver(r);
    await sleep(30_000);
    r.steps.push([
      "release after the window (evaluator wallet as bystander)",
      (await asEvaluator.release(r.escrowId)).reference,
    ]);
  } else if (flow === "C") {
    r = await run("C", { window: 600, mode: "buyer", deliverIn: 15 });
    await sleep(25_000);
    r.steps.push(["refund after deliverBy (buyer)", (await asBuyer.refund(r.escrowId)).reference]);
  } else if (flow === "D") {
    r = await run("D", { window: 600, mode: "evaluator", evaluated: true });
    await deliver(r);
    r.steps.push(["reject (evaluator)", (await asEvaluator.reject(r.escrowId)).reference]);
  } else if (flow === "E") {
    r = await run("E", { window: 600, mode: "buyer" });
    await deliver(r);
    r.steps.push(["sellerRefund (seller)", (await asSeller.sellerRefund(r.escrowId)).reference]);
  } else if (flow === "F") {
    r = await run("F", { window: 600, mode: "evaluator", evaluated: true });
    await deliver(r);
    r.steps.push(["accept (evaluator)", (await asEvaluator.accept(r.escrowId)).reference]);
  } else throw new Error(`unknown flow ${flow}`);
  const state = await asBuyer.getEscrow(r.escrowId);
  results[flow] = { ...r, state };
  console.log(flow, state.status, r.steps.map((s) => s[1]).join(" "));
}

await sleep(20_000); // let the last transactions finalize
const names = {
  A: "buyer accepts",
  B: "auto-release",
  C: "refund after missed deadline",
  D: "evaluator rejects",
  E: "seller refund",
  F: "evaluator accepts",
};
const rows = [];
for (const [flow, r] of Object.entries(results)) {
  const lower = flow.toLowerCase();
  const deliverable = `examples/deliverables/solana-devnet-escrow-${lower}.txt`;
  writeFileSync(new URL(`../../../${deliverable}`, import.meta.url), r.output);
  const report = await verify(r.signed, { file: new TextEncoder().encode(r.output) });
  const payment = report.checks.find((c) => c.name.startsWith("Payment"));
  const { escrow } = parseSolanaEscrowId(r.escrowId);
  const doc = {
    flow: `${flow}: ${names[flow]}`,
    network: NETWORK,
    programId: RECEPTUM_SOLANA_PROGRAM_ID,
    escrowId: r.escrowId,
    escrowUrl: explorerAddressUrl(escrow),
    deliverable,
    transactions: r.steps.map(([step, sig]) => ({ step, signature: sig, url: explorerTxUrl(sig) })),
    finalState: {
      status: r.state.status,
      settledBy: r.state.solana.settledBy,
      receiptHash: r.state.solana.receiptHash,
    },
    ...(flow === "C"
      ? {
          note: "Nothing was delivered: the receipt was signed but never committed, so it cannot verify.",
        }
      : {}),
    signedReceipt: r.signed,
    verify: { verdict: report.verdict, checks: report.checks },
  };
  const json = JSON.stringify(doc, null, 2) + "\n";
  assertNoSecrets(json);
  writeFileSync(
    new URL(`../../../examples/solana-devnet-escrow-${lower}.json`, import.meta.url),
    json,
  );
  console.log(flow, report.verdict, payment?.detail);
  rows.push(
    `| ${flow} — ${names[flow]} | [\`${escrow.slice(0, 8)}…\`](${explorerAddressUrl(escrow)}) | ${r.steps
      .map(([step, sig]) => `${step}: [\`${sig.slice(0, 10)}…\`](${explorerTxUrl(sig)})`)
      .join("<br>")} | ${r.state.status} | **${report.verdict}** |`,
  );
}

writeSection(
  new URL("../E2E_RESULTS.md", import.meta.url).pathname,
  "escrow",
  [
    "## receptum_escrow on Solana devnet",
    "",
    `Generated by \`packages/adapter-solana/scripts/e2e-devnet.mjs\` on ${new Date().toISOString()}. Program [\`${RECEPTUM_SOLANA_PROGRAM_ID}\`](${explorerAddressUrl(RECEPTUM_SOLANA_PROGRAM_ID)}) (immutable, see \`program/deployment.devnet.json\`); each escrow holds **0.10 devnet USDC** (mint \`${DEVNET_USDC_MINT}\`). Buyer \`${buyer.address}\`, seller \`${seller.address}\`, evaluator \`${evaluator.address}\`. Every receipt carries the seller's account binding (\`examples/bindings/solana-devnet.json\`).`,
    "",
    "| Flow | Escrow | Transactions | Final state | `receptum-verify` |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Refunded escrows (C, D, E) never verify: the verifier reports NOT VERIFIED because the funds went back to the buyer. Files: `examples/solana-devnet-escrow-*.json`, `examples/deliverables/solana-devnet-escrow-*.txt`.",
  ].join("\n"),
);
console.log("wrote examples/solana-devnet-escrow-*.json and the escrow section of E2E_RESULTS.md");
