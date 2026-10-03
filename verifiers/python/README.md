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
python -m receptum_verify <receipt.json> [file] [--anchor <caip2>:<tx>]... [--offline] [--allow-unbound] [--json] [--rpc <caip2>=<url>]...
```

`receipt.json` is either a bare signed receipt (`{ receipt, receiptHash, proof, bindings? }`) or a
wrapper object with a `signedReceipt` member (SPEC §6.1). The wrapper's `anchor` — one
`<caip2>:<tx>` string or an array of them — is checked together with every `--anchor` (an anchor
is bound to the recomputed `receiptHash`, so the wrapper does not need to be trusted); any other
`anchor` value is an input error. The wrapper's other members are informational.

```sh
$ python -m receptum_verify ../../examples/x402-base-sepolia.json ../../examples/x402-base-sepolia-output.svg
VERIFIED
  receiptHash  11e739252cc2d6e76adf0819a9f3914c6c49fbdbc6a572c424786b792658ee5b
  seller       did:key:z6Mkqc7RGNmmfbG4HeUF6UdeeBXuRiXfUk1fMf9sg1Adby4t
  L1 file        PASS        SHA-256(file) = outputSha256 = 301917f6…6544234a
  L2 signature   PASS        receiptHash recomputed and JWS verifies against did:key:z6Mkqc7R…
  L2.5 binding   PASS        did:key:z6Mkqc7R… ↔ eip155:84532:0x6344…328B: EIP-191 signature recovers 0x6344…328B (offline)
  L3 settlement  PASS        tx 0x778f0a7d…bcf0b86b succeeded; Transfer 250000 of 0x036CbD53… 0x62e5… -> 0x6344…
  L3 anchor      PASS        eip155:5042002 tx 0xa546047c…28e04b70 commits receiptHash (block 65317884, …)
```

A PARTIALLY VERIFIED report ends with one `missing:` line per piece that prevented VERIFIED, e.g.
for `examples/x402-stellar-testnet.json` (this verifier has no Stellar settlement check, and the
receipt was never anchored):

```text
  missing: L3: the payment was not confirmed on its rail (unavailable — rail x402:exact on stellar:testnet is not supported by this verifier)
  missing: L3: receiptHash is not committed on-chain — x402:exact does not commit it, so a mined anchor is required (--anchor <caip2>:<tx>, or the input wrapper's "anchor")
```

Exit codes: `0` VERIFIED, `1` NOT VERIFIED, `2` usage or unreadable/invalid JSON input,
`3` PARTIALLY VERIFIED.

## What is checked

| Level                    | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input                    | Strict I-JSON (SPEC §6.1): UTF-8 without BOM, no duplicate member names, no lone surrogates, no NaN/Infinity or out-of-range numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L1 file                  | `SHA-256(file) == outputSha256`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| L2 signature             | SPEC §2 schema (exact members, types, §2.1 identity expressions, §2.2 timestamp profile with 1–9 fractional digits, `remedy.kind` required, `acceptance.evaluator` only in evaluator mode); the signed-receipt envelope (exactly `receipt`/`receiptHash`/`proof`, optional `bindings` array — `null` and `[]` count as absent); `receiptHash` recomputed from JCS; detached JWS with exactly 3 segments and an empty payload, header I-JSON with members exactly `alg`/`kid`/`typ` (`EdDSA`, `receptum+jws`), `kid` = `<seller did:key>#<multibase key>`, canonical unpadded 64-byte signature with `S < L`. A CAIP-10 `seller.id` cannot carry a JWS proof and fails |
| L2.5 binding             | SPEC §4.1, only when `payment.payee` is present. Some binding in `bindings` (the first 16 are examined) must have exactly `statement`/`didProof`/`accountProof`; a statement with exactly the allowed string members; a `didProof` JWS as for L2 but with `typ` `receptum-binding+jws` over `JCS(statement)`, by `statement.did`; and an `accountProof` for the account's namespace (below). It covers the receipt when `statement.did == seller.id`, `statement.account == payment.payee` (EVM address case-insensitive, everything else exact), `expiresAt` (if any) is after `deliveredAt`, and `issuedAt` is at most 5 minutes in the future                      |
| L3 settlement            | `x402:exact` on `eip155:*` (SPEC §7.3; default RPC for `eip155:84532`): `payment.asset` must be the token contract address and `payment.reference` a transaction hash (otherwise fail); the RPC serves the right chain id (otherwise unavailable), the transaction at `payment.reference` is mined with status success, and it emitted an ERC-20 `Transfer` of exactly `payment.amount` of token `payment.asset` to `payment.payee` (and from `payment.payer` when stated). Other `x402:*` schemes, Stellar x402 and every escrow rail are `unavailable` here                                                                                                         |
| L3 anchor (`anchor:evm`) | SPEC §7.1, every anchor from the wrapper and `--anchor` (default RPC for `eip155:5042002`): `<caip2>:<tx>` with a CAIP-2 network; the anchor transaction is mined, successful, zero-value, and its calldata is exactly `utf8("receptum/1") ‖ receiptHash` (32 raw bytes). XRPL and Stellar anchor references are format-checked, then `unavailable`                                                                                                                                                                                                                                                                                                                   |

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
`pending` (genuine but not final; here only L2.5 when the receipt carries no binding at all, so
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

Because this verifier only checks `x402:exact` on EVM chains at level 3, a receipt on any other
rail is PARTIALLY VERIFIED here even when the TypeScript verifier reports VERIFIED; it is never
the other way round.

## Tests

```sh
pytest -m "not online"        # offline: RFC 8785 examples, every spec vector byte for byte (and every invalid one rejected), bindings, SPEC alignment, live receipt offline, tampered receipt
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
`tests/test_spec_alignment.py` pins each decision of the SPEC alignment with the TypeScript
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
