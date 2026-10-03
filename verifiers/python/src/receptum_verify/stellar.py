"""Stellar testnet: StrKey, assets and their Stellar Asset Contract ids, a minimal Horizon client
(urllib), level 3 for ``x402:exact`` on ``stellar:testnet`` and ``anchor:stellar`` (SPEC §7.1,
§7.3).

Horizon keeps full history, so settlements and anchors are read from it. A transaction Horizon
does not know fails; transport errors are ``unavailable``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any, Callable

from .evm import CheckResult

__all__ = [
    "DEFAULT_HORIZON",
    "STELLAR_TESTNET",
    "STELLAR_TESTNET_PASSPHRASE",
    "HorizonError",
    "HorizonNotFound",
    "Horizon",
    "check_stellar_anchor",
    "check_stellar_x402_exact",
    "contract_strkey",
    "decode_strkey",
    "encode_strkey",
    "from_stellar_amount",
    "is_valid_account",
    "is_valid_contract",
    "parse_asset",
    "sac_contract_id",
    "token_contract_id",
]

STELLAR_TESTNET = "stellar:testnet"
STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
DEFAULT_HORIZON: dict[str, str] = {STELLAR_TESTNET: "https://horizon-testnet.stellar.org"}

# --- StrKey (SEP-23) ---------------------------------------------------------------------------

VERSION_ACCOUNT = 6 << 3  # G…
VERSION_CONTRACT = 2 << 3  # C…
VERSION_CLAIMABLE_BALANCE = 1 << 3  # B…

_B32 = re.compile(r"^[A-Z2-7]+\Z")


def _crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def encode_strkey(version: int, payload: bytes) -> str:
    raw = bytes([version]) + payload
    raw += _crc16_xmodem(raw).to_bytes(2, "little")
    return base64.b32encode(raw).decode("ascii").rstrip("=")


def decode_strkey(version: int, text: Any, length: int) -> bytes:
    """Payload of a canonical StrKey with this version byte and payload length; ValueError else."""
    if not isinstance(text, str) or not _B32.match(text):
        raise ValueError("not a StrKey")
    try:
        raw = base64.b32decode(text + "=" * (-len(text) % 8))
    except binascii.Error:
        raise ValueError("StrKey is not base32") from None
    if len(raw) != 1 + length + 2 or raw[0] != version:
        raise ValueError("unexpected StrKey type or length")
    if _crc16_xmodem(raw[:-2]).to_bytes(2, "little") != raw[-2:]:
        raise ValueError("StrKey checksum mismatch")
    if encode_strkey(version, raw[1:-2]) != text:
        raise ValueError("non-canonical StrKey")
    return raw[1:-2]


def is_valid_account(text: Any) -> bool:
    try:
        decode_strkey(VERSION_ACCOUNT, text, 32)
        return True
    except ValueError:
        return False


def is_valid_contract(text: Any) -> bool:
    try:
        decode_strkey(VERSION_CONTRACT, text, 32)
        return True
    except ValueError:
        return False


def contract_strkey(contract_id: bytes) -> str:
    return encode_strkey(VERSION_CONTRACT, contract_id)


# --- Assets and the Stellar Asset Contract ------------------------------------------------------

_ASSET_CODE = re.compile(r"^[A-Za-z0-9]{1,12}\Z")


def parse_asset(asset: Any) -> tuple[str, str] | None:
    """``native``/``XLM`` → None; ``CODE:ISSUER`` → (code, issuer). ValueError otherwise."""
    if asset in ("native", "XLM"):
        return None
    if not isinstance(asset, str):
        raise ValueError("invalid Stellar asset")
    parts = asset.split(":")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError(f"invalid Stellar asset: {asset}")
    code, issuer = parts
    if not _ASSET_CODE.match(code):
        raise ValueError(f"invalid Stellar asset code: {code}")
    if not is_valid_account(issuer):
        raise ValueError(f"invalid Stellar asset issuer: {issuer}")
    return code, issuer


def _asset_xdr(parsed: tuple[str, str] | None) -> bytes:
    if parsed is None:
        return (0).to_bytes(4, "big")  # ASSET_TYPE_NATIVE
    code, issuer = parsed
    key = decode_strkey(VERSION_ACCOUNT, issuer, 32)
    issuer_xdr = (0).to_bytes(4, "big") + key  # PublicKey: PUBLIC_KEY_TYPE_ED25519
    raw = code.encode("ascii")
    if len(raw) <= 4:
        return (1).to_bytes(4, "big") + raw.ljust(4, b"\0") + issuer_xdr
    return (2).to_bytes(4, "big") + raw.ljust(12, b"\0") + issuer_xdr


def sac_contract_id(asset: str, passphrase: str = STELLAR_TESTNET_PASSPHRASE) -> str:
    """Contract id (C…) of an asset's Stellar Asset Contract: SHA-256 of the XDR
    ``HashIDPreimage`` ENVELOPE_TYPE_CONTRACT_ID { networkID, CONTRACT_ID_PREIMAGE_FROM_ASSET }."""
    preimage = (
        (8).to_bytes(4, "big")  # ENVELOPE_TYPE_CONTRACT_ID
        + hashlib.sha256(passphrase.encode()).digest()
        + (1).to_bytes(4, "big")  # CONTRACT_ID_PREIMAGE_FROM_ASSET
        + _asset_xdr(parse_asset(asset))
    )
    return contract_strkey(hashlib.sha256(preimage).digest())


def token_contract_id(asset: str) -> str:
    """The token contract of ``native`` / ``CODE:ISSUER`` (its SAC on testnet) or a ``C…`` id."""
    if is_valid_contract(asset):
        return asset
    return sac_contract_id(asset)


def same_stellar_asset(a: str, b: str) -> bool:
    try:
        return token_contract_id(a) == token_contract_id(b)
    except ValueError:
        return False


_STELLAR_AMOUNT = re.compile(r"^([0-9]+)(?:\.([0-9]{1,7}))?\Z")


def from_stellar_amount(amount: Any) -> str:
    """Horizon decimal amount (7 decimals) → smallest-unit integer string."""
    m = _STELLAR_AMOUNT.match(amount) if isinstance(amount, str) else None
    if not m:
        raise ValueError(f"invalid Stellar amount: {amount}")
    return str(int(m.group(1)) * 10_000_000 + int((m.group(2) or "").ljust(7, "0")))


def hash_from_base64(value: Any) -> str | None:
    """A base64 32-byte value (Horizon's hash ``memo``, a data entry value) as hex, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = base64.b64decode(value)
    except (binascii.Error, ValueError):
        return None
    return raw.hex() if len(raw) == 32 else None


def unix_seconds(iso: Any) -> float | None:
    """Horizon timestamp (``2026-10-03T17:34:17Z``) → unix seconds, or None."""
    if not isinstance(iso, str):
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# --- Horizon ----------------------------------------------------------------------------------


class HorizonError(RuntimeError):
    """Horizon could not be asked (transport error, unexpected reply): ``unavailable``."""


class HorizonNotFound(HorizonError):
    """Horizon answered 404."""


Fetch = Callable[[str], Any]


def _urllib_fetch(url: str, timeout: float = 20.0) -> Any:
    req = urllib.request.Request(
        url, headers={"accept": "application/json", "user-agent": "receptum-verify-py"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HorizonNotFound(f"{url}: not found") from None
        raise HorizonError(f"GET {url} failed: HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise HorizonError(f"GET {url} failed: {exc}") from None


class Horizon:
    """Read-only Horizon access. ``fetch(url)`` returns parsed JSON or raises HorizonNotFound /
    HorizonError (tests inject a fake)."""

    def __init__(self, base_url: str, fetch: Fetch | None = None) -> None:
        self.base = base_url.rstrip("/")
        self.fetch = fetch or _urllib_fetch

    def get(self, path: str, **query: Any) -> Any:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        doc = self.fetch(url)
        if not isinstance(doc, dict):
            raise HorizonError(f"GET {path}: malformed reply")
        return doc

    def transaction(self, tx_hash: str) -> dict:
        return self.get(f"/transactions/{tx_hash}")

    def records(self, path: str, **query: Any) -> list[dict]:
        """The first page of a collection."""
        doc = self.get(path, **query)
        recs = doc.get("_embedded", {}).get("records")
        if not isinstance(recs, list):
            raise HorizonError(f"GET {path}: malformed collection")
        return [r for r in recs if isinstance(r, dict)]

    def pages(self, path: str, **query: Any):
        """Every page of a collection (records, in order), following ``_links.next``."""
        doc = self.get(path, **query)
        while True:
            recs = doc.get("_embedded", {}).get("records")
            if not isinstance(recs, list):
                raise HorizonError(f"GET {path}: malformed collection")
            if not recs:
                return
            yield [r for r in recs if isinstance(r, dict)]
            nxt = doc.get("_links", {}).get("next", {}).get("href")
            if not isinstance(nxt, str) or not nxt:
                return
            doc = self.fetch(nxt)
            if not isinstance(doc, dict):
                raise HorizonError(f"GET {nxt}: malformed reply")


def horizon_for(network: str, horizons: dict[str, str] | None, fetch: Fetch | None) -> Horizon | None:
    url = {**DEFAULT_HORIZON, **(horizons or {})}.get(network)
    return Horizon(url, fetch) if url else None


# --- x402:exact on stellar:testnet (SPEC §7.3) ------------------------------------------------

_TX = re.compile(r"^[0-9a-f]{64}\Z")


def _change_matches(change: dict, token: str, amount: str, to: str, frm: str | None) -> bool:
    if change.get("asset_type") == "native":
        asset = "native"
    else:
        asset = f"{change.get('asset_code') or ''}:{change.get('asset_issuer') or ''}"
    try:
        change_token = token_contract_id(asset)
    except ValueError:
        return False
    if change.get("type") != "transfer" or change_token != token or change.get("to") != to:
        return False
    if frm and change.get("from") != frm:
        return False
    # A malformed Horizon amount raises (unavailable), as it would for the TS verifier.
    return from_stellar_amount(change.get("amount")) == str(int(amount))


def check_stellar_x402_exact(
    receipt: dict,
    payer: str | None,
    payee: str | None,
    *,
    horizons: dict[str, str] | None = None,
    fetch: Fetch | None = None,
) -> CheckResult:
    """A successful transaction at ``payment.reference`` whose ``invoke_host_function``
    operation records (Horizon ``asset_balance_changes``) a SAC ``transfer`` of exactly
    ``payment.amount`` of ``payment.asset`` to the payee (from the payer, when stated).
    ``payer``/``payee`` are the bare accounts already checked to be on the network."""
    pay = receipt["payment"]
    ref, asset, amount = pay["reference"], pay["asset"], pay["amount"]
    if not isinstance(ref, str) or not _TX.match(ref):
        return CheckResult(
            "fail", "payment.reference is not a Stellar transaction hash (64 lower-case hex)"
        )
    try:
        token = token_contract_id(asset)
    except ValueError:
        return CheckResult(
            "fail", "payment.asset is not a Stellar asset (CODE:ISSUER, native or a C… contract)"
        )
    if not payee:
        return CheckResult(
            "unavailable", "receipt does not name a payee, so the recipient can't be confirmed"
        )
    horizon = horizon_for(pay["network"], horizons, fetch)
    if horizon is None:
        return CheckResult("unavailable", f"no Horizon endpoint configured for {pay['network']}")
    try:
        try:
            tx = horizon.transaction(ref)
        except HorizonNotFound:
            return CheckResult("fail", "settlement transaction not found")
        if tx.get("successful") is not True:
            return CheckResult("fail", "settlement transaction failed")
        ops = horizon.records(f"/transactions/{ref}/operations", limit=200)
        for op in ops:
            if op.get("type") != "invoke_host_function":
                continue
            for change in op.get("asset_balance_changes") or []:
                if isinstance(change, dict) and _change_matches(change, token, amount, payee, payer):
                    return CheckResult(
                        "pass", f"{amount} base units paid to {payee} in ledger {tx.get('ledger')}"
                    )
    except (HorizonError, ValueError) as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")
    return CheckResult(
        "fail", "no transfer of that amount and asset to the payee in the settlement"
    )


# --- anchor:stellar (SPEC §7.1) ---------------------------------------------------------------


def check_stellar_anchor(
    network: str,
    tx_hash: str,
    receipt_hash_hex: str,
    *,
    horizons: dict[str, str] | None = None,
    fetch: Fetch | None = None,
) -> CheckResult:
    """A successful transaction with memo type MEMO_HASH whose 32 bytes equal receiptHash."""
    if not _TX.match(tx_hash):
        return CheckResult("fail", "anchor transaction hash is malformed")
    horizon = horizon_for(network, horizons, fetch)
    if horizon is None:
        return CheckResult("unavailable", f"unsupported anchor network {network}")
    try:
        tx = horizon.transaction(tx_hash)
    except HorizonNotFound:
        tx = None
    except HorizonError as exc:
        return CheckResult("unavailable", f"could not be checked: {exc}")
    if (
        tx is None
        or tx.get("successful") is not True
        or tx.get("memo_type") != "hash"
        or hash_from_base64(tx.get("memo")) != receipt_hash_hex
    ):
        return CheckResult(
            "fail", "no successful MEMO_HASH transaction for this receiptHash at that reference"
        )
    return CheckResult("pass", f"MEMO_HASH anchored {tx.get('created_at')} ({network} tx {tx_hash})")
