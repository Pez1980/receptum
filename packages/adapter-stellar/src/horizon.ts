import {
  BASE_FEE,
  Horizon,
  TransactionBuilder,
  type Memo,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, assertTestnetHorizon } from "./network.js";
import type { StellarSigner } from "./signer.js";

export interface HorizonOptions {
  /** Defaults to the public testnet Horizon. Mainnet endpoints are refused. */
  horizonUrl?: string;
  /** Max fee per operation in stroops. Defaults to the network base fee. */
  fee?: string;
}

/** Thin wrapper over Horizon: builds, signs and submits testnet transactions. */
export class HorizonClient {
  readonly server: Horizon.Server;
  private readonly fee: string;

  constructor(options: HorizonOptions = {}) {
    const url = options.horizonUrl ?? STELLAR_TESTNET.horizonUrl;
    assertTestnetHorizon(url);
    this.server = new Horizon.Server(url);
    this.fee = options.fee ?? BASE_FEE;
  }

  /** Builds a transaction from `signer`'s account, signs it and submits it. */
  async submit(
    signer: StellarSigner,
    operations: xdr.Operation[],
    memo?: Memo,
  ): Promise<{ hash: string; tx: Transaction }> {
    const account = await this.server.loadAccount(signer.publicKey);
    const builder = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    });
    for (const op of operations) builder.addOperation(op);
    if (memo) builder.addMemo(memo);
    const tx = builder.setTimeout(120).build();
    await signer.sign(tx);
    try {
      const res = await this.server.submitTransaction(tx);
      return { hash: res.hash, tx };
    } catch (err) {
      throw describeSubmitError(err, Buffer.from(tx.hash()).toString("hex"));
    }
  }
}

/** Turns Horizon's 400 into an Error that carries the result codes and the tx hash. */
export function describeSubmitError(err: unknown, hash?: string): Error & { hash?: string } {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } | undefined;
  const codes = data?.extras?.result_codes;
  if (!codes) return err instanceof Error ? err : new Error(String(err));
  const ops = codes.operations?.length ? ` [${codes.operations.join(", ")}]` : "";
  const error: Error & { hash?: string } = new Error(
    `Stellar transaction failed: ${codes.transaction ?? "unknown"}${ops}`,
    { cause: err },
  );
  if (hash) error.hash = hash;
  return error;
}

export function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 404;
}
