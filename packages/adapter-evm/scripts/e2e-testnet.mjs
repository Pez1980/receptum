// End-to-end run of ReceptumEscrow on Arc testnet (not part of CI).
// Wallets are read from $RECEPTUM_WALLETS_DIR (default ~/.config/receptum/wallets) and never written to the repo.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createReceipt,
  receiptHash,
  sellerKeyFromPem,
  sha256Hex,
  signReceipt,
  verifySignedReceipt,
} from "@receptum/core";
import { clientsFor, deployEscrow, EvmAnchor, EvmEscrowRail, NETWORKS } from "../dist/index.js";

const NETWORK = "eip155:5042002";
const net = NETWORKS[NETWORK];
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));
const buyer = clientsFor(NETWORK, privateKeyToAccount(wallets.buyer.privateKey));
const seller = clientsFor(NETWORK, privateKeyToAccount(wallets.seller.privateKey));
const deployer = clientsFor(NETWORK, privateKeyToAccount(wallets.deployer.privateKey));
for (const c of [buyer, seller, deployer]) c.publicClient.pollingInterval = 500;

const tx = (h) => `${net.explorer}/tx/${h}`;
const results = {
  network: NETWORK,
  explorer: net.explorer,
  accounts: {
    buyer: buyer.account.address,
    seller: seller.account.address,
    deployer: deployer.account.address,
    sellerDid: sellerKey.did,
  },
  flows: [],
};
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const now = async () => Number((await buyer.publicClient.getBlock()).timestamp);

async function usdcBalance(addr) {
  return buyer.publicClient.readContract({
    address: net.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  });
}

async function topUp(to, amount) {
  if ((await usdcBalance(to)) >= amount) return null;
  const h = await buyer.walletClient.writeContract({
    address: net.usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
    account: buyer.account,
    chain: net.chain,
  });
  await buyer.publicClient.waitForTransactionReceipt({ hash: h });
  return h;
}

function signedReceiptFor(escrowId, label, amount, acceptance) {
  const receipt = createReceipt({
    jobId: `arc-e2e-${label}-${Date.now()}`,
    seller: { id: sellerKey.did, name: "render.example" },
    buyer: { id: `${NETWORK}:${buyer.account.address}` },
    inputSha256: [sha256Hex(`source for ${label}`)],
    outputSha256: sha256Hex(`render output for ${label}`),
    payment: {
      rail: "escrow:receptum-evm",
      network: NETWORK,
      asset: net.usdc,
      amount: amount.toString(),
      reference: escrowId,
      payer: `${NETWORK}:${buyer.account.address}`,
    },
    acceptance,
    remedy: { kind: "rerender", withinDays: 30 },
  });
  const signed = signReceipt(receipt, sellerKey);
  if (!verifySignedReceipt(signed).ok) throw new Error("signature check failed");
  return signed;
}

const b = new EvmEscrowRail(buyer);
const s = new EvmEscrowRail(seller);

console.log("funding seller and deployer with gas…");
results.funding = {
  deployer: await topUp(deployer.account.address, 3_000_000n),
  seller: await topUp(seller.account.address, 2_000_000n),
};

console.log("deploying ReceptumEscrow…");
const contract = await deployEscrow(deployer);
results.contract = contract;
console.log("  contract", contract);

// A — buyer acceptance
{
  const amount = 2_500_000n;
  const t = await now();
  const { escrowId, approve, open } = await b.open({
    contract,
    seller: seller.account.address,
    amount,
    deliverBy: new Date((t + 600) * 1000),
    reviewWindowSeconds: 3600,
  });
  const signed = signedReceiptFor(escrowId, "accept", amount, {
    mode: "buyer",
    reviewWindowSeconds: 3600,
  });
  const deliver = await s.deliver(escrowId, signed.receiptHash);
  const onChain = await b.getEscrow(escrowId);
  if (onChain.receiptHash !== receiptHash(signed.receipt))
    throw new Error("on-chain receiptHash mismatch");
  const accept = await b.accept(escrowId);
  results.flows.push({
    name: "A · buyer accepts",
    escrowId,
    status: (await b.getEscrow(escrowId)).status,
    txs: { approve, open, deliver: deliver.reference, accept: accept.reference },
    signedReceipt: signed,
  });
  console.log("A done", escrowId);
}

