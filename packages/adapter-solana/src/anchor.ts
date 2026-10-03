import { isSha256Hex, type Anchor, type AnchorRecord, type Sha256Hex } from "@receptum/core";
import { MEMO_PROGRAM_ID } from "./address.js";
import { assertSolanaNetwork, SOLANA_DEVNET } from "./network.js";
import { getParsedTransaction, rpcFor, type ParsedTransaction, type SolanaRpc } from "./rpc.js";
import { sendAndConfirm, type SolanaKeypair, type TransactionInstruction } from "./transaction.js";

export const SOLANA_ANCHOR_RAIL = "anchor:solana";
/** Memo prefix of a receipt anchor (SPEC §7.1): `receptum/1:` followed by the receiptHash. */
export const ANCHOR_MEMO_PREFIX = "receptum/1:";

/** The exact memo text that anchors `receiptHash`. */
export function anchorMemo(receiptHash: Sha256Hex): string {
  if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be hex64");
  return ANCHOR_MEMO_PREFIX + receiptHash;
}

/** An SPL Memo v2 instruction carrying `text`, with `signer` as its (required) signer. */
export function memoInstruction(text: string, signer: string): TransactionInstruction {
  return {
    programId: MEMO_PROGRAM_ID,
    accounts: [{ address: signer, signer: true, writable: false }],
    data: new TextEncoder().encode(text),
  };
}

/**
 * The memo texts of the top-level SPL Memo v2 instructions of a jsonParsed transaction, in order.
 * (jsonParsed renders a memo instruction's data as the UTF-8 string in `parsed`.)
 */
export function topLevelMemos(tx: ParsedTransaction): string[] {
  return tx.transaction.message.instructions
    .filter((ix) => ix.programId === MEMO_PROGRAM_ID && typeof ix.parsed === "string")
    .map((ix) => ix.parsed as string);
}

/** True when the successful transaction carries the anchor memo for `receiptHash`. */
export function txAnchors(tx: ParsedTransaction, receiptHash: Sha256Hex): boolean {
  if (!tx.meta || tx.meta.err !== null) return false;
  return topLevelMemos(tx).includes(anchorMemo(receiptHash));
}

export interface SolanaAnchorOptions {
  /** CAIP-2 network. Default devnet; mainnet needs `allowMainnet`. */
  network?: string;
  /** JSON-RPC transport; defaults to the public endpoint for `network`. */
  rpc?: SolanaRpc;
  rpcUrl?: string;
  /** Pays for and signs anchor transactions. Not needed for `find`. */
  signer?: SolanaKeypair;
  allowMainnet?: boolean;
}

/**
 * Anchors receipt hashes as an SPL Memo `receptum/1:<receiptHash>` in a transaction from the
 * anchoring account. No funds move. Anyone may anchor any hash (SPEC §7.1).
 */
export class SolanaAnchor implements Anchor {
  readonly id = SOLANA_ANCHOR_RAIL;
  readonly network: string;
  private readonly rpc: SolanaRpc;

  constructor(private readonly opts: SolanaAnchorOptions = {}) {
    this.network = opts.network ?? SOLANA_DEVNET;
    this.rpc = opts.rpc ?? rpcFor(this.network, opts.rpcUrl);
  }

  async anchor(receiptHash: Sha256Hex): Promise<AnchorRecord> {
    const memo = anchorMemo(receiptHash);
    const signer = this.opts.signer;
    if (!signer) throw new Error("anchor needs a signer");
    assertSolanaNetwork(this.network, this.opts.allowMainnet);
    const { signature } = await sendAndConfirm(this.rpc, signer, [
      memoInstruction(memo, signer.address),
    ]);
    return {
      rail: SOLANA_ANCHOR_RAIL,
      network: this.network,
      receiptHash,
      reference: signature,
      anchoredAt: new Date().toISOString(),
    };
  }

  /** Finds the anchor at `hint.reference` (a transaction signature). */
  async find(receiptHash: Sha256Hex, hint?: { reference?: string }): Promise<AnchorRecord | null> {
    if (!isSha256Hex(receiptHash) || !hint?.reference) return null;
    const found = await getParsedTransaction(this.rpc, hint.reference);
    if (!found || !txAnchors(found.tx, receiptHash)) return null;
    return {
      rail: SOLANA_ANCHOR_RAIL,
      network: this.network,
      receiptHash,
      reference: hint.reference,
      anchoredAt: found.tx.blockTime
        ? new Date(found.tx.blockTime * 1000).toISOString()
        : new Date(0).toISOString(),
    };
  }
}
