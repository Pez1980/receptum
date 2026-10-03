# receptum-verify (Python)

An independent, second-language verifier for the [Receptum Receipt Format v1](../../docs/SPEC.md).
It was written from `docs/SPEC.md` and `spec/vectors/rrf-v1.json` only — not ported from the
TypeScript packages — so a receipt can be checked without trusting any Receptum JavaScript code.

- Python ≥ 3.11, one dependency: [`cryptography`](https://cryptography.io) (pinned) for Ed25519.
- JCS (RFC 8785), base58btc, `did:key`, base64url and JSON-RPC are implemented with the standard
  library. Online checks use plain JSON-RPC over `urllib` (no web3).
- Not published to PyPI; install from this repository.

## Install

```sh
cd verifiers/python
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[test]"
```

## CLI

```sh
python -m receptum_verify <receipt.json> [file] [--anchor <caip2>:<tx>] [--offline] [--json] [--rpc <caip2>=<url>]
```

`receipt.json` is either a bare signed receipt (`{ receipt, receiptHash, proof }`) or an object
with a `signedReceipt` member. If such a wrapper also has a string `anchor` member and `--anchor`
is not given, that anchor is checked (an anchor is bound to the recomputed `receiptHash`, so the
wrapper does not need to be trusted).

```sh
$ python -m receptum_verify ../../examples/x402-base-sepolia.json ../../examples/x402-base-sepolia-output.svg
VERIFIED
  receiptHash  cb27b5b6a98fdaecb96fbedf557acba67bdad3a2fa6505f9836c49fbc766ba4a
  seller       did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
  L1 file        PASS        SHA-256(file) = outputSha256 = 301917f6…6544234a
  L2 signature   PASS        receiptHash recomputed and JWS verifies against did:key:z6Mkqc7R…
  L3 settlement  PASS        tx 0x90a09ae1…4ff454f succeeded; Transfer 250000 of 0x036CbD53… 0x62e5… -> 0x6344…
  L3 anchor      PASS        eip155:5042002 tx 0xe708fdb7…e67e9f8 commits receiptHash
```

Exit codes: `0` VERIFIED, `1` NOT VERIFIED, `2` usage or unreadable/invalid JSON input,
`3` PARTIALLY VERIFIED.

## What is checked

| Level                    | Check                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| input                    | Strict I-JSON: UTF-8, no duplicate member names, no lone surrogates, no NaN/Infinity                                                                                                                                                                                                                                                       |
| L1 file                  | `SHA-256(file) == outputSha256`                                                                                                                                                                                                                                                                                                            |
| L2 signature             | SPEC §2 schema (exact members, types, timestamp profile, identity syntax); `receiptHash` recomputed from JCS; detached JWS with exactly 3 segments and an empty payload, header members exactly `alg`/`kid`/`typ` (`EdDSA`, `receptum+jws`), `kid` = `<seller did:key>#<multibase key>`, canonical unpadded 64-byte signature with `S < L` |
| L3 settlement            | `x402:exact` on `eip155:*` (default RPC for `eip155:84532`): the RPC serves the right chain id, the transaction at `payment.reference` is mined with status success, and it emitted an ERC-20 `Transfer` of exactly `payment.amount` of token `payment.asset` to `payment.payee` (and from `payment.payer` when stated)                    |
| L3 anchor (`anchor:evm`) | default RPC for `eip155:5042002`: the anchor transaction is mined, successful, zero-value, and its calldata is exactly `utf8("receptum/1") ‖ receiptHash` (32 raw bytes)                                                                                                                                                                   |

Each check is `pass`, `fail` (the evidence contradicts the receipt), `skipped` (not requested or
not possible offline) or `unavailable` (could not be checked: unsupported rail, a symbolic
`payment.asset`, no `payment.payee`, or an RPC error).

## Verdicts

- **NOT VERIFIED** — any check failed.
- **VERIFIED** — every check passed: the file matches, the seller signed the receipt, the payment
  settled on its rail to the payee, and the `receiptHash` is committed on-chain (SPEC §6 level 3:
  "the rail shows `receiptHash` committed and the payment settled"). For `x402:exact` the
  settlement transaction predates the receipt, so the commitment is the anchor.
- **PARTIALLY VERIFIED** — nothing failed, but at least one level was not confirmed (offline mode,
  no file, no anchor, unsupported rail, RPC unavailable). Anchors alone never yield VERIFIED.

Note: this is stricter than the TypeScript `@receptum/verify`, which reports VERIFIED when the
payment check passes even without a file or an anchor. SPEC §6 does not yet define the verdicts
precisely; this difference is pending a spec clarification.

## Tests

```sh
pytest -m "not online"        # offline: RFC 8785 examples, every spec vector byte for byte, live receipt offline, tampered receipt
pytest                        # also hits Base Sepolia and Arc testnet RPCs (skipped if they are unreachable)
RECEPTUM_OFFLINE=1 pytest     # force-skip online tests
```

The vector tests re-derive the seller `did:key` from the RFC 8032 §7.1 TEST 1 seed, reproduce the
JCS bytes and `receiptHash` of every vector, and re-sign each receipt to reproduce its JWS exactly
(Ed25519 is deterministic).

## Library

```python
from receptum_verify import extract_signed_receipt, loads_strict, verify

doc = loads_strict(open("receipt.json", "rb").read())
signed, anchor = extract_signed_receipt(doc)
report = verify(signed, open("output.svg", "rb").read(), anchor=anchor)
print(report.status, report.to_dict())
```
