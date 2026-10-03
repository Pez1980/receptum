import { readFileSync } from "node:fs";
import {
  DEVNET_USDC_MINT,
  encodeBase58,
  escrowAddress,
  RECEPTUM_SOLANA_PROGRAM_ID,
  SOLANA_DEVNET,
  vaultAddress,
  type ParsedTransaction,
  type SolanaRpc,
} from "@receptum/adapter-solana";
import type { SignedReceipt } from "@receptum/core";
import { describe, expect, it } from "vitest";
import {
  verifySolanaAnchor,
  verifySolanaEscrowPayment,
  verifySolanaX402Payment,
} from "./solana.js";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1y1MCnvwMbRuv"; // devnet genesis hash
const SIG = encodeBase58(new Uint8Array(64).fill(7));
const PAYER = encodeBase58(new Uint8Array(32).fill(1));
const PAYEE = encodeBase58(new Uint8Array(32).fill(2));
const SRC = encodeBase58(new Uint8Array(32).fill(3));
const DST = encodeBase58(new Uint8Array(32).fill(4));
const FEE = encodeBase58(new Uint8Array(32).fill(5));
const HASH = "ab".repeat(32);

const bal = (accountIndex: number, owner: string, amount: string) => ({
  accountIndex,
  mint: DEVNET_USDC_MINT,
  owner,
  uiTokenAmount: { amount, decimals: 6 },
});

function x402Tx(over: { amount?: string; dest?: string; err?: unknown; post?: string } = {}) {
  const tx: ParsedTransaction = {
    slot: 123,
    blockTime: 1_800_000_000,
    meta: {
      err: over.err ?? null,
      preTokenBalances: [bal(1, PAYER, "5000000"), bal(2, PAYEE, "0")],
      postTokenBalances: [bal(1, PAYER, "4990000"), bal(2, PAYEE, over.post ?? "10000")],
      innerInstructions: [],
    },
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: [FEE, SRC, DST].map((pubkey, i) => ({
          pubkey,
          signer: i === 0,
          writable: true,
        })),
        instructions: [
          {
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                source: SRC,
                destination: over.dest ?? DST,
                mint: DEVNET_USDC_MINT,
                authority: PAYER,
                tokenAmount: { amount: over.amount ?? "10000", decimals: 6 },
              },
            },
          },
          {
            programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            program: "spl-memo",
            parsed: `receptum/1:${HASH}`,
          },
        ],
      },
    },
  };
  return tx;
}

function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>): SolanaRpc {
  return async (method, params) => {
    if (method === "getGenesisHash") return handlers.getGenesisHash?.(params) ?? GENESIS;
    const h = handlers[method];
    if (!h) throw new Error(`unexpected ${method}`);
    return h(params);
  };
}

const payment = {
  network: SOLANA_DEVNET,
  asset: DEVNET_USDC_MINT,
  amount: "10000",
  reference: SIG,
  payee: `${SOLANA_DEVNET}:${PAYEE}`,
  payer: `${SOLANA_DEVNET}:${PAYER}`,
};

