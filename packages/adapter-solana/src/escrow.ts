import { randomBytes } from "node:crypto";
import type {
  EscrowCapabilities,
  EscrowRail,
  EscrowState,
  EscrowStatus,
  Sha256Hex,
} from "@receptum/core";
import { isSolanaAddress } from "./base58.js";
import { SOLANA_DEVNET } from "./network.js";
import {
  createAtaIdempotentInstruction,
  decodeEscrowAccount,
  deliverInstruction,
  escrowAddress,
  formatSolanaEscrowId,
  openInstruction,
  parseSolanaEscrowId,
  payoutInstruction,
  RECEPTUM_SOLANA_PROGRAM_ID,
  SOLANA_ESCROW_RAIL,
  type PayoutKind,
  type SolanaEscrowAccount,
} from "./program.js";
import { getAccount, rpcFor, type SolanaRpc } from "./rpc.js";
import {
  assertRpcNetwork,
  sendAndConfirm,
  type SolanaKeypair,
  type TransactionInstruction,
} from "./transaction.js";

/** Same hybrid machine as `escrow:receptum-evm` / `escrow:receptum-soroban` (SPEC §7.4). */
export const SOLANA_ESCROW_CAPABILITIES: EscrowCapabilities = {
  acceptanceModes: ["buyer", "evaluator", "auto"],
  reviewWindowFromDelivery: true,
  refundAfterDelivery: true,
};

export interface SolanaEscrowRailOptions {
  /**
   * CAIP-2 network. Default devnet; mainnet needs `allowMainnet` before anything is signed. Before
   * every signature the RPC (default, `rpc` or `rpcUrl`) must report this cluster's genesis hash.
   */
  network?: string;
  rpc?: SolanaRpc;
  rpcUrl?: string;
  programId?: string;
  /** Pays fees and signs as buyer, seller, evaluator or bystander, depending on the call. */
  signer?: SolanaKeypair;
  allowMainnet?: boolean;
}

export interface OpenEscrowParams {
  seller: string;
  /** SPL Token mint (classic Token program), e.g. devnet USDC. */
  mint: string;
  /** Token base units. */
  amount: string | bigint;
  deliverBy: Date;
  reviewWindowSeconds: number;
  evaluator?: string;
  /** Escrow id (u64). Default: random. */
  id?: bigint;
}

export interface SolanaEscrowState extends EscrowState {
  solana: SolanaEscrowAccount & { escrow: string; programId: string };
}

const toCore = (s: SolanaEscrowAccount["status"]): EscrowStatus => s;

/**
 * `escrow:receptum-solana` — the `receptum_escrow` program. escrowId (also the receipt's
 * `payment.reference`) is `<caip2>:<programId>:<escrow account>`.
 */
export class SolanaEscrowRail implements EscrowRail {
  readonly id = SOLANA_ESCROW_RAIL;
  readonly network: string;
  readonly programId: string;
  readonly rpc: SolanaRpc;

  constructor(private readonly opts: SolanaEscrowRailOptions = {}) {
    this.network = opts.network ?? SOLANA_DEVNET;
    this.programId = opts.programId ?? RECEPTUM_SOLANA_PROGRAM_ID;
    this.rpc = opts.rpc ?? rpcFor(this.network, opts.rpcUrl);
  }

  private get allow() {
    return this.opts.allowMainnet !== undefined ? { allowMainnet: this.opts.allowMainnet } : {};
  }

  /** The signer, once the RPC is verified to serve `network` and the opt-in allows it. */
  private async signer(): Promise<SolanaKeypair> {
    const s = this.opts.signer;
    if (!s) throw new Error("this call needs a signer");
    await assertRpcNetwork(this.rpc, this.network, this.opts.allowMainnet);
    return s;
  }

  /** Signs and sends; `sendAndConfirm` re-checks the RPC's network before the signature. */
  private send(signer: SolanaKeypair, ixs: TransactionInstruction[]) {
    return sendAndConfirm(this.rpc, signer, ixs, { network: this.network, ...this.allow });
  }

  private parse(escrowId: string) {
    const p = parseSolanaEscrowId(escrowId);
    if (p.network !== this.network)
      throw new Error(`escrow is on ${p.network}, rail is ${this.network}`);
    if (p.programId !== this.programId) throw new Error(`escrow belongs to program ${p.programId}`);
    return p;
  }

