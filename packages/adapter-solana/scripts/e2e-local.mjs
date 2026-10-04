// Integration run against a LOCAL solana-test-validator (no devnet funds needed): the adapter's
// own transaction builder, SolanaEscrowRail, SolanaAnchor and the @receptum/verify Solana checks.
//
//   solana-test-validator --reset --upgradeable-program \
//     2neqpNegEPy9zYppnbMtksNdoXLE9XDesAbBEqKUqTsg packages/adapter-solana/program/receptum_escrow.so none
//   pnpm build && node packages/adapter-solana/scripts/e2e-local.mjs
//
// Uses throwaway keys generated in memory. The verifier's cluster check is pointed at the local
// genesis by wrapping the RPC (a local validator is not devnet). Releases verify as `pending`
// locally only because the test validator cannot deploy a program without an authority.
import { randomBytes } from "node:crypto";
import {
  associatedTokenAddress,
  createAtaIdempotentInstruction,
  RECEPTUM_SOLANA_PROGRAM_ID,
  SolanaAnchor,
  SolanaEscrowRail,
  sendAndConfirm,
  solanaJsonRpc,
  solanaKeypair,
  SOLANA_DEVNET,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../dist/index.js";
import { verifySolanaAnchor, verifySolanaEscrowPayment } from "../../verify/dist/solana.js";

const URL_ = process.env.SOLANA_LOCAL_RPC ?? "http://127.0.0.1:8899";
const raw = solanaJsonRpc(URL_);
// Pretend to be devnet: the local validator is a disposable 127.0.0.1 cluster, so it is presented
// as devnet both to the adapter's signing gate (which verifies the RPC's genesis hash before every
// signature) and to the verifier's cluster check. Never point SOLANA_LOCAL_RPC at a real cluster.
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_))
  throw new Error("e2e-local only runs against a local solana-test-validator");
const rpc = async (m, p) =>
  m === "getGenesisHash" ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx" : raw(m, p);
