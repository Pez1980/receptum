import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  isSha256Hex,
  type EscrowCapabilities,
  type EscrowRail,
  type EscrowState,
  type EscrowStatus,
  type Sha256Hex,
} from "@receptum/core";
import { parseAsset } from "./codec.js";
import {
  assertStellarSigningAllowed,
  PUBNET_USDC,
  STELLAR_PUBNET,
  STELLAR_TESTNET,
  TESTNET_USDC,
  assertEndpointMatches,
  stellarNetwork,
  type StellarNetwork,
  type StellarNetworkLike,
  type StellarNetworkOptions,
} from "./network.js";
import type { StellarSigner } from "./signer.js";

/** Rail id written to `payment.rail` for the Soroban ReceptumEscrow (SPEC §7). */
export const SOROBAN_ESCROW_RAIL = "escrow:receptum-soroban";

/**
 * SHA-256 of the published (unaudited) `receptum_escrow.wasm` — contracts/receptum-escrow, built
 * with `stellar contract build` (stellar-cli 28.1.0, rustc 1.99.0). Verifiers require a contract
 * to run exactly this code.
 */
export const RECEPTUM_SOROBAN_WASM_HASH =
  "0dc6b174951cad16630ab1d6600e54d4b6378d9d076fd0d0c5936e2bcaa3deaf";

/** What the Soroban escrow enforces on-chain (same hybrid machine as the EVM escrow). */
export const SOROBAN_ESCROW_CAPABILITIES: EscrowCapabilities = {
  acceptanceModes: ["buyer", "evaluator", "auto"],
  reviewWindowFromDelivery: true,
  refundAfterDelivery: true,
};

/** Contract error codes (`Error` in contracts/receptum-escrow/src/lib.rs). */
export const SOROBAN_ESCROW_ERRORS: Record<number, string> = {
  1: "BadState",
  2: "NotAllowed",
  3: "TooEarly",
  4: "TooLate",
  5: "InvalidArgs",
  6: "UnsupportedToken",
  7: "NotFound",
  8: "Overflow",
};

// ─── Escrow ids ────────────────────────────────────────────────────────────

/**
 * escrowId format: `<caip2>:<contract C…>:<id>`, e.g. `stellar:testnet:CABC…:7` (default testnet)
 * or `stellar:pubnet:CABC…:7`.
 */
export function formatSorobanEscrowId(
  contractId: string,
  id: bigint | number,
  network: StellarNetworkLike = STELLAR_TESTNET,
): string {
  if (!StrKey.isValidContract(contractId)) throw new TypeError(`invalid contract id ${contractId}`);
  return `${stellarNetwork(network).caip2}:${contractId}:${BigInt(id)}`;
}

export function parseSorobanEscrowId(escrowId: string): {
  contractId: string;
  id: bigint;
  network: "stellar:testnet" | "stellar:pubnet";
} {
  const m = /^(stellar:(?:testnet|pubnet)):(C[A-Z2-7]{55}):([1-9][0-9]{0,19})$/.exec(escrowId);
  if (!m?.[1] || !m[2] || !m[3] || !StrKey.isValidContract(m[2]) || BigInt(m[3]) >= 2n ** 64n) {
    throw new TypeError(`invalid Soroban escrowId: ${escrowId}`);
  }
  return {
    contractId: m[2],
    id: BigInt(m[3]),
    network: m[1] as "stellar:testnet" | "stellar:pubnet",
  };
}

/**
 * Token contract for an asset: the Stellar Asset Contract of `native` / `CODE:ISSUER` on the
 * network (default testnet), or a `C…` contract id unchanged.
 */
export function tokenContractId(
  asset: string,
  network: StellarNetworkLike = STELLAR_TESTNET,
): string {
  if (StrKey.isValidContract(asset)) return asset;
  return parseAsset(asset).contractId(stellarNetwork(network).networkPassphrase);
}

/** Testnet USDC's Stellar Asset Contract. */
export const TESTNET_USDC_SAC = new Asset("USDC", TESTNET_USDC.split(":")[1]!).contractId(
  STELLAR_TESTNET.networkPassphrase,
);

