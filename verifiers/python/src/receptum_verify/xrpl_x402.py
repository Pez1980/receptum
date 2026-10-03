"""Level 3 on XRPL over plain rippled JSON-RPC (urllib): ``x402:exact`` settlements and
``anchor:xrpl`` memos. Rule text: SPEC §7.3 ("x402:exact on xrpl:*") and §7.1.

A settlement passes only from a validated ledger: tesSUCCESS, TransactionType Payment,
Account = payer, Destination = payee, and ``meta.delivered_amount`` (never ``Amount`` —
partial payments can deliver less) equal to ``payment.amount``: XRP drops, or for an issued
token (``payment.asset`` = ``<currency>.<issuer>``, the currency as on the ledger) the delivered
value as an integer number of 10^-15 units, converted exactly (``xrpl_assets``). Currencies
compare by 160-bit protocol identity (3-character codes are case-sensitive) and issuers exactly.
Lookups that can't be completed are ``unavailable``, never ``pass``.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable

from .evm import CheckResult
from .xrpl_assets import (
    XrplAmountRangeError,
    XrplValueError,
    amount_id,
    asset_id,
    currency_id,
    value_to_units,
)

__all__ = [
    "DEFAULT_XRPL_JSON_RPCS",
    "RECEIPT_MEMO_TYPE",
    "XrplRpcError",
    "check_xrpl_anchor",
    "check_xrpl_x402_exact",
    "xrpl_json_rpc",
]

DEFAULT_XRPL_JSON_RPCS: dict[str, str] = {
    "xrpl:1": "https://s.altnet.rippletest.net:51234",
    "xrpl:0": "https://xrplcluster.com",  # mainnet (read-only; NetworkID is still checked)
}
# SPEC §7: MemoType = hex("receptum/1"), MemoData = the 32 receiptHash bytes.
RECEIPT_MEMO_TYPE = b"receptum/1".hex().upper()

_HASH = re.compile(r"^[0-9A-Fa-f]{64}$")
_NETWORK = re.compile(r"^xrpl:(0|[1-9][0-9]{0,9})$")
_UNITS = re.compile(r"^(0|[1-9][0-9]*)\Z")

Rpc = Callable[[str, dict], Any]


class XrplRpcError(RuntimeError):
    pass


def xrpl_json_rpc(url: str, timeout: float = 20.0) -> Rpc:
    """rippled JSON-RPC: returns the reply's ``result``; transport errors raise XrplRpcError."""

    def call(method: str, params: dict) -> Any:
        body = json.dumps({"method": method, "params": [params]}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={"content-type": "application/json", "user-agent": "receptum-verify-py"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                reply = json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise XrplRpcError(f"{method} via {url} failed: {exc}") from None
        if not isinstance(reply, dict):
            raise XrplRpcError(f"{method}: malformed reply")
        return reply.get("result")

    return call


def _account(network: str, caip10: Any) -> str | None | bool:
    """Bare address on ``network``; None when absent; False when on another network."""
    if caip10 is None:
        return None
    if not isinstance(caip10, str):
        return False
    chain, _, addr = caip10.rpartition(":")
    return addr if chain == network and addr else False


def _rpc(network: str, rpcs: dict[str, str] | None, rpc: Rpc | None) -> Rpc | None:
    if rpc is not None:
        return rpc
    url = {**DEFAULT_XRPL_JSON_RPCS, **(rpcs or {})}.get(network)
    return xrpl_json_rpc(url) if url else None


def _lookup(rpc: Rpc, network_id: int, tx_hash: str) -> tuple[dict | None, CheckResult | None]:
    """Fetch a validated tx; returns (result, None) or (None, unavailable-result)."""
    try:
        info = rpc("server_info", {})
        result = rpc("tx", {"transaction": tx_hash, "binary": False, "api_version": 2})
    except XrplRpcError as exc:
        return None, CheckResult("unavailable", f"XRPL lookup unavailable: {exc}")
    served = info.get("info", {}).get("network_id") if isinstance(info, dict) else None
    if served is not None and served != network_id:
        return None, CheckResult(
            "unavailable", f"the XRPL server serves NetworkID {served}, not {network_id}"
        )
    if not isinstance(result, dict):
        return None, CheckResult("unavailable", "malformed tx reply")
    if result.get("error") == "txnNotFound":
        return None, CheckResult(
            "unavailable", f"transaction {tx_hash} not found on this server (it may lack history)"
        )
    if result.get("error"):
        return None, CheckResult("unavailable", f"tx lookup failed: {result['error']}")
    if result.get("validated") is not True:
        return None, CheckResult("unavailable", "transaction is not in a validated ledger yet")
    tx = result.get("tx_json") if isinstance(result.get("tx_json"), dict) else result
    got = result.get("hash", tx.get("hash"))
    if not isinstance(got, str) or got.upper() != tx_hash.upper():
        return None, CheckResult("fail", "server returned a different transaction")
    return result, None


def check_xrpl_x402_exact(
    receipt: dict, rpcs: dict[str, str] | None = None, *, rpc: Rpc | None = None
) -> CheckResult:
    """x402:exact on xrpl:<NetworkID> — see the module docstring."""
    pay = receipt.get("payment", {})
    network = pay.get("network", "")
    ref = pay.get("reference", "")
    amount = pay.get("amount", "")
    asset = pay.get("asset", "")
    m = _NETWORK.match(network) if isinstance(network, str) else None
    if not m:
        return CheckResult("fail", f"{network} is not an XRPL network (xrpl:<NetworkID>)")
    network_id = int(m.group(1))
    if not isinstance(ref, str) or not _HASH.match(ref):
        return CheckResult("fail", "payment.reference is not an XRPL transaction hash")
    payer = _account(network, pay.get("payer"))
    payee = _account(network, pay.get("payee"))
    if payer is False:
        return CheckResult("fail", f"payment.payer is not an account on {network}")
    if payee is False:
        return CheckResult("fail", f"payment.payee is not an account on {network}")
    if payee is None:
        return CheckResult("unavailable", "receipt does not name a payee")
    if payer is None:
        return CheckResult("unavailable", "receipt does not name a payer")
    if not isinstance(amount, str) or not isinstance(asset, str):
        return CheckResult("fail", "payment.amount and payment.asset must be strings")
    want = asset_id(asset)
    if want is None:
        return CheckResult(
            "fail",
            f'payment.asset must be "XRP" or "<currency>.<issuer>" with a valid XRPL currency '
            f'code (as on the ledger: 3 characters or 40 hex) and issuer address, got "{asset}"',
        )
    xrp = want[0] == "XRP"
    if not _UNITS.match(amount):
        return CheckResult(
            "fail",
            "payment.amount must be an integer (XRP drops)"
            if xrp
            else "payment.amount must be an integer (10^-15 token units)",
        )

    client = _rpc(network, rpcs, rpc)
    if client is None:
        return CheckResult("unavailable", f"no XRPL JSON-RPC endpoint configured for {network}")
    result, problem = _lookup(client, network_id, ref)
    if problem:
        return problem
    assert result is not None
    tx = result.get("tx_json") if isinstance(result.get("tx_json"), dict) else result
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    if meta.get("TransactionResult") != "tesSUCCESS":
        return CheckResult(
            "fail",
            f"transaction result is {meta.get('TransactionResult', 'missing')}, not tesSUCCESS",
        )
    if tx.get("TransactionType") != "Payment":
        return CheckResult("fail", f"transaction is a {tx.get('TransactionType')}, not a Payment")
    tx_net = tx.get("NetworkID")
    if tx_net is not None and int(tx_net) != network_id:
        return CheckResult("fail", f"transaction NetworkID {tx_net} does not match {network}")
    if network_id > 1024 and tx_net is None:
        return CheckResult("fail", f"transaction carries no NetworkID, required on {network}")
    if tx.get("Account") != payer:
        return CheckResult("fail", f"sender {tx.get('Account')} is not payment.payer")
    if tx.get("Destination") != payee:
        return CheckResult("fail", f"destination {tx.get('Destination')} is not payment.payee")

    delivered = meta.get("delivered_amount", meta.get("DeliveredAmount"))
    if delivered is None or delivered == "unavailable":
        return CheckResult("unavailable", "the server does not report delivered_amount")
    ledger = result.get("ledger_index")
    where = f" in ledger {ledger}" if isinstance(ledger, int) else ""
    if xrp:
        if not isinstance(delivered, str):
            return CheckResult("fail", "delivered an issued currency, not XRP")
        if delivered != amount:
            return CheckResult("fail", f"delivered {delivered} drops, receipt says {amount}")
        return CheckResult("pass", f"tx {ref}: {amount} drops delivered to {payee}{where} (validated)")
    if not isinstance(delivered, dict) or not isinstance(delivered.get("currency"), str):
        return CheckResult("fail", "delivered XRP, not an issued currency")
    if currency_id(delivered["currency"]) != want[0]:
        return CheckResult(
            "fail",
            f"delivered currency {delivered['currency']}, not the currency of {asset} "
            "(compared by protocol bytes; 3-character codes are case-sensitive)",
        )
    got = amount_id(delivered)
    if got is None or got[1] != want[1]:
        return CheckResult("fail", f"delivered issuer {delivered.get('issuer')}, not {want[1]}")
    value = delivered.get("value")
    if not isinstance(value, str):
        return CheckResult("fail", "delivered_amount has no issued value")
    try:
        units = value_to_units(value)
    except (XrplValueError, XrplAmountRangeError) as exc:
        return CheckResult(
            "fail", f"delivered value {value!r} has no exact 10^-15 integer form ({exc})"
        )
    if units != amount:
        return CheckResult(
            "fail", f"delivered {value} ({units} x 10^-15) of {asset}, receipt says {amount}"
        )
    return CheckResult(
        "pass",
        f"tx {ref}: {value} {asset} ({amount} x 10^-15) delivered to {payee}{where} (validated)",
    )


def check_xrpl_anchor(
    anchor: str,
    receipt_hash_hex: str | None,
    rpcs: dict[str, str] | None = None,
    *,
    rpc: Rpc | None = None,
) -> CheckResult:
    """anchor:xrpl — a validated tesSUCCESS transaction whose first ``receptum/1`` memo
    carries exactly the receiptHash (SPEC §7)."""
    network, _, tx_hash = anchor.rpartition(":")
    m = _NETWORK.match(network)
    if not m:
        return CheckResult("fail", "anchor must be xrpl:<NetworkID>:<transaction hash>")
    if not _HASH.match(tx_hash):
        return CheckResult("fail", "anchor transaction hash is malformed")
    if not receipt_hash_hex:
        return CheckResult("fail", "no receiptHash to compare")
    client = _rpc(network, rpcs, rpc)
    if client is None:
        return CheckResult("unavailable", f"no XRPL JSON-RPC endpoint configured for {network}")
    result, problem = _lookup(client, int(m.group(1)), tx_hash)
    if problem:
        return problem
    assert result is not None
    tx = result.get("tx_json") if isinstance(result.get("tx_json"), dict) else result
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    if meta.get("TransactionResult") != "tesSUCCESS":
        return CheckResult("fail", f"anchor transaction {tx_hash} did not succeed")
    for entry in tx.get("Memos") or []:
        memo = entry.get("Memo") if isinstance(entry, dict) else None
        if not isinstance(memo, dict) or str(memo.get("MemoType", "")).upper() != RECEIPT_MEMO_TYPE:
            continue
        data = str(memo.get("MemoData", "")).lower()
        if data == receipt_hash_hex.lower():
            when = result.get("close_time_iso")
            return CheckResult(
                "pass",
                f"{network} tx {tx_hash} commits receiptHash in a receptum/1 memo"
                + (f" ({when})" if when else ""),
            )
        if _HASH.match(data):
            break  # the first well-formed receipt memo names another receipt
    return CheckResult("fail", "anchor transaction carries no receptum/1 memo for this receipt")
