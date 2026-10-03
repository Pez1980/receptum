"""Account bindings (SPEC §4.1): the seller's did:key and the payout account's own
chain key both sign one statement, proving the seller controls ``payment.payee``.

Namespaces: eip155 (EIP-191 personal_sign), xrpl (ripple-keypairs, Ed25519 and
secp256k1; master key offline, master/RegularKey online) and stellar (SEP-53).
"""

from __future__ import annotations

import base64
import binascii
import calendar
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import secp256k1
from .encoding import EncodingError, did_key_public_key
from .evm import CheckResult
from .hashes import keccak256, ripemd160
from .jcs import JCSError, canonicalize
from .jws import verify_detached_jws
from .receipt import _TIMESTAMP, _timestamp_ok, is_caip10

__all__ = [
    "BINDING_JWS_TYP",
    "BINDING_TYPE",
    "DEFAULT_XRPL_RPCS",
    "MAX_BINDINGS",
    "MAX_ISSUED_AT_SKEW_SECONDS",
    "BindingResult",
    "XrplKeys",
    "check_payee_binding",
    "evm_recover_address",
    "fetch_xrpl_keys",
    "parse_timestamp",
    "stellar_public_key",
    "validate_statement",
    "verify_binding",
    "xrpl_address",
]

BINDING_TYPE = "receptum/account-binding/1"
BINDING_JWS_TYP = "receptum-binding+jws"
MAX_ISSUED_AT_SKEW_SECONDS = 300
# Bindings examined per receipt: a bound on work, not a protocol limit (as in the TS verifier).
MAX_BINDINGS = 16
DEFAULT_XRPL_RPCS: dict[str, str] = {
    "xrpl:1": "https://s.altnet.rippletest.net:51234",
    "xrpl:0": "https://xrplcluster.com",  # mainnet (read-only account-key lookup)
}

_BINDING_MEMBERS = {"statement", "didProof", "accountProof"}
_STATEMENT = {"type": True, "did": True, "account": True, "issuedAt": True, "expiresAt": False}
_EVM_SIG = re.compile(r"^0x[0-9a-f]{130}\Z")
_EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}\Z")
_UPPER_HEX = re.compile(r"^(?:[0-9A-F]{2})+\Z")
_HALF_N = secp256k1.N // 2
# Order of the Ed25519 base point (RFC 8032 §5.1): S MUST be < L.
_ED25519_L = 2**252 + 27742317777372353535851770400913936493
_EIP191_PREFIX = b"\x19Ethereum Signed Message:\n"
_SEP53_PREFIX = b"Stellar Signed Message:\n"
_RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"
_LSF_DISABLE_MASTER = 0x00100000


@dataclass
class XrplKeys:
    """An XRPL account's current signing keys, from a validated ``account_info``."""

    master_disabled: bool
    regular_key: str | None


@dataclass
class BindingResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    detail: str = ""
    # True when everything verified except that the XRPL key is not the master key
    # (offline rules); the statement is then known to be well-formed.
    key_only: bool = False


# --- timestamps -------------------------------------------------------------


def parse_timestamp(s: str) -> Fraction:
    """Exact seconds since the Unix epoch of a SPEC §2.2 timestamp (1–9 fractional digits)."""
    if not (isinstance(s, str) and _timestamp_ok(s)):
        raise ValueError(f"not a UTC timestamp YYYY-MM-DDTHH:MM:SS[.f…]Z: {s!r}")
    m = _TIMESTAMP.match(s)
    assert m is not None
    y, mo, d, h, mi, sec = (int(g) for g in m.groups())
    whole = calendar.timegm((y, mo, d, h, mi, sec, 0, 0, 0))
    dot = s.find(".")
    frac = Fraction(int(s[dot + 1 : -1]), 10 ** (len(s) - dot - 2)) if dot >= 0 else Fraction(0)
    return whole + frac


# --- statement --------------------------------------------------------------


