import type {
  Anchor,
  AnchorRecord,
  EscrowRail,
  EscrowState,
  EscrowStatus,
  Sha256Hex,
} from "@receptum/core";
import { assertNetworkAllowed, isSha256Hex, networkClass } from "@receptum/core";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  http,
  stringToHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arbitrum, arbitrumSepolia, arc, arcTestnet, base, baseSepolia } from "viem/chains";
import {
  receptumEscrowAbi,
  receptumEscrowBytecode,
  receptumEscrowDeployedBytecode,
} from "./artifact.js";

export { receptumEscrowAbi, receptumEscrowBytecode, receptumEscrowDeployedBytecode };

export interface EvmNetwork {
  /** CAIP-2 id. */
  caip2: string;
  chain: Chain;
  /** USDC ERC-20 contract (6 decimals). */
  usdc: Address;
  explorer: string;
  /** True for a mainnet: signing on it requires the explicit opt-in (see `clientsFor`). */
  mainnet?: boolean;
}

/** Testnets with Circle USDC — the default. */
export const TESTNETS = {
  "eip155:5042002": {
    caip2: "eip155:5042002",
    chain: arcTestnet,
    usdc: "0x3600000000000000000000000000000000000000",
    explorer: "https://explorer.testnet.arc.io",
    mainnet: false,
  },
  "eip155:84532": {
    caip2: "eip155:84532",
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
    mainnet: false,
  },
  "eip155:421614": {
    caip2: "eip155:421614",
    chain: arbitrumSepolia,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorer: "https://sepolia.arbiscan.io",
    mainnet: false,
  },
} as const satisfies Record<string, EvmNetwork>;

/**
 * Mainnets with Circle USDC. Listed so verifiers can read them, but every signing path refuses
 * them unless the caller opts in (`allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`).
 * USDC: Circle's published addresses (developers.circle.com/stablecoins/usdc-contract-addresses).
 * On Arc, USDC is the native gas token; `0x3600…0000` is its optional ERC-20 interface (6 decimals).
 */
export const MAINNETS = {
  "eip155:8453": {
    caip2: "eip155:8453",
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    mainnet: true,
  },
  "eip155:5042": {
    caip2: "eip155:5042",
    chain: arc,
    usdc: "0x3600000000000000000000000000000000000000",
    explorer: "https://explorer.arc.io",
    mainnet: true,
  },
  "eip155:42161": {
    caip2: "eip155:42161",
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorer: "https://arbiscan.io",
    mainnet: true,
  },
} as const satisfies Record<string, EvmNetwork>;

/** Every supported network: testnets (default) and opt-in mainnets. */
export const NETWORKS = { ...TESTNETS, ...MAINNETS } as const satisfies Record<string, EvmNetwork>;

export type NetworkId = keyof typeof NETWORKS;
export type TestnetId = keyof typeof TESTNETS;
export type MainnetId = keyof typeof MAINNETS;

/** Does signing on `network` need the mainnet opt-in? Known testnets and local chains don't. */
export const requiresMainnetOptIn = (network: EvmNetwork): boolean =>
  network.mainnet === true || networkClass(network.caip2) !== "testnet";

export const RAIL_ID = "escrow:receptum-evm";

const STATUS: Record<number, EscrowStatus | undefined> = {
  1: "open",
  2: "delivered",
  3: "released",
  4: "refunded",
};

/** receiptHash (hex64) ⇄ bytes32. */
export const toBytes32 = (hash: Sha256Hex): Hex => {
  if (!isSha256Hex(hash)) throw new TypeError("receiptHash must be 64 lower-case hex characters");
  return `0x${hash}`;
};
const fromBytes32 = (b: Hex): Sha256Hex => b.slice(2).toLowerCase();

/** escrowId format: `<caip2>:<contract>:<id>`, e.g. `eip155:5042002:0xAbc…:7`. */
export function formatEscrowId(network: string, contract: Address, id: bigint): string {
  return `${network}:${contract}:${id}`;
}

export function parseEscrowId(escrowId: string): {
  network: string;
  contract: Address;
  id: bigint;
} {
  const m = /^(eip155:\d+):(0x[0-9a-fA-F]{40}):(\d+)$/.exec(escrowId);
  if (!m?.[1] || !m[2] || !m[3]) throw new TypeError(`invalid EVM escrowId: ${escrowId}`);
  return { network: m[1], contract: m[2] as Address, id: BigInt(m[3]) };
}

