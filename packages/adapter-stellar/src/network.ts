import { Networks } from "@stellar/stellar-sdk";
import { assertNetworkAllowed } from "@receptum/core";

/** One Stellar network: passphrase, endpoints and Circle USDC. */
export interface StellarNetwork {
  /** CAIP-2 id used in receipts. */
  caip2: "stellar:testnet" | "stellar:pubnet";
  networkPassphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  friendbotUrl?: string;
  /** stellar.expert base for this network. */
  explorer: string;
  /** Circle's USDC issuer on this network. */
  usdcIssuer: string;
  /** True for the public network: signing needs the explicit opt-in. */
  mainnet: boolean;
}

/** Circle's testnet USDC issuer on Stellar. */
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** Testnet USDC in the `CODE:ISSUER` form used throughout this adapter. */
export const TESTNET_USDC = `USDC:${TESTNET_USDC_ISSUER}`;

/**
 * Circle's official mainnet (pubnet) USDC issuer
 * (developers.circle.com/stablecoins/usdc-contract-addresses).
 */
export const PUBNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** Mainnet USDC in `CODE:ISSUER` form. */
export const PUBNET_USDC = `USDC:${PUBNET_USDC_ISSUER}`;

/**
 * Stellar testnet — the default everywhere. Every transaction is signed with the testnet
 * passphrase, so it cannot be replayed on, or accepted by, the public network.
 */
export const STELLAR_TESTNET = {
  caip2: "stellar:testnet",
  networkPassphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  explorer: "https://stellar.expert/explorer/testnet",
  usdcIssuer: TESTNET_USDC_ISSUER,
  mainnet: false,
} as const satisfies StellarNetwork;

/**
 * Stellar public network (mainnet). Read-only use (verification) needs nothing; anything that
 * signs refuses unless the caller passes `allowMainnet: true` or sets `RECEPTUM_ALLOW_MAINNET=1`.
 * SDF runs no public mainnet Soroban RPC; the default is the community endpoint listed in the
 * Stellar docs (developers.stellar.org/docs/data/apis/rpc/providers) — production deployments
 * should pass their own `rpcUrl`. The RPC's passphrase is checked before every signature.
 */
export const STELLAR_PUBNET = {
  caip2: "stellar:pubnet",
  networkPassphrase: Networks.PUBLIC,
  horizonUrl: "https://horizon.stellar.org",
  sorobanRpcUrl: "https://mainnet.sorobanrpc.com",
  explorer: "https://stellar.expert/explorer/public",
  usdcIssuer: PUBNET_USDC_ISSUER,
  mainnet: true,
} as const satisfies StellarNetwork;

export const STELLAR_NETWORKS = {
  "stellar:testnet": STELLAR_TESTNET,
  "stellar:pubnet": STELLAR_PUBNET,
} as const satisfies Record<string, StellarNetwork>;

/** A network by object, CAIP-2 id, or short name (`testnet` / `pubnet`). */
export type StellarNetworkLike =
  StellarNetwork | "testnet" | "pubnet" | "stellar:testnet" | "stellar:pubnet";

export interface StellarNetworkOptions {
  /** Default testnet. */
  network?: StellarNetworkLike;
  /** Required (or `RECEPTUM_ALLOW_MAINNET=1`) to sign on pubnet. */
  allowMainnet?: boolean;
}

/** Resolves a network option (default testnet). Throws on anything that isn't a Stellar network. */
export function stellarNetwork(
  network: StellarNetworkLike | string = STELLAR_TESTNET,
): StellarNetwork {
  if (typeof network === "object") return network;
  const id = network.startsWith("stellar:") ? network : `stellar:${network}`;
  const n = (STELLAR_NETWORKS as Record<string, StellarNetwork>)[id];
  if (!n) throw new TypeError(`unknown Stellar network ${network}`);
  return n;
}

/** Throws `MainnetNotAllowedError` before signing on pubnet without the opt-in. */
export function assertStellarSigningAllowed(network: StellarNetwork, allowMainnet?: boolean): void {
  if (!network.mainnet && network.networkPassphrase === Networks.TESTNET) return;
  assertNetworkAllowed(
    network.mainnet ? STELLAR_PUBNET.caip2 : `stellar:${network.networkPassphrase}`,
    allowMainnet,
    "sign",
  );
}

/** Rail ids written to `payment.rail` (SPEC §7). */
export const STELLAR_ESCROW_RAIL = "escrow:stellar-claimable";
export const STELLAR_ANCHOR_RAIL = "anchor:stellar";

/** stellar.expert link for a transaction (default testnet). */
export function explorerTxUrl(hash: string, network: StellarNetworkLike = STELLAR_TESTNET): string {
  return `${stellarNetwork(network).explorer}/tx/${hash}`;
}

/** CAIP-10 account id for a Stellar address (default testnet). */
export function caip10(address: string, network: StellarNetworkLike = STELLAR_TESTNET): string {
  return `${stellarNetwork(network).caip2}:${address}`;
}

const MAINNET_HOSTS = ["horizon.stellar.org", "mainnet.sorobanrpc.com"];
const TESTNET_HOSTS = ["horizon-testnet.stellar.org", "soroban-testnet.stellar.org"];

/** Rejects the public-network Horizon for a testnet client. */
export function assertTestnetHorizon(url: string): void {
  const host = new URL(url).hostname;
  if (MAINNET_HOSTS.includes(host)) {
    throw new Error(`refusing mainnet endpoint ${url}: this client is configured for testnet`);
  }
}

/** Rejects an endpoint that obviously belongs to the other network. */
export function assertEndpointMatches(url: string, network: StellarNetwork): void {
  if (!network.mainnet) return assertTestnetHorizon(url);
  const host = new URL(url).hostname;
  if (TESTNET_HOSTS.includes(host))
    throw new Error(`refusing testnet endpoint ${url}: this client is configured for pubnet`);
}