def validate_statement(st: Any) -> list[str]:
    errors: list[str] = []
    p = "binding.statement"
    if not isinstance(st, dict):
        return [f"{p} must be an object"]
    for key in st:
        if key not in _STATEMENT:
            errors.append(f"{p}.{key} is not allowed")
    for key, required in _STATEMENT.items():
        if required and key not in st:
            errors.append(f"{p}.{key} is required")
        elif key in st and not isinstance(st[key], str):
            errors.append(f"{p}.{key} must be a string")
    if errors:
        return errors
    if st["type"] != BINDING_TYPE:
        errors.append(f'{p}.type must be "{BINDING_TYPE}"')
    try:
        did_key_public_key(st["did"])
    except EncodingError:
        errors.append(f"{p}.did must be an Ed25519 did:key")
    if not is_caip10(st["account"]):
        errors.append(f"{p}.account must be a CAIP-10 account")
    times = {}
    for key in ("issuedAt", "expiresAt"):
        if key in st:
            try:
                times[key] = parse_timestamp(st[key])
            except ValueError:
                errors.append(f"{p}.{key} must be a UTC timestamp YYYY-MM-DDTHH:MM:SS[.f…]Z")
    if "issuedAt" in times and "expiresAt" in times and times["expiresAt"] <= times["issuedAt"]:
        errors.append(f"{p}.expiresAt must be after issuedAt")
    return errors


# --- eip155: EIP-191 personal_sign -----------------------------------------


def evm_recover_address(message: bytes, signature_hex: str) -> str:
    """Lower-case 0x address that signed ``personal_sign(message)``.

    Requires 65 bytes of lower-case 0x hex r ‖ s ‖ v, v ∈ {27, 28}, low-s."""
    if not isinstance(signature_hex, str) or not _EVM_SIG.match(signature_hex):
        raise ValueError("signature must be 65 bytes of lower-case 0x hex (r ‖ s ‖ v)")
    sig = bytes.fromhex(signature_hex[2:])
    r, s, v = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:64], "big"), sig[64]
    if v not in (27, 28):
        raise ValueError("signature v must be 27 or 28")
    if not (1 <= r < secp256k1.N and 1 <= s < secp256k1.N):
        raise ValueError("signature r or s is out of range")
    if s > _HALF_N:
        raise ValueError("signature is not low-s")
    digest = keccak256(_EIP191_PREFIX + str(len(message)).encode("ascii") + message)
    try:
        pub = secp256k1.recover(digest, r, s, v - 27)
    except secp256k1.Secp256k1Error as exc:
        raise ValueError(f"no public key recovers from the signature: {exc}") from None
    return "0x" + keccak256(secp256k1.encode_uncompressed(pub)[1:])[12:].hex()


def _verify_eip191(proof: dict, address: str, message: bytes, err: list[str]) -> str | None:
    if set(proof) != {"type", "signature"}:
        err.append('accountProof members must be exactly ["signature", "type"] for eip191')
        return None
    if not _EVM_ADDRESS.match(address):
        err.append("statement.account is not an EVM address")
        return None
    try:
        recovered = evm_recover_address(message, proof["signature"])
    except ValueError as exc:
        err.append(f"accountProof: {exc}")
        return None
    if recovered != address.lower():
        err.append(f"accountProof was signed by {recovered}, not {address}")
        return None
    return f"EIP-191 signature recovers {address}"


# --- xrpl: ripple-keypairs --------------------------------------------------


def _ripple_b58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = []
    while n:
        n, r = divmod(n, 58)
        out.append(_RIPPLE_ALPHABET[r])
    zeros = len(data) - len(data.lstrip(b"\x00"))
    return _RIPPLE_ALPHABET[0] * zeros + "".join(reversed(out))


def is_classic_address(address: Any) -> bool:
    """A valid XRPL classic address: ripple-base58check of 0x00 ‖ 20-byte account id."""
    if not isinstance(address, str) or not address.startswith("r") or not 25 <= len(address) <= 35:
        return False
    n = 0
    for ch in address:
        i = _RIPPLE_ALPHABET.find(ch)
        if i < 0:
            return False
        n = n * 58 + i
    zeros = len(address) - len(address.lstrip(_RIPPLE_ALPHABET[0]))
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    data = b"\x00" * zeros + raw
    if len(data) != 25 or data[0] != 0:
        return False
    return hashlib.sha256(hashlib.sha256(data[:21]).digest()).digest()[:4] == data[21:]


def xrpl_address(public_key: bytes) -> str:
    """Classic address: base58check(0x00 ‖ RIPEMD-160(SHA-256(publicKey))), ripple alphabet."""
    payload = b"\x00" + ripemd160(hashlib.sha256(public_key).digest())
    check = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return _ripple_b58(payload + check)


