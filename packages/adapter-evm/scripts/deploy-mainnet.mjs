#!/usr/bin/env node
// Deploys ReceptumEscrow to an EVM MAINNET (Base eip155:8453, Arc eip155:5042 or Arbitrum One eip155:42161). Not part of CI.
//
//   pnpm --filter @receptum/adapter-evm build
//   RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_KEY=0x… \
//     node packages/adapter-evm/scripts/deploy-mainnet.mjs eip155:8453 --audit-report <url> [--rpc <url>]
//
// Safety rules, all enforced before anything is signed:
//   - refuses unless RECEPTUM_ALLOW_MAINNET=1;
//   - refuses without --audit-report: escrow contracts hold customer funds and go to mainnet only
//     after an independent audit (SECURITY.md, docs/MAINNET.md §0);
//   - the deployer key comes ONLY from RECEPTUM_MAINNET_DEPLOYER_KEY (a fresh key, never a testnet
//     one). This script never reads wallet files — in particular not the testnet wallets under
//     $RECEPTUM_WALLETS_DIR / ~/.config/receptum;
//   - prints the plan (network, chain id, RPC, deployer, balance, estimated gas and cost, code
//     hash) and requires typing the exact confirmation phrase on an interactive terminal;
//   - `--dry-run` prints the plan and exits without signing.
// After deploying, publish the deployment record and only then add the address to
// TRUSTED_ESCROWS in packages/verify (and verifiers/python) in a reviewed change.
import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAINNET_IDS = ["eip155:8453", "eip155:5042", "eip155:42161"];
export const KEY_ENV = "RECEPTUM_MAINNET_DEPLOYER_KEY";

const USAGE =
  "usage: RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_KEY=0x… node deploy-mainnet.mjs <eip155:8453|eip155:5042|eip155:42161> --audit-report <url> [--rpc <url>] [--dry-run] [--out <file>]";

export class Refusal extends Error {}

function parse(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--audit-report" || a === "--rpc" || a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Refusal(`${a} needs a value\n${USAGE}`);
      args[{ "--audit-report": "auditReport", "--rpc": "rpc", "--out": "out" }[a]] = v;
    } else if (a.startsWith("--")) throw new Refusal(`unknown option ${a}\n${USAGE}`);
    else args.positional.push(a);
  }
  return args;
}

/** The phrase the operator must type to confirm. */
export const confirmationPhrase = (network) => `deploy ReceptumEscrow to ${network}`;

async function defaultDeps() {
  const viem = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const evm = await import("../dist/index.js");
  return {
    accountFromKey: (key) => privateKeyToAccount(key),
    clientsFor: evm.clientsFor,
    deployEscrow: evm.deployEscrow,
    bytecode: evm.receptumEscrowBytecode,
    deployedBytecode: evm.receptumEscrowDeployedBytecode,
    keccak256: viem.keccak256,
    formatEther: viem.formatEther,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
    writeFile: (path, data) => writeFileSync(path, data, { flag: "wx" }),
  };
}

/**
 * Runs the deployment. Every refusal throws `Refusal` before any key is used to sign.
 * `deps` is injectable for tests (mocked clients — nothing reaches a real network).
 */
export async function run({ argv, env, log = console.log, deps }) {
  const args = parse(argv);
  if (env.RECEPTUM_ALLOW_MAINNET !== "1")
    throw new Refusal(`refusing: set RECEPTUM_ALLOW_MAINNET=1 to deploy to a mainnet\n${USAGE}`);
  const [network, ...extra] = args.positional;
  if (!network || extra.length) throw new Refusal(USAGE);
  if (!MAINNET_IDS.includes(network))
    throw new Refusal(
      `refusing: ${network} is not a supported mainnet (${MAINNET_IDS.join(", ")}); testnet deployments use e2e-testnet.mjs`,
    );
  if (!args.auditReport || !/^https:\/\//.test(args.auditReport))
    throw new Refusal(
      "refusing: --audit-report <https://…> is required — ReceptumEscrow holds customer funds and goes to mainnet only after an independent audit (docs/MAINNET.md §0)",
    );
  const key = env[KEY_ENV];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Refusal(
      `refusing: ${KEY_ENV} must hold the fresh mainnet deployer key (0x + 64 hex). Wallet files are never read.`,
    );

  const d = deps ?? (await defaultDeps());
  const account = d.accountFromKey(key);
  const c = d.clientsFor(network, account, {
    allowMainnet: true,
    ...(args.rpc ? { rpcUrl: args.rpc } : {}),
  });
  const chainId = await c.publicClient.getChainId();
  if (`eip155:${chainId}` !== network)
    throw new Refusal(`refusing: RPC serves chain ${chainId}, expected ${network}`);
  const [balance, gas, gasPrice] = await Promise.all([
    c.publicClient.getBalance({ address: account.address }),
    c.publicClient.estimateGas({ account: account.address, data: d.bytecode }),
    c.publicClient.getGasPrice(),
  ]);
  const cost = gas * gasPrice;
  const plan = {
    network,
    chainId,
    rpc: args.rpc ?? c.network.chain.rpcUrls.default.http[0],
    explorer: c.network.explorer,
    deployer: account.address,
    deployerBalance: `${d.formatEther(balance)} (native gas token)`,
    estimatedGas: gas.toString(),
    gasPrice: gasPrice.toString(),
    estimatedCost: `${d.formatEther(cost)} (native gas token)`,
    runtimeCodeHash: d.keccak256(d.deployedBytecode),
    auditReport: args.auditReport,
  };
  log("ReceptumEscrow MAINNET deployment plan");
  for (const [k, v] of Object.entries(plan)) log(`  ${k.padEnd(16)} ${v}`);
  if (balance < cost)
    throw new Refusal(
      "refusing: the deployer cannot pay the estimated gas — fund the fresh key first",
    );
  if (args.dryRun) {
    log("dry run: nothing signed");
    return { plan, deployed: false };
  }
  if (!d.isTTY) throw new Refusal("refusing: confirmation needs an interactive terminal");
  const phrase = confirmationPhrase(network);
  const answer = await d.ask(`Type "${phrase}" to sign and broadcast: `);
  if (answer.trim() !== phrase) throw new Refusal("refusing: confirmation did not match");

  const address = await d.deployEscrow(c);
  const record = { ...plan, contract: address, deployedAt: new Date().toISOString() };
  log(`deployed ${address} — ${c.network.explorer}/address/${address}`);
  const out = args.out ?? `deployment.${network.replace(":", "-")}.json`;
  d.writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  log(`wrote ${out}. Publish it, then add ${address} to TRUSTED_ESCROWS["${network}"].`);
  return { plan, deployed: true, address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run({ argv: process.argv.slice(2), env: process.env });
  } catch (err) {
    console.error(err instanceof Refusal ? err.message : err);
    process.exit(err instanceof Refusal ? 2 : 1);
  }
}
