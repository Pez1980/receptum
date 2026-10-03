# Receptum Receipt Format (RRF) v1

**Status:** draft · October 2026 · Apache-2.0
**Version string:** `receptum/1`

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119.

## 1. Purpose

A Receptum receipt binds a payment to the exact inputs and output of a paid job. It is issued and signed by the seller on delivery. Only hashes are published; the work itself never is.

A receipt proves **which** output was delivered for **which** payment, by **whom**, and under **which acceptance and remedy terms**. It does not prove the output is good — quality is decided by the acceptance mode the receipt records.

## 2. Receipt object

A receipt is a JSON object with these members:

| Member                           | Type                              | Req.                                      | Meaning                                                                                                                   |
| -------------------------------- | --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `version`                        | string                            | MUST                                      | `"receptum/1"`                                                                                                            |
| `receiptId`                      | string                            | MUST                                      | `RCPT-XXXX-XXXX`, Crockford base32 upper-case (§2.3)                                                                      |
| `jobIdHash`                      | hex64                             | MUST                                      | SHA-256 of the seller's internal job id (the id itself MUST NOT be published)                                             |
| `seller.id`                      | string                            | MUST                                      | Ed25519 `did:key` of the signer (required for a `jws` proof, §4), or a CAIP-10 account (§2.1)                             |
| `seller.name`                    | string                            | MAY                                       | Non-empty display name                                                                                                    |
| `buyer.id`                       | string                            | MAY                                       | CAIP-10 account or DID (§2.1)                                                                                             |
| `inputSha256`                    | hex64[]                           | MUST                                      | One or more input hashes; the same hash MAY appear more than once                                                         |
| `outputSha256`                   | hex64                             | MUST                                      | Hash of the delivered artifact                                                                                            |
| `evidence`                       | {string: hex64}                   | MAY                                       | Supporting evidence hashes, e.g. `qaReport`; MAY be an empty object                                                       |
| `payment.rail`                   | string                            | MUST                                      | Non-empty, e.g. `x402:exact`, `escrow:receptum-evm`, `escrow:receptum-soroban`, `escrow:xrpl`, `escrow:stellar-claimable` |
| `payment.network`                | string                            | MUST                                      | CAIP-2 id (§2.1), e.g. `eip155:84532`, `stellar:testnet`, `xrpl:1`                                                        |
| `payment.asset`                  | string                            | MUST                                      | Non-empty asset identifier; a rail may constrain it (`x402:exact` on `eip155`: the token contract address, §7.3)          |
| `payment.amount`                 | string                            | MUST                                      | Non-negative integer in the asset's smallest unit, `0` or `[1-9][0-9]*`                                                   |
| `payment.reference`              | string                            | MUST                                      | Non-empty rail reference: tx hash, escrow id, or payment proof id                                                         |
| `payment.payer`                  | string                            | MAY                                       | CAIP-10 payer account (never a DID)                                                                                       |
| `payment.payee`                  | string                            | SHOULD                                    | CAIP-10 account that receives the funds (never a DID); verifiers check the settlement went to it                          |
| `acceptance.mode`                | `buyer` \| `evaluator` \| `auto`  | MUST                                      | How delivery is accepted                                                                                                  |
| `acceptance.reviewWindowSeconds` | integer                           | MUST                                      | Window after delivery during which delivery can be rejected; an integer in [0, 2^53−1] (§2.3)                             |
| `acceptance.evaluator`           | string                            | MUST if mode = `evaluator`, else MUST NOT | Evaluator identity: DID or CAIP-10 account (§2.1)                                                                         |
| `remedy.kind`                    | `rerender` \| `refund` \| `terms` | MUST when `remedy` is present             | Seller's commitment for defects found after release                                                                       |
| `remedy.withinDays`              | integer                           | MAY                                       | Remedy period; an integer in [0, 2^53−1] (§2.3)                                                                           |
| `remedy.termsSha256`             | hex64                             | MUST if kind = `terms`, MAY for any kind  | Hash of the terms document                                                                                                |
| `supersedes`                     | hex64                             | MAY                                       | `receiptHash` of an earlier receipt this one replaces (e.g. a fixed re-render)                                            |
| `deliveredAt`                    | string                            | MUST                                      | UTC timestamp in the profile of §2.2                                                                                      |

`hex64` is 64 lower-case hexadecimal characters (`^[0-9a-f]{64}$`). Members not listed MUST NOT be present in v1. Optional members that are absent MUST be omitted, not set to `null`. Every string member is non-empty.

### 2.1 Identity syntax

