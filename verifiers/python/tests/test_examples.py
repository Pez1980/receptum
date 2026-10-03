"""The live Base Sepolia receipt in examples/, offline and (optionally) online."""

import os

import pytest

from receptum_verify import NOT_VERIFIED, PARTIALLY_VERIFIED, VERIFIED, extract_signed_receipt, verify

from conftest import EXAMPLES, load_json



def test_live_receipt_offline(live_doc, live_output):
    # Expected values come from the example itself, so regenerating it needs no edit here.
    signed, anchors = extract_signed_receipt(live_doc)
    assert len(anchors) == 1 and anchors[0].startswith("eip155:5042002:")
    report = verify(signed, live_output, offline=True)
    assert report.receipt_hash == signed["receiptHash"]
    assert report.seller == signed["receipt"]["seller"]["id"]
    assert report.levels["file"].status == "pass"
    assert report.levels["signature"].status == "pass"
    assert report.levels["binding"].status == "pass", report.levels["binding"].detail
    assert live_doc["check"]["payeeBound"] is True
    # Offline can never be fully verified (SPEC §6).
    assert report.status == PARTIALLY_VERIFIED


def test_live_receipt_without_bindings_is_partial_and_allow_unbound_skips(live_doc, live_output):
    signed, _ = extract_signed_receipt(live_doc)
    unbound = {k: v for k, v in signed.items() if k != "bindings"}
    report = verify(unbound, live_output, offline=True)
    # Removing bindings never changes the receipt hash or signature (SPEC §4.1).
    assert report.receipt_hash == signed["receiptHash"]
    assert report.levels["signature"].status == "pass"
    assert report.levels["binding"].status == "pending"
    report = verify(unbound, live_output, offline=True, allow_unbound=True)
    assert report.levels["binding"].status == "skipped"
    assert "--allow-unbound" in report.levels["binding"].detail


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
    assert report.levels["binding"].status == "pass", report.levels["binding"].detail
    assert report.status == VERIFIED


@pytest.mark.online
@online
def test_live_receipt_online_without_binding_is_partial(live_doc, live_output):
    signed, anchor = extract_signed_receipt(live_doc)
    unbound = {k: v for k, v in signed.items() if k != "bindings"}
    report = verify(unbound, live_output, anchor=anchor)
    if any(c.status == "unavailable" for c in report.levels.values()):
        pytest.skip(f"RPC unavailable: {report.to_dict()['levels']}")
    assert report.levels["binding"].status == "pending"
    assert report.status == PARTIALLY_VERIFIED
    # The explicit legacy opt-out may reach VERIFIED, and says so.
    report = verify(unbound, live_output, anchor=anchor, allow_unbound=True)
    assert report.levels["binding"].status == "skipped"
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

    _, anchors = extract_signed_receipt(live_doc)
    res = check_evm_anchor(anchors[0], "00" * 32)
    if res.status == "unavailable":
        pytest.skip("RPC unavailable")
    assert res.status == "fail"


def _verify_examples_module():
    import importlib.util

    path = EXAMPLES.parent / "verifiers" / "python" / "scripts" / "verify_examples.py"
    spec = importlib.util.spec_from_file_location("verify_examples", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_verify_examples_lists_the_same_cases_as_the_typescript_script():
    """Both verify-examples scripts check the same published receipts, in the same order, with
    the same labels and expected verdicts (so their outputs can be diffed line for line)."""
    import re

    ts = (EXAMPLES.parent / "scripts" / "verify-examples.mjs").read_text("utf-8")
    body = ts[ts.index("const cases = [") :]
    want = re.findall(
        r'\[\n\s+"([^"]+)",\n.*?\n\s+"(VERIFIED|NOT VERIFIED|PARTIALLY VERIFIED)",\n\s+\],', body, re.S
    )
    got = [(label, verdict) for label, _, _, verdict in _verify_examples_module().cases()]
    assert got == want
    # Every published example receipt is covered.
    covered = ts + (EXAMPLES.parent / "verifiers" / "python" / "scripts" / "verify_examples.py").read_text("utf-8")
    for path in sorted(EXAMPLES.glob("*.json")):
        assert f"examples/{path.name}" in covered, path.name


def test_every_published_verified_case_passes_levels_1_to_2_5_offline():
    """Offline, each case expected VERIFIED online has its delivered bytes, a valid signature and
    a seller binding covering its payee: only level 3 is left to the chain."""
    for label, (signed, anchors), file_bytes, want in _verify_examples_module().cases():
        if want != VERIFIED:
            continue
        report = verify(signed, file_bytes, anchor=anchors, offline=True)
        for level in ("file", "signature", "binding"):
            assert report.levels[level].status == "pass", (label, level, report.levels[level].detail)
        assert report.status == PARTIALLY_VERIFIED, label
