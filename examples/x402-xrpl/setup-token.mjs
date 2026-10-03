// XRPL TESTNET only (NetworkID 1). Prepares the issued-token and evaluator runs:
//
//   pnpm build && node examples/x402-xrpl/setup-wallets.mjs && node examples/x402-xrpl/setup-token.mjs
//
// - creates (once) a fresh token issuer and a fresh evaluator from the faucet, stored in
//   $RECEPTUM_WALLETS_DIR/xrpl-token-testnet.json (mode 600) — never printed;
// - issuer: asfDefaultRipple (holder-to-holder payments ripple through it) and
//   asfAllowTrustLineLocking (TokenEscrow);
// - buyer and seller (from xrpl-x402-testnet.json) open trust lines for the test token, and the
//   issuer funds the buyer with it.
// Prints addresses and transaction hashes only; writes examples/x402-xrpl/token-setup.json
// (public data).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountSetAsfFlags, Client, Wallet } from "xrpl";
import { currencyCode } from "@receptum/adapter-xrpl";

const WSS = "wss://s.altnet.rippletest.net:51233";
export const TOKEN_SYMBOL = "RCPT";
const CURRENCY = currencyCode(TOKEN_SYMBOL); // 40-hex, RLUSD-style
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const x402File = join(dir, "xrpl-x402-testnet.json");
const tokenFile = join(dir, "xrpl-token-testnet.json");

const client = new Client(WSS);
await client.connect();
const hashes = [];
try {
  const info = (await client.request({ command: "server_info" })).result.info;
  if (info.network_id !== 1) throw new Error("refusing: not XRPL testnet (NetworkID 1)");

  if (!existsSync(tokenFile)) {
    const { wallet: issuer } = await client.fundWallet();
    const { wallet: evaluator } = await client.fundWallet();
    const data = {
      network: "xrpl:1",
      issuer: { address: issuer.classicAddress, seed: issuer.seed },
      evaluator: { address: evaluator.classicAddress, seed: evaluator.seed },
    };
    writeFileSync(tokenFile, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    console.log("created", tokenFile);
  }
  chmodSync(tokenFile, 0o600);
  const x = JSON.parse(readFileSync(x402File, "utf8"));
  const t = JSON.parse(readFileSync(tokenFile, "utf8"));
  const buyer = Wallet.fromSeed(x.buyer.seed);
  const seller = Wallet.fromSeed(x.seller.seed);
  const issuer = Wallet.fromSeed(t.issuer.seed);
  const evaluator = Wallet.fromSeed(t.evaluator.seed);
  const secrets = [x.buyer.seed, x.seller.seed, t.issuer.seed, t.evaluator.seed];

  const submit = async (label, wallet, tx) => {
    const res = await client.submitAndWait(tx, { wallet, autofill: true });
    const code = res.result.meta.TransactionResult;
    if (code !== "tesSUCCESS") throw new Error(`${label}: ${code}`);
    hashes.push({ label, hash: res.result.hash });
    console.log(`  ${label}: ${res.result.hash}`);
  };
  const xrp = async (w) =>
    (
      await client.request({
        command: "account_info",
        account: w.classicAddress,
        ledger_index: "validated",
      })
    ).result.account_data.Balance;
  for (const [role, w] of Object.entries({ buyer, seller, issuer, evaluator }))
    console.log(`${role.padEnd(9)} ${w.classicAddress} ${Number(await xrp(w)) / 1e6} XRP`);

  const flags = (
    await client.request({
      command: "account_info",
      account: issuer.classicAddress,
      ledger_index: "validated",
    })
  ).result.account_flags;
  if (!flags.defaultRipple)
    await submit("issuer AccountSet asfDefaultRipple", issuer, {
      TransactionType: "AccountSet",
      Account: issuer.classicAddress,
      SetFlag: AccountSetAsfFlags.asfDefaultRipple,
    });
  if (!flags.allowTrustLineLocking)
    await submit("issuer AccountSet asfAllowTrustLineLocking", issuer, {
      TransactionType: "AccountSet",
      Account: issuer.classicAddress,
      SetFlag: AccountSetAsfFlags.asfAllowTrustLineLocking,
    });

  const balance = async (w) => {
    const lines = (
      await client.request({
        command: "account_lines",
        account: w.classicAddress,
        peer: issuer.classicAddress,
        ledger_index: "validated",
      })
    ).result.lines;
    return lines.find((l) => l.currency === CURRENCY);
  };
  for (const [role, w] of [
    ["buyer", buyer],
    ["seller", seller],
  ]) {
    if (!(await balance(w)))
      await submit(`${role} TrustSet ${TOKEN_SYMBOL}`, w, {
        TransactionType: "TrustSet",
        Account: w.classicAddress,
        LimitAmount: { currency: CURRENCY, issuer: issuer.classicAddress, value: "1000000" },
      });
  }
  if (Number((await balance(buyer)).balance) < 10)
    await submit(`issuer pays buyer 100 ${TOKEN_SYMBOL}`, issuer, {
      TransactionType: "Payment",
      Account: issuer.classicAddress,
      Destination: buyer.classicAddress,
      Amount: { currency: CURRENCY, issuer: issuer.classicAddress, value: "100" },
    });
  console.log(`buyer holds ${(await balance(buyer)).balance} ${TOKEN_SYMBOL}`);

  const record = {
    network: "xrpl:1",
    token: { symbol: TOKEN_SYMBOL, currency: CURRENCY, issuer: issuer.classicAddress },
    asset: `${CURRENCY}.${issuer.classicAddress}`,
    accounts: {
      buyer: buyer.classicAddress,
      seller: seller.classicAddress,
      issuer: issuer.classicAddress,
      evaluator: evaluator.classicAddress,
    },
    setup: hashes,
  };
  const path = new URL("./token-setup.json", import.meta.url);
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).setup : [];
  record.setup = [...previous, ...hashes];
  const json = JSON.stringify(record, null, 2) + "\n";
  if (secrets.some((s) => json.includes(s))) throw new Error("refusing to write a secret");
  writeFileSync(path, json);
  console.log("wrote examples/x402-xrpl/token-setup.json");
} finally {
  await client.disconnect();
}
