# Receptum Receipt Format (RRF) v1

**Status:** draft · October 2026 · Apache-2.0
**Version string:** `receptum/1`

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119.

## 1. Purpose

A Receptum receipt binds a payment to the exact inputs and output of a paid job. It is issued and signed by the seller on delivery. Only hashes are published; the work itself never is.

A receipt proves **which** output was delivered for **which** payment, by **whom**, and under **which acceptance and remedy terms**. It does not prove the output is good — quality is decided by the acceptance mode the receipt records.

## 2. Receipt object

A receipt is a JSON object with these members:

| Member                           | Type                              | Req.                     | Meaning                                                                             |
| -------------------------------- | --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `version`                        | string                            | MUST                     | `"receptum/1"`                                                                      |
| `receiptId`                      | string                            | MUST                     | `RCPT-XXXX-XXXX`, Crockford base32 upper-case                                       |
| `jobIdHash`                      | hex64                             | MUST                     | SHA-256 of the seller's internal job id (the id itself MUST NOT be published)       |
| `seller.id`                      | string                            | MUST                     | `did:key` (Ed25519) of the signer, or a CAIP-10 account for chain-native proofs     |
| `seller.name`                    | string                            | MAY                      | Display name                                                                        |
| `buyer.id`                       | string                            | MAY                      | CAIP-10 account or DID                                                              |
| `inputSha256`                    | hex64[]                           | MUST                     | One or more input hashes                                                            |
| `outputSha256`                   | hex64                             | MUST                     | Hash of the delivered artifact                                                      |
| `evidence`                       | {string: hex64}                   | MAY                      | Supporting evidence hashes, e.g. `qaReport`                                         |
| `payment.rail`                   | string                            | MUST                     | e.g. `x402:exact`, `escrow:receptum-evm`, `escrow:xrpl`, `escrow:stellar-claimable` |
| `payment.network`                | string                            | MUST                     | CAIP-2 id, e.g. `eip155:84532`, `stellar:testnet`, `xrpl:1`                         |
| `payment.asset`                  | string                            | MUST                     | Symbol or asset identifier                                                          |
| `payment.amount`                 | string                            | MUST                     | Non-negative integer in the asset's smallest unit                                   |
| `payment.reference`              | string                            | MUST                     | Rail reference: tx hash, escrow id, or payment proof id                             |
| `payment.payer`                  | string                            | MAY                      | CAIP-10 payer account                                                               |
| `payment.payee`                  | string                            | SHOULD                   | CAIP-10 account that receives the funds; verifiers check the settlement went to it  |
| `acceptance.mode`                | `buyer` \| `evaluator` \| `auto`  | MUST                     | How delivery is accepted                                                            |
| `acceptance.reviewWindowSeconds` | integer ≥ 0                       | MUST                     | Window after delivery during which delivery can be rejected                         |
| `acceptance.evaluator`           | string                            | MUST if mode = evaluator | Evaluator identity                                                                  |
| `remedy.kind`                    | `rerender` \| `refund` \| `terms` | MAY                      | Seller's commitment for defects found after release                                 |
| `remedy.withinDays`              | integer                           | MAY                      | Remedy period                                                                       |
| `remedy.termsSha256`             | hex64                             | MUST if kind = terms     | Hash of the terms document                                                          |
| `supersedes`                     | hex64                             | MAY                      | `receiptHash` of an earlier receipt this one replaces (e.g. a fixed re-render)      |
| `deliveredAt`                    | string                            | MUST                     | RFC 3339 UTC timestamp                                                              |

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
{ "receipt": { … }, "receiptHash": "<hex64>", "proof": { "type": "jws", "kid": "<did:key>#<multibase>", "jws": "<header>..<signature>" } }
```

- `header` is base64url of `{"alg":"EdDSA","kid":<kid>,"typ":"receptum+jws"}`.
- The JWS payload is base64url(JCS(receipt)) and is **detached** (omitted from the compact form).
- The signing input is `header || "." || payload`, signed with Ed25519 (RFC 8032).
- `kid` MUST resolve (did:key) to the key of `receipt.seller.id`.

Verifiers MUST recompute `receiptHash` from `receipt`, compare it to the stated `receiptHash`, and verify the signature against `seller.id`. Chain-native proofs (e.g. EIP-712) MAY be defined by adapters; they MUST sign the same `receiptHash`.

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

Verifiers MUST NOT report a receipt as fully verified unless level 3 confirms the payment on its rail; anchors alone are partial evidence.

Verifiers MUST NOT report a receipt as fully verified unless level 3 confirms the payment on its rail; anchors alone are partial evidence.

1. **File ↔ receipt (offline):** `SHA-256(file) == outputSha256`.
2. **Receipt ↔ seller (offline):** the JWS proof verifies against `seller.id`.
3. **Receipt ↔ settlement (online):** the rail shows `receiptHash` committed and the payment settled, at `payment.reference` on `payment.network`.
4. **Seller ↔ real-world identity:** out of scope for v1 (e.g. `did:web`, DNS).

## 7. Anchoring

Adapters anchor `receiptHash` as follows:

| Rail                                          | Anchor                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `escrow:receptum-evm`                         | `Delivered(escrowId, receiptHash)` event of the Receptum escrow contract |
| `anchor:evm`                                  | calldata / event of a zero-value transaction                             |
| `escrow:xrpl` / `anchor:xrpl`                 | Memo `MemoType = hex("receptum/1")`, `MemoData = receiptHash`            |
| `escrow:stellar-claimable` / `anchor:stellar` | `MEMO_HASH = receiptHash`                                                |

### 7.1 Outputs that are not files

- **HTTP responses:** `outputSha256` is the SHA-256 of the response body bytes as delivered.
- **MCP tool results:** `outputSha256` is the SHA-256 of `JCS({ content, structuredContent?, isError? })` (members present only when set); the receipt travels in `result._meta["receptum/receipt"]`.

### 7.2 Rail differences

Rails enforce acceptance differently. Adapters SHOULD publish their `EscrowCapabilities`:

| Rail                       | Acceptance modes enforced on-chain                                                                      | Review window starts                | Refund after delivery                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `escrow:receptum-evm`      | one hybrid machine: buyer or evaluator may accept/reject within the window; anyone may release after it | at delivery                         | by buyer/evaluator rejection within the window, or voluntarily by the seller (`sellerRefund`) |
| `escrow:xrpl`              | buyer, evaluator (holder of the fulfillment)                                                            | n/a (release needs the fulfillment) | yes, after `CancelAfter`                                                                      |
| `escrow:stellar-claimable` | buyer, auto                                                                                             | at the delivery deadline            | yes, by the buyer within its claim window                                                     |

## 8. Test vectors

`spec/vectors/rrf-v1.json` contains receipts, their JCS bytes, hashes and JWS proofs generated from the RFC 8032 §7.1 TEST 1 seed (public; testing only). Implementations SHOULD reproduce every vector byte for byte.

## 9. Privacy

Receipts are pseudonymous by design: parties are identified only by wallet accounts (CAIP-10) and the seller's public key (`did:key`) — never by name, email or other personal data. `seller.name` is an optional display label. `payment.payee` and `payment.payer` are the same public addresses that already appear in the settlement on-chain.

Receipts MUST NOT contain media, prompts, personal data or raw job ids. Because inputs are hashed, low-entropy inputs could be guessed by brute force; sellers SHOULD salt or avoid publishing hashes of guessable inputs.
