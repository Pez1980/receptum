# Receptum Receipt Format (RRF) v1

**Status:** draft · October 2026 · Apache-2.0
**Version string:** `receptum/1`

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119.

## 1. Purpose

A Receptum receipt binds a payment to the exact inputs and output of a paid job. It is issued and signed by the seller on delivery. Only hashes are published; the work itself never is.

A receipt proves **which** output was delivered for **which** payment, by **whom**, and under **which acceptance and remedy terms**. It does not prove the output is good — quality is decided by the acceptance mode the receipt records.

## 2. Receipt object

A receipt is a JSON object with these members:

| Member                           | Type                              | Req.                     | Meaning                                                                                                                     |
| -------------------------------- | --------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `version`                        | string                            | MUST                     | `"receptum/1"`                                                                                                              |
| `receiptId`                      | string                            | MUST                     | `RCPT-XXXX-XXXX`, Crockford base32 upper-case                                                                               |
| `jobIdHash`                      | hex64                             | MUST                     | SHA-256 of the seller's internal job id (the id itself MUST NOT be published)                                               |
| `seller.id`                      | string                            | MUST                     | `did:key` (Ed25519) of the signer, or a CAIP-10 account for chain-native proofs                                             |
| `seller.name`                    | string                            | MAY                      | Display name                                                                                                                |
| `buyer.id`                       | string                            | MAY                      | CAIP-10 account or DID                                                                                                      |
| `inputSha256`                    | hex64[]                           | MUST                     | One or more input hashes                                                                                                    |
| `outputSha256`                   | hex64                             | MUST                     | Hash of the delivered artifact                                                                                              |
| `evidence`                       | {string: hex64}                   | MAY                      | Supporting evidence hashes, e.g. `qaReport`                                                                                 |
| `payment.rail`                   | string                            | MUST                     | e.g. `x402:exact`, `escrow:receptum-evm`, `escrow:xrpl`, `escrow:stellar-claimable`                                         |
| `payment.network`                | string                            | MUST                     | CAIP-2 id, e.g. `eip155:84532`, `stellar:testnet`, `xrpl:1`                                                                 |
| `payment.asset`                  | string                            | MUST                     | Symbol or asset identifier                                                                                                  |
| `payment.amount`                 | string                            | MUST                     | Non-negative integer in the asset's smallest unit                                                                           |
| `payment.reference`              | string                            | MUST                     | Rail reference: tx hash, escrow id, or payment proof id                                                                     |
| `payment.payer`                  | string                            | MAY                      | CAIP-10 payer account                                                                                                       |
| `payment.payee`                  | string                            | SHOULD                   | CAIP-10 account that receives the funds; verifiers check the settlement went to it                                          |
| `acceptance.mode`                | `buyer` \| `evaluator` \| `auto`  | MUST                     | How delivery is accepted                                                                                                    |
| `acceptance.reviewWindowSeconds` | integer ≥ 0                       | MUST                     | Window after delivery during which delivery can be rejected                                                                 |
| `acceptance.evaluator`           | string                            | MUST if mode = evaluator | Evaluator identity                                                                                                          |
| `remedy.kind`                    | `rerender` \| `refund` \| `terms` | MAY                      | Seller's commitment for defects found after release                                                                         |
| `remedy.withinDays`              | integer                           | MAY                      | Remedy period                                                                                                               |
| `remedy.termsSha256`             | hex64                             | MUST if kind = terms     | Hash of the terms document                                                                                                  |
| `supersedes`                     | hex64                             | MAY                      | `receiptHash` of an earlier receipt this one replaces (e.g. a fixed re-render)                                              |
| `deliveredAt`                    | string                            | MUST                     | UTC timestamp, exactly `YYYY-MM-DDTHH:MM:SS[.f…]Z` (a strict RFC 3339 profile; offsets and lower-case `t`/`z` are not used) |

`hex64` is 64 lower-case hexadecimal characters. Members not listed MUST NOT be present in v1. Optional members that are absent MUST be omitted, not set to `null`.

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

