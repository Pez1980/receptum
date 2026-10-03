"""Strict RRF v1 receipt validation (docs/SPEC.md §2) and receiptHash (§3)."""

from __future__ import annotations

import calendar
import hashlib
import re
from typing import Any

from .encoding import EncodingError, did_key_public_key
from .jcs import canonicalize

__all__ = [
    "VERSION",
    "is_caip10",
    "is_caip2",
    "is_did",
    "receipt_hash",
    "validate_receipt",
]

VERSION = "receptum/1"
_MAX_SAFE_INTEGER = 2**53 - 1

HEX64 = re.compile(r"^[0-9a-f]{64}$")
_CROCKFORD = "[0-9A-HJKMNP-TV-Z]"
RECEIPT_ID = re.compile(rf"^RCPT-{_CROCKFORD}{{4}}-{_CROCKFORD}{{4}}$")
_CAIP2 = re.compile(r"^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$")
_CAIP10 = re.compile(r"^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$")
# W3C DID Core §3.1 ABNF (no path/query/fragment).
_IDCHAR = r"(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})"
_DID = re.compile(rf"^did:[a-z0-9]+:(?:{_IDCHAR}*:)*{_IDCHAR}+$")
_TIMESTAMP = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$")
_AMOUNT = re.compile(r"^(?:0|[1-9][0-9]*)$")

_TOP = {
    "version": True,
    "receiptId": True,
    "jobIdHash": True,
    "seller": True,
    "buyer": False,
    "inputSha256": True,
    "outputSha256": True,
    "evidence": False,
    "payment": True,
    "acceptance": True,
    "remedy": False,
    "supersedes": False,
    "deliveredAt": True,
}
_SELLER = {"id": True, "name": False}
_BUYER = {"id": False}
_PAYMENT = {
    "rail": True,
    "network": True,
    "asset": True,
    "amount": True,
    "reference": True,
    "payer": False,
    "payee": False,
}
_ACCEPTANCE = {"mode": True, "reviewWindowSeconds": True, "evaluator": False}
_REMEDY = {"kind": False, "withinDays": False, "termsSha256": False}


def is_caip2(s: Any) -> bool:
    return isinstance(s, str) and bool(_CAIP2.match(s))


def is_caip10(s: Any) -> bool:
    # "did:method:id" is also syntactically a CAIP-10 account; a DID is never one.
    return isinstance(s, str) and bool(_CAIP10.match(s)) and not s.startswith("did:")


def is_did(s: Any) -> bool:
    return isinstance(s, str) and bool(_DID.match(s))


def is_ed25519_did_key(s: Any) -> bool:
    try:
        did_key_public_key(s)
    except EncodingError:
        return False
    return True


