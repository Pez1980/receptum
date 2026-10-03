#!/usr/bin/env node
// Deploys contracts/receptum-escrow/receptum_escrow.wasm to Stellar TESTNET (never mainnet).
// Usage (after `pnpm --filter @receptum/adapter-stellar build`):
//   node packages/adapter-stellar/scripts/deploy-soroban-testnet.mjs [--force]
//
// The deployer is the seller account in $RECEPTUM_WALLETS_DIR/stellar-testnet.json (it has no
// special rights: the contract has no admin and no upgrade path). Public deployment data is
// written to contracts/receptum-escrow/deployment.testnet.json.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Keypair, Operation, scValToNative } from "@stellar/stellar-sdk";
import {
  RECEPTUM_SOROBAN_WASM_HASH,
  SorobanRpcClient,
  explorerTxUrl,
  keypairSigner,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, "..", "contracts", "receptum-escrow");
const out = join(contractDir, "deployment.testnet.json");
const walletsDir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");

if (existsSync(out) && !process.argv.includes("--force")) {
  console.error(`${out} exists; pass --force to deploy another instance`);
  process.exit(1);
}

const wasm = readFileSync(join(contractDir, "receptum_escrow.wasm"));
const wasmHash = createHash("sha256").update(wasm).digest("hex");
if (wasmHash !== RECEPTUM_SOROBAN_WASM_HASH) {
  throw new Error(
    `wasm hash ${wasmHash} ≠ RECEPTUM_SOROBAN_WASM_HASH; rebuild or update the constant`,
  );
}

const wallets = JSON.parse(readFileSync(join(walletsDir, "stellar-testnet.json"), "utf8"));
const deployer = Keypair.fromSecret(wallets.seller.secret);
const signer = keypairSigner(deployer);
const client = new SorobanRpcClient();

const upload = await client.invoke(signer, Operation.uploadContractWasm({ wasm }));
console.log(`uploaded wasm ${wasmHash} (tx ${upload.hash})`);
const create = await client.invoke(
  signer,
  Operation.createCustomContract({
    address: new Address(deployer.publicKey()),
    wasmHash: Buffer.from(wasmHash, "hex"),
    salt: randomBytes(32),
  }),
);
const contractId = scValToNative(create.returnValue);
const onChain = await client.contractWasmHash(contractId);
if (onChain !== wasmHash)
  throw new Error(`deployed contract runs ${onChain}, expected ${wasmHash}`);
console.log(`deployed ${contractId} (tx ${create.hash})`);

const deployment = {
  network: "stellar:testnet",
  contractId,
  wasmHash,
  deployer: deployer.publicKey(),
  deployedAt: new Date().toISOString(),
  transactions: {
    uploadWasm: { hash: upload.hash, url: explorerTxUrl(upload.hash) },
    createContract: { hash: create.hash, url: explorerTxUrl(create.hash) },
  },
  contract: `https://stellar.expert/explorer/testnet/contract/${contractId}`,
  note: "Unaudited. Testnet only.",
};
writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");
console.log(`wrote ${out}`);
