"""Online parity with the TypeScript verifier: every published testnet receipt (the cases and
expected verdicts of scripts/verify-examples.mjs), the published claimable-balance escrows and a
Stellar MEMO_HASH anchor. Skipped when RECEPTUM_OFFLINE=1 or a chain is unreachable."""

import importlib.util
import json
import os
import re

import pytest

from receptum_verify import verify
from receptum_verify.stellar import check_stellar_anchor

from conftest import PACKAGES, REPO

pytestmark = [
    pytest.mark.online,
    pytest.mark.skipif(os.environ.get("RECEPTUM_OFFLINE") == "1", reason="RECEPTUM_OFFLINE=1"),
]

_spec = importlib.util.spec_from_file_location(
    "verify_examples", REPO / "verifiers" / "python" / "scripts" / "verify_examples.py"
)
verify_examples = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify_examples)
CASES = verify_examples.cases()


def _skip_if_unreachable(report):
    flaky = [c.detail for c in report.levels.values()
             if c.status == "unavailable" and re.search(r"failed|timed out|HTTP 5", c.detail)]
    if flaky:
        pytest.skip(f"RPC unavailable: {flaky}")


@pytest.mark.parametrize("label,inputs,file_bytes,want", CASES, ids=[c[0] for c in CASES])
def test_published_receipt_matches_the_typescript_verdict(label, inputs, file_bytes, want):
    signed, anchors = inputs
    report = verify(signed, file_bytes, anchor=anchors)
    _skip_if_unreachable(report)
    assert report.status == want, report.to_dict()


def _claimable_receipts():
    md = (PACKAGES / "adapter-stellar" / "E2E_RESULTS.md").read_text()
    out = []
    for block in re.findall(r"```json\n(.*?)\n```", md, re.S):
        try:
            doc = json.loads(block)
        except ValueError:
            continue
        if isinstance(doc, dict) and doc.get("receipt", {}).get("payment", {}).get("rail") == "escrow:stellar-claimable":
            out.append(doc)
    return out


# Settlement results the TypeScript verifier recorded for these runs (E2E_RESULTS.md): released by
# the seller, released by buyer acceptance, refunded; the original run names no payee.
CLAIMABLE_WANT = {
    "cb5f8b843dc5c3cdd53acca2415d3cf3ad7d5c61ccf71c22d3210840a8751a38": "pass",
    "2006e959868e9768bcd2d9054fcdd5d9dc5e347d4911f9b1de3afb9d28d501fc": "pass",
    "208307bb981236cb59f76d628ea0a4aebacc80e7e0b00cb765f86cef8d04222a": "fail",
    "2f559ce45cc0465c180ac563dba65e0ca5b457f131e054a93932c6d05e40eb43": "unavailable",
    "725f2dfd5f250ecf489ca442758ce9fd2e6be4593ccb6419024301b51cb4daac": "unavailable",
    "e75c4f27524d4ffbe3418f053356bb96e960ea1d212b8fbbacf9eab2f0cf1bfc": "unavailable",
}


def test_published_claimable_escrows():
    receipts = _claimable_receipts()
    assert {r["receiptHash"] for r in receipts} == set(CLAIMABLE_WANT)
    for signed in receipts:
        report = verify(signed)
        _skip_if_unreachable(report)
        assert report.levels["signature"].status == "pass"
        assert report.levels["settlement"].status == CLAIMABLE_WANT[signed["receiptHash"]], report.to_dict()


def test_stellar_memo_hash_anchor():
    tx = "9c840fbd9e5c50b9b4c7ea5d37346a40b219d5848f557340fd3f85675ef98a46"
    res = check_stellar_anchor("stellar:testnet", tx, "cb5f8b843dc5c3cdd53acca2415d3cf3ad7d5c61ccf71c22d3210840a8751a38")
    if res.status == "unavailable":
        pytest.skip(res.detail)
    assert res.status == "pass"
    assert check_stellar_anchor("stellar:testnet", tx, "00" * 32).status == "fail"
