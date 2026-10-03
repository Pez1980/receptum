import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createReceipt, receiptHash, sha256Hex } from "@receptum/core";
import { deployEscrow, EvmEscrowRail, type EvmClients } from "./index.js";

// Integration test against a local anvil chain. Skipped when Foundry isn't installed.
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "anvil"].find((bin) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
const hasAnvil =
  Boolean(ANVIL) &&
  existsSync(new URL("../contracts/out/ReceptumEscrow.t.sol/MockUSDC.json", import.meta.url));

const PORT = 8547;
const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});
// anvil's well-known dev keys (public test values)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
] as const;

function clients(i: 0 | 1): EvmClients {
  const account = privateKeyToAccount(KEYS[i]);
  const transport = http();
  return {
    network: {
      caip2: "eip155:31337",
      chain,
      usdc: "0x0000000000000000000000000000000000000000",
      explorer: "",
    },
    account,
    publicClient: createPublicClient({ chain, transport, pollingInterval: 50 }) as PublicClient,
    walletClient: createWalletClient({ chain, transport, account }),
  };
}

describe.skipIf(!hasAnvil)("ReceptumEscrow on anvil", { timeout: 30_000 }, () => {
  let anvil: ChildProcess;
  let contract: Address;
  let token: Address;
  const buyer = clients(0);
  const seller = clients(1);

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await buyer.publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    contract = await deployEscrow(buyer);
    const mock = JSON.parse(
      readFileSync(
        new URL("../contracts/out/ReceptumEscrow.t.sol/MockUSDC.json", import.meta.url),
        "utf8",
      ),
    );
    const hash = await buyer.walletClient.deployContract({
      abi: mock.abi,
      bytecode: mock.bytecode.object,
      account: buyer.account,
      chain,
    });
    token = (await buyer.publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    const mint = await buyer.walletClient.writeContract({
      address: token,
      abi: mock.abi,
      functionName: "mint",
      args: [buyer.account.address, 10_000_000n],
      account: buyer.account,
      chain,
    });
    await buyer.publicClient.waitForTransactionReceipt({ hash: mint });
  }, 30_000);

  afterAll(() => anvil?.kill());

  const receipt = () =>
    receiptHash(
      createReceipt({
        jobId: "render-1",
        seller: { id: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" },
        inputSha256: [sha256Hex("in")],
        outputSha256: sha256Hex("out"),
        payment: {
          rail: "escrow:receptum-evm",
          network: "eip155:31337",
          asset: "USDC",
          amount: "2500000",
          reference: "pending",
        },
      }),
    );

  it("opens, delivers, accepts and pays the seller in full", async () => {
    const b = new EvmEscrowRail(buyer);
    const s = new EvmEscrowRail(seller);
    const { escrowId } = await b.open({
      contract,
      token,
      seller: seller.account.address,
      amount: 2_500_000n,
      deliverBy: new Date(Date.now() + 3_600_000),
      reviewWindowSeconds: 86_400,
    });
    expect((await b.getEscrow(escrowId)).status).toBe("open");
    const rh = receipt();
    await s.deliver(escrowId, rh);
    const delivered = await b.getEscrow(escrowId);
    expect(delivered).toMatchObject({ status: "delivered", receiptHash: rh });
    await b.accept(escrowId);
    expect((await b.getEscrow(escrowId)).status).toBe("released");
  });

  it("refunds the buyer when nothing is delivered by the deadline", async () => {
    const b = new EvmEscrowRail(buyer);
    const block = await buyer.publicClient.getBlock();
    const { escrowId } = await b.open({
      contract,
      token,
      seller: seller.account.address,
      amount: 1_000_000n,
      deliverBy: new Date((Number(block.timestamp) + 60) * 1000),
      reviewWindowSeconds: 60,
    });
    await expect(b.refund(escrowId)).rejects.toThrow();
    await buyer.publicClient.request({
      method: "evm_increaseTime" as never,
      params: [120] as never,
    });
    await buyer.publicClient.request({ method: "evm_mine" as never, params: [] as never });
    await b.refund(escrowId);
    expect((await b.getEscrow(escrowId)).status).toBe("refunded");
  });

  it("refuses an escrowId from another network", async () => {
    await expect(new EvmEscrowRail(buyer).getEscrow(`eip155:84532:${contract}:1`)).rejects.toThrow(
      /rail is on/,
    );
  });
});
