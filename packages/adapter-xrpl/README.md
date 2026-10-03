# @receptum/adapter-xrpl

XRP Ledger rail for Receptum: **native XRPL Escrow** (`escrow:xrpl`) and **memo-anchored receipts** (`anchor:xrpl`). No smart contracts, no custom code on-chain.

**Status:** working on XRPL **testnet** (`xrpl:1`, the default), proven end to end — see [E2E_RESULTS.md](./E2E_RESULTS.md). Not audited. Mainnet (`xrpl:0`) is supported behind an explicit opt-in — see [Mainnet](#mainnet-opt-in).

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

- Account bindings (SPEC §4.1): `xrplAccountSigner(wallet, { account? })` signs with ripple-keypairs; `xrplBindingVerifier` checks offline that the key is the account's master key; `xrplOnlineBindingVerifier(client, address)` accepts the master key (unless `lsfDisableMaster`) or the current `RegularKey`.

`getEscrow` derives state from chronological ledger history. Settlement: the escrow ledger entry while it exists; afterwards the `EscrowFinish`/`EscrowCancel` that deleted it (owner's history). Delivery: the **first** successful memo transaction from the seller naming the escrow, ordered after the `EscrowCreate` (found via the entry's `PreviousTxnID`), with a close time ≤ `CancelAfter`, and before the settling transaction — scanned forward from the creation ledger. Later memos (re-deliveries, memos after refund) are ignored, as are memos sent before the escrow existed. Scans are bounded by `maxHistoryPages` (200 txs per page, default 10) and stop early on decisive evidence; a scan that would need more pages throws `XrplHistoryIncompleteError` rather than pretending the history ended, and an escrow is reported not found only when the owner's history was read back to the account's creation (otherwise the same error). `@receptum/verify` reports that error as `unavailable`. The state carries the raw protocol facts in `state.xrpl` (160-bit `currency`, `issuer`, `condition`, `cancelAfter`, `finishAfter`, `deliveryCloseTime`); `state.asset` is a round-trip-safe display form — a nonstandard 40-hex code is never shown as the standard code it spells — and comparisons use `currencyId` / `parseXrplAsset`.

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

## x402 `exact` on XRPL

This adapter isn't needed to sell over x402 on XRPL. `@x402/xrpl` (client and server schemes) and the public facilitator `https://x402.org/facilitator` do that on `xrpl:1` (the payer pays the fee, `areFeesSponsored: false`). The adapter adds the Receptum pieces: `XrplAnchor` for the receipt hash and `xrplAccountSigner`/`xrplBindingVerifier` for the seller ↔ payee binding. `@receptum/verify` confirms the settlement by its rule in [SPEC §7.3](../../docs/SPEC.md#73-settlement-level-3): a validated tesSUCCESS `Payment` from the payer to the payee whose `delivered_amount` (not `Amount`) equals the receipt amount. The Python verifier applies the same rule. Example: [examples/x402-xrpl](../../examples/x402-xrpl). Live run (0.01 XRP): settlement [`CEBA2DF49DE1…`](https://testnet.xrpl.org/transactions/CEBA2DF49DE13B89A6A5A9D79F4CB113724EACC02DE9E4F1B0F5C8ADE1F4CC1E), anchor [`C731592F3059…`](https://testnet.xrpl.org/transactions/C731592F3059F916685F7D5413575017167F5E25D6715780BB140B204D3932E1), VERIFIED by both verifiers.

## Limitations

- Testnet only; not audited.
- `auto` acceptance needs an off-chain agent to reveal the fulfillment (see above).
- RLUSD escrow is blocked on testnet by the issuer's settings, not by this adapter.
- History scans are bounded; there is no indexer.
- No multisig signers, destination tags or MPT amounts yet.

## Mainnet (opt-in)

Before every signature the adapter calls `assertNetwork(client, network, { allowMainnet })` (it replaces `assertTestnet()`, which remains as a deprecated alias). The default `network` is testnet `xrpl:1` and the server must report NetworkID 1, as before. Mainnet `xrpl:0` needs `allowMainnet: true` (or `RECEPTUM_ALLOW_MAINNET=1`) — checked before the server is even asked — and the server must then report exactly NetworkID 0:

```ts
const client = new Client(XRPL_ENDPOINTS["xrpl:0"][0]); // wss://xrplcluster.com, wss://s1.ripple.com, wss://s2.ripple.com
const rail = new XrplEscrowRail({ client, wallet, network: "xrpl:0", allowMainnet: true });
```

`XrplAnchor` takes the same options. XRP escrow works on mainnet (native protocol escrow, no Receptum contract); RLUSD escrow needs the RLUSD issuer to enable trust-line locking. Use fresh mainnet keys only. See [docs/MAINNET.md](../../docs/MAINNET.md).
