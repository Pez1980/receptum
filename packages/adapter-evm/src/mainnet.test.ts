import { afterEach, describe, expect, it, vi } from "vitest";
import { MainnetNotAllowedError } from "@receptum/core";
import { privateKeyToAccount } from "viem/accounts";
import {
  clientsFor,
  deployEscrow,
  EvmAnchor,
  EvmEscrowRail,
  MAINNETS,
  NETWORKS,
  TESTNETS,
  type EvmClients,
  type EvmNetwork,
} from "./index.js";

// A public, well-known dev key (anvil #0). Nothing is ever sent: the clients below are mocks.
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const H = "ab".repeat(32);
const TX = `0x${"11".repeat(32)}` as const;

afterEach(() => vi.unstubAllEnvs());

function mocked(network: EvmNetwork, allowMainnet?: boolean) {
  const walletClient = {
    sendTransaction: vi.fn(async () => TX),
    writeContract: vi.fn(async () => TX),
    deployContract: vi.fn(async () => TX),
  };
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      contractAddress: "0x2222222222222222222222222222222222222222",
      logs: [],
    })),
  };
  const c = {
    network,
    account,
    walletClient,
    publicClient,
    ...(allowMainnet !== undefined ? { allowMainnet } : {}),
  } as unknown as EvmClients;
  return { c, walletClient };
}

describe("EVM mainnet entries", () => {
  it("lists Base, Arc and Arbitrum One mainnet with Circle USDC", () => {
    expect(MAINNETS["eip155:8453"]).toMatchObject({
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      explorer: "https://basescan.org",
      mainnet: true,
    });
    expect(MAINNETS["eip155:8453"].chain.id).toBe(8453);
    expect(MAINNETS["eip155:5042"]).toMatchObject({
      usdc: "0x3600000000000000000000000000000000000000",
      explorer: "https://explorer.arc.io",
      mainnet: true,
    });
    expect(MAINNETS["eip155:5042"].chain.id).toBe(5042);
    // Native USDC on Arbitrum One (not the bridged USDC.e).
    expect(MAINNETS["eip155:42161"]).toMatchObject({
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      explorer: "https://arbiscan.io",
      mainnet: true,
    });
    expect(TESTNETS["eip155:421614"]).toMatchObject({
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      explorer: "https://sepolia.arbiscan.io",
      mainnet: false,
    });
    for (const n of Object.values(TESTNETS)) expect(n.mainnet).toBe(false);
    expect(Object.keys(NETWORKS).sort()).toEqual(
      [
        "eip155:5042002",
        "eip155:84532",
        "eip155:421614",
        "eip155:8453",
        "eip155:5042",
        "eip155:42161",
      ].sort(),
    );
    for (const [id, n] of Object.entries(NETWORKS)) expect(`eip155:${n.chain.id}`).toBe(id);
  });
});

describe("clientsFor mainnet gate", () => {
  it("refuses mainnet without the opt-in", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() => clientsFor("eip155:8453", account)).toThrow(MainnetNotAllowedError);
    expect(() => clientsFor("eip155:5042", account, "https://rpc.example")).toThrow(
      /explicit opt-in/,
    );
    expect(() => clientsFor("eip155:8453", account, { allowMainnet: false })).toThrow();
    expect(() => clientsFor("eip155:42161", account)).toThrow(MainnetNotAllowedError);
  });

  it("allows mainnet with allowMainnet or RECEPTUM_ALLOW_MAINNET=1", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const c = clientsFor("eip155:8453", account, { allowMainnet: true });
    expect(c.network.caip2).toBe("eip155:8453");
    expect(c.allowMainnet).toBe(true);
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    expect(clientsFor("eip155:5042", account).network.chain.id).toBe(5042);
  });

  it("keeps testnets the default, without any opt-in", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(clientsFor("eip155:84532", account).network.mainnet).toBe(false);
    expect(clientsFor("eip155:421614", account).network.mainnet).toBe(false);
    expect(clientsFor("eip155:5042002", account, { allowMainnet: false }).network.mainnet).toBe(
      false,
    );
  });
});

describe("signing paths refuse mainnet before signing", () => {
  const base = MAINNETS["eip155:8453"];
  const escrowId = `eip155:8453:0x1111111111111111111111111111111111111111:1`;
  const unknown: EvmNetwork = { ...TESTNETS["eip155:84532"], caip2: "eip155:1", mainnet: false };

  it("never calls the wallet without the opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { c, walletClient } = mocked(base);
    await expect(new EvmAnchor(c).anchor(H)).rejects.toThrow(MainnetNotAllowedError);
    await expect(deployEscrow(c)).rejects.toThrow(MainnetNotAllowedError);
    const rail = new EvmEscrowRail(c);
    await expect(
      rail.open({
        contract: "0x1111111111111111111111111111111111111111",
        seller: "0x3333333333333333333333333333333333333333",
        amount: 1n,
        deliverBy: new Date(),
        reviewWindowSeconds: 0,
      }),
    ).rejects.toThrow(MainnetNotAllowedError);
    for (const call of [
      () => rail.deliver(escrowId, H),
      () => rail.accept(escrowId),
      () => rail.reject(escrowId),
      () => rail.release(escrowId),
      () => rail.refund(escrowId),
      () => rail.sellerRefund(escrowId),
    ])
      await expect(call()).rejects.toThrow(MainnetNotAllowedError);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(walletClient.deployContract).not.toHaveBeenCalled();
  });

  it("fails closed on a hand-built network the registry doesn't know", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { c, walletClient } = mocked(unknown);
    await expect(new EvmAnchor(c).anchor(H)).rejects.toThrow(/unknown network/);
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it("signs (on the mock) once opted in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { c, walletClient } = mocked(base, true);
    const record = await new EvmAnchor(c).anchor(H);
    expect(record).toMatchObject({ network: "eip155:8453", reference: TX });
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
    await rail(c).deliver(escrowId, H);
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(await deployEscrow(c)).toBe("0x2222222222222222222222222222222222222222");
  });

  it("does not gate testnets", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { c, walletClient } = mocked(TESTNETS["eip155:84532"], false);
    await new EvmAnchor(c).anchor(H);
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
  });
});

const rail = (c: EvmClients) => new EvmEscrowRail(c);
