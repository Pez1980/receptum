// Shared helpers for the Solana DEVNET scripts and examples. Keys stay in $RECEPTUM_WALLETS_DIR
// (default ~/.config/receptum/wallets): solana-devnet-{buyer,seller,evaluator,deployer}.json,
// each a Solana CLI keypair file (mode 600). Nothing here ever prints or writes key material.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAccountBinding, sellerKeyFromPem, verifyAccountBinding } from "@receptum/core";
import {
  associatedTokenAddress,
  createAtaIdempotentInstruction,
  DEVNET_USDC_MINT,
  getAccount,
  sendAndConfirm,
  solanaAccountSigner,
  solanaBindingVerifier,
  solanaJsonRpc,
  solanaKeypair,
  SOLANA_DEVNET,
  SYSTEM_PROGRAM_ID,
} from "../dist/index.js";

export const NETWORK = SOLANA_DEVNET;
export const RPC_URL = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
export const rpc = solanaJsonRpc(RPC_URL);
/** sendAndConfirm options: every signature first checks that the RPC serves devnet. */
const SEND = { network: NETWORK };
export const walletsDir =
  process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");

const secrets = [];
/** Loads a devnet keypair by role; remembers its secret bytes so outputs can be screened. */
export function loadKeypair(role) {
  const bytes = JSON.parse(readFileSync(join(walletsDir, `solana-devnet-${role}.json`), "utf8"));
  secrets.push(Buffer.from(bytes).toString("hex"), JSON.stringify(bytes).slice(1, 60));
  return solanaKeypair(bytes);
}

/** Replaces (or appends) the `<!-- name:start -->…<!-- name:end -->` block of a Markdown file. */
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

/** Throws if `text` contains any loaded secret (as hex or as the JSON byte list). */
export function assertNoSecrets(text) {
  for (const s of secrets) if (text.includes(s)) throw new Error("refusing to write a secret");
  if (text.includes("PRIVATE KEY")) throw new Error("refusing to write a secret");
}

export const sellerKey = () =>
  sellerKeyFromPem(readFileSync(join(walletsDir, "seller-ed25519.pem"), "utf8"));

/** The seller's public binding (did:key ↔ solana devnet payout account), created once. */
export async function sellerBinding(seller) {
  const path = new URL("../../../examples/bindings/solana-devnet.json", import.meta.url);
  const key = sellerKey();
  if (existsSync(path)) {
    const b = JSON.parse(readFileSync(path, "utf8"));
    if (b.statement.account === `${NETWORK}:${seller.address}` && b.statement.did === key.did)
      return b;
  }
  const issuedAt = new Date();
  const binding = await createAccountBinding({
    key,
    signer: solanaAccountSigner(seller, NETWORK),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 365 * 86_400_000),
  });
  const check = verifyAccountBinding(binding, { verifiers: [solanaBindingVerifier] });
  if (!check.ok) throw new Error(check.reason);
  const json = JSON.stringify(binding, null, 2) + "\n";
  assertNoSecrets(json);
  writeFileSync(path, json);
  return binding;
}

export async function lamports(address) {
  const r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

export async function tokenBalance(owner, mint = DEVNET_USDC_MINT) {
  const acc = await getAccount(rpc, associatedTokenAddress(owner, mint));
  return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : null;
}

/** Tops up `to` from `from` to at least `min` lamports (SOL transfer). */
export async function topUp(from, to, min) {
  const have = await lamports(to);
  if (have >= min) return null;
  const d = Buffer.alloc(12);
  d.writeUInt32LE(2, 0);
  d.writeBigUInt64LE(min - have, 4);
  const { signature } = await sendAndConfirm(
    rpc,
    from,
    [
      {
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          { address: from.address, signer: true, writable: true },
          { address: to, signer: false, writable: true },
        ],
        data: d,
      },
    ],
    SEND,
  );
  return signature;
}

/** Creates `owner`'s devnet-USDC associated token account if it does not exist. */
export async function ensureUsdcAccount(payer, owner) {
  if ((await tokenBalance(owner)) !== null) return null;
  const { signature } = await sendAndConfirm(
    rpc,
    payer,
    [createAtaIdempotentInstruction(payer.address, owner, DEVNET_USDC_MINT)],
    SEND,
  );
  return signature;
}

/** Moves devnet USDC between associated token accounts (classic SPL Token transferChecked). */
export async function transferUsdc(from, toOwner, amount) {
  const d = Buffer.alloc(10);
  d[0] = 12;
  d.writeBigUInt64LE(BigInt(amount), 1);
  d[9] = 6;
  const { signature } = await sendAndConfirm(
    rpc,
    from,
    [
      createAtaIdempotentInstruction(from.address, toOwner, DEVNET_USDC_MINT),
      {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        accounts: [
          {
            address: associatedTokenAddress(from.address, DEVNET_USDC_MINT),
            signer: false,
            writable: true,
          },
          { address: DEVNET_USDC_MINT, signer: false, writable: false },
          {
            address: associatedTokenAddress(toOwner, DEVNET_USDC_MINT),
            signer: false,
            writable: true,
          },
          { address: from.address, signer: true, writable: false },
        ],
        data: d,
      },
    ],
    SEND,
  );
  return signature;
}
