"""x402:exact on xrpl:* and anchor:xrpl, with mocked rippled JSON-RPC (plus one online test)."""

import copy
import os

import pytest

from receptum_verify import VERIFIED, extract_signed_receipt, verify
from receptum_verify.xrpl_x402 import (
    RECEIPT_MEMO_TYPE,
    XrplRpcError,
    check_xrpl_anchor,
    check_xrpl_x402_exact,
)

from conftest import EXAMPLES, load_json

HASH = "A" * 64
BUYER = "rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf"
SELLER = "r9vbiDzUBwmrfL62JeGoNnKSbVofVWpg2s"
ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"


def receipt(**over):
    pay = {
        "rail": "x402:exact",
        "network": "xrpl:1",
        "asset": "XRP",
        "amount": "10000",
        "reference": HASH,
        "payer": f"xrpl:1:{BUYER}",
        "payee": f"xrpl:1:{SELLER}",
    }
    pay.update(over)
    return {"payment": pay}


def tx_reply(tx=None, meta=None, **top):
    reply = {
        "hash": HASH,
        "validated": True,
        "ledger_index": 123,
        "tx_json": {
            "TransactionType": "Payment",
            "Account": BUYER,
            "Destination": SELLER,
            "DeliverMax": "10000",
            **(tx or {}),
        },
        "meta": {"TransactionResult": "tesSUCCESS", "delivered_amount": "10000", **(meta or {})},
    }
    reply.update(top)
    return reply


def mock(reply, network_id=1):
    def rpc(method, params):
        if method == "server_info":
            return {"info": {"network_id": network_id}}
        if method == "tx":
            assert params["transaction"] == HASH
            return copy.deepcopy(reply)
        raise AssertionError(method)

    return rpc


def check(rec, reply, network_id=1):
    return check_xrpl_x402_exact(rec, rpc=mock(reply, network_id))


def test_success():
    res = check(receipt(), tx_reply())
    assert res.status == "pass", res.detail
    assert "10000 drops" in res.detail


def test_issued_currency_success_with_equal_decimal_value():
    delivered = {"currency": "USD", "issuer": ISSUER, "value": "1e-2"}
    res = check(receipt(asset=f"USD.{ISSUER}", amount="0.010"), tx_reply(meta={"delivered_amount": delivered}))
    assert res.status == "pass", res.detail


def test_wrong_destination():
    res = check(receipt(), tx_reply(tx={"Destination": ISSUER}))
    assert res.status == "fail"
    assert "payment.payee" in res.detail


def test_wrong_sender():
    assert check(receipt(), tx_reply(tx={"Account": ISSUER})).status == "fail"


def test_partial_payment_delivered_less_than_amount():
    # Amount/DeliverMax says 10000, but tfPartialPayment delivered only 1 drop.
    res = check(receipt(), tx_reply(tx={"Flags": 131072}, meta={"delivered_amount": "1"}))
    assert res.status == "fail"
    assert "delivered 1 drops" in res.detail


def test_issued_partial_payment_and_wrong_issuer():
    rec = receipt(asset=f"USD.{ISSUER}", amount="1")
    partial = {"currency": "USD", "issuer": ISSUER, "value": "0.5"}
    assert check(rec, tx_reply(meta={"delivered_amount": partial})).status == "fail"
    forged = {"currency": "USD", "issuer": BUYER, "value": "1"}
    assert check(rec, tx_reply(meta={"delivered_amount": forged})).status == "fail"
    assert check(receipt(asset="USD", amount="1"), tx_reply()).status == "fail"


def test_non_validated_ledger_is_never_pass():
    assert check(receipt(), tx_reply(validated=False)).status == "unavailable"


def test_tes_success_missing_or_tec():
    reply = tx_reply()
    del reply["meta"]["TransactionResult"]
    assert check(receipt(), reply).status == "fail"
    assert check(receipt(), tx_reply(meta={"TransactionResult": "tecUNFUNDED_PAYMENT"})).status == "fail"


def test_not_a_payment():
    assert check(receipt(), tx_reply(tx={"TransactionType": "AccountSet"})).status == "fail"


def test_wrong_network():
    assert check(receipt(payee=f"xrpl:0:{SELLER}"), tx_reply()).status == "fail"
    assert check(receipt(), tx_reply(tx={"NetworkID": 21338})).status == "fail"
    assert check(receipt(), tx_reply(), network_id=0).status == "unavailable"
    assert check(receipt(network="xrpl:testnet"), tx_reply()).status == "fail"


def test_unavailable_lookups():
    def down(method, params):
        raise XrplRpcError("ECONNREFUSED")

    assert check_xrpl_x402_exact(receipt(), rpc=down).status == "unavailable"
    assert check(receipt(), {"error": "txnNotFound"}).status == "unavailable"
    no_rpc = receipt(network="xrpl:0", payer=f"xrpl:0:{BUYER}", payee=f"xrpl:0:{SELLER}")
    assert check_xrpl_x402_exact(no_rpc, {}).status == "unavailable"


def test_reply_for_another_hash():
    assert check(receipt(), tx_reply(hash="B" * 64)).status == "fail"


def test_anchor_memo():
    rh = "ab" * 32
    memos = [{"Memo": {"MemoType": RECEIPT_MEMO_TYPE, "MemoData": rh.upper()}}]
    reply = tx_reply(tx={"TransactionType": "AccountSet", "Memos": memos})
    assert check_xrpl_anchor(f"xrpl:1:{HASH}", rh, rpc=mock(reply)).status == "pass"
    assert check_xrpl_anchor(f"xrpl:1:{HASH}", "cd" * 32, rpc=mock(reply)).status == "fail"
    assert check_xrpl_anchor(f"xrpl:1:{HASH}", rh, rpc=mock(tx_reply(validated=False))).status == "unavailable"


def test_example_offline():
    doc = load_json(EXAMPLES / "x402-xrpl-testnet.json")
    signed, anchors = extract_signed_receipt(doc)
    assert len(anchors) == 1 and anchors[0].startswith("xrpl:1:")
    report = verify(signed, (EXAMPLES / "x402-xrpl-testnet-output.svg").read_bytes(), offline=True)
    assert report.levels["file"].status == "pass"
    assert report.levels["signature"].status == "pass"
    assert report.levels["binding"].status == "pass", report.levels["binding"].detail


@pytest.mark.online
@pytest.mark.skipif(os.environ.get("RECEPTUM_OFFLINE") == "1", reason="RECEPTUM_OFFLINE=1")
def test_example_online():
    doc = load_json(EXAMPLES / "x402-xrpl-testnet.json")
    signed, anchor = extract_signed_receipt(doc)
    report = verify(signed, (EXAMPLES / "x402-xrpl-testnet-output.svg").read_bytes(), anchor=anchor)
    if any(c.status == "unavailable" for c in report.levels.values()):
        pytest.skip(f"XRPL RPC unavailable: {report.to_dict()['levels']}")
    assert report.levels["settlement"].status == "pass", report.levels["settlement"].detail
    assert report.levels["anchor"].status == "pass", report.levels["anchor"].detail
    assert report.status == VERIFIED
