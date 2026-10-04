"""Solana (SPEC §4.1, §7.1, §7.3): account bindings, ``x402:exact`` settlements,
``escrow:receptum-solana`` escrows and ``anchor:solana`` memo anchors.

Written from the spec and the reference adapter's encodings (packages/adapter-solana), over plain
JSON-RPC (urllib). Every online check first requires the RPC's genesis hash to begin with the
CAIP-2 reference; otherwise, and on any RPC error, the result is ``unavailable``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import struct
import time
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .evm import CheckResult, JsonRpc, RpcError

__all__ = [
    "DEFAULT_SOLANA_RPCS",
    "RECEPTUM_SOLANA_PROGRAM_HASH",
    "RECEPTUM_SOLANA_PROGRAM_ID",
    "SOLANA_DEVNET",
    "SOLANA_ESCROW_RAIL",
    "SOLANA_MAINNET",
    "b58decode",
    "b58encode",
    "check_solana_anchor",
    "check_solana_escrow",
    "check_solana_x402_exact",
    "find_program_address",
    "is_on_curve",
    "verify_solana_proof",
]

SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
DEFAULT_SOLANA_RPCS = {
    SOLANA_DEVNET: "https://api.devnet.solana.com",
    SOLANA_MAINNET: "https://api.mainnet-beta.solana.com",
}
SOLANA_ESCROW_RAIL = "escrow:receptum-solana"
# The published receptum_escrow build (packages/adapter-solana/program/deployment.devnet.json).
RECEPTUM_SOLANA_PROGRAM_ID = "6VdZ7E96YbZig648NFQ9sHwKTHQtY7cntYU1mZmv77wv"
RECEPTUM_SOLANA_PROGRAM_HASH = "b3964928ffc08a5a6266957944d03deb62b206d9dfc356c126dedea229e5d93b"

BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111"
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
TOKEN_PROGRAMS = ("spl-token", "spl-token-2022")
ANCHOR_MEMO_PREFIX = "receptum/1:"
BINDING_PREFIX = b"Solana Signed Message:\n"
_ED25519_L = 2**252 + 27742317777372353535851770400913936493
_NETWORK = re.compile(r"^solana:[1-9A-HJ-NP-Za-km-z]{32}\Z")
_AMOUNT = re.compile(r"^(0|[1-9][0-9]*)\Z")

# --- base58 -----------------------------------------------------------------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + out


def b58decode(text: str) -> bytes:
    n = 0
    for c in text:
        i = _B58.find(c)
        if i < 0:
            raise ValueError("invalid base58 character")
        n = n * 58 + i
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(text) - len(text.lstrip("1"))
    return b"\0" * pad + body


def _is_b58(text: Any, length: int) -> bool:
    if not isinstance(text, str) or not 0 < len(text) <= 90:
        return False
    try:
        raw = b58decode(text)
    except ValueError:
        return False
    return len(raw) == length and b58encode(raw) == text


def is_address(text: Any) -> bool:
    return _is_b58(text, 32)


def is_signature(text: Any) -> bool:
    return _is_b58(text, 64)


# --- program-derived addresses ------------------------------------------------

_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def is_on_curve(point: bytes) -> bool:
    """curve25519-dalek decompression validity (y reduced mod p, sign bit ignored)."""
    y = int.from_bytes(point, "little") & ((1 << 255) - 1)
    y %= _P
    u = (y * y - 1) % _P
    v = (_D * y * y + 1) % _P
    v3 = v * v * v % _P
    x = u * v3 * pow(u * v3 * v3 * v % _P, (_P - 5) // 8, _P) % _P
    vx2 = v * x * x % _P
    return vx2 == u or vx2 == (-u) % _P


def create_program_address(seeds: list[bytes], program_id: str) -> str:
    h = hashlib.sha256(b"".join(seeds) + b58decode(program_id) + b"ProgramDerivedAddress").digest()
    if is_on_curve(h):
        raise ValueError("on curve")
    return b58encode(h)


def find_program_address(seeds: list[bytes], program_id: str) -> tuple[str, int]:
    for bump in range(255, -1, -1):
        try:
            return create_program_address([*seeds, bytes([bump])], program_id), bump
        except ValueError:
            continue
    raise ValueError("no viable program-derived address")


# --- account bindings (SPEC §4.1) -------------------------------------------


def verify_solana_proof(
    proof: dict, network: str, address: str, message: bytes, err: list[str]
) -> str | None:
    """``{type: "solana", signature}``: Ed25519 by the address's own key over
    SHA-256("Solana Signed Message:\\n" || m), signature 64 bytes in padded standard base64."""
    if set(proof) != {"type", "signature"}:
        err.append('accountProof members must be exactly ["signature", "type"] for solana')
        return None
    if not _NETWORK.match(network) or not is_address(address):
        err.append("statement.account is not a solana:<genesis>:<base58 address> account")
        return None
    sig_b64 = proof["signature"]
    try:
        if not isinstance(sig_b64, str):
            raise binascii.Error
        signature = base64.b64decode(sig_b64, validate=True)
        if base64.b64encode(signature).decode() != sig_b64:
            raise binascii.Error
    except binascii.Error:
        err.append("accountProof.signature must be canonical padded standard base64")
        return None
    if len(signature) != 64:
        err.append("accountProof: Solana signature must be 64 bytes")
        return None
    if int.from_bytes(signature[32:], "little") >= _ED25519_L:
        err.append("accountProof: non-canonical Ed25519 signature (S >= L)")
        return None
    digest = hashlib.sha256(BINDING_PREFIX + message).digest()
    try:
        Ed25519PublicKey.from_public_bytes(b58decode(address)).verify(signature, digest)
    except (InvalidSignature, ValueError):
        err.append("accountProof: Solana signature does not verify against the account")
        return None
    return f"Ed25519 signature by {address}"


# --- RPC ----------------------------------------------------------------------


class _RetryingRpc(JsonRpc):
    """Public Solana endpoints rate-limit (HTTP 429): retry a few times with backoff."""

    def call(self, method: str, params: list[Any]) -> Any:
        for attempt in range(5):
            try:
                return super().call(method, params)
            except RpcError as exc:
                if "429" not in str(exc) and "Too Many" not in str(exc) or attempt == 4:
                    raise
                time.sleep(0.5 * 2**attempt)
        raise AssertionError("unreachable")  # pragma: no cover


def _connect(network: str, rpcs: dict[str, str]) -> JsonRpc | CheckResult:
    url = rpcs.get(network)
    if not url:
        return CheckResult("unavailable", f"no Solana RPC endpoint configured for {network}")
    rpc = _RetryingRpc(url, timeout=30.0)
    try:
        genesis = rpc.call("getGenesisHash", [])
    except RpcError as exc:
        return CheckResult("unavailable", f"Solana RPC unavailable: {exc}")
    if not isinstance(genesis, str) or not genesis.startswith(network[len("solana:") :]):
        return CheckResult("unavailable", f"the RPC does not serve {network} (genesis hash mismatch)")
    return rpc


def _get_tx(rpc: JsonRpc, signature: str) -> tuple[dict, str] | None:
    for commitment in ("finalized", "confirmed"):
        tx = rpc.call(
            "getTransaction",
            [
                signature,
                {"encoding": "jsonParsed", "commitment": commitment, "maxSupportedTransactionVersion": 0},
            ],
        )
        if isinstance(tx, dict):
            return tx, commitment
    return None


def _get_account(rpc: JsonRpc, address: str) -> dict | None:
    r = rpc.call("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}])
    value = r.get("value") if isinstance(r, dict) else None
    if not isinstance(value, dict):
        return None
    return {
        "owner": value.get("owner"),
        "executable": value.get("executable") is True,
        "data": base64.b64decode(value["data"][0]),
    }


def _account(network: str, caip10: Any) -> str | None | bool:
    if caip10 is None:
        return None
    if not isinstance(caip10, str):
        return False
    chain, _, addr = caip10.rpartition(":")
    return addr if chain == network else False


def _first_signature(tx: dict) -> Any:
    sigs = (tx.get("transaction") or {}).get("signatures") or []
    return sigs[0] if sigs else None


# --- x402 exact (SPEC §7.3) -------------------------------------------------


def _owner_of(tx: dict, account: str) -> tuple[Any, Any]:
    keys = [k.get("pubkey") for k in tx["transaction"]["message"].get("accountKeys", [])]
    if account not in keys:
        return None, None
    i = keys.index(account)
    meta = tx.get("meta") or {}
    for lst in (meta.get("postTokenBalances") or [], meta.get("preTokenBalances") or []):
        for b in lst:
            if b.get("accountIndex") == i:
                return b.get("owner"), b.get("mint")
    return None, None


def _net_change(tx: dict, owner: str, mint: str) -> int:
    meta = tx.get("meta") or {}

    def total(lst: list) -> int:
        return sum(
            int(b["uiTokenAmount"]["amount"])
            for b in lst or []
            if b.get("owner") == owner and b.get("mint") == mint
        )

    return total(meta.get("postTokenBalances")) - total(meta.get("preTokenBalances"))


def find_token_transfer(tx: dict, mint: str, amount: str, payee: str, payer: str | None) -> str | None:
    """None when the transaction pays as required, else the reason it doesn't."""
    meta = tx.get("meta")
    if not isinstance(meta, dict):
        return "transaction has no status metadata"
    if meta.get("err") is not None:
        return "settlement transaction failed"
    instructions = list(tx["transaction"]["message"].get("instructions", []))
    for inner in meta.get("innerInstructions") or []:
        instructions.extend(inner.get("instructions", []))
    for ix in instructions:
        parsed = ix.get("parsed")
        if ix.get("program") not in TOKEN_PROGRAMS or not isinstance(parsed, dict):
            continue
        info = parsed.get("info")
        if parsed.get("type") != "transferChecked" or not isinstance(info, dict):
            continue
        token_amount = info.get("tokenAmount")
        got = token_amount.get("amount") if isinstance(token_amount, dict) else None
        if info.get("mint") != mint or got != amount:
            continue
        if not isinstance(info.get("destination"), str) or not isinstance(info.get("source"), str):
            continue
        if _owner_of(tx, info["destination"]) != (payee, mint):
            continue
        if payer is not None and _owner_of(tx, info["source"])[0] != payer:
            continue
        delta = _net_change(tx, payee, mint)
        if delta != int(amount):
            return f"the payee's {mint} balance changed by {delta}, not {amount}"
        return None
    sender = f"from {payer} " if payer else ""
    return f"no transferChecked of {amount} {mint} {sender}to {payee} in the settlement transaction"


