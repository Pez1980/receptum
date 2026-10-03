import { SOLANA_RPC_ENDPOINTS } from "./network.js";

/** Calls one Solana JSON-RPC method and returns its `result`. Transport and RPC errors throw. */
export type SolanaRpc = (method: string, params: unknown[]) => Promise<unknown>;

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

/** Plain-fetch JSON-RPC client. */
export function solanaJsonRpc(url: string, timeoutMs = 30_000): SolanaRpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new SolanaRpcError(`${method} via ${url}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (body.error)
      throw new SolanaRpcError(
        `${method}: ${body.error.message ?? "RPC error"}`,
        body.error.code,
        body.error.data,
      );
    return body.result;
  };
}

/** RPC for a CAIP-2 network: `rpcUrl` when given, else the public endpoint (or throws). */
export function rpcFor(network: string, rpcUrl?: string): SolanaRpc {
  const url = rpcUrl ?? SOLANA_RPC_ENDPOINTS[network];
  if (!url) throw new SolanaRpcError(`no Solana RPC endpoint configured for ${network}`);
  return solanaJsonRpc(url);
}

/** The cluster's genesis hash serves `network` when it begins with the CAIP-2 reference. */
export async function servesNetwork(rpc: SolanaRpc, network: string): Promise<boolean> {
  const genesis = await rpc("getGenesisHash", []);
  return typeof genesis === "string" && genesis.startsWith(network.slice("solana:".length));
}

export interface AccountData {
  owner: string;
  lamports: number;
  executable: boolean;
  data: Uint8Array;
}

/** `getAccountInfo` (base64); null when the account does not exist. */
export async function getAccount(
  rpc: SolanaRpc,
  address: string,
  commitment: "confirmed" | "finalized" = "confirmed",
): Promise<AccountData | null> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment }])) as {
    value: null | { owner: string; lamports: number; executable: boolean; data: [string, string] };
  };
  if (!r?.value) return null;
  return {
    owner: r.value.owner,
    lamports: r.value.lamports,
    executable: r.value.executable,
    data: new Uint8Array(Buffer.from(r.value.data[0], "base64")),
  };
}

/** Fetches a transaction (jsonParsed), trying `finalized` first, then `confirmed`. */
export async function getParsedTransaction(
  rpc: SolanaRpc,
  signature: string,
): Promise<{ tx: ParsedTransaction; commitment: "finalized" | "confirmed" } | null> {
  for (const commitment of ["finalized", "confirmed"] as const) {
    const tx = (await rpc("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment, maxSupportedTransactionVersion: 0 },
    ])) as ParsedTransaction | null;
    if (tx) return { tx, commitment };
  }
  return null;
}

export interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: unknown;
  data?: string;
  accounts?: string[];
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** The subset of a jsonParsed `getTransaction` result Receptum reads. */
export interface ParsedTransaction {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[];
    logMessages?: string[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
      instructions: ParsedInstruction[];
    };
  };
}
