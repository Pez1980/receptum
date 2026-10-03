// Level-3 rules aligned with the Python verifier (SPEC §7.1, §7.3, §7.5): a missing Soroban
// contract fails, a malformed claimable-balance reference or a non-Receptum balance fails, and
// every XRPL check refuses a server that serves another NetworkID. Every RPC is mocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceipt, generateSellerKey, sha256Hex, signReceipt } from "@receptum/core";
import {
  parseEscrowTerms,
  SorobanRpcClient,
  StellarClaimableEscrowRail,
  TESTNET_USDC_SAC,
} from "@receptum/adapter-stellar";
import { Client } from "xrpl";
import { TRUSTED_ESCROWS, verify } from "./index.js";

const seller = generateSellerKey();
const file = new TextEncoder().encode("delivered bytes");
const BUYER = "GAJGU63DDMPR6DU2LVMMFOV5DUSPTHG6PSGV7N3E72TXWMK74ZEOCNWI";
const SELLER = "GCKJSBZNHSKEPM7VEM6CQ6RGP2HNNMJOUIEXGYABRSRJVI73K6YDSRIT";
const BALANCE = `00000000${"ab".repeat(32)}`;

afterEach(() => vi.restoreAllMocks());

function sign(payment: Record<string, unknown>, acceptance?: Record<string, unknown>) {
  return signReceipt(
    createReceipt({
      jobId: "j",
      seller: { id: seller.did },
      inputSha256: [sha256Hex("source")],
      outputSha256: sha256Hex(file),
      payment: payment as never,
      ...(acceptance ? { acceptance: acceptance as never } : {}),
    }),
    seller,
  );
}

const settlement = async (signed: ReturnType<typeof sign>, anchors?: string[]) =>
  (
    await verify(signed, { file, allowUnbound: true, ...(anchors ? { anchors } : {}) })
  ).checks.filter((c) => c.level === 3);

describe("escrow:receptum-soroban: a missing contract fails (as missing EVM code)", () => {
  it("maps a contract with no instance entry to a contradiction", async () => {
    const contractId = TRUSTED_ESCROWS["stellar:testnet"]![0]!;
    vi.spyOn(SorobanRpcClient.prototype, "contractWasmHash").mockRejectedValue(
      new Error(`contract ${contractId} not found`),
    );
    const [pay] = await settlement(
      sign({
        rail: "escrow:receptum-soroban",
        network: "stellar:testnet",
        asset: TESTNET_USDC_SAC,
        amount: "1",
        reference: `stellar:testnet:${contractId}:1`,
        payee: `stellar:testnet:${SELLER}`,
      }),
    );
    expect(pay).toMatchObject({ status: "fail", detail: `contract ${contractId} not found` });
  });

  it("the adapter reports the missing instance by that message", async () => {
    const rpc = new SorobanRpcClient({ network: "stellar:testnet" });
    const server = (rpc as unknown as { server: Record<string, unknown> }).server;
    server.getNetwork = async () => ({ passphrase: "Test SDF Network ; September 2015" });
    server.getContractInstance = async () =>
      Promise.reject({ code: 404, message: "Could not obtain contract instance from server" });
    const id = TRUSTED_ESCROWS["stellar:testnet"]![0]!;
    await expect(rpc.contractWasmHash(id)).rejects.toThrow(`contract ${id} not found`);
  });
});

