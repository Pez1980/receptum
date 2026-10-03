# @receptum/adapter-stellar

Stellar rails for Receptum:

- **`SorobanEscrowRail`** — the Soroban `ReceptumEscrow` contract (Rust, in
  [`contracts/receptum-escrow`](./contracts/receptum-escrow)): the same state machine as the EVM
  escrow, with the review window measured from delivery, an optional evaluator and
  delivery-conditional refunds. **Recommended.**
- **`StellarClaimableEscrowRail`** — escrow on native claimable balances (no contract), with
  weaker, time-only guarantees (see below).
- **`StellarAnchor`** — receipt anchoring with `MEMO_HASH` (SPEC §7).
- **`findSacTransfer`** — checks an x402 `exact` settlement on `stellar:testnet` (used by
  `@receptum/verify`).

**Status:** testnet only (`stellar:testnet`). The contract and both escrow designs are
**unaudited**. Every transaction is signed with the testnet passphrase, the mainnet Horizon is
refused, and the Soroban RPC's network passphrase is checked before anything is signed. Mainnet
waits for an independent audit (roadmap M7). Real end-to-end runs are recorded in
[E2E_RESULTS.md](./E2E_RESULTS.md).

## Soroban escrow

Deployed on testnet: [`CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG`](https://stellar.expert/explorer/testnet/contract/CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG)
(wasm SHA-256 `0dc6b174951cad16630ab1d6600e54d4b6378d9d076fd0d0c5936e2bcaa3deaf` =
`RECEPTUM_SOROBAN_WASM_HASH`; record in
[`deployment.testnet.json`](./contracts/receptum-escrow/deployment.testnet.json)).

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { SorobanEscrowRail, keypairSigner, caip10 } from "@receptum/adapter-stellar";

const contractId = "CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG";
const buyerRail = new SorobanEscrowRail({ contractId, signer: keypairSigner(buyerKp) }); // asset: testnet USDC
const escrow = await buyerRail.open({
  seller: sellerAddress,
  amount: "1000000", // 0.1 USDC: 7 decimals
  deliverBy: new Date(Date.now() + 3_600_000),
  reviewWindowSeconds: 86_400, // from delivery
  evaluator: evaluatorAddress, // optional; must differ from buyer and seller
});
// escrow.escrowId = "stellar:testnet:<contract>:<id>" → receipt.payment.reference
// receipt.payment.asset = escrow.token (the USDC Stellar Asset Contract), payee = caip10(seller)

const sellerRail = new SorobanEscrowRail({ contractId, signer: keypairSigner(sellerKp) });
await sellerRail.deliver(escrow.escrowId, signed.receiptHash); // starts the review window
await buyerRail.accept(escrow.escrowId); // or: reject() within the window, or anyone release() after it
```

| Call                | Who                                           | When                                  | Effect                         |
| ------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------ |
| `open`              | buyer (signs; funds move via the token's SAC) | `deliverBy` in the future             | funds held by the contract     |
| `deliver(id, hash)` | seller                                        | at or before `deliverBy`, once        | `delivered`, window starts now |
| `accept(id, by)`    | buyer or evaluator                            | any time after delivery               | `released` to the seller       |
| `reject(id, by)`    | buyer or evaluator                            | before `deliveredAt + reviewWindow`   | `refunded` to the buyer        |
| `release(id)`       | anyone                                        | from `deliveredAt + reviewWindow`     | `released` to the seller       |
| `refund(id)`        | anyone                                        | after `deliverBy`, if never delivered | `refunded` to the buyer        |
| `seller_refund(id)` | seller                                        | any time before release               | `refunded` to the buyer        |

Contract properties (tested in `src/test.rs`, 27 tests: time boundaries, auth failures, double
settlement, a lying token, conservation across many escrows):

- `require_auth` on the buyer (`open`, which also authorizes the token transfer), the seller
  (`deliver`, `seller_refund`) and the named judge (`accept`, `reject`); `release`/`refund` are
  permissionless but time-gated.
- `open` checks the token moved exactly `amount` into the contract (the balance delta), so a token
  that lies about transfers is rejected. Like the EVM escrow it assumes an honest, standard token;
  verifiers additionally require the token to be the Stellar Asset Contract of the receipt's asset.
- Funds only ever go to the escrow's buyer or seller. Checked arithmetic (`overflow-checks = true`
  and explicit `checked_add`). No admin, no upgrade entry point — the code at a contract id can't
  change.
- One delivery per escrow: the first committed hash is final (redelivery fails `BadState`).
- Events `opened`, `delivered`, `released`, `refunded` (topic: escrow id) for every transition.
- Soroban forbids re-entering a contract during its own call, so no reentrancy lock is needed.
- Storage: one persistent entry per escrow, TTL extended to ~30 days on every write (the contract
  instance and code too, on each `open`). Archived entries are restored automatically when invoked
  (protocol 23+), but **read-only verification of an archived escrow fails until someone restores
  it** — verify receipts while they're fresh, or keep the transaction hashes.

Rail details: `getEscrow` reads the escrow straight from contract storage (no account or
simulation). Calls simulate first, so a call the contract would reject fails with a named error
(`ReceptumEscrow rejected the call: TooEarly`) before anything is submitted. The signer must be
the account whose authorization the call needs (it signs as the transaction source).

Build, test, deploy:

```sh
cd packages/adapter-stellar/contracts/receptum-escrow
cargo test                      # toolchain pinned in rust-toolchain.toml (1.99.0 + wasm32v1-none)
stellar contract build          # stellar-cli 28.1.0; must reproduce receptum_escrow.wasm (0dc6b174…)
cd - && pnpm build
node packages/adapter-stellar/scripts/deploy-soroban-testnet.mjs   # refuses if a deployment exists
node packages/adapter-stellar/scripts/e2e-soroban-testnet.mjs      # flows A–E, ~4 minutes
```

## Exports

| Export                                                               | Implements   | Notes                                                                                   |
| -------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `SorobanEscrowRail`                                                  | `EscrowRail` | `open`, `getEscrow`, `deliver`, `accept`, `reject`, `release`, `refund`, `sellerRefund` |
| `StellarClaimableEscrowRail`                                         | `EscrowRail` | `open`, `getEscrow`, `deliver`, `release`, `refund`, plus `reject` and `clearDelivery`  |
| `SOROBAN_ESCROW_CAPABILITIES`, `CLAIMABLE_ESCROW_CAPABILITIES`       | —            | `EscrowCapabilities` of each rail (also each rail's `capabilities` property)            |
| `StellarAnchor`                                                      | `Anchor`     | `MEMO_HASH = receiptHash` on a no-op `BumpSequence` transaction                         |
| `SorobanRpcClient`, `RECEPTUM_SOROBAN_WASM_HASH`, `TESTNET_USDC_SAC` | —            | Read escrow storage and a contract's wasm hash; submit invocations                      |
| `findSacTransfer`, `matchSacTransfer`                                | —            | Find a Stellar Asset Contract `transfer` to a payee in a settled transaction (x402)     |
| `keypairSigner`                                                      | —            | Signers are injected; the adapter never stores keys                                     |
| `findDelivery`, `allocateClaimPayments`, `deriveEscrowState`, …      | —            | Pure, network-free helpers (unit tested)                                                |

| Rail                           | `payment.rail`             | `payment.reference`               | `payment.asset`                                   |
| ------------------------------ | -------------------------- | --------------------------------- | ------------------------------------------------- |
| Soroban escrow                 | `escrow:receptum-soroban`  | `stellar:testnet:<contract>:<id>` | token contract `C…` (or `CODE:ISSUER` of its SAC) |
| Claimable-balance escrow       | `escrow:stellar-claimable` | hex balance id `00000000…`        | `native` or `CODE:ISSUER`                         |
| x402 `exact` (`@x402/stellar`) | `x402:exact`               | settlement transaction hash       | token contract `C…`                               |

Amounts are integer strings in the smallest unit (Stellar assets have 7 decimals). Testnet USDC:
`TESTNET_USDC` (`CODE:ISSUER`) / `TESTNET_USDC_SAC` (its contract).

| Capability                         | Soroban escrow                      | Claimable-balance escrow                               |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Acceptance modes enforced on-chain | buyer, evaluator, auto              | buyer, auto                                            |
| Review window starts               | at delivery                         | at the delivery deadline                               |
| Refund after delivery              | rejection in window, or seller      | buyer claim in its window                              |
| Refund if nothing delivered        | anyone, any time after the deadline | buyer only, before `deadline + window` (review item 3) |

## x402 on Stellar

`@x402/stellar` 2.28 supports `exact` on `stellar:testnet`, and the public facilitator
`https://x402.org/facilitator` advertises it (`areFeesSponsored: true`). The buyer signs only a
Soroban authorization entry for the USDC contract's `transfer`; the facilitator submits and pays
the fee. [`examples/x402-stellar/e2e.mjs`](../../examples/x402-stellar/e2e.mjs) runs a paid HTTP
job end to end with `@receptum/server` and `@receptum/client`, and `receptum-verify` confirms the
settlement: a successful transaction containing a SAC `transfer` of exactly `payment.amount` of
`payment.asset` from the payer to `payment.payee` (read from Horizon's `asset_balance_changes`,
which Horizon derives from the asset contract's own events; Horizon keeps full history, Soroban RPC
only about a week).

## Claimable-balance escrow

One claimable balance per job, created by the buyer, with exactly two claimants whose time windows
never overlap:

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
- **deliver** (seller, before the deadline, once): one transaction with `MEMO_HASH = receiptHash`
  (the SPEC §7 anchor) and a `ManageData` entry on the seller's account named by the balance hash,
  valued with the receipt hash.
- **Delivery is derived from history** (review item 13): the delivery is the _first_ successful
  seller transaction after the balance was created and strictly before the deadline that carries
  both the memo and a matching write of that entry. Later writes, deletions, rewrites or
  post-deadline entries never change it; the current value of the data entry is not consulted.
  The scan is bounded (`maxHistory`, default 1000 seller transactions); exceeding it is an error,
  never a silent "not delivered".
- **release** (seller, after the window): `ClaimClaimableBalance` (+ removal of the delivery entry).
- **release** (buyer = early acceptance, inside the buyer window): one atomic transaction that
  claims the balance and pays the full amount to the seller. The seller then calls `clearDelivery`
  to recover the entry's 0.5 XLM reserve.
- **refund** / **reject** (buyer, inside its window): `ClaimClaimableBalance`.
- **getEscrow** reads only public history: the balance's operations, the seller's transactions up
  to the deadline, and the claim transaction. A buyer claim is `released` only if the same
  transaction pays the seller exactly the escrow amount in its asset — and payments are allocated
  across **every** Receptum balance claimed in that transaction, one payment per escrow, in
  operation order (review item 14), so a single payment can't make two escrows look accepted. Any
  other buyer claim is `refunded`. Balances without exactly this predicate shape are rejected as
  "not a Receptum escrow".

### Trade-offs and limitations (read before relying on it)

Claimable-balance predicates are **time-only**: they cannot see deliveries, receipts or signatures.

Enforced on-chain: nobody can move the funds before the deadline; only the buyer can claim during
`[deadline, deadline + review)`; only the seller afterwards; the windows never overlap.

Not enforced on-chain (client policy + public evidence only):

1. **Buyer must act if nothing is delivered** (review item 3, open by design). If the seller never
   delivers and the buyer does not refund during `[deadline, deadline + review)`, the seller can
   claim afterwards. `release()` refuses to claim without a delivery (`requireDeliveryForRelease`,
   default on), but a dishonest seller can bypass the client; such a claim is publicly visible as a
   release with no delivery anchor, and `receptum-verify` fails it. Buyers must monitor their
   escrows — or use the Soroban escrow, where an undelivered escrow can be refunded by anyone at
   any time after the deadline.
2. **The buyer can reject a genuine delivery** during its window (the `buyer` mode's inherent risk;
   no arbiter). The receipt and its anchor are public evidence.
3. **The review window runs from the deadline, not from the delivery**, and there is **no
   acceptance before the deadline**.
4. **Late delivery is refused** by `deliver()` once the deadline has passed, and ignored by
   `getEscrow` if forced through.
5. **Reserves.** The buyer sponsors the claimant reserves (returned on claim); the seller locks
   0.5 XLM per delivery entry until `release` or `clearDelivery`.
6. **No evaluator mode**: a claimant can only claim to itself.

## Anchor

`StellarAnchor.anchor(receiptHash)` submits a transaction with `MEMO_HASH = receiptHash` whose only
operation is a no-op `BumpSequence`. `find(receiptHash, { reference })` checks one transaction
(escrow delivery and release transactions also qualify); without a reference it scans the anchor
account's recent transactions (`maxScan`, default 200). Only successful transactions from the
configured account count.

## Running the end-to-end tests (testnet, not in CI)

```sh
pnpm install && pnpm build
node packages/adapter-stellar/scripts/e2e-soroban-testnet.mjs   # Soroban flows A–E (~4 min)
node packages/adapter-stellar/scripts/e2e-testnet.mjs           # claimable-balance flows (~3 min)
node examples/x402-stellar/e2e.mjs                              # x402 exact paid job (~30 s)
```

Keys live **outside the repo** in `$RECEPTUM_WALLETS_DIR` (default `~/.config/receptum/wallets`,
directory mode 700, files mode 600): `stellar-testnet.json` (buyer and seller),
`stellar-testnet-evaluator.json` (evaluator / third party, Soroban run only) and
`seller-ed25519.pem` (the seller's receipt-signing key); each is created on first use. The scripts
fund accounts with friendbot, add USDC trustlines and buy a few Circle testnet USDC with XLM on the
testnet DEX. They write public results only (addresses, transaction hashes, explorer links, signed
receipts) to `E2E_RESULTS.md` and refuse to write anything that looks like a secret.
