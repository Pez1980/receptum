/**
 * Network classification and the mainnet opt-in shared by every Receptum package.
 *
 * Testnets are the default everywhere. Anything that would sign or send on a mainnet — or on a
 * network this registry does not know — refuses unless the caller opts in explicitly, with an
 * `allowMainnet: true` option or `RECEPTUM_ALLOW_MAINNET=1` in the environment. Read-only checks
 * (verifiers) never need the opt-in: verifying a mainnet receipt moves nothing.
 */

/** Environment variable that opts a process into mainnet use. Only the exact value `1` counts. */
export const ALLOW_MAINNET_ENV = "RECEPTUM_ALLOW_MAINNET";

/** CAIP-2 ids of the public test networks Receptum supports (plus local dev chains). */
export const TESTNET_NETWORKS: readonly string[] = [
  "eip155:84532", // Base Sepolia
  "eip155:5042002", // Arc testnet
  "eip155:31337", // anvil / hardhat (local)
  "eip155:1337", // ganache / geth dev (local)
  "xrpl:1", // XRPL testnet
  "stellar:testnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana devnet
];

/** CAIP-2 ids of the mainnets Receptum knows. Using any of them for signing needs the opt-in. */
export const MAINNET_NETWORKS: readonly string[] = [
  "eip155:8453", // Base
  "eip155:5042", // Arc
  "xrpl:0", // XRPL mainnet
  "stellar:pubnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana mainnet-beta
];

export type NetworkClass = "mainnet" | "testnet" | "unknown";

/** `mainnet`, `testnet`, or `unknown` (not in either registry — treated like mainnet when signing). */
export function networkClass(caip2: string | undefined): NetworkClass {
  if (caip2 === undefined) return "unknown";
  if (TESTNET_NETWORKS.includes(caip2)) return "testnet";
  if (MAINNET_NETWORKS.includes(caip2)) return "mainnet";
  return "unknown";
}

/** True when the receipt network is a known mainnet. */
export const isMainnet = (caip2: string | undefined): boolean => networkClass(caip2) === "mainnet";

/** True when the receipt network is a known testnet (or local dev chain). */
export const isTestnet = (caip2: string | undefined): boolean => networkClass(caip2) === "testnet";

/**
 * Is mainnet use allowed? An explicit option wins (so `allowMainnet: false` refuses even when the
 * environment opts in); otherwise `RECEPTUM_ALLOW_MAINNET=1`.
 */
export function mainnetAllowed(allowMainnet?: boolean): boolean {
  if (allowMainnet !== undefined) return allowMainnet === true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[ALLOW_MAINNET_ENV] === "1";
}

/** Thrown before any signature when a mainnet (or unknown) network is used without the opt-in. */
export class MainnetNotAllowedError extends Error {
  constructor(
    readonly network: string,
    what = "use",
  ) {
    super(
      `refusing to ${what} on ${network}: ${networkClass(network) === "mainnet" ? "mainnet" : "unknown network"} requires an explicit opt-in (allowMainnet: true or ${ALLOW_MAINNET_ENV}=1)`,
    );
    this.name = "MainnetNotAllowedError";
  }
}

/**
 * Throws `MainnetNotAllowedError` unless `caip2` is a known testnet or mainnet use is allowed.
 * Unknown networks fail closed: they need the same opt-in as a mainnet.
 */
export function assertNetworkAllowed(caip2: string, allowMainnet?: boolean, what = "sign"): void {
  if (networkClass(caip2) === "testnet") return;
  if (!mainnetAllowed(allowMainnet)) throw new MainnetNotAllowedError(caip2, what);
}
