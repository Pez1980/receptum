# @receptum/core

Receptum Receipt Format v1 ([spec](../../docs/SPEC.md)).

- `createReceipt` / `receiptHash` / `receiptBytes` — build a receipt and its JCS (RFC 8785) hash. Raw job ids are hashed, never published.
- `generateSellerKey` / `sellerKeyFromPem` / `signReceipt` / `verifySignedReceipt` — Ed25519 `did:key` seller signatures as detached JWS; verifies offline.
- `sha256File` — streaming file hash for large media.
- Job lifecycle (`quoted → paid|escrowed → delivered → released|refunded`) with enforced transitions.
- `PaymentRail`, `EscrowRail`, `Anchor`, `EscrowCapabilities` — implemented by the chain adapters.

Test vectors: `spec/vectors/rrf-v1.json` (RFC 8032 test seed — public, testing only).
