import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNetworkAllowed,
  isMainnet,
  isTestnet,
  MainnetNotAllowedError,
  mainnetAllowed,
  networkClass,
} from "./networks.js";

afterEach(() => vi.unstubAllEnvs());

describe("network classification", () => {
  it("classifies the supported networks", () => {
    for (const n of [
      "eip155:84532",
      "eip155:5042002",
      "eip155:421614",
      "eip155:31337",
      "xrpl:1",
      "stellar:testnet",
    ])
      expect(networkClass(n)).toBe("testnet");
    for (const n of ["eip155:8453", "eip155:5042", "eip155:42161", "xrpl:0", "stellar:pubnet"])
      expect(networkClass(n)).toBe("mainnet");
    expect(networkClass("eip155:1")).toBe("unknown");
    expect(networkClass(undefined)).toBe("unknown");
    expect(isMainnet("eip155:8453")).toBe(true);
    expect(isTestnet("eip155:8453")).toBe(false);
  });
});

describe("mainnet opt-in", () => {
  it("is off by default", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(mainnetAllowed()).toBe(false);
    expect(() => assertNetworkAllowed("eip155:8453")).toThrow(MainnetNotAllowedError);
    expect(() => assertNetworkAllowed("xrpl:0")).toThrow(/explicit opt-in/);
  });

  it("never gates testnets", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() => assertNetworkAllowed("eip155:84532")).not.toThrow();
    expect(() => assertNetworkAllowed("stellar:testnet", false)).not.toThrow();
  });

  it("fails closed on unknown networks", () => {
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "");
    expect(() => assertNetworkAllowed("eip155:1")).toThrow(/unknown network/);
    expect(() => assertNetworkAllowed("eip155:1", true)).not.toThrow();
  });

  it("accepts the option or RECEPTUM_ALLOW_MAINNET=1 only", () => {
    expect(() => assertNetworkAllowed("eip155:8453", true)).not.toThrow();
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "true");
    expect(mainnetAllowed()).toBe(false);
    vi.stubEnv("RECEPTUM_ALLOW_MAINNET", "1");
    expect(mainnetAllowed()).toBe(true);
    expect(() => assertNetworkAllowed("stellar:pubnet")).not.toThrow();
    // An explicit false wins over the environment.
    expect(() => assertNetworkAllowed("stellar:pubnet", false)).toThrow(MainnetNotAllowedError);
  });
});
