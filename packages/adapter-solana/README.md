# @receptum/adapter-solana

Solana rail for Receptum: the **`receptum_escrow` program** (`escrow:receptum-solana`), **x402 `exact`** settlement checks, **SPL Memo anchors** (`anchor:solana`) and **account bindings** for `solana:` payout wallets.

**Status:** devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, the default) — see [E2E_RESULTS.md](./E2E_RESULTS.md). Not audited. Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) only behind the explicit opt-in (`allowMainnet: true` or `RECEPTUM_ALLOW_MAINNET=1`); every signing path refuses before signing otherwise. Before **every** signature the adapter asks the RPC for its genesis hash, maps it to the CAIP-2 network, requires that to equal the declared network and then applies the opt-in to it (`assertRpcNetwork`; `sendAndConfirm` takes `{ network, allowMainnet }`), so an `rpc` / `rpcUrl` override pointing at mainnet can't slip past a devnet declaration.

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

Native Rust (`program/`, `solana-program` 4.0, no Anchor), built with Agave 4.3.0 `cargo-build-sbf` (platform-tools v1.57); `Cargo.lock` is committed. **The canonical build is the Linux x86_64 one**: CI (job `solana-program`, `ubuntu-latest`) rebuilds the program with the pinned toolchain on every push and fails unless the result is byte-identical to the committed `program/receptum_escrow.so`. Linux builds are deterministic; macOS arm64 builds are not the same bytes (platform-tools codegen differs by host), so never commit or deploy a locally built `.so` from a Mac. The build hashes to `b270e9844502f115ffcb41e260a23fe5487d2917dd0842c43c742895bf1467c3` (SHA-256 with trailing zeros removed — what `solana-verify get-executable-hash` prints). It is deployed on devnet at [`2neqpNegEPy9zYppnbMtksNdoXLE9XDesAbBEqKUqTsg`](https://explorer.solana.com/address/2neqpNegEPy9zYppnbMtksNdoXLE9XDesAbBEqKUqTsg?cluster=devnet) (deploy transaction [`5HiZfyuW…`](https://explorer.solana.com/tx/5HiZfyuWEUKBVXdPv35wmWsMVfVnZpEqcjCysvVNwrGZmH9bs5LrFr6vBkeHgn1dMtuPhwcupJs6VPfcFzLkJdLk?cluster=devnet)) with `--final`: **no upgrade authority**, no admin, no fee. `scripts/deploy-devnet.mjs` refuses any `.so` whose hash differs from the published one.

> **Superseded deployments.** `4iUzsYkrzcUdc3aFsgXg5aocHWShMjQ3dCNSyg6dwgYC` (build `e20b63d3…`, 4 Oct 2026) is the same source built on macOS arm64; CI on Linux can't reproduce it, so it was replaced by the CI build above. It is no longer in `TRUSTED_ESCROWS`, its build no longer verifies, and its receipts were replaced. The first devnet deployment, `6VdZ7E96YbZig648NFQ9sHwKTHQtY7cntYU1mZmv77wv` (build `b3964928…`), required the vault to hold exactly `amount` at payout, so anyone could lock an escrow forever by sending 1 token unit to its vault (review round 4, HIGH). Being immutable, it can't be fixed in place: it is no longer in `TRUSTED_ESCROWS`, its build no longer verifies, and its receipts were replaced. Don't open escrows on it.

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

- **Funds only move to the escrow's own buyer or seller**: payouts go to a token account the program checks is owned by that party (the rail creates the associated token account if needed).
- **Payouts move the whole vault** (at least `amount`, plus anything anyone sent to the vault) and close it, so a donation to a vault can never lock an escrow; it simply goes to the recipient the escrow's state machine picks. A vault below `amount` (impossible with the classic Token program) is refused.
- Classic SPL Token only — Token-2022 is refused (transfer fees and hooks would break the exact-amount invariant at deposit). The vault balance is re-read after the deposit and must equal `amount`.
- Checked arithmetic (`deliver_by + window`, `delivered_at + window`), `overflow-checks = true`; the evaluator must differ from buyer and seller; the receipt hash cannot be zero; delivery happens once.
- `open` works even if someone pre-funds the escrow address (transfer + allocate + assign rather than `CreateAccount`). The escrow id is chosen by the buyer (random by default).
- Errors (custom codes, numbered like the Soroban escrow): 1 BadState, 2 NotAllowed, 3 TooEarly, 4 TooLate, 5 InvalidArgs, 6 UnsupportedToken, 7 NotFound, 8 Overflow.

Tests: `src/program.test.ts` runs the published `.so` in [LiteSVM](https://github.com/LiteSVM/litesvm) with the real SPL Token and ATA programs — every flow plus negative cases (wrong signer, double delivery, early/late calls, wrong token program, foreign payout account, wrong rent recipient, fake escrow accounts, pre-funded address, overflow) and vault donations on every settlement path (accept, reject, release, refund, sellerRefund). `scripts/e2e-local.mjs` runs the rail, anchor and verifier against a local `solana-test-validator`; `scripts/e2e-devnet.mjs` runs flows A–F on devnet; `scripts/deploy-devnet.mjs` deploys and records `program/deployment.devnet.json`; `scripts/deploy-mainnet.test.mjs` covers every refusal of the mainnet deploy script with a mocked RPC and CLI.

## x402 `exact` on Solana

The public facilitator (`https://x402.org/facilitator`) advertises `exact` on `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` and co-signs as fee payer. Use `@x402/svm` (2.28) with `@receptum/server` / `@receptum/client`; the receipt records the mint as `payment.asset`, base units as `payment.amount`, the settlement signature as `payment.reference` and the `payTo` **wallet** (not its token account) as `payment.payee`. `findTokenTransfer` implements the SPEC §7.3 check (a `transferChecked` of exactly the amount, owners from the transaction's token balances, and the payee's net balance change). The payee's USDC associated token account must exist before the first payment. See [examples/x402-solana](../../examples/x402-solana).

## Account bindings

`accountProof = { type: "solana", signature }`: Ed25519 by the wallet key over `SHA-256("Solana Signed Message:\n" ‖ JCS(statement))`, base64 — the SEP-53 construction with a Solana prefix (defined by RRF). Verified offline against the address (`solanaBindingVerifier`, registered in `@receptum/verify`).

## Mainnet

`SOLANA_MAINNET`, `MAINNET_USDC_MINT` and the mainnet RPC are defined, but nothing is deployed and `TRUSTED_ESCROWS` has no mainnet program. See [docs/MAINNET.md](../../docs/MAINNET.md).

`scripts/deploy-mainnet.mjs` deploys the program to mainnet-beta once the independent audit is published, with the same guard rails as the EVM and Soroban mainnet scripts:

```sh
RECEPTUM_ALLOW_MAINNET=1 RECEPTUM_MAINNET_DEPLOYER_KEYPAIR=/abs/path/fresh-mainnet-deployer.json \
  node packages/adapter-solana/scripts/deploy-mainnet.mjs --audit-report https://… [--so <ci-artifact.so>] [--rpc <url>] --dry-run
```

It refuses without `RECEPTUM_ALLOW_MAINNET=1` or an `https` audit report; takes the deployer keypair only from the path in `RECEPTUM_MAINNET_DEPLOYER_KEYPAIR` (read by the Agave CLI, never by the script; testnet wallet directories, `~/.config/solana` and devnet/testnet-named files are refused); requires the RPC's genesis hash to be mainnet-beta's (`5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`); refuses a `.so` that isn't the canonical CI build (`b270e984…1467c3`; use the CI artifact `receptum_escrow-ci-build`, never a macOS build); prints the plan (network, deployer, balance, program size, estimated rent and fees, hash) and refuses an underfunded deployer; and needs the typed phrase `deploy receptum_escrow to solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` on a terminal (`--dry-run` stops after the plan). It deploys with `--final`, then checks the on-chain ProgramData hash and that there is no upgrade authority before writing `deployment.mainnet.json`. Raw CLI output is never printed. Tests: `scripts/deploy-mainnet.test.mjs` (mocked RPC and CLI).
