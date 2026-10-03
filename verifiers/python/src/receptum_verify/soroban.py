"""Level 3 for ``escrow:receptum-soroban`` (SPEC §7.3, "Escrow rails") over Soroban RPC
``getLedgerEntries`` (JSON-RPC via urllib), with the minimal XDR needed decoded by hand.

The contract at the escrow reference MUST run the published ReceptumEscrow wasm (its instance's
executable wasm hash), the escrow's persistent ``DataKey::Escrow(id)`` entry MUST have exactly the
contract's ``Escrow`` shape, and its terms, status and committed ``receipt_hash`` MUST match the
receipt. A genuine contract at a deployment outside the trusted registry is ``pending``.
"""

from __future__ import annotations

import base64
import re
import struct
from dataclasses import dataclass
from typing import Any, Callable

from .evm import CheckResult, JsonRpc, RpcError
from .stellar import (
    STELLAR_TESTNET,
    STELLAR_TESTNET_PASSPHRASE,
    VERSION_ACCOUNT,
    VERSION_CONTRACT,
    decode_strkey,
    encode_strkey,
    is_valid_account,
    is_valid_contract,
    token_contract_id,
)

__all__ = [
    "DEFAULT_SOROBAN_RPCS",
    "RECEPTUM_SOROBAN_WASM_HASH",
    "SOROBAN_ESCROW_RAIL",
    "TRUSTED_SOROBAN_ESCROWS",
    "SorobanEscrow",
    "XdrError",
    "check_soroban_escrow",
    "decode_escrow_record",
    "parse_soroban_escrow_id",
]

SOROBAN_ESCROW_RAIL = "escrow:receptum-soroban"
DEFAULT_SOROBAN_RPCS: dict[str, str] = {STELLAR_TESTNET: "https://soroban-testnet.stellar.org"}
# SHA-256 of the published receptum_escrow.wasm (packages/adapter-stellar/contracts/receptum-escrow;
# tests pin it to the wasm file and to the TypeScript constant).
RECEPTUM_SOROBAN_WASM_HASH = "0dc6b174951cad16630ab1d6600e54d4b6378d9d076fd0d0c5936e2bcaa3deaf"
# Published deployments (contracts/receptum-escrow/deployment.testnet.json).
TRUSTED_SOROBAN_ESCROWS: dict[str, tuple[str, ...]] = {
    STELLAR_TESTNET: ("CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG",),
}


class XdrError(ValueError):
    pass


class Contradiction(Exception):
    """The chain contradicts the receipt (``fail``)."""


# --- XDR (RFC 4506) subset ---------------------------------------------------------------------

# SCVal discriminants.
SCV_BOOL, SCV_VOID, SCV_ERROR, SCV_U32, SCV_I32, SCV_U64, SCV_I64 = 0, 1, 2, 3, 4, 5, 6
SCV_TIMEPOINT, SCV_DURATION, SCV_U128, SCV_I128, SCV_U256, SCV_I256 = 7, 8, 9, 10, 11, 12
SCV_BYTES, SCV_STRING, SCV_SYMBOL, SCV_VEC, SCV_MAP, SCV_ADDRESS = 13, 14, 15, 16, 17, 18
SCV_CONTRACT_INSTANCE, SCV_LEDGER_KEY_CONTRACT_INSTANCE, SCV_LEDGER_KEY_NONCE = 19, 20, 21

# Integer ScVal types that the JS SDK's scValToNative turns into a BigInt / a Number.
_BIGINT_TYPES = {SCV_U64, SCV_I64, SCV_TIMEPOINT, SCV_DURATION, SCV_U128, SCV_I128, SCV_U256, SCV_I256}
_NUMBER_TYPES = {SCV_U32, SCV_I32}


