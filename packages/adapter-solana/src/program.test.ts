// Program tests for receptum_escrow, run against the published build (program/receptum_escrow.so)
// in LiteSVM — the real SBF runtime with the real SPL Token and Associated Token programs.
import { readFileSync } from "node:fs";
import { Clock, LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { associatedTokenAddress, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./address.js";
import { decodeBase58 } from "./base58.js";
import {
  createAtaIdempotentInstruction,
  decodeEscrowAccount,
  deliverInstruction,
  elfHash,
  ESCROW_ERRORS,
  escrowAddress,
  openInstruction,
  payoutInstruction,
  RECEPTUM_SOLANA_PROGRAM_HASH,
  RECEPTUM_SOLANA_PROGRAM_ID,
  vaultAddress,
  type PayoutKind,
  type SolanaEscrowAccount,
} from "./program.js";
import {
  compileMessage,
  solanaKeypair,
  type SolanaKeypair,
  type TransactionInstruction,
} from "./transaction.js";

const SO = new URL("../program/receptum_escrow.so", import.meta.url);
const PROGRAM = RECEPTUM_SOLANA_PROGRAM_ID;
const HASH = "ab".repeat(32);

// Deterministic test keys (public test values).
const kp = (n: number) => solanaKeypair(new Uint8Array(32).fill(n));
const buyer = kp(1);
const seller = kp(2);
const evaluator = kp(3);
const stranger = kp(4);
const MINT = kp(9).address;

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let svm: LiteSVM;
let now = 1_800_000_000n;

function setClock(unix: bigint) {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix));
  now = unix;
}

function setAccount(address: string, owner: string, data: Uint8Array, lamports = 1_000_000_000n) {
  svm.setAccount({
    address,
    data,
    executable: false,
    lamports,
    programAddress: owner,
    space: BigInt(data.length),
  } as Any);
}

function mintData(decimals = 6): Uint8Array {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(10n ** 12n, 36);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

function tokenAccountData(mint: string, owner: string, amount: bigint): Uint8Array {
  const d = Buffer.alloc(165);
  Buffer.from(decodeBase58(mint)).copy(d, 0);
  Buffer.from(decodeBase58(owner)).copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}

function balance(address: string): bigint {
  const a = svm.getAccount(address as Any) as Any;
  if (!a.exists) return -1n;
  return Buffer.from(a.data).readBigUInt64LE(64);
}

const ata = (owner: string, mint = MINT) => associatedTokenAddress(owner, mint);

/** Sends a transaction; returns null on success or the custom error name / error text. */
function send(ixs: TransactionInstruction[], payer: SolanaKeypair, extra: SolanaKeypair[] = []) {
  svm.expireBlockhash();
  const { message, signers } = compileMessage(payer.address, ixs, svm.latestBlockhash());
  const all = [payer, ...extra];
  const signatures: Record<string, Uint8Array> = {};
  for (const s of signers) signatures[s] = all.find((k) => k.address === s)!.sign(message);
  const res = svm.sendTransaction({ messageBytes: message, signatures } as Any) as Any;
  if (typeof res.err !== "function") return null;
  const text = String(res.toString());
  const m = /Custom\((\d+)\)/.exec(text) ?? /custom program error: 0x([0-9a-f]+)/.exec(text);
  if (m) return ESCROW_ERRORS[m[0].startsWith("Custom") ? Number(m[1]) : parseInt(m[1]!, 16)];
  return text;
}

function state(escrow: string): SolanaEscrowAccount {
  const a = svm.getAccount(escrow as Any) as Any;
  return decodeEscrowAccount(new Uint8Array(a.data));
}

let nextId = 1n;
function open(over: Partial<Parameters<typeof openInstruction>[0]> = {}, signer = buyer) {
  const id = nextId++;
  const p = {
    buyer: signer.address,
    seller: seller.address,
    mint: MINT,
    amount: 2_500_000n,
    deliverBy: (Number(now) + 3600) as number | bigint,
    reviewWindowSeconds: 600,
    evaluator: null as string | null,
    id,
    ...over,
  };
  const err = send([openInstruction(p)], signer);
  const escrow = escrowAddress(p.buyer, p.id).address;
  return { err, escrow, id };
}

const payout = (kind: PayoutKind, escrow: string, signer: SolanaKeypair) => {
  const e = state(escrow);
  const needs = kind === "accept" || kind === "reject" || kind === "sellerRefund";
  return send([payoutInstruction(kind, escrow, e, needs ? signer.address : undefined)], signer);
};

beforeEach(() => {
  svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM as Any, SO.pathname);
  now = 1_800_000_000n;
  setClock(now);
  for (const k of [buyer, seller, evaluator, stranger])
    svm.airdrop(k.address as Any, 10_000_000_000n as Any);
  setAccount(MINT, TOKEN_PROGRAM_ID, mintData());
  setAccount(
    ata(buyer.address),
    TOKEN_PROGRAM_ID,
    tokenAccountData(MINT, buyer.address, 10_000_000n),
    2_039_280n,
  );
  setAccount(
    ata(seller.address),
    TOKEN_PROGRAM_ID,
    tokenAccountData(MINT, seller.address, 0n),
    2_039_280n,
  );
});