// B — auto-release after the review window
{
  const amount = 1_000_000n;
  const t = await now();
  const { escrowId, approve, open } = await b.open({
    contract,
    seller: seller.account.address,
    amount,
    deliverBy: new Date((t + 600) * 1000),
    reviewWindowSeconds: 45,
  });
  const signed = signedReceiptFor(escrowId, "auto", amount, {
    mode: "auto",
    reviewWindowSeconds: 45,
  });
  const deliver = await s.deliver(escrowId, signed.receiptHash);
  let early;
  try {
    await s.release(escrowId);
    early = "UNEXPECTED: release succeeded early";
  } catch {
    early = "refused before the review window ended (expected)";
  }
  await sleep(50);
  const release = await s.release(escrowId);
  results.flows.push({
    name: "B · auto-release after review window",
    escrowId,
    status: (await b.getEscrow(escrowId)).status,
    earlyRelease: early,
    txs: { approve, open, deliver: deliver.reference, release: release.reference },
    signedReceipt: signed,
  });
  console.log("B done", escrowId);
}

// C — refund when nothing is delivered by the deadline
{
  const amount = 500_000n;
  const t = await now();
  const { escrowId, approve, open } = await b.open({
    contract,
    seller: seller.account.address,
    amount,
    deliverBy: new Date((t + 40) * 1000),
    reviewWindowSeconds: 60,
  });
  let early;
  try {
    await b.refund(escrowId);
    early = "UNEXPECTED: refund succeeded early";
  } catch {
    early = "refused before the deadline (expected)";
  }
  await sleep(50);
  const refund = await b.refund(escrowId);
  results.flows.push({
    name: "C · refund after missed deadline",
    escrowId,
    status: (await b.getEscrow(escrowId)).status,
    earlyRefund: early,
    txs: { approve, open, refund: refund.reference },
  });
  console.log("C done", escrowId);
}

// D — standalone anchor (for direct x402 payments without escrow)
{
  const signed = signedReceiptFor(`${NETWORK}:demo-x402`, "anchor", 100_000n, {
    mode: "auto",
    reviewWindowSeconds: 0,
  });
  const anchor = await new EvmAnchor(seller).anchor(signed.receiptHash);
  const found = await new EvmAnchor(seller).find(signed.receiptHash, {
    reference: anchor.reference,
  });
  results.flows.push({
    name: "D · standalone anchor",
    status: found ? "anchored" : "NOT FOUND",
    txs: { anchor: anchor.reference },
    signedReceipt: signed,
  });
  console.log("D done");
}

results.balances = {
  buyer: formatUnits(await usdcBalance(buyer.account.address), 6),
  seller: formatUnits(await usdcBalance(seller.account.address), 6),
};
writeFileSync(
  new URL("../e2e-results.json", import.meta.url),
  JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
);

const md = [
  "# Arc testnet end-to-end results",
  "",
  `Run ${new Date().toISOString()} · network \`${NETWORK}\` · contract [\`${contract}\`](${net.explorer}/address/${contract})`,
  "",
  `Buyer \`${buyer.account.address}\` · seller \`${seller.account.address}\` · seller signing key \`${sellerKey.did}\``,
  "",
  "| Flow | Escrow | Final status | Transactions |",
  "|---|---|---|---|",
  ...results.flows.map(
    (f) =>
      `| ${f.name} | ${f.escrowId ? `\`${f.escrowId.split(":").pop()}\`` : "—"} | ${f.status} | ${Object.entries(
        f.txs,
      )
        .map(([k, h]) => `[${k}](${tx(h)})`)
        .join(" · ")} |`,
  ),
  "",
  ...results.flows
    .filter((f) => f.earlyRelease || f.earlyRefund)
    .map((f) => `- ${f.name}: ${f.earlyRelease ?? f.earlyRefund}`),
  "",
  "Full signed receipts: `e2e-results.json`. No private keys are stored in this repository.",
  "",
].join("\n");
writeFileSync(new URL("../E2E_RESULTS.md", import.meta.url), md);
console.log(md);