@dataclass(frozen=True)
class ScVal:
    type: int
    value: Any


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.data):
            raise XdrError("truncated XDR")
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def u32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def i32(self) -> int:
        return struct.unpack(">i", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack(">Q", self.take(8))[0]

    def i64(self) -> int:
        return struct.unpack(">q", self.take(8))[0]

    def boolean(self) -> bool:
        v = self.u32()
        if v > 1:
            raise XdrError("bad XDR bool")
        return bool(v)

    def opaque(self, max_len: int | None = None) -> bytes:
        n = self.u32()
        if max_len is not None and n > max_len:
            raise XdrError("XDR opaque too long")
        out = self.take(n)
        if any(self.take(-n % 4)):
            raise XdrError("non-zero XDR padding")
        return out

    def done(self) -> None:
        if self.pos != len(self.data):
            raise XdrError("trailing bytes after XDR value")


def _sc_address(r: _Reader) -> str:
    kind = r.u32()
    if kind == 0:  # SC_ADDRESS_TYPE_ACCOUNT: AccountID = PublicKey
        if r.u32() != 0:
            raise XdrError("unsupported public key type")
        return encode_strkey(VERSION_ACCOUNT, r.take(32))
    if kind == 1:  # SC_ADDRESS_TYPE_CONTRACT
        return encode_strkey(VERSION_CONTRACT, r.take(32))
    if kind == 2:  # SC_ADDRESS_TYPE_MUXED_ACCOUNT { uint64 id; uint256 ed25519 }
        mux_id = r.take(8)
        return encode_strkey(12 << 3, r.take(32) + mux_id)
    if kind == 3:  # SC_ADDRESS_TYPE_CLAIMABLE_BALANCE: ClaimableBalanceID (V0 + hash)
        if r.u32() != 0:
            raise XdrError("unsupported claimable balance id type")
        return encode_strkey(1 << 3, b"\0" + r.take(32))
    if kind == 4:  # SC_ADDRESS_TYPE_LIQUIDITY_POOL
        return encode_strkey(11 << 3, r.take(32))
    raise XdrError(f"unknown SCAddress type {kind}")


def _sc_val(r: _Reader, depth: int = 0) -> ScVal:
    if depth > 32:
        raise XdrError("XDR nested too deeply")
    t = r.u32()
    if t == SCV_BOOL:
        return ScVal(t, r.boolean())
    if t in (SCV_VOID, SCV_LEDGER_KEY_CONTRACT_INSTANCE):
        return ScVal(t, None)
    if t == SCV_ERROR:
        return ScVal(t, (r.u32(), r.u32()))
    if t == SCV_U32:
        return ScVal(t, r.u32())
    if t == SCV_I32:
        return ScVal(t, r.i32())
    if t in (SCV_U64, SCV_TIMEPOINT, SCV_DURATION):
        return ScVal(t, r.u64())
    if t in (SCV_I64, SCV_LEDGER_KEY_NONCE):
        return ScVal(t, r.i64())
    if t == SCV_U128:
        hi, lo = r.u64(), r.u64()
        return ScVal(t, (hi << 64) | lo)
    if t == SCV_I128:
        hi, lo = r.i64(), r.u64()
        return ScVal(t, (hi << 64) | lo)
    if t == SCV_U256:
        parts = [r.u64() for _ in range(4)]
        return ScVal(t, (parts[0] << 192) | (parts[1] << 128) | (parts[2] << 64) | parts[3])
    if t == SCV_I256:
        hh = r.i64()
        rest = [r.u64() for _ in range(3)]
        return ScVal(t, (hh << 192) | (rest[0] << 128) | (rest[1] << 64) | rest[2])
    if t == SCV_BYTES:
        return ScVal(t, r.opaque())
    if t in (SCV_STRING, SCV_SYMBOL):
        return ScVal(t, r.opaque())
    if t == SCV_VEC:
        if not r.boolean():
            return ScVal(t, None)
        return ScVal(t, [_sc_val(r, depth + 1) for _ in range(r.u32())])
    if t == SCV_MAP:
        if not r.boolean():
            return ScVal(t, None)
        return ScVal(t, [(_sc_val(r, depth + 1), _sc_val(r, depth + 1)) for _ in range(r.u32())])
    if t == SCV_ADDRESS:
        return ScVal(t, _sc_address(r))
    if t == SCV_CONTRACT_INSTANCE:
        kind = r.u32()  # ContractExecutable
        if kind == 0:
            executable: tuple[str, bytes | None] = ("wasm", r.take(32))
        elif kind == 1:
            executable = ("stellar_asset", None)
        else:
            raise XdrError(f"unknown ContractExecutable type {kind}")
        storage = None
        if r.boolean():
            storage = [(_sc_val(r, depth + 1), _sc_val(r, depth + 1)) for _ in range(r.u32())]
        return ScVal(t, (executable, storage))
    raise XdrError(f"unknown SCVal type {t}")


def encode_sc_address(address: str) -> bytes:
    if is_valid_contract(address):
        return struct.pack(">I", 1) + decode_strkey(VERSION_CONTRACT, address, 32)
    if is_valid_account(address):
        return struct.pack(">II", 0, 0) + decode_strkey(VERSION_ACCOUNT, address, 32)
    raise XdrError(f"unsupported address {address}")


def escrow_storage_key(escrow_id: int) -> bytes:
    """``DataKey::Escrow(id)``: ScVal vec [symbol "Escrow", u64 id]."""
    sym = b"Escrow"
    return (
        struct.pack(">III", SCV_VEC, 1, 2)
        + struct.pack(">II", SCV_SYMBOL, len(sym))
        + sym
        + b"\0" * (-len(sym) % 4)
        + struct.pack(">IQ", SCV_U64, escrow_id)
    )


INSTANCE_KEY = struct.pack(">I", SCV_LEDGER_KEY_CONTRACT_INSTANCE)
PERSISTENT = 1


def contract_data_ledger_key(contract_id: str, key_xdr: bytes, durability: int = PERSISTENT) -> str:
    """Base64 XDR LedgerKey CONTRACT_DATA { contract, key, durability }."""
    raw = struct.pack(">I", 6) + encode_sc_address(contract_id) + key_xdr + struct.pack(">I", durability)
    return base64.b64encode(raw).decode("ascii")


def decode_contract_data_entry(b64: str) -> tuple[str, ScVal, int, ScVal]:
    """LedgerEntryData (base64) of type CONTRACT_DATA → (contract, key, durability, val)."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError):
        raise XdrError("ledger entry is not base64") from None
    r = _Reader(raw)
    if r.u32() != 6:
        raise XdrError("ledger entry is not contract data")
    if r.u32() != 0:  # ExtensionPoint
        raise XdrError("unsupported contract data extension")
    contract = _sc_address(r)
    key = _sc_val(r)
    durability = r.u32()
    val = _sc_val(r)
    r.done()
    return contract, key, durability, val


# --- The contract's Escrow record ---------------------------------------------------------------

_STATUS = {1: "open", 2: "delivered", 3: "released", 4: "refunded"}
_FIELDS = sorted(
    [
        "amount",
        "buyer",
        "deliver_by",
        "delivered_at",
        "evaluator",
        "receipt_hash",
        "review_window",
        "seller",
        "status",
        "token",
    ]
)
_MAX_SAFE = 2**53 - 1


@dataclass
class SorobanEscrow:
    buyer: str
    seller: str
    evaluator: str | None
    token: str
    amount: int
    deliver_by: int
    review_window: int
    delivered_at: int
    status: str
    receipt_hash: str | None


def _not_record(what: str) -> Contradiction:
    return Contradiction(f"not a ReceptumEscrow record: {what}")


def _text(v: ScVal) -> str | None:
    """String form of an address, string or symbol ScVal (as the JS SDK's scValToNative)."""
    if v.type == SCV_ADDRESS:
        return v.value
    if v.type in (SCV_STRING, SCV_SYMBOL):
        return v.value.decode("utf-8", "replace")
    return None


def decode_escrow_record(val: ScVal) -> SorobanEscrow:
    """Decodes the contract's ``Escrow`` struct, rejecting anything without exactly its shape."""
    if val.type != SCV_MAP or val.value is None:
        raise _not_record("not a map")
    raw: dict[str, ScVal] = {}
    for k, v in val.value:
        name = _text(k)
        if name is None:
            raise _not_record("unexpected fields")
        raw[name] = v
    if sorted(raw) != _FIELDS:
        raise _not_record("unexpected fields")

    def account(v: ScVal, k: str) -> str:
        s = _text(v)
        if s is None or not (is_valid_account(s) or is_valid_contract(s)):
            raise _not_record(k)
        return s

    def optional(v: ScVal) -> bool:
        return v.type == SCV_VOID

    def u64(v: ScVal, k: str) -> int:
        if v.type not in _BIGINT_TYPES or not 0 <= v.value <= _MAX_SAFE:
            raise _not_record(k)
        return v.value

    status_v = raw["status"]
    status = (
        _STATUS.get(status_v.value)
        if status_v.type in _BIGINT_TYPES | _NUMBER_TYPES
        else None
    )
    if status is None:
        raise _not_record("status")
    receipt_hash = None
    rh = raw["receipt_hash"]
    if not optional(rh):
        if rh.type != SCV_BYTES or len(rh.value) != 32:
            raise _not_record("receipt_hash")
        receipt_hash = rh.value.hex()
    amount = raw["amount"]
    if amount.type not in _BIGINT_TYPES or amount.value <= 0:
        raise _not_record("amount")
    window = raw["review_window"]
    if window.type not in _NUMBER_TYPES:
        raise _not_record("review_window")
    evaluator = None if optional(raw["evaluator"]) else account(raw["evaluator"], "evaluator")
    buyer = account(raw["buyer"], "buyer")
    seller = account(raw["seller"], "seller")
    token = _text(raw["token"])
    if token is None or not is_valid_contract(token):
        raise _not_record("token")
    return SorobanEscrow(
        buyer=buyer,
        seller=seller,
        evaluator=evaluator,
        token=token,
        amount=amount.value,
        deliver_by=u64(raw["deliver_by"], "deliver_by"),
        review_window=window.value,
        delivered_at=u64(raw["delivered_at"], "delivered_at"),
        status=status,
        receipt_hash=receipt_hash,
    )


# --- RPC --------------------------------------------------------------------------------------

Call = Callable[[str, Any], Any]

_ESCROW_ID = re.compile(r"^stellar:testnet:(C[A-Z2-7]{55}):([1-9][0-9]{0,19})\Z")


def parse_soroban_escrow_id(reference: Any) -> tuple[str, int]:
    """``stellar:testnet:<C…>:<id>`` → (contract id, escrow id); ValueError when malformed."""
    m = _ESCROW_ID.match(reference) if isinstance(reference, str) else None
    if not m or not is_valid_contract(m.group(1)) or int(m.group(2)) >= 2**64:
        raise ValueError(f"invalid Soroban escrowId: {reference}")
    return m.group(1), int(m.group(2))


class SorobanRpc:
    def __init__(self, call: Call) -> None:
        self.call = call

    def assert_testnet(self) -> None:
        net = self.call("getNetwork", {})
        passphrase = net.get("passphrase") if isinstance(net, dict) else None
        if passphrase != STELLAR_TESTNET_PASSPHRASE:
            raise RpcError(f'refusing RPC on "{passphrase}": the escrow rail is testnet-only')

    def entry(self, ledger_key: str) -> str | None:
        res = self.call("getLedgerEntries", {"keys": [ledger_key]})
        entries = res.get("entries") if isinstance(res, dict) else None
        if entries is None:
            entries = []
        if not isinstance(entries, list):
            raise RpcError("getLedgerEntries: malformed reply")
        for e in entries:
            if isinstance(e, dict) and e.get("key") in (None, ledger_key):
                xdr = e.get("xdr")
                if not isinstance(xdr, str):
                    raise RpcError("getLedgerEntries: entry without xdr")
                return xdr
        return None

    def contract_wasm_hash(self, contract_id: str) -> str | None:
        """Hex wasm hash the contract runs; None for non-wasm (asset) contracts. Raises RpcError
        when the instance can't be read (as the TS verifier, a missing instance is unavailable)."""
        xdr = self.entry(contract_data_ledger_key(contract_id, INSTANCE_KEY))
        if xdr is None:
            raise RpcError(f"contract instance of {contract_id} not found")
        _, _, _, val = decode_contract_data_entry(xdr)
        if val.type != SCV_CONTRACT_INSTANCE:
            raise RpcError("unexpected contract instance entry")
        (kind, wasm_hash), _ = val.value
        return wasm_hash.hex() if kind == "wasm" and wasm_hash else None

    def read_escrow(self, contract_id: str, escrow_id: int) -> SorobanEscrow:
        xdr = self.entry(contract_data_ledger_key(contract_id, escrow_storage_key(escrow_id)))
        if xdr is None:
            raise Contradiction(f"unknown escrow {escrow_id} on {contract_id}")
        _, _, _, val = decode_contract_data_entry(xdr)
        return decode_escrow_record(val)


def _json_rpc_call(url: str) -> Call:
    rpc = JsonRpc(url)
    return lambda method, params: rpc.call(method, params)


def check_soroban_escrow(
    signed: dict,
    payer: str | None,
    payee: str | None,
    *,
    trusted: list[str] | tuple[str, ...] = (),
    rpcs: dict[str, str] | None = None,
    call: Call | None = None,
) -> CheckResult:
    """SPEC §7.3 escrow rail on the Soroban ReceptumEscrow. ``payer``/``payee`` are the bare
    accounts already checked to be on ``payment.network`` (None when absent)."""
    receipt = signed["receipt"]
    pay = receipt["payment"]
    network = pay["network"]
    if network != STELLAR_TESTNET:
        return CheckResult("unavailable", f"unsupported network {network}")
    try:
        contract_id, escrow_id = parse_soroban_escrow_id(pay["reference"])
    except ValueError as exc:
        return CheckResult("fail", str(exc))
    if call is None:
        url = {**DEFAULT_SOROBAN_RPCS, **(rpcs or {})}.get(network)
        if not url:
            return CheckResult("unavailable", f"no Soroban RPC endpoint configured for {network}")
        call = _json_rpc_call(url)
    rpc = SorobanRpc(call)
    try:
        rpc.assert_testnet()
        if rpc.contract_wasm_hash(contract_id) != RECEPTUM_SOROBAN_WASM_HASH:
            return CheckResult(
                "fail", "referenced contract does not run the published ReceptumEscrow wasm"
            )
        e = rpc.read_escrow(contract_id, escrow_id)
    except Contradiction as exc:
        return CheckResult("fail", str(exc))
    except (RpcError, XdrError) as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")

    acc = receipt["acceptance"]
    try:
        token = token_contract_id(pay["asset"])
    except ValueError:
        token = None
    want_evaluator = None
    if acc.get("evaluator") is not None:
        chain, _, addr = acc["evaluator"].rpartition(":")
        want_evaluator = addr if chain == network else None
    problems = [
        p
        for p in (
            e.receipt_hash != signed["receiptHash"] and "committed receiptHash differs",
            str(e.amount) != pay["amount"] and "amount differs",
            e.token != token and "token differs from payment.asset",
            payer and e.buyer != payer and "buyer differs from payment.payer",
            payee and e.seller != payee and "seller differs from payment.payee",
            e.review_window != acc["reviewWindowSeconds"]
            and "review window differs from acceptance.reviewWindowSeconds",
            acc["mode"] == "evaluator"
            and (not e.evaluator or e.evaluator != want_evaluator)
            and "evaluator differs from acceptance.evaluator",
            acc["mode"] != "evaluator"
            and e.evaluator
            and "escrow has an evaluator the receipt doesn't declare",
        )
        if p
    ]
    if problems:
        return CheckResult("fail", f"escrow {e.status}: {'; '.join(problems)}")
    if e.status not in ("released", "delivered"):
        return CheckResult("fail", f"escrow is {e.status}, not released")
    if contract_id not in (*TRUSTED_SOROBAN_ESCROWS.get(network, ()), *trusted):
        return CheckResult(
            "pending",
            "ReceptumEscrow wasm, but this deployment isn't in the trusted registry "
            "(pass --trust-escrow to accept it)",
        )
    if not payee:
        return CheckResult(
            "unavailable", "receipt does not name a payee, so the recipient can't be confirmed"
        )
    if e.status == "delivered":
        return CheckResult(
            "pending", "delivery committed; funds still held awaiting acceptance or the review window"
        )
    return CheckResult(
        "pass",
        f"Soroban escrow {escrow_id} on {contract_id} released to the payee; committed "
        "receiptHash and terms match",
    )