def _parse_der(sig: bytes) -> tuple[int, int]:
    """Strict DER ECDSA-Sig-Value: minimal lengths and integers, positive, no trailing data."""

    def integer(buf: bytes, i: int) -> tuple[int, int]:
        if i + 2 > len(buf) or buf[i] != 0x02:
            raise ValueError("expected a DER INTEGER")
        ln = buf[i + 1]
        if ln == 0 or ln > 33 or i + 2 + ln > len(buf):
            raise ValueError("bad DER INTEGER length")
        body = buf[i + 2 : i + 2 + ln]
        if body[0] & 0x80:
            raise ValueError("negative DER INTEGER")
        if ln > 1 and body[0] == 0 and not body[1] & 0x80:
            raise ValueError("non-minimal DER INTEGER")
        return int.from_bytes(body, "big"), i + 2 + ln

    if len(sig) < 8 or len(sig) > 72 or sig[0] != 0x30 or sig[1] != len(sig) - 2:
        raise ValueError("not a DER SEQUENCE")
    r, i = integer(sig, 2)
    s, i = integer(sig, i)
    if i != len(sig):
        raise ValueError("trailing bytes after DER signature")
    return r, s


def _xrpl_signature_ok(public_key: bytes, signature: bytes, message: bytes, err: list[str]) -> bool:
    if len(public_key) == 33 and public_key[0] == 0xED:
        if len(signature) != 64:
            err.append("accountProof: Ed25519 signature must be 64 bytes")
            return False
        if int.from_bytes(signature[32:], "little") >= _ED25519_L:
            err.append("accountProof: non-canonical Ed25519 signature (S >= L)")
            return False
        try:
            Ed25519PublicKey.from_public_bytes(public_key[1:]).verify(signature, message)
        except (InvalidSignature, ValueError):
            err.append("accountProof: Ed25519 signature does not verify")
            return False
        return True
    if len(public_key) == 33 and public_key[0] in (2, 3):
        try:
            point = secp256k1.decode_point(public_key)
            r, s = _parse_der(signature)
        except ValueError as exc:
            err.append(f"accountProof: {exc}")
            return False
        if not (1 <= r < secp256k1.N and 1 <= s < secp256k1.N):
            err.append("accountProof: signature r or s is out of range")
            return False
        if s > _HALF_N:
            err.append("accountProof: signature is not low-s (not fully canonical)")
            return False
        digest = hashlib.sha512(message).digest()[:32]  # SHA-512Half
        if not secp256k1.verify(digest, r, s, point):
            err.append("accountProof: secp256k1 signature does not verify")
            return False
        return True
    err.append('accountProof.publicKey must be "ED" ‖ 32 bytes or 02/03 ‖ 32 bytes')
    return False


def _verify_xrpl(
    proof: dict,
    address: str,
    message: bytes,
    err: list[str],
    keys: XrplKeys | None,
    res: BindingResult,
) -> str | None:
    if set(proof) != {"type", "publicKey", "signature"}:
        err.append('accountProof members must be exactly ["publicKey", "signature", "type"] for xrpl')
        return None
    pk_hex, sig_hex = proof["publicKey"], proof["signature"]
    if not (isinstance(pk_hex, str) and _UPPER_HEX.match(pk_hex)):
        err.append("accountProof.publicKey must be upper-case hex")
        return None
    if not (isinstance(sig_hex, str) and _UPPER_HEX.match(sig_hex)):
        err.append("accountProof.signature must be upper-case hex")
        return None
    public_key = bytes.fromhex(pk_hex)
    if not _xrpl_signature_ok(public_key, bytes.fromhex(sig_hex), message, err):
        return None
    signer = xrpl_address(public_key)
    if keys is None:
        if signer != address:
            err.append(f"accountProof.publicKey is not the master key of {address} (offline)")
            res.key_only = True
            return None
        return f"signed by the master key of {address} (offline)"
    if signer == address and not keys.master_disabled:
        return f"signed by the enabled master key of {address} (online)"
    if keys.regular_key is not None and signer == keys.regular_key:
        return f"signed by the current RegularKey of {address} (online)"
    if signer == address:
        err.append(f"accountProof is signed by the master key of {address}, which is disabled")
    else:
        err.append(f"accountProof.publicKey is neither the master key nor the RegularKey of {address}")
    return None


