"""Account bindings (SPEC §4.1): spec/vectors/account-binding-v1.json, reproduced
byte for byte from the public test keys, plus negative cases."""

import base64
import copy
import hashlib
import json
import os

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.utils import (
    Prehashed,
    decode_dss_signature,
    encode_dss_signature,
)

from receptum_verify import secp256k1, verify
from receptum_verify.binding import (
    BINDING_JWS_TYP,
    XrplKeys,
    check_payee_binding,
    evm_recover_address,
    fetch_xrpl_keys,
    parse_timestamp,
    stellar_public_key,
    validate_statement,
    verify_binding,
    xrpl_address,
)
from receptum_verify.encoding import b64url_encode, did_key_from_public_key
from receptum_verify.hashes import keccak256, ripemd160
from receptum_verify.jcs import canonicalize

from conftest import EXAMPLES, REPO, load_json

VECTORS = load_json(REPO / "spec" / "vectors" / "account-binding-v1.json")
SEED = bytes.fromhex(VECTORS["testSeedHex"])
DID_KEY = Ed25519PrivateKey.from_private_bytes(SEED)
DID = VECTORS["sellerDid"]
NOW = parse_timestamp("2026-10-02T00:00:00Z")
BY_NS = {v["binding"]["statement"]["account"].split(":")[0]: v for v in VECTORS["vectors"]}


# --- test-only signers (public test keys from the vector file) --------------


def sign_did(statement: dict) -> dict:
    kid = DID + "#" + DID[len("did:key:") :]
    header = b64url_encode(
        json.dumps({"alg": "EdDSA", "kid": kid, "typ": BINDING_JWS_TYP}, separators=(",", ":")).encode()
    )
    sig = DID_KEY.sign((header + "." + b64url_encode(canonicalize(statement))).encode())
    return {"type": "jws", "kid": kid, "jws": f"{header}..{b64url_encode(sig)}"}


def _ecdsa_low_s(priv: int, digest: bytes) -> tuple[int, int]:
    key = ec.derive_private_key(priv, ec.SECP256K1())
    der = key.sign(digest, ec.ECDSA(Prehashed(hashes.SHA256()), deterministic_signing=True))
    r, s = decode_dss_signature(der)
    return r, min(s, secp256k1.N - s)


def sign_eip191(priv: int, m: bytes) -> str:
    digest = keccak256(b"\x19Ethereum Signed Message:\n" + str(len(m)).encode() + m)
    r, s = _ecdsa_low_s(priv, digest)
    pub = ec.derive_private_key(priv, ec.SECP256K1()).public_key().public_numbers()
    for recid in (0, 1):
        if secp256k1.recover(digest, r, s, recid) == (pub.x, pub.y):
            break
    return "0x" + r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex() + bytes([27 + recid]).hex()


def _xrpl_scalar(data: bytes, discrim: int | None = None) -> int:
    for i in range(2**32):
        extra = (discrim.to_bytes(4, "big") if discrim is not None else b"") + i.to_bytes(4, "big")
        k = int.from_bytes(hashlib.sha512(data + extra).digest()[:32], "big")
        if 0 < k < secp256k1.N:
            return k
    raise AssertionError("unreachable")


def _compressed(priv: int) -> bytes:
    n = ec.derive_private_key(priv, ec.SECP256K1()).public_key().public_numbers()
    return bytes([2 + (n.y & 1)]) + n.x.to_bytes(32, "big")


def xrpl_secp256k1_from_passphrase(passphrase: str) -> int:
    """ripple-keypairs secp256k1 account key 0 of a passphrase seed."""
    entropy = hashlib.sha512(passphrase.encode()).digest()[:16]
    root = _xrpl_scalar(entropy)
    return (_xrpl_scalar(_compressed(root), 0) + root) % secp256k1.N


def sign_xrpl_secp256k1(priv: int, m: bytes) -> str:
    r, s = _ecdsa_low_s(priv, hashlib.sha512(m).digest()[:32])
    return encode_dss_signature(r, s).hex().upper()


def sign_sep53(seed: bytes, m: bytes) -> str:
    sig = Ed25519PrivateKey.from_private_bytes(seed).sign(
        hashlib.sha256(b"Stellar Signed Message:\n" + m).digest()
    )
    return base64.b64encode(sig).decode()


