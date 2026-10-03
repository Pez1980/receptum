"""Level 3 for ``escrow:stellar-claimable`` (native Stellar claimable balances; SPEC §7, §7.3,
§7.4) from Horizon history.

One balance per job with two claimants whose windows never overlap: the buyer in
``[deadline, releaseAt)`` (``{and: [{not: {abs_before: deadline}}, {abs_before: releaseAt}]}``) and
the seller from ``releaseAt`` (``{not: {abs_before: releaseAt}}``); the review window is
``releaseAt − deadline``.

- **Delivery** — the first successful seller transaction after the balance was created and
  strictly before the deadline with ``MEMO_HASH = h`` that also writes the seller data entry named
  by the balance hash with the value ``h``. Later or mutable data never changes it.
- **Settlement** — the successful ``claim_claimable_balance``: by the seller, released; by the buyer,
  released (early acceptance) only when the same transaction pays the seller the escrowed amount
  and that payment is not allocated to another escrow claimed in the same transaction (payments are
  allocated in operation order, each escrow taking the first unused exact payment from its buyer to
  its seller in its asset); otherwise refunded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .evm import CheckResult
from .stellar import (
    STELLAR_NETWORKS,
    VERSION_CLAIMABLE_BALANCE,
    Fetch,
    Horizon,
    HorizonError,
    HorizonNotFound,
    decode_strkey,
    from_stellar_amount,
    hash_from_base64,
    horizon_for,
    same_stellar_asset,
    unix_seconds,
)

__all__ = [
    "STELLAR_CLAIMABLE_RAIL",
    "ClaimableState",
    "allocate_claim_payments",
    "check_stellar_claimable",
    "derive_state",
    "parse_balance_id",
    "parse_escrow_terms",
]

STELLAR_CLAIMABLE_RAIL = "escrow:stellar-claimable"
DEFAULT_MAX_HISTORY = 1000

_BALANCE_HEX = re.compile(r"^00000000[0-9a-f]{64}\Z")
# SPEC §7.5: payment.reference is the balance id, exactly — Horizon's hex form (any case) or its
# SEP-23 strkey. Anything else (whitespace included) fails.
_REFERENCE = re.compile(r"^(?:00000000[0-9A-Fa-f]{64}|B[A-Z2-7]{57})\Z")


class NotAnEscrow(ValueError):
    """The balance does not have exactly the Receptum claimant shape (``fail``)."""


class Contradiction(Exception):
    """Horizon contradicts the receipt (``fail``)."""


def parse_balance_id(escrow_id: Any) -> str:
    """Horizon hex balance id (``00000000`` + 64 hex), from that form (any case) or a ``B…``
    strkey. ValueError otherwise."""
    if not isinstance(escrow_id, str):
        raise ValueError(f"invalid Stellar escrow id: {escrow_id}")
    s = escrow_id.strip()
    if _BALANCE_HEX.match(s.lower()):
        return s.lower()
    if s.startswith("B"):
        try:
            raw = decode_strkey(VERSION_CLAIMABLE_BALANCE, s, 33)
        except ValueError:
            raw = b""
        if len(raw) == 33 and raw[0] == 0:
            return "00000000" + raw[1:].hex()
    raise ValueError(f"invalid Stellar escrow id: {escrow_id}")


# --- predicates → terms ----------------------------------------------------------------------


def _safe_int(text: Any) -> int | None:
    if isinstance(text, str) and re.fullmatch(r"\s*[+-]?[0-9]+\s*", text):
        n = int(text)
        return n if abs(n) <= 2**53 - 1 else None
    return None


def _abs_before(p: Any) -> int | None:
    if not isinstance(p, dict) or "abs_before" not in p:
        return None
    if any(not k.startswith("abs_before") for k in p):
        return None
    epoch = p.get("abs_before_epoch")
    if epoch is not None:
        return _safe_int(epoch) if isinstance(epoch, str) else None
    t = unix_seconds(p.get("abs_before"))
    return int(t) if t is not None and t == int(t) else None


def _not_before(p: Any) -> int | None:
    if not isinstance(p, dict) or "not" not in p or len(p) != 1:
        return None
    return _abs_before(p["not"])


def _window(p: Any) -> tuple[int, int] | None:
    if not isinstance(p, dict) or len(p) != 1 or not isinstance(p.get("and"), list):
        return None
    if len(p["and"]) != 2:
        return None
    x, y = p["and"]
    start = _not_before(x)
    if start is None:
        start = _not_before(y)
    until = _abs_before(x)
    if until is None:
        until = _abs_before(y)
    return (start, until) if start is not None and until is not None else None


@dataclass
class Terms:
    buyer: str
    seller: str
    deadline: int
    release_at: int


def parse_escrow_terms(claimants: Any) -> Terms:
    """Escrow terms from a balance's claimants; NotAnEscrow unless exactly the Receptum shape."""
    if not isinstance(claimants, list) or len(claimants) != 2:
        raise NotAnEscrow("not a Receptum escrow: expected 2 claimants")
    seller = buyer = None
    for c in claimants:
        if not isinstance(c, dict):
            continue
        pred = c.get("predicate")
        release_at = _not_before(pred)
        w = _window(pred) if isinstance(pred, dict) else None
        if release_at is not None:
            seller = (c.get("destination"), release_at)
        elif w:
            buyer = (c.get("destination"), w[0], w[1])
    if not seller or not buyer:
        raise NotAnEscrow("not a Receptum escrow: unexpected predicates")
    if buyer[2] != seller[1]:
        raise NotAnEscrow("not a Receptum escrow: buyer and seller windows are not contiguous")
    terms = Terms(buyer=buyer[0], seller=seller[0], deadline=buyer[1], release_at=seller[1])
    if terms.buyer == terms.seller:
        raise NotAnEscrow("not a Receptum escrow: buyer and seller must differ")
    for name, v in (("deadline", terms.deadline), ("releaseAt", terms.release_at)):
        if v <= 0:
            raise NotAnEscrow(f"not a Receptum escrow: {name} must be unix seconds")
    if terms.release_at <= terms.deadline:
        raise NotAnEscrow(
            "not a Receptum escrow: review window must be > 0: the buyer's refund window would be empty"
        )
    return terms