/** Mainnet (pubnet) Circle USDC's Stellar Asset Contract. */
export const PUBNET_USDC_SAC = new Asset("USDC", PUBNET_USDC.split(":")[1]!).contractId(
  STELLAR_PUBNET.networkPassphrase,
);

// ─── Contract storage codec (pure) ─────────────────────────────────────────

/** Ledger key of escrow `id`: the contract's `DataKey::Escrow(id)`. */
export function escrowStorageKey(id: bigint): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Escrow"), nativeToScVal(id, { type: "u64" })]);
}

const STATUS: Record<number, EscrowStatus> = {
  1: "open",
  2: "delivered",
  3: "released",
  4: "refunded",
};

/** One escrow as stored by the contract, in JS types. */
export interface SorobanEscrowRecord {
  buyer: string;
  seller: string;
  evaluator?: string;
  token: string;
  amount: bigint;
  /** Unix seconds. */
  deliverBy: number;
  reviewWindowSeconds: number;
  /** Unix seconds, 0 until delivered. */
  deliveredAt: number;
  status: EscrowStatus;
  receiptHash?: Sha256Hex;
}

const FIELDS = [
  "amount",
  "buyer",
  "deliver_by",
  "delivered_at",
  "evaluator",
  "receipt_hash",
  "review_window",
  "seller",
  "status",
  "token",
].join(",");