def check_solana_x402_exact(receipt: dict, rpcs: dict[str, str]) -> CheckResult:
    pay = receipt["payment"]
    network, reference, amount, asset = pay["network"], pay["reference"], pay["amount"], pay["asset"]
    if not _NETWORK.match(network):
        return CheckResult("fail", f"{network} is not a Solana network")
    if not is_signature(reference):
        return CheckResult("fail", "payment.reference is not a Solana transaction signature (base58, 64 bytes)")
    if not is_address(asset):
        return CheckResult("fail", "payment.asset must be the SPL token mint address")
    if not isinstance(amount, str) or not _AMOUNT.match(amount):
        return CheckResult("fail", "payment.amount must be an integer (token base units)")
    payee = _account(network, pay.get("payee"))
    payer = _account(network, pay.get("payer"))
    if payee is False or (payee is not None and not is_address(payee)):
        return CheckResult("fail", f"payment.payee is not an account on {network}")
    if payer is False or (payer is not None and not is_address(payer)):
        return CheckResult("fail", f"payment.payer is not an account on {network}")
    if not payee:
        return CheckResult("unavailable", "receipt does not name a payee, so the recipient can't be confirmed")
    rpc = _connect(network, rpcs)
    if isinstance(rpc, CheckResult):
        return rpc
    try:
        found = _get_tx(rpc, reference)
    except RpcError as exc:
        return CheckResult("unavailable", f"transaction lookup unavailable: {exc}")
    if found is None:
        return CheckResult("unavailable", f"transaction {reference} not found (not confirmed yet, or no history)")
    tx, commitment = found
    if _first_signature(tx) != reference:
        return CheckResult("fail", "the RPC returned a different transaction")
    try:
        reason = find_token_transfer(tx, asset, amount, payee, payer or None)
    except (KeyError, TypeError, ValueError) as exc:
        return CheckResult("unavailable", f"malformed transaction reply: {exc}")
    if reason:
        return CheckResult("fail", reason)
    return CheckResult(
        "pass", f"{amount} base units of {asset} paid to {payee} in slot {tx.get('slot')} ({commitment})"
    )


