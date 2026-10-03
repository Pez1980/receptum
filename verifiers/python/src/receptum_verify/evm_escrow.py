"""Level 3 for ``escrow:receptum-evm`` (SPEC §7.3, "Escrow rails") over plain JSON-RPC.

The contract at the escrow reference MUST run exactly the published ReceptumEscrow runtime code
(keccak-256 of ``eth_getCode``), its ``escrows(id)`` record (read with a hand-encoded
``eth_call``) MUST match the receipt's terms and committed ``receiptHash``, and the escrow MUST be
released to ``payment.payee``. A genuine contract at a deployment outside the trusted registry is
``pending``: matching runtime code alone doesn't prove the contract wasn't deployed with forged
storage.
"""

from __future__ import annotations

import re
from typing import Any

from .evm import DEFAULT_RPCS, CheckResult, JsonRpc, RpcError, _chain_id
from .hashes import keccak256
from .networks import TRUSTED_ESCROWS, is_trusted_deployment, untrusted_deployment

__all__ = [
    "ESCROWS_SELECTOR",
    "RECEPTUM_ESCROW_CODE_HASH",
    "TRUSTED_EVM_ESCROWS",
    "check_evm_escrow",
    "parse_evm_escrow_id",
]

# keccak256 of ReceptumEscrow's deployed (runtime) bytecode, receptumEscrowDeployedBytecode in
# packages/adapter-evm/src/artifact.ts (tests/test_evm_escrow.py pins it to that artifact).
RECEPTUM_ESCROW_CODE_HASH = "58c8beee19bb48209d7398ba2ecad2b6ec48a77e4929ac82286ac29b1af24861"
# Deprecated alias: the registry lives in networks.TRUSTED_ESCROWS (one registry for every rail).
TRUSTED_EVM_ESCROWS = TRUSTED_ESCROWS
# bytes4(keccak256("escrows(uint256)"))
ESCROWS_SELECTOR = keccak256(b"escrows(uint256)")[:4].hex()
_STATUS = ["none", "open", "delivered", "released", "refunded"]

_ESCROW_ID = re.compile(r"^(eip155:[0-9]+):(0x[0-9a-fA-F]{40}):([0-9]+)\Z")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}\Z")
_HEX = re.compile(r"^0x(?:[0-9a-fA-F]{2})*\Z")


def parse_evm_escrow_id(reference: Any) -> tuple[str, str, int]:
    """``<caip2>:<contract>:<id>`` → (network, contract, id); ValueError when malformed."""
    m = _ESCROW_ID.match(reference) if isinstance(reference, str) else None
    if not m:
        raise ValueError(f"invalid EVM escrowId: {reference}")
    return m.group(1), m.group(2), int(m.group(3))


def _same_addr(a: Any, b: Any) -> bool:
    return (
        isinstance(a, str)
        and isinstance(b, str)
        and bool(_ADDRESS.match(a))
        and bool(_ADDRESS.match(b))
        and a.lower() == b.lower()
    )


def _decode_escrow(data: Any) -> dict:
    """ABI-decodes the ``escrows(uint256)`` return tuple (10 static words)."""
    if not isinstance(data, str) or not _HEX.match(data) or len(data) < 2 + 64 * 10:
        raise RpcError("escrows(): malformed return data")
    words = [int(data[2 + 64 * i : 2 + 64 * (i + 1)], 16) for i in range(10)]
    addr = lambda w: "0x" + (w & ((1 << 160) - 1)).to_bytes(20, "big").hex()  # noqa: E731
    return {
        "buyer": addr(words[0]),
        "seller": addr(words[1]),
        "evaluator": addr(words[2]),
        "token": addr(words[3]),
        "amount": words[4],
        "deliverBy": words[5],
        "reviewWindow": words[6],
        "deliveredAt": words[7],
        "status": words[8],
        "receiptHash": words[9].to_bytes(32, "big").hex(),
    }