Implementations MUST use exactly these expressions (anchored at both ends, with no newline accepted before the end):

| Syntax  | Expression                                                                                |
| ------- | ----------------------------------------------------------------------------------------- |
| CAIP-2  | `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`                                                    |
| CAIP-10 | `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$`                              |
| DID     | `^did:[a-z0-9]+:(?:idchar*:)*idchar+$` where `idchar = [A-Za-z0-9._-] \| %[0-9A-Fa-f]{2}` |

The DID expression is the W3C DID Core §3.1 ABNF without path, query or fragment; a `%` MUST be followed by two hex digits. A value beginning with `did:` is a DID and never a CAIP-10 account, even though it would also match the CAIP-10 expression; `payment.payer` and `payment.payee` therefore reject every DID. `buyer.id` and `acceptance.evaluator` are a DID or a CAIP-10 account. `seller.id` is an Ed25519 `did:key` (`did:key:z…`, multicodec `0xed01`, 32 key bytes) or a CAIP-10 account.

### 2.2 Timestamps

`deliveredAt`, and the binding timestamps of §4.1, are `YYYY-MM-DDTHH:MM:SS[.f]Z` with ASCII digits only: exactly `^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?Z$` — a strict RFC 3339 profile (upper-case `T` and `Z`, no offsets, 1–9 fractional digits). The value MUST be calendar-valid in the proleptic Gregorian calendar: year 0001–9999, month 01–12, a day that exists in that month, hour 00–23, minute 00–59 and second 00–59 (no leap second). Comparisons between timestamps (§4.1) MUST be exact at full fractional precision — `…00.0001Z` is earlier than `…00.0005Z` — and MUST NOT truncate to milliseconds.

### 2.3 Other values

- `receiptId` matches `^RCPT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`.
- `payment.amount` matches `^(0|[1-9][0-9]*)$`: no sign, no leading zeros, no fraction.
- `acceptance.reviewWindowSeconds` and `remedy.withinDays` are JSON numbers with an integer value in [0, 2^53−1]. JSON cannot distinguish `3` from `3.0`, so both are the integer 3 (and canonicalize as `3`); `1.5`, `-1` and `2^53` are invalid.
- `payment.rail`, `payment.asset`, `payment.reference` and `seller.name` are non-empty strings.
- `evidence` MAY be an empty object; its member names are arbitrary strings.
- `inputSha256` is a non-empty array; duplicate entries are allowed (two identical inputs).

## 3. Canonical form and receipt hash

The canonical bytes of a receipt are its **JCS** serialization (RFC 8785), UTF-8 encoded.

```
receiptHash = lowercase-hex( SHA-256( JCS(receipt) ) )
```

`receiptHash` is the single value anchored on-chain and referenced by `supersedes`.

## 4. Seller signature (JWS proof)

A signed receipt is:

```json
{ "receipt": { … }, "receiptHash": "<hex64>", "proof": { "type": "jws", "kid": "<did:key>#<multibase>", "jws": "<header>..<signature>" }, "bindings": [ … ] }
```

**Envelope.** The signed receipt has exactly the members `receipt`, `receiptHash` (hex64), `proof` and, optionally, `bindings`. `bindings`, when present, is a non-empty array of account bindings (§4.1); `null` and `[]` are treated as absent; any other value is invalid. Verifiers MAY examine only the first 16 bindings. `proof` has exactly the members `type` (`"jws"`), `kid` and `jws`. Any other member, at either level, makes the signed receipt invalid (level 2 fails).

**JWS.**

- `jws` is the compact serialization `<header>..<signature>`: exactly three `.`-separated segments with an empty middle one. The payload base64url(JCS(receipt)) is **detached**.
- `header` and `signature` are unpadded base64url (RFC 4648 §5) in canonical form: re-encoding the decoded bytes MUST reproduce the segment exactly (no padding, no non-zero trailing bits).
- The decoded header is UTF-8 I-JSON (RFC 7493) — in particular with no duplicate member names (a verifier MUST NOT let a later duplicate silently replace an earlier one) — and is an object with exactly the members `alg` (`"EdDSA"`), `kid` and `typ` (`"receptum+jws"`). It is produced as `{"alg":"EdDSA","kid":<kid>,"typ":"receptum+jws"}`.
- The header `kid` MUST equal `proof.kid`, and `kid` MUST be `seller.id + "#" + <method-specific id of seller.id>` (the part after `did:key:`).
- The signing input is `header || "." || payload`, signed with Ed25519 (RFC 8032). The signature is 64 bytes and canonical: its scalar `S` (the second 32 bytes, little-endian) MUST be less than the group order `L = 2^252 + 27742317777372353535851770400913936493`.

