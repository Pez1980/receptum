// Refusal and confirmation rules of deploy-soroban-mainnet.mjs with a mocked RPC: nothing is
// signed against, or sent to, a real network.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "@stellar/stellar-sdk";
import { Refusal, SECRET_ENV, confirmationPhrase, run } from "./deploy-soroban-mainnet.mjs";

const lib = await import("../dist/index.js");
const wasm = readFileSync(
  new URL("../contracts/receptum-escrow/receptum_escrow.wasm", import.meta.url),
);
const deployer = sdk.Keypair.random();
const contractId = sdk.StrKey.encodeContract(Buffer.alloc(32, 9));
const AUDIT = "https://audits.example/receptum-soroban.pdf";
const okEnv = { RECEPTUM_ALLOW_MAINNET: "1", [SECRET_ENV]: deployer.secret() };

function deps(over = {}, passphrase = sdk.Networks.PUBLIC) {
  const client = new lib.SorobanRpcClient({ network: "pubnet", allowMainnet: true });
  Object.assign(client.server, {
    getNetwork: vi.fn(async () => ({ passphrase })),
    getAccount: vi.fn(async (id) => new sdk.Account(id, "1")),
    prepareTransaction: vi.fn(async (tx) => tx), // fee stays BASE_FEE (100 stroops)
  });
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({
      hash: "aa".repeat(32),
      ledger: 1,
      returnValue: sdk.xdr.ScVal.scvBytes(Buffer.from(lib.RECEPTUM_SOROBAN_WASM_HASH, "hex")),
    })
    .mockResolvedValueOnce({
      hash: "bb".repeat(32),
      ledger: 2,
      returnValue: new sdk.Address(contractId).toScVal(),
    });
  client.invoke = invoke;
  client.contractWasmHash = vi.fn(async () => lib.RECEPTUM_SOROBAN_WASM_HASH);
  const makeRpc = vi.fn(() => client);
  return {
    client,
    invoke,
    makeRpc,
    d: {
      sdk,
      lib,
      readWasm: vi.fn(async () => wasm),
      makeRpc,
      nativeBalance: async () => 1_000_000_000n,
      isTTY: true,
      ask: vi.fn(async () => confirmationPhrase()),
      writeFile: vi.fn(),
      ...over,
    },
  };
}

const call = (argv, env, d) => run({ argv, env, log: () => {}, deps: d });

