"""Independent Python verifier for the Receptum Receipt Format (RRF) v1.

Implemented from docs/SPEC.md, spec/vectors/rrf-v1.json and
spec/vectors/account-binding-v1.json only.
"""

from .binding import check_payee_binding, verify_binding
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
    "check_payee_binding",
    "extract_signed_receipt",
    "loads_strict",
    "receipt_hash",
    "serialize_number",
    "validate_receipt",
    "verify",
    "verify_binding",
    "verify_signed_receipt",
]
