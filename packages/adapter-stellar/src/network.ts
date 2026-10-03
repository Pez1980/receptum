import { Networks } from "@stellar/stellar-sdk";

/**
 * This adapter is deliberately testnet-only until the escrow design has been
 * audited (roadmap M5). Every transaction is signed with the testnet
 * passphrase, so it cannot be replayed on, or accepted by, Stellar mainnet.
 */
export const STELLAR_TESTNET = {
  /** CAIP-2 id used in receipts. */
  caip2: "stellar:testnet",
  networkPassphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
} as const;

/** stellar.expert link for a testnet transaction. */
export function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/** Circle's testnet USDC issuer on Stellar. */
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** Testnet USDC in the `CODE:ISSUER` form used throughout this adapter. */
export const TESTNET_USDC = `USDC:${TESTNET_USDC_ISSUER}`;

/** Rail ids written to `payment.rail` (SPEC §7). */
export const STELLAR_ESCROW_RAIL = "escrow:stellar-claimable";
export const STELLAR_ANCHOR_RAIL = "anchor:stellar";

/** CAIP-10 account id for a Stellar testnet address. */
export function caip10(address: string): string {
  return `${STELLAR_TESTNET.caip2}:${address}`;
}

/** Rejects the public-network Horizon; this adapter is testnet-only. */
export function assertTestnetHorizon(url: string): void {
  const host = new URL(url).hostname;
  if (host === "horizon.stellar.org" || host === "mainnet.sorobanrpc.com") {
    throw new Error(`refusing mainnet endpoint ${url}: this adapter is testnet-only`);
  }
}
