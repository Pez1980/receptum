#!/usr/bin/env node
// Deploys program/receptum_escrow.so to Solana MAINNET-BETA as an immutable program. Not in CI.
//
//   pnpm --filter @receptum/adapter-solana build
//   RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_KEYPAIR=/abs/path/fresh-deployer.json \
//     node packages/adapter-solana/scripts/deploy-mainnet.mjs --audit-report <url> [--rpc <url>] [--so <file>]
//
// Same refusal rules as packages/adapter-evm/scripts/deploy-mainnet.mjs and
// packages/adapter-stellar/scripts/deploy-soroban-mainnet.mjs, all enforced before anything is
// signed:
//   - refuses unless RECEPTUM_ALLOW_MAINNET=1;
//   - refuses without --audit-report: the escrow holds customer funds and goes to mainnet only
//     after an independent audit (SECURITY.md, docs/MAINNET.md §0);
//   - the deployer keypair comes ONLY from the path in RECEPTUM_MAINNET_DEPLOYER_KEYPAIR (a fresh
//     key, never a testnet one), and this script never reads it: only the Agave CLI does. Paths
//     under $RECEPTUM_WALLETS_DIR, ~/.config/receptum or ~/.config/solana (the CLI's default
//     wallet) and any devnet/testnet-named file are refused;
//   - checks the RPC's genesis hash (over JSON-RPC and through the CLI) is Solana mainnet-beta's;
//   - refuses a .so whose hash (SHA-256 with trailing zero bytes removed) differs from the
//     canonical CI build, RECEPTUM_SOLANA_PROGRAM_HASH = program/deployment.devnet.json
//     executableHash. Use the CI artifact `receptum_escrow-ci-build` of the audited commit (or
//     the committed program/receptum_escrow.so, which CI keeps byte-identical) — never a local
//     macOS build;
//   - prints the plan (network, RPC, deployer, balance, program size, estimated rent and fees,
//     hash) and refuses an underfunded deployer;
//   - requires typing the exact confirmation phrase on an interactive terminal; `--dry-run` stops
//     after the plan.
// It deploys with `--final` (no upgrade authority, ever), then checks the on-chain ProgramData:
// hash = the canonical hash and no upgrade authority. The raw Solana CLI output is never printed
// (it can contain a recovery seed phrase); only validated addresses, hashes and signatures are.
// After deploying, publish deployment.mainnet.json and only then add the program to
// TRUSTED_ESCROWS["solana:5eykt4…"] (packages/verify and verifiers/python) in a reviewed change.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const KEYPAIR_ENV = "RECEPTUM_MAINNET_DEPLOYER_KEYPAIR";
/** Full genesis hash of Solana mainnet-beta (CAIP-2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const confirmationPhrase = () => `deploy receptum_escrow to ${NETWORK}`;

const USAGE =
  "usage: RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_KEYPAIR=/abs/path.json node deploy-mainnet.mjs --audit-report <https://…> [--rpc <url>] [--so <file>] [--dry-run] [--out <file>]";
const LAMPORTS = 1_000_000_000n;
/** Upgradeable-loader account sizes: Program, Buffer header, ProgramData header. */
const PROGRAM_LEN = 36;
const BUFFER_HEADER = 37;
const PROGRAMDATA_HEADER = 45;
/** Conservative fee model: bytes per write-buffer tx, base fee, priority fee (µlamports/CU). */
const WRITE_CHUNK = 900;
const BASE_FEE = 5_000n;
const CU_PRICE = 10_000n;
const CU_LIMIT = 200_000n;

export class Refusal extends Error {}