A `jws` proof therefore requires `seller.id` to be an Ed25519 `did:key`. A receipt whose `seller.id` is a CAIP-10 account is well-formed (§2) but cannot carry an RRF v1 proof: chain-native proofs (e.g. EIP-712) MAY be defined by adapters and MUST sign the same `receiptHash`, but none is defined in v1, so a v1 verifier fails level 2 for such a receipt.

Verifiers MUST recompute `receiptHash` from `receipt`, compare it to the stated `receiptHash`, and verify the signature against `seller.id`. `bindings` is OPTIONAL and outside the signed receipt (§4.1).

### 4.1 Account binding

The JWS proves who signed a receipt; it does not prove that the signer controls `payment.payee`. A seller could otherwise sign receipts naming someone else's account as the payee and claim that account's payments as its own deliveries. An **account binding** closes that gap: a statement signed **both** by the seller's `did:key` **and** by the payout account's own chain key.

```text
{
  "statement": { "type": "receptum/account-binding/1", "did": "<did:key>", "account": "<CAIP-10>", "issuedAt": "<ts>", "expiresAt": "<ts>" },
  "didProof": { "type": "jws", "kid": "<did:key>#<multibase>", "jws": "<header>..<signature>" },
  "accountProof": { "type": "eip191" | "xrpl" | "sep53", "signature": "…", "publicKey": "…" }
}
```

| Statement member | Type   | Req. | Meaning                                                                            |
| ---------------- | ------ | ---- | ---------------------------------------------------------------------------------- |
| `type`           | string | MUST | `"receptum/account-binding/1"`                                                     |
| `did`            | string | MUST | The seller's Ed25519 `did:key`                                                     |
| `account`        | string | MUST | CAIP-10 payout account, e.g. `eip155:84532:0x…`, `xrpl:1:r…`, `stellar:testnet:G…` |
| `issuedAt`       | string | MUST | Timestamp, same profile as `deliveredAt`                                           |
| `expiresAt`      | string | MAY  | Timestamp after `issuedAt`; receipts delivered at or after it are not covered      |

No other members are allowed, and every member is a string; `issuedAt` and `expiresAt` follow §2.2 and `expiresAt` MUST be later than `issuedAt`. The binding object itself has exactly `statement`, `didProof` and `accountProof`.

**Signing input.** Let `m = UTF-8( JCS(statement) )`. The `type` member inside `m` domain-separates it from receipts and chain transactions.

- **`didProof`** — a detached JWS exactly as in §4, over payload `base64url(m)`, with header `{"alg":"EdDSA","kid":<kid>,"typ":"receptum-binding+jws"}`; `kid` MUST resolve to `statement.did`.
- **`accountProof`**, by the CAIP-2 namespace of `statement.account`:

