// Pubnet (mainnet) opt-in. Every server below is a mock: nothing reaches a real Stellar network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import { MainnetNotAllowedError, sha256Hex } from "@receptum/core";
import { StellarAnchor } from "./anchor.js";
import { StellarClaimableEscrowRail } from "./escrow.js";
import { HorizonClient } from "./horizon.js";
import {
  PUBNET_USDC,
  PUBNET_USDC_ISSUER,
  STELLAR_PUBNET,
  STELLAR_TESTNET,
  caip10,
  explorerTxUrl,
  stellarNetwork,
} from "./network.js";
import { keypairSigner } from "./signer.js";
import {
  PUBNET_USDC_SAC,
  SorobanEscrowRail,
  SorobanRpcClient,
  formatSorobanEscrowId,
  parseSorobanEscrowId,
  tokenContractId,
} from "./soroban.js";

const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
const kp = Keypair.random();
const seller = Keypair.random().publicKey();
const HASH = "ab".repeat(32);

afterEach(() => vi.unstubAllEnvs());

function signerSpy() {
  const passphrases: string[] = [];
  const signer = keypairSigner(kp);
  return {
    passphrases,
    signer: {
      publicKey: signer.publicKey,
      sign: vi.fn(async (tx: Transaction) => {
        passphrases.push(tx.networkPassphrase);
        await signer.sign(tx);
      }),
    },
  };
}

/** Stubs the Horizon calls `HorizonClient.submit` makes. */
function stubHorizon(h: HorizonClient, passphrase = h.network.networkPassphrase) {
  const root = vi.fn(async () => ({ network_passphrase: passphrase }));
  const loadAccount = vi.fn(async (id: string) => new Account(id, "1"));
  const submitTransaction = vi.fn(async (tx: Transaction) => ({
    hash: Buffer.from(tx.hash()).toString("hex"),
  }));
  Object.assign(h.server, { root, loadAccount, submitTransaction });
  return { root, loadAccount, submitTransaction };
}

/** Stubs the Soroban RPC calls `SorobanRpcClient.invoke` makes. */
function stubRpc(c: SorobanRpcClient, passphrase: string) {
  const s = {
    getNetwork: vi.fn(async () => ({ passphrase })),
    getAccount: vi.fn(async (id: string) => new Account(id, "1")),
    prepareTransaction: vi.fn(async (tx: Transaction) => tx),
    sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "aa".repeat(32) })),
    pollTransaction: vi.fn(async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 7,
    })),
  };
  Object.assign(c.server, s);
  return s;
}

