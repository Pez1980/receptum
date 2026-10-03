"""JSON Canonicalization Scheme (RFC 8785) and a strict I-JSON parser.

Implemented from RFC 8785 / RFC 7493 / ECMA-262 only. No third-party code.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

__all__ = [
    "JCSError",
    "canonicalize",
    "loads_strict",
    "serialize_number",
]

_MAX_SAFE_INTEGER = 2**53 - 1


class JCSError(ValueError):
    """Raised for inputs that cannot be canonicalized or are not I-JSON."""


# ---------------------------------------------------------------------------
# Strict parsing
# ---------------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise JCSError(f"non-JSON number literal {name!r}")


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise JCSError(f"duplicate object member {key!r}")
        out[key] = value
    return out


def _parse_float(text: str) -> float:
    value = float(text)
    if math.isinf(value):
        raise JCSError(f"number out of IEEE 754 double range: {text}")
    return value


def _parse_int(text: str) -> int | float:
    value = int(text)
    if abs(value) > _MAX_SAFE_INTEGER:
        # Keep JavaScript (IEEE 754 double) semantics for large integers.
        return _parse_float(text)
    return value


def _check_strings(value: Any) -> None:
    if isinstance(value, str):
        _check_string(value)
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_string(k)
            _check_strings(v)
    elif isinstance(value, list):
        for v in value:
            _check_strings(v)


_SURROGATE = re.compile("[\ud800-\udfff]")


def _check_string(s: str) -> None:
    if _SURROGATE.search(s):
        raise JCSError("string contains a lone surrogate (not valid Unicode)")


def loads_strict(data: bytes | str) -> Any:
    """Parse I-JSON (RFC 7493): UTF-8, no duplicate members, no lone surrogates,
    no NaN/Infinity, numbers representable as IEEE 754 doubles."""
    if isinstance(data, bytes):
        if data.startswith(b"\xef\xbb\xbf"):
            raise JCSError("byte order mark is not allowed")
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise JCSError(f"input is not valid UTF-8: {exc}") from None
    else:
        text = data
    try:
        value = json.loads(
            text,
            object_pairs_hook=_pairs_no_duplicates,
            parse_constant=_reject_constant,
            parse_float=_parse_float,
            parse_int=_parse_int,
        )
    except JCSError:
        raise
    except (ValueError, RecursionError) as exc:
        raise JCSError(f"invalid JSON: {exc}") from None
    _check_strings(value)
    return value


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def serialize_number(x: int | float) -> str:
    """ECMAScript Number::toString(x) for an IEEE 754 double (ECMA-262 §6.1.6.1.20)."""
    if isinstance(x, bool):
        raise JCSError("booleans are not numbers")
    if isinstance(x, int):
        if abs(x) <= _MAX_SAFE_INTEGER:
            return str(x)
        try:
            x = float(x)
        except OverflowError:
            raise JCSError("integer out of IEEE 754 double range") from None
    if not isinstance(x, float):
        raise JCSError(f"unsupported number type {type(x).__name__}")
    if math.isnan(x) or math.isinf(x):
        raise JCSError("NaN and Infinity cannot be canonicalized")
    if x == 0:
        return "0"  # also -0
    sign = "-" if x < 0 else ""
    # repr() yields the shortest round-tripping decimal, closest to the exact value
    # (the same digit string ECMAScript selects).
    r = repr(abs(x))
    mant, _, exp = r.partition("e")
    e = int(exp) if exp else 0
    int_part, _, frac_part = mant.partition(".")
    all_digits = int_part + frac_part
    stripped = all_digits.lstrip("0")
    leading = len(all_digits) - len(stripped)
    # value = 0.<digits> * 10**n
    n = len(int_part) + e - leading
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        exp_val = n - 1
        exp_str = ("+" if exp_val >= 0 else "-") + str(abs(exp_val))
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + exp_str
    return sign + out


_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _serialize_string(s: str) -> str:
    _check_string(s)
    out = ['"']
    for ch in s:
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(s: str) -> bytes:
    # Big-endian UTF-16 bytes compare exactly like sequences of UTF-16 code units.
    return s.encode("utf-16-be")


def _serialize(value: Any, out: list[str], depth: int) -> None:
    if depth > 1000:
        raise JCSError("nesting too deep")
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, (int, float)):
        out.append(serialize_number(value))
    elif isinstance(value, str):
        out.append(_serialize_string(value))
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _serialize(item, out, depth + 1)
        out.append("]")
    elif isinstance(value, dict):
        for k in value:
            if not isinstance(k, str):
                raise JCSError("object member names must be strings")
            _check_string(k)
        out.append("{")
        for i, k in enumerate(sorted(value, key=_utf16_key)):
            if i:
                out.append(",")
            out.append(_serialize_string(k))
            out.append(":")
            _serialize(value[k], out, depth + 1)
        out.append("}")
    else:
        raise JCSError(f"unsupported type {type(value).__name__}")


def canonicalize(value: Any) -> bytes:
    """Return the RFC 8785 canonical form of ``value`` as UTF-8 bytes."""
    out: list[str] = []
    _serialize(value, out, 0)
    return "".join(out).encode("utf-8")