export interface EvmClients {
  network: EvmNetwork;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  /**
   * Mainnet opt-in for this bundle. Without it (or `RECEPTUM_ALLOW_MAINNET=1`), every signing
   * call on a mainnet or unknown chain throws `MainnetNotAllowedError` before anything is signed.
   */
  allowMainnet?: boolean;
}

export interface ClientsOptions {
  rpcUrl?: string;
  /** Required (or `RECEPTUM_ALLOW_MAINNET=1`) for a mainnet network. */
  allowMainnet?: boolean;
}

/** Throws before any signature unless `c` is on a testnet or mainnet use is allowed. */
export function assertSigningAllowed(c: Pick<EvmClients, "network" | "allowMainnet">): void {
  if (!requiresMainnetOptIn(c.network)) return;
  assertNetworkAllowed(c.network.caip2, c.allowMainnet, "sign");
}

/**
 * Signing clients for `networkId`. Mainnet ids throw `MainnetNotAllowedError` here unless
 * `allowMainnet: true` is passed or `RECEPTUM_ALLOW_MAINNET=1` is set. The third argument may be
 * an RPC URL (legacy form) or `{ rpcUrl, allowMainnet }`.
 */
export function clientsFor(
  networkId: NetworkId,
  account: Account,
  options?: string | ClientsOptions,
): EvmClients {
  const network: EvmNetwork | undefined = NETWORKS[networkId];
  if (!network) throw new TypeError(`unknown EVM network ${String(networkId)}`);
  const opts: ClientsOptions = typeof options === "string" ? { rpcUrl: options } : (options ?? {});
  assertSigningAllowed({
    network,
    ...(opts.allowMainnet !== undefined ? { allowMainnet: opts.allowMainnet } : {}),
  });
  const transport = http(opts.rpcUrl);
  return {
    network,
    account,
    publicClient: createPublicClient({ chain: network.chain, transport }) as PublicClient,
    walletClient: createWalletClient({ chain: network.chain, transport, account }),
    ...(opts.allowMainnet !== undefined ? { allowMainnet: opts.allowMainnet } : {}),
  };
}

