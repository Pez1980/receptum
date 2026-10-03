"""Level 3 online checks on EVM chains over plain JSON-RPC (urllib, no web3)."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .receipt import is_caip2

__all__ = [
    "ANCHOR_PREFIX",
    "DEFAULT_RPCS",
    "CheckResult",
    "RpcError",
    "check_evm_anchor",
    "check_x402_exact",
]

DEFAULT_RPCS: dict[str, str] = {
    "eip155:84532": "https://sepolia.base.org",
    "eip155:5042002": "https://rpc.testnet.arc.io",
    "eip155:421614": "https://sepolia-rollup.arbitrum.io/rpc",
    # Mainnets (read-only verification; the RPC's chain id is still checked against the receipt).
    "eip155:8453": "https://mainnet.base.org",
    "eip155:5042": "https://rpc.mainnet.arc.io",
    "eip155:42161": "https://arb1.arbitrum.io/rpc",
}
ANCHOR_PREFIX = b"receptum/1"
# keccak256("Transfer(address,address,uint256)")
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
_TX_HASH = re.compile(r"^0x[0-9a-fA-F]{64}\Z")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}\Z")


class RpcError(RuntimeError):
    pass


@dataclass
class CheckResult:
    """status: "pass" (confirmed), "fail" (chain contradicts the receipt) or
    "unavailable" (could not be checked: unsupported, missing data or RPC error)."""

    status: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"status": self.status, "detail": self.detail}


class JsonRpc:
    def __init__(self, url: str, timeout: float = 20.0) -> None:
        self.url = url
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params: list[Any]) -> Any:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        req = urllib.request.Request(
            self.url,
            data=body.encode(),
            headers={"content-type": "application/json", "user-agent": "receptum-verify-py"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                reply = json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise RpcError(f"{method} via {self.url} failed: {exc}") from None
        if not isinstance(reply, dict):
            raise RpcError(f"{method}: malformed JSON-RPC reply")
        if reply.get("error"):
            raise RpcError(f"{method}: {reply['error']}")
        return reply.get("result")


def _chain_id(caip2: str) -> int | None:
    ns, _, ref = caip2.partition(":")
    if ns != "eip155" or not ref.isdigit():
        return None
    return int(ref)


def _rpc_for(caip2: str, rpcs: dict[str, str]) -> JsonRpc | None:
    url = rpcs.get(caip2)
    return JsonRpc(url) if url else None


def _check_chain(rpc: JsonRpc, chain_id: int) -> CheckResult | None:
    got = rpc.call("eth_chainId", [])
    if not isinstance(got, str) or int(got, 16) != chain_id:
        return CheckResult("unavailable", f"RPC {rpc.url} serves chain {got}, expected {chain_id}")
    return None


_WORD = re.compile(r"^0x[0-9a-fA-F]{64}\Z")


def _addr_topic(topic: Any) -> str | None:
    if not isinstance(topic, str) or not _WORD.match(topic):
        return None
    if topic[2:26].strip("0"):
        return None
    return "0x" + topic[26:].lower()


def _caip10_address(account: str, network: str) -> str | None:
    """Return the lower-cased address of an eip155 CAIP-10 account on ``network``."""
    chain, _, addr = account.rpartition(":")
    if chain != network or not _ADDRESS.match(addr):
        return None
    return addr.lower()


def check_x402_exact(receipt: dict, rpcs: dict[str, str] | None = None) -> CheckResult:
    """x402 `exact` on an EVM chain: the settlement transaction at payment.reference
    succeeded and emitted an ERC-20 Transfer of exactly payment.amount of token
    payment.asset from payment.payer (when stated) to payment.payee."""
    rpcs = DEFAULT_RPCS if rpcs is None else rpcs
    pay = receipt["payment"]
    network = pay["network"]
    chain_id = _chain_id(network)
    if chain_id is None:
        return CheckResult("unavailable", f"network {network} is not an EVM (eip155) chain")
    # Receipt-side MUSTs first (SPEC §7.3): these fail without asking the chain.
    asset = pay["asset"]
    if not _ADDRESS.match(asset):
        return CheckResult(
            "fail", "payment.asset must be the token contract address for x402:exact on eip155"
        )
    ref = pay["reference"]
    if not _TX_HASH.match(ref):
        return CheckResult("fail", "payment.reference is not an EVM transaction hash")
    payee = None
    if "payee" in pay:
        payee = _caip10_address(pay["payee"], network)
        if payee is None:
            return CheckResult("fail", f"payment.payee is not an EVM account on {network}")
    payer = None
    if "payer" in pay:
        payer = _caip10_address(pay["payer"], network)
        if payer is None:
            return CheckResult("fail", f"payment.payer is not an EVM account on {network}")
    rpc = _rpc_for(network, rpcs)
    if rpc is None:
        return CheckResult("unavailable", f"no RPC endpoint configured for {network}")
    if payee is None:
        return CheckResult(
            "unavailable", "payment.payee is absent; cannot check where the funds went"
        )
    amount = int(pay["amount"])

    try:
        bad_chain = _check_chain(rpc, chain_id)
        if bad_chain:
            return bad_chain
        tx_receipt = rpc.call("eth_getTransactionReceipt", [ref])
    except RpcError as exc:
        return CheckResult("unavailable", str(exc))
    if not isinstance(tx_receipt, dict) or not tx_receipt.get("blockNumber"):
        return CheckResult("fail", f"settlement transaction {ref} not found or not mined")
    if tx_receipt.get("status") != "0x1":
        return CheckResult("fail", f"settlement transaction {ref} reverted")
    for log in tx_receipt.get("logs") or []:
        if not isinstance(log, dict) or log.get("removed"):
            continue
        topics = log.get("topics") or []
        if (
            str(log.get("address", "")).lower() != asset.lower()
            or len(topics) != 3
            or str(topics[0]).lower() != TRANSFER_TOPIC
        ):
            continue
        frm, to = _addr_topic(topics[1]), _addr_topic(topics[2])
        data = log.get("data")
        # SPEC §7.3: data is exactly one 32-byte word (int() alone would accept short, long,
        # zero-prefixed or underscored hex and diverge from other verifiers).
        if frm is None or to is None or not isinstance(data, str) or not _WORD.match(data):
            continue
        value = int(data[2:], 16)
        if to == payee and value == amount and (payer is None or frm == payer):
            who = f"{frm} -> {to}"
            return CheckResult(
                "pass",
                f"tx {ref} succeeded; Transfer {amount} of {asset} {who} "
                f"(block {int(tx_receipt['blockNumber'], 16)})",
            )
    return CheckResult(
        "fail",
        f"tx {ref} has no Transfer of exactly {amount} of {asset} "
        f"{'from ' + payer + ' ' if payer else ''}to {payee}",
    )


def parse_anchor(anchor: str) -> tuple[str, str]:
    """Split ``caip2:txhash`` (e.g. eip155:5042002:0xabc…) into (caip2, txhash), SPEC §7.1."""
    if not isinstance(anchor, str):
        raise ValueError("anchor must be <caip2>:<transaction hash>")
    network, _, tx = anchor.rpartition(":")
    if not network or not tx or not is_caip2(network):
        raise ValueError("anchor must be <caip2>:<transaction hash>")
    return network, tx


# Transaction-hash formats of the anchor networks this verifier recognises but cannot query.
_OTHER_ANCHOR_TX = {
    "xrpl:1": re.compile(r"^[0-9A-Fa-f]{64}\Z"),
    "xrpl:0": re.compile(r"^[0-9A-Fa-f]{64}\Z"),
    "stellar:testnet": re.compile(r"^[0-9a-f]{64}\Z"),
    "stellar:pubnet": re.compile(r"^[0-9a-f]{64}\Z"),
}


def check_evm_anchor(
    anchor: str, receipt_hash_hex: str, rpcs: dict[str, str] | None = None
) -> CheckResult:
    """anchor:evm — a mined, successful, zero-value transaction whose calldata is
    exactly utf8("receptum/1") || receiptHash (32 raw bytes)."""
    rpcs = DEFAULT_RPCS if rpcs is None else rpcs
    try:
        network, tx_hash = parse_anchor(anchor)
    except ValueError as exc:
        return CheckResult("fail", str(exc))
    chain_id = _chain_id(network)
    if chain_id is None:
        fmt = _OTHER_ANCHOR_TX.get(network)
        if fmt is not None and not fmt.match(tx_hash):
            return CheckResult("fail", "anchor transaction hash is malformed")
        return CheckResult(
            "unavailable", f"anchor network {network} is not supported by this verifier"
        )
    if not _TX_HASH.match(tx_hash):
        return CheckResult("fail", "anchor transaction hash is malformed")
    rpc = _rpc_for(network, rpcs)
    if rpc is None:
        return CheckResult("unavailable", f"no RPC endpoint configured for {network}")
    expected = "0x" + (ANCHOR_PREFIX + bytes.fromhex(receipt_hash_hex)).hex()
    try:
        bad_chain = _check_chain(rpc, chain_id)
        if bad_chain:
            return bad_chain
        tx = rpc.call("eth_getTransactionByHash", [tx_hash])
        tx_receipt = rpc.call("eth_getTransactionReceipt", [tx_hash])
    except RpcError as exc:
        return CheckResult("unavailable", str(exc))
    if not isinstance(tx, dict) or not isinstance(tx_receipt, dict):
        return CheckResult("fail", f"anchor transaction {tx_hash} not found")
    if not tx_receipt.get("blockNumber"):
        return CheckResult("fail", f"anchor transaction {tx_hash} is not mined")
    if tx_receipt.get("status") != "0x1":
        return CheckResult("fail", f"anchor transaction {tx_hash} reverted")
    if str(tx.get("input", "")).lower() != expected:
        return CheckResult("fail", "anchor calldata is not utf8('receptum/1') || receiptHash")
    try:
        value = int(tx.get("value", "0x0"), 16)
    except ValueError:
        value = -1
    if value != 0:
        return CheckResult("fail", "anchor transaction is not zero-value")
    tx_chain = tx.get("chainId")
    if tx_chain is not None and int(tx_chain, 16) != chain_id:
        return CheckResult("fail", "anchor transaction chainId does not match the anchor network")
    return CheckResult(
        "pass",
        f"{network} tx {tx_hash} commits receiptHash "
        f"(block {int(tx_receipt['blockNumber'], 16)}, from {tx.get('from')})",
    )
