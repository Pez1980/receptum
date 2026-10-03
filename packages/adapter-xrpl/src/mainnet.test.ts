import { MainnetNotAllowedError, sha256Hex } from "@receptum/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { XrplAnchor } from "./anchor.js";
import { newEscrowSecret } from "./condition.js";
import { XrplEscrowRail } from "./escrow.js";
import { fakeLedger } from "./fake-ledger.test-util.js";
import { assertNetwork, xrplNetworkId, XRPL_ENDPOINTS, XRPL_MAINNET } from "./ledger.js";

// Every ledger here is the in-memory fake: nothing reaches a real XRPL server.
const buyer = Wallet.generate();
const seller = Wallet.generate();
const receiptHash = sha256Hex("receipt");

afterEach(() => vi.unstubAllEnvs());

describe("assertNetwork", () => {
  it("keeps the testnet guard by default", async () => {
    const ledger = fakeLedger();
    await expect(assertNetwork(ledger.client)).resolves.toBeUndefined();
    ledger.state.networkId = 0;
    await expect(assertNetwork(ledger.client)).rejects.toThrow(/expected testnet \(1\)/);
    ledger.state.networkId = undefined;
    await expect(assertNetwork(ledger.client, "xrpl:1")).rejects.toThrow(/NetworkID none/);
  });

  it("refuses mainnet without the opt-in, before asking the server", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const ledger = fakeLedger();
    ledger.state.networkId = 0;
    const request = vi.spyOn(ledger.client, "request");
    await expect(assertNetwork(ledger.client, XRPL_MAINNET)).rejects.toThrow(
      MainnetNotAllowedError,
    );
    await expect(
      assertNetwork(ledger.client, XRPL_MAINNET, { allowMainnet: false }),
    ).rejects.toThrow(/explicit opt-in/);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts mainnet with the opt-in only when the server reports NetworkID 0", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const ledger = fakeLedger();
    ledger.state.networkId = 0;
    await expect(
      assertNetwork(ledger.client, XRPL_MAINNET, { allowMainnet: true }),
    ).resolves.toBeUndefined();
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    await expect(assertNetwork(ledger.client, XRPL_MAINNET)).resolves.toBeUndefined();
    // A testnet (or silent) server is never taken for mainnet.
    ledger.state.networkId = 1;
    await expect(assertNetwork(ledger.client, XRPL_MAINNET)).rejects.toThrow(/xrpl:0 \(0\)/);
    ledger.state.networkId = undefined;
    await expect(assertNetwork(ledger.client, XRPL_MAINNET)).rejects.toThrow(/NetworkID none/);
  });

  it("fails closed on other networks and malformed ids", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const ledger = fakeLedger();
    ledger.state.networkId = 2;
    await expect(assertNetwork(ledger.client, "xrpl:2")).rejects.toThrow(/unknown network/);
    await expect(assertNetwork(ledger.client, "eip155:1")).rejects.toThrow(TypeError);
    expect(() => xrplNetworkId("xrpl:01")).toThrow(TypeError);
  });

  it("lists the public mainnet endpoints", () => {
    expect(XRPL_ENDPOINTS["xrpl:0"]).toEqual(
      expect.arrayContaining(["wss://xrplcluster.com", "wss://s1.ripple.com"]),
    );
    expect(XRPL_ENDPOINTS["xrpl:1"]).toEqual(["wss://s.altnet.rippletest.net:51233"]);
  });
});

describe("rails on mainnet", () => {
  const params = (ledger: ReturnType<typeof fakeLedger>) => ({
    seller: seller.address,
    amount: "1000000",
    asset: "XRP",
    deliverBy: new Date((ledger.state.closeTime + 946_684_800 + 600) * 1000),
    reviewWindowSeconds: 300,
    condition: newEscrowSecret().condition,
  });

  it("refuse to sign without the opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const ledger = fakeLedger();
    ledger.state.networkId = 0;
    const rail = new XrplEscrowRail({ client: ledger.client, wallet: buyer, network: "xrpl:0" });
    await expect(rail.createEscrow(params(ledger))).rejects.toThrow(MainnetNotAllowedError);
    const anchor = new XrplAnchor({ client: ledger.client, wallet: seller, network: "xrpl:0" });
    await expect(anchor.anchor(receiptHash)).rejects.toThrow(MainnetNotAllowedError);
    expect(ledger.state.submitted).toEqual([]);
  });

  it("sign (on the fake ledger) with the opt-in", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    const ledger = fakeLedger();
    ledger.state.networkId = 0;
    const rail = new XrplEscrowRail({
      client: ledger.client,
      wallet: buyer,
      network: "xrpl:0",
      allowMainnet: true,
    });
    const handle = await rail.createEscrow(params(ledger));
    expect(handle.network).toBe("xrpl:0");
    expect(handle.buyer).toBe(buyer.address);
    const anchor = new XrplAnchor({
      client: ledger.client,
      wallet: seller,
      network: "xrpl:0",
      allowMainnet: true,
    });
    expect(await anchor.anchor(receiptHash)).toMatchObject({ network: "xrpl:0" });
    expect(ledger.state.submitted).toHaveLength(2);
  });

  it("a mainnet-configured rail still refuses a testnet server", async () => {
    const ledger = fakeLedger(); // reports NetworkID 1
    const rail = new XrplEscrowRail({
      client: ledger.client,
      wallet: buyer,
      network: "xrpl:0",
      allowMainnet: true,
    });
    await expect(rail.createEscrow(params(ledger))).rejects.toThrow(/refusing to sign/);
    expect(ledger.state.submitted).toEqual([]);
  });

  it("a testnet rail refuses a mainnet server even when mainnet is allowed", async () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    const ledger = fakeLedger();
    ledger.state.networkId = 0;
    const rail = new XrplEscrowRail({ client: ledger.client, wallet: buyer });
    await expect(rail.createEscrow(params(ledger))).rejects.toThrow(/expected testnet/);
  });
});