# --- anchors (SPEC §7.1) ----------------------------------------------------


def check_solana_anchor(network: str, tx_sig: str, receipt_hash: str, rpcs: dict[str, str]) -> CheckResult:
    if not _NETWORK.match(network):
        return CheckResult("fail", f"{network} is not a Solana network")
    if not is_signature(tx_sig):
        return CheckResult("fail", "anchor transaction signature is malformed")
    rpc = _connect(network, rpcs)
    if isinstance(rpc, CheckResult):
        return rpc
    try:
        found = _get_tx(rpc, tx_sig)
    except RpcError as exc:
        return CheckResult("unavailable", f"anchor lookup unavailable: {exc}")
    if found is None:
        return CheckResult("fail", "anchor transaction not found or not confirmed")
    tx, commitment = found
    if _first_signature(tx) != tx_sig:
        return CheckResult("fail", "the RPC returned a different transaction")
    meta = tx.get("meta")
    if not isinstance(meta, dict) or meta.get("err") is not None:
        return CheckResult("fail", "anchor transaction did not succeed")
    memos = [
        ix.get("parsed")
        for ix in tx["transaction"]["message"].get("instructions", [])
        if ix.get("programId") == MEMO_PROGRAM and isinstance(ix.get("parsed"), str)
    ]
    if ANCHOR_MEMO_PREFIX + receipt_hash in memos:
        return CheckResult("pass", f"memo anchored in slot {tx.get('slot')} ({commitment})")
    return CheckResult("fail", "no receptum/1 memo for this receiptHash in that transaction")


