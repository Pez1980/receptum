"""Verification levels (SPEC §6) and the overall verdict."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .evm import DEFAULT_RPCS, CheckResult, check_evm_anchor, check_x402_exact
from .jws import verify_signed_receipt

__all__ = [
    "NOT_VERIFIED",
    "PARTIALLY_VERIFIED",
    "VERIFIED",
    "Report",
    "extract_signed_receipt",
    "verify",
]

VERIFIED = "VERIFIED"
PARTIALLY_VERIFIED = "PARTIALLY VERIFIED"
NOT_VERIFIED = "NOT VERIFIED"


@dataclass
class Report:
    status: str
    receipt_hash: str | None
    seller: str | None
    levels: dict[str, CheckResult]
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "receiptHash": self.receipt_hash,
            "seller": self.seller,
            "levels": {k: v.to_dict() for k, v in self.levels.items()},
            "errors": self.errors,
        }


def extract_signed_receipt(doc: Any) -> tuple[Any, str | None]:
    """Accept a bare signed receipt or a wrapper object with ``signedReceipt``.

    Returns (signedReceipt, anchor-from-wrapper-or-None). The wrapper's other
    members (settlement, check, …) are informational and never trusted."""
    if isinstance(doc, dict) and "signedReceipt" in doc:
        anchor = doc.get("anchor")
        return doc["signedReceipt"], anchor if isinstance(anchor, str) else None
    return doc, None


def _skip(detail: str) -> CheckResult:
    return CheckResult("skipped", detail)


def verify(
    signed: Any,
    file_bytes: bytes | None = None,
    *,
    anchor: str | None = None,
    offline: bool = False,
    rpcs: dict[str, str] | None = None,
) -> Report:
    rpcs = {**DEFAULT_RPCS, **(rpcs or {})}
    sig = verify_signed_receipt(signed)
    levels: dict[str, CheckResult] = {}

    # Level 1 — file <-> receipt (offline).
    receipt = signed.get("receipt") if isinstance(signed, dict) else None
    if file_bytes is None:
        levels["file"] = _skip("no file given")
    elif not sig.schema_ok:
        levels["file"] = CheckResult("fail", "receipt is invalid; nothing to compare against")
    else:
        digest = hashlib.sha256(file_bytes).hexdigest()
        if digest == receipt["outputSha256"]:
            levels["file"] = CheckResult("pass", f"SHA-256(file) = outputSha256 = {digest}")
        else:
            levels["file"] = CheckResult(
                "fail", f"SHA-256(file) {digest} != outputSha256 {receipt['outputSha256']}"
            )

    # Level 2 — receipt <-> seller (offline).
    if sig.ok:
        levels["signature"] = CheckResult(
            "pass", f"receiptHash recomputed and JWS verifies against {sig.seller}"
        )
    else:
        levels["signature"] = CheckResult("fail", "; ".join(sig.errors) or "invalid")

    # Level 3 — receipt <-> settlement (online): payment settled + receiptHash committed.
    if not sig.ok:
        levels["settlement"] = _skip("receipt not authenticated")
        levels["anchor"] = _skip("receipt not authenticated")
    elif offline:
        levels["settlement"] = _skip("offline")
        levels["anchor"] = _skip("offline")
    else:
        pay = receipt["payment"]
        if pay["rail"] == "x402:exact" and pay["network"].startswith("eip155:"):
            levels["settlement"] = check_x402_exact(receipt, rpcs)
        else:
            levels["settlement"] = CheckResult(
                "unavailable",
                f"rail {pay['rail']} on {pay['network']} is not supported by this verifier",
            )
        if anchor is None:
            levels["anchor"] = _skip("no anchor given; receiptHash commitment not checked")
        else:
            levels["anchor"] = check_evm_anchor(anchor, sig.receipt_hash, rpcs)

    statuses = [c.status for c in levels.values()]
    if "fail" in statuses:
        status = NOT_VERIFIED
    elif all(s == "pass" for s in statuses):
        status = VERIFIED
    else:
        status = PARTIALLY_VERIFIED
    return Report(status, sig.receipt_hash, sig.seller, levels, sig.errors)
