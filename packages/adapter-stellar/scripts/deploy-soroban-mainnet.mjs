#!/usr/bin/env node
// Deploys contracts/receptum-escrow/receptum_escrow.wasm to Stellar PUBNET (mainnet). Not in CI.
//
//   pnpm --filter @receptum/adapter-stellar build
//   RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_SECRET=S… \
//     node packages/adapter-stellar/scripts/deploy-soroban-mainnet.mjs --audit-report <url> [--rpc <url>] [--max-fee-xlm 50]
//
// Same refusal rules as packages/adapter-evm/scripts/deploy-mainnet.mjs, all enforced before
// anything is signed:
//   - refuses unless RECEPTUM_ALLOW_MAINNET=1;
//   - refuses without --audit-report: the escrow holds customer funds and goes to mainnet only
//     after an independent audit (SECURITY.md, docs/MAINNET.md §0);
//   - refuses unless the wasm's SHA-256 equals RECEPTUM_SOROBAN_WASM_HASH (the reproducible build);
//   - the deployer secret comes ONLY from RECEPTUM_MAINNET_DEPLOYER_SECRET (a fresh key, never a
//     testnet one). This script never reads wallet files — in particular not
//     $RECEPTUM_WALLETS_DIR/stellar-testnet.json or anything under ~/.config/receptum;
//   - checks the RPC's passphrase is the public network's, prints the plan (network, RPC,
//     deployer, balance, simulated fees, wasm hash) and requires typing the exact confirmation
//     phrase on an interactive terminal; `--dry-run` stops after the plan.
// The contract has no admin and no upgrade path; the deployer gets no special rights.
// After deploying, publish deployment.pubnet.json and only then add the contract id to
// TRUSTED_ESCROWS["stellar:pubnet"] in a reviewed change.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const SECRET_ENV = "RECEPTUM_MAINNET_DEPLOYER_SECRET";
export const confirmationPhrase = () => "deploy ReceptumEscrow to stellar:pubnet";

const USAGE =
  "usage: RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_SECRET=S… node deploy-soroban-mainnet.mjs --audit-report <https://…> [--rpc <url>] [--max-fee-xlm <n>] [--dry-run] [--out <file>]";
const STROOPS = 10_000_000n;

export class Refusal extends Error {}

function parse(argv) {
  const keys = {
    "--audit-report": "auditReport",
    "--rpc": "rpc",
    "--out": "out",
    "--max-fee-xlm": "maxFeeXlm",
  };
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (keys[a]) {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Refusal(`${a} needs a value\n${USAGE}`);
      args[keys[a]] = v;
    } else throw new Refusal(`unexpected argument ${a}\n${USAGE}`);
  }
  return args;
}

const xlm = (stroops) => {
  const s = BigInt(stroops);
  return `${s / STROOPS}.${(s % STROOPS).toString().padStart(7, "0")} XLM`;
};