function parse(argv) {
  const keys = { "--audit-report": "auditReport", "--rpc": "rpc", "--out": "out", "--so": "so" };
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

const sol = (lamports) => {
  const l = BigInt(lamports);
  return `${l / LAMPORTS}.${(l % LAMPORTS).toString().padStart(9, "0")} SOL`;
};

/** Directories whose keypairs are testnet wallets or the CLI's default wallet: never used. */
function forbiddenKeyDirs(env) {
  const dirs = [];
  if (env.RECEPTUM_WALLETS_DIR) dirs.push(env.RECEPTUM_WALLETS_DIR);
  if (env.HOME) dirs.push(join(env.HOME, ".config/receptum"), join(env.HOME, ".config/solana"));
  return dirs;
}

const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * A `solana` CLI runner whose output never reaches the terminal: stdout is returned to the caller
 * (which extracts only validated fields) and a failure carries only the exit status and a fixed
 * classification — never the CLI's own text, which can contain a seed phrase.
 */
export function makeCli(exec = execFileSync) {
  return (args) => {
    try {
      return exec("solana", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const text = `${err?.stderr ?? ""}\n${err?.stdout ?? ""}`;
      const reason = /insufficient (funds|lamports)/i.test(text)
        ? "insufficient funds"
        : /blockhash|timed? ?out|429|too many requests/i.test(text)
          ? "transaction expired or the RPC throttled"
          : /ENOENT/.test(String(err?.code))
            ? "the solana CLI is not on PATH"
            : "the CLI output is withheld (it can contain key material)";
      // No `cause`: the original error carries the CLI's raw output, possibly a seed phrase.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `solana ${args[0]} ${args[1] ?? ""} failed (status ${err?.status ?? "?"}): ${reason}`.replace(
          / +/g,
          " ",
        ),
      );
    }
  };
}

/** A fresh ed25519 Solana CLI keypair file (mode 600) in `dir`; returns its path and address. */
function newKeypairFile(dir, name, encodeBase58) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify([...d, ...x]), { mode: 0o600, flag: "wx" });
  return { path, address: encodeBase58(x) };
}

