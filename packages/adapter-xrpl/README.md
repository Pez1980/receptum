# @receptum/adapter-xrpl

XRP Ledger rail for Receptum: **native XRPL Escrow** (`escrow:xrpl`) and **memo-anchored receipts** (`anchor:xrpl`). No smart contracts, no custom code on-chain.

**Status:** working on XRPL **testnet** (`xrpl:1`), proven end to end — see [E2E_RESULTS.md](./E2E_RESULTS.md). Not audited; mainnet is not a supported target yet.

```ts
import { Client } from "xrpl";
import { newEscrowSecret, XrplEscrowRail } from "@receptum/adapter-xrpl";

const client = new Client("wss://s.altnet.rippletest.net:51233");
await client.connect();

// Buyer: lock 2 XRP for the seller, releasable only with the buyer's secret.
const secret = newEscrowSecret(); // keep secret.fulfillment private until you accept
const buyerRail = new XrplEscrowRail({ client, wallet: buyerWallet });
const escrow = await buyerRail.createEscrow({
  seller: sellerAddress,
  amount: "2000000", // drops
  asset: "XRP",
  deliverBy: new Date(Date.now() + 3_600_000),
  reviewWindowSeconds: 86_400,
  condition: secret.condition,
});

// Seller: commit the receipt hash on delivery.
const sellerRail = new XrplEscrowRail({
  client,
  wallet: sellerWallet,
  fulfillment: (escrowId) => fulfillmentsFromBuyer.get(escrowId),
});
await sellerRail.deliver(escrow.escrowId, signed.receiptHash);

// Buyer accepts → hands secret.fulfillment to the seller → seller releases.
await sellerRail.release(escrow.escrowId);
// …or, if nothing acceptable arrived, the buyer refunds after CancelAfter:
await buyerRail.refund(escrow.escrowId);
```

## What goes on-chain

| Step               | Transaction                                   | Public data                                                                                                                 |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fund (buyer)       | `EscrowCreate`                                | amount, buyer, seller, `CancelAfter`, `Condition` (SHA-256 fingerprint of a random secret)                                  |
| Deliver (seller)   | `AccountSet` (no-op) from the seller, 2 memos | `MemoType=hex("receptum/1")`, `MemoData=receiptHash` (SPEC §7); `MemoType=hex("receptum/escrow")`, `MemoData=hex(escrowId)` |
| Release            | `EscrowFinish` with `Fulfillment`             | the (now spent) secret                                                                                                      |
| Refund (buyer)     | `EscrowCancel`                                | —                                                                                                                           |
| Anchor (no escrow) | `AccountSet` (no-op) with the receipt memo    | `receiptHash`                                                                                                               |

