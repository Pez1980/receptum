"""Independent Python verifier for the Receptum Receipt Format (RRF) v1.

Implemented from docs/SPEC.md and spec/vectors/rrf-v1.json only.
"""

from .jcs import JCSError, canonicalize, loads_strict, serialize_number
from .jws import SignatureResult, verify_signed_receipt
from .receipt import receipt_hash, validate_receipt
from .verify import (
    NOT_VERIFIED,
    PARTIALLY_VERIFIED,
    VERIFIED,
    Report,
    extract_signed_receipt,
    verify,
)

__version__ = "0.1.0"

__all__ = [
    "NOT_VERIFIED",
    "PARTIALLY_VERIFIED",
    "VERIFIED",
    "JCSError",
    "Report",
    "SignatureResult",
    "canonicalize",
    "extract_signed_receipt",
    "loads_strict",
    "receipt_hash",
    "serialize_number",
    "validate_receipt",
    "verify",
    "verify_signed_receipt",
]