describe("receptum_escrow build", () => {
  it("is the published build", () => {
    expect(elfHash(readFileSync(SO))).toBe(RECEPTUM_SOLANA_PROGRAM_HASH);
  });
});

/** Anyone sends `n` units of the mint straight to `vault` (a real SPL Token transferChecked). */
function donate(vault: string, n: bigint) {
  const from = ata(stranger.address);
  if (balance(from) < 0n)
    setAccount(
      from,
      TOKEN_PROGRAM_ID,
      tokenAccountData(MINT, stranger.address, 1_000_000n),
      2_039_280n,
    );
  const d = Buffer.alloc(10);
  d[0] = 12;
  d.writeBigUInt64LE(n, 1);
  d[9] = 6;
  const err = send(
    [
      {
        programId: TOKEN_PROGRAM_ID,
        accounts: [
          { address: from, signer: false, writable: true },
          { address: MINT, signer: false, writable: false },
          { address: vault, signer: false, writable: true },
          { address: stranger.address, signer: true, writable: false },
        ],
        data: d,
      },
    ],
    stranger,
  );
  expect(err).toBeNull();
}

describe("receptum_escrow vault donations (review round 4)", () => {
  // Anyone can send tokens to the vault. A payout must still settle — moving the WHOLE vault
  // (amount + donation) to the authorized recipient — instead of locking the escrow forever.
  const DONATION = 1n;
  const funded = (over: Partial<Parameters<typeof openInstruction>[0]> = {}) => {
    const { escrow, err } = open(over);
    expect(err).toBeNull();
    return { escrow, vault: state(escrow).vault };
  };

  it("accept pays the seller the whole vault", () => {
    const { escrow, vault } = funded();
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    donate(vault, DONATION);
    expect(balance(vault)).toBe(2_500_001n);
    expect(payout("accept", escrow, buyer)).toBeNull();
    expect(state(escrow).status).toBe("released");
    expect(state(escrow).amount).toBe(2_500_000n);
    expect(balance(ata(seller.address))).toBe(2_500_001n);
    expect(balance(vault)).toBe(-1n);
  });

  it("reject refunds the buyer the whole vault", () => {
    const { escrow, vault } = funded({ evaluator: evaluator.address });
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    donate(vault, 7n);
    expect(payout("reject", escrow, evaluator)).toBeNull();
    expect(state(escrow).status).toBe("refunded");
    expect(balance(ata(buyer.address))).toBe(10_000_007n);
    expect(balance(vault)).toBe(-1n);
  });

  it("release (anyone, after the window) pays the seller the whole vault", () => {
    const { escrow, vault } = funded();
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    donate(vault, DONATION);
    setClock(now + 600n);
    expect(payout("release", escrow, stranger)).toBeNull();
    expect(state(escrow).status).toBe("released");
    expect(balance(ata(seller.address))).toBe(2_500_001n);
    expect(balance(vault)).toBe(-1n);
  });

  it("refund (anyone, after the deadline) returns the whole vault to the buyer", () => {
    const { escrow, vault } = funded();
    donate(vault, DONATION);
    setClock(now + 3601n);
    expect(payout("refund", escrow, stranger)).toBeNull();
    expect(state(escrow).status).toBe("refunded");
    expect(balance(ata(buyer.address))).toBe(10_000_001n);
    expect(balance(vault)).toBe(-1n);
  });

  it("sellerRefund returns the whole vault to the buyer, before or after delivery", () => {
    const a = funded();
    donate(a.vault, DONATION);
    expect(payout("sellerRefund", a.escrow, seller)).toBeNull();
    expect(balance(a.vault)).toBe(-1n);
    const b = funded();
    expect(send([deliverInstruction(b.escrow, seller.address, HASH)], seller)).toBeNull();
    donate(b.vault, 3n);
    expect(payout("sellerRefund", b.escrow, seller)).toBeNull();
    expect(state(b.escrow).status).toBe("refunded");
    expect(balance(ata(buyer.address))).toBe(10_000_004n);
    expect(balance(b.vault)).toBe(-1n);
  });

  it("a donation never redirects funds: the recipient is still fixed by the escrow", () => {
    const { escrow, vault } = funded();
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    donate(vault, 1_000n);
    const evil = ata(stranger.address);
    const pay = payoutInstruction("accept", escrow, state(escrow), buyer.address);
    pay.accounts[3]!.address = evil;
    expect(send([pay], buyer)).toBe("InvalidArgs");
    expect(payout("accept", escrow, buyer)).toBeNull();
    expect(balance(ata(seller.address))).toBe(2_501_000n);
  });
});