describe("deploy-soroban-mainnet.mjs refusals (before any signature)", () => {
  it("refuses without RECEPTUM_ALLOW_MAINNET=1", async () => {
    const m = deps();
    for (const env of [{}, { [SECRET_ENV]: deployer.secret() }, { RECEPTUM_ALLOW_MAINNET: "yes" }])
      await expect(call(["--audit-report", AUDIT], env, m.d)).rejects.toThrow(
        /RECEPTUM_ALLOW_MAINNET=1/,
      );
    expect(m.makeRpc).not.toHaveBeenCalled();
  });

  it("refuses without an audit report", async () => {
    const m = deps();
    await expect(call([], okEnv, m.d)).rejects.toThrow(/independent audit/);
  });

  it("takes the secret only from the environment", async () => {
    const m = deps();
    await expect(
      call(["--audit-report", AUDIT], { RECEPTUM_ALLOW_MAINNET: "1" }, m.d),
    ).rejects.toThrow(new RegExp(SECRET_ENV));
    await expect(
      call(["--audit-report", AUDIT], { ...okEnv, [SECRET_ENV]: deployer.publicKey() }, m.d),
    ).rejects.toThrow(Refusal);
    await expect(call(["--audit-report", AUDIT, "--wallet", "x"], okEnv, m.d)).rejects.toThrow(
      /unexpected argument --wallet/,
    );
    // The wasm path is fixed (no path argument to alias into a wallet directory).
    await expect(call(["--audit-report", AUDIT, "--wasm", "/x.wasm"], okEnv, m.d)).rejects.toThrow(
      /unexpected argument --wasm/,
    );
  });

  it("never reads wallet files", () => {
    const src = readFileSync(new URL("./deploy-soroban-mainnet.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(
      /readFileSync|homedir|stellar-testnet\.json"|loadWallets|testnet-common/,
    );
  });

  it("refuses a wasm that isn't the reproducible build", async () => {
    const m = deps({ readWasm: async () => Buffer.from("not the contract") });
    await expect(call(["--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(
      /RECEPTUM_SOROBAN_WASM_HASH/,
    );
  });

  it("refuses an RPC on another network", async () => {
    const m = deps({}, sdk.Networks.TESTNET);
    await expect(call(["--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(
      /configured for stellar:pubnet/,
    );
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("refuses an unfunded deployer, a missing TTY or a wrong phrase", async () => {
    const poor = deps({ nativeBalance: async () => 0n });
    await expect(call(["--audit-report", AUDIT], okEnv, poor.d)).rejects.toThrow(/fund the fresh/);
    const noTty = deps({ isTTY: false });
    await expect(call(["--audit-report", AUDIT], okEnv, noTty.d)).rejects.toThrow(/interactive/);
    const wrong = deps({ ask: async () => "y" });
    await expect(call(["--audit-report", AUDIT], okEnv, wrong.d)).rejects.toThrow(/did not match/);
    for (const m of [poor, noTty, wrong]) expect(m.invoke).not.toHaveBeenCalled();
  });
});

describe("deploy-soroban-mainnet.mjs plan and confirmed deploy (mocked)", () => {
  it("dry run prints the plan and signs nothing", async () => {
    const m = deps();
    const lines = [];
    const r = await run({
      argv: ["--audit-report", AUDIT, "--dry-run"],
      env: okEnv,
      log: (l) => lines.push(l),
      deps: m.d,
    });
    expect(r.plan).toMatchObject({
      network: "stellar:pubnet",
      passphrase: sdk.Networks.PUBLIC,
      deployer: deployer.publicKey(),
      wasmHash: lib.RECEPTUM_SOROBAN_WASM_HASH,
      uploadFee: "0.0000100 XLM",
      deployerBalance: "100.0000000 XLM",
    });
    expect(lines.join("\n")).toMatch(/MAINNET deployment plan/);
    expect(m.makeRpc).toHaveBeenCalledWith({ network: "pubnet", allowMainnet: true });
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("uploads and creates on the mock only after the exact confirmation", async () => {
    const m = deps();
    const r = await call(["--audit-report", AUDIT], okEnv, m.d);
    expect(r).toMatchObject({ deployed: true, contractId });
    expect(m.invoke).toHaveBeenCalledTimes(2);
    // The upload carries exactly the validated bytes, read once.
    expect(m.d.readWasm).toHaveBeenCalledOnce();
    const uploaded = m.invoke.mock.calls[0][1].body.invokeHostFunctionOp.hostFunction.wasm;
    expect(Buffer.compare(Buffer.from(uploaded), wasm)).toBe(0);
    expect(m.d.writeFile).toHaveBeenCalledWith(
      "deployment.pubnet.json",
      expect.stringContaining(`"contractId": "${contractId}"`),
    );
  });

  it("verifies the uploaded wasm hash before creating the contract", async () => {
    for (const returnValue of [
      sdk.xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
      undefined,
      sdk.xdr.ScVal.scvU32(1),
    ]) {
      const m = deps();
      m.invoke.mockReset();
      m.invoke.mockResolvedValueOnce({
        hash: "aa".repeat(32),
        ledger: 1,
        ...(returnValue ? { returnValue } : {}),
      });
      await expect(call(["--audit-report", AUDIT], okEnv, m.d)).rejects.toThrow(
        /uploaded wasm .*not RECEPTUM_SOROBAN_WASM_HASH.*no contract created/,
      );
      expect(m.invoke).toHaveBeenCalledOnce();
      expect(m.d.writeFile).not.toHaveBeenCalled();
    }
  });
});