describe("x402 exact on Solana", () => {
  const withTx = (tx: ParsedTransaction | null) => fakeRpc({ getTransaction: () => tx });

  it("passes a matching transferChecked", async () => {
    const r = await verifySolanaX402Payment(payment, { rpc: withTx(x402Tx()) });
    expect(r).toMatchObject({ status: "pass" });
    expect(r.detail).toMatch(/slot 123 \(finalized\)/);
  });

  it("fails a different amount, recipient, a failed tx or a short balance change", async () => {
    for (const tx of [
      x402Tx({ amount: "9999" }),
      x402Tx({ dest: SRC }),
      x402Tx({ err: { InstructionError: [0, "Custom"] } }),
      x402Tx({ post: "20000" }),
    ])
      expect((await verifySolanaX402Payment(payment, { rpc: withTx(tx) })).status).toBe("fail");
    const otherPayer = { ...payment, payer: `${SOLANA_DEVNET}:${PAYEE}` };
    expect((await verifySolanaX402Payment(otherPayer, { rpc: withTx(x402Tx()) })).status).toBe(
      "fail",
    );
  });

  it("validates the receipt before asking the chain", async () => {
    const rpc = fakeRpc({});
    for (const p of [
      { ...payment, reference: "0x" + "ab".repeat(32) },
      { ...payment, asset: "USDC" },
      { ...payment, amount: "1.5" },
      { ...payment, payee: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${PAYEE}` },
    ])
      expect((await verifySolanaX402Payment(p, { rpc })).status).toBe("fail");
    const { payee: _, ...noPayee } = payment;
    void _;
    expect((await verifySolanaX402Payment(noPayee, { rpc })).status).toBe("unavailable");
  });

  it("is unavailable for another cluster, an RPC error or a tx the node doesn't have", async () => {
    const other = fakeRpc({ getGenesisHash: () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
    expect((await verifySolanaX402Payment(payment, { rpc: other })).status).toBe("unavailable");
    const broken = fakeRpc({
      getTransaction: () => {
        throw new Error("503");
      },
    });
    expect((await verifySolanaX402Payment(payment, { rpc: broken })).status).toBe("unavailable");
    expect((await verifySolanaX402Payment(payment, { rpc: withTx(null) })).status).toBe(
      "unavailable",
    );
  });
});

describe("Solana memo anchors", () => {
  it("passes the exact memo, fails anything else", async () => {
    const rpc = fakeRpc({ getTransaction: () => x402Tx() });
    expect((await verifySolanaAnchor(HASH, SOLANA_DEVNET, SIG, { rpc })).status).toBe("pass");
    expect((await verifySolanaAnchor("cd".repeat(32), SOLANA_DEVNET, SIG, { rpc })).status).toBe(
      "fail",
    );
    const failed = fakeRpc({ getTransaction: () => x402Tx({ err: "x" }) });
    expect((await verifySolanaAnchor(HASH, SOLANA_DEVNET, SIG, { rpc: failed })).status).toBe(
      "fail",
    );
    const none = fakeRpc({ getTransaction: () => null });
    expect((await verifySolanaAnchor(HASH, SOLANA_DEVNET, SIG, { rpc: none })).status).toBe("fail");
    expect((await verifySolanaAnchor(HASH, SOLANA_DEVNET, "abc", { rpc })).status).toBe("fail");
  });
});

// ─── escrow ──────────────────────────────────────────────────────────────────

const SO = readFileSync(
  new URL("../../adapter-solana/program/receptum_escrow.so", import.meta.url),
);
const PROGRAM_DATA = encodeBase58(new Uint8Array(32).fill(8));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function programAccount() {
  const d = Buffer.alloc(36);
  d.writeUInt32LE(2, 0);
  Buffer.from(new Uint8Array(32).fill(8)).copy(d, 4);
  return d;
}
function programData(authority?: Uint8Array, so: Uint8Array = SO) {
  const d = Buffer.alloc(45 + so.length + 1000);
  d.writeUInt32LE(3, 0);
  if (authority) {
    d[12] = 1;
    Buffer.from(authority).copy(d, 13);
  }
  Buffer.from(so).copy(d, 45);
  return d;
}

const ESCROW_ID = 42n;
const ESCROW = escrowAddress(PAYER, ESCROW_ID).address;
function escrowData(over: { status?: number; hash?: string; evaluator?: Uint8Array } = {}) {
  const { bump } = escrowAddress(PAYER, ESCROW_ID);
  const vault = vaultAddress(ESCROW);
  const d = Buffer.alloc(272);
  d.write("rcptesc1", 0, "latin1");
  d[8] = 1;
  d[9] = over.status ?? 3;
  d[10] = bump;
  d[11] = vault.bump;
  Buffer.from(new Uint8Array(32).fill(1)).copy(d, 12);
  Buffer.from(new Uint8Array(32).fill(2)).copy(d, 44);
  if (over.evaluator) Buffer.from(over.evaluator).copy(d, 76);
  Buffer.from(Buffer.from(require58(DEVNET_USDC_MINT))).copy(d, 108);
  Buffer.from(require58(vault.address)).copy(d, 140);
  d.writeBigUInt64LE(ESCROW_ID, 204);
  d.writeBigUInt64LE(2_500_000n, 212);
  d.writeBigInt64LE(1_800_003_600n, 220);
  d.writeUInt32LE(600, 228);
  d.writeBigInt64LE(1_800_000_100n, 232);
  Buffer.from(over.hash ?? HASH, "hex").copy(d, 240);
  return d;
}
function require58(s: string): Uint8Array {
  // tiny local decoder (base58) to keep the test independent from the adapter's decoder
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function escrowRpc(
  accounts: Record<string, { owner: string; data: Uint8Array; executable?: boolean }>,
) {
  return fakeRpc({
    getAccountInfo: ([address]) => {
      const a = accounts[address as string];
      return {
        value: a
          ? {
              owner: a.owner,
              lamports: 1,
              executable: a.executable ?? false,
              data: [b64(a.data), "base64"],
            }
          : null,
      };
    },
  });
}
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const chain = (over: { escrow?: Uint8Array; programData?: Uint8Array } = {}) =>
  escrowRpc({
    [RECEPTUM_SOLANA_PROGRAM_ID]: { owner: LOADER, data: programAccount(), executable: true },
    [PROGRAM_DATA]: { owner: LOADER, data: over.programData ?? programData() },
    [ESCROW]: { owner: RECEPTUM_SOLANA_PROGRAM_ID, data: over.escrow ?? escrowData() },
  });

const signed = (over: Record<string, unknown> = {}, acceptance?: unknown) =>
  ({
    receiptHash: HASH,
    receipt: {
      acceptance: acceptance ?? { mode: "buyer", reviewWindowSeconds: 600 },
      payment: {
        rail: "escrow:receptum-solana",
        network: SOLANA_DEVNET,
        asset: DEVNET_USDC_MINT,
        amount: "2500000",
        reference: `${SOLANA_DEVNET}:${RECEPTUM_SOLANA_PROGRAM_ID}:${ESCROW}`,
        payer: `${SOLANA_DEVNET}:${PAYER}`,
        payee: `${SOLANA_DEVNET}:${PAYEE}`,
        ...over,
      },
    },
  }) as unknown as SignedReceipt;

const TRUSTED = [RECEPTUM_SOLANA_PROGRAM_ID];

describe("receptum_escrow on Solana", () => {
  it("passes a released escrow with matching terms", async () => {
    const r = await verifySolanaEscrowPayment(signed(), TRUSTED, { rpc: chain() });
    expect(r).toMatchObject({ status: "pass" });
  });

  it("is pending while delivered, or for an untrusted or upgradeable deployment", async () => {
    expect(
      (
        await verifySolanaEscrowPayment(signed(), TRUSTED, {
          rpc: chain({ escrow: escrowData({ status: 2 }) }),
        })
      ).status,
    ).toBe("pending");
    expect((await verifySolanaEscrowPayment(signed(), [], { rpc: chain() })).status).toBe(
      "pending",
    );
    const upgradeable = chain({ programData: programData(new Uint8Array(32).fill(9)) });
    const r = await verifySolanaEscrowPayment(signed(), TRUSTED, { rpc: upgradeable });
    expect(r.status).toBe("pending");
    expect(r.detail).toMatch(/upgradeable/);
  });

  it("fails a refunded escrow, mismatching terms or another program build", async () => {
    const cases: [SignedReceipt, ReturnType<typeof chain>][] = [
      [signed(), chain({ escrow: escrowData({ status: 4 }) })],
      [signed(), chain({ escrow: escrowData({ hash: "cd".repeat(32) }) })],
      [signed({ amount: "1" }), chain()],
      [signed({ payee: `${SOLANA_DEVNET}:${PAYER}` }), chain()],
      [signed({}, { mode: "buyer", reviewWindowSeconds: 601 }), chain()],
      [
        signed(
          {},
          { mode: "evaluator", reviewWindowSeconds: 600, evaluator: `${SOLANA_DEVNET}:${FEE}` },
        ),
        chain(),
      ],
      [signed(), chain({ escrow: escrowData({ evaluator: new Uint8Array(32).fill(5) }) })],
      [signed(), chain({ programData: programData(undefined, Buffer.from("not the build")) })],
      [signed({ reference: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:nope" }), chain()],
    ];
    for (const [s, rpc] of cases) {
      const r = await verifySolanaEscrowPayment(s, TRUSTED, { rpc });
      expect(r.status, r.detail).toBe("fail");
    }
  });

  it("accepts the declared evaluator", async () => {
    const r = await verifySolanaEscrowPayment(
      signed(
        {},
        { mode: "evaluator", reviewWindowSeconds: 600, evaluator: `${SOLANA_DEVNET}:${FEE}` },
      ),
      TRUSTED,
      { rpc: chain({ escrow: escrowData({ evaluator: new Uint8Array(32).fill(5) }) }) },
    );
    expect(r.status).toBe("pass");
  });
});