/** Decodes the contract's `Escrow` struct, rejecting anything that doesn't have exactly its shape. */
export function decodeEscrowRecord(val: xdr.ScVal): SorobanEscrowRecord {
  const raw = scValToNative(val) as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new TypeError(`not a ReceptumEscrow record: ${what}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("not a map");
  if (Object.keys(raw).sort().join(",") !== FIELDS) fail("unexpected fields");
  const account = (v: unknown, k: string) =>
    typeof v === "string" && (StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v))
      ? v
      : fail(k);
  const u64 = (v: unknown, k: string) =>
    typeof v === "bigint" && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : fail(k);
  const status = STATUS[raw.status as number] ?? fail("status");
  let receiptHash: Sha256Hex | undefined;
  if (raw.receipt_hash !== null && raw.receipt_hash !== undefined) {
    const bytes = raw.receipt_hash;
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail("receipt_hash");
    receiptHash = Buffer.from(bytes as Uint8Array).toString("hex");
    if (!isSha256Hex(receiptHash)) fail("receipt_hash");
  }
  if (typeof raw.amount !== "bigint" || raw.amount <= 0n) fail("amount");
  if (typeof raw.review_window !== "number" || !Number.isSafeInteger(raw.review_window))
    fail("review_window");
  const evaluator =
    raw.evaluator === null || raw.evaluator === undefined
      ? undefined
      : account(raw.evaluator, "evaluator");
  return {
    buyer: account(raw.buyer, "buyer"),
    seller: account(raw.seller, "seller"),
    ...(evaluator ? { evaluator } : {}),
    token: StrKey.isValidContract(raw.token as string) ? (raw.token as string) : fail("token"),
    amount: raw.amount as bigint,
    deliverBy: u64(raw.deliver_by, "deliver_by"),
    reviewWindowSeconds: raw.review_window as number,
    deliveredAt: u64(raw.delivered_at, "delivered_at"),
    status,
    ...(receiptHash ? { receiptHash } : {}),
  };
}

export interface SorobanEscrowState extends EscrowState {
  contractId: string;
  /** Token contract holding the funds (`asset` is the same id). */
  token: string;
  evaluator?: string;
  reviewWindowSeconds: number;
  /** ISO time of the delivery, when delivered. */
  deliveredAt?: string;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** Maps a stored record to the core escrow lifecycle. */
export function sorobanEscrowState(
  contractId: string,
  id: bigint,
  r: SorobanEscrowRecord,
  network: StellarNetworkLike = STELLAR_TESTNET,
): SorobanEscrowState {
  const delivered = r.deliveredAt > 0 && r.receiptHash !== undefined;
  return {
    rail: SOROBAN_ESCROW_RAIL,
    network: stellarNetwork(network).caip2,
    escrowId: formatSorobanEscrowId(contractId, id, network),
    contractId,
    amount: r.amount.toString(),
    asset: r.token,
    token: r.token,
    buyer: r.buyer,
    seller: r.seller,
    ...(r.evaluator ? { evaluator: r.evaluator } : {}),
    reviewWindowSeconds: r.reviewWindowSeconds,
    status: r.status,
    // The contract refunds strictly after deliver_by and releases at delivered_at + window.
    refundableAfter: iso(r.deliverBy),
    ...(delivered
      ? {
          deliveredAt: iso(r.deliveredAt),
          releasableAfter: iso(r.deliveredAt + r.reviewWindowSeconds),
        }
      : {}),
    ...(r.receiptHash ? { receiptHash: r.receiptHash } : {}),
  };
}

/** Turns a simulation/submission failure into an Error naming the contract error, if any. */
export function describeContractError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  const m = /Error\(Contract, #(\d+)\)/.exec(text);
  if (!m) return err instanceof Error ? err : new Error(text);
  const name = SOROBAN_ESCROW_ERRORS[Number(m[1])] ?? `#${m[1]}`;
  return new Error(`ReceptumEscrow rejected the call: ${name}`, { cause: err });
}

// ─── RPC ───────────────────────────────────────────────────────────────────

export interface SorobanRpcOptions extends StellarNetworkOptions {
  /**
   * Defaults to the network's Soroban RPC (testnet: SDF's; pubnet: a community endpoint — pass your
   * own). The RPC's network passphrase is checked before every call.
   */
  rpcUrl?: string;
}

/**
 * Builds, simulates, signs, submits and confirms Soroban invocations — on testnet by default.
 * On pubnet, `invoke` throws `MainnetNotAllowedError` before signing unless mainnet use is allowed.
 */
export class SorobanRpcClient {
  readonly server: rpc.Server;
  readonly network: StellarNetwork;
  private readonly allowMainnet: boolean | undefined;
  private checked: Promise<void> | undefined;

  constructor(options: SorobanRpcOptions = {}) {
    this.network = stellarNetwork(options.network);
    const url = options.rpcUrl ?? this.network.sorobanRpcUrl;
    assertEndpointMatches(url, this.network);
    this.server = new rpc.Server(url, { allowHttp: url.startsWith("http://localhost") });
    this.allowMainnet = options.allowMainnet;
  }

  /**
   * Refuses any RPC whose passphrase isn't this client's network. Read-only calls reuse the first
   * answer; `fresh` (used before every signature) asks the RPC again.
   */
  assertNetwork(fresh = false): Promise<void> {
    if (fresh) this.checked = undefined;
    this.checked ??= this.server.getNetwork().then((n) => {
      if (n.passphrase !== this.network.networkPassphrase) {
        this.checked = undefined;
        throw new Error(
          `refusing RPC on "${n.passphrase}": this client is configured for ${this.network.caip2}`,
        );
      }
    });
    return this.checked;
  }

  /** @deprecated Use `assertNetwork()`; kept for callers of 0.2 (checks the configured network). */
  assertTestnet(): Promise<void> {
    return this.assertNetwork();
  }

  /**
   * Submits one host-function operation from `signer`'s account. Simulation fills in the
   * footprint, fees and (source-account) authorization; the signer must be the account whose
   * authorization the call needs.
   */
  async invoke(
    signer: StellarSigner,
    operation: xdr.Operation,
  ): Promise<{ hash: string; returnValue?: xdr.ScVal; ledger: number }> {
    assertStellarSigningAllowed(this.network, this.allowMainnet);
    await this.assertNetwork(true);
    const account = await this.server.getAccount(signer.publicKey);
    const draft = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(120)
      .build();
    let tx;
    try {
      tx = await this.server.prepareTransaction(draft);
    } catch (err) {
      throw describeContractError(err);
    }
    await signer.sign(tx);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER")
      throw Object.assign(new Error(`Soroban transaction not accepted: ${sent.status}`), {
        hash: sent.hash,
      });
    const res = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw Object.assign(new Error(`Soroban transaction ${sent.hash} ${res.status}`), {
        hash: sent.hash,
      });
    }
    return {
      hash: sent.hash,
      ledger: res.ledger,
      ...(res.returnValue ? { returnValue: res.returnValue } : {}),
    };
  }

  /**
   * SHA-256 (hex) of the wasm a contract runs, or null for non-wasm (e.g. asset) contracts.
   * Throws `contract <id> not found` when the contract has no instance entry.
   */
  async contractWasmHash(contractId: string): Promise<string | null> {
    await this.assertNetwork();
    let instance;
    try {
      instance = await this.server.getContractInstance(contractId);
    } catch (err) {
      // No instance entry: the contract does not exist (verifiers fail it, like missing EVM code).
      if ((err as { code?: number })?.code === 404)
        throw new Error(`contract ${contractId} not found`, { cause: err });
      throw err;
    }
    const exe = instance.executable as unknown as {
      type: string;
      wasmHash?: { value: Uint8Array } | Uint8Array;
    };
    if (exe.type !== "contractExecutableWasm" || !exe.wasmHash) return null;
    const bytes = exe.wasmHash instanceof Uint8Array ? exe.wasmHash : exe.wasmHash.value;
    return Buffer.from(bytes).toString("hex");
  }

  /** Reads escrow `id` straight from contract storage (no account or simulation needed). */
  async readEscrow(contractId: string, id: bigint): Promise<SorobanEscrowRecord> {
    await this.assertNetwork();
    let entry;
    try {
      entry = await this.server.getContractData(
        contractId,
        escrowStorageKey(id),
        rpc.Durability.Persistent,
      );
    } catch (err) {
      if ((err as { code?: number })?.code === 404)
        throw new Error(`unknown escrow ${id} on ${contractId}`, { cause: err });
      throw err;
    }
    const data = entry.val as unknown as { type: string; contractData?: { val: xdr.ScVal } };
    if (data.type !== "contractData" || !data.contractData) throw new Error("unexpected entry");
    return decodeEscrowRecord(data.contractData.val);
  }
}

