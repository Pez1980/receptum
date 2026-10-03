"""base64url (RFC 4648 §5, unpadded), base58btc and did:key (Ed25519) helpers."""

from __future__ import annotations

import base64
import re

__all__ = [
    "EncodingError",
    "b64url_decode",
    "b64url_encode",
    "b58_decode",
    "b58_encode",
    "did_key_from_public_key",
    "did_key_public_key",
]

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}
_B64URL = re.compile(r"^[A-Za-z0-9_-]*\Z")
_ED25519_PUB_MULTICODEC = b"\xed\x01"


class EncodingError(ValueError):
    pass


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    """Strict unpadded base64url: alphabet only, no padding, canonical trailing bits."""
    if not isinstance(text, str) or not _B64URL.match(text):
        raise EncodingError("not unpadded base64url")
    if len(text) % 4 == 1:
        raise EncodingError("invalid base64url length")
    data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64url_encode(data) != text:
        raise EncodingError("non-canonical base64url (non-zero trailing bits)")
    return data


def b58_encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = []
    while n:
        n, r = divmod(n, 58)
        out.append(_B58_ALPHABET[r])
    zeros = len(data) - len(data.lstrip(b"\x00"))
    return "1" * zeros + "".join(reversed(out))


def b58_decode(text: str) -> bytes:
    if not text:
        raise EncodingError("empty base58 string")
    n = 0
    for c in text:
        if c not in _B58_INDEX:
            raise EncodingError(f"invalid base58 character {c!r}")
        n = n * 58 + _B58_INDEX[c]
    zeros = len(text) - len(text.lstrip("1"))
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\x00" * zeros + body


def did_key_public_key(did: str) -> bytes:
    """Return the 32-byte Ed25519 public key of an Ed25519 ``did:key``.

    Requires multibase base58btc (``z``), the ``ed25519-pub`` multicodec (0xed 0x01)
    and exactly 32 key bytes; rejects non-canonical encodings.
    """
    if not isinstance(did, str) or not did.startswith("did:key:z"):
        raise EncodingError("not a base58btc did:key")
    msid = did[len("did:key:") :]
    raw = b58_decode(msid[1:])
    if "z" + b58_encode(raw) != msid:
        raise EncodingError("non-canonical base58btc")
    if not raw.startswith(_ED25519_PUB_MULTICODEC) or len(raw) != 34:
        raise EncodingError("did:key is not an Ed25519 public key")
    return raw[2:]


def did_key_from_public_key(public_key: bytes) -> str:
    if len(public_key) != 32:
        raise EncodingError("Ed25519 public keys are 32 bytes")
    return "did:key:z" + b58_encode(_ED25519_PUB_MULTICODEC + public_key)
