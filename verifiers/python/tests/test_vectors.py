"""Reproduce every vector in spec/vectors/rrf-v1.json byte for byte."""

import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from receptum_verify import canonicalize, receipt_hash, validate_receipt, verify_signed_receipt
from receptum_verify.encoding import b64url_encode, did_key_from_public_key

from conftest import VECTORS, load_json

VECTOR_LIST = load_json(VECTORS)["vectors"]
IDS = [v["name"] for v in VECTOR_LIST]


def _key(vectors):
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(vectors["testSeedHex"]))


def test_seller_did_from_rfc8032_seed(vectors):
    pub = _key(vectors).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    # RFC 8032 §7.1 TEST 1 public key.
    assert pub.hex() == "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    assert did_key_from_public_key(pub) == vectors["sellerDid"]


@pytest.mark.parametrize("vector", VECTOR_LIST, ids=IDS)
def test_jcs_bytes(vector):
    assert canonicalize(vector["receipt"]) == vector["jcs"].encode("utf-8")


@pytest.mark.parametrize("vector", VECTOR_LIST, ids=IDS)
def test_receipt_hash(vector):
    assert receipt_hash(vector["receipt"]) == vector["receiptHash"]


@pytest.mark.parametrize("vector", VECTOR_LIST, ids=IDS)
def test_receipt_is_valid(vector):
    assert validate_receipt(vector["receipt"]) == []


@pytest.mark.parametrize("vector", VECTOR_LIST, ids=IDS)
def test_proof_reproduced_byte_for_byte(vector, vectors):
    did = vectors["sellerDid"]
    kid = did + "#" + did[len("did:key:") :]
    assert vector["proof"]["kid"] == kid
    assert vector["proof"]["type"] == "jws"
    header = json.dumps(
        {"alg": "EdDSA", "kid": kid, "typ": "receptum+jws"}, separators=(",", ":")
    ).encode()
    header_b64 = b64url_encode(header)
    payload_b64 = b64url_encode(canonicalize(vector["receipt"]))
    sig = _key(vectors).sign(f"{header_b64}.{payload_b64}".encode())
    assert f"{header_b64}..{b64url_encode(sig)}" == vector["proof"]["jws"]


@pytest.mark.parametrize("vector", VECTOR_LIST, ids=IDS)
def test_vector_verifies(vector):
    res = verify_signed_receipt(
        {"receipt": vector["receipt"], "receiptHash": vector["receiptHash"], "proof": vector["proof"]}
    )
    assert res.ok, res.errors
    assert res.receipt_hash == vector["receiptHash"]
