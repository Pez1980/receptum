// Shared helpers for the Stellar TESTNET scripts (never mainnet). Keys live outside the repo in
// $RECEPTUM_WALLETS_DIR (default ~/.config/receptum/wallets), directory mode 700, files mode 600.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Asset, Horizon, Keypair, Operation } from "@stellar/stellar-sdk";
import { generateSellerKey, sellerKeyFromPem } from "@receptum/core";
import {
  HorizonClient,
  STELLAR_TESTNET,
  TESTNET_USDC_ISSUER,
  keypairSigner,
} from "../dist/index.js";

export const walletsDir =
  process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
export const horizon = new Horizon.Server(STELLAR_TESTNET.horizonUrl);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Creates `path` atomically with mode 600, or returns the existing content. */
function createOrRead(path, make, parse) {
  mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
  chmodSync(walletsDir, 0o700);
  if (!existsSync(path)) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, make(), { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    } finally {
      unlinkSync(tmp);
    }
  }
  chmodSync(path, 0o600);
  return parse(readFileSync(path, "utf8"));
}

const kp = () => {
  const k = Keypair.random();
  return { publicKey: k.publicKey(), secret: k.secret() };
};

/** Buyer and seller (shared with e2e-testnet.mjs). */
export function loadWallets() {
  return createOrRead(
    join(walletsDir, "stellar-testnet.json"),
    () =>
      JSON.stringify(
        { network: "stellar:testnet", note: "TESTNET ONLY", buyer: kp(), seller: kp() },
        null,
        2,
      ),
    (text) => {
      const w = JSON.parse(text);
      return {
        buyer: Keypair.fromSecret(w.buyer.secret),
        seller: Keypair.fromSecret(w.seller.secret),
      };
    },
  );
}

/** A third party: evaluator, and "anyone" for permissionless calls. */
export function loadThirdParty() {
  return createOrRead(
    join(walletsDir, "stellar-testnet-evaluator.json"),
    () =>
      JSON.stringify(
        { network: "stellar:testnet", note: "TESTNET ONLY", evaluator: kp() },
        null,
        2,
      ),
    (text) => Keypair.fromSecret(JSON.parse(text).evaluator.secret),
  );
}

export function loadSellerReceiptKey() {
  return createOrRead(
    join(walletsDir, "seller-ed25519.pem"),
    () => generateSellerKey().privateKeyPem,
    (pem) => sellerKeyFromPem(pem),
  );
}

export async function fund(keypair) {
  try {
    await horizon.loadAccount(keypair.publicKey());
    return "existing";
  } catch {
    const res = await fetch(`${STELLAR_TESTNET.friendbotUrl}?addr=${keypair.publicKey()}`);
    if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
    return "friendbot";
  }
}

export const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);

export async function usdcBalance(address) {
  const acct = await horizon.loadAccount(address);
  const line = acct.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER,
  );
  return line ? line.balance : null;
}

/** USDC trustlines for `holders`; `buyer` buys testnet USDC with XLM on the testnet DEX if short. */
export async function ensureUsdc(buyer, holders, need) {
  const client = new HorizonClient();
  const txs = [];
  for (const k of holders) {
    if ((await usdcBalance(k.publicKey())) === null) {
      const { hash } = await client.submit(keypairSigner(k), [
        Operation.changeTrust({ asset: usdc }),
      ]);
      txs.push({ step: `USDC trustline (${k.publicKey().slice(0, 6)}…)`, hash });
    }
  }
  if (Number(await usdcBalance(buyer.publicKey())) < need) {
    const { hash } = await client.submit(keypairSigner(buyer), [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "200",
        destination: buyer.publicKey(),
        destAsset: usdc,
        destAmount: String(need),
        path: [],
      }),
    ]);
    txs.push({ step: `buyer buys ${need} testnet USDC with XLM (DEX path payment)`, hash });
  }
  return txs;
}

/** Replaces the block between `<!-- name:start -->` and `<!-- name:end -->` in a markdown file. */
export function writeSection(path, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const block = `${start}\n\n${body.trim()}\n\n${end}`;
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  const next =
    i >= 0 && j > i ? text.slice(0, i) + block + text.slice(j + end.length) : `${text}\n${block}\n`;
  assertNoSecrets(next);
  writeFileSync(path, next);
}

/** Refuses to write anything that looks like a Stellar secret seed or a private key. */
export function assertNoSecrets(text) {
  if (/\bS[A-Z2-7]{55}\b/.test(text) || text.includes("PRIVATE KEY")) {
    throw new Error("refusing to write results: they look like they contain a secret");
  }
}
