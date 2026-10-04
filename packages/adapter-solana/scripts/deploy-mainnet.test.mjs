// Refusal, confirmation and post-deploy checks of deploy-mainnet.mjs with a mocked RPC and a mocked
// solana CLI: nothing is signed against, or sent to, a real network, and no keypair file is read.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  confirmationPhrase,
  KEYPAIR_ENV,
  MAINNET_GENESIS,
  makeCli,
  NETWORK,
  Refusal,
  run,
} from "./deploy-mainnet.mjs";

const lib = await import("../dist/index.js");
const so = readFileSync(new URL("../program/receptum_escrow.so", import.meta.url));
const devnetRecord = readFileSync(new URL("../program/deployment.devnet.json", import.meta.url));
const addr = (n) => lib.encodeBase58(Buffer.alloc(32, n));
const DEPLOYER = addr(1);
const PROGRAM_ID = addr(2);
const BUFFER = addr(3);
const PROGRAM_DATA = addr(4);
const SIGNATURE = lib.encodeBase58(Buffer.alloc(64, 5));
const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const KEY = "/secure/mainnet/fresh-deployer.json";
const AUDIT = "https://audits.example/receptum-solana.pdf";
const okEnv = {
  RECEPTUM_ALLOW_MAINNET: "1",
  [KEYPAIR_ENV]: KEY,
  HOME: "/home/op",
  RECEPTUM_WALLETS_DIR: "/wallets",
};

function programDataBytes({ authority = null, elf = so } = {}) {
  const h = Buffer.alloc(45);
  h.writeUInt32LE(3, 0);
  h.writeBigUInt64LE(400_000_000n, 4);
  if (authority) {
    h[12] = 1;
    Buffer.from(lib.decodeBase58(authority)).copy(h, 13);
  }
  return Buffer.concat([h, elf, Buffer.alloc(64)]);
}