# --- escrow (SPEC §7.3) -------------------------------------------------------

_ESCROW_ID = re.compile(
    r"^(solana:[1-9A-HJ-NP-Za-km-z]{32}):([1-9A-HJ-NP-Za-km-z]{32,44}):([1-9A-HJ-NP-Za-km-z]{32,44})\Z"
)
_STATUSES = {1: "open", 2: "delivered", 3: "released", 4: "refunded"}


def decode_escrow(data: bytes) -> dict:
    if len(data) != 272 or data[:8] != b"rcptesc1":
        raise ValueError("not a receptum_escrow account")
    if data[8] != 1:
        raise ValueError(f"unsupported receptum_escrow account version {data[8]}")
    if data[9] not in _STATUSES:
        raise ValueError(f"invalid escrow status {data[9]}")

    def key(o: int) -> str:
        return b58encode(data[o : o + 32])

    def opt(o: int) -> str | None:
        return None if data[o : o + 32] == b"\0" * 32 else key(o)

    rh = data[240:272]
    return {
        "status": _STATUSES[data[9]],
        "bump": data[10],
        "buyer": key(12),
        "seller": key(44),
        "evaluator": opt(76),
        "mint": key(108),
        "vault": key(140),
        "settled_by": opt(172),
        "id": struct.unpack_from("<Q", data, 204)[0],
        "amount": struct.unpack_from("<Q", data, 212)[0],
        "deliver_by": struct.unpack_from("<q", data, 220)[0],
        "review_window": struct.unpack_from("<I", data, 228)[0],
        "delivered_at": struct.unpack_from("<q", data, 232)[0],
        "receipt_hash": None if rh == b"\0" * 32 else rh.hex(),
    }


def program_data_hash(data: bytes) -> tuple[str, str | None]:
    """SHA-256 of the ELF in a ProgramData account (after the 45-byte header, trailing zero
    bytes removed) and the upgrade authority (None when immutable)."""
    if len(data) < 45 or struct.unpack_from("<I", data, 0)[0] != 3 or data[12] not in (0, 1):
        raise ValueError("not an upgradeable-loader ProgramData account")
    authority = b58encode(data[13:45]) if data[12] == 1 else None
    return hashlib.sha256(data[45:].rstrip(b"\0")).hexdigest(), authority


