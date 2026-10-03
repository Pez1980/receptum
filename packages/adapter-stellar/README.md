# @receptum/adapter-stellar

Stellar rail for Receptum: escrow on native **claimable balances** and receipt anchoring with
`MEMO_HASH` (SPEC §7). No smart contract is involved.

**Status:** testnet only (`stellar:testnet`). Every transaction is signed with the testnet
passphrase, and the mainnet Horizon is refused. Mainnet waits for the escrow audit (roadmap M5).
A real end-to-end run is recorded in [E2E_RESULTS.md](./E2E_RESULTS.md).

```ts
import { Keypair } from "@stellar/stellar-sdk";
import {
  StellarClaimableEscrowRail,
  StellarAnchor,
  keypairSigner,
  TESTNET_USDC,
} from "@receptum/adapter-stellar";

const buyerRail = new StellarClaimableEscrowRail({
  signer: keypairSigner(buyerKp),
  asset: TESTNET_USDC,
});
const escrow = await buyerRail.open({
  seller: sellerAddress,
  amount: "10000000", // 1 USDC: 7 decimals
  deadline: new Date(Date.now() + 3_600_000),
  reviewWindowSeconds: 86_400,
});
// escrow.escrowId is the claimable balance id; put it in receipt.payment.reference.

const sellerRail = new StellarClaimableEscrowRail({ signer: keypairSigner(sellerKp) });
await sellerRail.deliver(escrow.escrowId, signed.receiptHash); // MEMO_HASH anchor
// ... after deadline + review window:
await sellerRail.release(escrow.escrowId);
```

## What it exports

| Export                                                                         | Implements   | Notes                                                                                  |
| ------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------- |
| `StellarClaimableEscrowRail`                                                   | `EscrowRail` | `open`, `getEscrow`, `deliver`, `release`, `refund`, plus `reject` and `clearDelivery` |
| `StellarAnchor`                                                                | `Anchor`     | `MEMO_HASH = receiptHash` on a no-op `BumpSequence` transaction                        |
| `keypairSigner`                                                                | —            | Signers are injected; the adapter never stores keys                                    |
| `parseEscrowId`, `escrowClaimants`, `parseEscrowTerms`, `deriveEscrowState`, … | —            | Pure, network-free helpers (unit tested)                                               |

Rail id: `escrow:stellar-claimable`; anchor id: `anchor:stellar`; network: `stellar:testnet`.
Assets are `native` or `CODE:ISSUER` (testnet USDC: `TESTNET_USDC`). Amounts are integer strings in
the smallest unit (Stellar has 7 decimals).

## Escrow design

One claimable balance per job, created by the buyer. It has exactly two claimants whose time
windows never overlap:

| Claimant | Predicate                                                   | Meaning                                     |
| -------- | ----------------------------------------------------------- | ------------------------------------------- |
| seller   | `not(before(deadline + reviewWindow))`                      | auto-release once the review window ends    |
| buyer    | `not(before(deadline)) and before(deadline + reviewWindow)` | refund, reject or accept after the deadline |

```
open ────────── deadline ──────────────── deadline + review ─────────▶
│ nobody can claim │ buyer may claim:           │ seller may claim
│ seller works and │  refund   (not delivered)  │  release (auto)
│ delivers         │  reject   (delivered)      │
│                  │  accept   (claim + pay)    │
```

- **escrowId** is Horizon's hex balance id (`00000000…`); the SEP-23 `B…` strkey is accepted too.
- **deliver** (seller, before the deadline): one transaction with `MEMO_HASH = receiptHash` (the
  SPEC §7 anchor) and a `ManageData` entry on the seller's account named by the balance hash, valued
  with the receipt hash. The entry makes "delivered" a fact of current ledger state, readable with
  one account lookup. Redelivery overwrites it (use `supersedes` in the new receipt).
- **release** (seller, after the window): `ClaimClaimableBalance` + removal of the delivery entry,
  with `MEMO_HASH = receiptHash`.
- **release** (buyer = early acceptance, inside the buyer window): one atomic transaction that claims
  the balance and pays the full amount to the seller, with `MEMO_HASH = receiptHash`. The seller then
  calls `clearDelivery` to recover the entry's 0.5 XLM reserve.
- **refund** (buyer, inside the buyer window, nothing delivered) and **reject** (buyer, inside the
  window, delivered): `ClaimClaimableBalance` with memo text `receptum:refund` / `receptum:reject`.
- **getEscrow** reads only public data: the balance's operations (creation, claim), the claim
  transaction's memo and payments, and the seller's data entry. A buyer claim that pays the seller in
  full in the same transaction is `released` (acceptance); any other buyer claim is `refunded`.
  Balances without exactly this predicate shape are rejected as "not a Receptum escrow".

