"""XRPL issued tokens in RRF v1 receipts (SPEC §7.3, "XRPL issued tokens"): currency identity and
the exact 10^-15-unit amount conversion. Float-free: decimal strings and Python integers only.

Mirrors ``@receptum/core`` (xrpl.ts); ``spec/vectors/xrpl-currency-v1.json`` and
``spec/vectors/xrpl-issued-amount-v1.json`` pin both implementations.
"""

from __future__ import annotations

import re
from typing import Any

from .binding import is_classic_address

__all__ = [
    "XRPL_ISSUED_SCALE",
    "XrplAmountRangeError",
    "XrplValueError",
    "amount_id",
    "asset_id",
    "canonical_currency",
    "currency_id",
    "parse_issued_asset",
    "units_to_value",
    "value_to_units",
]

# payment.amount of an issued token = its value as an integer number of 10^-15 units.
XRPL_ISSUED_SCALE = 15
# rippled: a normalized mantissa 10^15 <= m < 10^16, exponent in [-96, 80].
_MAX_DIGITS = 16
_MIN_EXPONENT = -96
_MAX_EXPONENT = 80

_VALUE = re.compile(r"^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\Z")
_UNITS = re.compile(r"^(0|[1-9][0-9]*)\Z")
# Characters XRPL allows in a 3-character (standard) currency code; case-sensitive.
_STANDARD_CODE = re.compile(r"^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}\Z")
# 160-bit standard layout: 12 zero bytes, the 3 code bytes, 5 zero bytes.
_STANDARD_LAYOUT = re.compile(r"^0{24}([0-9A-F]{6})0{10}\Z")
_HEX40 = re.compile(r"^[0-9A-Fa-f]{40}\Z")


class XrplValueError(ValueError):
    """Not an XRPL issued-value string at all (TypeError in the TypeScript reference)."""


class XrplAmountRangeError(ValueError):
    """A well-formed value with no exact 10^-15 integer / XRPL issued amount (RangeError in TS)."""


def _assert_on_ledger(digits: str, exponent: int, what: str) -> None:
    if len(digits) > _MAX_DIGITS:
        raise XrplAmountRangeError(
            f"{what} has {len(digits)} significant digits; XRPL issued amounts hold at most {_MAX_DIGITS}"
        )
    normalized = exponent - (_MAX_DIGITS - len(digits))
    if normalized < _MIN_EXPONENT or normalized > _MAX_EXPONENT:
        raise XrplAmountRangeError(f"{what} is outside the XRPL issued-amount range")


def value_to_units(value: Any) -> str:
    """XRPL issued value (``"0.25"``, ``"1e-2"``, ``"1.5E3"``) → ``payment.amount`` (integer
    10^-15 units), by the four rules of SPEC §7.3. XrplValueError when the string is not a
    value; XrplAmountRangeError when it is not an exact multiple of 10^-15, has more than 16
    significant digits, or is outside the ledger's range."""
    m = _VALUE.match(value) if isinstance(value, str) else None
    if not m:
        raise XrplValueError(f"not an XRPL issued value: {value!r}")
    frac = m.group(2) or ""
    exp_text = m.group(3) or "0"
    if len(exp_text.lstrip("+-").lstrip("0")) > 6:
        raise XrplAmountRangeError(f"{value} is outside the XRPL issued-amount range")
    digits = (m.group(1) + frac).lstrip("0")
    if not digits:
        return "0"
    exponent = int(exp_text) - len(frac)
    trimmed = digits.rstrip("0")
    exponent += len(digits) - len(trimmed)
    _assert_on_ledger(trimmed, exponent, value)
    shift = exponent + XRPL_ISSUED_SCALE
    if shift < 0:
        raise XrplAmountRangeError(f"{value} is not a whole number of 10^-{XRPL_ISSUED_SCALE} units")
    return trimmed + "0" * shift


def units_to_value(units: Any) -> str:
    """``payment.amount`` (integer 10^-15 units) → the plain decimal a seller writes on the
    ledger: no exponent, no trailing fractional zeros, ``"0"`` for zero."""
    if not isinstance(units, str) or not _UNITS.match(units):
        raise XrplValueError(f"amount must be an integer string: {units}")
    if units == "0":
        return "0"
    digits = units.rstrip("0")
    _assert_on_ledger(digits, len(units) - len(digits) - XRPL_ISSUED_SCALE, units)
    padded = units.rjust(XRPL_ISSUED_SCALE + 1, "0")
    whole, frac = padded[:-XRPL_ISSUED_SCALE], padded[-XRPL_ISSUED_SCALE:].rstrip("0")
    return f"{whole}.{frac}" if frac else whole


def currency_id(code: Any) -> str | None:
    """160-bit protocol identity (40 upper-case hex) of an on-ledger currency code, or None.

    A 3-character code (case-sensitive, never ``XRP``) is its bytes in the standard layout; a
    40-hex code is its own identity (hex case ignored). A 0x00-prefixed 40-hex code must be the
    standard layout of a valid standard code. Display symbols such as ``RLUSD`` are not on-ledger
    codes and are invalid."""
    if not isinstance(code, str):
        return None
    if _HEX40.match(code):
        ident = code.upper()
    elif _STANDARD_CODE.match(code):
        ident = "00" * 12 + code.encode("latin-1").hex().upper() + "00" * 5
    else:
        return None
    if ident.startswith("00"):
        m = _STANDARD_LAYOUT.match(ident)
        text = bytes.fromhex(m.group(1)).decode("latin-1") if m else ""
        if not m or not _STANDARD_CODE.match(text) or text == "XRP":
            return None
    return ident


def canonical_currency(code: Any) -> str | None:
    """The currency as rippled writes it: the 3-character code for the standard layout,
    otherwise the 40 upper-case hex."""
    ident = currency_id(code)
    if ident is None:
        return None
    std = _STANDARD_LAYOUT.match(ident)
    return bytes.fromhex(std.group(1)).decode("latin-1") if std else ident


def parse_issued_asset(asset: Any) -> tuple[str, str] | None:
    """``<currency>.<issuer>`` (split at the first ``.``) → (160-bit currency, issuer), or None."""
    if not isinstance(asset, str):
        return None
    code, dot, issuer = asset.partition(".")
    if not dot or not code or not is_classic_address(issuer):
        return None
    ident = currency_id(code)
    return (ident, issuer) if ident else None


def asset_id(asset: Any) -> tuple[str, str | None] | None:
    """Identity of ``payment.asset``: ("XRP", None), (160-bit currency, issuer), or None."""
    if asset == "XRP":
        return "XRP", None
    return parse_issued_asset(asset)


def amount_id(amount: Any) -> tuple[str, str | None] | None:
    """Identity of a ledger amount: ("XRP", None) for drops, or (160-bit currency, issuer)."""
    if isinstance(amount, str):
        return "XRP", None
    if isinstance(amount, dict):
        ident = currency_id(amount.get("currency"))
        issuer = amount.get("issuer")
        if ident is not None and isinstance(issuer, str):
            return ident, issuer
    return None