// ─── Rail ──────────────────────────────────────────────────────────────────

export interface SorobanEscrowOptions extends SorobanRpcOptions {
  /** The deployed ReceptumEscrow contract (C…). */
  contractId: string;
  /** The account acting through this instance (buyer, seller, evaluator, or anyone). */
  signer?: StellarSigner;
  /** Asset for escrows opened by this instance: `native`, `CODE:ISSUER` or a token `C…`. Default: the network's Circle USDC. */
  asset?: string;
}

export interface OpenSorobanEscrowParams {
  /** Seller's G… address. */
  seller: string;
  /** Amount in the token's smallest unit (7 decimals for Stellar assets). */
  amount: string;
  /** Delivery deadline; anyone can refund the buyer after it if nothing was delivered. */
  deliverBy: Date;
  /** Seconds after delivery during which the buyer (or evaluator) may reject. */
  reviewWindowSeconds: number;
  /** Optional third party who may accept or reject in addition to the buyer. */
  evaluator?: string;
}

export type OpenedSorobanEscrow = SorobanEscrowState & { reference: string };

/**
 * `EscrowRail` on the Soroban ReceptumEscrow contract: the same hybrid state machine as the EVM
 * escrow (review window from delivery, optional evaluator, delivery-conditional refunds).
 * Unaudited: testnet by default; pubnet only with the explicit mainnet opt-in (and, for real funds,
 * only after an independent audit — docs/MAINNET.md §0).
 */
export class SorobanEscrowRail implements EscrowRail {
  readonly id = SOROBAN_ESCROW_RAIL;
  readonly network: string;
  readonly capabilities = SOROBAN_ESCROW_CAPABILITIES;
  readonly rpc: SorobanRpcClient;
  readonly contractId: string;
  private readonly signer: StellarSigner | undefined;
  private readonly token: string;

  constructor(options: SorobanEscrowOptions) {
    if (!StrKey.isValidContract(options.contractId))
      throw new TypeError(`invalid contract id ${options.contractId}`);
    this.contractId = options.contractId;
    this.rpc = new SorobanRpcClient(options);
    this.network = this.rpc.network.caip2;
    this.signer = options.signer;
    this.token = tokenContractId(
      options.asset ?? `USDC:${this.rpc.network.usdcIssuer}`,
      this.rpc.network,
    );
  }

  private get contract() {
    return new Contract(this.contractId);
  }

  private requireSigner(): StellarSigner {
    if (!this.signer) throw new Error("this SorobanEscrowRail has no signer");
    return this.signer;
  }