# --- history ---------------------------------------------------------------------------------


@dataclass
class DataOp:
    account: str
    name: str
    value: str | None  # base64, None for a deletion


@dataclass
class DeliveryTx:
    hash: str
    successful: bool
    created_at: str
    memo_type: str
    memo: str | None
    data_ops: list[DataOp] = field(default_factory=list)


@dataclass
class BatchClaim:
    escrow_id: str
    claimant: str
    buyer: str
    seller: str
    asset: str
    amount: str  # Horizon decimal


@dataclass
class ClaimPayment:
    frm: str
    to: str
    asset: str
    amount: str  # Horizon decimal


@dataclass
class Claim:
    claimant: str
    transaction_hash: str
    payments: list[ClaimPayment]
    batch: list[BatchClaim] | None = None


@dataclass
class History:
    escrow_id: str
    asset: str
    amount: str
    claimants: list
    create_tx: str
    created_at: str
    delivery_txs: list[DeliveryTx]
    claim: Claim | None = None


def _create_record(horizon: Horizon, balance_id: str) -> tuple[dict, list[dict]] | None:
    """The balance's create operation and all its operations, or None if it isn't a balance."""
    try:
        records = horizon.records(
            f"/claimable_balances/{balance_id}/operations", order="asc", limit=200
        )
    except HorizonNotFound:
        return None
    create = next((r for r in records if r.get("type") == "create_claimable_balance"), None)
    if not create or not create.get("claimants") or not create.get("asset") or not create.get("amount"):
        return None
    return create, records


def _data_ops(horizon: Horizon, tx_hash: str) -> list[DataOp]:
    ops = horizon.records(f"/transactions/{tx_hash}/operations", limit=200)
    out = []
    for op in ops:
        if op.get("type") != "manage_data":
            continue
        # A muxed source (M…) is not the seller's G… account, as when read from the envelope.
        account = op.get("source_account_muxed") or op.get("source_account")
        value = op.get("value")
        out.append(DataOp(str(account), str(op.get("name")), value if value else None))
    return out


def _delivery_txs(
    horizon: Horizon, seller: str, cursor: str, deadline: int, max_history: int
) -> list[DeliveryTx]:
    """The seller's transactions after ``cursor`` (the creating transaction), oldest first, until
    the first one at or after the deadline."""
    out: list[DeliveryTx] = []
    for page in horizon.pages(
        f"/accounts/{seller}/transactions", cursor=cursor, order="asc", limit=200
    ):
        for tx in page:
            at = unix_seconds(tx.get("created_at"))
            if at is not None and at >= deadline:
                return out
            if len(out) >= max_history:
                raise HorizonError(
                    f"seller has more than {max_history} transactions before the deadline"
                )
            successful = tx.get("successful") is True
            memo_type = str(tx.get("memo_type"))
            ops = (
                _data_ops(horizon, tx["hash"])
                if successful and memo_type == "hash" and isinstance(tx.get("hash"), str)
                else []
            )
            out.append(
                DeliveryTx(
                    hash=str(tx.get("hash")),
                    successful=successful,
                    created_at=str(tx.get("created_at")),
                    memo_type=memo_type,
                    memo=tx.get("memo") if isinstance(tx.get("memo"), str) else None,
                    data_ops=ops,
                )
            )
    return out


