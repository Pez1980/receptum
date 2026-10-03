// End-to-end run of ReceptumEscrow on an EVM testnet (not part of CI).
//
//   node scripts/e2e-testnet.mjs [network]     # default eip155:5042002 (Arc testnet)
//   node scripts/e2e-testnet.mjs eip155:421614 # Arbitrum Sepolia
//
// Testnets only: mainnets (and unknown networks) are refused. Wallets are read from
// $RECEPTUM_WALLETS_DIR (default ~/.config/receptum/wallets) and never written to the repo.
// The deployer pays gas and the buyer holds the test USDC; on chains where gas is not USDC (every
// testnet except Arc), the deployer also tops up buyer and seller with native gas.
// When examples/bindings/evm-<slug>.json exists, the seller's account binding for this network is
// attached to every signed receipt, and the released deliverables are published to
// examples/deliverables/<slug>-escrow-{a,b}.txt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { erc20Abi, formatEther, formatUnits, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createReceipt,
  receiptHash,
  sellerKeyFromPem,
  sha256Hex,
  signReceipt,
  verifyAccountBinding,
  verifySignedReceipt,
} from "@receptum/core";
import {
  clientsFor,
  deployEscrow,
  evmBindingVerifier,
  EvmAnchor,
  EvmEscrowRail,
  TESTNETS,
} from "../dist/index.js";

/** Short names used for result files, deliverables and bindings. */
const SLUGS = {
  "eip155:5042002": "arc-testnet",
  "eip155:84532": "base-sepolia",
  "eip155:421614": "arbitrum-sepolia",
};
const NETWORK = process.argv[2] ?? "eip155:5042002";
const net = TESTNETS[NETWORK];
if (!net || !SLUGS[NETWORK])
  throw new Error(
    `refusing ${NETWORK}: e2e-testnet runs only on ${Object.keys(SLUGS).join(", ")} (testnets)`,
  );
const SLUG = SLUGS[NETWORK];
const IS_ARC = NETWORK === "eip155:5042002";
// Arc keeps its original file names (scripts/verify-examples.mjs reads e2e-results.json).
const RESULTS_FILE = IS_ARC ? "../e2e-results.json" : `../e2e-results.${SLUG}.json`;
const repo = new URL("../../../", import.meta.url);

const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
const sellerKey = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));
const rpcUrl = process.env.RECEPTUM_E2E_RPC;
const buyer = clientsFor(NETWORK, privateKeyToAccount(wallets.buyer.privateKey), rpcUrl);
const seller = clientsFor(NETWORK, privateKeyToAccount(wallets.seller.privateKey), rpcUrl);
const deployer = clientsFor(NETWORK, privateKeyToAccount(wallets.deployer.privateKey), rpcUrl);
for (const c of [buyer, seller, deployer]) c.publicClient.pollingInterval = 500;

// The seller's public account binding (SPEC §4.1) for this network, if published.
const bindingUrl = new URL(`examples/bindings/evm-${SLUG}.json`, repo);
const binding = existsSync(bindingUrl) ? JSON.parse(readFileSync(bindingUrl, "utf8")) : null;
if (binding) {
  const want = `${NETWORK}:${seller.account.address}`;
  if (binding.statement.account.toLowerCase() !== want.toLowerCase())
    throw new Error(`binding is for ${binding.statement.account}, expected ${want}`);
  const check = verifyAccountBinding(binding, { verifiers: [evmBindingVerifier] });
  if (!check.ok) throw new Error(`binding does not verify: ${check.reason}`);
}

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

async function topUpGas(to, wei) {
  if ((await buyer.publicClient.getBalance({ address: to })) >= wei) return null;
  const h = await deployer.walletClient.sendTransaction({
    to,
    value: wei,
    account: deployer.account,
    chain: net.chain,
  });
  await deployer.publicClient.waitForTransactionReceipt({ hash: h });
  return h;
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
    jobId: `${IS_ARC ? "arc" : SLUG}-e2e-${label}-${Date.now()}`,
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
      payee: `${NETWORK}:${seller.account.address}`,
    },
    acceptance,
    remedy: { kind: "rerender", withinDays: 30 },
  });
  const signed = signReceipt(receipt, sellerKey);
  if (!verifySignedReceipt(signed).ok) throw new Error("signature check failed");
  return binding ? { ...signed, bindings: [binding] } : signed;
}

const b = new EvmEscrowRail(buyer);
const s = new EvmEscrowRail(seller);

if (IS_ARC) {
  // On Arc, USDC is the gas token: the buyer funds the others' gas in USDC.
  console.log("funding seller and deployer with gas…");
  results.funding = {
    deployer: await topUp(deployer.account.address, 3_000_000n),
    seller: await topUp(seller.account.address, 2_000_000n),
  };
} else {
  // Elsewhere gas is native ETH: the deployer funds buyer and seller.
  console.log("funding buyer and seller with native gas…");
  results.funding = {
    buyer: await topUpGas(buyer.account.address, parseEther("0.002")),
    seller: await topUpGas(seller.account.address, parseEther("0.002")),
  };
}

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
  ...(IS_ARC
    ? {}
    : { deployerGas: formatEther(await buyer.publicClient.getBalance(deployer.account)) }),
};
results.binding = binding ? `examples/bindings/evm-${SLUG}.json` : null;
writeFileSync(
  new URL(RESULTS_FILE, import.meta.url),
  JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
);

// Synthetic deliverables (outputSha256 = SHA-256 of these bytes) and the flow A input file, so
// released receipts can be re-verified to VERIFIED (scripts/verify-examples.mjs).
if (!IS_ARC) {
  writeFileSync(
    new URL(`examples/deliverables/${SLUG}-escrow-a.txt`, repo),
    "render output for accept",
  );
  writeFileSync(
    new URL(`examples/deliverables/${SLUG}-escrow-b.txt`, repo),
    "render output for auto",
  );
  writeFileSync(
    new URL(`examples/${SLUG}-escrow-a.json`, repo),
    JSON.stringify(results.flows[0].signedReceipt, null, 2) + "\n",
  );
}

const section = [
  `## ${net.chain.name} (\`${NETWORK}\`)`,
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
  `Full signed receipts: \`${RESULTS_FILE.slice(3)}\`.${binding ? ` Receipts carry the seller's account binding \`examples/bindings/evm-${SLUG}.json\`.` : ""}`,
  "",
].join("\n");

// E2E_RESULTS.md keeps one section per network; re-running replaces only this network's section.
const mdUrl = new URL("../E2E_RESULTS.md", import.meta.url);
const begin = `<!-- e2e:${NETWORK} -->`;
const end = `<!-- /e2e:${NETWORK} -->`;
const block = `${begin}\n\n${section}\n${end}`;
let md = existsSync(mdUrl)
  ? readFileSync(mdUrl, "utf8")
  : "# ReceptumEscrow testnet end-to-end results\n\nNo private keys are stored in this repository.\n";
md =
  md.includes(begin) && md.includes(end)
    ? md.slice(0, md.indexOf(begin)) + block + md.slice(md.indexOf(end) + end.length)
    : `${md.trimEnd()}\n\n${block}\n`;
writeFileSync(mdUrl, md);
console.log(section);