  private idOf(escrowId: string): bigint {
    const { contractId, id, network } = parseSorobanEscrowId(escrowId);
    if (network !== this.network)
      throw new Error(`escrow ${escrowId} is on ${network}, rail is on ${this.network}`);
    if (contractId !== this.contractId)
      throw new Error(`escrow ${escrowId} belongs to another contract`);
    return id;
  }

  private async call(method: string, ...args: xdr.ScVal[]) {
    const signer = this.requireSigner();
    return this.rpc.invoke(signer, this.contract.call(method, ...args));
  }

  /** Buyer (the signer): locks `amount` in the contract. */
  async open(p: OpenSorobanEscrowParams): Promise<OpenedSorobanEscrow> {
    const buyer = this.requireSigner().publicKey;
    if (!/^[1-9][0-9]*$/.test(p.amount)) throw new TypeError("amount must be a positive integer");
    const window = p.reviewWindowSeconds;
    if (!Number.isSafeInteger(window) || window < 0 || window > 0xffff_ffff)
      throw new TypeError("reviewWindowSeconds must be a u32");
    const deliverBy = Math.floor(p.deliverBy.getTime() / 1000);
    const res = await this.call(
      "open",
      new Address(buyer).toScVal(),
      new Address(p.seller).toScVal(),
      new Address(this.token).toScVal(),
      nativeToScVal(BigInt(p.amount), { type: "i128" }),
      nativeToScVal(BigInt(deliverBy), { type: "u64" }),
      nativeToScVal(window, { type: "u32" }),
      p.evaluator ? new Address(p.evaluator).toScVal() : xdr.ScVal.scvVoid(),
    );
    if (!res.returnValue) throw new Error(`open ${res.hash} returned no escrow id`);
    const id = scValToNative(res.returnValue) as bigint;
    const state = await this.getEscrow(
      formatSorobanEscrowId(this.contractId, id, this.rpc.network),
    );
    return { ...state, reference: res.hash };
  }

  /** Reads the escrow from contract storage (needs no key). */
  async getEscrow(escrowId: string): Promise<SorobanEscrowState> {
    const id = this.idOf(escrowId);
    return sorobanEscrowState(
      this.contractId,
      id,
      await this.rpc.readEscrow(this.contractId, id),
      this.rpc.network,
    );
  }

  /** Seller: commits `receiptHash` (by the deadline). Starts the review window. */
  async deliver(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }> {
    if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be 64 lower-case hex");
    const id = this.idOf(escrowId);
    const res = await this.call(
      "deliver",
      nativeToScVal(id, { type: "u64" }),
      xdr.ScVal.scvBytes(Buffer.from(receiptHash, "hex")),
    );
    return { reference: res.hash };
  }

  /** Buyer or evaluator (the signer): accepts the delivery; the seller is paid. */
  async accept(escrowId: string): Promise<{ reference: string }> {
    return this.judge("accept", escrowId);
  }

  /** Buyer or evaluator (the signer): rejects within the review window; the buyer is refunded. */
  async reject(escrowId: string): Promise<{ reference: string }> {
    return this.judge("reject", escrowId);
  }

  /** Anyone: releases a delivered escrow to the seller once the review window has passed. */
  async release(escrowId: string): Promise<{ reference: string }> {
    const res = await this.call("release", nativeToScVal(this.idOf(escrowId), { type: "u64" }));
    return { reference: res.hash };
  }

  /** Anyone: refunds the buyer after a missed delivery deadline. */
  async refund(escrowId: string): Promise<{ reference: string }> {
    const res = await this.call("refund", nativeToScVal(this.idOf(escrowId), { type: "u64" }));
    return { reference: res.hash };
  }

  /** Seller: returns the funds to the buyer at any time before release. */
  async sellerRefund(escrowId: string): Promise<{ reference: string }> {
    const res = await this.call(
      "seller_refund",
      nativeToScVal(this.idOf(escrowId), { type: "u64" }),
    );
    return { reference: res.hash };
  }

  private async judge(method: "accept" | "reject", escrowId: string) {
    const by = this.requireSigner().publicKey;
    const res = await this.call(
      method,
      nativeToScVal(this.idOf(escrowId), { type: "u64" }),
      new Address(by).toScVal(),
    );
    return { reference: res.hash };
  }
}