# --- primitives ---------------------------------------------------------------


def test_keccak256_is_not_sha3():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"").hex() != hashlib.sha3_256(b"").hexdigest()
    # Multi-block input (rate is 136 bytes).
    assert keccak256(b"a" * 300).hex() == (
        "5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826"
    )


@pytest.mark.parametrize(
    "msg,digest",
    [
        (b"", "9c1185a5c5e9fc54612808977ee8f548b2258d31"),
        (b"abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"),
        (b"message digest", "5d0689ef49d2fae572b881b123a85ffa21595f36"),
        (b"1234567890" * 8, "9b752e45573d4b39f4dbd3323cab82bf63326bfb"),
    ],
)
def test_ripemd160(msg, digest):
    assert ripemd160(msg).hex() == digest


def test_anvil_and_genesis_addresses():
    anvil = int(BY_NS["eip155"]["chainKey"]["value"], 16)
    sig = sign_eip191(anvil, b"hello")
    assert evm_recover_address(b"hello", sig) == "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    priv = xrpl_secp256k1_from_passphrase("masterpassphrase")
    assert xrpl_address(_compressed(priv)) == "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"


# --- vectors ----------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_vector_jcs_and_verifies(vector):
    binding = vector["binding"]
    assert canonicalize(binding["statement"]).decode() == vector["jcs"]
    res = verify_binding(binding)
    assert res.ok, res.errors


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_vector_reproduced_byte_for_byte(vector):
    binding = vector["binding"]
    st = binding["statement"]
    m = canonicalize(st)
    assert did_key_from_public_key(DID_KEY.public_key().public_bytes_raw()) == DID == st["did"]
    assert sign_did(st) == binding["didProof"]
    ns = st["account"].split(":")[0]
    key = vector["chainKey"]["value"]
    proof = binding["accountProof"]
    if ns == "eip155":
        assert sign_eip191(int(key, 16), m) == proof["signature"]
    elif ns == "xrpl":
        priv = xrpl_secp256k1_from_passphrase(key)
        assert _compressed(priv).hex().upper() == proof["publicKey"]
        assert sign_xrpl_secp256k1(priv, m) == proof["signature"]
    else:
        seed = bytes.fromhex(key)
        pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()
        assert stellar_public_key(st["account"].split(":")[2]) == pub
        assert sign_sep53(seed, m) == proof["signature"]


@pytest.mark.parametrize("vector", VECTORS["invalid"], ids=lambda v: v["name"])
def test_invalid_vectors_fail(vector):
    res = verify_binding(vector["binding"])
    assert not res.ok
    # The did signature is valid; it is the account signature that must fail.
    assert any("accountProof" in e for e in res.errors), res.errors


@pytest.mark.parametrize("name", ["evm-arc-testnet", "evm-base-sepolia", "stellar-testnet", "xrpl-testnet"])
def test_example_bindings_verify(name):
    # xrpl-testnet uses an Ed25519 XRPL key.
    res = verify_binding(load_json(EXAMPLES / "bindings" / f"{name}.json"))
    assert res.ok, res.errors


# --- negatives on single bindings --------------------------------------------


def _vec(ns):
    return copy.deepcopy(BY_NS[ns]["binding"])


@pytest.mark.parametrize("ns", ["eip155", "xrpl", "stellar"])
def test_tampered_statement_fails(ns):
    b = _vec(ns)
    b["statement"]["issuedAt"] = "2026-10-01T00:00:00.001Z"
    res = verify_binding(b)
    assert not res.ok and any("statement.did" in e for e in res.errors)


@pytest.mark.parametrize("ns", ["eip155", "xrpl", "stellar"])
def test_account_signature_over_tampered_statement_fails(ns):
    # Re-sign the did part so only the account proof is stale.
    b = _vec(ns)
    b["statement"]["expiresAt"] = "2028-10-01T00:00:00.000Z"
    b["didProof"] = sign_did(b["statement"])
    res = verify_binding(b)
    assert not res.ok and any("accountProof" in e for e in res.errors), res.errors


