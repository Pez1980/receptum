// Review round 4, finding 2: an RPC override must not bypass the mainnet opt-in. Before every
// transaction signature the adapter asks the RPC for its genesis hash, maps it to the CAIP-2
// network, requires that to equal the declared network and only then applies the opt-in to that
// verified network. Nothing is ever sent: the RPC below is a mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainnetNotAllowedError } from "@receptum/core";
import { DEVNET_USDC_MINT } from "./address.js";
import { SolanaAnchor } from "./anchor.js";
import { SolanaEscrowRail } from "./escrow.js";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "./network.js";
import { formatSolanaEscrowId, RECEPTUM_SOLANA_PROGRAM_ID } from "./program.js";
import { rpcNetwork, type SolanaRpc } from "./rpc.js";
import {
  assertRpcNetwork,
  sendAndConfirm,
  solanaKeypair,
  type SolanaKeypair,
} from "./transaction.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const HASH = "ab".repeat(32);
const BLOCKHASH = "11111111111111111111111111111111";

/** A keypair (public test seed) that counts its signatures. */
function counted(): SolanaKeypair & { signed: number } {
  const k = solanaKeypair(new Uint8Array(32).fill(7));
  const c = {
    address: k.address,
    signed: 0,
    sign(m: Uint8Array) {
      c.signed++;
      return k.sign(m);
    },
  };
  return c;
}