Only hashes and the escrow parameters are published — never the receipt body, the output, prompts or job ids. An escrow is identified by `escrowId = <ownerAddress>:<OfferSequence>` (the EscrowCreate's `Sequence`, or `TicketSequence`), which is also what the receipt puts in `payment.reference`.

Delivery uses a no-op `AccountSet` rather than a 1-drop payment: no value moves, and it cannot fail because of the buyer's account settings (`DepositAuth`, required destination tags, …). The second memo binds the delivery to one escrow, so `getEscrow` can find it in the seller's history.

## Escrow design

XRPL Escrow offers three knobs, fixed at creation: `Condition` (a PREIMAGE-SHA-256 crypto-condition), `FinishAfter` and `CancelAfter`. Two facts drive the design:

1. **`Condition` and `FinishAfter` are conjunctive.** If both are set, `EscrowFinish` needs the fulfillment **and** a close time past `FinishAfter`. There is no "fulfillment _or_ timeout" — so "early release via the fulfillment, auto-release via `FinishAfter`" cannot be built from one escrow.
2. **Nothing on-chain can observe delivery**, and none of the three fields can be changed later.

A `FinishAfter`-only escrow would let the seller collect after the timer whether or not they delivered, and the buyer could not refund before it. That breaks _buyer protection by default_. So this adapter uses:

- `Condition = condition(preimage)` — the buyer generates a fresh random 32-byte preimage per escrow (`newEscrowSecret()`) and keeps it.
- `CancelAfter = deliverBy + reviewWindowSeconds` — the latest on-time delivery still gets the full review window.
- No `FinishAfter`.

Resulting guarantees:

| Who    | Can                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller | finish **only** with the fulfillment, i.e. only after the buyer (or an evaluator holding the secret) accepted. Funds always go to the escrow's `Destination`, whoever submits the finish. |
| Buyer  | refund **without anyone's approval** once the ledger close time is past `CancelAfter`, if they never revealed the fulfillment.                                                            |
| Nobody | finish after `CancelAfter`, or cancel before it.                                                                                                                                          |

**Acceptance modes.** `buyer` and `evaluator` map directly: whoever holds the preimage accepts by revealing it (the buyer can also submit `EscrowFinish` themselves). `auto` (release when the review window lapses) **cannot be enforced trustlessly** with native escrow today; it needs the buyer's agent, or a delegated evaluator service, to reveal the fulfillment when the window ends. Smart Escrows (XLS-100, `FinishFunction`) could remove that dependency once enabled.

**Rejection.** Rejecting a delivery means not revealing the fulfillment; the funds return at `CancelAfter` (SPEC §5 "per rail rules").

**Trade-offs, plainly:**

- The seller carries the risk of a silent buyer: delivered work + no acceptance = refund at `CancelAfter`. Use an evaluator, deliver previews first, or price the risk in.
- The delivery deadline itself is not on-chain; only `CancelAfter` is. `deliver()` refuses once `CancelAfter` has passed; judging lateness before that is up to the buyer.
- Releasing publishes the preimage. Never reuse a secret across escrows.
- XRPL compares times with the **parent ledger's close time**, which has ~10 s resolution and lags wall-clock time. A refund becomes possible a few seconds to one ledger after `CancelAfter`; `refund()` checks the validated ledger's close time first and throws early instead of burning a fee.

## Assets

- **XRP** — amounts in drops.
- **Issued tokens** (`"<currency>.<issuer>"`, e.g. `RLUSD.r…`) via the `TokenEscrow` amendment (XLS-85). Integer amounts are scaled by `iouDecimals` (default 6: `"1250000"` ⇄ `1.25`). The issuer must have set `asfAllowTrustLineLocking`, the buyer must not be the issuer, and the seller should hold a trust line before release.
- **Testnet status (Oct 2026):** `TokenEscrow` is **enabled** on testnet, but Ripple's RLUSD testnet issuer (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) has **not** set `allowTrustLineLocking`, so an RLUSD `EscrowCreate` is rejected with `tecNO_PERMISSION` (checked with `simulate`). The token path is proven on testnet with a self-issued token instead; RLUSD escrow works unchanged once the issuer enables locking. MPT escrow is not implemented.

## API

- `XrplEscrowRail` — core `EscrowRail` (`getEscrow`, `deliver`, `release`, `refund`) plus `createEscrow` for the buyer. Options: `client`, `wallet`, `network` (default `xrpl:1`), `fulfillment(escrowId)`, `iouDecimals`, `maxHistoryPages`.
- `XrplAnchor` — core `Anchor`. `find(hash, { reference })` fetches the tx and checks the memo; without a reference it scans the anchoring account's recent history.
- Helpers: `newEscrowSecret`, `conditionFromPreimage`, `fulfillmentFromPreimage`, `fulfillmentMatches`, `receiptMemos`, `parseReceiptMemos`, `formatEscrowId`, `parseEscrowId`, `toXrplAmount`, `fromXrplAmount`.

Keys stay with the integrator: wallets are injected xrpl.js `Wallet`s and the adapter never stores them.

`getEscrow` reads the escrow ledger entry while it exists; afterwards it finds the closing `EscrowFinish`/`EscrowCancel` in the owner's history. `delivered` and `receiptHash` come from the seller's history. Both scans are bounded by `maxHistoryPages` (200 txs per page, default 10) — very busy accounts need a larger bound or an indexer.

## Running the testnet E2E

```sh
pnpm install && pnpm build
node packages/adapter-xrpl/scripts/e2e-testnet.mjs
```

The script refuses to run unless the server reports NetworkID 1 (testnet). It keeps its secrets **outside the repo** in `$RECEPTUM_WALLETS_DIR` (default `~/.config/receptum/wallets`, directory `0700`, files `0600`): `xrpl-testnet.json` (buyer, seller and test-issuer seeds, generated on first run) and `seller-ed25519.pem` (the receipt signing key, reused if present). Each run tops the wallets up from the faucet and:

- **A** — XRP escrow → seller delivers a signed receipt → buyer verifies the signature and the on-chain `receiptHash`, hands over the fulfillment → seller releases.
- **Anchor** — standalone `anchor:xrpl` anchor, found by reference and by account scan.
- **C** — the same flow with a self-issued token through `TokenEscrow`.
- **B** — XRP escrow with no delivery → refund once the ledger passes `CancelAfter` (~2 minutes).

It writes public results (addresses, tx hashes, explorer links, signed receipts) to `E2E_RESULTS.md`.

## Limitations

- Testnet only; not audited.
- `auto` acceptance needs an off-chain agent to reveal the fulfillment (see above).
- RLUSD escrow is blocked on testnet by the issuer's settings, not by this adapter.
- History scans are bounded; there is no indexer.
- No multisig signers, destination tags or MPT amounts yet.
