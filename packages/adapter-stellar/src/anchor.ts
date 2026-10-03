import { Operation } from "@stellar/stellar-sdk";
import type { Anchor, AnchorRecord, Sha256Hex } from "@receptum/core";
import { receiptHashFromBase64, receiptMemo } from "./codec.js";
import { HorizonClient, isNotFound, type HorizonOptions } from "./horizon.js";
import { STELLAR_ANCHOR_RAIL, STELLAR_TESTNET } from "./network.js";
import type { StellarSigner } from "./signer.js";

export interface StellarAnchorOptions extends HorizonOptions {
  /** Signs anchor transactions. Optional for a read-only (verify) anchor. */
  signer?: StellarSigner;
  /**
   * Account whose transactions count as anchors. Defaults to the signer's
   * account. `find` ignores transactions from any other source account.
   */
  account?: string;
  /** How many recent transactions `find` scans when no reference is given. Default 200. */
  maxScan?: number;
}

/** Horizon transaction fields this adapter reads. */
export interface AnchorTxLike {
  hash: string;
  successful: boolean;
  source_account: string;
  memo_type: string;
  memo?: string;
  created_at: string;
}

/** Pure check: is `tx` a successful MEMO_HASH anchor of `receiptHash` (from `account`, if set)? */
export function matchAnchor(
  tx: AnchorTxLike,
  receiptHash: Sha256Hex,
  account?: string,
): AnchorRecord | null {
  if (!tx.successful || tx.memo_type !== "hash") return null;
  if (account && tx.source_account !== account) return null;
  if (receiptHashFromBase64(tx.memo) !== receiptHash) return null;
  return {
    rail: STELLAR_ANCHOR_RAIL,
    network: STELLAR_TESTNET.caip2,
    receiptHash,
    reference: tx.hash,
    anchoredAt: new Date(tx.created_at).toISOString(),
  };
}

/**
 * `Anchor` on Stellar: a transaction with `MEMO_HASH = receiptHash` (SPEC §7).
 * The transaction's only operation is a no-op `BumpSequence`, so anchoring
 * costs one base fee and changes no balances.
 */
export class StellarAnchor implements Anchor {
  readonly id = STELLAR_ANCHOR_RAIL;
  private readonly horizon: HorizonClient;
  private readonly signer: StellarSigner | undefined;
  private readonly account: string | undefined;
  private readonly maxScan: number;

  constructor(options: StellarAnchorOptions = {}) {
    this.horizon = new HorizonClient(options);
    this.signer = options.signer;
    this.account = options.account ?? options.signer?.publicKey;
    this.maxScan = options.maxScan ?? 200;
  }

  async anchor(receiptHash: Sha256Hex): Promise<AnchorRecord> {
    if (!this.signer) throw new Error("StellarAnchor needs a signer to anchor");
    // bumpTo 0 is always below the current sequence: a valid no-op.
    const op = Operation.bumpSequence({ bumpTo: "0" });
    const { hash } = await this.horizon.submit(this.signer, [op], receiptMemo(receiptHash));
    const found = await this.find(receiptHash, { reference: hash });
    if (!found) throw new Error(`anchor transaction ${hash} not found after submission`);
    return found;
  }

  /**
   * Finds an anchor of `receiptHash`. With `hint.reference` (a tx hash) it
   * checks that one transaction — this also accepts escrow delivery and release
   * transactions, which carry the same memo. Without a hint it scans the anchor
   * account's most recent transactions.
   */
  async find(receiptHash: Sha256Hex, hint?: { reference?: string }): Promise<AnchorRecord | null> {
    receiptMemo(receiptHash); // validates the hash
    const server = this.horizon.server;
    if (hint?.reference) {
      try {
        const tx = (await server.transactions().transaction(hint.reference).call()) as AnchorTxLike;
        return matchAnchor(tx, receiptHash, this.account);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    }
    if (!this.account) throw new Error("find without a reference needs an anchor account");
    let page = await server.transactions().forAccount(this.account).order("desc").limit(100).call();
    let scanned = 0;
    while (page.records.length > 0 && scanned < this.maxScan) {
      for (const tx of page.records as unknown as AnchorTxLike[]) {
        const hit = matchAnchor(tx, receiptHash, this.account);
        if (hit) return hit;
      }
      scanned += page.records.length;
      page = await page.next();
    }
    return null;
  }
}
