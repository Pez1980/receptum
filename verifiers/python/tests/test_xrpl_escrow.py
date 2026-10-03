"""escrow:xrpl with a mocked rippled: history-derived delivery and settlement (SPEC §7, §7.3),
currency identity, acceptance terms and incomplete history."""

from datetime import datetime, timezone

import pytest

from receptum_verify.xrpl_escrow import (
    ESCROW_MEMO_TYPE,
    RIPPLE_EPOCH,
    check_xrpl_escrow_payment,
    escrow_amount_units,
    parse_receipt_memos,
    parse_xrpl_escrow_id,
)
from receptum_verify.xrpl_x402 import RECEIPT_MEMO_TYPE, XrplRpcError

from conftest import RH, bare, escrow_signed

BUYER = "rfy1FurqCy5P7ads54PCxGUbqJyeK1LX7r"
SELLER = "rUuUZJXy7qQhZkpr8ovFBgBT5JrPv3nnFf"
OTHER = "rEsPJWasngBfidJ75VHhrCv4ZMQTV1uFHf"
ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"
SEQ = 21239409
ESCROW = f"{BUYER}:{SEQ}"
COND = "A0258020" + "AB" * 32 + "810120"
T0 = 815_000_000  # Ripple-epoch seconds of ledger 100
CANCEL = T0 + 2000


