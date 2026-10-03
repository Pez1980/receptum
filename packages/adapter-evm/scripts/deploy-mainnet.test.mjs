// Refusal and confirmation rules of deploy-mainnet.mjs, with mocked clients: nothing is signed or
// sent, and no real network is contacted.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { confirmationPhrase, KEY_ENV, Refusal, run } from "./deploy-mainnet.mjs";

// A synthetic, well-formed key: the account and every RPC are mocks.
const KEY = `0x${"11".repeat(32)}`;
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const AUDIT = "https://audits.example/receptum-escrow.pdf";
const okEnv = { RECEPTUM_ALLOW_MAINNET: "1", [KEY_ENV]: KEY };

function deps(over = {}) {
  const publicClient = {
    getChainId: vi.fn(async () => 8453),
    getBalance: vi.fn(async () => 10n ** 18n),
    estimateGas: vi.fn(async () => 1_500_000n),
    getGasPrice: vi.fn(async () => 1_000_000n),
  };
  const deployEscrow = vi.fn(async () => "0x2222222222222222222222222222222222222222");
  const clientsFor = vi.fn((network, account, opts) => ({
    network: {
      caip2: network,
      explorer: "https://basescan.org",
      chain: { rpcUrls: { default: { http: ["https://mainnet.base.org"] } } },
    },
    account,
    publicClient,
    opts,
  }));
  return {
    publicClient,
    deployEscrow,
    clientsFor,
    d: {
      accountFromKey: () => ({ address: ADDRESS }),
      clientsFor,
      deployEscrow,
      bytecode: "0x6000",
      deployedBytecode: "0x6000",
      keccak256: () => "0xcodehash",
      formatEther: (v) => String(v),
      isTTY: true,
      ask: vi.fn(async () => confirmationPhrase("eip155:8453")),
      writeFile: vi.fn(),
      ...over,
    },
  };
}

const call = (argv, env, d) => run({ argv, env, log: () => {}, deps: d });

describe("deploy-mainnet.mjs refusals (before any signature)", () => {
  it("refuses without RECEPTUM_ALLOW_MAINNET=1", async () => {
    const m = deps();
    for (const env of [{}, { RECEPTUM_ALLOW_MAINNET: "true" }, { [KEY_ENV]: KEY }])
      await expect(call(["eip155:8453", "--audit-report", AUDIT], env, m.d)).rejects.toThrow(
        /RECEPTUM_ALLOW_MAINNET=1/,
      );
    expect(m.clientsFor).not.toHaveBeenCalled();
    expect(m.deployEscrow).not.toHaveBeenCalled();
  });

  it("refuses testnets and unknown networks", async () => {
    const m = deps();
    for (const n of ["eip155:84532", "eip155:5042002", "eip155:1"])
      await expect(call([n, "--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(Refusal);
  });

  it("refuses without an audit report", async () => {
    const m = deps();
    await expect(call(["eip155:8453"], okEnv, m.d)).rejects.toThrow(/independent audit/);
    await expect(call(["eip155:8453", "--audit-report", "http://x"], okEnv, m.d)).rejects.toThrow(
      /audit/,
    );
  });

  it("takes the key only from the environment", async () => {
    const m = deps();
    await expect(
      call(["eip155:8453", "--audit-report", AUDIT], { RECEPTUM_ALLOW_MAINNET: "1" }, m.d),
    ).rejects.toThrow(new RegExp(KEY_ENV));
    await expect(
      call(["eip155:8453", "--audit-report", AUDIT, "--key-file", "x"], okEnv, m.d),
    ).rejects.toThrow(/unknown option --key-file/);
  });

  it("never reads wallet files", () => {
    const src = readFileSync(new URL("./deploy-mainnet.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/readFileSync|readFile\(|homedir|RECEPTUM_WALLETS_DIR\s*\?\?/);
    expect(src).not.toMatch(/evm-testnet\.json/);
  });

  it("refuses when the RPC serves another chain", async () => {
    const m = deps();
    m.publicClient.getChainId.mockResolvedValue(84532);
    await expect(call(["eip155:8453", "--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(
      /serves chain 84532/,
    );
    expect(m.deployEscrow).not.toHaveBeenCalled();
  });

  it("refuses when the deployer can't pay the estimated gas", async () => {
    const m = deps();
    m.publicClient.getBalance.mockResolvedValue(1n);
    await expect(call(["eip155:8453", "--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(
      /fund the fresh key/,
    );
    expect(m.deployEscrow).not.toHaveBeenCalled();
  });

  it("requires an interactive terminal and the exact phrase", async () => {
    const noTty = deps({ isTTY: false });
    await expect(call(["eip155:8453", "--audit-report", AUDIT], okEnv, noTty.d)).rejects.toThrow(
      /interactive terminal/,
    );
    const wrong = deps({ ask: async () => "yes" });
    await expect(call(["eip155:8453", "--audit-report", AUDIT], okEnv, wrong.d)).rejects.toThrow(
      /did not match/,
    );
    expect(noTty.deployEscrow).not.toHaveBeenCalled();
    expect(wrong.deployEscrow).not.toHaveBeenCalled();
  });
});

describe("deploy-mainnet.mjs plan and confirmed deploy (mocked)", () => {
  it("dry run prints the plan and signs nothing", async () => {
    const m = deps();
    const lines = [];
    const r = await run({
      argv: ["eip155:8453", "--audit-report", AUDIT, "--dry-run"],
      env: okEnv,
      log: (l) => lines.push(l),
      deps: m.d,
    });
    expect(r.deployed).toBe(false);
    expect(r.plan).toMatchObject({
      network: "eip155:8453",
      chainId: 8453,
      deployer: ADDRESS,
      estimatedGas: "1500000",
      auditReport: AUDIT,
    });
    expect(lines.join("\n")).toMatch(/MAINNET deployment plan[\s\S]*deployer[\s\S]*estimatedGas/);
    expect(m.clientsFor.mock.calls[0][2]).toEqual({ allowMainnet: true });
    expect(m.deployEscrow).not.toHaveBeenCalled();
  });

  it("deploys on the mock only after the exact confirmation", async () => {
    const m = deps();
    const r = await call(["eip155:8453", "--audit-report", AUDIT], okEnv, m.d);
    expect(r).toMatchObject({
      deployed: true,
      address: "0x2222222222222222222222222222222222222222",
    });
    expect(m.d.ask).toHaveBeenCalledOnce();
    expect(m.deployEscrow).toHaveBeenCalledOnce();
    expect(m.d.writeFile).toHaveBeenCalledWith(
      "deployment.eip155-8453.json",
      expect.stringContaining('"contract": "0x2222'),
    );
  });
});
