# receptum-verify (Python)

An independent, second-language verifier for the [Receptum Receipt Format v1](../../docs/SPEC.md).
It was written from `docs/SPEC.md`, `spec/vectors/rrf-v1.json` and
`spec/vectors/account-binding-v1.json` — not ported from the TypeScript packages — so a
receipt can be checked without trusting any Receptum JavaScript code. Where the SPEC leaves a
rail's on-chain encoding to its reference adapter (the escrow contracts' storage layouts, the
claimable-balance predicates, XRPL delivery memos), those formats were taken from the adapters and
re-implemented here by hand, and are pinned by tests to the published artifacts (EVM runtime code,
Soroban wasm, trusted deployments). It reaches the same verdict as `@receptum/verify` on every
published receipt (`scripts/verify_examples.py`).

- Python ≥ 3.11, one dependency: [`cryptography`](https://cryptography.io) (pinned) for Ed25519.
- JCS (RFC 8785), base58btc, `did:key`, base64url and JSON-RPC are implemented with the standard
  library. Online checks use plain JSON-RPC over `urllib` (no web3).
- For account bindings, Keccak-256 (not `hashlib.sha3_256`), RIPEMD-160 and secp256k1 public-key
  recovery/verification are implemented in pure Python (`hashes.py`, `secp256k1.py`); they only
  ever handle public data.
- XDR (Soroban ledger keys and entries, Stellar Asset Contract ids), StrKey and ABI encoding are
  hand-written subsets of what the checks need.
- Not published to PyPI; install from this repository.

## Install

```sh
cd verifiers/python
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
```

## CLI

```sh
python -m receptum_verify <receipt.json> [file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract>]... [--offline] [--allow-unbound] [--json] [--rpc <caip2>=<url>]... [--horizon <caip2>=<url>]...
```

Default endpoints: `eip155:84532` (Base Sepolia) and `eip155:5042002` (Arc testnet) JSON-RPC,
`xrpl:1` rippled JSON-RPC, and for `stellar:testnet` Horizon (`--horizon`) and Soroban RPC
(`--rpc stellar:testnet=<url>`). `--trust-escrow` adds a ReceptumEscrow deployment (EVM address or
Soroban contract id) to the built-in trusted registry.

`receipt.json` is either a bare signed receipt (`{ receipt, receiptHash, proof, bindings? }`) or a
wrapper object with a `signedReceipt` member (SPEC §6.1). The wrapper's `anchor` — one
`<caip2>:<tx>` string or an array of them — is checked together with every `--anchor` (an anchor
is bound to the recomputed `receiptHash`, so the wrapper does not need to be trusted); any other
`anchor` value is an input error. The wrapper's other members are informational.

```sh
$ python -m receptum_verify ../../examples/x402-base-sepolia.json ../../examples/x402-base-sepolia-output.svg
=== TESTNET receipt (eip155:84532) — test tokens, no real value ===
VERIFIED
  receiptHash  11e739252cc2d6e76adf0819a9f3914c6c49fbdbc6a572c424786b792658ee5b
  seller       did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
  network      eip155:84532 (testnet)
  L1 file        PASS        SHA-256(file) = outputSha256 = 301917f6…6544234a
  L2 signature   PASS        receiptHash recomputed and JWS verifies against did:key:z6Mkqc7R…
  L2.5 binding   PASS        did:key:z6Mkqc7R… ↔ eip155:84532:0x6344…328B: EIP-191 signature recovers 0x6344…328B (offline)
  L3 settlement  PASS        tx 0x778f0a7d…bcf0b86b succeeded; Transfer 250000 of 0x036CbD53… 0x62e5… -> 0x6344…
  L3 anchor      PASS        eip155:5042002 tx 0xa546047c…28e04b70 commits receiptHash (block 65317884, …)
```

A PARTIALLY VERIFIED report ends with one `missing:` line per piece that prevented VERIFIED, e.g.
for `examples/x402-stellar-testnet.json` without its delivered file:

```text
  missing: L1: no file given — the output was not compared with outputSha256
```

Exit codes: `0` VERIFIED, `1` NOT VERIFIED, `2` usage or unreadable/invalid JSON input,
`3` PARTIALLY VERIFIED.

## What is checked

| Level                         | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input                         | Strict I-JSON (SPEC §6.1): UTF-8 without BOM, no duplicate member names, no lone surrogates, no NaN/Infinity or out-of-range numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L1 file                       | `SHA-256(file) == outputSha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L2 signature                  | SPEC §2 schema (exact members, types, §2.1 identity expressions, §2.2 timestamp profile with 1–9 fractional digits, `remedy.kind` required, `acceptance.evaluator` only in evaluator mode); the signed-receipt envelope (exactly `receipt`/`receiptHash`/`proof`, optional `bindings` array — `null` and `[]` count as absent); `receiptHash` recomputed from JCS; detached JWS with exactly 3 segments and an empty payload, header I-JSON with members exactly `alg`/`kid`/`typ` (`EdDSA`, `receptum+jws`), `kid` = `<seller did:key>#<multibase key>`, canonical unpadded 64-byte signature with `S < L`. A CAIP-10 `seller.id` cannot carry a JWS proof and fails                                |
| L2.5 binding                  | SPEC §4.1, only when `payment.payee` is present. Some binding in `bindings` (the first 16 are examined) must have exactly `statement`/`didProof`/`accountProof`; a statement with exactly the allowed string members; a `didProof` JWS as for L2 but with `typ` `receptum-binding+jws` over `JCS(statement)`, by `statement.did`; and an `accountProof` for the account's namespace (below). It covers the receipt when `statement.did == seller.id`, `statement.account == payment.payee` (EVM address case-insensitive, everything else exact), `expiresAt` (if any) is after `deliveredAt`, and `issuedAt` is at most 5 minutes in the future                                                     |
| L3 settlement (EVM x402)      | `x402:exact` on `eip155:*` (SPEC §7.3): `payment.asset` must be the token contract address and `payment.reference` a transaction hash (otherwise fail); the RPC serves the right chain id (otherwise unavailable), the transaction at `payment.reference` is mined with status success, and it emitted an ERC-20 `Transfer` of exactly `payment.amount` of token `payment.asset` to `payment.payee` (and from `payment.payer` when stated). Other `x402:*` schemes are `unavailable`                                                                                                                                                                                                                 |
| L3 settlement (XRPL x402)     | `x402:exact` on `xrpl:*` (`xrpl_x402.py`): `tx` at `payment.reference` is `validated`, `tesSUCCESS`, a `Payment` with `Account` = payer and `Destination` = payee, and `meta.delivered_amount` (not `Amount`) equals `payment.amount` XRP drops. Issued tokens are unsupported in RRF v1: another currency (160-bit identity, case-sensitive 3-character codes) or issuer fails, a match is `unavailable`; see SPEC §7.3                                                                                                                                                                                                                                                                             |
| L3 settlement (Stellar x402)  | `x402:exact` on `stellar:testnet` (`stellar.py`): `payment.reference` is 64 lower-case hex and `payment.asset` `native`, `CODE:ISSUER` or a `C…` contract (otherwise fail); the Horizon transaction is successful and an `invoke_host_function` operation's `asset_balance_changes` record a `transfer` of exactly `payment.amount` (7-decimal units) of that asset — compared by Stellar Asset Contract id, computed from the asset XDR and the network id — to the payee (from the payer when stated). Unknown to Horizon fails                                                                                                                                                                    |
| L3 `escrow:receptum-evm`      | `evm_escrow.py`: the reference is `<caip2>:<contract>:<id>` on `payment.network`; keccak-256 of `eth_getCode` equals the published ReceptumEscrow runtime code (vendored hash, pinned to `packages/adapter-evm/src/artifact.ts`); `escrows(id)` read by a hand-encoded `eth_call`; committed `receiptHash`, amount, token, buyer, seller, review window and evaluator (absent unless evaluator mode) must match; released passes, delivered is `pending`, anything else fails; a deployment outside the trusted registry (`TRUSTED_EVM_ESCROWS` mirrors the TypeScript `TRUSTED_ESCROWS`, plus `--trust-escrow`) is `pending`                                                                        |
| L3 `escrow:receptum-soroban`  | `soroban.py`: the reference is `stellar:testnet:<C…>:<id>`; Soroban RPC `getNetwork` must be testnet; `getLedgerEntries` for the contract instance gives its executable wasm hash, which must be the published `0dc6b174…` (pinned to the wasm file); the persistent `DataKey::Escrow(id)` entry must decode (hand-written XDR) to exactly the contract's `Escrow` struct; terms (token = the asset's SAC), status and committed `receipt_hash` as for EVM; same trusted-registry rule                                                                                                                                                                                                               |
| L3 `escrow:xrpl`              | `xrpl_escrow.py`, from validated history (SPEC §7, §7.3): settlement from the `EscrowFinish`/`EscrowCancel` that deleted the escrow; delivery = the first seller memo for the escrow after the `EscrowCreate` (ledger, then transaction index), at or before `CancelAfter`, before settlement; amount, asset (protocol identity), buyer and seller match; buyer mode needs a `Condition` and `CancelAfter − delivery close ≥ reviewWindowSeconds`; evaluator mode is at best `unavailable`; auto fails on a conditional escrow and is `unavailable` otherwise. A page limit reached or history not reaching the owner's creation is `unavailable`; not found after a complete history fails          |
| L3 `escrow:stellar-claimable` | `stellar_claimable.py`, from Horizon history: the balance must have exactly the Receptum claimants (seller `not(before(releaseAt))`, buyer `not(before(deadline)) and before(releaseAt)`); delivery = the first successful seller transaction after creation and before the deadline with `MEMO_HASH = h` that writes the data entry named by the balance hash with value `h`; claimed by the seller = released, by the buyer = released only if the same transaction pays the seller exactly (payments allocated to batch-claimed escrows in operation order, one payment per escrow), else refunded; amount, asset, parties and review window (`releaseAt − deadline`) match; evaluator mode fails |
| L3 anchor (`anchor:evm`)      | SPEC §7.1, every anchor from the wrapper and `--anchor`: `<caip2>:<tx>` with a CAIP-2 network; the anchor transaction is mined, successful, zero-value, and its calldata is exactly `utf8("receptum/1") ‖ receiptHash` (32 raw bytes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| L3 anchor (`anchor:xrpl`)     | `xrpl:<id>:<tx>`: a validated `tesSUCCESS` transaction whose first `receptum/1` memo carries exactly the receiptHash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L3 anchor (`anchor:stellar`)  | `stellar:testnet:<64 lower-case hex>`: a successful Horizon transaction with memo type `hash` whose 32 bytes are the receiptHash; unknown to Horizon fails. Other anchor networks are `unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Account proofs by namespace (an unsupported namespace fails closed):

| Namespace | `accountProof.type` | Verification                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eip155`  | `eip191`            | `signature` is 65 bytes of lower-case `0x` hex, `v ∈ {27, 28}`, low-s; the secp256k1 key recovered from `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ m)` must hash to the account address. Offline. EOAs only                                                                                                                                                                             |
| `xrpl`    | `xrpl`              | upper-case hex; Ed25519 (`ED` ‖ 32 bytes) over `m`, or secp256k1 (`02`/`03` ‖ 32 bytes) over `SHA-512Half(m)` with strict DER and low-s. **Offline:** the key must derive (SHA-256 → RIPEMD-160 → base58check, ripple alphabet) to the account: its master key. **Online:** `account_info` on the validated ledger; the master key unless `lsfDisableMaster` is set, or the current `RegularKey` |
| `stellar` | `sep53`             | `signature` is 64 bytes, canonical padded base64; Ed25519 over `SHA-256("Stellar Signed Message:\n" ‖ m)` by the G… address (StrKey checksum verified). Offline                                                                                                                                                                                                                                  |

The online XRPL check runs for `xrpl:1` (testnet, `https://s.altnet.rippletest.net:51234`) unless
`--offline`; other XRPL networks use the offline rule unless an endpoint is given with
`--rpc xrpl:0=<url>`.

Each check is `pass`, `fail` (the evidence contradicts the receipt, or the receipt breaks a MUST),
`skipped` (not requested or not applicable: no file, offline, no payee, `--allow-unbound`),
`pending` (genuine but not final: an escrow delivered but not yet released, a genuine escrow
contract at an untrusted deployment, or L2.5 when the receipt carries no binding at all, so
nothing proves the seller controls the payee) or `unavailable` (could not be performed:
unsupported rail or anchor network, no `payment.payee`, an RPC error or an RPC serving another
chain — for L2.5, the XRPL `account_info` lookup failed or was not from a validated ledger). An
`unavailable` check is never a pass and never a failure (SPEC §6).

## Verdicts

The SPEC §6 rules, identical in the TypeScript `@receptum/verify`:

- **NOT VERIFIED** — any check failed.
- **VERIFIED** — no check failed and none is pending or unavailable, and: the file matches (L1;
  a file must be given), the seller signed the receipt (L2), the seller proved it controls the
  payee (L2.5; `skipped` only when the receipt names no payee or with `--allow-unbound`), the
  payment settled on its rail to the payee, and `receiptHash` is committed on-chain — by the
  escrow rail itself, or, for `x402:exact`, whose settlement predates the receipt, by a passing
  anchor.
- **PARTIALLY VERIFIED** — otherwise (offline mode, no file, no anchor, no account binding,
  unsupported rail, RPC unavailable), with a `missing:` line for each piece. Anchors alone never
  yield VERIFIED.

`--allow-unbound` is the SPEC §6 opt-out for legacy receipts issued before account bindings: a
receipt with no binding at all reports L2.5 `skipped` ("allowed: --allow-unbound") instead of
`pending`. Bindings that are present but invalid still fail.

Coverage matches the TypeScript verifier: every rail and anchor it checks is checked here, so
both reach the same verdict on every published receipt.

| Rail / anchor              | Networks                                                      | Python | TypeScript |
| -------------------------- | ------------------------------------------------------------- | ------ | ---------- |
| `x402:exact`               | `eip155:84532`, `eip155:5042002` (any EVM chain with `--rpc`) | yes    | yes        |
| `x402:exact`               | `stellar:testnet`                                             | yes    | yes        |
| `x402:exact`               | `xrpl:1` (other XRPL networks with `--rpc`)                   | yes    | yes        |
| `escrow:receptum-evm`      | `eip155:5042002` (trusted), Base Sepolia                      | yes    | yes        |
| `escrow:receptum-soroban`  | `stellar:testnet`                                             | yes    | yes        |
| `escrow:xrpl`              | `xrpl:1`                                                      | yes    | yes        |
| `escrow:stellar-claimable` | `stellar:testnet`                                             | yes    | yes        |
| `anchor:evm`               | any EVM chain with an RPC                                     | yes    | yes        |
| `anchor:xrpl`              | `xrpl:1`                                                      | yes    | yes        |
| `anchor:stellar`           | `stellar:testnet`                                             | yes    | yes        |

Re-verify every published receipt against live testnets (the cases and expected verdicts of
`scripts/verify-examples.mjs`):

```sh
python scripts/verify_examples.py
```

## Tests

```sh
pytest -m "not online"        # offline: RFC 8785 examples, every spec vector byte for byte (and every invalid one rejected), bindings, SPEC alignment, live receipt offline, tampered receipt
pytest -m online              # every published receipt against Base Sepolia, Arc, XRPL and Stellar testnets (skipped if unreachable)
RECEPTUM_OFFLINE=1 pytest     # force-skip online tests
```

The vector tests re-derive the seller `did:key` from the RFC 8032 §7.1 TEST 1 seed, reproduce the
JCS bytes and `receiptHash` of every vector, and re-sign each receipt to reproduce its JWS exactly
(Ed25519 is deterministic). The binding tests do the same for every account binding: they derive
the anvil #0 address, the XRPL genesis key from `masterpassphrase` (ripple-keypairs secp256k1
derivation) and the Stellar key, and re-sign each statement with Ed25519 and RFC 6979 ECDSA to
reproduce `didProof` and `accountProof` byte for byte. Negative tests cover a wrong account, a
wrong seller DID, expiry at `deliveredAt`, future `issuedAt`, high-s signatures (EVM and XRPL),
non-canonical DER and base64, a disabled XRPL master key and tampered statements.
Each rail has mocked-RPC unit tests (`test_evm_escrow.py`, `test_soroban.py`, `test_xrpl_escrow.py`,
`test_stellar_claimable.py`, `test_stellar.py`): success and every failure mode — wrong runtime code
or wasm, untrusted deployment, wrong terms, not released, wrong payee, first-delivery-wins, batch
claims, and truncated history (`unavailable`). `test_online_rails.py` runs the published cases
online. `tests/test_spec_alignment.py` pins each decision of the SPEC alignment with the TypeScript
verifier (verdicts, wrapper anchors, anchor references, x402 schemes, validated XRPL ledgers,
envelope, identity expressions — including that no pattern accepts a trailing newline —, remedy
and evaluator rules, timestamps and integers).

## Library

```python
from receptum_verify import extract_signed_receipt, loads_strict, verify

doc = loads_strict(open("receipt.json", "rb").read())
signed, anchors = extract_signed_receipt(doc)
report = verify(signed, open("output.svg", "rb").read(), anchor=anchors)
print(report.status, report.missing, report.to_dict())
```

## Mainnet receipts

Mainnet endpoints are built in (`eip155:8453` `https://mainnet.base.org`, `eip155:5042` `https://rpc.mainnet.arc.io`, `xrpl:0` `https://xrplcluster.com`); x402 `exact` settlements there are checked out of the box, and the RPC's chain id / NetworkID is still checked against the receipt. The CLI's first line labels the network — `=== MAINNET receipt (…) — real funds ===` or `=== TESTNET receipt (…) — test tokens, no real value ===` — and `--json` reports `network` and `networkClass`. `TRUSTED_ESCROWS` (in `networks.py`) mirrors `@receptum/verify`: the mainnet entries are empty until a deployment is published, so mainnet escrow receipts report `untrusted deployment` (`unavailable`; this verifier does not read escrow state).
