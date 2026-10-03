# receptum-verify (Python)

An independent, second-language verifier for the [Receptum Receipt Format v1](../../docs/SPEC.md).
It was written from `docs/SPEC.md`, `spec/vectors/rrf-v1.json` and
`spec/vectors/account-binding-v1.json` only — not ported from the TypeScript packages — so a
receipt can be checked without trusting any Receptum JavaScript code.

- Python ≥ 3.11, one dependency: [`cryptography`](https://cryptography.io) (pinned) for Ed25519.
- JCS (RFC 8785), base58btc, `did:key`, base64url and JSON-RPC are implemented with the standard
  library. Online checks use plain JSON-RPC over `urllib` (no web3).
- For account bindings, Keccak-256 (not `hashlib.sha3_256`), RIPEMD-160 and secp256k1 public-key
  recovery/verification are implemented in pure Python (`hashes.py`, `secp256k1.py`); they only
  ever handle public data.
- Not published to PyPI; install from this repository.

## Install

```sh
cd verifiers/python
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
```

## CLI

```sh
python -m receptum_verify <receipt.json> [file] [--anchor <caip2>:<tx>] [--offline] [--allow-unbound] [--json] [--rpc <caip2>=<url>]
```

`receipt.json` is either a bare signed receipt (`{ receipt, receiptHash, proof, bindings? }`) or an object
with a `signedReceipt` member. If such a wrapper also has a string `anchor` member and `--anchor`
is not given, that anchor is checked (an anchor is bound to the recomputed `receiptHash`, so the
wrapper does not need to be trusted).

```sh
$ python -m receptum_verify ../../examples/x402-base-sepolia.json ../../examples/x402-base-sepolia-output.svg
VERIFIED
  receiptHash  11e739252cc2d6e76adf0819a9f3914c6c49fbdbc6a572c424786b792658ee5b
  seller       did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
  L1 file        PASS        SHA-256(file) = outputSha256 = 301917f6…6544234a
  L2 signature   PASS        receiptHash recomputed and JWS verifies against did:key:z6Mkqc7R…
  L2.5 binding   PASS        did:key:z6Mkqc7R… ↔ eip155:84532:0x6344…328B: EIP-191 signature recovers 0x6344…328B (offline)
  L3 settlement  PASS        tx 0x778f0a7d…bcf0b86b succeeded; Transfer 250000 of 0x036CbD53… 0x62e5… -> 0x6344…
  L3 anchor      PASS        eip155:5042002 tx 0xa546047c…28e04b70 commits receiptHash
```

Exit codes: `0` VERIFIED, `1` NOT VERIFIED, `2` usage or unreadable/invalid JSON input,
`3` PARTIALLY VERIFIED.

## What is checked

| Level                     | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| input                     | Strict I-JSON: UTF-8, no duplicate member names, no lone surrogates, no NaN/Infinity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L1 file                   | `SHA-256(file) == outputSha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L2 signature              | SPEC §2 schema (exact members, types, timestamp profile, identity syntax); `receiptHash` recomputed from JCS; detached JWS with exactly 3 segments and an empty payload, header members exactly `alg`/`kid`/`typ` (`EdDSA`, `receptum+jws`), `kid` = `<seller did:key>#<multibase key>`, canonical unpadded 64-byte signature with `S < L`                                                                                                                                                                                                                                                                                                       |
| L2.5 binding              | SPEC §4.1, only when `payment.payee` is present. Some binding in `bindings` (the first 16 are examined) must have exactly `statement`/`didProof`/`accountProof`; a statement with exactly the allowed string members; a `didProof` JWS as for L2 but with `typ` `receptum-binding+jws` over `JCS(statement)`, by `statement.did`; and an `accountProof` for the account's namespace (below). It covers the receipt when `statement.did == seller.id`, `statement.account == payment.payee` (EVM address case-insensitive, everything else exact), `expiresAt` (if any) is after `deliveredAt`, and `issuedAt` is at most 5 minutes in the future |
| L3 settlement             | `x402:exact` on `eip155:*` (default RPC for `eip155:84532`): the RPC serves the right chain id, the transaction at `payment.reference` is mined with status success, and it emitted an ERC-20 `Transfer` of exactly `payment.amount` of token `payment.asset` to `payment.payee` (and from `payment.payer` when stated)                                                                                                                                                                                                                                                                                                                          |
| L3 settlement (XRPL)      | `x402:exact` on `xrpl:*` (default RPC for `xrpl:1`, `xrpl_x402.py`): `tx` at `payment.reference` is `validated`, `tesSUCCESS`, a `Payment` with `Account` = payer and `Destination` = payee, and `meta.delivered_amount` (not `Amount`) equals `payment.amount` in `payment.asset` (`XRP` drops, or `<currency>.<issuer>` decimal value); see `docs/rails/x402-xrpl.md`                                                                                                                                                                                                                                                                          |
| L3 anchor (`anchor:evm`)  | default RPC for `eip155:5042002`: the anchor transaction is mined, successful, zero-value, and its calldata is exactly `utf8("receptum/1") ‖ receiptHash` (32 raw bytes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| L3 anchor (`anchor:xrpl`) | `xrpl:<id>:<tx>`: a validated `tesSUCCESS` transaction whose first `receptum/1` memo carries exactly the receiptHash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Account proofs by namespace (an unsupported namespace fails closed):

| Namespace | `accountProof.type` | Verification                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eip155`  | `eip191`            | `signature` is 65 bytes of lower-case `0x` hex, `v ∈ {27, 28}`, low-s; the secp256k1 key recovered from `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ m)` must hash to the account address. Offline. EOAs only                                                                                                                                                                             |
| `xrpl`    | `xrpl`              | upper-case hex; Ed25519 (`ED` ‖ 32 bytes) over `m`, or secp256k1 (`02`/`03` ‖ 32 bytes) over `SHA-512Half(m)` with strict DER and low-s. **Offline:** the key must derive (SHA-256 → RIPEMD-160 → base58check, ripple alphabet) to the account: its master key. **Online:** `account_info` on the validated ledger; the master key unless `lsfDisableMaster` is set, or the current `RegularKey` |
| `stellar` | `sep53`             | `signature` is 64 bytes, canonical padded base64; Ed25519 over `SHA-256("Stellar Signed Message:\n" ‖ m)` by the G… address (StrKey checksum verified). Offline                                                                                                                                                                                                                                  |

The online XRPL check runs for `xrpl:1` (testnet, `https://s.altnet.rippletest.net:51234`) unless
`--offline`; other XRPL networks use the offline rule unless an endpoint is given with
`--rpc xrpl:0=<url>`.

Each check is `pass`, `fail` (the evidence contradicts the receipt), `skipped` (not requested or
not possible offline), `pending` (L2.5 only: the receipt carries no binding at all, so nothing
proves the seller controls the payee) or `unavailable` (could not be checked: unsupported rail, a
symbolic `payment.asset`, no `payment.payee`, or an RPC error — for L2.5, the XRPL `account_info`
lookup failed).

## Verdicts

- **NOT VERIFIED** — any check failed.
- **VERIFIED** — every check passed: the file matches, the seller signed the receipt, the seller
  proved it controls the payee (L2.5; `skipped` only when the receipt names no payee or with
  `--allow-unbound`), the payment
  settled on its rail to the payee, and the `receiptHash` is committed on-chain (SPEC §6 level 3:
  "the rail shows `receiptHash` committed and the payment settled"). For `x402:exact` the
  settlement transaction predates the receipt, so the commitment is the anchor.
- **PARTIALLY VERIFIED** — nothing failed, but at least one level was not confirmed (offline mode,
  no file, no anchor, no account binding, unsupported rail, RPC unavailable). Anchors alone never
  yield VERIFIED.

`--allow-unbound` is the SPEC §6 opt-out for legacy receipts issued before account bindings: a
receipt with no binding at all reports L2.5 `skipped` ("allowed: --allow-unbound") instead of
`pending`. Bindings that are present but invalid still fail.

Note: this is stricter than the TypeScript `@receptum/verify`, which reports VERIFIED when the
payment check passes even without a file or an anchor. SPEC §6 does not yet define the verdicts
precisely; this difference is pending a spec clarification.

## Tests

```sh
pytest -m "not online"        # offline: RFC 8785 examples, every spec vector byte for byte, bindings, live receipt offline, tampered receipt
pytest                        # also hits Base Sepolia, Arc testnet and XRPL testnet (skipped if they are unreachable)
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

## Library

```python
from receptum_verify import extract_signed_receipt, loads_strict, verify

doc = loads_strict(open("receipt.json", "rb").read())
signed, anchor = extract_signed_receipt(doc)
report = verify(signed, open("output.svg", "rb").read(), anchor=anchor)
print(report.status, report.to_dict())
```
