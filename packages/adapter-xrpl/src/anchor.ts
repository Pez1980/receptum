import { isSha256Hex, type Anchor, type AnchorRecord, type Sha256Hex } from "@receptum/core";
import type { Client, Wallet } from "xrpl";
import { parseReceiptMemos, receiptMemos } from "./encoding.js";
import { accountTxs, getTx, submit, XRPL_TESTNET, type LedgerTx } from "./ledger.js";

export const XRPL_ANCHOR_RAIL = "anchor:xrpl";

export interface XrplAnchorOptions {
  /** A connected xrpl.js client. */
  client: Client;
  /** Signs anchor transactions. Not needed for `find`. */
  wallet?: Wallet;
  /** CAIP-2 id of the network the client is connected to. Default `xrpl:1` (testnet). */
  network?: string;
  /** Account whose history `find` scans when no reference is given. Defaults to the wallet. */
  account?: string;
  /** account_tx pages (200 txs each) scanned by `find` without a reference. Default 10. */
  maxHistoryPages?: number;
}

/**
 * Anchors receipt hashes as SPEC §7 memos on a no-op AccountSet from the
 * anchoring account — no funds move and no counterparty is involved.
 */
export class XrplAnchor implements Anchor {
  readonly id = XRPL_ANCHOR_RAIL;
  readonly network: string;

  constructor(private readonly opts: XrplAnchorOptions) {
    this.network = opts.network ?? XRPL_TESTNET;
  }

  async anchor(receiptHash: Sha256Hex): Promise<AnchorRecord> {
    if (!isSha256Hex(receiptHash)) throw new TypeError("receiptHash must be hex64");
    const wallet = this.opts.wallet;
    if (!wallet) throw new Error("anchor needs a wallet");
    const tx = await submit(this.opts.client, wallet, {
      TransactionType: "AccountSet",
      Account: wallet.address,
      Memos: receiptMemos(receiptHash),
    });
    return this.record(receiptHash, tx);
  }

  /**
   * Finds the anchor of `receiptHash`: at `hint.reference` (a tx hash) when given,
   * otherwise in the recent history of the anchoring account.
   */
  async find(receiptHash: Sha256Hex, hint?: { reference?: string }): Promise<AnchorRecord | null> {
    if (!isSha256Hex(receiptHash)) return null;
    if (hint?.reference) {
      const tx = await getTx(this.opts.client, hint.reference);
      return tx && parseReceiptMemos(tx.tx.Memos).receiptHash === receiptHash
        ? this.record(receiptHash, tx)
        : null;
    }
    const account = this.opts.account ?? this.opts.wallet?.address;
    if (!account) return null;
    for await (const tx of accountTxs(this.opts.client, account, this.opts.maxHistoryPages ?? 10)) {
      if (tx.tx.Account === account && parseReceiptMemos(tx.tx.Memos).receiptHash === receiptHash) {
        return this.record(receiptHash, tx);
      }
    }
    return null;
  }

  private record(receiptHash: Sha256Hex, tx: LedgerTx): AnchorRecord {
    return {
      rail: this.id,
      network: this.network,
      receiptHash,
      reference: tx.hash,
      anchoredAt: tx.closeTime ?? new Date().toISOString(),
    };
  }
}
