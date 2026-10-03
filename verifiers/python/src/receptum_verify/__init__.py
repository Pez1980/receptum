"""Independent Python verifier for the Receptum Receipt Format (RRF) v1.

Implemented from docs/SPEC.md, spec/vectors/rrf-v1.json and
spec/vectors/account-binding-v1.json; rail encodings the SPEC leaves to the reference adapters
(escrow storage, claimable-balance predicates, delivery memos) are re-implemented by hand and
pinned to the published artifacts by tests.
"""

from .binding import check_payee_binding, verify_binding
from .jcs import JCSError, canonicalize, loads_strict, serialize_number
from .jws import SignatureResult, verify_signed_receipt
from .networks import TRUSTED_ESCROWS, network_class, network_label
from .receipt import receipt_hash, validate_receipt
from .verify import (
    COMMITTING_RAILS,
    NOT_VERIFIED,
    PARTIALLY_VERIFIED,
    VERIFIED,
    InputError,
    Report,
    extract_signed_receipt,
    verdict_of,
    verify,
)

__version__ = "0.2.0"

__all__ = [
    "COMMITTING_RAILS",
    "TRUSTED_ESCROWS",
    "network_class",
    "network_label",
    "InputError",
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
    "verdict_of",
    "verify",
    "verify_binding",
    "verify_signed_receipt",
]