def iso(ripple):
    return datetime.fromtimestamp(ripple + RIPPLE_EPOCH, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def memos(receipt_hash=RH, escrow=ESCROW):
    out = [{"Memo": {"MemoType": RECEIPT_MEMO_TYPE, "MemoData": receipt_hash.upper()}}]
    if escrow is not None:
        out.append({"Memo": {"MemoType": ESCROW_MEMO_TYPE, "MemoData": escrow.encode().hex().upper()}})
    return out


def txn(h, ledger, tx, index=0, nodes=(), result="tesSUCCESS", t=None):
    return {"hash": h, "ledger_index": ledger, "validated": True,
            "close_time_iso": iso(T0 + (ledger - 100) * 10 if t is None else t),
            "tx_json": tx, "meta": {"TransactionResult": result, "TransactionIndex": index,
                                    "AffectedNodes": list(nodes)}}


def fields(amount="2000000", condition=COND, cancel=CANCEL, **over):
    f = {"Account": BUYER, "Destination": SELLER, "Amount": amount, "CancelAfter": cancel,
         "PreviousTxnID": "CREATE"}
    if condition:
        f["Condition"] = condition
    f.update(over)
    return {k: v for k, v in f.items() if v is not None}


ACCOUNT_CREATED = txn("FUND", 50, {"TransactionType": "Payment", "Account": OTHER, "Destination": BUYER},
                      nodes=[{"CreatedNode": {"LedgerEntryType": "AccountRoot", "NewFields": {"Account": BUYER}}}])


class Ledger:
    def __init__(self, f=None, page_size=200, network_id=1):
        self.f = fields() if f is None else f
        self.create = txn("CREATE", 100, {"TransactionType": "EscrowCreate", "Account": BUYER,
                                          "Destination": SELLER, "Sequence": SEQ}, index=3)
        self.owner = [ACCOUNT_CREATED, self.create]  # oldest first
        self.seller = [self.create]
        self.open = True
        self.page_size = page_size
        self.network_id = network_id
        self.drop_tx = False

    def deliver(self, h="DELIVER", ledger=110, index=0, account=SELLER, **kw):
        t = kw.pop("t", None)
        self.seller.append(txn(h, ledger, {"TransactionType": "AccountSet", "Account": account,
                                           "Memos": memos(**kw)}, index=index, t=t))
        return self

    def settle(self, kind="EscrowFinish", ledger=120, index=0, by=SELLER):
        t = txn("SETTLE", ledger, {"TransactionType": kind, "Account": by, "Owner": BUYER,
                                   "OfferSequence": SEQ},
                index=index, nodes=[{"DeletedNode": {"LedgerEntryType": "Escrow", "FinalFields": self.f}}])
        self.owner.append(t)
        self.seller.append(t)
        self.open = False
        return self

    def __call__(self, method, params):
        if method == "server_info":
            return {"info": {"network_id": self.network_id}}
        if method == "ledger_entry":
            return {"node": self.f} if self.open else {"error": "entryNotFound"}
        if method == "account_info":
            return {"account_data": {}} if params["account"] in (BUYER, SELLER) else {"error": "actNotFound"}
        if method == "tx":
            if self.drop_tx:
                return {"error": "txnNotFound"}
            for t in self.owner + self.seller:
                if t["hash"] == params["transaction"]:
                    return t
            return {"error": "txnNotFound"}
        if method == "account_tx":
            history = self.owner if params["account"] == BUYER else self.seller
            history = sorted(history, key=lambda t: (t["ledger_index"], t["meta"]["TransactionIndex"]))
            if params.get("forward"):
                history = [t for t in history if t["ledger_index"] >= params["ledger_index_min"]]
            else:
                history = history[::-1]
            start = params.get("marker", 0)
            page = history[start:start + self.page_size]
            out = {"transactions": page}
            if start + self.page_size < len(history):
                out["marker"] = start + self.page_size
            return out
        raise AssertionError(method)


def payment(**over):
    p = {"rail": "escrow:xrpl", "network": "xrpl:1", "asset": "XRP", "amount": "2000000",
         "reference": ESCROW, "payer": f"xrpl:1:{BUYER}", "payee": f"xrpl:1:{SELLER}"}
    p.update(over)
    return {k: v for k, v in p.items() if v is not None}


def run(ledger, acceptance=None, max_pages=10, **over):
    p = payment(**over)
    acc = acceptance or {"mode": "buyer", "reviewWindowSeconds": 600}
    return check_xrpl_escrow_payment(escrow_signed(p, acc), bare(p.get("payer")), bare(p.get("payee")),
                                     rpc=ledger, max_pages=max_pages)


# --- settlement and delivery -------------------------------------------------------------------


def test_finished_escrow_with_delivery_passes():
    res = run(Ledger().deliver().settle())
    assert res.status == "pass", res.detail
    assert "1900 s before CancelAfter" in res.detail  # delivery at T0 + 100


def test_open_delivered_cancelled_and_undelivered():
    assert run(Ledger().deliver()).status == "pending"
    res = run(Ledger().deliver().settle("EscrowCancel"))
    assert res.status == "fail" and "refunded" in res.detail
    res = run(Ledger())
    assert res.status == "fail" and "different receipt" in res.detail
    assert run(Ledger().settle()).status == "fail"  # finished, never delivered


def test_first_memo_wins_and_later_ones_are_ignored():
    led = Ledger().deliver("D1", ledger=105, receipt_hash="ab" * 32).deliver("D2", ledger=110).settle()
    res = run(led)
    assert res.status == "fail" and "different receipt" in res.detail
    # Same ledger: transaction index decides.
    led = Ledger().deliver("D1", ledger=110, index=2, receipt_hash="ab" * 32).deliver("D2", ledger=110, index=1).settle()
    assert run(led).status == "pass"


def test_memo_in_the_create_ledger_before_the_create_is_ignored():
    led = Ledger().deliver("EARLY", ledger=100, index=1).settle()
    assert run(led).status == "fail"
    led = Ledger().deliver("AFTER", ledger=100, index=4).settle()
    assert run(led).status == "pass"


def test_memo_after_cancel_after_or_settlement_is_ignored():
    assert run(Ledger().deliver(t=CANCEL + 1).settle()).status == "fail"
    assert run(Ledger().deliver(t=CANCEL, ledger=110).settle()).status == "fail"  # 0 s left < 600
    assert run(Ledger().deliver(ledger=130).settle(ledger=120)).status == "fail"


def test_memo_from_another_account_or_for_another_escrow_is_ignored():
    assert run(Ledger().deliver(account=OTHER).settle()).status == "fail"
    assert run(Ledger().deliver(escrow=f"{BUYER}:1").settle()).status == "fail"
    assert run(Ledger().deliver(escrow=None).settle()).status == "fail"


def test_creation_found_by_history_when_previous_txn_id_is_absent():
    led = Ledger(fields(PreviousTxnID=None)).deliver().settle()
    assert run(led).status == "pass"
    led = Ledger().deliver().settle()
    led.drop_tx = True  # PreviousTxnID lookup fails over to the owner's history
    assert run(led).status == "pass"


# --- incomplete history ------------------------------------------------------------------------


def test_truncated_history_is_unavailable():
    led = Ledger(page_size=1).deliver().settle()
    led.owner.extend(txn(f"N{i}", 200 + i, {"TransactionType": "AccountSet", "Account": BUYER}) for i in range(5))
    res = run(led, max_pages=2)
    assert res.status == "unavailable" and "incomplete" in res.detail
    assert run(Ledger(page_size=1).deliver().settle(), max_pages=10).status == "pass"


def test_history_that_does_not_reach_the_account_creation_is_unavailable():
    led = Ledger().deliver()
    led.owner.remove(ACCOUNT_CREATED)
    led.open = False  # finished elsewhere: nothing in the visible history
    res = run(led)
    assert res.status == "unavailable" and "creation" in res.detail


def test_escrow_not_found_with_complete_history_fails():
    led = Ledger()
    led.open = False
    res = run(led)
    assert res.status == "fail" and "not found" in res.detail


def test_escrow_create_not_found_fails():
    led = Ledger(fields(PreviousTxnID=None)).deliver()
    led.owner.remove(led.create)
    res = run(led)
    assert res.status == "fail" and "EscrowCreate" in res.detail


def test_rpc_problems_are_unavailable():
    def broken(method, params):
        raise XrplRpcError("down")

    assert run(broken).status == "unavailable"
    assert run(Ledger(network_id=0).deliver().settle()).status == "unavailable"


# --- terms -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "over,needle",
    [
        ({"amount": "1"}, "amount differs"),
        ({"payer": f"xrpl:1:{OTHER}"}, "buyer differs"),
        ({"payee": f"xrpl:1:{OTHER}"}, "seller differs"),
        ({"asset": f"USD.{ISSUER}"}, "asset differs"),
    ],
)
def test_wrong_terms_fail(over, needle):
    res = run(Ledger().deliver().settle(), **over)
    assert res.status == "fail" and needle in res.detail


