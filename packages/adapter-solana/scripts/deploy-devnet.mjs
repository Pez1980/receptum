// Deploys program/receptum_escrow.so to Solana DEVNET as an immutable program (`--final`: no
// upgrade authority, ever), then checks the deployed bytes against the published build hash and
// writes program/deployment.devnet.json. Devnet only; refuses any other cluster.
//
//   node packages/adapter-solana/scripts/deploy-devnet.mjs
//
// Needs the Agave CLI (`solana`, pinned v4.3.0) on PATH, the payer keypair
// $RECEPTUM_WALLETS_DIR/solana-devnet-deployer.json (~1.1 SOL: program rent + the temporary
// buffer) and the program address keypair solana-devnet-program.json. Neither is ever printed.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  elfHash,
  explorerAddressUrl,
  explorerTxUrl,
  getAccount,
  programDataAddress,
  programDataHash,
  RECEPTUM_SOLANA_PROGRAM_HASH,
  RECEPTUM_SOLANA_PROGRAM_ID,
  servesNetwork,
} from "../dist/index.js";
import {
  assertNoSecrets,
  loadKeypair,
  NETWORK,
  rpc,
  RPC_URL,
  walletsDir,
} from "./devnet-common.mjs";

const so = new URL("../program/receptum_escrow.so", import.meta.url);
if (elfHash(readFileSync(so)) !== RECEPTUM_SOLANA_PROGRAM_HASH)
  throw new Error("program/receptum_escrow.so is not the published build");
if (!(await servesNetwork(rpc, NETWORK))) throw new Error(`${RPC_URL} is not Solana devnet`);
const deployer = loadKeypair("deployer");
const program = loadKeypair("program");
if (program.address !== RECEPTUM_SOLANA_PROGRAM_ID)
  throw new Error("solana-devnet-program.json is not the published program address");

// The CLI prints a recovery seed phrase for any buffer keypair it generates itself, so the
// buffer keypair is created here (in the wallets dir, mode 600) and the CLI's stderr is never
// shown raw: only lines without key material are echoed.
function cli(args) {
  try {
    const out = execFileSync("solana", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assertNoSecrets(out);
    return out;
  } catch (err) {
    const lines = String(err.stderr ?? "")
      .split("\n")
      .filter(
        (l) => /error|insufficient|failed/i.test(l) && !/seed phrase|keygen recover/i.test(l),
      );
    // The original error carries the CLI's raw output (possibly a seed phrase): strip it first.
    for (const k of ["stderr", "stdout", "output"]) err[k] = undefined;
    err.message = `solana exited with status ${err.status}`;
    throw new Error(`solana ${args[0]} ${args[1]} failed: ${lines.join(" | ").slice(0, 500)}`, {
      cause: err,
    });
  }
}
const wallet = (role) => join(walletsDir, `solana-devnet-${role}.json`);
const common = ["--keypair", wallet("deployer"), "--url", RPC_URL, "--commitment", "confirmed"];

// DEPLOY_SIGNATURE records the deploy transaction when re-running only the post-deploy checks.
let signature = process.env.DEPLOY_SIGNATURE ?? null;
const existing = await getAccount(rpc, RECEPTUM_SOLANA_PROGRAM_ID);
if (!existing) {
  const bufferFile = wallet("buffer");
  if (!existsSync(bufferFile)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
    const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    writeFileSync(bufferFile, JSON.stringify([...d, ...x]), { mode: 0o600 });
  }
  loadKeypair("buffer"); // registers it for the secret screen
  // Write (or resume writing) the buffer; retried because public RPCs drop write transactions.
  for (let attempt = 1; ; attempt++) {
    try {
      cli([
        "program",
        "write-buffer",
        so.pathname,
        "--buffer",
        bufferFile,
        "--use-rpc",
        "--max-sign-attempts",
        "50",
        "--with-compute-unit-price",
        "10000",
        ...common,
      ]);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      console.log(`write-buffer attempt ${attempt} failed, resuming: ${err.message}`);
    }
  }
  const out = cli([
    "program",
    "deploy",
    "--buffer",
    bufferFile,
    "--program-id",
    wallet("program"),
    "--final",
    "--use-rpc",
    "--with-compute-unit-price",
    "10000",
    "--output",
    "json",
    ...common,
  ]);
  signature = JSON.parse(out).signature ?? null;
  console.log("deployed", RECEPTUM_SOLANA_PROGRAM_ID, signature ?? "");
}

const acc = await getAccount(rpc, RECEPTUM_SOLANA_PROGRAM_ID);
if (!acc?.executable) throw new Error("program account is not executable");
const pda = programDataAddress(acc.data);
const pd = await getAccount(rpc, pda);
const { hash, upgradeAuthority } = programDataHash(pd.data);
if (hash !== RECEPTUM_SOLANA_PROGRAM_HASH) throw new Error(`deployed hash ${hash} differs`);
if (upgradeAuthority) throw new Error(`program is still upgradeable by ${upgradeAuthority}`);
const slot = Buffer.from(pd.data).readBigUInt64LE(4);

const deployment = {
  network: NETWORK,
  programId: RECEPTUM_SOLANA_PROGRAM_ID,
  programData: pda,
  executableHash: hash,
  executableHashNote:
    "SHA-256 of program/receptum_escrow.so with trailing zero bytes removed (= solana-verify get-executable-hash); verifiers recompute it from the ProgramData account after its 45-byte header",
  upgradeAuthority: null,
  deployedSlot: Number(slot),
  deployer: deployer.address,
  ...(signature ? { deployTransaction: signature, deployUrl: explorerTxUrl(signature) } : {}),
  program: explorerAddressUrl(RECEPTUM_SOLANA_PROGRAM_ID),
  build: {
    toolchain: "Agave 4.3.0 cargo-build-sbf, platform-tools v1.57 (rustc 1.95.0-sbpf-solana-v1.57)",
    crate: "solana-program =4.0.0 (Cargo.lock committed)",
    command: "cd packages/adapter-solana/program && cargo-build-sbf",
  },
  note: "Unaudited. Devnet only. Deployed with --final: there is no upgrade authority.",
};
const json = JSON.stringify(deployment, null, 2) + "\n";
assertNoSecrets(json);
writeFileSync(new URL("../program/deployment.devnet.json", import.meta.url), json);
console.log(json);