def _is_int(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return abs(v) <= _MAX_SAFE_INTEGER
    # JSON (and JCS) cannot distinguish 3 from 3.0; accept integral doubles.
    return isinstance(v, float) and v.is_integer() and abs(v) <= _MAX_SAFE_INTEGER


def _members(obj: Any, spec: dict[str, bool], path: str, errors: list[str]) -> bool:
    if not isinstance(obj, dict):
        errors.append(f"{path} must be an object")
        return False
    for key in obj:
        if key not in spec:
            errors.append(f"{path}.{key} is not a v1 member")
    for key, required in spec.items():
        if key in obj and obj[key] is None:
            errors.append(f"{path}.{key} must be omitted, not null")
        elif required and key not in obj:
            errors.append(f"{path}.{key} is required")
    return True


def _string(obj: dict, key: str, path: str, errors: list[str]) -> str | None:
    v = obj.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        errors.append(f"{path}.{key} must be a string")
        return None
    if v == "":
        errors.append(f"{path}.{key} must not be empty")
        return None
    return v


def _hex64(obj: dict, key: str, path: str, errors: list[str]) -> None:
    v = obj.get(key)
    if v is not None and not (isinstance(v, str) and HEX64.match(v)):
        errors.append(f"{path}.{key} must be 64 lower-case hex characters")


def _timestamp_ok(s: str) -> bool:
    m = _TIMESTAMP.match(s)
    if not m:
        return False
    y, mo, d, h, mi, sec = (int(g) for g in m.groups())
    if not (1 <= mo <= 12) or y < 1:
        return False
    if not (1 <= d <= calendar.monthrange(y, mo)[1]):
        return False
    return h <= 23 and mi <= 59 and sec <= 59


def validate_receipt(receipt: Any) -> list[str]:
    """Return a list of violations of SPEC §2 (empty list = valid)."""
    errors: list[str] = []
    if not _members(receipt, _TOP, "receipt", errors):
        return errors
    r = receipt
    p = "receipt"

    if "version" in r and r["version"] != VERSION:
        errors.append(f'receipt.version must be "{VERSION}"')
    rid = r.get("receiptId")
    if rid is not None and not (isinstance(rid, str) and RECEIPT_ID.match(rid)):
        errors.append("receipt.receiptId must match RCPT-XXXX-XXXX (Crockford base32, upper-case)")
    _hex64(r, "jobIdHash", p, errors)
    _hex64(r, "outputSha256", p, errors)
    _hex64(r, "supersedes", p, errors)

    seller = r.get("seller")
    if seller is not None and _members(seller, _SELLER, "receipt.seller", errors):
        sid = _string(seller, "id", "receipt.seller", errors)
        if sid is not None and not (is_ed25519_did_key(sid) or is_caip10(sid)):
            errors.append("receipt.seller.id must be an Ed25519 did:key or a CAIP-10 account")
        _string(seller, "name", "receipt.seller", errors)

    buyer = r.get("buyer")
    if buyer is not None and _members(buyer, _BUYER, "receipt.buyer", errors):
        bid = _string(buyer, "id", "receipt.buyer", errors)
        if bid is not None and not (is_caip10(bid) or is_did(bid)):
            errors.append("receipt.buyer.id must be a CAIP-10 account or a DID")

    inputs = r.get("inputSha256")
    if inputs is not None:
        if not isinstance(inputs, list) or not inputs:
            errors.append("receipt.inputSha256 must be a non-empty array")
        elif not all(isinstance(h, str) and HEX64.match(h) for h in inputs):
            errors.append("receipt.inputSha256 entries must be 64 lower-case hex characters")

    evidence = r.get("evidence")
    if evidence is not None:
        if not isinstance(evidence, dict):
            errors.append("receipt.evidence must be an object")
        else:
            for k, v in evidence.items():
                if not (isinstance(v, str) and HEX64.match(v)):
                    errors.append(
                        f"receipt.evidence.{k} must be 64 lower-case hex characters"
                    )

    pay = r.get("payment")
    if pay is not None and _members(pay, _PAYMENT, "receipt.payment", errors):
        pp = "receipt.payment"
        for key in ("rail", "asset", "reference"):
            _string(pay, key, pp, errors)
        net = _string(pay, "network", pp, errors)
        if net is not None and not is_caip2(net):
            errors.append("receipt.payment.network must be a CAIP-2 chain id")
        amount = pay.get("amount")
        if amount is not None and not (isinstance(amount, str) and _AMOUNT.match(amount)):
            errors.append(
                "receipt.payment.amount must be a non-negative integer string (no sign, "
                "no leading zeros)"
            )
        for key in ("payer", "payee"):
            v = _string(pay, key, pp, errors)
            if v is not None and not is_caip10(v):
                errors.append(f"receipt.payment.{key} must be a CAIP-10 account")

    acc = r.get("acceptance")
    if acc is not None and _members(acc, _ACCEPTANCE, "receipt.acceptance", errors):
        mode = acc.get("mode")
        if mode is not None and mode not in ("buyer", "evaluator", "auto"):
            errors.append('receipt.acceptance.mode must be "buyer", "evaluator" or "auto"')
        rws = acc.get("reviewWindowSeconds")
        if rws is not None and not (_is_int(rws) and rws >= 0):
            errors.append("receipt.acceptance.reviewWindowSeconds must be an integer >= 0")
        ev = _string(acc, "evaluator", "receipt.acceptance", errors)
        if mode == "evaluator" and "evaluator" not in acc:
            errors.append("receipt.acceptance.evaluator is required when mode is evaluator")
        if ev is not None and not (is_did(ev) or is_caip10(ev)):
            errors.append("receipt.acceptance.evaluator must be a DID or a CAIP-10 account")

    rem = r.get("remedy")
    if rem is not None and _members(rem, _REMEDY, "receipt.remedy", errors):
        kind = rem.get("kind")
        if kind is not None and kind not in ("rerender", "refund", "terms"):
            errors.append('receipt.remedy.kind must be "rerender", "refund" or "terms"')
        wd = rem.get("withinDays")
        if wd is not None and not (_is_int(wd) and wd >= 0):
            errors.append("receipt.remedy.withinDays must be an integer >= 0")
        _hex64(rem, "termsSha256", "receipt.remedy", errors)
        if kind == "terms" and "termsSha256" not in rem:
            errors.append("receipt.remedy.termsSha256 is required when kind is terms")

    da = r.get("deliveredAt")
    if da is not None and not (isinstance(da, str) and _timestamp_ok(da)):
        errors.append("receipt.deliveredAt must be a UTC timestamp YYYY-MM-DDTHH:MM:SS[.f…]Z")

    return errors


def receipt_hash(receipt: Any) -> str:
    """lowercase-hex(SHA-256(JCS(receipt))) — SPEC §3."""
    return hashlib.sha256(canonicalize(receipt)).hexdigest()
