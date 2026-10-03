"""Signed-receipt checks: receiptHash recomputation and detached JWS (SPEC §4)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .encoding import EncodingError, b64url_decode, b64url_encode, did_key_public_key
from .jcs import JCSError, canonicalize, loads_strict
from .receipt import HEX64, receipt_hash, validate_receipt

__all__ = ["JWS_TYP", "SignatureResult", "verify_detached_jws", "verify_signed_receipt"]

JWS_TYP = "receptum+jws"
_SIGNED_MEMBERS = {"receipt", "receiptHash", "proof"}
# `bindings` (SPEC §4.1) is optional and outside the signed receipt; it is
# checked at level 2.5 (binding.py), not here.
_OPTIONAL_MEMBERS = {"bindings"}
_PROOF_MEMBERS = {"type", "kid", "jws"}
_HEADER_MEMBERS = {"alg", "kid", "typ"}
# Order of the Ed25519 base point (RFC 8032 §5.1): S MUST be < L.
_L = 2**252 + 27742317777372353535851770400913936493


@dataclass
class SignatureResult:
    schema_ok: bool = False
    hash_ok: bool = False
    signature_ok: bool = False
    receipt_hash: str | None = None
    seller: str | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.schema_ok and self.hash_ok and self.signature_ok


def verify_signed_receipt(signed: Any) -> SignatureResult:
    res = SignatureResult()
    err = res.errors
    if not isinstance(signed, dict):
        err.append("signed receipt must be an object")
        return res
    extra = set(signed) - _SIGNED_MEMBERS - _OPTIONAL_MEMBERS
    missing = _SIGNED_MEMBERS - set(signed)
    if extra:
        err.append(f"signed receipt has unknown members: {sorted(extra)}")
    # bindings: optional; null and [] count as absent; otherwise an array (SPEC §4).
    bindings_ok = signed.get("bindings") is None or isinstance(signed.get("bindings"), list)
    if not bindings_ok:
        err.append("bindings must be an array")
    if missing:
        err.append(f"signed receipt is missing members: {sorted(missing)}")
        if "receipt" not in signed:
            return res

    receipt = signed["receipt"]
    schema_errors = validate_receipt(receipt)
    err.extend(schema_errors)
    res.schema_ok = not schema_errors and not extra and not missing and bindings_ok
    if schema_errors:
        return res
    res.seller = receipt["seller"]["id"]

    try:
        payload_bytes = canonicalize(receipt)
    except JCSError as exc:
        err.append(f"receipt cannot be canonicalized: {exc}")
        res.schema_ok = False
        return res
    computed = receipt_hash(receipt)
    res.receipt_hash = computed
    stated = signed.get("receiptHash")
    if not (isinstance(stated, str) and HEX64.match(stated)):
        err.append("receiptHash must be 64 lower-case hex characters")
    elif stated != computed:
        err.append(f"receiptHash mismatch: stated {stated}, computed {computed}")
    else:
        res.hash_ok = True

    res.signature_ok = _verify_proof(signed.get("proof"), receipt, payload_bytes, err)
    return res


def _verify_proof(proof: Any, receipt: dict, payload: bytes, err: list[str]) -> bool:
    return verify_detached_jws(
        proof, receipt["seller"]["id"], payload, JWS_TYP, err, path="proof", signer="seller.id"
    )


def verify_detached_jws(
    proof: Any,
    did: str,
    payload: bytes,
    typ: str,
    err: list[str],
    *,
    path: str,
    signer: str,
) -> bool:
    """Verify ``{type:"jws", kid, jws}``: a detached compact EdDSA JWS over
    base64url(payload) with header exactly {alg:"EdDSA", kid, typ}, where kid is
    ``did#<multibase>`` of the Ed25519 ``did``. Appends reasons to ``err``."""
    if not isinstance(proof, dict):
        err.append(f"{path} must be an object")
        return False
    if set(proof) != _PROOF_MEMBERS:
        err.append(f"{path} members must be exactly {sorted(_PROOF_MEMBERS)}")
        return False
    if proof["type"] != "jws":
        err.append(f'{path}.type must be "jws"')
        return False

    try:
        public_key = did_key_public_key(did)
    except EncodingError:
        err.append(f"{signer} is not an Ed25519 did:key; a JWS proof cannot verify against it")
        return False
    expected_kid = did + "#" + did[len("did:key:") :]
    kid = proof["kid"]
    if kid != expected_kid:
        err.append(f"{path}.kid must be {expected_kid}")
        return False

    jws = proof["jws"]
    if not isinstance(jws, str):
        err.append(f"{path}.jws must be a string")
        return False
    parts = jws.split(".")
    if len(parts) != 3:
        err.append(f"{path}.jws must have exactly 3 segments")
        return False
    header_b64, body_b64, sig_b64 = parts
    if body_b64 != "":
        err.append(f"{path}.jws payload must be detached (empty middle segment)")
        return False
    try:
        header = loads_strict(b64url_decode(header_b64))
        signature = b64url_decode(sig_b64)
    except (EncodingError, JCSError) as exc:
        err.append(f"{path}.jws is malformed: {exc}")
        return False
    if not isinstance(header, dict) or set(header) != _HEADER_MEMBERS:
        err.append(f"JWS header members must be exactly {sorted(_HEADER_MEMBERS)}")
        return False
    if header["alg"] != "EdDSA":
        err.append('JWS header alg must be "EdDSA"')
        return False
    if header["typ"] != typ:
        err.append(f'JWS header typ must be "{typ}"')
        return False
    if header["kid"] != kid:
        err.append(f"JWS header kid does not match {path}.kid")
        return False
    if len(signature) != 64:
        err.append("Ed25519 signature must be 64 bytes")
        return False
    if int.from_bytes(signature[32:], "little") >= _L:
        err.append("non-canonical Ed25519 signature (S >= L)")
        return False

    signing_input = (header_b64 + "." + b64url_encode(payload)).encode("ascii")
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, signing_input)
    except (InvalidSignature, ValueError):
        err.append(f"signature does not verify against {signer}")
        return False
    return True