  /** Buyer (the signer) locks `amount` of `mint` for `seller`. */
  async open(params: OpenEscrowParams): Promise<{ escrowId: string; reference: string }> {
    const buyer = await this.signer();
    if (!isSolanaAddress(params.seller) || !isSolanaAddress(params.mint))
      throw new TypeError("seller and mint must be Solana addresses");
    if (params.evaluator !== undefined && !isSolanaAddress(params.evaluator))
      throw new TypeError("evaluator must be a Solana address");
    const id = params.id ?? randomBytes(8).readBigUInt64LE();
    const ix = openInstruction({
      buyer: buyer.address,
      seller: params.seller,
      mint: params.mint,
      amount: BigInt(params.amount),
      deliverBy: Math.floor(params.deliverBy.getTime() / 1000),
      reviewWindowSeconds: params.reviewWindowSeconds,
      evaluator: params.evaluator ?? null,
      id,
      programId: this.programId,
    });
    const { signature } = await this.send(buyer, [ix]);
    const escrow = escrowAddress(buyer.address, id, this.programId).address;
    return {
      escrowId: formatSolanaEscrowId(this.network, this.programId, escrow),
      reference: signature,
    };
  }

  async getEscrow(escrowId: string): Promise<SolanaEscrowState> {
    const { escrow } = this.parse(escrowId);
    const acc = await getAccount(this.rpc, escrow);
    if (!acc) throw new Error(`escrow ${escrowId} not found`);
    if (acc.owner !== this.programId) throw new Error(`escrow ${escrowId} not found`);
    const e = decodeEscrowAccount(acc.data);
    return {
      rail: SOLANA_ESCROW_RAIL,
      network: this.network,
      escrowId,
      amount: e.amount.toString(),
      asset: e.mint,
      buyer: `${this.network}:${e.buyer}`,
      seller: `${this.network}:${e.seller}`,
      refundableAfter: new Date(e.deliverBy * 1000).toISOString(),
      status: toCore(e.status),
      ...(e.receiptHash ? { receiptHash: e.receiptHash } : {}),
      ...(e.status !== "open"
        ? {
            releasableAfter: new Date((e.deliveredAt + e.reviewWindowSeconds) * 1000).toISOString(),
          }
        : {}),
      solana: { ...e, escrow, programId: this.programId },
    };
  }

  /** Seller (the signer) commits `receiptHash`. */
  async deliver(escrowId: string, receiptHash: Sha256Hex): Promise<{ reference: string }> {
    const { escrow } = this.parse(escrowId);
    const seller = await this.signer();
    const { signature } = await this.send(seller, [
      deliverInstruction(escrow, seller.address, receiptHash, this.programId),
    ]);
    return { reference: signature };
  }

  private async payout(escrowId: string, kind: PayoutKind): Promise<{ reference: string }> {
    this.parse(escrowId);
    const signer = await this.signer();
    const state = await this.getEscrow(escrowId);
    const e = state.solana;
    const toSeller = kind === "accept" || kind === "release";
    const { signature } = await this.send(signer, [
      // The payout goes to the recipient's associated token account; create it if needed.
      createAtaIdempotentInstruction(signer.address, toSeller ? e.seller : e.buyer, e.mint),
      payoutInstruction(kind, e.escrow, e, signer.address, this.programId),
    ]);
    return { reference: signature };
  }

  /** Buyer or evaluator (the signer) accepts: the seller is paid. */
  accept(escrowId: string) {
    return this.payout(escrowId, "accept");
  }
  /** Buyer or evaluator (the signer) rejects within the review window: the buyer is refunded. */
  reject(escrowId: string) {
    return this.payout(escrowId, "reject");
  }
  /** Anyone, once the review window after delivery has passed: the seller is paid. */
  release(escrowId: string) {
    return this.payout(escrowId, "release");
  }
  /** Anyone, after the deadline when nothing was delivered: the buyer is refunded. */
  refund(escrowId: string) {
    return this.payout(escrowId, "refund");
  }
  /** Seller (the signer) returns the funds to the buyer before settlement. */
  sellerRefund(escrowId: string) {
    return this.payout(escrowId, "sellerRefund");
  }
}