describe("pubnet definition", () => {
  it("uses the public passphrase, Horizon and Circle's USDC issuer", () => {
    expect(STELLAR_PUBNET).toMatchObject({
      caip2: "stellar:pubnet",
      networkPassphrase: Networks.PUBLIC,
      horizonUrl: "https://horizon.stellar.org",
      mainnet: true,
    });
    expect(STELLAR_PUBNET.sorobanRpcUrl).toMatch(/^https:\/\//);
    expect(PUBNET_USDC_ISSUER).toBe("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    expect(PUBNET_USDC_SAC).toBe(new Asset("USDC", PUBNET_USDC_ISSUER).contractId(Networks.PUBLIC));
    expect(PUBNET_USDC_SAC).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
    expect(tokenContractId(PUBNET_USDC, "pubnet")).toBe(PUBNET_USDC_SAC);
    expect(tokenContractId(PUBNET_USDC)).not.toBe(PUBNET_USDC_SAC); // testnet by default
    expect(STELLAR_TESTNET.mainnet).toBe(false);
  });

  it("resolves names and builds pubnet ids and links", () => {
    expect(stellarNetwork()).toBe(STELLAR_TESTNET);
    expect(stellarNetwork("pubnet")).toBe(STELLAR_PUBNET);
    expect(stellarNetwork("stellar:pubnet")).toBe(STELLAR_PUBNET);
    expect(() => stellarNetwork("futurenet")).toThrow(TypeError);
    expect(caip10(seller, "pubnet")).toBe(`stellar:pubnet:${seller}`);
    expect(caip10(seller)).toBe(`stellar:testnet:${seller}`);
    expect(explorerTxUrl("ab", "pubnet")).toBe("https://stellar.expert/explorer/public/tx/ab");
    const id = formatSorobanEscrowId(contractId, 7n, "pubnet");
    expect(id).toBe(`stellar:pubnet:${contractId}:7`);
    expect(parseSorobanEscrowId(id)).toEqual({ contractId, id: 7n, network: "stellar:pubnet" });
    expect(() => parseSorobanEscrowId(`stellar:futurenet:${contractId}:7`)).toThrow();
  });

  it("refuses endpoints of the other network", () => {
    expect(() => new HorizonClient({ horizonUrl: "https://horizon.stellar.org" })).toThrow(
      /configured for testnet/,
    );
    expect(
      () =>
        new HorizonClient({ network: "pubnet", horizonUrl: "https://horizon-testnet.stellar.org" }),
    ).toThrow(/configured for pubnet/);
    expect(
      () =>
        new SorobanRpcClient({ network: "pubnet", rpcUrl: "https://soroban-testnet.stellar.org" }),
    ).toThrow(/configured for pubnet/);
  });
});

describe("claimable-balance rail on pubnet", () => {
  const open = (rail: StellarClaimableEscrowRail) =>
    rail.open({
      seller,
      amount: "10000000",
      deadline: new Date(Date.now() + 3_600_000),
      reviewWindowSeconds: 600,
    });

  it("refuses to sign without the opt-in (nothing is loaded or signed)", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const rail = new StellarClaimableEscrowRail({ network: "pubnet", signer });
    expect(rail.network).toBe("stellar:pubnet");
    const h = stubHorizon((rail as unknown as { horizon: HorizonClient }).horizon);
    await expect(open(rail)).rejects.toThrow(MainnetNotAllowedError);
    const anchor = new StellarAnchor({ network: "pubnet", signer });
    await expect(anchor.anchor(HASH)).rejects.toThrow(MainnetNotAllowedError);
    expect(h.loadAccount).not.toHaveBeenCalled();
    expect(passphrases).toEqual([]);
  });

  it("signs with the public passphrase and mainnet USDC once opted in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const rail = new StellarClaimableEscrowRail({ network: "pubnet", allowMainnet: true, signer });
    const h = stubHorizon((rail as unknown as { horizon: HorizonClient }).horizon);
    const opened = await open(rail);
    expect(opened).toMatchObject({ network: "stellar:pubnet", asset: PUBNET_USDC });
    expect(passphrases).toEqual([Networks.PUBLIC]);
    expect(h.submitTransaction).toHaveBeenCalledOnce();
  });

  it("honours RECEPTUM_ALLOW_MAINNET=1, and an explicit false still refuses", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    const { signer } = signerSpy();
    const ok = new HorizonClient({ network: "pubnet" });
    stubHorizon(ok);
    await expect(
      ok.submit(signer, [Operation.bumpSequence({ bumpTo: "0" })]),
    ).resolves.toMatchObject({ hash: expect.any(String) });
    const no = new HorizonClient({ network: "pubnet", allowMainnet: false });
    stubHorizon(no);
    await expect(no.submit(signer, [Operation.bumpSequence({ bumpTo: "0" })])).rejects.toThrow(
      MainnetNotAllowedError,
    );
  });

  it("testnet stays the default and needs no opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const h = new HorizonClient();
    stubHorizon(h);
    await h.submit(signer, [Operation.bumpSequence({ bumpTo: "0" })]);
    expect(passphrases).toEqual([Networks.TESTNET]);
  });
});