## Trade-offs and limitations (read before relying on it)

Claimable-balance predicates are **time-only**: they cannot see deliveries, receipts or signatures.
So some guarantees are enforced by the ledger and others only by this client and by public
verifiability.

Enforced on-chain:

- Nobody can move the funds before the deadline; the buyer cannot cancel mid-work.
- Only the buyer can claim during `[deadline, deadline + review)`; only the seller afterwards.
- The two windows never overlap, so there is no race.

Not enforced on-chain (client policy + public evidence only):

1. **Buyer must act if nothing is delivered.** If the seller never delivers and the buyer does not
   refund during `[deadline, deadline + review)`, the seller can claim afterwards. `release()`
   refuses to claim without a recorded delivery (`requireDeliveryForRelease`, default on), but a
   dishonest seller can bypass the client; such a claim is publicly visible as a release with no
   delivery anchor. Buyers (or an agent acting for them) should watch their escrows; size the review
   window to your monitoring.
2. **The buyer can reject a genuine delivery.** During its window the buyer can reclaim even after a
   valid delivery. This is the `buyer` acceptance mode's inherent risk; there is no arbiter. The
   receipt and its anchor are public evidence for reputation or off-chain dispute.
3. **The review window runs from the deadline, not from the delivery.** Predicates are fixed when
   the balance is created, so an early delivery still auto-releases at `deadline + review` (the buyer
   always gets at least `reviewWindowSeconds`). The receipt's `acceptance.reviewWindowSeconds` is
   that window; `EscrowState.releasableAfter` states the exact time.
4. **No acceptance before the deadline.** The buyer has no claim right before the deadline, so the
   earliest release is at the deadline. Pick short deadlines for short jobs.
5. **Late delivery is refused** by `deliver()` once the deadline has passed, since the buyer's refund
   window is already open.
6. **Reserves.** The buyer sponsors the balance's claimant reserves (returned on claim); the seller
   locks 0.5 XLM per delivery entry until `release` or `clearDelivery`.
7. **Evaluator mode** (`acceptance.mode = "evaluator"`) is not supported by this rail: a claimant can
   only claim to itself, so a third party cannot release funds to the seller.

Alternatives considered:

- _2-of-2 escrow account with pre-signed transactions_: true delivery-conditional refunds are
  possible with sequence-number tricks and `minSeqAge` preconditions, but delivery could not carry
  the receipt hash in a pre-authorised transaction, either party could grief by bumping the
  sequence, and per-job account setup costs more reserves and transactions. Rejected for v1.
- _Soroban escrow contract_ (the long-term design, roadmap M6): the contract can condition refunds
  and release on `deliver(escrowId, receiptHash)` exactly like the EVM escrow, support evaluators,
  and emit a `Delivered` event. **Next step**: it needs the `wasm32v1-none` Rust target and
  `stellar-cli`; the local toolchain here is a Homebrew Rust without rustup, so this was deferred.
  The `EscrowRail` interface stays the same; a `StellarSorobanEscrowRail` would sit alongside this
  one, with the `StellarAnchor` unchanged.

## Anchor

`StellarAnchor.anchor(receiptHash)` submits a transaction with `MEMO_HASH = receiptHash` whose only
operation is a no-op `BumpSequence` (one base fee, no balance changes). `find(receiptHash, { reference })`
checks one transaction (escrow delivery and release transactions also qualify); without a reference
it scans the anchor account's recent transactions (`maxScan`, default 200). Only successful
transactions from the configured account count.

## Running the end-to-end test (testnet, not in CI)

```sh
pnpm install
pnpm --filter @receptum/core --filter @receptum/adapter-stellar build
node packages/adapter-stellar/scripts/e2e-testnet.mjs
```

The script stores testnet keys **outside the repo** in `$RECEPTUM_WALLETS_DIR` (default
`~/.config/receptum/wallets`, directory mode 700, files mode 600): `stellar-testnet.json` (buyer and
seller keypairs, created on first run) and `seller-ed25519.pem` (the seller's receipt-signing key,
created if absent and reused if present). It funds both accounts with friendbot, adds USDC trustlines,
buys a few Circle testnet USDC with XLM on the testnet DEX (falling back to XLM if that fails), then
runs four escrows sharing one ~90 s deadline — auto-release, buyer acceptance, refund and rejection —
plus client-side and on-chain negative checks. It takes about 3 minutes and writes public results
only (addresses, transaction hashes, explorer links, signed receipts) to `E2E_RESULTS.md`.
