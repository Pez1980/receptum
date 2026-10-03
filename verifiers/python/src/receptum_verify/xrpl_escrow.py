"""Level 3 for ``escrow:xrpl`` (XRPL native Escrow; SPEC §7 and §7.3 "XRPL escrows") over
rippled JSON-RPC (urllib).

State is derived from validated history only:

- **Settlement** — the ``EscrowFinish`` / ``EscrowCancel`` in the owner's history that deleted the
  ``Escrow`` entry (its ``FinalFields`` are the escrow's terms); an escrow still in the validated
  ledger is open or delivered.
- **Delivery** — the *first* successful transaction from the escrow's ``Destination`` (the seller)
  carrying a ``receptum/1`` memo and a ``receptum/escrow`` memo naming the escrow, ordered after the
  ``EscrowCreate`` (ledger index, then transaction index), with a ledger close time no later than
  ``CancelAfter``, and before the settling transaction. Later memos are ignored.
- **Completeness** — absence is only proven by a history read back to the transaction that created
  the owner account (or a missing account). A page limit reached with a ``marker`` left, or a server
  whose history doesn't reach the account's creation, is ``unavailable``.

The rules a reviewer may want to change are separate functions: ``escrow_amount_units`` (how an
escrowed amount maps to ``payment.amount``) and one ``_<mode>_terms`` function per acceptance mode.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterator

from .binding import is_classic_address
from .evm import CheckResult
from .xrpl_x402 import (
    DEFAULT_XRPL_JSON_RPCS,
    RECEIPT_MEMO_TYPE,
    XrplRpcError,
    _asset_currency_id,
    _currency_id,
    xrpl_json_rpc,
)

__all__ = [
    "ESCROW_MEMO_TYPE",
    "XrplEscrowState",
    "XrplHistoryIncomplete",
    "XrplLedger",
    "check_xrpl_escrow",
    "check_xrpl_escrow_payment",
    "escrow_amount_units",
    "parse_xrpl_escrow_id",
    "read_xrpl_escrow",
]

ESCROW_MEMO_TYPE = b"receptum/escrow".hex().upper()
XRPL_TESTNET = "xrpl:1"
RIPPLE_EPOCH = 946684800
DEFAULT_MAX_PAGES = 10
# Fractional digits mapping an issued-token escrow value to payment.amount (the TypeScript
# adapter's default iouDecimals). SPEC v1 does not define this unit; see escrow_amount_units.
ISSUED_DECIMALS = 6

Rpc = Callable[[str, dict], Any]


class XrplHistoryIncomplete(Exception):
    """The history needed to decide could not be read in full (``unavailable``)."""


class Contradiction(Exception):
    """The validated ledger contradicts the receipt (``fail``)."""


class XrplError(Exception):
    """An rippled error reply (``code`` = its ``error``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- ids, memos, amounts ---------------------------------------------------------------------

_ESCROW_ID = re.compile(r"^(r[1-9A-HJ-NP-Za-km-z]{24,34}):([1-9][0-9]{0,9})\Z")


def parse_xrpl_escrow_id(escrow_id: Any) -> tuple[str, int]:
    """``<owner>:<OfferSequence>`` → (owner, sequence); ValueError when malformed."""
    m = _ESCROW_ID.match(escrow_id) if isinstance(escrow_id, str) else None
    if not m or not is_classic_address(m.group(1)) or int(m.group(2)) > 0xFFFFFFFF:
        raise ValueError(f"invalid XRPL escrow id: {escrow_id}")
    return m.group(1), int(m.group(2))


def _unhex_utf8(data: str) -> str:
    """Hex → UTF-8 text, leniently (as Node's Buffer.from(hex)): stops at the first bad pair."""
    out = bytearray()
    for i in range(0, len(data) - 1, 2):
        pair = data[i : i + 2]
        if not re.fullmatch(r"[0-9A-Fa-f]{2}", pair):
            break
        out.append(int(pair, 16))
    return out.decode("utf-8", "replace")


def parse_receipt_memos(memos: Any) -> tuple[str | None, str | None]:
    """(receiptHash, escrowId) from a transaction's memos: the first well-formed ``receptum/1``
    memo and the first ``receptum/escrow`` memo. Unknown or malformed memos are ignored."""
    receipt_hash = escrow_id = None
    for entry in memos if isinstance(memos, list) else []:
        m = entry.get("Memo") if isinstance(entry, dict) else None
        if not isinstance(m, dict):
            continue
        mtype = m.get("MemoType")
        mtype = mtype.upper() if isinstance(mtype, str) else None
        data = m.get("MemoData")
        if not isinstance(data, str) or not data:
            continue
        if mtype == RECEIPT_MEMO_TYPE and receipt_hash is None:
            h = data.lower()
            if re.fullmatch(r"[0-9a-f]{64}", h):
                receipt_hash = h
        elif mtype == ESCROW_MEMO_TYPE and escrow_id is None:
            escrow_id = _unhex_utf8(data)
    return receipt_hash, escrow_id


_ISSUED_VALUE = re.compile(r"^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\Z")


def _unscale(value: Any, decimals: int) -> str:
    m = _ISSUED_VALUE.match(value) if isinstance(value, str) else None
    if not m:
        raise ValueError(f"unsupported amount value: {value}")
    frac = m.group(2) or ""
    digits = m.group(1) + frac
    exp = int(m.group(3) or 0) - len(frac) + decimals
    while exp < 0 and digits.endswith("0"):
        digits = digits[:-1]
        exp += 1
    if exp < 0:
        raise ValueError(f"{value} has more than {decimals} decimals")
    return str(int(digits + "0" * exp))


def escrow_amount_units(amount: Any) -> str:
    """The escrowed ``Amount`` as an integer ``payment.amount``: XRP drops as-is; an issued value
    scaled by ``ISSUED_DECIMALS`` (the reference adapter's default). Raises ValueError."""
    if isinstance(amount, str):
        if not re.fullmatch(r"0|[1-9][0-9]*", amount):
            raise ValueError(f"invalid XRP amount: {amount}")
        return amount
    if isinstance(amount, dict):
        return _unscale(amount.get("value"), ISSUED_DECIMALS)
    raise ValueError("invalid escrow Amount")


def _amount_id(amount: Any) -> tuple[str, str | None] | None:
    """Protocol identity of a ledger amount: ("XRP", None) or (160-bit currency, issuer)."""
    if isinstance(amount, str):
        return "XRP", None
    if isinstance(amount, dict):
        cur = _currency_id(amount.get("currency"))
        issuer = amount.get("issuer")
        if cur is not None and isinstance(issuer, str):
            return cur, issuer
    return None


def _asset_id(asset: Any) -> tuple[str, str | None] | None:
    """Identity of a receipt's ``payment.asset`` (``XRP`` or ``<currency>.<issuer>``), or None."""
    if asset == "XRP":
        return "XRP", None
    if not isinstance(asset, str):
        return None
    symbol, dot, issuer = asset.rpartition(".")
    if not dot or not symbol or not is_classic_address(issuer):
        return None
    cur = _asset_currency_id(symbol)
    return (cur, issuer) if cur else None


# --- ledger access ---------------------------------------------------------------------------


@dataclass
class LedgerTx:
    hash: str
    tx: dict
    meta: dict
    close_time: str | None
    ledger_index: int | None

    def order(self) -> tuple[int, int]:
        idx = self.meta.get("TransactionIndex")
        return (self.ledger_index or 0, idx if isinstance(idx, int) else 0)


def _ripple_time(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        unix = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return round(unix) - RIPPLE_EPOCH


def _succeeded(meta: Any) -> bool:
    return isinstance(meta, dict) and meta.get("TransactionResult") == "tesSUCCESS"


class XrplLedger:
    """Validated-ledger reads over rippled JSON-RPC (``rpc(method, params) -> result``)."""

    def __init__(self, rpc: Rpc) -> None:
        self.rpc = rpc

    def request(self, method: str, params: dict) -> dict:
        result = self.rpc(method, {**params, "api_version": 2})
        if not isinstance(result, dict):
            raise XrplRpcError(f"{method}: malformed reply")
        if result.get("error"):
            raise XrplError(str(result["error"]), f"{method}: {result['error']}")
        return result

    def network_id(self) -> Any:
        info = self.request("server_info", {})
        return info.get("info", {}).get("network_id")

    def escrow_entry(self, owner: str, seq: int) -> dict | None:
        try:
            res = self.request(
                "ledger_entry", {"escrow": {"owner": owner, "seq": seq}, "ledger_index": "validated"}
            )
        except XrplError as exc:
            if exc.code == "entryNotFound":
                return None
            raise
        node = res.get("node")
        if not isinstance(node, dict):
            raise XrplRpcError("ledger_entry: no node")
        return node

    def account_exists(self, account: str) -> bool:
        try:
            self.request("account_info", {"account": account, "ledger_index": "validated"})
            return True
        except XrplError as exc:
            if exc.code == "actNotFound":
                return False
            raise

    def get_tx(self, tx_hash: str) -> LedgerTx | None:
        """A validated, successful transaction by hash, or None."""
        try:
            res = self.request("tx", {"transaction": tx_hash, "binary": False})
        except XrplError as exc:
            if exc.code == "txnNotFound":
                return None
            raise
        if res.get("validated") is not True or not _succeeded(res.get("meta")):
            return None
        tx = res.get("tx_json")
        if not isinstance(tx, dict):
            return None
        li = res.get("ledger_index")
        return LedgerTx(res.get("hash", ""), tx, res["meta"], res.get("close_time_iso"),
                        li if isinstance(li, int) else None)

    def account_txs(
        self, account: str, max_pages: int, *, forward: bool = False, from_ledger: int | None = None
    ) -> Iterator[LedgerTx]:
        """Validated, successful transactions affecting ``account``, newest first (or oldest
        first from ``from_ledger`` with ``forward``). More than ``max_pages`` pages raises
        XrplHistoryIncomplete rather than ending as if the history were complete."""
        marker = None
        for _ in range(max_pages):
            params: dict[str, Any] = {
                "account": account,
                "ledger_index_min": from_ledger if from_ledger is not None else -1,
                "ledger_index_max": -1,
                "limit": 200,
            }
            if forward:
                params["forward"] = True
            if marker:
                params["marker"] = marker
            res = self.request("account_tx", params)
            txs = res.get("transactions")
            if not isinstance(txs, list):
                raise XrplRpcError("account_tx: malformed reply")
            for t in txs:
                if not isinstance(t, dict) or t.get("validated") is not True:
                    continue
                tx, meta, h = t.get("tx_json"), t.get("meta"), t.get("hash")
                if not isinstance(tx, dict) or not h or not _succeeded(meta):
                    continue
                li = t.get("ledger_index")
                yield LedgerTx(h, tx, meta, t.get("close_time_iso"), li if isinstance(li, int) else None)
            marker = res.get("marker")
            if not marker:
                return
        raise XrplHistoryIncomplete(
            f"account_tx for {account} needs more than {max_pages} page(s)"
        )


def _creates_account(t: LedgerTx, account: str) -> bool:
    for n in t.meta.get("AffectedNodes") or []:
        c = n.get("CreatedNode") if isinstance(n, dict) else None
        if (
            isinstance(c, dict)
            and c.get("LedgerEntryType") == "AccountRoot"
            and isinstance(c.get("NewFields"), dict)
            and c["NewFields"].get("Account") == account
        ):
            return True
    return False


# --- state derivation ------------------------------------------------------------------------


@dataclass
class XrplEscrowState:
    escrow_id: str
    status: str  # open | delivered | released | refunded
    amount: str
    currency: str  # "XRP" or the 160-bit identity (40 upper-case hex)
    issuer: str | None
    buyer: str
    seller: str
    receipt_hash: str | None
    condition: str | None
    cancel_after: int | None
    finish_after: int | None
    # Ripple-epoch close time of the ledger holding the delivery memo, when delivered.
    delivery_close_time: int | None
    # Account that submitted the EscrowFinish / EscrowCancel, when settled.
    settled_by: str | None = None


def _assert_complete(ledger: XrplLedger, owner: str, reached_creation: bool, scanned: int) -> None:
    if reached_creation:
        return
    if scanned == 0 and not ledger.account_exists(owner):
        return
    raise XrplHistoryIncomplete(
        f"the server's account_tx history for {owner} does not reach the account's creation"
    )


def _closing(ledger: XrplLedger, owner: str, seq: int, max_pages: int):
    """(type, FinalFields, tx) of the EscrowFinish/EscrowCancel that deleted the escrow, or None."""
    reached, scanned = False, 0
    for t in ledger.account_txs(owner, max_pages):
        scanned += 1
        if _creates_account(t, owner):
            reached = True
        kind = t.tx.get("TransactionType")
        if kind not in ("EscrowFinish", "EscrowCancel"):
            continue
        offer = t.tx.get("OfferSequence")
        try:
            same_seq = int(offer) == seq
        except (TypeError, ValueError):
            same_seq = False
        if t.tx.get("Owner") != owner or not same_seq:
            continue
        for n in t.meta.get("AffectedNodes") or []:
            d = n.get("DeletedNode") if isinstance(n, dict) else None
            if isinstance(d, dict) and d.get("LedgerEntryType") == "Escrow":
                return kind, d.get("FinalFields") or {}, t
    _assert_complete(ledger, owner, reached, scanned)
    return None


def _creation(ledger: XrplLedger, escrow_id: str, owner: str, seq: int, fields: dict, max_pages: int) -> LedgerTx:
    def is_create(t: LedgerTx | None) -> bool:
        return (
            t is not None
            and t.tx.get("TransactionType") == "EscrowCreate"
            and t.tx.get("Account") == owner
            and (t.tx.get("TicketSequence") or t.tx.get("Sequence")) == seq
        )

    prev = fields.get("PreviousTxnID")
    if isinstance(prev, str) and prev:
        t = ledger.get_tx(prev)
        if is_create(t):
            return t  # type: ignore[return-value]
    reached, scanned = False, 0
    for t in ledger.account_txs(owner, max_pages):
        scanned += 1
        if is_create(t):
            return t
        if _creates_account(t, owner):
            reached = True
    _assert_complete(ledger, owner, reached, scanned)
    raise Contradiction(f"EscrowCreate for {escrow_id} not found in ledger history")


def _delivery(
    ledger: XrplLedger,
    escrow_id: str,
    fields: dict,
    created: LedgerTx,
    settled: LedgerTx | None,
    max_pages: int,
) -> tuple[str, LedgerTx] | None:
    """First seller memo for this escrow after the EscrowCreate, at or before CancelAfter and
    before the settling transaction (SPEC §7)."""
    seller = fields.get("Destination")
    cancel_after = fields.get("CancelAfter")
    for t in ledger.account_txs(seller, max_pages, forward=True, from_ledger=created.ledger_index):
        if t.order() <= created.order():
            continue
        if settled is not None and t.order() >= settled.order():
            break
        close = _ripple_time(t.close_time)
        # An unknown close time can't be placed before CancelAfter: stop rather than guess.
        if cancel_after and (close is None or close > cancel_after):
            break
        if t.tx.get("Account") != seller:
            continue
        receipt_hash, memo_escrow = parse_receipt_memos(t.tx.get("Memos"))
        if memo_escrow == escrow_id and receipt_hash:
            return receipt_hash, t
    return None


def read_xrpl_escrow(ledger: XrplLedger, escrow_id: str, max_pages: int = DEFAULT_MAX_PAGES) -> XrplEscrowState:
    owner, seq = parse_xrpl_escrow_id(escrow_id)
    open_fields = ledger.escrow_entry(owner, seq)
    closed = None if open_fields is not None else _closing(ledger, owner, seq, max_pages)
    fields = open_fields if open_fields is not None else (closed[1] if closed else None)
    if not fields:
        raise Contradiction(f"escrow {escrow_id} not found")
    created = _creation(ledger, escrow_id, owner, seq, fields, max_pages)
    delivery = _delivery(ledger, escrow_id, fields, created, closed[2] if closed else None, max_pages)
    if closed:
        status = "released" if closed[0] == "EscrowFinish" else "refunded"
    else:
        status = "delivered" if delivery else "open"
    ident = _amount_id(fields.get("Amount"))
    if ident is None:
        raise ValueError(f"escrow {escrow_id} holds an invalid currency")
    condition = fields.get("Condition")
    cancel_after = fields.get("CancelAfter") or None
    finish_after = fields.get("FinishAfter") or None
    return XrplEscrowState(
        escrow_id=escrow_id,
        status=status,
        amount=escrow_amount_units(fields.get("Amount")),
        currency=ident[0],
        issuer=ident[1],
        buyer=fields.get("Account"),
        seller=fields.get("Destination"),
        receipt_hash=delivery[0] if delivery else None,
        condition=condition.upper() if isinstance(condition, str) and condition else None,
        cancel_after=cancel_after,
        finish_after=finish_after,
        delivery_close_time=_ripple_time(delivery[1].close_time) if delivery else None,
        settled_by=closed[2].tx.get("Account") if closed else None,
    )


# --- level 3 decision ------------------------------------------------------------------------


def _review_window(state: XrplEscrowState) -> int | None:
    """Seconds the ledger left the buyer between the delivery and CancelAfter, when known."""
    if state.cancel_after is None or state.delivery_close_time is None:
        return None
    return state.cancel_after - state.delivery_close_time


def _conditional_terms(mode: str, acc: dict, state: XrplEscrowState) -> list[str]:
    """Shared by buyer and evaluator mode: release needed a fulfillment, and the delivery left at
    least the declared review window before CancelAfter."""
    problems = []
    if not state.condition:
        problems.append(f"escrow has no Condition, so release did not need the {mode}'s acceptance")
    window = _review_window(state)
    if window is not None and acc["reviewWindowSeconds"] > window:
        problems.append(
            f"acceptance.reviewWindowSeconds {acc['reviewWindowSeconds']} exceeds the {window} s "
            "the ledger left between delivery and CancelAfter"
        )
    return problems


def _buyer_terms(acc: dict, state: XrplEscrowState) -> tuple[list[str], CheckResult | None]:
    return _conditional_terms("buyer", acc, state), None


def _evaluator_terms(acc: dict, state: XrplEscrowState) -> tuple[list[str], CheckResult | None]:
    # The ledger shows a fulfillment was needed, not who held it (SPEC §7.3).
    return _conditional_terms("evaluator", acc, state), CheckResult(
        "unavailable",
        "the ledger shows a fulfillment was needed, not who held it: acceptance.evaluator can't "
        "be confirmed on XRPL",
    )


def _auto_terms(acc: dict, state: XrplEscrowState) -> tuple[list[str], CheckResult | None]:
    if state.condition:
        return [
            "escrow needs a fulfillment to release; it cannot auto-release as acceptance.mode "
            "auto states"
        ], None
    return [], CheckResult(
        "unavailable",
        "an unconditional XRPL escrow has no on-ledger review window; auto terms can't be confirmed",
    )


ACCEPTANCE_RULES = {"buyer": _buyer_terms, "evaluator": _evaluator_terms, "auto": _auto_terms}


def _same_asset(asset: str, state: XrplEscrowState) -> bool:
    want = _asset_id(asset)
    if want is None:
        return False
    if want[0] == "XRP":
        return state.currency == "XRP" and state.issuer is None
    return state.currency == want[0] and state.issuer == want[1]


def check_xrpl_escrow(
    signed: dict, state: XrplEscrowState, payer: str | None, payee: str | None
) -> CheckResult:
    """Decides level 3 from an escrow state read from the validated ledger. ``payer``/``payee``
    are the bare accounts already checked to be on ``payment.network`` (None when absent)."""
    pay = signed["receipt"]["payment"]
    acc = signed["receipt"]["acceptance"]
    mode_problems, outcome = ACCEPTANCE_RULES[acc["mode"]](acc, state)
    problems = [
        p
        for p in (
            state.receipt_hash != signed["receiptHash"]
            and "recorded delivery is for a different receipt",
            state.amount != pay["amount"] and "amount differs",
            not _same_asset(pay["asset"], state)
            and "asset differs (compared by protocol currency bytes and issuer)",
            payer and state.buyer != payer and "buyer differs from payment.payer",
            payee and state.seller != payee and "seller differs from payment.payee",
        )
        if p
    ] + mode_problems
    if problems:
        return CheckResult("fail", f"escrow {state.status}: {'; '.join(problems)}")
    if state.status in ("refunded", "open"):
        return CheckResult("fail", f"escrow is {state.status}")
    if not payer or not payee:
        return CheckResult(
            "unavailable",
            "receipt doesn't name both payer and payee, so the parties can't be confirmed",
        )
    if state.cancel_after is not None and state.delivery_close_time is None:
        return CheckResult(
            "unavailable",
            "the delivery's ledger close time is unknown, so the review window can't be checked",
        )
    if outcome is not None:
        return outcome
    if state.status == "delivered":
        return CheckResult("pending", "delivered; awaiting the buyer's fulfillment")
    window = _review_window(state)
    left = "no CancelAfter" if window is None else f"{window} s before CancelAfter"
    return CheckResult(
        "pass",
        "escrow finished to the payee; amount, asset, parties, delivery memo and buyer-held "
        f"condition match (delivered {left})",
    )


def check_xrpl_escrow_payment(
    signed: dict,
    payer: str | None,
    payee: str | None,
    *,
    rpcs: dict[str, str] | None = None,
    rpc: Rpc | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> CheckResult:
    """Reads the escrow at ``payment.reference`` and decides level 3. Incomplete history and
    lookups that can't be completed are ``unavailable``, never ``fail`` or ``pass``."""
    pay = signed["receipt"]["payment"]
    network = pay["network"]
    if network != XRPL_TESTNET:
        return CheckResult("unavailable", f"unsupported network {network}")
    try:
        parse_xrpl_escrow_id(pay["reference"])
    except ValueError as exc:
        return CheckResult("fail", str(exc))
    if rpc is None:
        url = {**DEFAULT_XRPL_JSON_RPCS, **(rpcs or {})}.get(network)
        if not url:
            return CheckResult("unavailable", f"no XRPL JSON-RPC endpoint configured for {network}")
        rpc = xrpl_json_rpc(url)
    ledger = XrplLedger(rpc)
    try:
        served = ledger.network_id()
        if served is not None and served != 1:
            return CheckResult("unavailable", f"the XRPL server serves NetworkID {served}, not 1")
        state = read_xrpl_escrow(ledger, pay["reference"], max_pages)
    except XrplHistoryIncomplete as exc:
        return CheckResult("unavailable", f"could not be checked: XRPL history incomplete: {exc}")
    except Contradiction as exc:
        return CheckResult("fail", str(exc))
    except (XrplError, XrplRpcError, ValueError, TypeError, KeyError) as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")
    return check_xrpl_escrow(signed, state, payer, payee)
