# @receptum/adapter-solana

Solana rail for Receptum: the **`receptum_escrow` program** (`escrow:receptum-solana`), **x402 `exact`** settlement checks, **SPL Memo anchors** (`anchor:solana`) and **account bindings** for `solana:` payout wallets.

**Status:** devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, the default) — see [E2E_RESULTS.md](./E2E_RESULTS.md). Not audited. Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) only behind the explicit opt-in (`allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`); every signing path refuses before signing otherwise.

No `@solana/web3.js` or `@solana/kit` dependency: the adapter builds, signs and sends legacy transactions itself (Ed25519 via `node:crypto`), derives PDAs and associated token accounts, and talks plain JSON-RPC.

```ts
import { readFileSync } from "node:fs";
import { createAccountBinding } from "@receptum/core";
import {
  DEVNET_USDC_MINT,
  SolanaAnchor,
  SolanaEscrowRail,
  solanaAccountSigner,
  solanaKeypair,
} from "@receptum/adapter-solana";

const buyer = solanaKeypair(JSON.parse(readFileSync("buyer.json", "utf8"))); // Solana CLI keypair file
const seller = solanaKeypair(JSON.parse(readFileSync("seller.json", "utf8")));

// Buyer: lock 0.10 devnet USDC for the seller, deliverable within an hour, 10-minute review.
const { escrowId } = await new SolanaEscrowRail({ signer: buyer }).open({
  seller: seller.address,
  mint: DEVNET_USDC_MINT,
  amount: "100000",
  deliverBy: new Date(Date.now() + 3_600_000),
  reviewWindowSeconds: 600,
  // evaluator: evaluatorAddress,   // optional third party who may accept or reject
});

// Seller: commit the receipt hash (escrowId is the receipt's payment.reference).
await new SolanaEscrowRail({ signer: seller }).deliver(escrowId, signed.receiptHash);

// Buyer accepts (seller paid) — or rejects within the window (buyer refunded). After the window
// anyone can `release`; after a missed deadline anyone can `refund`; the seller can `sellerRefund`.
await new SolanaEscrowRail({ signer: buyer }).accept(escrowId);

// Anchor any receipt (e.g. an x402 one) with an SPL Memo:
await new SolanaAnchor({ signer: seller }).anchor(signed.receiptHash);

// Bind the seller's did:key to its Solana payout wallet (SPEC §4.1):
const binding = await createAccountBinding({ key: sellerKey, signer: solanaAccountSigner(seller) });
```

## The `receptum_escrow` program

Native Rust (`program/`, `solana-program` 4.0, no Anchor), built with Agave 4.3.0 `cargo-build-sbf` (platform-tools v1.57); `Cargo.lock` is committed and a clean rebuild is byte-identical. The build `program/receptum_escrow.so` hashes to `b3964928ffc08a5a6266957944d03deb62b206d9dfc356c126dedea229e5d93b` (SHA-256 with trailing zeros removed — what `solana-verify get-executable-hash` prints). It is deployed with `--final`: **no upgrade authority**, no admin, no fee.

```text
open ──deliver (seller, ≤ deliver_by)──▶ delivered ──accept (buyer/evaluator, any time)──▶ released
 │                                          │      ──release (anyone, ≥ delivered_at + window)──▶ released
 │                                          │      ──reject (buyer/evaluator, < delivered_at + window)──▶ refunded
 │                                          └──────seller_refund (seller)──▶ refunded
 ├──refund (anyone, > deliver_by)──▶ refunded
 └──seller_refund (seller)──▶ refunded
```

| Account | Address                                       | Holds                                                                                                        |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| escrow  | PDA `["escrow", buyer, id u64 LE]`            | 272-byte state (SPEC §7.3): parties, evaluator, mint, amount, deadline, review window, delivery, receiptHash |
| vault   | PDA `["vault", escrow]`, an SPL Token account | the deposit, owned by the escrow PDA; closed (rent to the buyer) on payout                                   |

- **Funds only move to the escrow's own buyer or seller**: payouts go to a token account the program checks is owned by that party (the rail creates the associated token account if needed), and the vault must hold exactly `amount`.
- Classic SPL Token only — Token-2022 is refused (transfer fees and hooks would break the exact-amount invariant). The vault balance is re-read after the deposit.
- Checked arithmetic (`deliver_by + window`, `delivered_at + window`), `overflow-checks = true`; the evaluator must differ from buyer and seller; the receipt hash cannot be zero; delivery happens once.
- `open` works even if someone pre-funds the escrow address (transfer + allocate + assign rather than `CreateAccount`). The escrow id is chosen by the buyer (random by default).
- Errors (custom codes, numbered like the Soroban escrow): 1 BadState, 2 NotAllowed, 3 TooEarly, 4 TooLate, 5 InvalidArgs, 6 UnsupportedToken, 7 NotFound, 8 Overflow.

Tests: `src/program.test.ts` runs the published `.so` in [LiteSVM](https://github.com/LiteSVM/litesvm) with the real SPL Token and ATA programs — every flow plus negative cases (wrong signer, double delivery, early/late calls, wrong token program, foreign payout account, wrong rent recipient, fake escrow accounts, pre-funded address, overflow). `scripts/e2e-local.mjs` runs the rail, anchor and verifier against a local `solana-test-validator`; `scripts/e2e-devnet.mjs` runs flows A–F on devnet; `scripts/deploy-devnet.mjs` deploys and records `program/deployment.devnet.json`.

## x402 `exact` on Solana

The public facilitator (`https://x402.org/facilitator`) advertises `exact` on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` and co-signs as fee payer. Use `@x402/svm` (2.28) with `@receptum/server` / `@receptum/client`; the receipt records the mint as `payment.asset`, base units as `payment.amount`, the settlement signature as `payment.reference` and the `payTo` **wallet** (not its token account) as `payment.payee`. `findTokenTransfer` implements the SPEC §7.3 check (a `transferChecked` of exactly the amount, owners from the transaction's token balances, and the payee's net balance change). The payee's USDC associated token account must exist before the first payment. See [examples/x402-solana](../../examples/x402-solana).

## Account bindings

`accountProof = { type: "solana", signature }`: Ed25519 by the wallet key over `SHA-256("Solana Signed Message:\n" ‖ JCS(statement))`, base64 — the SEP-53 construction with a Solana prefix (defined by RRF). Verified offline against the address (`solanaBindingVerifier`, registered in `@receptum/verify`).

## Mainnet

`SOLANA_MAINNET`, `MAINNET_USDC_MINT` and the mainnet RPC are defined, but nothing is deployed and `TRUSTED_ESCROWS` has no mainnet program. See [docs/MAINNET.md](../../docs/MAINNET.md).