def test_high_s_eip191_rejected():
    b = _vec("eip155")
    sig = bytes.fromhex(b["accountProof"]["signature"][2:])
    s = int.from_bytes(sig[32:64], "big")
    flipped = sig[:32] + (secp256k1.N - s).to_bytes(32, "big") + bytes([55 - sig[64]])
    b["accountProof"]["signature"] = "0x" + flipped.hex()
    # The flipped signature is mathematically valid for the same key...
    m = canonicalize(b["statement"])
    digest = keccak256(b"\x19Ethereum Signed Message:\n" + str(len(m)).encode() + m)
    assert secp256k1.recover(digest, int.from_bytes(sig[:32], "big"), secp256k1.N - s, flipped[64] - 27)
    # ...but not low-s.
    res = verify_binding(b)
    assert not res.ok and any("low-s" in e for e in res.errors)


def test_high_s_xrpl_rejected():
    b = _vec("xrpl")
    r, s = decode_dss_signature(bytes.fromhex(b["accountProof"]["signature"]))
    b["accountProof"]["signature"] = encode_dss_signature(r, secp256k1.N - s).hex().upper()
    res = verify_binding(b)
    assert not res.ok and any("low-s" in e for e in res.errors)


@pytest.mark.parametrize(
    "sig",
    [
        lambda s: s.upper().replace("0X", "0x"),  # upper-case hex
        lambda s: s[:-2] + "00",  # v = 0
        lambda s: s[:-2] + "01",  # v = 1
        lambda s: s[:-2],  # 64 bytes
    ],
)
def test_eip191_signature_encoding(sig):
    b = _vec("eip155")
    b["accountProof"]["signature"] = sig(b["accountProof"]["signature"])
    assert not verify_binding(b).ok


def test_xrpl_lower_case_hex_and_non_master_key():
    b = _vec("xrpl")
    b["accountProof"]["signature"] = b["accountProof"]["signature"].lower()
    assert not verify_binding(b).ok
    # A valid signature by a key that is not the account's master key.
    b = _vec("xrpl")
    other = 12345
    m = canonicalize(b["statement"])
    b["accountProof"] = {
        "type": "xrpl",
        "publicKey": _compressed(other).hex().upper(),
        "signature": sign_xrpl_secp256k1(other, m),
    }
    res = verify_binding(b)
    assert not res.ok and res.key_only
    # Online, the same key passes if it is the account's current RegularKey.
    keys = XrplKeys(master_disabled=False, regular_key=xrpl_address(_compressed(other)))
    assert verify_binding(b, xrpl_keys=keys).ok


def test_xrpl_online_disabled_master_fails():
    b = _vec("xrpl")
    assert verify_binding(b, xrpl_keys=XrplKeys(master_disabled=False, regular_key=None)).ok
    res = verify_binding(b, xrpl_keys=XrplKeys(master_disabled=True, regular_key=None))
    assert not res.ok and any("disabled" in e for e in res.errors)


def test_xrpl_non_canonical_der_rejected():
    b = _vec("xrpl")
    der = bytes.fromhex(b["accountProof"]["signature"])
    # Pad r with a superfluous leading zero.
    r_len = der[3]
    padded = b"\x30" + bytes([der[1] + 1]) + b"\x02" + bytes([r_len + 1]) + b"\x00" + der[4:]
    b["accountProof"]["signature"] = padded.hex().upper()
    res = verify_binding(b)
    assert not res.ok and any("DER" in e for e in res.errors)


def test_stellar_signature_must_be_padded_base64():
    b = _vec("stellar")
    b["accountProof"]["signature"] = b["accountProof"]["signature"].rstrip("=")
    assert not verify_binding(b).ok
    b = _vec("stellar")
    b["statement"]["account"] = b["statement"]["account"][:-1] + "A"  # checksum
    b["didProof"] = sign_did(b["statement"])
    res = verify_binding(b)
    assert not res.ok and any("checksum" in e or "base32" in e for e in res.errors)


def test_wrong_did_in_did_proof():
    other = Ed25519PrivateKey.from_private_bytes(b"\x01" * 32)
    other_did = did_key_from_public_key(other.public_key().public_bytes_raw())
    b = _vec("eip155")
    b["statement"]["did"] = other_did  # did proof (kid) still names the vector DID
    res = verify_binding(b)
    assert not res.ok and any("didProof.kid" in e for e in res.errors)


