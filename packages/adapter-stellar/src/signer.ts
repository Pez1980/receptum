import type { Keypair, Transaction } from "@stellar/stellar-sdk";

/**
 * Signs Stellar transactions for one account. The adapter never stores keys;
 * integrators inject a signer (a local keypair, a wallet, an HSM, …).
 */
export interface StellarSigner {
  /** G… address of the account this signer controls. */
  readonly publicKey: string;
  /** Adds this account's signature to the transaction in place. */
  sign(tx: Transaction): Promise<void>;
}

/** A signer backed by an in-memory keypair (tests and scripts). */
export function keypairSigner(keypair: Keypair): StellarSigner {
  return {
    publicKey: keypair.publicKey(),
    sign: async (tx) => tx.sign(keypair),
  };
}
