// Paid HTTP job over x402 `exact` (EIP-3009 USDC) with a SELF-HOSTED, IN-PROCESS facilitator, on
// Arc or Base, with a Receptum receipt anchored on the same network.
//
//   pnpm build
//   node examples/x402-self-facilitated/e2e.mjs [--network <caip2>] [--price <usdc>] [--rpc <url>] [--dry-run]
//
// Networks: eip155:5042002 (Arc testnet, the default) and eip155:84532 (Base Sepolia); the mainnets
// eip155:5042 (Arc) and eip155:8453 (Base) only with RECEPTUM_ALLOW_MAINNET=1 and keys from the
// environment (README.md). Arc has no public x402 facilitator, so the seller runs one in process:
// @x402/core's x402Facilitator with @x402/evm's exact facilitator scheme, wired into
// x402ResourceServer as a FacilitatorClient that calls it directly (no HTTP). The facilitator signs
// with the seller's own EVM account, which submits transferWithAuthorization and pays its gas (USDC
// on Arc, ETH on Base), then anchors the receipt hash with EvmAnchor on the same network.
//
// --dry-run goes through the buyer's EIP-712 signature and the facilitator's verify (signature check
// and eth_call simulation of transferWithAuthorization), prints the settlement and anchor it would
// send with gas estimates, and exits before settling: no transaction is sent.
//
// Keys — testnets: $RECEPTUM_WALLETS_DIR/evm-testnet.json (buyer, seller) and seller-ed25519.pem;
// mainnets: only RECEPTUM_MAINNET_BUYER_KEY, RECEPTUM_MAINNET_SELLER_KEY (0x-hex EVM keys) and
// RECEPTUM_MAINNET_SELLER_PEM (absolute path of the seller's Ed25519 PKCS8 PEM); wallet files are
// never read for a mainnet. Prints addresses and DIDs only. Writes only public data:
// examples/x402-<arc|base>-<testnet|mainnet>.json and examples/x402-<…>-output.svg.
import { createServer } from "node:http";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  domainSeparator,
  encodeFunctionData,
  formatUnits,
  isAddressEqual,
  parseAbi,
  parseSignature,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { estimateL1Fee } from "viem/op-stack";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { eip3009ABI, toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import {
  createAccountBinding,
  networkClass,
  sellerKeyFromPem,
  sha256Hex,
  verifyAccountBinding,
} from "@receptum/core";
import { handlePaidJob } from "@receptum/server";
import { createReceptumFetch } from "@receptum/client";
import { verify } from "@receptum/verify";
import {
  anchorCalldata,
  assertSigningNetwork,
  clientsFor,
  evmAccountSigner,
  evmBindingVerifier,
  EvmAnchor,
  NETWORKS,
} from "@receptum/adapter-evm";

/**
 * The networks this example runs on. USDC address, chain, RPC and explorer come from
 * `@receptum/adapter-evm` NETWORKS. `token` is the USDC EIP-712 domain the buyer signs — checked
 * on-chain (name, version, decimals and DOMAIN_SEPARATOR) before anything is signed; read-only
 * eth_calls on 13 Oct 2026 returned exactly these on all four networks. The seller pays the
 * settlement and anchor gas in the chain's gas token and must hold at least `minGas` of it.
 */
const SUPPORTED = {
  "eip155:5042002": {
    slug: "arc-testnet",
    label: "Arc testnet",
    gas: "USDC",
    minGas: "0.02",
    buyerMargin: "0.02",
    token: { name: "USDC", version: "2" },
    binding: "evm-arc-testnet.json",
  },
  "eip155:5042": {
    slug: "arc-mainnet",
    label: "Arc",
    gas: "USDC",
    minGas: "0.02",
    buyerMargin: "0.02",
    token: { name: "USDC", version: "2" },
  },
  "eip155:84532": {
    slug: "base-testnet",
    label: "Base Sepolia",
    gas: "ETH",
    minGas: "0.00005",
    buyerMargin: "0",
    token: { name: "USDC", version: "2" },
    binding: "evm-base-sepolia.json",
  },
  "eip155:8453": {
    slug: "base-mainnet",
    label: "Base",
    gas: "ETH",
    minGas: "0.00005",
    buyerMargin: "0",
    token: { name: "USD Coin", version: "2" },
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "..");

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

// Secrets are kept only to redact them from any error output and to refuse writing them.
const secrets = [];
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const redact = (text) =>
  secrets.reduce(
    (t, s) => t.replace(new RegExp(escapeRegExp(s), "gi"), "[redacted]"),
    String(text),
  );

const { values: args } = parseArgs({
  options: {
    network: { type: "string", default: "eip155:5042002" },
    price: { type: "string" },
    rpc: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const NETWORK = args.network;
const DRY_RUN = args["dry-run"];

async function main() {
  if (!Object.hasOwn(SUPPORTED, NETWORK))
    refuse(`--network must be one of ${Object.keys(SUPPORTED).join(", ")}`);
  const cfg = SUPPORTED[NETWORK];
  const net = NETWORKS[NETWORK];
  const MAINNET = networkClass(NETWORK) === "mainnet";
  if (MAINNET !== (net.mainnet === true)) refuse(`${NETWORK}: inconsistent network registries`);
  // The repo's opt-in (docs/MAINNET.md §2), checked before any key is read or anything signed.
  if (MAINNET && process.env.RECEPTUM_ALLOW_MAINNET !== "1")
    refuse(
      `${NETWORK} is a mainnet (real funds): set RECEPTUM_ALLOW_MAINNET=1 to opt in (docs/MAINNET.md §2)`,
    );

  const priceText = args.price ?? (MAINNET ? "0.01" : "0.25");
  if (!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(priceText))
    refuse("--price must be a USDC amount with at most 6 decimals, e.g. 0.01");
  const PRICE = parseUnits(priceText, 6);
  if (PRICE <= 0n) refuse("--price must be positive");
  if (MAINNET && PRICE > 1_000_000n) refuse("this example refuses a mainnet price above 1 USDC");

  // ─── Keys ──────────────────────────────────────────────────────────────────
  const keys = MAINNET ? mainnetKeys() : testnetKeys();
  for (const k of [keys.buyerKey, keys.sellerEvmKey]) secrets.push(k.slice(2));
  secrets.push(keys.pem.replace(/-----[^-]+-----|\s/g, ""));
  const buyer = privateKeyToAccount(keys.buyerKey);
  const seller = privateKeyToAccount(keys.sellerEvmKey);
  let sellerKey;
  try {
    sellerKey = sellerKeyFromPem(keys.pem);
  } catch {
    refuse("the seller PEM is not an Ed25519 PKCS8 private key");
  }
  if (isAddressEqual(buyer.address, seller.address)) refuse("buyer and seller must differ");
  if (MAINNET) {
    // docs/MAINNET.md §4: fresh keys for every mainnet account, no testnet key promoted.
    const known = publishedTestnetIdentities();
    for (const [who, id] of [
      ["seller did:key", sellerKey.did],
      ["seller account", seller.address.toLowerCase()],
      ["buyer account", buyer.address.toLowerCase()],
    ])
      if (known.has(id))
        refuse(`the mainnet ${who} ${id} is a published testnet identity; use fresh mainnet keys`);
  }

  const USDC = net.usdc;
  const txUrl = (hash) => `${net.explorer}/tx/${hash}`;
  console.log(
    `${MAINNET ? "=== MAINNET" : "=== TESTNET"} ${cfg.label} (${NETWORK})${DRY_RUN ? " — DRY RUN, nothing will be sent" : ""} ===`,
  );
  console.log(`buyer  ${buyer.address}`);
  console.log(`seller ${seller.address} (payee, facilitator and anchor signer)`);
  console.log(`seller ${sellerKey.did}`);

  // ─── Chain and token checks (read-only) ───────────────────────────────────
  const sellerClients = clientsFor(NETWORK, seller, {
    allowMainnet: MAINNET,
    ...(args.rpc ? { rpcUrl: args.rpc } : {}),
  });
  const { publicClient } = sellerClients;
  await assertSigningNetwork(sellerClients); // the opt-in again, and the RPC must serve NETWORK
  const tokenAbi = parseAbi([
    "function name() view returns (string)",
    "function version() view returns (string)",
    "function decimals() view returns (uint8)",
    "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const readToken = (functionName, a = []) =>
    publicClient.readContract({ address: USDC, abi: tokenAbi, functionName, args: a });
  const [name, version, decimals, separator] = await Promise.all(
    ["name", "version", "decimals", "DOMAIN_SEPARATOR"].map((f) => readToken(f)),
  );
  const expectedSeparator = domainSeparator({
    domain: { ...cfg.token, chainId: net.chain.id, verifyingContract: USDC },
  });
  if (
    name !== cfg.token.name ||
    version !== cfg.token.version ||
    Number(decimals) !== 6 ||
    separator.toLowerCase() !== expectedSeparator.toLowerCase()
  )
    refuse(
      `USDC ${USDC} reports ${JSON.stringify({ name, version, decimals: Number(decimals) })} with DOMAIN_SEPARATOR ${separator}; expected ${JSON.stringify({ ...cfg.token, decimals: 6 })} — refusing to sign`,
    );
  console.log(`USDC   ${USDC} — EIP-712 "${name}" v${version}, 6 decimals (checked on-chain)`);

  const usdc = (n) => `${formatUnits(n, 6)} USDC`;
  const gas = (n) => `${formatUnits(n, 18)} ${cfg.gas}`;
  const balances = async () => {
    const [buyerUsdc, sellerUsdc, sellerGas] = await Promise.all([
      readToken("balanceOf", [buyer.address]),
      readToken("balanceOf", [seller.address]),
      publicClient.getBalance({ address: seller.address }),
    ]);
    return { buyerUsdc, sellerUsdc, sellerGas };
  };
  const before = await balances();
  console.log(`price  ${usdc(PRICE)}`);
  console.log(`buyer  balance ${usdc(before.buyerUsdc)}`);
  console.log(
    `seller balance ${usdc(before.sellerUsdc)}; gas ${gas(before.sellerGas)}${cfg.gas === "USDC" ? " (native USDC, 18 decimals — the same funds)" : ""}`,
  );
  // A real run refuses here; a dry run reports what a real run would refuse and keeps going (it
  // never sends), so one dry run shows every problem and still prices the transactions.
  const wouldRefuse = [];
  const preflight = (ok, message) => {
    if (ok) return;
    if (!DRY_RUN) refuse(message);
    wouldRefuse.push(message);
    console.log(`WOULD REFUSE: ${message}`);
  };
  preflight(
    before.sellerGas >= parseUnits(cfg.minGas, 18),
    `the seller pays the settlement and anchor gas on ${cfg.label} in ${cfg.gas} and holds ${gas(before.sellerGas)}; it needs at least ${cfg.minGas} ${cfg.gas}`,
  );
  const buyerNeeds = PRICE + parseUnits(cfg.buyerMargin, 6);
  preflight(
    before.buyerUsdc >= buyerNeeds,
    `the buyer holds ${usdc(before.buyerUsdc)} and needs ${usdc(buyerNeeds)} (price${cfg.buyerMargin === "0" ? "" : ` + ${cfg.buyerMargin} USDC margin`})`,
  );

  // ─── Seller: binding, in-process facilitator, resource server ─────────────
  const { binding, source } = await sellerBinding(sellerKey, seller, cfg, MAINNET);
  console.log(`binding ${binding.statement.account} ↔ ${binding.statement.did} (${source})`);

  const facilitatorSigner = toFacilitatorEvmSigner(
    {
      address: seller.address,
      getCode: (a) => publicClient.getCode(a),
      readContract: (a) => publicClient.readContract({ ...a, args: a.args ?? [] }),
      verifyTypedData: (a) => publicClient.verifyTypedData(a),
      async writeContract(a) {
        if (DRY_RUN) throw new Error("dry run: the facilitator never sends");
        if (a.functionName !== "transferWithAuthorization" || !isAddressEqual(a.address, USDC))
          throw new Error(`the facilitator only submits USDC transferWithAuthorization`);
        await assertSigningNetwork(sellerClients);
        return sellerClients.walletClient.writeContract({
          ...a,
          account: seller,
          chain: net.chain,
        });
      },
      async sendTransaction() {
        throw new Error("the facilitator sends no raw transactions (ERC-6492 deployment is off)");
      },
      waitForTransactionReceipt: (a) => publicClient.waitForTransactionReceipt(a),
    },
    { confirmationTimeoutMs: 120_000 },
  );
  const facilitator = new x402Facilitator().register(
    NETWORK,
    new ExactEvmFacilitator(facilitatorSigner), // no ERC-6492 factories, no simulation in settle
  );

  /** Prices the settlement and anchor the facilitator would send (eth_estimateGas, read-only). */
  async function planTransactions(payload) {
    const auth = payload.payload.authorization;
    const signature = payload.payload.signature;
    const head = [
      auth.from,
      auth.to,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
    ];
    const sig = signature.length === 132 ? parseSignature(signature) : undefined;
    const settleData = encodeFunctionData({
      abi: eip3009ABI,
      functionName: "transferWithAuthorization",
      args: sig ? [...head, sig.v ?? BigInt(sig.yParity + 27), sig.r, sig.s] : [...head, signature],
    });
    // The real anchor commits the final receiptHash; its calldata size and cost are the same.
    const anchorData = anchorCalldata(sha256Hex(settleData));
    const txs = {
      settlement: { account: seller.address, to: USDC, data: settleData },
      anchor: { account: seller.address, to: seller.address, value: 0n, data: anchorData },
    };
    const [fees, gasPrice] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      publicClient.getGasPrice(),
    ]);
    const plan = {};
    for (const [step, tx] of Object.entries(txs)) {
      const gasLimit = await publicClient.estimateGas(tx);
      const l1Fee = net.chain.contracts?.gasPriceOracle
        ? await estimateL1Fee(publicClient, { ...tx, chain: net.chain })
        : 0n;
      plan[step] = {
        to: tx.to,
        dataBytes: (tx.data.length - 2) / 2,
        gasLimit,
        cost: gasLimit * gasPrice + l1Fee,
        maxCost: gasLimit * fees.maxFeePerGas + l1Fee,
        l1Fee,
      };
    }
    plan.cost = plan.settlement.cost + plan.anchor.cost;
    plan.maxCost = plan.settlement.maxCost + plan.anchor.maxCost;
    return plan;
  }

  const printPlan = (plan, sellerGas) => {
    const line = (label, p, what) =>
      console.log(
        `${label} to ${p.to} · ${what} · data ${p.dataBytes} bytes · est. gas ${p.gasLimit} · ≈ ${gas(p.cost)} (max ${gas(p.maxCost)}${p.l1Fee ? `, incl. L1 fee ${gas(p.l1Fee)}` : ""})`,
      );
    line(
      "planned settlement",
      plan.settlement,
      `USDC transferWithAuthorization, from ${seller.address}`,
    );
    line(
      "planned anchor    ",
      plan.anchor,
      `zero-value self-transaction ("receptum/1" ‖ receiptHash)`,
    );
    console.log(
      `seller gas: ≈ ${gas(plan.cost)} (max ${gas(plan.maxCost)}) of ${gas(sellerGas)} available`,
    );
  };

  let dryRunPlan;
  // The in-process FacilitatorClient: x402ResourceServer calls the local facilitator directly.
  const inProcessFacilitator = {
    async verify(payload, requirements) {
      const r = await facilitator.verify(payload, requirements);
      console.log(
        `facilitator verify: ${r.isValid ? "valid (EIP-712 signature, balance, nonce, eth_call simulation)" : `INVALID ${r.invalidReason}${r.invalidMessage ? ` — ${r.invalidMessage}` : ""}`}; payer ${r.payer}`,
      );
      return r;
    },
    async settle(payload, requirements) {
      const failed = (errorReason) => ({
        success: false,
        errorReason,
        transaction: "",
        network: requirements.network,
      });
      let plan;
      try {
        plan = await planTransactions(payload);
      } catch (err) {
        console.error(`settlement simulation failed: ${redact(err?.shortMessage ?? err)}`);
        return failed("settlement_simulation_failed");
      }
      const { sellerGas } = await balances();
      printPlan(plan, sellerGas);
      const covered = sellerGas >= plan.maxCost;
      if (DRY_RUN) {
        preflight(covered, `the seller's ${gas(sellerGas)} can't cover the planned gas`);
        dryRunPlan = plan;
        return failed("dry_run");
      }
      if (!covered) {
        console.error(`refusing to settle: the seller's ${gas(sellerGas)} can't cover the gas`);
        return failed("insufficient_gas");
      }
      return facilitator.settle(payload, requirements);
    },
    getSupported: async () => facilitator.getSupported(),
  };
  const kind = facilitator.getSupported().kinds.find((k) => k.network === NETWORK);
  console.log(`in-process facilitator: ${JSON.stringify(kind)} signer ${seller.address}`);
  const x402 = new x402ResourceServer(inProcessFacilitator).register(NETWORK, new ExactEvmServer());
  await x402.initialize();

  const anchor = new EvmAnchor(sellerClients);
  let anchored;
  const render = (prompt) =>
    new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="#0F1115"/><text x="80" y="330" fill="#F7F5EF" font-family="sans-serif" font-size="56">${prompt.replace(/[<>&"]/g, "").slice(0, 80)}</text><text x="80" y="400" fill="#8A8F98" font-family="monospace" font-size="24">paid on ${cfg.label} · self-hosted x402 facilitator · receipt attached</text></svg>`,
    );
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/render") {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 16 * 1024) throw new Error("request body too large");
        chunks.push(c);
      }
      const input = Buffer.concat(chunks);
      const prompt = input.length ? String(JSON.parse(input.toString()).prompt ?? "") : "Hello";
      const result = await handlePaidJob(
        (h) => req.headers[h.toLowerCase()],
        async () => ({
          jobId: `${cfg.slug}-render-${Date.now()}`,
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
              // Explicit asset and EIP-712 domain (checked on-chain above), not x402's defaults.
              price: { amount: PRICE.toString(), asset: USDC, extra: { ...cfg.token } },
              maxTimeoutSeconds: 120,
            },
          ],
          resource: {
            url: `http://127.0.0.1:${server.address().port}/render`,
            description: "Render a title card",
            mimeType: "image/svg+xml",
          },
          seller: { ...sellerKey, name: `render.example (${cfg.slug})` },
          acceptance: { mode: "auto", reviewWindowSeconds: 0 },
          remedy: { kind: "rerender", withinDays: 30 },
          anchor,
          bindings: [binding],
          bindingVerifiers: [evmBindingVerifier], // refuse to charge unless it covers payTo
          allowMainnet: MAINNET,
        },
      );
      if (result.anchor) anchored = result.anchor;
      res.writeHead(result.status, result.headers).end(result.body);
    } catch (err) {
      console.error("seller:", redact(err?.stack ?? err));
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/render`;
  console.log(`seller listening on ${url}`);

  // ─── Buyer agent ───────────────────────────────────────────────────────────
  try {
    const wanted = (r) =>
      r.scheme === "exact" &&
      r.network === NETWORK &&
      isAddressEqual(r.asset, USDC) &&
      isAddressEqual(r.payTo, seller.address) &&
      BigInt(r.amount) <= PRICE;
    const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: NETWORK, client: new ExactEvmClient(buyer) }],
      // Sign only for this seller, this USDC and at most the price.
      policies: [(_version, requirements) => requirements.filter(wanted)],
      spendControls: {
        allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: PRICE.toString() }],
      },
    });
    const requestBody = JSON.stringify({ prompt: "Know what you paid for." });
    const buy = createReceptumFetch({
      paidFetch,
      networks: [NETWORK], // what paidFetch is registered to pay on (required)
      allowMainnet: MAINNET,
      allowedSellers: [sellerKey.did],
      requireBinding: true,
      bindingVerifiers: [evmBindingVerifier],
      expected: {
        network: NETWORK,
        asset: USDC,
        amount: PRICE.toString(),
        payee: `${NETWORK}:${seller.address}`,
        payer: buyer.address,
        inputSha256: [sha256Hex(requestBody)],
      },
    });

    let result;
    try {
      result = await buy(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
    } catch (err) {
      if (!DRY_RUN || !dryRunPlan) throw err;
    }
    if (DRY_RUN) {
      if (result || !dryRunPlan) throw new Error("dry run did not stop before settlement");
      console.log(
        `\nDRY RUN on ${NETWORK}: the buyer signed an EIP-3009 authorization for ${usdc(PRICE)} (kept in this process, never submitted), the in-process facilitator verified it, and the job and receipt preflight passed. Nothing was sent; no balance changed.`,
      );
      if (wouldRefuse.length)
        throw new Refusal(`a real run would refuse: ${wouldRefuse.join("; ")}`);
      console.log("DRY RUN OK: a real run would settle and anchor as planned.");
      return;
    }

    console.log("client check:", result.check);
    console.log("settlement:", result.settlement?.transaction, "on", result.settlement?.network);
    if (!anchored) throw new Error("the receipt was not anchored");
    const anchorRef = `${NETWORK}:${anchored.reference}`;
    console.log("anchor:", anchorRef);

    let report;
    for (let attempt = 1; ; attempt++) {
      report = await verify(result.receipt, { file: result.body, anchors: [anchorRef] });
      if (report.complete || attempt === 5) break;
      console.log(`verify: ${report.verdict}; retrying in 5 s (RPC propagation)`);
      await sleep(5000);
    }
    for (const c of report.checks) console.log(`[${c.status}] L${c.level} ${c.name} — ${c.detail}`);
    console.log(report.verdict);

    const hash = result.settlement.transaction;
    const record = {
      network: NETWORK,
      facilitator: "self-hosted, in-process (@x402/core x402Facilitator + @x402/evm exact)",
      facilitatorKind: kind,
      facilitatorSigner: seller.address,
      settlement: result.settlement,
      settlementUrl: txUrl(hash),
      anchor: anchorRef,
      anchorUrl: txUrl(anchored.reference),
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
    const svg = Buffer.from(result.body).toString("utf8");
    const lower = (json + svg).toLowerCase();
    if (secrets.some((s) => lower.includes(s.toLowerCase())))
      throw new Error("refusing to write a secret");
    const out = `x402-${cfg.slug}`;
    writeFileSync(join(examples, `${out}.json`), json);
    writeFileSync(join(examples, `${out}-output.svg`), result.body);
    console.log(`wrote examples/${out}.json and examples/${out}-output.svg`);
    console.log("settlement", txUrl(hash));
    console.log("anchor    ", txUrl(anchored.reference));
    if (!report.complete) throw new Error(`receipt is ${report.verdict}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Testnet keys from the shared wallet files (never used for a mainnet). */
function testnetKeys() {
  const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
  const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
  return {
    buyerKey: wallets.buyer.privateKey,
    sellerEvmKey: wallets.seller.privateKey,
    pem: readFileSync(join(dir, "seller-ed25519.pem"), "utf8"),
  };
}

/** Mainnet keys from the environment only; the PEM may not live in a testnet wallet directory. */
function mainnetKeys() {
  const envKey = (name) => {
    const v = process.env[name];
    if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v))
      refuse(`${name} must hold a 0x-prefixed 32-byte hex EVM private key`);
    return v;
  };
  const buyerKey = envKey("RECEPTUM_MAINNET_BUYER_KEY");
  const sellerEvmKey = envKey("RECEPTUM_MAINNET_SELLER_KEY");
  const pemPath = process.env.RECEPTUM_MAINNET_SELLER_PEM;
  if (!pemPath || !isAbsolute(pemPath))
    refuse("RECEPTUM_MAINNET_SELLER_PEM must be the absolute path of the seller's Ed25519 PEM");
  let real;
  try {
    real = realpathSync(pemPath);
  } catch {
    refuse("RECEPTUM_MAINNET_SELLER_PEM does not exist");
  }
  const testnetDirs = [
    process.env.RECEPTUM_WALLETS_DIR,
    join(homedir(), ".config/receptum/wallets"),
  ];
  for (const dir of testnetDirs.filter(Boolean)) {
    let d;
    try {
      d = realpathSync(dir);
    } catch {
      continue;
    }
    const rel = relative(d, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      refuse("RECEPTUM_MAINNET_SELLER_PEM is in the testnet wallets directory; use a mainnet key");
  }
  if (!statSync(real).isFile()) refuse("RECEPTUM_MAINNET_SELLER_PEM is not a regular file");
  return { buyerKey, sellerEvmKey, pem: readFileSync(real, "utf8") };
}

/** Seller DIDs and EVM accounts that the repo's public testnet bindings and receipts use. */
function publishedTestnetIdentities() {
  const ids = new Set();
  const testnet = (caip10) =>
    networkClass(String(caip10).split(":").slice(0, 2).join(":")) === "testnet";
  const addAccount = (caip10) => {
    if (typeof caip10 === "string" && testnet(caip10))
      ids.add(caip10.split(":").pop().toLowerCase());
  };
  const files = [
    ...readdirSync(join(examples, "bindings")).map((f) => join(examples, "bindings", f)),
    ...readdirSync(examples).map((f) => join(examples, f)),
  ].filter((f) => f.endsWith(".json"));
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (doc?.statement?.account && testnet(doc.statement.account)) {
      ids.add(doc.statement.did);
      addAccount(doc.statement.account);
    }
    const r = doc?.signedReceipt?.receipt;
    if (r?.payment && networkClass(r.payment.network) === "testnet") {
      ids.add(r.seller?.id);
      addAccount(r.payment.payee);
      addAccount(r.payment.payer);
    }
  }
  return ids;
}

/**
 * The seller's account binding (SPEC §4.1) for payTo on this network: the published testnet binding
 * when it matches the keys, otherwise a fresh one (always on a mainnet), signed EIP-191 by the payout
 * account. Off-chain signatures only; the binding travels in the receipt.
 */
async function sellerBinding(sellerKey, seller, cfg, mainnet) {
  const account = `${NETWORK}:${seller.address}`.toLowerCase();
  const verifiers = [evmBindingVerifier];
  if (!mainnet && cfg.binding) {
    const published = JSON.parse(readFileSync(join(examples, "bindings", cfg.binding), "utf8"));
    const lasting = verifyAccountBinding(published, {
      verifiers,
      at: new Date(Date.now() + 3_600_000),
    });
    if (
      published.statement.did === sellerKey.did &&
      published.statement.account.toLowerCase() === account &&
      lasting.ok
    )
      return { binding: published, source: `examples/bindings/${cfg.binding}` };
  }
  const issuedAt = new Date();
  const binding = await createAccountBinding({
    key: sellerKey,
    signer: evmAccountSigner(seller, NETWORK),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 365 * 86_400_000),
  });
  const check = verifyAccountBinding(binding, { verifiers });
  if (!check.ok) throw new Error(`binding: ${check.reason}`);
  return { binding, source: "created for this run, EIP-191 by the payout account" };
}

main().catch((err) => {
  console.error(
    err instanceof Refusal ? `refusing: ${redact(err.message)}` : redact(err?.stack ?? err),
  );
  process.exitCode = 1;
});