describe("Soroban rail on pubnet", () => {
  const escrowId = `stellar:pubnet:${contractId}:1`;

  it("refuses to sign without the opt-in, before contacting the RPC", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const rail = new SorobanEscrowRail({ contractId, signer, network: "pubnet" });
    const s = stubRpc(rail.rpc, Networks.PUBLIC);
    await expect(rail.deliver(escrowId, sha256Hex("r"))).rejects.toThrow(MainnetNotAllowedError);
    await expect(rail.release(escrowId)).rejects.toThrow(MainnetNotAllowedError);
    expect(s.getNetwork).not.toHaveBeenCalled();
    expect(s.sendTransaction).not.toHaveBeenCalled();
    expect(passphrases).toEqual([]);
  });

  it("signs with the public passphrase once opted in (mock RPC)", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const rail = new SorobanEscrowRail({
      contractId,
      signer,
      network: "pubnet",
      allowMainnet: true,
    });
    expect(rail.network).toBe("stellar:pubnet");
    const s = stubRpc(rail.rpc, Networks.PUBLIC);
    await expect(rail.release(escrowId)).resolves.toEqual({ reference: "aa".repeat(32) });
    expect(passphrases).toEqual([Networks.PUBLIC]);
    expect(s.sendTransaction).toHaveBeenCalledOnce();
  });

  it("refuses an RPC that serves another network, even when opted in", async () => {
    const { signer } = signerSpy();
    const rail = new SorobanEscrowRail({
      contractId,
      signer,
      network: "pubnet",
      allowMainnet: true,
    });
    const s = stubRpc(rail.rpc, Networks.TESTNET);
    await expect(rail.release(escrowId)).rejects.toThrow(/configured for stellar:pubnet/);
    expect(s.sendTransaction).not.toHaveBeenCalled();
  });

  it("asks the RPC for its passphrase again before every signature (review round 4)", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const rail = new SorobanEscrowRail({ contractId, signer, rpcUrl: "https://rpc-proxy.example" });
    const s = stubRpc(rail.rpc, Networks.TESTNET);
    const id = `stellar:testnet:${contractId}:1`;
    await rail.release(id);
    s.getNetwork.mockResolvedValue({ passphrase: Networks.PUBLIC });
    await expect(rail.release(id)).rejects.toThrow(/configured for stellar:testnet/);
    expect(s.sendTransaction).toHaveBeenCalledOnce();
    expect(passphrases).toEqual([Networks.TESTNET]);
  });

  it("keeps rails and escrow ids on their own network", async () => {
    const testnetRail = new SorobanEscrowRail({ contractId });
    await expect(testnetRail.getEscrow(escrowId)).rejects.toThrow(/is on stellar:pubnet/);
    const pubnetRail = new SorobanEscrowRail({ contractId, network: "pubnet" });
    await expect(pubnetRail.getEscrow(`stellar:testnet:${contractId}:1`)).rejects.toThrow(
      /is on stellar:testnet/,
    );
  });
});

describe("Horizon: the server's passphrase is verified before every signature (review round 4)", () => {
  const bump = [Operation.bumpSequence({ bumpTo: "0" })];

  it("a testnet client on a custom horizonUrl that serves pubnet signs nothing", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1"); // even with the env opt-in
    for (const allowMainnet of [undefined, false, true]) {
      const { signer, passphrases } = signerSpy();
      const h = new HorizonClient({ horizonUrl: "https://horizon-proxy.example", allowMainnet });
      const s = stubHorizon(h, Networks.PUBLIC);
      await expect(h.submit(signer, bump)).rejects.toThrow(
        /Horizon serves "Public Global Stellar Network ; September 2015", not stellar:testnet/,
      );
      expect(s.loadAccount).not.toHaveBeenCalled();
      expect(passphrases).toEqual([]);
    }
  });

  it("a pubnet client still needs the opt-in before Horizon is even asked", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer } = signerSpy();
    const h = new HorizonClient({ network: "pubnet", horizonUrl: "https://horizon-proxy.example" });
    const s = stubHorizon(h);
    await expect(h.submit(signer, bump)).rejects.toThrow(MainnetNotAllowedError);
    expect(s.root).not.toHaveBeenCalled();
  });

  it("asks again before each signature", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const h = new HorizonClient({ horizonUrl: "https://horizon-proxy.example" });
    const s = stubHorizon(h);
    await h.submit(signer, bump);
    s.root.mockResolvedValue({ network_passphrase: Networks.PUBLIC });
    await expect(h.submit(signer, bump)).rejects.toThrow(/not stellar:testnet/);
    expect(s.root).toHaveBeenCalledTimes(2);
    expect(passphrases).toEqual([Networks.TESTNET]);
  });

  it("the claimable-balance rail and the anchor go through the same check", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const { signer, passphrases } = signerSpy();
    const opts = { signer, horizonUrl: "https://horizon-proxy.example" };
    const rail = new StellarClaimableEscrowRail(opts);
    stubHorizon((rail as unknown as { horizon: HorizonClient }).horizon, Networks.PUBLIC);
    await expect(
      rail.open({
        seller,
        amount: "10000000",
        deadline: new Date(Date.now() + 3_600_000),
        reviewWindowSeconds: 600,
      }),
    ).rejects.toThrow(/not stellar:testnet/);
    const anchor = new StellarAnchor(opts);
    stubHorizon((anchor as unknown as { horizon: HorizonClient }).horizon, Networks.PUBLIC);
    await expect(anchor.anchor(HASH)).rejects.toThrow(/not stellar:testnet/);
    expect(passphrases).toEqual([]);
  });
});
