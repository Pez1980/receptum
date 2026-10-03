// Creates (once) a fresh buyer + seller on XRPL TESTNET via the public faucet, stores them in
// $RECEPTUM_WALLETS_DIR/xrpl-x402-testnet.json (mode 600), and writes the seller's public account
// binding (SPEC §4.1) to examples/bindings/xrpl-testnet-x402.json. Prints addresses only.
//
//   pnpm build && node examples/x402-xrpl/setup-wallets.mjs
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, Wallet } from "xrpl";
import { createAccountBinding, sellerKeyFromPem, verifyAccountBinding } from "@receptum/core";
import { xrplAccountSigner, xrplBindingVerifier } from "@receptum/adapter-xrpl";

const WSS = "wss://s.altnet.rippletest.net:51233";
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const file = join(dir, "xrpl-x402-testnet.json");

if (!existsSync(file)) {
  const client = new Client(WSS);
  await client.connect();
  try {
    const { wallet: buyer } = await client.fundWallet();
    const { wallet: seller } = await client.fundWallet();
    const data = {
      network: "xrpl:1",
      buyer: { address: buyer.classicAddress, seed: buyer.seed },
      seller: { address: seller.classicAddress, seed: seller.seed },
    };
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log("created", file);
  } finally {
    await client.disconnect();
  }
}
const wallets = JSON.parse(readFileSync(file, "utf8"));
console.log("buyer ", wallets.buyer.address);
console.log("seller", wallets.seller.address);

const key = sellerKeyFromPem(readFileSync(join(dir, "seller-ed25519.pem"), "utf8"));
const issuedAt = new Date();
const binding = await createAccountBinding({
  key,
  signer: xrplAccountSigner(Wallet.fromSeed(wallets.seller.seed), { network: "xrpl:1" }),
  issuedAt,
  expiresAt: new Date(issuedAt.getTime() + 365 * 86_400_000),
});
const check = verifyAccountBinding(binding, { verifiers: [xrplBindingVerifier] });
if (!check.ok) throw new Error(check.reason);
const out = new URL("../bindings/xrpl-testnet-x402.json", import.meta.url);
const json = JSON.stringify(binding, null, 2) + "\n";
if (json.includes(wallets.seller.seed) || json.includes(wallets.buyer.seed))
  throw new Error("refusing to write a secret");
writeFileSync(out, json);
console.log(`binding ${binding.statement.account} — ${check.detail}`);
