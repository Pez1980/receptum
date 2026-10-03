// Creates the public account bindings (SPEC §4.1) for the testnet seller: its did:key bound to
// its EVM, XRPL and Stellar payout accounts. Reads keys from RECEPTUM_WALLETS_DIR; writes only
// public data (statements + signatures) next to this file. Testnet only.
//
//   RECEPTUM_WALLETS_DIR=~/.config/receptum/wallets node create.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { Wallet } from "xrpl";
import {
  createAccountBinding,
  sellerKeyFromPem,
  stellarAccountSigner,
  verifyAccountBinding,
} from "@receptum/core";
import { evmAccountSigner, evmBindingVerifier } from "@receptum/adapter-evm";
import { xrplAccountSigner, xrplBindingVerifier } from "@receptum/adapter-xrpl";

const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const read = (f) => readFileSync(join(dir, f), "utf8");
const key = sellerKeyFromPem(read("seller-ed25519.pem"));
const evm = JSON.parse(read("evm-testnet.json"));
const xrpl = JSON.parse(read("xrpl-testnet.json"));
const stellar = JSON.parse(read("stellar-testnet.json"));

const issuedAt = new Date();
const expiresAt = new Date(issuedAt.getTime() + 365 * 86_400_000);
const signers = {
  "evm-base-sepolia": evmAccountSigner(privateKeyToAccount(evm.seller.privateKey), "eip155:84532"),
  "evm-arc-testnet": evmAccountSigner(privateKeyToAccount(evm.seller.privateKey), "eip155:5042002"),
  "xrpl-testnet": xrplAccountSigner(Wallet.fromSeed(xrpl.seller), { network: "xrpl:1" }),
  "stellar-testnet": stellarAccountSigner(stellar.seller.secret, "stellar:testnet"),
};

for (const [name, signer] of Object.entries(signers)) {
  const binding = await createAccountBinding({ key, signer, issuedAt, expiresAt });
  const check = verifyAccountBinding(binding, {
    verifiers: [evmBindingVerifier, xrplBindingVerifier],
  });
  if (!check.ok) throw new Error(`${name}: ${check.reason}`);
  writeFileSync(
    new URL(`./${name}.json`, import.meta.url),
    JSON.stringify(binding, null, 2) + "\n",
  );
  console.log(`${name}: ${binding.statement.account} — ${check.detail}`);
}