def read_history(horizon: Horizon, balance_id: str, max_history: int = DEFAULT_MAX_HISTORY) -> History:
    found = _create_record(horizon, balance_id)
    if not found:
        raise Contradiction(f"unknown escrow {balance_id}")
    create, records = found
    terms = parse_escrow_terms(create["claimants"])
    create_tx = horizon.transaction(create["transaction_hash"])
    history = History(
        escrow_id=balance_id,
        asset=create["asset"],
        amount=create["amount"],
        claimants=create["claimants"],
        create_tx=create["transaction_hash"],
        created_at=create_tx.get("created_at"),
        delivery_txs=_delivery_txs(
            horizon, terms.seller, str(create_tx.get("paging_token")), terms.deadline, max_history
        ),
    )
    claim = next(
        (
            r
            for r in records
            if r.get("type") == "claim_claimable_balance"
            and r.get("transaction_successful") is not False
        ),
        None,
    )
    if claim and claim.get("claimant"):
        ops = horizon.records(f"/transactions/{claim['transaction_hash']}/operations", limit=200)
        batch: list[BatchClaim] = []
        for op in ops:
            if op.get("type") != "claim_claimable_balance" or not op.get("balance_id") or not op.get("claimant"):
                continue
            bid = str(op["balance_id"]).lower()
            rec = create if bid == balance_id else (_create_record(horizon, bid) or (None,))[0]
            if not rec:
                continue
            try:
                t = parse_escrow_terms(rec["claimants"])
            except NotAnEscrow:
                continue  # not a Receptum escrow: it can't consume payments
            batch.append(BatchClaim(bid, op["claimant"], t.buyer, t.seller, rec["asset"], rec["amount"]))
        payments = [
            ClaimPayment(
                r["from"],
                r["to"],
                "native" if r.get("asset_type") == "native" else f"{r.get('asset_code')}:{r.get('asset_issuer')}",
                r["amount"],
            )
            for r in ops
            if r.get("type") == "payment" and r.get("from") and r.get("to") and r.get("amount")
        ]
        history.claim = Claim(claim["claimant"], claim["transaction_hash"], payments, batch)
    return history


# --- pure derivation -------------------------------------------------------------------------


@dataclass
class ClaimableState:
    escrow_id: str
    status: str  # open | delivered | released | refunded
    amount: str
    asset: str
    buyer: str
    seller: str
    deadline: int
    release_at: int
    opened_by: str
    receipt_hash: str | None = None
    delivered_by: str | None = None
    settled_by: str | None = None
    released_by: str | None = None  # "seller" | "buyer-acceptance"


def find_delivery(escrow_id: str, terms: Terms, opened_at: str, txs: list[DeliveryTx]) -> tuple[str, str] | None:
    """(receiptHash, transaction hash) of the delivery, or None."""
    key = escrow_id[8:]
    opened = unix_seconds(opened_at)
    for tx in txs:
        at = unix_seconds(tx.created_at)
        if at is None or (opened is not None and at < opened):
            continue
        if at >= terms.deadline:
            break  # the buyer's window has opened: no later delivery counts
        if not tx.successful or tx.memo_type != "hash":
            continue
        h = hash_from_base64(tx.memo)
        if not h:
            continue
        if any(
            op.account == terms.seller
            and op.name == key
            and op.value is not None
            and hash_from_base64(op.value) == h
            for op in tx.data_ops
        ):
            return h, tx.hash
    return None


def allocate_claim_payments(claims: list[BatchClaim], payments: list[ClaimPayment]) -> dict[str, int]:
    """escrowId → index of the payment backing its buyer acceptance (one payment backs at most one
    escrow; operation order)."""
    used: set[int] = set()
    out: dict[str, int] = {}
    for c in claims:
        if c.claimant != c.buyer or c.escrow_id in out:
            continue
        want = from_stellar_amount(c.amount)
        for j, p in enumerate(payments):
            if (
                j not in used
                and p.frm == c.buyer
                and p.to == c.seller
                and p.asset == c.asset
                and from_stellar_amount(p.amount) == want
            ):
                used.add(j)
                out[c.escrow_id] = j
                break
    return out