def check_solana_escrow(
    signed: dict,
    payer: str | None,
    payee: str | None,
    *,
    trusted: list[str] | tuple[str, ...],
    rpcs: dict[str, str],
) -> CheckResult:
    receipt = signed["receipt"]
    pay = receipt["payment"]
    network, reference = pay["network"], pay["reference"]
    m = _ESCROW_ID.match(reference) if isinstance(reference, str) else None
    if not m or not is_address(m.group(2)) or not is_address(m.group(3)):
        return CheckResult("fail", f"invalid Solana escrowId: {reference}")
    ref_network, program_id, escrow = m.groups()
    if ref_network != network:
        return CheckResult("fail", f"escrow reference is on {ref_network}, receipt says {network}")
    rpc = _connect(network, rpcs)
    if isinstance(rpc, CheckResult):
        return rpc
    try:
        program = _get_account(rpc, program_id)
        if not program or not program["executable"] or program["owner"] != BPF_LOADER_UPGRADEABLE:
            return CheckResult("fail", "referenced program is not a deployed upgradeable-loader program")
        pd = program["data"]
        if len(pd) != 36 or struct.unpack_from("<I", pd, 0)[0] != 2:
            return CheckResult("fail", "referenced program is not a deployed upgradeable-loader program")
        program_data = _get_account(rpc, b58encode(pd[4:36]))
        if not program_data:
            return CheckResult("fail", "program has no ProgramData account")
        digest, authority = program_data_hash(program_data["data"])
        if digest != RECEPTUM_SOLANA_PROGRAM_HASH:
            return CheckResult("fail", "referenced program does not run the published receptum_escrow build")
        acc = _get_account(rpc, escrow)
        if not acc or acc["owner"] != program_id:
            return CheckResult("fail", f"escrow {escrow} not found")
        try:
            e = decode_escrow(acc["data"])
        except ValueError as exc:
            return CheckResult("fail", str(exc))
        seeds = [b"escrow", b58decode(e["buyer"]), struct.pack("<Q", e["id"])]
        if find_program_address(seeds, program_id)[0] != escrow:
            return CheckResult("fail", "escrow account is not at its program-derived address")
    except RpcError as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")
    except (KeyError, TypeError, ValueError, binascii.Error) as exc:
        return CheckResult("unavailable", f"malformed RPC reply: {exc}")

    acc_terms = receipt["acceptance"]
    evaluator = _account(network, acc_terms.get("evaluator"))
    problems = [
        p
        for p in (
            e["receipt_hash"] != signed["receiptHash"] and "committed receiptHash differs",
            str(e["amount"]) != pay["amount"] and "amount differs",
            e["mint"] != pay["asset"] and "mint differs from payment.asset",
            payer and e["buyer"] != payer and "buyer differs from payment.payer",
            payee and e["seller"] != payee and "seller differs from payment.payee",
            e["review_window"] != acc_terms["reviewWindowSeconds"]
            and "review window differs from acceptance.reviewWindowSeconds",
            acc_terms["mode"] == "evaluator"
            and (not e["evaluator"] or e["evaluator"] != evaluator)
            and "evaluator differs from acceptance.evaluator",
            acc_terms["mode"] != "evaluator"
            and e["evaluator"]
            and "escrow has an evaluator the receipt doesn't declare",
        )
        if p
    ]
    if problems:
        return CheckResult("fail", f"escrow {e['status']}: {'; '.join(problems)}")
    if e["status"] not in ("released", "delivered"):
        return CheckResult("fail", f"escrow is {e['status']}, not released")
    if authority:
        return CheckResult(
            "pending", f"program is upgradeable (authority {authority}), so its accounts can't be trusted"
        )
    if program_id not in trusted:
        return CheckResult(
            "pending",
            "untrusted deployment: receptum_escrow build, but this deployment isn't in the trusted registry",
        )
    if not payee:
        return CheckResult("unavailable", "receipt does not name a payee, so the recipient can't be confirmed")
    if e["status"] == "delivered":
        return CheckResult(
            "pending", "delivery committed; funds still held awaiting acceptance or the review window"
        )
    by = f"accepted by {e['settled_by']}" if e["settled_by"] else "released after the review window"
    return CheckResult(
        "pass", f"Solana escrow released to the payee ({by}); committed receiptHash and terms match"
    )
