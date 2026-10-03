"""Verification levels (SPEC §6) and the overall verdict."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

from .binding import DEFAULT_XRPL_RPCS, check_payee_binding
from .evm import DEFAULT_RPCS, CheckResult, check_evm_anchor, check_x402_exact
from .jws import verify_signed_receipt
from .xrpl_x402 import check_xrpl_anchor, check_xrpl_x402_exact

__all__ = [
    "COMMITTING_RAILS",
    "NOT_VERIFIED",
    "PARTIALLY_VERIFIED",
    "VERIFIED",
    "InputError",
    "Report",
    "extract_signed_receipt",
    "verdict_of",
    "verify",
]

VERIFIED = "VERIFIED"
PARTIALLY_VERIFIED = "PARTIALLY VERIFIED"
NOT_VERIFIED = "NOT VERIFIED"

# Rails that commit receiptHash themselves (SPEC §7). Every other rail (x402) needs a mined
# anchor before level 3 can pass.
COMMITTING_RAILS = frozenset(
    {"escrow:receptum-evm", "escrow:receptum-soroban", "escrow:xrpl", "escrow:stellar-claimable"}
)


class InputError(ValueError):
    """The input file is not a signed receipt or a well-formed wrapper (CLI exit 2)."""


@dataclass
class Report:
    status: str
    receipt_hash: str | None
    seller: str | None
    levels: dict[str, CheckResult]
    errors: list[str] = field(default_factory=list)
    # When neither VERIFIED nor NOT VERIFIED: every missing piece that prevented VERIFIED.
    missing: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "receiptHash": self.receipt_hash,
            "seller": self.seller,
            "levels": {k: v.to_dict() for k, v in self.levels.items()},
            "missing": self.missing,
            "errors": self.errors,
        }


def extract_signed_receipt(doc: Any) -> tuple[Any, list[str]]:
    """Accept a bare signed receipt or a wrapper object with ``signedReceipt`` (SPEC §6.1).

    Returns (signedReceipt, anchors). The wrapper's ``anchor`` is one ``<caip2>:<tx>`` string or
    an array of them; anything else raises InputError. Every other wrapper member (settlement,
    check, …) is informational and never trusted."""
    if isinstance(doc, dict) and "signedReceipt" in doc:
        anchor = doc.get("anchor")
        if anchor is None and "anchor" not in doc:
            return doc["signedReceipt"], []
        if isinstance(anchor, str):
            return doc["signedReceipt"], [anchor]
        if isinstance(anchor, list) and all(isinstance(a, str) for a in anchor):
            return doc["signedReceipt"], list(anchor)
        raise InputError('wrapper "anchor" must be a <caip2>:<tx> string or an array of them')
    return doc, []


def _skip(detail: str) -> CheckResult:
    return CheckResult("skipped", detail)


def _anchor_keys(levels: dict[str, CheckResult]) -> list[str]:
    return [k for k in levels if k == "anchor" or k.startswith("anchor ")]


def verdict_of(levels: dict[str, CheckResult], rail: str | None) -> tuple[str, list[str]]:
    """SPEC §6: NOT VERIFIED when any check failed; VERIFIED when nothing is pending or
    unavailable, L1 and L2 passed, L2.5 passed or was skipped, the payment passed on its rail and
    receiptHash is committed on-chain (by the escrow rail itself, or a passing anchor);
    otherwise PARTIALLY VERIFIED with the missing pieces."""
    if any(c.status == "fail" for c in levels.values()):
        return NOT_VERIFIED, []
    missing: list[str] = []
    file = levels.get("file")
    if file is None or file.status != "pass":
        detail = file.detail if file else "no file given"
        missing.append(f"L1: {detail} — the output was not compared with outputSha256")
    sig = levels.get("signature")
    if sig is None or sig.status != "pass":
        missing.append("L2: the seller signature was not verified")
    binding = levels.get("binding")
    if binding is not None and binding.status == "pending":
        missing.append(
            "L2.5: nothing proves the seller controls the payee "
            "(pass --allow-unbound for legacy receipts)"
        )
    elif binding is not None and binding.status not in ("pass", "skipped"):
        missing.append(f"L2.5: {binding.status} — {binding.detail}")
    settlement = levels.get("settlement")
    if settlement is None or settlement.status != "pass":
        what = f"{settlement.status} — {settlement.detail}" if settlement else "not checked"
        missing.append(f"L3: the payment was not confirmed on its rail ({what})")
    anchors = [levels[k] for k in _anchor_keys(levels)]
    committed_by_rail = rail in COMMITTING_RAILS
    for key in _anchor_keys(levels):
        a = levels[key]
        if a.status in ("pending", "unavailable"):
            missing.append(f"L3 {key}: {a.status} — {a.detail}")
    if not committed_by_rail and not any(a.status == "pass" for a in anchors):
        missing.append(
            f"L3: receiptHash is not committed on-chain — {rail} does not commit it, so a mined "
            'anchor is required (--anchor <caip2>:<tx>, or the input wrapper\'s "anchor")'
        )
    return (PARTIALLY_VERIFIED if missing else VERIFIED), missing


def verify(
    signed: Any,
    file_bytes: bytes | None = None,
    *,
    anchor: str | list[str] | None = None,
    offline: bool = False,
    rpcs: dict[str, str] | None = None,
    allow_unbound: bool = False,
    now: float | None = None,
) -> Report:
    """Run every applicable level. ``anchor`` is one ``<caip2>:<tx>`` reference or a list.
    ``rpcs`` maps CAIP-2 ids to JSON-RPC endpoints (EVM, and XRPL for the online account-key
    check of level 2.5). ``allow_unbound`` accepts receipts without any account binding (legacy
    receipts); invalid bindings still fail."""
    rpcs = {**DEFAULT_RPCS, **DEFAULT_XRPL_RPCS, **(rpcs or {})}
    anchors = [anchor] if isinstance(anchor, str) else list(dict.fromkeys(anchor or []))
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

    # Level 2.5 — seller <-> payee: an account binding (SPEC §4.1; online for XRPL keys).
    if not sig.ok:
        levels["binding"] = _skip("receipt not authenticated")
    else:
        levels["binding"] = check_payee_binding(
            signed,
            offline=offline,
            allow_unbound=allow_unbound,
            xrpl_rpcs={k: v for k, v in rpcs.items() if k.startswith("xrpl:")},
            now=now,
        )

    # Level 3 — receipt <-> settlement (online): payment settled + receiptHash committed.
    rail = receipt["payment"]["rail"] if sig.ok else None

    def anchor_key(i: int) -> str:
        return "anchor" if i == 0 else f"anchor {i + 1}"

    if not sig.ok:
        levels["settlement"] = _skip("receipt not authenticated")
        levels["anchor"] = _skip("receipt not authenticated")
    elif offline:
        levels["settlement"] = _skip("offline")
        for i, _ in enumerate(anchors or [None]):
            levels[anchor_key(i)] = _skip("offline")
    else:
        pay = receipt["payment"]
        if pay["rail"] == "x402:exact" and pay["network"].startswith("eip155:"):
            levels["settlement"] = check_x402_exact(receipt, rpcs)
        elif pay["rail"].startswith("x402:") and pay["rail"] != "x402:exact":
            levels["settlement"] = CheckResult(
                "unavailable", f'only the x402 "exact" scheme is recognised, not {pay["rail"]}'
            )
        elif pay["rail"] == "x402:exact" and pay["network"].startswith("xrpl:"):
            levels["settlement"] = check_xrpl_x402_exact(receipt, rpcs)
        else:
            levels["settlement"] = CheckResult(
                "unavailable",
                f"rail {pay['rail']} on {pay['network']} is not supported by this verifier",
            )
        if not anchors:
            levels["anchor"] = _skip(
                "no anchor given; the escrow rail itself commits receiptHash"
                if pay["rail"] in COMMITTING_RAILS
                else "no anchor given; receiptHash commitment not checked"
            )
        for i, ref in enumerate(anchors):
            levels[anchor_key(i)] = (
                check_xrpl_anchor(ref, sig.receipt_hash, rpcs)
                if ref.startswith("xrpl:")
                else check_evm_anchor(ref, sig.receipt_hash, rpcs)
            )

    status, missing = verdict_of(levels, rail)
    return Report(status, sig.receipt_hash, sig.seller, levels, sig.errors, missing)