const kp = () => solanaKeypair(randomBytes(32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [buyer, seller, evaluator, mintKp] = [kp(), kp(), kp(), kp()];
const MINT = mintKp.address;

for (const k of [buyer, seller, evaluator]) {
  const sig = await raw("requestAirdrop", [k.address, 2_000_000_000]);
  for (let i = 0; i < 30; i++) {
    const st = await raw("getSignatureStatuses", [[sig]]);
    if (st.value[0]?.confirmationStatus) break;
    await sleep(500);
  }
}

// Mint: CreateAccount + InitializeMint2(decimals 6, authority buyer) + buyer ATA + MintTo.
const rent = await raw("getMinimumBalanceForRentExemption", [82]);
const create = Buffer.alloc(52);
create.writeUInt32LE(0, 0);
create.writeBigUInt64LE(BigInt(rent), 4);
create.writeBigUInt64LE(82n, 12);
const { decodeBase58 } = await import("../dist/base58.js");
Buffer.from(decodeBase58(TOKEN_PROGRAM_ID)).copy(create, 20);
const init = Buffer.alloc(67);
init[0] = 20;
init[1] = 6;
Buffer.from(decodeBase58(buyer.address)).copy(init, 2);
init[34] = 0;
const mintTo = Buffer.alloc(9);
mintTo[0] = 7;
mintTo.writeBigUInt64LE(10_000_000n, 1);
await sendAndConfirm(
  rpc,
  buyer,
  [
    {
      programId: SYSTEM_PROGRAM_ID,
      accounts: [
        { address: buyer.address, signer: true, writable: true },
        { address: MINT, signer: true, writable: true },
      ],
      data: create,
    },
    {
      programId: TOKEN_PROGRAM_ID,
      accounts: [{ address: MINT, signer: false, writable: true }],
      data: init.subarray(0, 35),
    },
    createAtaIdempotentInstruction(buyer.address, buyer.address, MINT),
    {
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { address: MINT, signer: false, writable: true },
        { address: associatedTokenAddress(buyer.address, MINT), signer: false, writable: true },
        { address: buyer.address, signer: true, writable: false },
      ],
      data: mintTo,
    },
  ],
  { network: SOLANA_DEVNET, extraSigners: [mintKp] },
);
console.log("mint", MINT);

const rail = (signer) => new SolanaEscrowRail({ network: SOLANA_DEVNET, rpc, signer });
const HASH = randomBytes(32).toString("hex");
const signedFor = (escrowId, acceptance) => ({
  receiptHash: HASH,
  receipt: {
    acceptance,
    payment: {
      rail: "escrow:receptum-solana",
      network: SOLANA_DEVNET,
      asset: MINT,
      amount: "100000",
      reference: escrowId,
      payer: `${SOLANA_DEVNET}:${buyer.address}`,
      payee: `${SOLANA_DEVNET}:${seller.address}`,
    },
  },
});
const TRUSTED = [RECEPTUM_SOLANA_PROGRAM_ID];
const results = [];
async function flow(name, window, evaluated, act, want) {
  const { escrowId } = await rail(buyer).open({
    seller: seller.address,
    mint: MINT,
    amount: "100000",
    deliverBy: new Date(Date.now() + (name === "C" ? 3_000 : 600_000)),
    reviewWindowSeconds: window,
    ...(evaluated ? { evaluator: evaluator.address } : {}),
  });
  await act(escrowId);
  const state = await rail(buyer).getEscrow(escrowId);
  const acceptance = evaluated
    ? {
        mode: "evaluator",
        reviewWindowSeconds: window,
        evaluator: `${SOLANA_DEVNET}:${evaluator.address}`,
      }
    : { mode: "buyer", reviewWindowSeconds: window };
  const v = await verifySolanaEscrowPayment(signedFor(escrowId, acceptance), TRUSTED, { rpc });
  results.push([name, state.status, v.status, v.detail]);
  // solana-test-validator's `none` authority is the zero key, not a real "no authority" like
  // devnet's --final deployment: the verifier (rightly) stops at pending there.
  const local = want === "pass" && v.status === "pending" && /authority 1{32}\)/.test(v.detail);
  if (v.status !== want && !local)
    throw new Error(`${name}: expected ${want}, got ${v.status}: ${v.detail}`);
}
await flow(
  "A",
  600,
  false,
  async (id) => {
    await rail(seller).deliver(id, HASH);
    await rail(buyer).accept(id);
  },
  "pass",
);
await flow(
  "B",
  2,
  false,
  async (id) => {
    await rail(seller).deliver(id, HASH);
    await sleep(4000);
    await rail(evaluator).release(id);
  },
  "pass",
);
await flow(
  "C",
  600,
  false,
  async (id) => {
    await sleep(5000);
    await rail(buyer).refund(id);
  },
  "fail",
);
await flow(
  "D",
  600,
  true,
  async (id) => {
    await rail(seller).deliver(id, HASH);
    await rail(evaluator).reject(id);
  },
  "fail",
);
await flow(
  "E",
  600,
  false,
  async (id) => {
    await rail(seller).deliver(id, HASH);
    await rail(seller).sellerRefund(id);
  },
  "fail",
);
await flow(
  "F",
  600,
  true,
  async (id) => {
    await rail(seller).deliver(id, HASH);
    await rail(evaluator).accept(id);
  },
  "pass",
);

const a = await new SolanaAnchor({ network: SOLANA_DEVNET, rpc, signer: seller }).anchor(HASH);
await sleep(1000);
const av = await verifySolanaAnchor(HASH, SOLANA_DEVNET, a.reference, { rpc });
results.push(["anchor", a.reference, av.status, av.detail]);
if (av.status !== "pass") throw new Error(`anchor: ${av.detail}`);
for (const r of results) console.log(r.join(" | "));
console.log("local e2e ok");