def check_evm_escrow(
    signed: dict,
    payer: str | None,
    payee: str | None,
    *,
    trusted: list[str] | tuple[str, ...] = (),
    rpcs: dict[str, str] | None = None,
    rpc: JsonRpc | None = None,
) -> CheckResult:
    """SPEC §7.3 escrow rail on ReceptumEscrow. ``payer``/``payee`` are the bare accounts already
    checked to be on ``payment.network`` (None when absent)."""
    receipt = signed["receipt"]
    pay = receipt["payment"]
    network = pay["network"]
    rpcs = DEFAULT_RPCS if rpcs is None else rpcs
    chain_id = _chain_id(network)
    if rpc is None:
        url = rpcs.get(network)
        if chain_id is None or not url:
            return CheckResult("unavailable", f"unsupported network {network}")
        rpc = JsonRpc(url)
    elif chain_id is None:
        return CheckResult("unavailable", f"unsupported network {network}")
    try:
        ref_network, contract, escrow_id = parse_evm_escrow_id(pay["reference"])
    except ValueError as exc:
        return CheckResult("fail", str(exc))
    if ref_network != network:
        return CheckResult("fail", f"escrow reference is on {ref_network}, receipt says {network}")
    if escrow_id >= 2**256:
        return CheckResult("unavailable", "could not be checked: escrow id exceeds uint256")
    try:
        got = rpc.call("eth_chainId", [])
        if not isinstance(got, str) or int(got, 16) != chain_id:
            return CheckResult(
                "unavailable", f"could not be checked: RPC serves chain {got}, expected {chain_id}"
            )
        code = rpc.call("eth_getCode", [contract, "latest"])
        if not isinstance(code, str) or not _HEX.match(code):
            raise RpcError("eth_getCode: malformed reply")
        if code == "0x" or keccak256(bytes.fromhex(code[2:])).hex() != RECEPTUM_ESCROW_CODE_HASH:
            return CheckResult("fail", "referenced contract is not ReceptumEscrow")
        data = rpc.call(
            "eth_call",
            [{"to": contract, "data": "0x" + ESCROWS_SELECTOR + f"{escrow_id:064x}"}, "latest"],
        )
        e = _decode_escrow(data)
    except (RpcError, ValueError) as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")

    status = _STATUS[e["status"]] if e["status"] < len(_STATUS) else "unknown"
    acc = receipt["acceptance"]
    no_evaluator = e["evaluator"] == "0x" + "0" * 40
    want_evaluator = None
    if acc.get("evaluator") is not None:
        chain, _, addr = acc["evaluator"].rpartition(":")
        want_evaluator = addr if chain == network else None
    problems = [
        p
        for p in (
            e["receiptHash"] != signed["receiptHash"] and "committed receiptHash differs",
            str(e["amount"]) != pay["amount"] and "amount differs",
            not _same_addr(e["token"], pay["asset"]) and "token differs from payment.asset",
            payer and not _same_addr(e["buyer"], payer) and "buyer differs from payment.payer",
            payee and not _same_addr(e["seller"], payee) and "seller differs from payment.payee",
            e["reviewWindow"] != acc["reviewWindowSeconds"]
            and "review window differs from acceptance.reviewWindowSeconds",
            acc["mode"] == "evaluator"
            and (no_evaluator or not _same_addr(e["evaluator"], want_evaluator))
            and "evaluator differs from acceptance.evaluator",
            acc["mode"] != "evaluator"
            and not no_evaluator
            and "escrow has an evaluator the receipt doesn't declare",
        )
        if p
    ]
    if problems:
        return CheckResult("fail", f"escrow {status}: {'; '.join(problems)}")
    if status not in ("released", "delivered"):
        return CheckResult("fail", f"escrow is {status}, not released")
    if not is_trusted_deployment(network, contract, tuple(trusted)):
        return CheckResult("pending", untrusted_deployment(network, "ReceptumEscrow code"))
    if not payee:
        return CheckResult(
            "unavailable", "receipt does not name a payee, so the recipient can't be confirmed"
        )
    if status == "delivered":
        return CheckResult(
            "pending", "delivery committed; funds still held awaiting acceptance or the review window"
        )
    return CheckResult(
        "pass",
        f"escrow {escrow_id} on {contract} released to the payee; committed receiptHash and "
        "terms match",
    )