/** Deploys a ReceptumEscrow contract and returns its address. */
export async function deployEscrow(c: EvmClients): Promise<Address> {
  assertSigningAllowed(c);
  const hash = await c.walletClient.deployContract({
    abi: receptumEscrowAbi,
    bytecode: receptumEscrowBytecode,
    account: c.account,
    chain: c.network.chain,
  });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deployment failed: ${hash}`);
  return receipt.contractAddress;
}

export interface OpenEscrowParams {
  contract: Address;
  seller: Address;
  /** Amount in USDC base units (6 decimals). */
  amount: bigint;
  deliverBy: Date;
  reviewWindowSeconds: number;
  evaluator?: Address;
  token?: Address;
}

/**
 * EscrowRail backed by the ReceptumEscrow contract. Construct it with the clients of the
 * party making the calls: the buyer opens/accepts/rejects, the seller delivers/releases.
 */
export class EvmEscrowRail implements EscrowRail {
  readonly id = RAIL_ID;

  constructor(private readonly c: EvmClients) {}

  private parse(escrowId: string) {
    const p = parseEscrowId(escrowId);
    if (p.network !== this.c.network.caip2)
      throw new Error(`escrow is on ${p.network}, rail is on ${this.c.network.caip2}`);
    return p;
  }

  private async write(
    contract: Address,
    functionName: "deliver" | "accept" | "reject" | "release" | "refund" | "sellerRefund",
    args: readonly unknown[],
  ) {
    assertSigningAllowed(this.c);
    const hash = await this.c.walletClient.writeContract({
      address: contract,
      abi: receptumEscrowAbi,
      functionName,
      args: args as never,
      account: this.c.account,
      chain: this.c.network.chain,
    });
    const receipt = await this.c.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return { reference: hash };
  }

  /** Buyer: approve the token and open an escrow. Returns the escrowId and transaction hashes. */
  async open(p: OpenEscrowParams): Promise<{ escrowId: string; approve: Hex; open: Hex }> {
    assertSigningAllowed(this.c);
    const token = p.token ?? this.c.network.usdc;
    const approve = await this.c.walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [p.contract, p.amount],
      account: this.c.account,
      chain: this.c.network.chain,
    });
    await this.c.publicClient.waitForTransactionReceipt({ hash: approve });
    const open = await this.c.walletClient.writeContract({
      address: p.contract,
      abi: receptumEscrowAbi,
      functionName: "open",
      args: [
        p.seller,
        token,
        p.amount,
        BigInt(Math.floor(p.deliverBy.getTime() / 1000)),
        p.reviewWindowSeconds,
        p.evaluator ?? "0x0000000000000000000000000000000000000000",
      ],
      account: this.c.account,
      chain: this.c.network.chain,
    });
    const receipt = await this.c.publicClient.waitForTransactionReceipt({ hash: open });
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: receptumEscrowAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Opened") {
          return {
            escrowId: formatEscrowId(this.c.network.caip2, p.contract, ev.args.id),
            approve,
            open,
          };
        }
      } catch {
        // not our event
      }
    }
    throw new Error(`Opened event not found in ${open}`);
  }

  async getEscrow(escrowId: string): Promise<EscrowState> {
    const { contract, id } = this.parse(escrowId);
    const [
      buyer,
      seller,
      ,
      token,
      amount,
      deliverBy,
      reviewWindow,
      deliveredAt,
      status,
      receiptHash,
    ] = await this.c.publicClient.readContract({
      address: contract,
      abi: receptumEscrowAbi,
      functionName: "escrows",
      args: [id],
    });
    const s = STATUS[status];
    if (!s) throw new Error(`escrow ${escrowId} not found`);
    const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    return {
      rail: RAIL_ID,
      network: this.c.network.caip2,
      escrowId,
      amount: amount.toString(),
      asset: token,
      buyer: `${this.c.network.caip2}:${buyer}`,
      seller: `${this.c.network.caip2}:${seller}`,
      refundableAfter: iso(deliverBy),
      status: s,
      ...(deliveredAt > 0n
        ? {
            receiptHash: fromBytes32(receiptHash),
            releasableAfter: iso(deliveredAt + BigInt(reviewWindow)),
          }
        : {}),
    };
  }

  /** Seller: commit the receipt hash on delivery. */
  deliver(escrowId: string, receiptHash: Sha256Hex) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "deliver", [id, toBytes32(receiptHash)]);
  }

  /** Buyer or evaluator: accept the delivery (seller paid in full). */
  accept(escrowId: string) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "accept", [id]);
  }

  /** Buyer or evaluator: reject within the review window (buyer refunded). */
  reject(escrowId: string) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "reject", [id]);
  }

  /** Anyone: release to the seller after the review window. */
  release(escrowId: string) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "release", [id]);
  }

  /** Seller: return the funds to the buyer before release (dispute settlement, blocked payee). */
  sellerRefund(escrowId: string) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "sellerRefund", [id]);
  }

  /** Anyone: refund the buyer after the deadline when nothing was delivered. */
  refund(escrowId: string) {
    const { contract, id } = this.parse(escrowId);
    return this.write(contract, "refund", [id]);
  }
}

const ANCHOR_PREFIX = stringToHex("receptum/1");

/** Encodes anchor calldata: utf8("receptum/1") || receiptHash. */
export function anchorCalldata(receiptHash: Sha256Hex): Hex {
  return `${ANCHOR_PREFIX}${toBytes32(receiptHash).slice(2)}`;
}

/** Anchors a receipt hash with a zero-value self-transaction (for rails without escrow, e.g. x402). */
export class EvmAnchor implements Anchor {
  readonly id = "anchor:evm";

  constructor(private readonly c: EvmClients) {}

  async anchor(receiptHash: Sha256Hex): Promise<AnchorRecord> {
    assertSigningAllowed(this.c);
    const hash = await this.c.walletClient.sendTransaction({
      to: this.c.account.address,
      value: 0n,
      data: anchorCalldata(receiptHash),
      account: this.c.account,
      chain: this.c.network.chain,
    });
    await this.c.publicClient.waitForTransactionReceipt({ hash });
    return {
      rail: this.id,
      network: this.c.network.caip2,
      receiptHash,
      reference: hash,
      anchoredAt: new Date().toISOString(),
    };
  }

  async find(receiptHash: Sha256Hex, hint?: { reference?: string }): Promise<AnchorRecord | null> {
    if (!hint?.reference) return null;
    const tx = await this.c.publicClient.getTransaction({ hash: hint.reference as Hex });
    if (tx.input.toLowerCase() !== anchorCalldata(receiptHash).toLowerCase()) return null;
    const block = await this.c.publicClient.getBlock({ blockHash: tx.blockHash! });
    return {
      rail: this.id,
      network: this.c.network.caip2,
      receiptHash,
      reference: hint.reference,
      anchoredAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  }
}

export { evmAccountSigner, evmBindingVerifier } from "./binding.js";