| Namespace | `accountProof`                        | Signature                                                                                                                                                                                                                                                                                                                                  | Key check                                                                                                                                                                                                       |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eip155`  | `{type:"eip191", signature}`          | EIP-191 `personal_sign(m)`: secp256k1 over `keccak256("\x19Ethereum Signed Message:\n" ‖ decimal(len(m)) ‖ m)`; `signature` = `r ‖ s ‖ v`, 65 bytes, lower-case `0x` hex, `v ∈ {27, 28}`, low-s                                                                                                                                            | The recovered address MUST equal the account (compared case-insensitively). Offline. Externally owned accounts only; contract wallets (ERC-1271) are not supported in v1                                        |
| `xrpl`    | `{type:"xrpl", publicKey, signature}` | ripple-keypairs `sign(hex(m))`: for an Ed25519 key (`publicKey` = `"ED"` ‖ 32 bytes) Ed25519 over `m`, 64 bytes with `S < L`; for a secp256k1 key (`02`/`03` ‖ 32 bytes) ECDSA over `SHA-512Half(m)` in canonical DER (minimal positive INTEGERs, no trailing bytes) and low-s (`s ≤ n/2`; a high-s twin MUST be rejected). Upper-case hex | **Offline:** `publicKey` MUST derive to the account (its master key). **Online:** the master key, only if `lsfDisableMaster` is not set, or the account's current `RegularKey` (from `account_info`, validated) |
| `stellar` | `{type:"sep53", signature}`           | SEP-53: Ed25519 over `SHA-256("Stellar Signed Message:\n" ‖ m)`; `signature` = 64 bytes, standard padded base64                                                                                                                                                                                                                            | The key is the account's G… address itself. Offline                                                                                                                                                             |

**Carrying bindings.** A signed receipt MAY carry `"bindings": [ … ]` beside `receipt`, `receiptHash` and `proof`. Bindings are **not** part of the receipt or of `receiptHash`: adding or removing them never changes a receipt's hash or signature, and a binding can be attached to a receipt issued earlier.

**Coverage.** A binding covers a receipt when all of these hold:

1. `statement.did == receipt.seller.id` and `statement.account` equals `receipt.payment.payee` (EVM addresses compared case-insensitively; other namespaces exactly, CAIP-2 included);
2. `expiresAt` is absent or later than `receipt.deliveredAt` (compared exactly, §2.2);
3. `issuedAt` is not more than 5 minutes ahead of the verifier's clock (it MAY be later than `deliveredAt`);
4. both `didProof` and `accountProof` verify as above.

A verifier without support for the payee's namespace MUST treat the binding as unverified (fail closed). When the XRPL online key check cannot be performed (network error, account not found, or an `account_info` that is not from a validated ledger — `validated: true` is required), level 2.5 is `unavailable` (§6), not a pass and not a failure — unless no binding could cover the receipt whatever the account's keys are, which is a failure. Test vectors: `spec/vectors/account-binding-v1.json`.

**Limits (v1).** There is no revocation other than `expiresAt` — sellers SHOULD set one and re-issue. XRPL key checks reflect the account's keys at verification time, not at delivery. A Stellar binding proves the master key signed; it does not inspect account signers or thresholds. A binding names one chain (CAIP-2), even where the same key controls the same address elsewhere.

## 5. Lifecycle

```
quoted → paid | escrowed → delivered → released | refunded
quoted → expired
```

- **Held:** funds are in escrow (`escrowed`) or paid directly (`paid`).
- **Delivered:** the seller commits `receiptHash` on the rail (escrow `deliver`, or an anchor transaction).
- **Released:** after buyer/evaluator acceptance, or when `reviewWindowSeconds` has elapsed after delivery in `auto` mode. Sellers are paid in full on release; holdbacks are not part of v1 defaults.
- **Refunded:** if nothing is delivered by the escrow deadline, the buyer reclaims funds without anyone's approval. A rejected delivery during the review window MAY also refund, per rail rules.

## 6. Verification levels

- **L1 File ↔ receipt (offline):** `SHA-256(file) == outputSha256`, for a delivered file the verifier was given.
- **L2 Receipt ↔ seller (offline):** the signed receipt is well-formed (§2, §4), `receiptHash` is recomputed, and the JWS proof verifies against `seller.id`.
- **L2.5 Seller ↔ payee (offline; online for XRPL key state):** a binding in `bindings` covers the receipt (§4.1). No binding at all is _unproven_ (`pending`); bindings that are present but none of which covers the receipt are a failure.
- **L3 Receipt ↔ settlement (online):** the payment settled on its rail, at `payment.reference` on `payment.network` (§7.3), **and** `receiptHash` is committed on-chain — by the rail itself for the escrow rails of §7, or, for rails that cannot commit it (e.g. `x402:exact`, whose settlement precedes the receipt), by a mined anchor (§7.1).
- **L4 Seller ↔ real-world identity:** out of scope for v1 (e.g. `did:web`, DNS).

**Check results.** Each check is one of: `pass`; `fail` — the evidence contradicts the receipt, or the receipt breaks a MUST of this specification; `pending` — genuine but not final (e.g. an escrow delivered but not yet released, or no binding at all); `unavailable` — the check could not be performed (unsupported rail or network, a network or RPC error, an account that is not found, a ledger that is not validated, an RPC that serves a different chain); `skipped` — not requested or not applicable (no file given, offline, no payee, the explicit legacy opt-out). A check that cannot be performed MUST be reported `unavailable`: never as a pass and never as a failure.

**Verdicts.** Verifiers MUST report exactly one of:

- **VERIFIED** — no check failed and none is `pending` or `unavailable`, **and** L1 passed (a delivered file was supplied and matches), L2 passed, L2.5 passed or was skipped because the receipt names no `payment.payee` or because the user explicitly opted out for legacy receipts issued before account bindings existed (a verifier MAY offer such an opt-out, e.g. `--allow-unbound`, and MUST then say so in its output), **and** L3 passed: the payment settled on its rail and `receiptHash` is committed on-chain. Anchors alone, or a payment alone, are partial evidence.
- **NOT VERIFIED** — any check failed.
- **PARTIALLY VERIFIED** — otherwise. Command-line verifiers exit with status 3 (0 = VERIFIED, 1 = NOT VERIFIED, 2 = usage or input error).

When the verdict is PARTIALLY VERIFIED, a verifier MUST say which missing pieces prevented VERIFIED (e.g. "no delivered file given", "nothing proves the seller controls the payee", "the payment was not confirmed on its rail", "receiptHash is not committed on-chain").

### 6.1 Input

A receipt file MUST be I-JSON (RFC 7493): UTF-8 without a byte order mark, no duplicate member names at any depth, no lone surrogates (including escaped ones such as `"\ud800"`), and only numbers representable as finite IEEE 754 doubles (no `NaN`, `Infinity` or `1e400`). Verifiers MUST reject any other input before verifying it, rather than parse it with a parser that keeps the first or last of duplicate members — two parsers could otherwise read two different receipts from the same bytes. Command-line verifiers report such input as an input error (exit 2).

The file holds either a bare signed receipt (§4) or a **wrapper** object that has a `signedReceipt` member:

```json
{ "signedReceipt": { "receipt": { … }, "receiptHash": "…", "proof": { … }, "bindings": [ … ] }, "anchor": "<caip2>:<tx>", "settlement": { … } }
```

`anchor`, when present, is one anchor reference (§7.1) or an array of them; any other value is an input error. Verifiers MUST check every anchor reference the wrapper carries, together with any given on the command line. Every other wrapper member (settlement records, client checks, notes, earlier verifier output) is informational and MUST NOT be trusted: an anchor is bound to the recomputed `receiptHash`, so the wrapper itself needs no trust.

## 7. Anchoring and settlement

Rails and anchors commit `receiptHash` as follows:

| Rail                                          | Commitment                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `escrow:receptum-evm`                         | `Delivered(escrowId, receiptHash)` event of the Receptum escrow contract, and `receiptHash` in its storage                       |
| `escrow:receptum-soroban`                     | `receipt_hash` committed by `deliver` in the Soroban escrow's storage, and its `delivered` event (topic: escrow id)              |
| `escrow:xrpl`                                 | Memo `MemoType = hex("receptum/1")`, `MemoData = receiptHash` on the delivery transaction (below)                                |
| `escrow:stellar-claimable`                    | `MEMO_HASH = receiptHash` on the first seller transaction before the deadline that also writes the balance's delivery data entry |
| `anchor:evm`, `anchor:xrpl`, `anchor:stellar` | a standalone anchor transaction (§7.1)                                                                                           |

These four escrow rails commit `receiptHash` themselves. `x402:exact` payments cannot: `payment.reference` is the settlement transaction, which exists before the receipt does, so a receipt paid by x402 needs an anchor to reach VERIFIED (§6). Sellers MAY anchor any receipt.

On rails where delivery is a memo rather than contract state (`escrow:xrpl`), the delivery is the **first** successful memo transaction from the escrow's destination (the seller) that names the escrow and is ordered after its creation (by ledger index, then transaction index), with a ledger close time no later than `CancelAfter`, and before the transaction that settles the escrow. Later memos for the same escrow MUST be ignored. Settlement status comes from the `EscrowFinish` / `EscrowCancel` that removed the escrow.

### 7.1 Anchors

An **anchor reference** is `<caip2>:<tx>`: a CAIP-2 network id (§2.1), a colon, and the transaction hash in the network's native form — split at the **last** colon. Examples: `eip155:5042002:0x<64 hex>`, `xrpl:1:<64 hex>`, `stellar:testnet:<64 lower-case hex>`. A reference that is not of this form fails.

| Anchor           | Anchor transaction                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor:evm`     | A mined transaction with status success and value 0 whose calldata is **exactly** `utf8("receptum/1") ‖ receiptHash` — the 10 ASCII bytes `72 65 63 65 70 74 75 6d 2f 31` followed by the 32 raw bytes of `receiptHash` (42 bytes). The RPC's chain id MUST equal the CAIP-2 reference |
| `anchor:xrpl`    | A transaction in a validated ledger with result `tesSUCCESS` whose first memo with `MemoType = hex("receptum/1")` has `MemoData = receiptHash` (hex compared case-insensitively). The reference adapter uses a no-op `AccountSet`                                                      |
| `anchor:stellar` | A successful transaction with memo type `MEMO_HASH` whose 32 bytes equal `receiptHash`. The reference adapter uses a no-op `BumpSequence`                                                                                                                                              |