async function defaultDeps() {
  const lib = await import("../dist/index.js");
  return {
    lib,
    readFile: (url) => readFile(url),
    makeRpc: (url) => lib.solanaJsonRpc(url),
    cli: makeCli(),
    keyFileExists: (path) => existsSync(path),
    realpath: (path) => realpathSync(path),
    // Program-id and buffer keypairs, generated here (the CLI prints a seed phrase for keypairs it
    // generates itself) in a private temporary directory, removed after a verified deploy.
    makeTempKeypairs: () => {
      const dir = mkdtempSync(join(tmpdir(), "receptum-solana-mainnet-"));
      return {
        dir,
        program: newKeypairFile(dir, "program", lib.encodeBase58),
        buffer: newKeypairFile(dir, "buffer", lib.encodeBase58),
      };
    },
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
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
 * Runs the deployment. Every refusal throws `Refusal` before any signature. `deps` is injectable
 * for tests (mocked RPC and CLI — nothing reaches a real network).
 */
export async function run({ argv, env, log = console.log, deps }) {
  const args = parse(argv);
  if (env.RECEPTUM_ALLOW_MAINNET !== "1")
    throw new Refusal(`refusing: set RECEPTUM_ALLOW_MAINNET=1 to deploy to a mainnet\n${USAGE}`);
  if (!args.auditReport || !/^https:\/\//.test(args.auditReport))
    throw new Refusal(
      "refusing: --audit-report <https://…> is required — receptum_escrow holds customer funds and goes to mainnet only after an independent audit (docs/MAINNET.md §0)",
    );
  const keypair = env[KEYPAIR_ENV];
  if (!keypair || !isAbsolute(keypair))
    throw new Refusal(
      `refusing: ${KEYPAIR_ENV} must hold the absolute path of the fresh mainnet deployer keypair. Wallet files are never read.`,
    );
  const d = deps ?? (await defaultDeps());
  const { lib } = d;
  if (!d.keyFileExists(keypair)) throw new Refusal(`refusing: ${KEYPAIR_ENV} names no file`);
  const real = d.realpath(keypair);
  const dirs = forbiddenKeyDirs(env).flatMap((dir) => [
    dir,
    d.keyFileExists(dir) ? d.realpath(dir) : dir,
  ]);
  if (dirs.some((dir) => inside(keypair, dir) || inside(real, dir)) || /devnet|testnet/i.test(real))
    throw new Refusal(
      `refusing: ${KEYPAIR_ENV} points at a testnet wallet or the CLI's default wallet; use a fresh mainnet-only keypair`,
    );

  // The cluster, before anything else touches the key: JSON-RPC and the CLI must both be mainnet-beta.
  const rpcUrl = args.rpc ?? lib.SOLANA_RPC_ENDPOINTS[NETWORK];
  const rpc = d.makeRpc(rpcUrl);
  const genesis = await rpc("getGenesisHash", []);
  if (genesis !== MAINNET_GENESIS)
    throw new Refusal(
      `refusing: ${rpcUrl} reports genesis ${String(genesis)}, not Solana mainnet-beta`,
    );
  const cliGenesis = d.cli(["genesis-hash", "--url", rpcUrl]).trim();
  if (cliGenesis !== MAINNET_GENESIS)
    throw new Refusal("refusing: the solana CLI does not see Solana mainnet-beta at that RPC");

  const canonical = lib.RECEPTUM_SOLANA_PROGRAM_HASH;
  const record = JSON.parse(
    String(await d.readFile(new URL("../program/deployment.devnet.json", import.meta.url))),
  );
  if (record.executableHash !== canonical)
    throw new Refusal(
      `refusing: program/deployment.devnet.json (${record.executableHash}) and RECEPTUM_SOLANA_PROGRAM_HASH (${canonical}) disagree`,
    );
  const soPath = args.so ?? new URL("../program/receptum_escrow.so", import.meta.url).pathname;
  if (dirs.some((dir) => inside(soPath, dir)))
    throw new Refusal("refusing: --so points into a wallet directory");
  const so = await d.readFile(soPath);
  const soHash = lib.elfHash(so);
  if (soHash !== canonical)
    throw new Refusal(
      `refusing: ${soPath} hashes to ${soHash} ≠ the canonical CI build ${canonical}; use the CI artifact receptum_escrow-ci-build`,
    );

  const deployer = d.cli(["address", "--keypair", keypair]).trim();
  if (!lib.isSolanaAddress(deployer))
    throw new Refusal(`refusing: ${KEYPAIR_ENV} is not a Solana keypair the CLI can read`);
  const version = /solana-cli (\d+\.\d+\.\d+)/.exec(d.cli(["--version"]))?.[1] ?? "unknown";
  const rent = async (len) => BigInt(await rpc("getMinimumBalanceForRentExemption", [len]));
  const [balanceReply, programDataRent, bufferRent, programRent] = await Promise.all([
    rpc("getBalance", [deployer, { commitment: "confirmed" }]),
    rent(PROGRAMDATA_HEADER + so.length),
    rent(BUFFER_HEADER + so.length),
    rent(PROGRAM_LEN),
  ]);
  const balance = BigInt(balanceReply.value);
  const txs = BigInt(Math.ceil(so.length / WRITE_CHUNK) + 4);
  const fees = 2n * txs * (BASE_FEE + (CU_PRICE * CU_LIMIT) / 1_000_000n); // 2× for resends
  const required = programDataRent + programRent + bufferRent + fees;
  const plan = {
    network: NETWORK,
    genesis,
    rpc: rpcUrl,
    cli: `solana-cli ${version}`,
    deployer,
    deployerBalance: sol(balance),
    program: soPath,
    programSize: `${so.length} bytes`,
    executableHash: soHash,
    programId: "fresh keypair, generated after confirmation",
    upgradeAuthority: "none (--final)",
    estimatedRent: `${sol(programDataRent + programRent)} (ProgramData + Program, locked)`,
    bufferRent: `${sol(bufferRent)} (temporary, refunded by the deploy)`,
    estimatedFees: `${sol(fees)} (~${txs} transactions, 2× margin)`,
    required: sol(required),
    auditReport: args.auditReport,
  };
  log("receptum_escrow (Solana) MAINNET deployment plan");
  for (const [k, v] of Object.entries(plan)) log(`  ${k.padEnd(16)} ${v}`);
  if (balance < required)
    throw new Refusal(
      "refusing: the deployer cannot pay the estimated rent and fees — fund the fresh key first",
    );
  if (args.dryRun) {
    log("dry run: nothing signed");
    return { plan, deployed: false };
  }
  if (!d.isTTY) throw new Refusal("refusing: confirmation needs an interactive terminal");
  const phrase = confirmationPhrase();
  const answer = await d.ask(`Type "${phrase}" to sign and broadcast: `);
  if (answer.trim() !== phrase) throw new Refusal("refusing: confirmation did not match");

  const keys = d.makeTempKeypairs();
  const programId = keys.program.address;
  if (await lib.getAccount(rpc, programId)) throw new Refusal(`refusing: ${programId} exists`);
  const common = ["--keypair", keypair, "--url", rpcUrl, "--commitment", "confirmed"];
  const priority = ["--with-compute-unit-price", String(CU_PRICE)];
  let signature;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        d.cli([
          "program",
          "write-buffer",
          soPath,
          "--buffer",
          keys.buffer.path,
          "--use-rpc",
          "--max-sign-attempts",
          "50",
          ...priority,
          ...common,
        ]);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        log(`write-buffer attempt ${attempt} failed, resuming: ${err.message}`);
      }
    }
    log(`buffer ${keys.buffer.address} written`);
    const out = d.cli([
      "program",
      "deploy",
      "--buffer",
      keys.buffer.path,
      "--program-id",
      keys.program.path,
      "--final",
      "--use-rpc",
      ...priority,
      "--output",
      "json",
      ...common,
    ]);
    try {
      const s = JSON.parse(out).signature;
      signature = lib.isSolanaSignature(s) ? s : null;
    } catch {
      signature = null;
    }
  } catch (err) {
    throw new Error(
      `${err.message}. The buffer and program keypairs are kept in ${keys.dir} to resume; the deployer can reclaim an unused buffer's rent with \`solana program close --buffers\`.`,
      { cause: err }, // already sanitized by makeCli
    );
  }

  const acc = await lib.getAccount(rpc, programId);
  if (!acc?.executable || acc.owner !== lib.BPF_LOADER_UPGRADEABLE_ID)
    throw new Error(`${programId} is not an executable upgradeable-loader program`);
  const programData = lib.programDataAddress(acc.data);
  const pd = await lib.getAccount(rpc, programData);
  if (!pd) throw new Error(`ProgramData ${programData} not found`);
  const { hash, upgradeAuthority } = lib.programDataHash(pd.data);
  if (hash !== canonical) throw new Error(`deployed program runs ${hash}, expected ${canonical}`);
  if (upgradeAuthority) throw new Error(`program is still upgradeable by ${upgradeAuthority}`);
  d.removeDir(keys.dir);

  const deployment = {
    network: NETWORK,
    programId,
    programData,
    executableHash: hash,
    upgradeAuthority: null,
    deployedSlot: Number(Buffer.from(pd.data).readBigUInt64LE(4)),
    deployer,
    ...(signature
      ? { deployTransaction: signature, deployUrl: lib.explorerTxUrl(signature, NETWORK) }
      : {}),
    program: lib.explorerAddressUrl(programId, NETWORK),
    deployedAt: new Date().toISOString(),
    auditReport: args.auditReport,
    build:
      "CI artifact receptum_escrow-ci-build (Linux x86_64, Agave 4.3.0 cargo-build-sbf -- --locked)",
    note: "Deployed with --final: there is no upgrade authority.",
  };
  const outFile = args.out ?? "deployment.mainnet.json";
  d.writeFile(outFile, `${JSON.stringify(deployment, null, 2)}\n`);
  log(
    `deployed ${programId} (hash ${hash}, no upgrade authority); wrote ${outFile}. Publish it, then add it to TRUSTED_ESCROWS["${NETWORK}"].`,
  );
  return { plan, deployed: true, programId, signature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run({ argv: process.argv.slice(2), env: process.env });
  } catch (err) {
    console.error(err instanceof Refusal ? err.message : err);
    process.exit(err instanceof Refusal ? 2 : 1);
  }
}
