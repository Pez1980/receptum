// XRPL TESTNET only (NetworkID 1). Two escrow:xrpl flows with signed, seller-bound receipts:
//
//   E — evaluator mode (XRP): buyer opens a conditional escrow and gives the fulfillment to the
//       evaluator off-ledger; the seller delivers (receipt memo) and hands the deliverable and
//       receipt to the evaluator; the evaluator checks them and submits EscrowFinish from its own
//       account — the on-ledger proof of who decided (SPEC §7.3).
//   T — TokenEscrow (buyer mode) with the self-issued RCPT token, amount in 10^-15 units.
//
//   pnpm build && node examples/x402-xrpl/setup-wallets.mjs && node examples/x402-xrpl/setup-token.mjs
//   node packages/adapter-xrpl/scripts/e2e-evaluator-token.mjs
//
// Keys: $RECEPTUM_WALLETS_DIR/xrpl-x402-testnet.json (buyer, seller), xrpl-token-testnet.json
// (evaluator) and seller-ed25519.pem — loaded, never printed. Writes public data only:
// examples/xrpl-testnet-escrow-{evaluator,token}.json and examples/deliverables/….
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createReceipt,
  sellerKeyFromPem,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
  xrplUnitsToValue,
} from "@receptum/core";
import { Client, Wallet } from "xrpl";
import { caip10, newEscrowSecret, XrplEscrowRail } from "../dist/index.js";

const WSS = "wss://s.altnet.rippletest.net:51233";
const NETWORK = "xrpl:1";
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const root = new URL("../../../", import.meta.url);
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config", "receptum", "wallets");
const x = JSON.parse(readFileSync(join(dir, "xrpl-x402-testnet.json"), "utf8"));
const t = JSON.parse(readFileSync(join(dir, "xrpl-token-testnet.json"), "utf8"));
const secrets = [x.buyer.seed, x.seller.seed, t.issuer.seed, t.evaluator.seed];
const buyer = Wallet.fromSeed(x.buyer.seed);
const seller = Wallet.fromSeed(x.seller.seed);
const evaluator = Wallet.fromSeed(t.evaluator.seed);
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));
const token = JSON.parse(
  readFileSync(new URL("examples/x402-xrpl/token-setup.json", root), "utf8"),
);
const binding = JSON.parse(
  readFileSync(new URL("examples/bindings/xrpl-testnet-x402.json", root), "utf8"),
);
if (binding.statement.account !== caip10(NETWORK, seller.address))
  throw new Error("examples/bindings/xrpl-testnet-x402.json is for another account");
if (t.evaluator.address !== token.accounts.evaluator) throw new Error("token-setup.json mismatch");

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
function write(path, data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  if (secrets.some((s) => text.includes(s))) throw new Error("refusing to write a secret");
  writeFileSync(new URL(path, root), text);
  console.log(`  wrote ${path}`);
}

function signedReceipt(handle, { jobId, deliverable, acceptance }) {
  const receipt = createReceipt({
    jobId,
    seller: { id: sellerKey.did, name: "receptum e2e seller (xrpl)" },
    buyer: { id: caip10(NETWORK, handle.buyer) },
    inputSha256: [sha256Hex(`brief for ${jobId}`)],
    outputSha256: sha256Hex(deliverable),
    payment: {
      rail: handle.rail,
      network: handle.network,
      asset: handle.asset,
      amount: handle.amount,
      reference: handle.escrowId,
      payer: caip10(NETWORK, handle.buyer),
      payee: caip10(NETWORK, handle.seller),
    },
    acceptance,
    remedy: { kind: "refund", withinDays: 7 },
  });
  return { ...signReceipt(receipt, sellerKey), bindings: [binding] };
}

