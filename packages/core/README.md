# @receptum/core

Chain-agnostic building blocks shared by every Receptum rail:

- `createReceipt` / `receiptHash` — build a delivery receipt from input and output hashes and get the single SHA-256 value that goes on-chain. Raw job ids are hashed, never published.
- `canonicalJson` — deterministic JSON so every party hashes identical bytes.
- `sha256File` — streaming file hash for large media.
- Job lifecycle (`quoted → paid|escrowed → delivered → released|refunded`) with enforced transitions.
- `PaymentRail`, `EscrowRail` and `Anchor` interfaces that each chain adapter implements.

**Status:** usable, pre-1.0 — APIs may change.
