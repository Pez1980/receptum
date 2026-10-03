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
import { readFileSync, writeFileSync } from "node:fs";
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

let signature = null;
const existing = await getAccount(rpc, RECEPTUM_SOLANA_PROGRAM_ID);
if (!existing) {
  const out = execFileSync(
    "solana",
    [
      "program",
      "deploy",
      so.pathname,
      "--program-id",
      join(walletsDir, "solana-devnet-program.json"),
      "--keypair",
      join(walletsDir, "solana-devnet-deployer.json"),
      "--final",
      "--use-rpc",
      "--url",
      RPC_URL,
      "--commitment",
      "confirmed",
      "--output",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  assertNoSecrets(out);
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