function deps(over = {}, { genesis = MAINNET_GENESIS, cliGenesis = MAINNET_GENESIS } = {}) {
  const state = { deployed: false, balance: 10n * 1_000_000_000n, programData: programDataBytes() };
  const account = (data, executable) => ({
    value: {
      owner: lib.BPF_LOADER_UPGRADEABLE_ID,
      lamports: 1,
      executable,
      data: [Buffer.from(data).toString("base64"), "base64"],
    },
  });
  const rpc = vi.fn(async (method, params) => {
    switch (method) {
      case "getGenesisHash":
        return genesis;
      case "getBalance":
        return { value: Number(state.balance) };
      case "getMinimumBalanceForRentExemption":
        return (params[0] + 128) * 6960;
      case "getAccountInfo": {
        if (!state.deployed) return { value: null };
        if (params[0] === PROGRAM_ID) {
          const p = Buffer.alloc(36);
          p.writeUInt32LE(2, 0);
          Buffer.from(lib.decodeBase58(PROGRAM_DATA)).copy(p, 4);
          return account(p, true);
        }
        if (params[0] === PROGRAM_DATA) return account(state.programData, false);
        return { value: null };
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  });
  const cli = vi.fn((args) => {
    if (args[0] === "genesis-hash") return `${cliGenesis}\n`;
    if (args[0] === "address") return `${DEPLOYER}\n`;
    if (args[0] === "--version") return "solana-cli 4.3.0 (src:00000000; feat:1, client:Agave)\n";
    if (args[0] === "program" && args[1] === "write-buffer")
      return `Save this seed phrase to recover the buffer: ${SEED}\n`;
    if (args[0] === "program" && args[1] === "deploy") {
      state.deployed = true;
      return JSON.stringify({ programId: PROGRAM_ID, signature: SIGNATURE });
    }
    throw new Error(`unexpected CLI ${args.join(" ")}`);
  });
  const programCalls = () => cli.mock.calls.filter(([a]) => a[0] === "program");
  return {
    state,
    rpc,
    cli,
    programCalls,
    d: {
      lib,
      readFile: async (u) => (String(u).endsWith(".so") ? so : devnetRecord),
      makeRpc: vi.fn(() => rpc),
      cli,
      keyFileExists: (p) => p === KEY,
      realpath: (p) => p,
      makeTempKeypairs: vi.fn(() => ({
        dir: "/tmp/receptum-solana-mainnet-x",
        program: { path: "/tmp/receptum-solana-mainnet-x/program.json", address: PROGRAM_ID },
        buffer: { path: "/tmp/receptum-solana-mainnet-x/buffer.json", address: BUFFER },
      })),
      removeDir: vi.fn(),
      isTTY: true,
      ask: vi.fn(async () => confirmationPhrase()),
      writeFile: vi.fn(),
      ...over,
    },
  };
}

const call = (argv, env, d) => run({ argv, env, log: () => {}, deps: d });
const ARGS = ["--audit-report", AUDIT];

describe("deploy-mainnet.mjs (Solana) refusals (before any signature)", () => {
  it("refuses without RECEPTUM_ALLOW_MAINNET=1", async () => {
    const m = deps();
    for (const env of [{}, { [KEYPAIR_ENV]: KEY }, { ...okEnv, RECEPTUM_ALLOW_MAINNET: "true" }])
      await expect(call(ARGS, env, m.d)).rejects.toThrow(/RECEPTUM_ALLOW_MAINNET=1/);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.cli).not.toHaveBeenCalled();
  });

  it("refuses without an https audit report", async () => {
    const m = deps();
    await expect(call([], okEnv, m.d)).rejects.toThrow(/independent audit/);
    await expect(call(["--audit-report", "http://x"], okEnv, m.d)).rejects.toThrow(/audit/);
    await expect(call(["--audit-report"], okEnv, m.d)).rejects.toThrow(/needs a value/);
    expect(m.cli).not.toHaveBeenCalled();
  });

  it("takes the keypair path only from the environment", async () => {
    const m = deps();
    await expect(call(ARGS, { RECEPTUM_ALLOW_MAINNET: "1" }, m.d)).rejects.toThrow(
      new RegExp(KEYPAIR_ENV),
    );
    await expect(call(ARGS, { ...okEnv, [KEYPAIR_ENV]: "deployer.json" }, m.d)).rejects.toThrow(
      /absolute path/,
    );
    await expect(
      call(ARGS, { ...okEnv, [KEYPAIR_ENV]: "/secure/missing.json" }, m.d),
    ).rejects.toThrow(/names no file/);
    await expect(call([...ARGS, "--keypair", KEY], okEnv, m.d)).rejects.toThrow(
      /unexpected argument --keypair/,
    );
    expect(m.cli).not.toHaveBeenCalled();
  });

  it("refuses testnet wallets and the CLI's default wallet, also through a symlink", async () => {
    const any = deps({ keyFileExists: () => true });
    for (const path of [
      "/home/op/.config/receptum/wallets/solana-devnet-deployer.json",
      "/wallets/fresh.json",
      "/home/op/.config/solana/id.json",
      "/secure/solana-devnet-deployer.json",
      "/secure/testnet-key.json",
    ])
      await expect(call(ARGS, { ...okEnv, [KEYPAIR_ENV]: path }, any.d)).rejects.toThrow(
        /testnet wallet or the CLI's default wallet/,
      );
    const link = deps({
      realpath: (p) => (p === KEY ? "/home/op/.config/receptum/wallets/x.json" : p),
    });
    await expect(call(ARGS, okEnv, link.d)).rejects.toThrow(/testnet wallet/);
    for (const m of [any, link]) {
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.cli).not.toHaveBeenCalled();
    }
  });

  it("never reads wallet files", () => {
    const src = readFileSync(new URL("./deploy-mainnet.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(
      /readFileSync|homedir|loadKeypair|devnet-common|solana-devnet-|RECEPTUM_WALLETS_DIR\s*\?\?/,
    );
  });

  it("refuses an RPC (or a CLI view) that is not mainnet-beta, before using the key", async () => {
    const devnet = deps({}, { genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcWgmbVV2VeQ" });
    await expect(call(ARGS, okEnv, devnet.d)).rejects.toThrow(/not Solana mainnet-beta/);
    expect(devnet.cli).not.toHaveBeenCalled();
    const cliOff = deps({}, { cliGenesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcWgmbVV2VeQ" });
    await expect(call(ARGS, okEnv, cliOff.d)).rejects.toThrow(/CLI does not see/);
    for (const m of [devnet, cliOff])
      expect(m.cli.mock.calls.some(([a]) => a[0] === "address")).toBe(false);
  });

  it("refuses a .so that isn't the canonical CI build", async () => {
    const local = deps({
      readFile: async (u) =>
        String(u).endsWith(".so") ? Buffer.from("a macOS build") : devnetRecord,
    });
    await expect(call(ARGS, okEnv, local.d)).rejects.toThrow(/receptum_escrow-ci-build/);
    const padded = deps({
      readFile: async (u) =>
        String(u).endsWith(".so") ? Buffer.concat([so, Buffer.alloc(4096)]) : devnetRecord,
    });
    // Trailing zero bytes don't change the executable hash.
    await expect(call([...ARGS, "--dry-run"], okEnv, padded.d)).resolves.toMatchObject({
      deployed: false,
    });
    const drift = deps({
      readFile: async (u) =>
        String(u).endsWith(".so") ? so : JSON.stringify({ executableHash: "00".repeat(32) }),
    });
    await expect(call(ARGS, okEnv, drift.d)).rejects.toThrow(/disagree/);
    const wallet = deps();
    await expect(
      call([...ARGS, "--so", "/home/op/.config/receptum/wallets/x.so"], okEnv, wallet.d),
    ).rejects.toThrow(/wallet directory/);
    for (const m of [local, drift, wallet]) expect(m.programCalls()).toHaveLength(0);
  });

  it("refuses an underfunded deployer, a missing TTY or a wrong phrase", async () => {
    const poor = deps();
    poor.state.balance = 1_000_000n;
    await expect(call(ARGS, okEnv, poor.d)).rejects.toThrow(/fund the fresh key/);
    const noTty = deps({ isTTY: false });
    await expect(call(ARGS, okEnv, noTty.d)).rejects.toThrow(/interactive terminal/);
    const wrong = deps({ ask: async () => "yes" });
    await expect(call(ARGS, okEnv, wrong.d)).rejects.toThrow(/did not match/);
    for (const m of [poor, noTty, wrong]) {
      expect(m.programCalls()).toHaveLength(0);
      expect(m.d.makeTempKeypairs).not.toHaveBeenCalled();
    }
  });

  it("refuses when the fresh program id already exists", async () => {
    const m = deps();
    m.state.deployed = true;
    m.d.makeTempKeypairs.mockReturnValue({
      dir: "/tmp/x",
      program: { path: "/tmp/x/program.json", address: PROGRAM_ID },
      buffer: { path: "/tmp/x/buffer.json", address: BUFFER },
    });
    await expect(call(ARGS, okEnv, m.d)).rejects.toThrow(/exists/);
    expect(m.programCalls()).toHaveLength(0);
  });
});

describe("deploy-mainnet.mjs (Solana) CLI output is never shown", () => {
  it("a failing CLI call reports a fixed reason, not its output", () => {
    const cli = makeCli(() => {
      const err = new Error(`Command failed: solana … ${SEED}`);
      Object.assign(err, {
        status: 1,
        stderr: `Error: insufficient funds for spend\nRecover with: ${SEED}`,
        stdout: SEED,
      });
      throw err;
    });
    let thrown;
    try {
      cli(["program", "write-buffer"]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown.message).toMatch(/solana program write-buffer failed \(status 1\): insufficient/);
    expect(thrown.message).not.toContain("abandon");
    expect(thrown.cause).toBeUndefined();
    expect(JSON.stringify(thrown)).not.toContain("abandon");
  });
});

describe("deploy-mainnet.mjs (Solana) plan and confirmed deploy (mocked)", () => {
  it("dry run prints the plan and signs nothing", async () => {
    const m = deps();
    const lines = [];
    const r = await run({
      argv: [...ARGS, "--dry-run"],
      env: okEnv,
      log: (l) => lines.push(l),
      deps: m.d,
    });
    expect(r.deployed).toBe(false);
    expect(r.plan).toMatchObject({
      network: NETWORK,
      genesis: MAINNET_GENESIS,
      rpc: "https://api.mainnet-beta.solana.com",
      cli: "solana-cli 4.3.0",
      deployer: DEPLOYER,
      deployerBalance: "10.000000000 SOL",
      programSize: `${so.length} bytes`,
      executableHash: lib.RECEPTUM_SOLANA_PROGRAM_HASH,
      upgradeAuthority: "none (--final)",
      auditReport: AUDIT,
    });
    expect(r.plan.estimatedRent).toMatch(/SOL/);
    expect(r.plan.estimatedFees).toMatch(/SOL/);
    expect(lines.join("\n")).toMatch(/MAINNET deployment plan[\s\S]*deployer[\s\S]*required/);
    expect(lines.join("\n")).toMatch(/dry run: nothing signed/);
    expect(m.d.makeRpc).toHaveBeenCalledWith("https://api.mainnet-beta.solana.com");
    expect(m.programCalls()).toHaveLength(0);
    expect(m.d.makeTempKeypairs).not.toHaveBeenCalled();
    expect(m.d.ask).not.toHaveBeenCalled();
  });

  it("deploys --final only after the exact phrase and verifies the on-chain ProgramData", async () => {
    const m = deps();
    const lines = [];
    const r = await run({ argv: ARGS, env: okEnv, log: (l) => lines.push(l), deps: m.d });
    expect(r).toMatchObject({ deployed: true, programId: PROGRAM_ID, signature: SIGNATURE });
    expect(m.d.ask).toHaveBeenCalledOnce();
    const [write, deploy] = m.programCalls().map(([a]) => a);
    expect(write.slice(0, 2)).toEqual(["program", "write-buffer"]);
    expect(deploy.slice(0, 2)).toEqual(["program", "deploy"]);
    expect(deploy).toContain("--final");
    expect(deploy).not.toContain("--upgrade-authority");
    for (const a of [write, deploy]) {
      expect(a).toEqual(expect.arrayContaining(["--keypair", KEY]));
      expect(a).toEqual(expect.arrayContaining(["--url", "https://api.mainnet-beta.solana.com"]));
    }
    expect(lines.join("\n")).not.toContain("abandon");
    expect(m.d.writeFile).toHaveBeenCalledWith(
      "deployment.mainnet.json",
      expect.stringContaining(`"programId": "${PROGRAM_ID}"`),
    );
    const record = JSON.parse(m.d.writeFile.mock.calls[0][1]);
    expect(record).toMatchObject({
      network: NETWORK,
      executableHash: lib.RECEPTUM_SOLANA_PROGRAM_HASH,
      upgradeAuthority: null,
      deployTransaction: SIGNATURE,
      auditReport: AUDIT,
    });
    expect(m.d.removeDir).toHaveBeenCalledWith("/tmp/receptum-solana-mainnet-x");
  });

  it("fails (and publishes nothing) if the deployed program is upgradeable or runs other bytes", async () => {
    const upgradeable = deps();
    upgradeable.state.programData = programDataBytes({ authority: DEPLOYER });
    await expect(call(ARGS, okEnv, upgradeable.d)).rejects.toThrow(/still upgradeable/);
    const other = deps();
    other.state.programData = programDataBytes({ elf: Buffer.from("other program") });
    await expect(call(ARGS, okEnv, other.d)).rejects.toThrow(/deployed program runs/);
    for (const m of [upgradeable, other]) {
      expect(m.d.writeFile).not.toHaveBeenCalled();
      expect(m.d.removeDir).not.toHaveBeenCalled();
    }
  });

  it("keeps the temporary keypairs and withholds CLI output when the deploy fails", async () => {
    const m = deps();
    m.cli.mockImplementation((args) => {
      if (args[0] === "genesis-hash") return MAINNET_GENESIS;
      if (args[0] === "address") return DEPLOYER;
      if (args[0] === "--version") return "solana-cli 4.3.0";
      throw new Error("solana program write-buffer failed (status 1): insufficient funds");
    });
    await expect(call(ARGS, okEnv, m.d)).rejects.toThrow(
      /kept in \/tmp\/receptum-solana-mainnet-x/,
    );
    expect(m.programCalls()).toHaveLength(5); // write-buffer retried, never deployed
    expect(m.d.writeFile).not.toHaveBeenCalled();
  });
});

it("refusals are Refusal instances (exit status 2)", async () => {
  await expect(call(ARGS, {}, deps().d)).rejects.toBeInstanceOf(Refusal);
});
