import copy
import json

import pytest

from receptum_verify import verify_signed_receipt
from receptum_verify.encoding import b64url_decode, b64url_encode


def _parts(signed):
    return signed["proof"]["jws"].split(".")


def _with_header(signed, header_bytes):
    _, _, sig = _parts(signed)
    s = copy.deepcopy(signed)
    s["proof"]["jws"] = b64url_encode(header_bytes) + ".." + sig
    return s


def test_vector_ok(signed_vector):
    assert verify_signed_receipt(signed_vector).ok


def test_tampered_receipt_fails(signed_vector):
    signed_vector["receipt"]["payment"]["amount"] = "1"
    res = verify_signed_receipt(signed_vector)
    assert not res.hash_ok and not res.signature_ok


def test_tampered_receipt_with_updated_hash_fails_signature(signed_vector):
    from receptum_verify import receipt_hash

    signed_vector["receipt"]["payment"]["amount"] = "1"
    signed_vector["receiptHash"] = receipt_hash(signed_vector["receipt"])
    res = verify_signed_receipt(signed_vector)
    assert res.hash_ok and not res.signature_ok


def test_uppercase_receipt_hash_rejected(signed_vector):
    signed_vector["receiptHash"] = signed_vector["receiptHash"].upper()
    assert not verify_signed_receipt(signed_vector).ok


def test_extra_signed_member_rejected(signed_vector):
    signed_vector["note"] = "x"
    assert not verify_signed_receipt(signed_vector).ok


def test_extra_proof_member_rejected(signed_vector):
    signed_vector["proof"]["created"] = "2026-10-04T12:00:00Z"
    assert not verify_signed_receipt(signed_vector).ok


def test_wrong_proof_type(signed_vector):
    signed_vector["proof"]["type"] = "eip712"
    assert not verify_signed_receipt(signed_vector).ok


@pytest.mark.parametrize("kid_suffix", ["#key-1", "", "#z6Mkother"])
def test_kid_must_be_did_hash_multibase(signed_vector, kid_suffix):
    did = signed_vector["receipt"]["seller"]["id"]
    signed_vector["proof"]["kid"] = did + kid_suffix
    assert not verify_signed_receipt(signed_vector).ok


def test_two_or_four_segments(signed_vector):
    h, _, s = _parts(signed_vector)
    for jws in (f"{h}.{s}", f"{h}...{s}", f"{h}.."):
        sv = copy.deepcopy(signed_vector)
        sv["proof"]["jws"] = jws
        assert not verify_signed_receipt(sv).ok


def test_attached_payload_rejected(signed_vector):
    from receptum_verify import canonicalize

    h, _, s = _parts(signed_vector)
    signed_vector["proof"]["jws"] = f"{h}.{b64url_encode(canonicalize(signed_vector['receipt']))}.{s}"
    assert not verify_signed_receipt(signed_vector).ok


def test_padded_or_noncanonical_signature_rejected(signed_vector):
    h, _, s = _parts(signed_vector)
    sv = copy.deepcopy(signed_vector)
    sv["proof"]["jws"] = f"{h}..{s}=="
    assert not verify_signed_receipt(sv).ok
    # 64 bytes -> 86 chars; last char carries 2 unused bits. Flip one of them.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    last = alphabet.index(s[-1])
    sv = copy.deepcopy(signed_vector)
    sv["proof"]["jws"] = f"{h}..{s[:-1]}{alphabet[last | 1]}"
    assert alphabet[last | 1] != s[-1]
    assert not verify_signed_receipt(sv).ok


def test_short_signature_rejected(signed_vector):
    h, _, s = _parts(signed_vector)
    signed_vector["proof"]["jws"] = f"{h}..{b64url_encode(b64url_decode(s)[:63])}"
    assert not verify_signed_receipt(signed_vector).ok


def test_s_not_reduced_rejected(signed_vector):
    # S + L is a different 32-byte encoding of the same scalar; must be rejected.
    L = 2**252 + 27742317777372353535851770400913936493
    h, _, s = _parts(signed_vector)
    sig = b64url_decode(s)
    big_s = int.from_bytes(sig[32:], "little") + L
    assert big_s < 2**256
    forged = sig[:32] + big_s.to_bytes(32, "little")
    signed_vector["proof"]["jws"] = f"{h}..{b64url_encode(forged)}"
    res = verify_signed_receipt(signed_vector)
    assert not res.ok and any("S >= L" in e for e in res.errors)


@pytest.mark.parametrize(
    "header",
    [
        {"alg": "EdDSA", "typ": "receptum+jws"},
        {"alg": "EdDSA", "kid": None, "typ": "receptum+jws", "crit": ["b64"]},
        {"alg": "ES256", "kid": None, "typ": "receptum+jws"},
        {"alg": "none", "kid": None, "typ": "receptum+jws"},
        {"alg": "EdDSA", "kid": None, "typ": "JWT"},
        {"alg": "EdDSA", "kid": "did:key:other#other", "typ": "receptum+jws"},
    ],
)
def test_header_strictness(signed_vector, header):
    if "kid" in header and header["kid"] is None:
        header["kid"] = signed_vector["proof"]["kid"]
    sv = _with_header(signed_vector, json.dumps(header).encode())
    assert not verify_signed_receipt(sv).ok


def test_header_with_duplicate_member_rejected(signed_vector):
    kid = signed_vector["proof"]["kid"]
    raw = f'{{"alg":"EdDSA","alg":"EdDSA","kid":"{kid}","typ":"receptum+jws"}}'.encode()
    assert not verify_signed_receipt(_with_header(signed_vector, raw)).ok


def test_caip10_seller_cannot_have_jws(signed_vector):
    signed_vector["receipt"]["seller"]["id"] = "eip155:84532:0x" + "11" * 20
    assert not verify_signed_receipt(signed_vector).ok


def test_not_an_object():
    assert not verify_signed_receipt("x").ok
    assert not verify_signed_receipt({"receiptHash": "a" * 64}).ok