def derive_state(h: History) -> ClaimableState:
    terms = parse_escrow_terms(h.claimants)
    delivery = find_delivery(h.escrow_id, terms, h.created_at, h.delivery_txs)
    state = ClaimableState(
        escrow_id=h.escrow_id,
        status="open",
        amount=from_stellar_amount(h.amount),
        asset=h.asset,
        buyer=terms.buyer,
        seller=terms.seller,
        deadline=terms.deadline,
        release_at=terms.release_at,
        opened_by=h.create_tx,
        receipt_hash=delivery[0] if delivery else None,
        delivered_by=delivery[1] if delivery else None,
    )
    claim = h.claim
    if not claim:
        state.status = "delivered" if delivery else "open"
        return state
    state.settled_by = claim.transaction_hash
    if claim.claimant == terms.seller:
        state.status, state.released_by = "released", "seller"
        return state
    if claim.claimant != terms.buyer:
        raise ValueError("escrow claimed by an unknown account")
    me = BatchClaim(h.escrow_id, claim.claimant, terms.buyer, terms.seller, h.asset, h.amount)
    batch = claim.batch if claim.batch is not None else [me]
    if not any(c.escrow_id == h.escrow_id for c in batch):
        raise ValueError("claim batch omits escrow")
    if h.escrow_id in allocate_claim_payments(batch, claim.payments):
        state.status, state.released_by = "released", "buyer-acceptance"
    else:
        state.status = "refunded"
    return state


# --- level 3 decision ------------------------------------------------------------------------


def check_claimable_state(signed: dict, state: ClaimableState, payer: str | None, payee: str | None) -> CheckResult:
    pay = signed["receipt"]["payment"]
    network = pay["network"]
    acc = signed["receipt"]["acceptance"]
    window = state.release_at - state.deadline
    problems = [
        p
        for p in (
            state.receipt_hash != signed["receiptHash"]
            and "no delivery anchor for this receipt before the deadline",
            state.amount != pay["amount"] and "amount differs",
            not same_stellar_asset(state.asset, pay["asset"], network) and "asset differs",
            payer and state.buyer != payer and "buyer differs from payment.payer",
            payee and state.seller != payee and "seller differs from payment.payee",
            window != acc["reviewWindowSeconds"]
            and "review window differs from acceptance.reviewWindowSeconds",
            acc["mode"] == "evaluator" and "claimable-balance escrows can't enforce an evaluator",
        )
        if p
    ]
    if problems:
        return CheckResult("fail", f"escrow {state.status}: {'; '.join(problems)}")
    if not payee:
        return CheckResult(
            "unavailable", "receipt does not name a payee, so the recipient can't be confirmed"
        )
    if state.status == "delivered":
        return CheckResult(
            "pending", "delivered; awaiting the buyer window to pass or the buyer's acceptance"
        )
    if state.status != "released":
        return CheckResult("fail", f"escrow is {state.status}")
    return CheckResult(
        "pass",
        f"claimable balance released to the payee ({state.released_by}); first delivery anchor "
        f"{state.delivered_by} matches",
    )


def check_stellar_claimable(
    signed: dict,
    payer: str | None,
    payee: str | None,
    *,
    horizons: dict[str, str] | None = None,
    fetch: Fetch | None = None,
    max_history: int = DEFAULT_MAX_HISTORY,
) -> CheckResult:
    pay = signed["receipt"]["payment"]
    network = pay["network"]
    if network not in STELLAR_NETWORKS:
        return CheckResult("unavailable", f"unsupported network {network}")
    reference = pay["reference"]
    try:
        if not isinstance(reference, str) or not _REFERENCE.match(reference):
            raise ValueError
        balance_id = parse_balance_id(reference)
    except ValueError:
        return CheckResult(
            "fail",
            f"invalid Stellar escrow id: {reference} (expected the claimable balance id: "
            "00000000 + 64 hex, or its B… strkey)",
        )
    horizon = horizon_for(network, horizons, fetch)
    if horizon is None:
        return CheckResult("unavailable", f"no Horizon endpoint configured for {network}")
    try:
        state = derive_state(read_history(horizon, balance_id, max_history))
    except (Contradiction, NotAnEscrow) as exc:
        return CheckResult("fail", str(exc))
    except (HorizonError, ValueError, KeyError, TypeError) as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")
    return check_claimable_state(signed, state, payer, payee)
