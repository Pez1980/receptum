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


def test_issued_token_amounts_are_10e15_units():
    delivered = {"currency": "USD", "issuer": ISSUER, "value": "1"}
    reply = tx_reply(meta={"delivered_amount": delivered})
    res = check(receipt(asset=f"USD.{ISSUER}", amount="1000000000000000"), reply)
    assert res.status == "pass", res.detail
    # The old 6-decimal reading, or the bare value, is not the receipt amount.
    for amount in ("1000000", "1"):
        res = check(receipt(asset=f"USD.{ISSUER}", amount=amount), reply)
        assert res.status == "fail" and "receipt says" in res.detail
    # A delivered value with no exact 10^-15 integer fails, whatever the receipt says.
    tiny = tx_reply(meta={"delivered_amount": {**delivered, "value": "1e-16"}})
    assert check(receipt(asset=f"USD.{ISSUER}", amount="0"), tiny).status == "fail"
    # Exponent forms convert exactly.
    exp = tx_reply(meta={"delivered_amount": {**delivered, "value": "25e-2"}})
    assert check(receipt(asset=f"USD.{ISSUER}", amount="250000000000000"), exp).status == "pass"
    # XRP delivered for an issued asset, or the reverse, fails.
    assert check(receipt(asset=f"USD.{ISSUER}", amount="1"), tx_reply()).status == "fail"
    assert check(receipt(), reply).status == "fail"


def test_display_symbols_are_not_ledger_codes():
    def never(method, params):
        raise AssertionError("must not be called")

    for code in ("RLUSD", "rlusd", "USDC", "ABCDEFGHIJKLMNOPQRSTU"):
        res = check_xrpl_x402_exact(receipt(asset=f"{code}.{ISSUER}", amount="1"), rpc=never)
        assert res.status == "fail" and "as on the ledger" in res.detail, code
    rlusd = "524C555344000000000000000000000000000000"
    delivered = {"currency": rlusd, "issuer": ISSUER, "value": "0.25"}
    reply = tx_reply(meta={"delivered_amount": delivered})
    assert check(receipt(asset=f"{rlusd}.{ISSUER}", amount="250000000000000"), reply).status == "pass"
    lower = f"{rlusd.lower()}.{ISSUER}"  # 40-hex compares case-insensitively
    assert check(receipt(asset=lower, amount="250000000000000"), reply).status == "pass"


def test_currency_codes_are_case_sensitive():
    usd = {"currency": "USD", "issuer": ISSUER, "value": "1"}
    lower = check(receipt(asset=f"usd.{ISSUER}", amount="1"), tx_reply(meta={"delivered_amount": usd}))
    assert lower.status == "fail", lower.detail
    upper = check(
        receipt(asset=f"USD.{ISSUER}", amount="1"),
        tx_reply(meta={"delivered_amount": {**usd, "currency": "usd"}}),
    )
    assert upper.status == "fail", upper.detail


def test_currency_compared_by_160_bit_identity():
    rec = receipt(asset=f"USD.{ISSUER}", amount="1")
    standard = {"currency": "0000000000000000000000005553440000000000", "issuer": ISSUER, "value": "1e-15"}
    assert check(rec, tx_reply(meta={"delivered_amount": standard})).status == "pass"
    nonstandard = {**standard, "currency": "5553440000000000000000000000000000000000"}
    assert check(rec, tx_reply(meta={"delivered_amount": nonstandard})).status == "fail"
    hex_asset = receipt(asset=f"5553440000000000000000000000000000000000.{ISSUER}", amount="1")
    usd = {"currency": "USD", "issuer": ISSUER, "value": "1"}
    assert check(hex_asset, tx_reply(meta={"delivered_amount": usd})).status == "fail"


def test_malformed_currency_codes_fail_without_rpc():
    def never(method, params):
        raise AssertionError("must not be called")

    for code in ["XRP", "U D", "0001" + "00" * 18, "00" * 20]:
        res = check_xrpl_x402_exact(receipt(asset=f"{code}.{ISSUER}", amount="1"), rpc=never)
        assert res.status == "fail", code


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


def test_issued_wrong_issuer():
    rec = receipt(asset=f"USD.{ISSUER}", amount="1")
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


def _vectors():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "spec" / "vectors" / "xrpl-currency-v1.json"
    return json.loads(path.read_text("utf-8"))["codes"]


@pytest.mark.parametrize("case", _vectors(), ids=lambda c: c["code"])
def test_currency_identity_vectors(case):
    from receptum_verify.xrpl_assets import currency_id

    assert currency_id(case["code"]) == case["id"]
    if case["id"] is None:
        res = check_xrpl_x402_exact(receipt(asset=f"{case['code']}.{ISSUER}", amount="1"), rpc=lambda m, p: None)
        assert res.status == "fail"


def _amount_vectors():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[3] / "spec" / "vectors" / "xrpl-issued-amount-v1.json"
    return json.loads(path.read_text("utf-8"))


@pytest.mark.parametrize("case", _amount_vectors()["values"], ids=lambda c: c["value"])
def test_issued_value_to_units_vectors(case):
    from receptum_verify.xrpl_assets import value_to_units

    if case["units"] is None:
        with pytest.raises(ValueError):
            value_to_units(case["value"])
    else:
        assert value_to_units(case["value"]) == case["units"]


@pytest.mark.parametrize("case", _amount_vectors()["units"], ids=lambda c: c["units"])
def test_units_to_value_vectors(case):
    from receptum_verify.xrpl_assets import units_to_value, value_to_units

    if case["value"] is None:
        with pytest.raises(ValueError):
            units_to_value(case["units"])
    else:
        assert units_to_value(case["units"]) == case["value"]
        assert value_to_units(case["value"]) == case["units"]
