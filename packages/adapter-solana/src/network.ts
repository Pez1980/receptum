import { assertNetworkAllowed } from "@receptum/core";

/**
 * CAIP-2 ids: `solana:` + the first 32 characters of the cluster's base58 genesis hash. Devnet is
 * the id x402 facilitators advertise (https://x402.org/facilitator/supported).
 */
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Public JSON-RPC endpoints by CAIP-2 id. Override them for production use. */
export const SOLANA_RPC_ENDPOINTS: Readonly<Record<string, string>> = {
  [SOLANA_DEVNET]: "https://api.devnet.solana.com",
  [SOLANA_MAINNET]: "https://api.mainnet-beta.solana.com",
};

const CAIP2 = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

/** True for a syntactically valid `solana:<genesis-prefix>` id. */
export const isSolanaNetwork = (network: unknown): network is string =>
  typeof network === "string" && CAIP2.test(network);

/** CAIP-10 account id on a Solana network. */
export function solanaCaip10(network: string, address: string): string {
  return `${network}:${address}`;
}

/** Explorer link for a transaction (devnet gets `?cluster=devnet`). */
export function explorerTxUrl(signature: string, network = SOLANA_DEVNET): string {
  return `https://explorer.solana.com/tx/${signature}${network === SOLANA_DEVNET ? "?cluster=devnet" : ""}`;
}

/** Explorer link for an account or program. */
export function explorerAddressUrl(address: string, network = SOLANA_DEVNET): string {
  return `https://explorer.solana.com/address/${address}${network === SOLANA_DEVNET ? "?cluster=devnet" : ""}`;
}

/**
 * Throws before anything is signed unless `network` is devnet, or mainnet use is opted into
 * (`allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`).
 */
export function assertSolanaNetwork(network: string, allowMainnet?: boolean): void {
  if (!isSolanaNetwork(network)) throw new TypeError(`not a Solana CAIP-2 id: ${network}`);
  assertNetworkAllowed(network, allowMainnet, "sign");
}
