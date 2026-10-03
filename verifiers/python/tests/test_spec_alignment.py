"""Regression tests for the SPEC alignment with the TypeScript verifier (Oct 2026).

Each test names the SPEC decision it pins. None of them touches the network."""

import copy
import io
import json

import pytest

from receptum_verify import (
    NOT_VERIFIED,
    PARTIALLY_VERIFIED,
    VERIFIED,
    InputError,
    extract_signed_receipt,
    validate_receipt,
    verdict_of,
    verify,
    verify_signed_receipt,
)
from receptum_verify import binding as binding_mod
from receptum_verify.binding import parse_timestamp
from receptum_verify.cli import main
from receptum_verify.evm import CheckResult, check_evm_anchor
from receptum_verify.encoding import b64url_encode
from receptum_verify.jcs import canonicalize
from receptum_verify.receipt import is_caip10, is_did, receipt_hash
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from conftest import EXAMPLES, VECTORS, load_json

BASE = load_json(VECTORS)["vectors"][0]["receipt"]


def _mutate(path, value, delete=False, base=BASE):
    r = copy.deepcopy(base)
    obj = r
    for key in path[:-1]:
        obj = obj[key]
    if delete:
        del obj[path[-1]]
    else:
        obj[path[-1]] = value
    return r


def _resign(receipt):
    """Sign ``receipt`` with the public RFC 8032 TEST 1 vector key (testing only)."""
    vectors = load_json(VECTORS)
    sk = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(vectors["testSeedHex"]))
    kid = vectors["vectors"][0]["proof"]["kid"]
    header = b64url_encode(
        json.dumps({"alg": "EdDSA", "kid": kid, "typ": "receptum+jws"}, separators=(",", ":")).encode()
    )
    sig = sk.sign(f"{header}.{b64url_encode(canonicalize(receipt))}".encode())
    return {
        "receipt": receipt,
        "receiptHash": receipt_hash(receipt),
        "proof": {"type": "jws", "kid": kid, "jws": f"{header}..{b64url_encode(sig)}"},
    }


def _c(status):
    return CheckResult(status, "d")


ALL_PASS = {"file": _c("pass"), "signature": _c("pass"), "binding": _c("pass"), "settlement": _c("pass")}


# --- item 1: verdicts -------------------------------------------------------


def test_x402_needs_a_passing_anchor():
    status, missing = verdict_of({**ALL_PASS, "anchor": _c("skipped")}, "x402:exact")
    assert status == PARTIALLY_VERIFIED
    assert any("not committed on-chain" in m for m in missing)
    assert verdict_of({**ALL_PASS, "anchor": _c("pass")}, "x402:exact") == (VERIFIED, [])


def test_escrow_rails_commit_receipt_hash_themselves():
    assert verdict_of({**ALL_PASS, "anchor": _c("skipped")}, "escrow:receptum-evm") == (VERIFIED, [])


def test_file_is_required():
    status, missing = verdict_of({**ALL_PASS, "file": _c("skipped")}, "escrow:xrpl")
    assert status == PARTIALLY_VERIFIED and missing[0].startswith("L1:")


@pytest.mark.parametrize("binding,want", [("skipped", VERIFIED), ("pending", PARTIALLY_VERIFIED), ("unavailable", PARTIALLY_VERIFIED)])
def test_binding_may_only_be_skipped(binding, want):
    assert verdict_of({**ALL_PASS, "binding": _c(binding)}, "escrow:xrpl")[0] == want


@pytest.mark.parametrize("second,want", [("unavailable", PARTIALLY_VERIFIED), ("pending", PARTIALLY_VERIFIED), ("fail", NOT_VERIFIED)])
def test_every_anchor_counts(second, want):
    levels = {**ALL_PASS, "anchor": _c("pass"), "anchor 2": _c(second)}
    assert verdict_of(levels, "x402:exact")[0] == want