def test_wrong_jws_typ_rejected():
    b = _vec("eip155")
    st = b["statement"]
    kid = DID + "#" + DID[len("did:key:") :]
    header = b64url_encode(
        json.dumps({"alg": "EdDSA", "kid": kid, "typ": "receptum+jws"}, separators=(",", ":")).encode()
    )
    sig = DID_KEY.sign((header + "." + b64url_encode(canonicalize(st))).encode())
    b["didProof"]["jws"] = f"{header}..{b64url_encode(sig)}"
    res = verify_binding(b)
    assert not res.ok and any("typ" in e for e in res.errors)


@pytest.mark.parametrize(
    "mutate,needle",
    [
        (lambda st: st.update(extra="x"), "not allowed"),
        (lambda st: st.pop("issuedAt"), "issuedAt is required"),
        (lambda st: st.update(type="receptum/account-binding/2"), "type"),
        (lambda st: st.update(expiresAt=None), "must be a string"),
        (lambda st: st.update(expiresAt="2026-10-01T00:00:00.000Z"), "after issuedAt"),
        (lambda st: st.update(issuedAt="2026-10-01T00:00:00+00:00"), "UTC timestamp"),
        (lambda st: st.update(did="did:web:example.com"), "Ed25519 did:key"),
        (lambda st: st.update(account="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), "CAIP-10"),
    ],
)
def test_statement_validation(mutate, needle):
    st = copy.deepcopy(BY_NS["eip155"]["binding"]["statement"])
    mutate(st)
    errors = validate_statement(st)
    assert any(needle in e for e in errors), errors


def test_binding_members_exact_and_namespace_fail_closed():
    b = _vec("eip155")
    b["extra"] = 1
    assert not verify_binding(b).ok
    b = _vec("eip155")
    b["statement"]["account"] = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:abc"
    b["didProof"] = sign_did(b["statement"])
    res = verify_binding(b)
    assert not res.ok and any("not supported" in e for e in res.errors)
    b = _vec("eip155")
    b["accountProof"]["type"] = "xrpl"
    assert not verify_binding(b).ok


# --- coverage (level 2.5 on a receipt) ----------------------------------------


def _signed(ns, **receipt_overrides):
    b = _vec(ns)
    receipt = {
        "seller": {"id": DID},
        "payment": {"payee": b["statement"]["account"]},
        "deliveredAt": "2026-10-01T12:00:00Z",
    }
    receipt.update(receipt_overrides)
    return {"receipt": receipt, "bindings": [b]}


@pytest.mark.parametrize("ns", ["eip155", "xrpl", "stellar"])
def test_covers(ns):
    res = check_payee_binding(_signed(ns), now=NOW)
    assert res.status == "pass", res.detail


def test_evm_payee_compared_case_insensitively_but_chain_exactly():
    s = _signed("eip155")
    s["receipt"]["payment"]["payee"] = s["receipt"]["payment"]["payee"].lower()
    assert check_payee_binding(s, now=NOW).status == "pass"
    s["receipt"]["payment"]["payee"] = "eip155:8453:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    assert check_payee_binding(s, now=NOW).status == "fail"


def test_xrpl_payee_compared_exactly():
    s = _signed("xrpl")
    s["receipt"]["payment"]["payee"] = "xrpl:0:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
    assert check_payee_binding(s, now=NOW).status == "fail"


def test_wrong_account_fails():
    s = _signed("eip155")
    s["receipt"]["payment"]["payee"] = "eip155:84532:0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    res = check_payee_binding(s, now=NOW)
    assert res.status == "fail" and "not payment.payee" in res.detail


def test_wrong_seller_fails():
    other = did_key_from_public_key(b"\x02" * 32)
    res = check_payee_binding(_signed("eip155", seller={"id": other}), now=NOW)
    assert res.status == "fail" and "seller.id" in res.detail


def test_expired_at_delivery_fails():
    # Delivered exactly at expiresAt is not covered.
    res = check_payee_binding(_signed("stellar", deliveredAt="2027-10-01T00:00:00Z"), now=NOW)
    assert res.status == "fail" and "expired" in res.detail
    ok = check_payee_binding(_signed("stellar", deliveredAt="2027-09-30T23:59:59.999999Z"), now=NOW)
    assert ok.status == "pass"


def test_issued_at_may_follow_delivery_but_not_the_future():
    s = _signed("eip155", deliveredAt="2026-01-01T00:00:00Z")
    assert check_payee_binding(s, now=NOW).status == "pass"
    issued = parse_timestamp("2026-10-01T00:00:00.000Z")
    assert check_payee_binding(s, now=issued - 300).status == "pass"
    res = check_payee_binding(s, now=issued - 301)
    assert res.status == "fail" and "future" in res.detail


def test_no_payee_no_binding_and_allow_unbound():
    s = _signed("eip155")
    s["receipt"]["payment"] = {}
    assert check_payee_binding(s, now=NOW).status == "skipped"
    s = _signed("eip155")
    del s["bindings"]
    assert check_payee_binding(s, now=NOW).status == "pending"
    assert check_payee_binding({**s, "bindings": []}, now=NOW).status == "pending"
    assert check_payee_binding(s, now=NOW, allow_unbound=True).status == "skipped"
    # Invalid bindings still fail with --allow-unbound.
    bad = _signed("eip155")
    bad["bindings"] = VECTORS["invalid"][0]["binding"]
    assert check_payee_binding(bad, now=NOW, allow_unbound=True).status == "fail"


def test_one_covering_binding_among_others_passes():
    s = _signed("eip155")
    s["bindings"] = [VECTORS["invalid"][0]["binding"], _vec("stellar"), *s["bindings"]]
    assert check_payee_binding(s, now=NOW).status == "pass"


def test_only_the_first_16_bindings_are_examined():
    s = _signed("eip155")
    s["bindings"] = [_vec("stellar")] * 16 + s["bindings"]
    assert check_payee_binding(s, now=NOW).status == "fail"
    s["bindings"] = s["bindings"][1:]
    assert check_payee_binding(s, now=NOW).status == "pass"


def test_xrpl_online_key_lookup():
    s = _signed("xrpl")
    seen = []

    def loader(address, url):
        seen.append((address, url))
        return XrplKeys(master_disabled=False, regular_key=None)

    res = check_payee_binding(s, offline=False, now=NOW, load_xrpl_keys=loader)
    assert res.status == "pass" and "online" in res.detail
    assert seen == [("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "https://s.altnet.rippletest.net:51234")]

    def disabled(address, url):
        return XrplKeys(master_disabled=True, regular_key=None)

    assert check_payee_binding(s, offline=False, now=NOW, load_xrpl_keys=disabled).status == "fail"

    def down(address, url):
        raise OSError("connection refused")

    res = check_payee_binding(s, offline=False, now=NOW, load_xrpl_keys=down)
    assert res.status == "unavailable" and "connection refused" in res.detail


def test_verify_reports_binding_level(live_doc, live_output):
    signed = live_doc["signedReceipt"]
    swapped = copy.deepcopy(signed)
    swapped["bindings"] = [VECTORS["vectors"][0]["binding"]]  # someone else's binding
    report = verify(swapped, live_output, offline=True)
    assert report.levels["signature"].status == "pass"
    assert report.levels["binding"].status == "fail"
    assert report.status == "NOT VERIFIED"
    # A non-array `bindings` breaks the signed-receipt envelope (SPEC §4): level 2 fails.
    swapped["bindings"] = {"not": "an array"}
    report = verify(swapped, live_output, offline=True)
    assert report.levels["signature"].status == "fail"
    assert "bindings must be an array" in report.levels["signature"].detail
    assert report.status == "NOT VERIFIED"


online = pytest.mark.skipif(os.environ.get("RECEPTUM_OFFLINE") == "1", reason="RECEPTUM_OFFLINE=1")


@pytest.mark.online
@online
def test_xrpl_example_binding_online():
    b = load_json(EXAMPLES / "bindings" / "xrpl-testnet.json")
    address = b["statement"]["account"].split(":")[2]
    try:
        keys = fetch_xrpl_keys(address, "https://s.altnet.rippletest.net:51234")
    except (OSError, ValueError) as exc:
        pytest.skip(f"XRPL testnet unavailable or account gone: {exc}")
    res = verify_binding(b, xrpl_keys=keys)
    assert res.ok, res.errors