**Anyone may send an anchor.** An anchor proves only that `receiptHash` existed by the time of its block or ledger — not who issued the receipt, and not that the anchoring account is the seller. Authorship comes from L2 (and the payout account from L2.5); verifiers MUST NOT require the anchor's sender to be the seller and MUST NOT treat it as evidence of authorship. An anchor is never a pass before it is final enough to be found: an EVM transaction the node does not know or has not mined fails (as for settlement, §7.3), and an XRPL transaction that is not yet in a validated ledger is `unavailable`.

### 7.2 Outputs that are not files

- **HTTP responses:** `outputSha256` is the SHA-256 of the response body bytes as delivered.
- **MCP tool results:** `outputSha256` is the SHA-256 of `JCS({ content, structuredContent?, isError? })`, where `structuredContent` and `isError` are included exactly when the result defines them (including `isError: false`); the receipt travels in `result._meta["receptum/receipt"]`.

### 7.3 Settlement (level 3)

Only the x402 scheme `exact` is recognised: a receipt with any other `x402:*` rail cannot be checked (`unavailable`). For `x402:exact`, `payment.payee` is needed to know where the funds had to go; without it the settlement check is `unavailable`.

**`x402:exact` on `eip155:*`.** `payment.asset` MUST be the ERC-20 token contract address (`0x` + 40 hex) and `payment.reference` the settlement transaction hash (`0x` + 64 hex); `payment.payee` and `payment.payer`, when present, MUST be EVM accounts on `payment.network` — otherwise the check fails without querying the chain. The RPC's chain id MUST equal the network's CAIP-2 reference (otherwise `unavailable`). The transaction at `payment.reference` MUST be mined with status success and MUST have emitted, from the contract `payment.asset`, a log that is not removed and has the exact ERC-20 `Transfer(from, to, value)` shape: **exactly three topics** — `keccak256("Transfer(address,address,uint256)")`, then `from` and `to`, each a 32-byte word whose upper 12 bytes are zero — and **exactly 32 bytes of data** (`0x` + 64 hex, the big-endian `value`). Logs of any other shape (a fourth topic, as in an ERC-721 `Transfer`; shorter, longer or zero-prefixed data; dirty address words) are ignored, never decoded leniently. It MUST have `to = payee`, `value = amount` and, when `payment.payer` is present, `from = payer` (addresses compared case-insensitively). A transaction the node does not know, or that is not yet mined, fails.