def test_offline_report_lists_missing_pieces(live_doc, live_output):
    signed, anchors = extract_signed_receipt(live_doc)
    report = verify(signed, live_output, anchor=anchors, offline=True)
    assert report.status == PARTIALLY_VERIFIED
    text = "\n".join(report.missing)
    assert "payment was not confirmed" in text and "not committed on-chain" in text
    assert report.to_dict()["missing"] == report.missing
    no_file = verify(signed, anchor=anchors, offline=True)
    assert no_file.missing[0].startswith("L1: no file given")


# --- items 1 / 4: wrapper and anchor references --------------------------------


def test_wrapper_anchor_string_list_or_error():
    s = {"receipt": {}}
    assert extract_signed_receipt({"signedReceipt": s}) == (s, [])
    assert extract_signed_receipt({"signedReceipt": s, "anchor": "a:b:c"}) == (s, ["a:b:c"])
    assert extract_signed_receipt({"signedReceipt": s, "anchor": ["x", "y"]}) == (s, ["x", "y"])
    for bad in (7, None, ["x", 1]):
        with pytest.raises(InputError):
            extract_signed_receipt({"signedReceipt": s, "anchor": bad})
    assert extract_signed_receipt(s) == (s, [])


def test_cli_anchor_is_repeatable_and_added_to_the_wrapper(capsys):
    extra = "eip155:5042002:0x" + "00" * 32
    code = main([
        str(EXAMPLES / "x402-base-sepolia.json"),
        str(EXAMPLES / "x402-base-sepolia-output.svg"),
        "--anchor", extra, "--anchor", extra, "--offline", "--json",
    ])
    out = json.loads(capsys.readouterr().out)
    assert code == 3
    # The wrapper's anchor plus one de-duplicated --anchor.
    assert [k for k in out["levels"] if k.startswith("anchor")] == ["anchor", "anchor 2"]


def test_cli_prints_missing_and_rejects_a_bad_wrapper_anchor(tmp_path, live_doc, capsys):
    assert main([str(EXAMPLES / "x402-base-sepolia.json"), "--offline"]) == 3
    assert "missing: L1: no file given" in capsys.readouterr().out
    bad = dict(live_doc, anchor=7)
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(bad))
    assert main([str(path), "--offline"]) == 2


def test_anchor_reference_format():
    rh = "00" * 32
    assert check_evm_anchor("EIP155:1:0x" + "ab" * 32, rh).status == "fail"  # not CAIP-2
    assert check_evm_anchor("not-an-anchor", rh).status == "fail"
    assert check_evm_anchor("xrpl:1:XYZ", rh).status == "fail"
    assert check_evm_anchor("stellar:testnet:" + "AB" * 32, rh).status == "fail"
    assert check_evm_anchor("xrpl:1:" + "AB" * 32, rh).status == "unavailable"
    assert check_evm_anchor("cosmos:hub-4:" + "ab" * 32, rh).status == "unavailable"


# --- item 3: x402 schemes ------------------------------------------------------


def test_only_the_exact_x402_scheme_is_recognised():
    report = verify(_resign(_mutate(("payment", "rail"), "x402:upto")))
    assert report.levels["signature"].status == "pass"
    assert report.levels["settlement"].status == "unavailable"
    assert 'only the x402 "exact" scheme' in report.levels["settlement"].detail
    assert report.status == PARTIALLY_VERIFIED


def test_symbolic_asset_fails_x402_exact(signed_vector):
    # The vector's symbolic asset "USDC" breaks the x402:exact MUST before any RPC call.
    res = verify(signed_vector).levels["settlement"]
    assert res.status == "fail" and "token contract address" in res.detail


# --- item 2: XRPL validated ledger -------------------------------------------------


def test_xrpl_account_info_must_be_validated(monkeypatch):
    reply = {
        "result": {
            "status": "success",
            "validated": False,
            "account_data": {"Account": "rAddr", "Flags": 0},
        }
    }
    monkeypatch.setattr(
        binding_mod.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(json.dumps(reply).encode())
    )
    with pytest.raises(ValueError, match="validated"):
        binding_mod.fetch_xrpl_keys("rAddr", "https://example.invalid")


# --- item 5: envelope -------------------------------------------------------------