const client = new Client(WSS);
await client.connect();
try {
  const info = (await client.request({ command: "server_info" })).result.info;
  assert(info.network_id === 1, "connected to XRPL testnet (NetworkID 1) — refusing anything else");
  const rail = (wallet, fulfillment) =>
    new XrplEscrowRail({
      client,
      wallet,
      network: NETWORK,
      ...(fulfillment ? { fulfillment } : {}),
    });

  // ─── E: evaluator mode ───────────────────────────────────────────────────
  console.log(`E: evaluator escrow (XRP), evaluator ${evaluator.address}`);
  const evaluatorId = caip10(NETWORK, evaluator.address);
  const evaluatorInbox = new Map(); // off-ledger: fulfillments the buyer gave the evaluator
  const secretE = newEscrowSecret();
  const txE = [];
  const handleE = await rail(buyer).createEscrow({
    seller: seller.address,
    amount: "1000000",
    asset: "XRP",
    deliverBy: new Date(Date.now() + 600_000),
    reviewWindowSeconds: 600,
    condition: secretE.condition,
  });
  txE.push({ step: `EscrowCreate (${handleE.escrowId}) by the buyer`, hash: handleE.reference });
  console.log(`  EscrowCreate ${handleE.reference}`);
  evaluatorInbox.set(handleE.escrowId, secretE.fulfillment); // buyer → evaluator, off-ledger

  const deliverableE = `Receptum XRPL evaluator-mode escrow — synthetic deliverable ${handleE.escrowId}\n`;
  const signedE = signedReceipt(handleE, {
    jobId: `xrpl-evaluator-${handleE.escrowId}`,
    deliverable: deliverableE,
    acceptance: { mode: "evaluator", reviewWindowSeconds: 600, evaluator: evaluatorId },
  });
  const sellerE = rail(seller, () => undefined);
  const deliveredE = await sellerE.deliver(handleE.escrowId, signedE.receiptHash);
  txE.push({ step: "AccountSet delivery memo by the seller", hash: deliveredE.reference });
  console.log(`  deliver ${deliveredE.reference}`);
  await expectError(sellerE.release(handleE.escrowId), "seller release without the fulfillment");

  // Off-ledger: the seller hands the deliverable and receipt to the evaluator, who checks them.
  const evaluatorRail = rail(evaluator, (id) => evaluatorInbox.get(id));
  const seen = await evaluatorRail.getEscrow(handleE.escrowId);
  assert(seen.status === "delivered" && seen.receiptHash === signedE.receiptHash, "E delivered");
  assert(verifySignedReceipt(signedE).ok, "E seller signature");
  assert(sha256Hex(deliverableE) === signedE.receipt.outputSha256, "E deliverable matches");
  assert(signedE.receipt.acceptance.evaluator === evaluatorId, "E names this evaluator");
  await expectError(
    rail(seller, () => secretE.fulfillment).accept(handleE.escrowId, { evaluator: evaluatorId }),
    "accept from a non-evaluator wallet",
  );
  const finishedE = await evaluatorRail.accept(handleE.escrowId, { evaluator: evaluatorId });
  txE.push({ step: "EscrowFinish by the evaluator", hash: finishedE.reference });
  console.log(`  EscrowFinish (evaluator) ${finishedE.reference}`);
  const finalE = await rail(buyer).getEscrow(handleE.escrowId);
  assert(finalE.status === "released", "E released");
  assert(finalE.xrpl.settledBy === evaluator.address, "E finished by the evaluator");

  write("examples/deliverables/xrpl-testnet-escrow-evaluator.txt", deliverableE);
  write("examples/xrpl-testnet-escrow-evaluator.json", {
    network: NETWORK,
    flow: "escrow:xrpl evaluator mode — buyer gives the fulfillment to the evaluator, the evaluator finishes",
    accounts: { buyer: buyer.address, seller: seller.address, evaluator: evaluator.address },
    transactions: txE.map((s) => ({ ...s, url: `${EXPLORER}${s.hash}` })),
    escrow: finalE,
    deliverable: "examples/deliverables/xrpl-testnet-escrow-evaluator.txt",
    signedReceipt: signedE,
  });

  // ─── T: TokenEscrow, buyer mode ──────────────────────────────────────────
  const units = "1500000000000000"; // 1.5 RCPT in 10^-15 units
  console.log(`T: TokenEscrow ${xrplUnitsToValue(units)} ${token.token.symbol} (${token.asset})`);
  const secretT = newEscrowSecret();
  const accepted = new Map();
  const txT = [];
  const handleT = await rail(buyer).createEscrow({
    seller: seller.address,
    amount: units,
    asset: token.asset,
    deliverBy: new Date(Date.now() + 600_000),
    reviewWindowSeconds: 600,
    condition: secretT.condition,
  });
  txT.push({ step: `EscrowCreate (${handleT.escrowId}) by the buyer`, hash: handleT.reference });
  console.log(`  EscrowCreate ${handleT.reference}`);
  const deliverableT = `Receptum XRPL TokenEscrow — synthetic deliverable ${handleT.escrowId}\n`;
  const signedT = signedReceipt(handleT, {
    jobId: `xrpl-token-${handleT.escrowId}`,
    deliverable: deliverableT,
    acceptance: { mode: "buyer", reviewWindowSeconds: 600 },
  });
  const sellerT = rail(seller, (id) => accepted.get(id));
  const deliveredT = await sellerT.deliver(handleT.escrowId, signedT.receiptHash);
  txT.push({ step: "AccountSet delivery memo by the seller", hash: deliveredT.reference });
  console.log(`  deliver ${deliveredT.reference}`);
  const seenT = await rail(buyer).getEscrow(handleT.escrowId);
  assert(seenT.status === "delivered" && seenT.receiptHash === signedT.receiptHash, "T delivered");
  assert(seenT.amount === units && seenT.xrpl.value === "1.5", "T escrowed 1.5 tokens");
  assert(sha256Hex(deliverableT) === signedT.receipt.outputSha256, "T deliverable matches");
  accepted.set(handleT.escrowId, secretT.fulfillment); // buyer accepts → seller may finish
  const releasedT = await sellerT.release(handleT.escrowId);
  txT.push({ step: "EscrowFinish with the buyer's fulfillment", hash: releasedT.reference });
  console.log(`  EscrowFinish ${releasedT.reference}`);
  const finalT = await rail(buyer).getEscrow(handleT.escrowId);
  assert(finalT.status === "released", "T released");

  write("examples/deliverables/xrpl-testnet-escrow-token.txt", deliverableT);
  write("examples/xrpl-testnet-escrow-token.json", {
    network: NETWORK,
    flow: "escrow:xrpl TokenEscrow (buyer mode) of a self-issued 40-hex token, amount in 10^-15 units",
    token: token.token,
    accounts: { buyer: buyer.address, seller: seller.address, issuer: token.token.issuer },
    transactions: txT.map((s) => ({ ...s, url: `${EXPLORER}${s.hash}` })),
    escrow: finalT,
    deliverable: "examples/deliverables/xrpl-testnet-escrow-token.txt",
    signedReceipt: signedT,
  });
  console.log("All checks passed.");
} finally {
  await client.disconnect();
}