describe("receptum_escrow state machine", () => {
  it("A: buyer accepts → released to the seller, vault closed", () => {
    const { err, escrow } = open();
    expect(err).toBeNull();
    let e = state(escrow);
    expect(e.status).toBe("open");
    expect(e.amount).toBe(2_500_000n);
    expect(e.vault).toBe(vaultAddress(escrow).address);
    expect(balance(e.vault)).toBe(2_500_000n);
    expect(balance(ata(buyer.address))).toBe(7_500_000n);
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    e = state(escrow);
    expect(e.status).toBe("delivered");
    expect(e.receiptHash).toBe(HASH);
    expect(e.deliveredAt).toBe(Number(now));
    expect(payout("accept", escrow, buyer)).toBeNull();
    e = state(escrow);
    expect(e.status).toBe("released");
    expect(e.settledBy).toBe(buyer.address);
    expect(balance(ata(seller.address))).toBe(2_500_000n);
    expect(balance(e.vault)).toBe(-1n);
    // Settled escrows can't move again.
    expect(payout("accept", escrow, buyer)).toBe("BadState");
    expect(payout("sellerRefund", escrow, seller)).toBe("BadState");
  });

  it("B: anyone releases after the review window, not before", () => {
    const { escrow } = open();
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    expect(payout("release", escrow, stranger)).toBe("TooEarly");
    setClock(now + 599n);
    expect(payout("release", escrow, stranger)).toBe("TooEarly");
    setClock(now + 1n);
    expect(payout("reject", escrow, buyer)).toBe("TooLate");
    expect(payout("release", escrow, stranger)).toBeNull();
    const e = state(escrow);
    expect(e.status).toBe("released");
    expect(e.settledBy).toBeNull();
    expect(balance(ata(seller.address))).toBe(2_500_000n);
  });

  it("C: anyone refunds after a missed deadline; late delivery is refused", () => {
    const { escrow } = open();
    expect(payout("refund", escrow, stranger)).toBe("TooEarly");
    setClock(now + 3601n);
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBe("TooLate");
    expect(payout("refund", escrow, stranger)).toBeNull();
    expect(state(escrow).status).toBe("refunded");
    expect(balance(ata(buyer.address))).toBe(10_000_000n);
  });

  it("D: the evaluator rejects within the window → refunded", () => {
    const { escrow, err } = open({ evaluator: evaluator.address });
    expect(err).toBeNull();
    expect(state(escrow).evaluator).toBe(evaluator.address);
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    expect(payout("reject", escrow, stranger)).toBe("NotAllowed");
    expect(payout("reject", escrow, seller)).toBe("NotAllowed");
    expect(payout("reject", escrow, evaluator)).toBeNull();
    const e = state(escrow);
    expect(e.status).toBe("refunded");
    expect(e.settledBy).toBe(evaluator.address);
    expect(balance(ata(buyer.address))).toBe(10_000_000n);
  });

  it("evaluator accepts → released", () => {
    const { escrow } = open({ evaluator: evaluator.address });
    send([deliverInstruction(escrow, seller.address, HASH)], seller);
    expect(payout("accept", escrow, evaluator)).toBeNull();
    expect(state(escrow).settledBy).toBe(evaluator.address);
  });

  it("E: the seller refunds before or after delivery", () => {
    const a = open();
    expect(payout("sellerRefund", a.escrow, buyer)).toBe("NotAllowed");
    expect(payout("sellerRefund", a.escrow, seller)).toBeNull();
    expect(state(a.escrow).status).toBe("refunded");
    expect(state(a.escrow).settledBy).toBe(seller.address);
    const b = open();
    send([deliverInstruction(b.escrow, seller.address, HASH)], seller);
    expect(payout("sellerRefund", b.escrow, seller)).toBeNull();
    expect(balance(ata(buyer.address))).toBe(10_000_000n);
  });

  it("deliver: seller only, once, non-zero hash", () => {
    const { escrow } = open();
    expect(send([deliverInstruction(escrow, stranger.address, HASH)], stranger)).toBe("NotAllowed");
    // seller account present but not signing
    const ix = deliverInstruction(escrow, seller.address, HASH);
    ix.accounts[0]!.signer = false;
    expect(send([ix], stranger)).toBe("NotAllowed");
    expect(send([deliverInstruction(escrow, seller.address, "00".repeat(32))], seller)).toBe(
      "InvalidArgs",
    );
    expect(send([deliverInstruction(escrow, seller.address, HASH)], seller)).toBeNull();
    expect(send([deliverInstruction(escrow, seller.address, "cd".repeat(32))], seller)).toBe(
      "BadState",
    );
    expect(state(escrow).receiptHash).toBe(HASH);
    // Accept/reject need a delivery; refund needs none.
    setClock(now + 3601n);
    expect(payout("refund", escrow, stranger)).toBe("BadState");
  });

  it("accept/reject before delivery are refused", () => {
    const { escrow } = open();
    expect(payout("accept", escrow, buyer)).toBe("BadState");
    expect(payout("reject", escrow, buyer)).toBe("BadState");
    expect(payout("release", escrow, buyer)).toBe("BadState");
  });

  it("open validates its terms", () => {
    expect(open({ amount: 0n }).err).toBe("InvalidArgs");
    expect(open({ seller: buyer.address }).err).toBe("InvalidArgs");
    expect(open({ evaluator: buyer.address }).err).toBe("InvalidArgs");
    expect(open({ evaluator: seller.address }).err).toBe("InvalidArgs");
    expect(open({ deliverBy: Number(now) }).err).toBe("InvalidArgs");
    expect(open({ deliverBy: 2n ** 63n - 10n, reviewWindowSeconds: 100 }).err).toBe("Overflow");
    // More than the buyer holds: the token transfer fails, nothing is created.
    const r = open({ amount: 10_000_001n });
    expect(r.err).not.toBeNull();
    expect((svm.getAccount(r.escrow as Any) as Any).exists).toBe(false);
  });

  it("open refuses a reused id and a wrong escrow address", () => {
    const first = open();
    expect(first.err).toBeNull();
    nextId--;
    expect(open().err).toBe("BadState");
    const ix = openInstruction({
      buyer: buyer.address,
      seller: seller.address,
      mint: MINT,
      amount: 1n,
      deliverBy: Number(now) + 60,
      reviewWindowSeconds: 0,
      id: 777n,
    });
    ix.accounts[2]!.address = escrowAddress(buyer.address, 778n).address;
    expect(send([ix], buyer)).toBe("InvalidArgs");
  });

  it("open survives a pre-funded escrow address", () => {
    const id = 4242n;
    const escrow = escrowAddress(buyer.address, id).address;
    svm.airdrop(escrow as Any, 5_000n as Any);
    nextId = id;
    expect(open().err).toBeNull();
    expect(state(escrow).status).toBe("open");
  });

  it("refuses Token-2022 and foreign token accounts", () => {
    const ix = openInstruction({
      buyer: buyer.address,
      seller: seller.address,
      mint: MINT,
      amount: 1n,
      deliverBy: Number(now) + 60,
      reviewWindowSeconds: 0,
      id: 900n,
    });
    ix.accounts[6]!.address = TOKEN_2022_PROGRAM_ID;
    expect(send([ix], buyer)).toBe("UnsupportedToken");

    // A payout to a token account the seller doesn't own fails.
    const { escrow } = open();
    send([deliverInstruction(escrow, seller.address, HASH)], seller);
    const e = state(escrow);
    const evil = ata(stranger.address);
    setAccount(evil, TOKEN_PROGRAM_ID, tokenAccountData(MINT, stranger.address, 0n), 2_039_280n);
    const pay = payoutInstruction("accept", escrow, e, buyer.address);
    pay.accounts[3]!.address = evil;
    expect(send([pay], buyer)).toBe("InvalidArgs");
    // …and so does naming someone else as the buyer (vault rent recipient).
    const pay2 = payoutInstruction("accept", escrow, e, buyer.address);
    pay2.accounts[4]!.address = stranger.address;
    expect(send([pay2], buyer)).toBe("InvalidArgs");
    expect(payout("accept", escrow, buyer)).toBeNull();
    expect(balance(evil)).toBe(0n);
  });

  it("rejects an account that only looks like an escrow", () => {
    const { escrow } = open();
    const fake = kp(20).address;
    const a = svm.getAccount(escrow as Any) as Any;
    setAccount(fake, PROGRAM, new Uint8Array(a.data));
    expect(send([deliverInstruction(fake, seller.address, HASH)], seller)).toBe("NotFound");
    setAccount(fake, stranger.address, new Uint8Array(a.data));
    expect(send([deliverInstruction(fake, seller.address, HASH)], seller)).toBe("NotFound");
  });

  it("pays a seller whose token account is created in the same transaction", () => {
    const { escrow } = open({ seller: stranger.address });
    send([deliverInstruction(escrow, stranger.address, HASH)], stranger);
    const e = state(escrow);
    expect(
      send(
        [
          createAtaIdempotentInstruction(buyer.address, stranger.address, MINT),
          payoutInstruction("accept", escrow, e, buyer.address),
        ],
        buyer,
      ),
    ).toBeNull();
    expect(balance(ata(stranger.address))).toBe(2_500_000n);
  });
});