/** A mock JSON-RPC serving the cluster with `genesis`; records every method called. */
function mockRpc(genesis: unknown) {
  const calls: string[] = [];
  const rpc: SolanaRpc = async (method) => {
    calls.push(method);
    switch (method) {
      case "getGenesisHash":
        if (genesis instanceof Error) throw genesis;
        return genesis;
      case "getLatestBlockhash":
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
      case "sendTransaction":
        return "sig";
      case "getSignatureStatuses":
        return { value: [{ slot: 1, err: null, confirmationStatus: "confirmed" }] };
      case "getBlockHeight":
        return 1;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, calls };
}

const memoIx = (signer: string) => [
  {
    programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    accounts: [{ address: signer, signer: true, writable: false }],
    data: new TextEncoder().encode("x"),
  },
];

beforeEach(() => vi.stubEnv("RECEPTUM_ALLOW_MAINNET", ""));
afterEach(() => vi.unstubAllEnvs());

describe("rpcNetwork", () => {
  it("maps the genesis hash to its CAIP-2 id", async () => {
    expect(await rpcNetwork(mockRpc(DEVNET_GENESIS).rpc)).toBe(SOLANA_DEVNET);
    expect(await rpcNetwork(mockRpc(MAINNET_GENESIS).rpc)).toBe(SOLANA_MAINNET);
  });
  it("throws on a reply that is not a genesis hash", async () => {
    await expect(rpcNetwork(mockRpc(null).rpc)).rejects.toThrow(/genesis/);
    await expect(rpcNetwork(mockRpc("0OIl").rpc)).rejects.toThrow(/genesis/);
  });
});

describe("assertRpcNetwork", () => {
  it("passes for a devnet RPC declared as devnet", async () => {
    await expect(assertRpcNetwork(mockRpc(DEVNET_GENESIS).rpc, SOLANA_DEVNET)).resolves.toBe(
      SOLANA_DEVNET,
    );
  });
  it("refuses a mainnet RPC declared as devnet, even with allowMainnet", async () => {
    for (const allow of [false, true, undefined])
      await expect(
        assertRpcNetwork(mockRpc(MAINNET_GENESIS).rpc, SOLANA_DEVNET, allow),
      ).rejects.toThrow(/serves solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, not solana:EtWT/);
  });
  it("refuses a mainnet RPC declared as mainnet without the opt-in", async () => {
    await expect(
      assertRpcNetwork(mockRpc(MAINNET_GENESIS).rpc, SOLANA_MAINNET, false),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
    await expect(
      assertRpcNetwork(mockRpc(MAINNET_GENESIS).rpc, SOLANA_MAINNET),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
  });
  it("allows a verified mainnet with the opt-in (option or env)", async () => {
    await expect(
      assertRpcNetwork(mockRpc(MAINNET_GENESIS).rpc, SOLANA_MAINNET, true),
    ).resolves.toBe(SOLANA_MAINNET);
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    await expect(assertRpcNetwork(mockRpc(MAINNET_GENESIS).rpc, SOLANA_MAINNET)).resolves.toBe(
      SOLANA_MAINNET,
    );
  });
  it("refuses an unknown cluster without the opt-in, and when the RPC fails", async () => {
    const local = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"; // Solana testnet: not in the registry
    await expect(
      assertRpcNetwork(mockRpc("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY").rpc, local),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
    await expect(assertRpcNetwork(mockRpc(new Error("down")).rpc, SOLANA_DEVNET)).rejects.toThrow(
      /down/,
    );
  });
});

describe("nothing is signed unless the RPC serves the declared, allowed network", () => {
  it("sendAndConfirm: mainnet genesis + allowMainnet false → refused before signing", async () => {
    const signer = counted();
    const { rpc, calls } = mockRpc(MAINNET_GENESIS);
    await expect(
      sendAndConfirm(rpc, signer, memoIx(signer.address), {
        network: SOLANA_MAINNET,
        allowMainnet: false,
      }),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
    await expect(
      sendAndConfirm(rpc, signer, memoIx(signer.address), { network: SOLANA_DEVNET }),
    ).rejects.toThrow(/not solana:EtWT/);
    expect(signer.signed).toBe(0);
    expect(calls.filter((c) => c !== "getGenesisHash")).toEqual([]);
  });

  it("sendAndConfirm signs and sends once the devnet RPC is verified", async () => {
    const signer = counted();
    const { rpc, calls } = mockRpc(DEVNET_GENESIS);
    const r = await sendAndConfirm(rpc, signer, memoIx(signer.address), {
      network: SOLANA_DEVNET,
      timeoutMs: 5_000,
    });
    expect(r.slot).toBe(1);
    expect(signer.signed).toBe(1);
    expect(calls[0]).toBe("getGenesisHash");
  });

  it("checks the RPC again before every signature", async () => {
    const signer = counted();
    let genesis = DEVNET_GENESIS;
    const { rpc: inner } = mockRpc(DEVNET_GENESIS);
    const rpc: SolanaRpc = async (m, p) => (m === "getGenesisHash" ? genesis : inner(m, p));
    await sendAndConfirm(rpc, signer, memoIx(signer.address), { network: SOLANA_DEVNET });
    genesis = MAINNET_GENESIS; // the endpoint now points at mainnet
    await expect(
      sendAndConfirm(rpc, signer, memoIx(signer.address), { network: SOLANA_DEVNET }),
    ).rejects.toThrow(/not solana:EtWT/);
    expect(signer.signed).toBe(1);
  });

  it("SolanaAnchor with a mainnet rpcUrl/rpc override declared as devnet refuses to sign", async () => {
    const signer = counted();
    const { rpc } = mockRpc(MAINNET_GENESIS);
    await expect(new SolanaAnchor({ rpc, signer }).anchor(HASH)).rejects.toThrow(/not solana:/);
    await expect(
      new SolanaAnchor({ network: SOLANA_MAINNET, rpc, signer, allowMainnet: false }).anchor(HASH),
    ).rejects.toBeInstanceOf(MainnetNotAllowedError);
    expect(signer.signed).toBe(0);
  });

  it("SolanaEscrowRail refuses every signing call on a mainnet RPC without the opt-in", async () => {
    const signer = counted();
    const { rpc, calls } = mockRpc(MAINNET_GENESIS);
    const devnet = new SolanaEscrowRail({ rpc, signer });
    const mainnet = new SolanaEscrowRail({ network: SOLANA_MAINNET, rpc, signer });
    const open = {
      seller: solanaKeypair(new Uint8Array(32).fill(8)).address,
      mint: DEVNET_USDC_MINT,
      amount: 1n,
      deliverBy: new Date(Date.now() + 60_000),
      reviewWindowSeconds: 0,
    };
    await expect(devnet.open(open)).rejects.toThrow(/not solana:EtWT/);
    await expect(mainnet.open(open)).rejects.toBeInstanceOf(MainnetNotAllowedError);
    const id = formatSolanaEscrowId(SOLANA_DEVNET, RECEPTUM_SOLANA_PROGRAM_ID, DEVNET_USDC_MINT);
    await expect(devnet.deliver(id, HASH)).rejects.toThrow(/not solana:EtWT/);
    for (const call of ["accept", "reject", "release", "refund", "sellerRefund"] as const)
      await expect(devnet[call](id)).rejects.toThrow(/not solana:EtWT/);
    expect(signer.signed).toBe(0);
    expect(calls.every((c) => c === "getGenesisHash")).toBe(true);
  });
});