- `header` is base64url of `{"alg":"EdDSA","kid":<kid>,"typ":"receptum+jws"}`.
- The JWS payload is base64url(JCS(receipt)) and is **detached** (omitted from the compact form).
- The signing input is `header || "." || payload`, signed with Ed25519 (RFC 8032).
- `kid` MUST resolve (did:key) to the key of `receipt.seller.id`.
- `bindings` is OPTIONAL and outside the signed receipt (§4.1).

Verifiers MUST recompute `receiptHash` from `receipt`, compare it to the stated `receiptHash`, and verify the signature against `seller.id`. Chain-native proofs (e.g. EIP-712) MAY be defined by adapters; they MUST sign the same `receiptHash`.

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

No other members are allowed, and every member is a string. The binding object itself has exactly `statement`, `didProof` and `accountProof`.

**Signing input.** Let `m = UTF-8( JCS(statement) )`. The `type` member inside `m` domain-separates it from receipts and chain transactions.

- **`didProof`** — a detached JWS exactly as in §4, over payload `base64url(m)`, with header `{"alg":"EdDSA","kid":<kid>,"typ":"receptum-binding+jws"}`; `kid` MUST resolve to `statement.did`.
- **`accountProof`**, by the CAIP-2 namespace of `statement.account`:

| Namespace | `accountProof`                        | Signature                                                                                                                                                                                                    | Key check                                                                                                                                                                                                       |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eip155`  | `{type:"eip191", signature}`          | EIP-191 `personal_sign(m)`: secp256k1 over `keccak256("\x19Ethereum Signed Message:\n" ‖ decimal(len(m)) ‖ m)`; `signature` = `r ‖ s ‖ v`, 65 bytes, lower-case `0x` hex, `v ∈ {27, 28}`, low-s              | The recovered address MUST equal the account (compared case-insensitively). Offline. Externally owned accounts only; contract wallets (ERC-1271) are not supported in v1                                        |
| `xrpl`    | `{type:"xrpl", publicKey, signature}` | ripple-keypairs `sign(hex(m))`: for an Ed25519 key (`publicKey` = `"ED"` ‖ 32 bytes) Ed25519 over `m`; for a secp256k1 key (`02`/`03` ‖ 32 bytes) ECDSA over `SHA-512Half(m)`, canonical DER. Upper-case hex | **Offline:** `publicKey` MUST derive to the account (its master key). **Online:** the master key, only if `lsfDisableMaster` is not set, or the account's current `RegularKey` (from `account_info`, validated) |
| `stellar` | `{type:"sep53", signature}`           | SEP-53: Ed25519 over `SHA-256("Stellar Signed Message:\n" ‖ m)`; `signature` = 64 bytes, standard padded base64                                                                                              | The key is the account's G… address itself. Offline                                                                                                                                                             |

**Carrying bindings.** A signed receipt MAY carry `"bindings": [ … ]` beside `receipt`, `receiptHash` and `proof`. Bindings are **not** part of the receipt or of `receiptHash`: adding or removing them never changes a receipt's hash or signature, and a binding can be attached to a receipt issued earlier.

**Coverage.** A binding covers a receipt when all of these hold:

1. `statement.did == receipt.seller.id` and `statement.account` equals `receipt.payment.payee` (EVM addresses compared case-insensitively; other namespaces exactly, CAIP-2 included);
2. `expiresAt` is absent or later than `receipt.deliveredAt`;
3. `issuedAt` is not more than 5 minutes ahead of the verifier's clock (it MAY be later than `deliveredAt`);
4. both `didProof` and `accountProof` verify as above.

A verifier without support for the payee's namespace MUST treat the binding as unverified (fail closed). Test vectors: `spec/vectors/account-binding-v1.json`.

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

Verifiers MUST NOT report a receipt as fully verified unless level 3 confirms the payment on its rail; anchors alone are partial evidence. When `payment.payee` is present, verifiers MUST NOT report a receipt as fully verified unless level 2.5 passes; a verifier MAY offer an explicit opt-out for legacy receipts issued before account bindings existed, and MUST then say so.

- **L1 File ↔ receipt (offline):** `SHA-256(file) == outputSha256`.
- **L2 Receipt ↔ seller (offline):** the JWS proof verifies against `seller.id`.
- **L2.5 Seller ↔ payee (offline; online for XRPL key state):** a binding in `bindings` covers the receipt (§4.1). No binding at all is _unproven_ (partial); bindings that are present but invalid are a failure.
- **L3 Receipt ↔ settlement (online):** the rail shows `receiptHash` committed and the payment settled, at `payment.reference` on `payment.network`.
- **L4 Seller ↔ real-world identity:** out of scope for v1 (e.g. `did:web`, DNS).

## 7. Anchoring

Adapters anchor `receiptHash` as follows:

| Rail                                          | Anchor                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `escrow:receptum-evm`                         | `Delivered(escrowId, receiptHash)` event of the Receptum escrow contract |
| `anchor:evm`                                  | calldata / event of a zero-value transaction                             |
| `escrow:xrpl` / `anchor:xrpl`                 | Memo `MemoType = hex("receptum/1")`, `MemoData = receiptHash`            |
| `escrow:stellar-claimable` / `anchor:stellar` | `MEMO_HASH = receiptHash`                                                |

On rails where delivery is a memo rather than contract state (`escrow:xrpl`), the delivery is the **first** successful memo transaction from the escrow's destination (the seller) that names the escrow and is ordered after its creation (by ledger index, then transaction index), with a ledger close time no later than `CancelAfter`, and before the transaction that settles the escrow. Later memos for the same escrow MUST be ignored. Settlement status comes from the `EscrowFinish` / `EscrowCancel` that removed the escrow.

### 7.1 Outputs that are not files

- **HTTP responses:** `outputSha256` is the SHA-256 of the response body bytes as delivered.
- **MCP tool results:** `outputSha256` is the SHA-256 of `JCS({ content, structuredContent?, isError? })`, where `structuredContent` and `isError` are included exactly when the result defines them (including `isError: false`); the receipt travels in `result._meta["receptum/receipt"]`.

### 7.2 Rail differences

Rails enforce acceptance differently. Adapters SHOULD publish their `EscrowCapabilities`:

| Rail                       | Acceptance modes enforced on-chain                                                                                                              | Review window starts                | Refund after delivery                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `escrow:receptum-evm`      | one hybrid machine: after delivery the buyer or evaluator may accept at any time and reject only within the window; anyone may release after it | at delivery                         | by buyer/evaluator rejection within the window, or voluntarily by the seller (`sellerRefund`) |
| `escrow:xrpl`              | buyer, evaluator (holder of the fulfillment)                                                                                                    | n/a (release needs the fulfillment) | yes, after `CancelAfter`                                                                      |
| `escrow:stellar-claimable` | buyer, auto                                                                                                                                     | at the delivery deadline            | yes, by the buyer within its claim window                                                     |

## 8. Test vectors

`spec/vectors/rrf-v1.json` contains receipts, their JCS bytes, hashes and JWS proofs generated from the RFC 8032 §7.1 TEST 1 seed (public; testing only). `spec/vectors/account-binding-v1.json` contains one account binding per namespace (§4.1) with the statement's JCS bytes, plus an invalid binding that MUST fail; its chain keys are public test values (anvil default account #0, the XRPL genesis key derived from the passphrase `masterpassphrase`, the RFC 8032 seed as a Stellar key). All signatures are deterministic (Ed25519; RFC 6979 ECDSA), so implementations SHOULD reproduce every vector byte for byte. Both files are generated by `scripts/gen-vectors.mjs`.

### Implementations

| Implementation                                      | Language   | Scope                                                                                               |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| [`@receptum/core`, `@receptum/verify`](../packages) | TypeScript | Reference: create, sign and verify; all rails and anchors                                           |
| [`receptum-verify`](../verifiers/python)            | Python     | Independent verifier written from this spec only: levels 1–2, `x402:exact` and `anchor:evm` level 3 |

## 9. Privacy

Receipts are pseudonymous by design: parties are identified only by wallet accounts (CAIP-10) and the seller's public key (`did:key`) — never by name, email or other personal data. `seller.name` is an optional, non-empty display label. `payment.payee` and `payment.payer` are the same public addresses that already appear in the settlement on-chain.

Receipts MUST NOT contain media, prompts, personal data or raw job ids. Because inputs are hashed, low-entropy inputs could be guessed by brute force; sellers SHOULD salt or avoid publishing hashes of guessable inputs.