def fetch_xrpl_keys(address: str, url: str, timeout: float = 20.0) -> XrplKeys:
    """``account_info`` on the validated ledger. Raises OSError/ValueError when the
    account cannot be read (including an unfunded account)."""
    body = {
        "method": "account_info",
        "params": [{"account": address, "ledger_index": "validated"}],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "user-agent": "receptum-verify-py"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            reply = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise OSError(f"account_info via {url} failed: {exc}") from None
    result = reply.get("result") if isinstance(reply, dict) else None
    if not isinstance(result, dict) or result.get("status") != "success":
        err = result.get("error") if isinstance(result, dict) else None
        raise ValueError(f"account_info for {address}: {err or 'malformed reply'}")
    if result.get("validated") is not True:
        raise ValueError("account_info did not come from a validated ledger")
    data = result.get("account_data")
    if not isinstance(data, dict) or data.get("Account") != address:
        raise ValueError("account_info returned a different account")
    flags = data.get("Flags", 0)
    if not isinstance(flags, int):
        raise ValueError("account_info Flags is not an integer")
    regular = data.get("RegularKey")
    return XrplKeys(bool(flags & _LSF_DISABLE_MASTER), regular if isinstance(regular, str) else None)


# --- stellar: SEP-53 --------------------------------------------------------


def _crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def stellar_public_key(address: str) -> bytes:
    """Ed25519 key of a G… strkey (version byte 6 << 3, CRC16-XModem little-endian)."""
    if not isinstance(address, str) or len(address) != 56 or not address.startswith("G"):
        raise ValueError("not a Stellar G… account address")
    try:
        raw = base64.b32decode(address, casefold=False)
    except binascii.Error:
        raise ValueError("Stellar address is not base32") from None
    if len(raw) != 35 or raw[0] != 6 << 3:
        raise ValueError("Stellar address is not an ed25519 public key strkey")
    if _crc16_xmodem(raw[:33]).to_bytes(2, "little") != raw[33:]:
        raise ValueError("Stellar address checksum mismatch")
    if base64.b32encode(raw).decode().rstrip("=") != address:
        raise ValueError("non-canonical Stellar address")
    return raw[1:33]


def _verify_sep53(proof: dict, address: str, message: bytes, err: list[str]) -> str | None:
    if set(proof) != {"type", "signature"}:
        err.append('accountProof members must be exactly ["signature", "type"] for sep53')
        return None
    try:
        public_key = stellar_public_key(address)
    except ValueError as exc:
        err.append(f"statement.account: {exc}")
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
        err.append("accountProof: SEP-53 signature must be 64 bytes")
        return None
    if int.from_bytes(signature[32:], "little") >= _ED25519_L:
        err.append("accountProof: non-canonical Ed25519 signature (S >= L)")
        return None
    digest = hashlib.sha256(_SEP53_PREFIX + message).digest()
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, digest)
    except (InvalidSignature, ValueError):
        err.append("accountProof: SEP-53 signature does not verify against the account")
        return None
    return f"SEP-53 signature by {address}"


# --- one binding ------------------------------------------------------------


def verify_binding(binding: Any, *, xrpl_keys: XrplKeys | None = None) -> BindingResult:
    """Check a binding's shape and both signatures (SPEC §4.1, condition 4).

    ``xrpl_keys`` switches XRPL to the online key check (master if enabled, or the
    current RegularKey); without it XRPL requires the master key."""
    res = BindingResult(False)
    err = res.errors
    if not isinstance(binding, dict):
        err.append("binding must be an object")
        return res
    if set(binding) != _BINDING_MEMBERS:
        err.append(f"binding members must be exactly {sorted(_BINDING_MEMBERS)}")
        return res
    st = binding["statement"]
    st_errors = validate_statement(st)
    if st_errors:
        err.extend(st_errors)
        return res
    try:
        message = canonicalize(st)
    except JCSError as exc:  # pragma: no cover - a dict of strings always canonicalizes
        err.append(f"statement cannot be canonicalized: {exc}")
        return res

    if not verify_detached_jws(
        binding["didProof"],
        st["did"],
        message,
        BINDING_JWS_TYP,
        err,
        path="didProof",
        signer="statement.did",
    ):
        return res

    proof = binding["accountProof"]
    if not isinstance(proof, dict) or not isinstance(proof.get("type"), str):
        err.append("accountProof must be an object with a string type")
        return res
    namespace, reference, address = st["account"].split(":", 2)
    expected = {"eip155": "eip191", "xrpl": "xrpl", "stellar": "sep53"}.get(namespace)
    if expected is None:
        err.append(f"account namespace {namespace} is not supported (unverified, fail closed)")
        return res
    if proof["type"] != expected:
        err.append(f'accountProof.type must be "{expected}" for {namespace} accounts')
        return res
    if namespace == "eip155":
        detail = _verify_eip191(proof, address, message, err)
    elif namespace == "xrpl":
        detail = _verify_xrpl(proof, address, message, err, xrpl_keys, res)
    else:
        detail = _verify_sep53(proof, address, message, err)
    if detail is None:
        return res
    res.ok = True
    res.detail = detail
    return res