**`x402:exact` on `stellar:*`.** `payment.reference` is the settlement transaction hash (64 lower-case hex) and `payment.asset` identifies the asset as `CODE:ISSUER`, `native`, or its Stellar Asset Contract id (`C…`); assets are compared by their contract id. The transaction (read from Horizon, which keeps full history) MUST be successful, and one of its `invoke_host_function` operations MUST record — in Horizon's `asset_balance_changes`, which are derived from the Stellar Asset Contract's own events — a `transfer` of exactly `payment.amount` (in the asset's 7-decimal smallest units) of that asset to the payee, and from the payer when `payment.payer` is present.

**`x402:exact` on `xrpl:*`.** The x402 `exact` scheme on XRPL settles one `Payment` that the payer signs (and pays the fee for; facilitators advertise `extra.areFeesSponsored: false`). `payment.network` is `xrpl:<NetworkID>`, `payment.reference` the `Payment`'s hash (64 hex), `payment.payer` and `payment.payee` the CAIP-10 accounts of its `Account` and `Destination`, both REQUIRED for a pass (otherwise `unavailable`). **RRF v1 supports XRP only:** `payment.asset` is `XRP` and `payment.amount` the integer drops. The verifier reads the transaction with rippled `tx` and reports **pass** only if (1) the server serves the expected network (when `server_info` reports `network_id`, it equals `<NetworkID>`; otherwise `unavailable`) and the reply is for `payment.reference`; (2) `validated` is `true` (otherwise `unavailable`); (3) `meta.TransactionResult` is `tesSUCCESS`; (4) `TransactionType` is `Payment`; (5) a `NetworkID` in the transaction equals `<NetworkID>`, and is present on networks with an ID above 1024; (6) `Account` = payer and `Destination` = payee; (7) `meta.delivered_amount` — never `Amount`/`DeliverMax`, since a partial payment (`tfPartialPayment`) can deliver less — is the XRP drops string equal to `payment.amount`. Rules 3–7, or a reply for another hash, fail; a transaction unknown to the server (`txnNotFound`; servers may lack history), transport errors, no endpoint for the network, or a `delivered_amount` that is absent or `unavailable` are `unavailable`. Destination tags are not part of the receipt and are not checked. The settlement exists before the receipt, so the commitment is an `anchor:xrpl` anchor (§7.1).

_Issued tokens_ are not supported by RRF v1 x402 receipts: `payment.amount` is an integer in the asset's smallest unit (§2.3), and an XRPL issued value is a decimal with no smallest unit, so no integer can name it. Sellers MUST NOT issue such receipts (the reference server refuses issued-token requirements before charging). A verifier given one still checks the asset: `payment.asset` is `<currency>.<issuer>`, where `<currency>` is a 3-character standard code, a 4–20 character symbol (its UTF-8 bytes, zero-padded to 20 bytes) or a 40-hex code, and `<issuer>` a classic address; anything else fails. Currencies compare by their **160-bit protocol identity** (XRPL binary format): a 3-character code is its bytes in the standard layout (12 zero bytes, the 3 code bytes, 5 zero bytes) and is **case-sensitive** (`usd` ≠ `USD`); a 40-hex code is its own identity, compared case-insensitively as hex — so a 40-hex code in the standard layout _is_ that standard code (the ledger stores both identically), while a nonstandard code whose bytes merely spell `USD` (`5553440000…`) is a different currency. `XRP`, characters outside the standard set (letters, digits and `?!@#$%^&*<>(){}[]|`) and 0x00-prefixed codes not in the standard layout are invalid. A delivery in another currency or from another issuer fails; a matching one is `unavailable` (the amount cannot be confirmed), never `pass`. A versioned amount representation for issued tokens is an open item for a later RRF version. `spec/vectors/xrpl-currency-v1.json` lists codes and their identities.

**Escrow rails.** Level 3 passes when the escrow at `payment.reference` committed this `receiptHash` as its delivery (§7), its terms (amount, asset, parties, review window, evaluator) match the receipt, and it was released to `payment.payee`. A genuine escrow that is delivered but not yet released, or a genuine contract at a deployment the verifier does not trust, is `pending`; refunded or mismatching escrows fail.

**XRPL escrows (`escrow:xrpl`).** Assets compare by protocol identity as above (`XRP`, or the escrowed amount's 160-bit currency and issuer — never a decoded display symbol). An XRPL escrow commits only `Amount`, `Account` (buyer), `Destination` (seller), an optional PREIMAGE-SHA-256 `Condition`, `CancelAfter` and `FinishAfter`; the reference adapter creates conditional escrows with `CancelAfter = deliverBy + reviewWindowSeconds`, but `deliverBy` itself is not on the ledger. Acceptance terms therefore verify as follows:

- `buyer`: the escrow MUST have a `Condition` — release then required the fulfillment of a condition the buyer chose when creating the escrow (the ledger does not show who held the preimage; a buyer that adopts someone else's condition delegates acceptance to them). The delivery MUST have left the buyer at least the declared review window: `CancelAfter − (close time of the delivery memo's ledger) ≥ reviewWindowSeconds` (no bound without `CancelAfter`). A receipt claiming more review time than the ledger allowed fails. This bound, not the exact value, is what the ledger proves: the buyer could withhold the fulfillment for at least `reviewWindowSeconds` after delivery.
- `evaluator`: the same ledger rules apply, but the evaluator's identity cannot be proven — possessing (or submitting) the fulfillment does not show who decided — so the check is at best `unavailable` and the receipt is never VERIFIED on this rail.
- `auto`: a conditional escrow cannot auto-release, so it fails; an unconditional escrow has no on-ledger review window, so it is `unavailable`.

Escrow state comes from validated history (§7). A verifier that could not read the history it needs in full — a page limit reached with a `marker` remaining, or a server whose `account_tx` history does not reach back to the owner account's creation — MUST report `unavailable`: an escrow (or its `EscrowCreate`) is _not found_, and fails, only when the owner's history was read completely back to the transaction that created the account (or the account does not exist). Scans MAY stop early once decisive evidence is found.

### 7.4 Rail differences

Rails enforce acceptance differently. Adapters SHOULD publish their `EscrowCapabilities`:

| Rail                       | Acceptance modes enforced on-chain                                                                                                              | Review window starts                | Refund after delivery                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow:receptum-evm`      | one hybrid machine: after delivery the buyer or evaluator may accept at any time and reject only within the window; anyone may release after it | at delivery                         | by buyer/evaluator rejection within the window, or voluntarily by the seller (`sellerRefund`)                                                                   |
| `escrow:receptum-soroban`  | the same hybrid machine as `escrow:receptum-evm` (buyer, evaluator, auto)                                                                       | at delivery                         | by buyer/evaluator rejection within the window, or voluntarily by the seller (`seller_refund`); undelivered escrows are refundable by anyone after the deadline |
| `escrow:xrpl`              | buyer (holder of the fulfillment); evaluator is not provable on-ledger (§7.3)                                                                   | n/a (release needs the fulfillment) | yes, after `CancelAfter`                                                                                                                                        |
| `escrow:stellar-claimable` | buyer, auto                                                                                                                                     | at the delivery deadline            | yes, by the buyer within its claim window — which also bounds the buyer's refund right when nothing was delivered                                               |

## 8. Test vectors

`spec/vectors/rrf-v1.json` contains receipts, their JCS bytes, hashes and JWS proofs generated from the RFC 8032 §7.1 TEST 1 seed (public; testing only), and `invalid` cases that every verifier MUST reject: signed receipts that MUST fail level 2 (a validly signed JWS header with a duplicate member, a malleated `S ≥ L` signature, extra envelope or proof members, a non-array `bindings`, an evaluator outside evaluator mode, a DID payee, a 10-digit fraction, a remedy without `kind`) and receipt files that are not I-JSON (§6.1). `spec/vectors/account-binding-v1.json` contains one account binding per namespace (§4.1) with the statement's JCS bytes, plus an invalid binding that MUST fail; its chain keys are public test values (anvil default account #0, the XRPL genesis key derived from the passphrase `masterpassphrase`, the RFC 8032 seed as a Stellar key). All signatures are deterministic (Ed25519; RFC 6979 ECDSA), so implementations SHOULD reproduce every vector byte for byte. Both files are generated by `scripts/gen-vectors.mjs`. `spec/vectors/xrpl-currency-v1.json` lists XRPL currency codes with their 160-bit identities (§7.3), or `null` where the code MUST be rejected.

### Implementations

| Implementation                                      | Language   | Scope                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@receptum/core`, `@receptum/verify`](../packages) | TypeScript | Reference: create, sign and verify. Level 3 for `x402:exact` (EVM, Stellar testnet, XRPL), `escrow:receptum-evm`, `escrow:receptum-soroban`, `escrow:xrpl` (testnet), `escrow:stellar-claimable`; anchors on EVM, XRPL testnet and Stellar testnet        |
| [`receptum-verify`](../verifiers/python)            | Python     | Independent verifier written from this spec only: levels 1, 2 and 2.5 (all three binding namespaces, XRPL online), level 3 for `x402:exact` on EVM and XRPL, `anchor:evm` and `anchor:xrpl`; every other rail or anchor network is reported `unavailable` |

Both implement §6 identically: the same verdicts, the same check results and the same input rules, so that a receipt they can both check gets the same verdict. A rail one of them does not support yields PARTIALLY VERIFIED there, never VERIFIED.

## 9. Privacy

Receipts are pseudonymous by design: parties are identified only by wallet accounts (CAIP-10) and the seller's public key (`did:key`) — never by name, email or other personal data. `seller.name` is an optional, non-empty display label. `payment.payee` and `payment.payer` are the same public addresses that already appear in the settlement on-chain.

Receipts MUST NOT contain media, prompts, personal data or raw job ids. Because inputs are hashed, low-entropy inputs could be guessed by brute force; sellers SHOULD salt or avoid publishing hashes of guessable inputs.

## 10. Security considerations

- **Confirmation depth.** A level-3 pass means the settlement or anchor was found mined (EVM) or in a validated ledger (XRPL) or successful (Stellar/Horizon) when the verifier looked. RRF v1 claims no finality: a chain reorganisation can still remove a recently mined EVM transaction. Verifiers SHOULD report the block or ledger number they relied on, so that a relying party can apply its own confirmation-depth policy, and relying parties that need finality SHOULD re-verify after their chosen depth.
- **Settlement time and `deliveredAt`.** There is no required relation between when the payment settled and `deliveredAt`, and verifiers MUST NOT fail a receipt over their order: x402 settles before the response is delivered, while escrows settle after delivery (on acceptance or after the review window); `deliveredAt` is the seller's own signed statement, and block and ledger times come from other clocks. What a verifier can rely on is the anchor (or the escrow's commitment), which proves the receipt existed by its block time.
- **Double issuance.** Nothing stops a seller from signing several receipts that name the same `payment.reference` (for example two deliveries claimed against one payment). Each such receipt verifies on its own. Verifiers given a set of receipts SHOULD warn when two of them share a `payment.network` and `payment.reference`; consumers that count payments, deliveries or revenue MUST de-duplicate by payment reference rather than by receipt.
- **Anchors are not authorship** (§7.1): anyone can anchor any `receiptHash`.
- **Parser differentials.** Verifiers reject non-I-JSON input (§6.1) and duplicate JWS header members (§4) so that every conforming implementation sees the same receipt and header.
