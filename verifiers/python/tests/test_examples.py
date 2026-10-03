"""The live Base Sepolia receipt in examples/, offline and (optionally) online."""

import os

import pytest

from receptum_verify import NOT_VERIFIED, PARTIALLY_VERIFIED, VERIFIED, extract_signed_receipt, verify

from conftest import EXAMPLES, load_json

LIVE_HASH = "cb27b5b6a98fdaecb96fbedf557acba67bdad3a2fa6505f9836c49fbc766ba4a"


def test_live_receipt_offline(live_doc, live_output):
    signed, anchor = extract_signed_receipt(live_doc)
    assert anchor and anchor.startswith("eip155:5042002:")
    report = verify(signed, live_output, offline=True)
    assert report.receipt_hash == LIVE_HASH
    assert report.levels["file"].status == "pass"
    assert report.levels["signature"].status == "pass"
    # Offline can never be fully verified (SPEC §6).
    assert report.status == PARTIALLY_VERIFIED


def test_live_receipt_without_file_is_partial(live_doc):
    signed, _ = extract_signed_receipt(live_doc)
    assert verify(signed, offline=True).status == PARTIALLY_VERIFIED


def test_wrong_file_fails(live_doc):
    signed, _ = extract_signed_receipt(live_doc)
    report = verify(signed, b"not the delivered bytes", offline=True)
    assert report.levels["file"].status == "fail"
    assert report.status == NOT_VERIFIED


def test_tampered_receipt_fails(live_output):
    doc = load_json(EXAMPLES / "x402-base-sepolia-tampered.json")
    signed, _ = extract_signed_receipt(doc)
    report = verify(signed, live_output, offline=True)
    assert report.levels["signature"].status == "fail"
    assert report.status == NOT_VERIFIED
    assert any("receiptHash mismatch" in e for e in report.errors)


def test_tampered_receipt_fails_online_too(live_output):
    # Never reaches the network: an unauthenticated receipt skips level 3.
    doc = load_json(EXAMPLES / "x402-base-sepolia-tampered.json")
    signed, anchor = extract_signed_receipt(doc)
    assert verify(signed, live_output, anchor=anchor, rpcs={}).status == NOT_VERIFIED


online = pytest.mark.skipif(
    os.environ.get("RECEPTUM_OFFLINE") == "1", reason="RECEPTUM_OFFLINE=1"
)


@pytest.mark.online
@online
def test_live_receipt_online(live_doc, live_output):
    signed, anchor = extract_signed_receipt(live_doc)
    report = verify(signed, live_output, anchor=anchor)
    if any(c.status == "unavailable" for c in report.levels.values()):
        pytest.skip(f"RPC unavailable: {report.to_dict()['levels']}")
    assert report.levels["settlement"].status == "pass", report.levels["settlement"].detail
    assert report.levels["anchor"].status == "pass", report.levels["anchor"].detail
    assert report.status == VERIFIED


@pytest.mark.online
@online
def test_live_receipt_online_without_anchor_is_partial(live_doc, live_output):
    signed, _ = extract_signed_receipt(live_doc)
    report = verify(signed, live_output)
    if report.levels["settlement"].status == "unavailable":
        pytest.skip("RPC unavailable")
    assert report.levels["settlement"].status == "pass"
    assert report.status == PARTIALLY_VERIFIED


@pytest.mark.online
@online
def test_anchor_for_a_different_receipt_fails(live_doc, live_output):
    from receptum_verify.evm import check_evm_anchor

    _, anchor = extract_signed_receipt(live_doc)
    res = check_evm_anchor(anchor, "00" * 32)
    if res.status == "unavailable":
        pytest.skip("RPC unavailable")
    assert res.status == "fail"