async function defaultDeps() {
  const sdk = await import("@stellar/stellar-sdk");
  const lib = await import("../dist/index.js");
  return {
    sdk,
    lib,
    readWasm: () =>
      readFile(new URL("../contracts/receptum-escrow/receptum_escrow.wasm", import.meta.url)),
    makeRpc: (opts) => new lib.SorobanRpcClient(opts),
    // Read-only Horizon lookup of the deployer's XLM balance (stroops).
    nativeBalance: async (id) => {
      const acc = await new lib.HorizonClient({ network: "pubnet" }).server.loadAccount(id);
      const native = acc.balances.find((b) => b.asset_type === "native");
      if (!native) return 0n;
      const [whole, frac = ""] = native.balance.split(".");
      return BigInt(whole) * STROOPS + BigInt(frac.padEnd(7, "0").slice(0, 7));
    },
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

/** Simulated total fee (stroops) of one host-function operation from `source`. */
async function simulateFee(sdk, client, source, operation) {
  const account = await client.server.getAccount(source);
  const draft = new sdk.TransactionBuilder(account, {
    fee: sdk.BASE_FEE,
    networkPassphrase: client.network.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await client.server.prepareTransaction(draft);
  return BigInt(prepared.fee);
}

/**
 * Runs the deployment. Every refusal throws `Refusal` before any signature. `deps` is injectable
 * for tests (mocked RPC — nothing reaches a real network).
 */
export async function run({ argv, env, log = console.log, deps }) {
  const args = parse(argv);
  if (env.RECEPTUM_ALLOW_MAINNET !== "1")
    throw new Refusal(`refusing: set RECEPTUM_ALLOW_MAINNET=1 to deploy to a mainnet\n${USAGE}`);
  if (!args.auditReport || !/^https:\/\//.test(args.auditReport))
    throw new Refusal(
      "refusing: --audit-report <https://…> is required — ReceptumEscrow holds customer funds and goes to mainnet only after an independent audit (docs/MAINNET.md §0)",
    );
  const maxFee = BigInt(Math.round(Number(args.maxFeeXlm ?? "50") * 1e7));
  if (!(maxFee > 0n)) throw new Refusal("refusing: --max-fee-xlm must be a positive number");
  const secret = env[SECRET_ENV];
  const d = deps ?? (await defaultDeps());
  const { sdk, lib } = d;
  if (!secret || !sdk.StrKey.isValidEd25519SecretSeed(secret))
    throw new Refusal(
      `refusing: ${SECRET_ENV} must hold the fresh mainnet deployer secret (S…). Wallet files are never read.`,
    );

  const wasm = await d.readWasm();
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  if (wasmHash !== lib.RECEPTUM_SOROBAN_WASM_HASH)
    throw new Refusal(
      `refusing: wasm hash ${wasmHash} ≠ RECEPTUM_SOROBAN_WASM_HASH (${lib.RECEPTUM_SOROBAN_WASM_HASH}); rebuild reproducibly`,
    );

  const deployer = sdk.Keypair.fromSecret(secret);
  const client = d.makeRpc({
    network: "pubnet",
    allowMainnet: true,
    ...(args.rpc ? { rpcUrl: args.rpc } : {}),
  });
  if (client.network.networkPassphrase !== sdk.Networks.PUBLIC)
    throw new Refusal("refusing: the RPC client is not configured for pubnet");
  await client.assertNetwork().catch((err) => {
    throw new Refusal(`refusing: ${err.message}`);
  });

  const account = await client.server.getAccount(deployer.publicKey());
  const balance = await d.nativeBalance(deployer.publicKey());
  const uploadOp = sdk.Operation.uploadContractWasm({ wasm });
  const uploadFee = await simulateFee(sdk, client, deployer.publicKey(), uploadOp);
  const plan = {
    network: client.network.caip2,
    passphrase: client.network.networkPassphrase,
    rpc: args.rpc ?? client.network.sorobanRpcUrl,
    deployer: deployer.publicKey(),
    sequence: account.sequenceNumber(),
    deployerBalance: xlm(balance),
    wasmHash,
    uploadFee: xlm(uploadFee),
    createFee: "simulated after the upload (needs the uploaded wasm); refused above maxFee",
    maxFee: xlm(maxFee),
    auditReport: args.auditReport,
  };
  log("ReceptumEscrow (Soroban) MAINNET deployment plan");
  for (const [k, v] of Object.entries(plan)) log(`  ${k.padEnd(16)} ${v}`);
  if (uploadFee > maxFee) throw new Refusal(`refusing: upload fee ${xlm(uploadFee)} > maxFee`);
  if (balance < uploadFee)
    throw new Refusal(
      "refusing: the deployer cannot pay the simulated fee — fund the fresh key first",
    );
  if (args.dryRun) {
    log("dry run: nothing signed");
    return { plan, deployed: false };
  }
  if (!d.isTTY) throw new Refusal("refusing: confirmation needs an interactive terminal");
  const phrase = confirmationPhrase();
  const answer = await d.ask(`Type "${phrase}" to sign and broadcast: `);
  if (answer.trim() !== phrase) throw new Refusal("refusing: confirmation did not match");

  const signer = lib.keypairSigner(deployer);
  const upload = await client.invoke(signer, uploadOp);
  log(`uploaded wasm ${wasmHash} (tx ${upload.hash})`);
  const createOp = sdk.Operation.createCustomContract({
    address: new sdk.Address(deployer.publicKey()),
    wasmHash: Buffer.from(wasmHash, "hex"),
    salt: randomBytes(32),
  });
  const createFee = await simulateFee(sdk, client, deployer.publicKey(), createOp);
  if (createFee > maxFee)
    throw new Refusal(
      `refusing: create fee ${xlm(createFee)} > maxFee (wasm uploaded in ${upload.hash})`,
    );
  const create = await client.invoke(signer, createOp);
  const contractId = sdk.scValToNative(create.returnValue);
  const onChain = await client.contractWasmHash(contractId);
  if (onChain !== wasmHash)
    throw new Error(`deployed contract runs ${onChain}, expected ${wasmHash}`);
  const record = {
    network: "stellar:pubnet",
    contractId,
    wasmHash,
    deployer: deployer.publicKey(),
    deployedAt: new Date().toISOString(),
    auditReport: args.auditReport,
    transactions: {
      uploadWasm: { hash: upload.hash, url: lib.explorerTxUrl(upload.hash, "pubnet") },
      createContract: { hash: create.hash, url: lib.explorerTxUrl(create.hash, "pubnet") },
    },
    contract: `https://stellar.expert/explorer/public/contract/${contractId}`,
  };
  const out = args.out ?? "deployment.pubnet.json";
  d.writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  log(
    `deployed ${contractId}; wrote ${out}. Publish it, then add it to TRUSTED_ESCROWS["stellar:pubnet"].`,
  );
  return { plan, deployed: true, contractId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run({ argv: process.argv.slice(2), env: process.env });
  } catch (err) {
    console.error(err instanceof Refusal ? err.message : err);
    process.exit(err instanceof Refusal ? 2 : 1);
  }
}
