# @receptum/core

Receptum Receipt Format v1 ([spec](../../docs/SPEC.md)).

- `createReceipt` / `receiptHash` / `receiptBytes` — build a receipt and its JCS (RFC 8785) hash. Raw job ids are hashed, never published.
- `generateSellerKey` / `sellerKeyFromPem` / `signReceipt` / `verifySignedReceipt` — Ed25519 `did:key` seller signatures as detached JWS; verifies offline.
- Account bindings (SPEC §4.1): `createAccountBinding`, `verifyAccountBinding`, `checkPayeeBinding(signedReceipt)` — prove the seller's did:key controls `payment.payee`. Chain verifiers implement `BindingVerifier` per CAIP-2 namespace (`registerBindingVerifier`, or pass `verifiers`); Stellar (SEP-53) is built in, EVM and XRPL ship with their adapters. Bindings travel in `SignedReceipt.bindings`, outside `receiptHash`.
- `sha256File` — streaming file hash for large media.
- Job lifecycle (`quoted → paid|escrowed → delivered → released|refunded`) with enforced transitions.
- `PaymentRail`, `EscrowRail`, `Anchor`, `EscrowCapabilities` — implemented by the chain adapters.

Test vectors: `spec/vectors/rrf-v1.json` and `spec/vectors/account-binding-v1.json` (public test keys only).