describe("escrow:stellar-claimable: references and balance shape (SPEC §7.5)", () => {
  const claimable = (reference: string) =>
    sign(
      {
        rail: "escrow:stellar-claimable",
        network: "stellar:testnet",
        asset: "native",
        amount: "1",
        reference,
        payer: `stellar:testnet:${BUYER}`,
        payee: `stellar:testnet:${SELLER}`,
      },
      { mode: "auto", reviewWindowSeconds: 60 },
    );

  it("a malformed reference fails before Horizon is asked", async () => {
    const read = vi.spyOn(StellarClaimableEscrowRail.prototype, "getEscrow");
    for (const ref of [
      "nope",
      ` ${BALANCE}`,
      `${BALANCE}\n`,
      `01000000${"00".repeat(32)}`,
      `B${"A".repeat(57)}`,
    ]) {
      const [pay] = await settlement(claimable(ref));
      expect(pay, ref).toMatchObject({
        status: "fail",
        detail: expect.stringMatching(/^invalid Stellar escrow id/),
      });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("a balance without the Receptum claimant shape fails", async () => {
    vi.spyOn(StellarClaimableEscrowRail.prototype, "getEscrow").mockRejectedValue(
      new TypeError("not a Receptum escrow: unexpected predicates"),
    );
    const [pay] = await settlement(claimable(BALANCE));
    expect(pay).toMatchObject({ status: "fail", detail: /not a Receptum escrow/ });
  });

  it("every shape error of parseEscrowTerms says so", () => {
    const ab = (t: number) => ({
      abs_before: new Date(t * 1000).toISOString(),
      abs_before_epoch: String(t),
    });
    const same = [
      { destination: SELLER, predicate: { not: ab(2000) } },
      { destination: SELLER, predicate: { and: [{ not: ab(1000) }, ab(2000)] } },
    ];
    expect(() => parseEscrowTerms(same)).toThrow(
      /^not a Receptum escrow: buyer and seller must differ/,
    );
    expect(() => parseEscrowTerms([same[0]!])).toThrow(/^not a Receptum escrow/);
  });
});

describe("XRPL: the server must serve payment.network", () => {
  const stubServer = (networkId: number) => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "disconnect").mockResolvedValue(undefined);
    const commands: string[] = [];
    vi.spyOn(Client.prototype, "request").mockImplementation((async (req: { command: string }) => {
      commands.push(req.command);
      if (req.command === "server_info") return { result: { info: { network_id: networkId } } };
      throw new Error(`unexpected ${req.command}`);
    }) as never);
    return commands;
  };
  const owner = "rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf";
  const sellerAddr = "r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s";

  it("escrow:xrpl on a testnet receipt read from a mainnet server is unavailable", async () => {
    const commands = stubServer(0);
    const [pay] = await settlement(
      sign({
        rail: "escrow:xrpl",
        network: "xrpl:1",
        asset: "XRP",
        amount: "1",
        reference: `${owner}:5`,
        payer: `xrpl:1:${owner}`,
        payee: `xrpl:1:${sellerAddr}`,
      }),
    );
    expect(pay).toMatchObject({ status: "unavailable", detail: /serves NetworkID 0, not 1/ });
    expect(commands).toEqual(["server_info"]);
  });

  it("anchor:xrpl likewise", async () => {
    stubServer(1);
    const checks = await settlement(
      sign({
        rail: "x402:upto", // no settlement lookup: only the anchor reaches the (mocked) server
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        reference: `0x${"ab".repeat(32)}`,
      }),
      [`xrpl:0:${"AB".repeat(32)}`],
    );
    expect(checks.find((c) => c.name === "Anchor on xrpl:0")).toMatchObject({
      status: "unavailable",
      detail: /serves NetworkID 1, not 0/,
    });
  });

  it("an anchor transaction unknown to the server is unavailable (servers may lack history)", async () => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "request").mockImplementation((async (req: { command: string }) => {
      if (req.command === "server_info") return { result: { info: { network_id: 1 } } };
      throw Object.assign(new Error("txnNotFound"), { data: { error: "txnNotFound" } });
    }) as never);
    const checks = await settlement(
      sign({
        rail: "x402:upto", // no settlement lookup: only the anchor reaches the (mocked) server
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        reference: `0x${"ab".repeat(32)}`,
      }),
      [`xrpl:1:${"AB".repeat(32)}`],
    );
    expect(checks.find((c) => c.name === "Anchor on xrpl:1")).toMatchObject({
      status: "unavailable",
    });
  });
});