@pytest.mark.parametrize("bindings", [None, []])
def test_null_or_empty_bindings_are_absent(signed_vector, bindings):
    assert verify_signed_receipt(dict(signed_vector, bindings=bindings)).ok
    with_payee = _resign(_mutate(("payment", "payee"), "eip155:84532:0x" + "11" * 20))
    report = verify(dict(with_payee, bindings=bindings), offline=True)
    assert report.levels["signature"].status == "pass"
    assert report.levels["binding"].status == "pending"


def test_non_array_bindings_break_the_envelope(signed_vector):
    res = verify_signed_receipt(dict(signed_vector, bindings={"x": 1}))
    assert not res.ok and "bindings must be an array" in res.errors


# --- item 8: identity syntax ---------------------------------------------------------


def test_did_is_never_caip10_and_pct_encoding_is_strict():
    assert not is_caip10("did:key:z6Mkabc")
    assert not is_did("did:web:a%") and not is_did("did:web:a%2")
    assert is_did("did:web:a%20b") and is_did("did:example::x")
    for key in ("payer", "payee"):
        assert validate_receipt(_mutate(("payment", key), "did:web:x")) != []


@pytest.mark.parametrize(
    "path,value",
    [
        (("receiptId",), "RCPT-7F3A-21C9\n"),
        (("jobIdHash",), "a" * 64 + "\n"),
        (("payment", "network"), "eip155:84532\n"),
        (("payment", "amount"), "1\n"),
        (("payment", "payee"), "eip155:84532:0xabc\n"),
        (("buyer",), {"id": "did:web:x\n"}),
        (("deliveredAt",), "2026-10-04T12:00:00Z\n"),
    ],
)
def test_trailing_newline_never_matches(path, value):
    # Python's `$` matches before a final newline; the patterns must use \Z (as TS `$` does).
    assert validate_receipt(_mutate(path, value)) != []


# --- item 9: remedy and evaluator ---------------------------------------------------------


def test_remedy_kind_is_required():
    errors = validate_receipt(_mutate(("remedy",), {"withinDays": 3}))
    assert any("remedy.kind is required" in e for e in errors)
    assert validate_receipt(_mutate(("remedy",), {"kind": "refund", "termsSha256": "a" * 64})) == []


def test_evaluator_only_in_evaluator_mode():
    r = _mutate(("acceptance",), {"mode": "auto", "reviewWindowSeconds": 0, "evaluator": "did:web:qa"})
    assert any("only allowed" in e for e in validate_receipt(r))


# --- item 10: timestamps ----------------------------------------------------------------


@pytest.mark.parametrize(
    "ts,ok",
    [
        ("2026-10-04T12:00:00.123456789Z", True),
        ("2026-10-04T12:00:00.1234567890Z", False),
        ("2026-10-04T12:00:0١Z", False),  # ARABIC-INDIC DIGIT ONE
        ("0000-01-01T00:00:00Z", False),
        ("0001-01-01T00:00:00Z", True),
    ],
)
def test_timestamp_profile(ts, ok):
    assert (validate_receipt(_mutate(("deliveredAt",), ts)) == []) is ok


def test_timestamps_compare_exactly():
    assert parse_timestamp("2026-10-04T12:00:00.0001Z") < parse_timestamp("2026-10-04T12:00:00.0005Z")
    assert parse_timestamp("2026-10-04T12:00:00.5Z") == parse_timestamp("2026-10-04T12:00:00.500000000Z")


# --- item 11: integers -------------------------------------------------------------------


@pytest.mark.parametrize("v,ok", [(3.0, True), (2**53 - 1, True), (2**53, False), (-1, False), (1.5, False), (True, False)])
def test_integer_members(v, ok):
    assert (validate_receipt(_mutate(("acceptance", "reviewWindowSeconds"), v)) == []) is ok
    assert (validate_receipt(_mutate(("remedy", "withinDays"), v)) == []) is ok


def test_duplicate_inputs_and_empty_evidence_are_allowed():
    assert validate_receipt(_mutate(("inputSha256",), ["a" * 64, "a" * 64])) == []
    assert validate_receipt(_mutate(("evidence",), {})) == []