def test_review_window_bound():
    assert run(Ledger().deliver().settle(), {"mode": "buyer", "reviewWindowSeconds": 1900}).status == "pass"
    res = run(Ledger().deliver().settle(), {"mode": "buyer", "reviewWindowSeconds": 1901})
    assert res.status == "fail" and "exceeds" in res.detail
    # No CancelAfter: no bound.
    assert run(Ledger(fields(cancel=None)).deliver().settle(), {"mode": "buyer", "reviewWindowSeconds": 10**9}).status == "pass"


def test_buyer_mode_needs_a_condition():
    res = run(Ledger(fields(condition=None)).deliver().settle())
    assert res.status == "fail" and "no Condition" in res.detail


def test_evaluator_mode_is_at_best_unavailable():
    acc = {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"xrpl:1:{OTHER}"}
    assert run(Ledger().deliver().settle(by=OTHER), acc).status == "unavailable"
    assert run(Ledger(fields(condition=None)).deliver().settle(), acc).status == "fail"


def test_auto_mode():
    acc = {"mode": "auto", "reviewWindowSeconds": 0}
    assert run(Ledger().deliver().settle(), acc).status == "fail"  # conditional can't auto-release
    assert run(Ledger(fields(condition=None)).deliver().settle(), acc).status == "unavailable"


def test_missing_parties_are_unavailable():
    assert run(Ledger().deliver().settle(), payer=None).status == "unavailable"
    assert run(Ledger().deliver().settle(), payee=None).status == "unavailable"


def test_issued_currency_identity():
    amount = {"currency": "USD", "issuer": ISSUER, "value": "2"}
    led = lambda: Ledger(fields(amount=amount)).deliver().settle()  # noqa: E731
    assert run(led(), asset=f"USD.{ISSUER}").status == "pass"
    std_hex = "0" * 24 + "555344" + "0" * 10
    assert run(led(), asset=f"{std_hex}.{ISSUER}").status == "pass"  # same 160-bit identity
    assert run(led(), asset=f"usd.{ISSUER}").status == "fail"  # case-sensitive
    assert run(led(), asset=f"{'555344'.ljust(40, '0')}.{ISSUER}").status == "fail"  # nonstandard
    assert run(led(), asset=f"USD.{OTHER}").status == "fail"
    assert run(led(), asset="XRP").status == "fail"


def test_escrow_amount_units():
    assert escrow_amount_units("2000000") == "2000000"
    assert escrow_amount_units({"currency": "USD", "issuer": ISSUER, "value": "1.5"}) == "1500000"
    assert escrow_amount_units({"currency": "USD", "issuer": ISSUER, "value": "1e-6"}) == "1"
    with pytest.raises(ValueError):
        escrow_amount_units({"currency": "USD", "issuer": ISSUER, "value": "1e-7"})


# --- references and memos ----------------------------------------------------------------------


def test_bad_references_fail_without_rpc():
    def no_rpc(method, params):
        raise AssertionError("no RPC expected")

    for ref in (f"{BUYER}:0", f"{BUYER}:4294967296", "rNotAnAddress:1", f"{BUYER}:1\n"):
        assert run(no_rpc, reference=ref).status == "fail"
    assert run(no_rpc, network="xrpl:0", payer=f"xrpl:0:{BUYER}", payee=f"xrpl:0:{SELLER}").status == "unavailable"


def test_escrow_id_and_memo_parsing():
    assert parse_xrpl_escrow_id(ESCROW) == (BUYER, SEQ)
    m = memos() + [{"Memo": {"MemoType": RECEIPT_MEMO_TYPE, "MemoData": "CD" * 32}}]
    assert parse_receipt_memos(m) == (RH, ESCROW)
    bad_first = [{"Memo": {"MemoType": RECEIPT_MEMO_TYPE, "MemoData": "ZZ"}}] + memos()
    assert parse_receipt_memos(bad_first) == (RH, ESCROW)
    assert parse_receipt_memos(None) == (None, None)