# --- coverage and level 2.5 -------------------------------------------------


def _same_account(a: str, b: str) -> bool:
    """EVM addresses compare case-insensitively; everything else (and CAIP-2) exactly."""
    if a == b:
        return True
    ca, _, aa = a.rpartition(":")
    cb, _, ab = b.rpartition(":")
    return (
        ca == cb
        and ca.startswith("eip155:")
        and bool(_EVM_ADDRESS.match(aa))
        and bool(_EVM_ADDRESS.match(ab))
        and aa.lower() == ab.lower()
    )


def _coverage_errors(st: dict, receipt: dict, now: float) -> list[str]:
    errors = []
    if st["did"] != receipt["seller"]["id"]:
        errors.append("statement.did is not receipt.seller.id")
    if not _same_account(st["account"], receipt["payment"]["payee"]):
        errors.append(f"statement.account {st['account']} is not payment.payee")
    if "expiresAt" in st and parse_timestamp(st["expiresAt"]) <= parse_timestamp(
        receipt["deliveredAt"]
    ):
        errors.append(f"binding expired at {st['expiresAt']}, not after deliveredAt")
    if parse_timestamp(st["issuedAt"]) > Fraction(now) + MAX_ISSUED_AT_SKEW_SECONDS:
        errors.append(f"statement.issuedAt {st['issuedAt']} is more than 5 minutes in the future")
    return errors


KeyLoader = Callable[[str, str], XrplKeys]


def check_payee_binding(
    signed: dict,
    *,
    offline: bool = True,
    allow_unbound: bool = False,
    xrpl_rpcs: dict[str, str] | None = None,
    now: float | None = None,
    load_xrpl_keys: KeyLoader | None = None,
) -> CheckResult:
    """Level 2.5 for an authenticated signed receipt.

    pass = a binding covers the receipt; fail = bindings present but none covers;
    pending = no binding at all (``skipped`` with ``allow_unbound``); skipped when the
    receipt names no payee; unavailable when only the online XRPL key lookup failed."""
    receipt = signed["receipt"]
    payee = receipt["payment"].get("payee")
    if payee is None:
        return CheckResult("skipped", "receipt names no payee")
    bindings = signed.get("bindings")
    if bindings is None or bindings == []:
        if allow_unbound:
            return CheckResult("skipped", "no account binding (allowed: --allow-unbound)")
        return CheckResult("pending", "no account binding: nothing proves the seller controls the payee")
    if not isinstance(bindings, list):
        return CheckResult("fail", "bindings must be an array")
    now = time.time() if now is None else now

    xrpl_keys: XrplKeys | None = None
    lookup_error: str | None = None
    caip2, _, address = payee.rpartition(":")
    if not offline and caip2.startswith("xrpl:"):
        rpcs = {**DEFAULT_XRPL_RPCS, **(xrpl_rpcs or {})}
        url = rpcs.get(caip2)
        if url is not None:  # no endpoint for this network: offline (master key) rules
            try:
                xrpl_keys = (load_xrpl_keys or fetch_xrpl_keys)(address, url)
            except (OSError, ValueError) as exc:
                lookup_error = f"could not load XRPL account keys: {exc}"

    reasons = []
    # Bindings that would cover the receipt but whose key could only be judged online.
    undecided = []
    for i, binding in enumerate(bindings[:MAX_BINDINGS]):
        res = verify_binding(binding, xrpl_keys=xrpl_keys)
        cov = _coverage_errors(binding["statement"], receipt, now) if res.ok or res.key_only else []
        if not res.ok or cov:
            reasons.append(f"bindings[{i}]: {'; '.join(res.errors + cov)}")
            if res.key_only and not cov and lookup_error is not None:
                undecided.append(i)
            continue
        if lookup_error is not None:
            # Offline-valid, but the account's current keys could not be read.
            return CheckResult(
                "unavailable", f"{lookup_error}; offline the binding verifies ({res.detail})"
            )
        mode = "online, current account keys" if xrpl_keys is not None else "offline"
        return CheckResult("pass", f"{binding['statement']['did']} ↔ {payee}: {res.detail} ({mode})")
    if undecided:
        return CheckResult(
            "unavailable",
            f"{lookup_error}; bindings{undecided} are signed by a key that is not the "
            "master key, which can only be checked online",
        )
    if lookup_error is not None:
        reasons.insert(0, lookup_error)
    return CheckResult("fail", "no binding covers the receipt: " + " | ".join(reasons))
