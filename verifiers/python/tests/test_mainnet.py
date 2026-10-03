"""Mainnet receipts: labelled distinctly, mainnet endpoints present, x402 settlement checks work
against a fake RPC, and escrow receipts report an untrusted deployment while the mainnet
registry is empty. No test here sends anything; the one online test is a read-only chain-id call."""

import copy
import json
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from receptum_verify import TRUSTED_ESCROWS, evm, network_class, network_label, verify
from receptum_verify.binding import DEFAULT_XRPL_RPCS
from receptum_verify.cli import main
from receptum_verify.encoding import b64url_encode
from receptum_verify.evm import DEFAULT_RPCS, TRANSFER_TOPIC, JsonRpc
from receptum_verify.jcs import canonicalize
from receptum_verify.receipt import receipt_hash
from receptum_verify.xrpl_x402 import DEFAULT_XRPL_JSON_RPCS

USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PAYER = "0x1111111111111111111111111111111111111111"
PAYEE = "0x2222222222222222222222222222222222222222"
TX = "0x" + "ab" * 32


def resign(vectors, payment, acceptance=None):
    """The first RRF vector with another payment, re-signed with its public RFC 8032 test seed."""
    receipt = copy.deepcopy(vectors["vectors"][0]["receipt"])
    receipt["payment"] = payment
    if acceptance is not None:
        receipt["acceptance"] = acceptance
    did = receipt["seller"]["id"]
    kid = f"{did}#{did[len('did:key:'):]}"
    header = b64url_encode(json.dumps({"alg": "EdDSA", "kid": kid, "typ": "receptum+jws"}).encode())
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(vectors["testSeedHex"]))
    sig = key.sign(f"{header}.{b64url_encode(canonicalize(receipt))}".encode("ascii"))
    return {
        "receipt": receipt,
        "receiptHash": receipt_hash(receipt),
        "proof": {"type": "jws", "kid": kid, "jws": f"{header}..{b64url_encode(sig)}"},
    }


def x402(network="eip155:8453"):
    return {
        "rail": "x402:exact",
        "network": network,
        "asset": USDC,
        "amount": "250000",
        "reference": TX,
        "payer": f"{network}:{PAYER}",
        "payee": f"{network}:{PAYEE}",
    }


class FakeRpc:
    def __init__(self, responses):
        self.responses = responses
        self.urls = []

    def __call__(self, url, timeout=20.0):
        self.url = url
        self.urls.append(url)
        return self

    def call(self, method, params):
        return copy.deepcopy(self.responses[method])


def test_classes_and_labels():
    assert network_class("eip155:8453") == "mainnet"
    assert network_class("stellar:pubnet") == "mainnet"
    assert network_class("xrpl:0") == "mainnet"
    assert network_class("eip155:84532") == "testnet"
    assert network_class("eip155:1") == "unknown"
    assert network_label("eip155:8453") == "=== MAINNET receipt (eip155:8453) — real funds ==="
    assert network_label("xrpl:1").startswith("=== TESTNET receipt (xrpl:1)")
    assert "unrecognised" in network_label(None)


def test_mainnet_endpoints():
    assert DEFAULT_RPCS["eip155:8453"] == "https://mainnet.base.org"
    assert DEFAULT_RPCS["eip155:5042"] == "https://rpc.mainnet.arc.io"
    assert DEFAULT_XRPL_JSON_RPCS["xrpl:0"].startswith("https://")
    assert DEFAULT_XRPL_RPCS["xrpl:0"].startswith("https://")


def test_mainnet_registry_entries_exist_and_are_empty():
    for n in ("eip155:8453", "eip155:5042", "stellar:pubnet"):
        assert TRUSTED_ESCROWS[n] == ()
    assert TRUSTED_ESCROWS["eip155:5042002"]


def test_report_carries_the_network(vectors):
    report = verify(resign(vectors, x402()), offline=True)
    assert report.to_dict()["network"] == "eip155:8453"
    assert report.to_dict()["networkClass"] == "mainnet"


def test_x402_mainnet_settlement_out_of_the_box(vectors, monkeypatch):
    log = {
        "address": USDC.lower(),
        "topics": [TRANSFER_TOPIC, "0x" + "0" * 24 + PAYER[2:], "0x" + "0" * 24 + PAYEE[2:]],
        "data": "0x" + f"{250000:064x}",
        "removed": False,
    }
    fake = FakeRpc(
        {
            "eth_chainId": "0x2105",
            "eth_getTransactionReceipt": {"status": "0x1", "blockNumber": "0x10", "logs": [log]},
        }
    )
    monkeypatch.setattr(evm, "JsonRpc", fake)
    report = verify(resign(vectors, x402()), allow_unbound=True)
    assert report.levels["settlement"].status == "pass"
    assert set(fake.urls) == {"https://mainnet.base.org"}
    # A testnet RPC behind a mainnet receipt is never accepted.
    fake.responses["eth_chainId"] = "0x14a34"
    assert verify(resign(vectors, x402()), allow_unbound=True).levels["settlement"].status == (
        "unavailable"
    )


def _evm_mainnet(vectors, monkeypatch, network, chain_hex, contract):
    import test_evm_escrow as t
    from receptum_verify import evm_escrow

    payment = {"rail": "escrow:receptum-evm", "network": network, "asset": t.TOKEN,
               "amount": "2500000", "reference": f"{network}:{contract}:1",
               "payer": f"{network}:{t.BUYER}", "payee": f"{network}:{t.SELLER}"}
    signed = resign(vectors, payment, {"mode": "buyer", "reviewWindowSeconds": 600})
    fake = t.FakeRpc(chain=chain_hex, data=t.record(receiptHash="0x" + signed["receiptHash"]))
    monkeypatch.setattr(evm_escrow, "JsonRpc", lambda url: fake)
    return signed


@pytest.mark.parametrize(
    "network,chain_hex,contract",
    [
        ("eip155:8453", "0x2105", "0x3333333333333333333333333333333333333333"),
        # The testnet deployment's address: trust must not carry over to another chain.
        ("eip155:5042", "0x13b2", "0x20d69c6c647559f48a7e6b0a3f922e99a4068f16"),
    ],
)
def test_mainnet_evm_escrow_reports_untrusted_deployment(vectors, monkeypatch, network, chain_hex, contract):
    # As in the TypeScript verifier: genuine ReceptumEscrow code and matching terms on a mainnet
    # whose registry entry is empty is pending (untrusted deployment), never VERIFIED.
    signed = _evm_mainnet(vectors, monkeypatch, network, chain_hex, contract)
    report = verify(signed, allow_unbound=True)
    s = report.levels["settlement"]
    assert s.status == "pending", s.detail
    assert s.detail.startswith(
        f"untrusted deployment: no ReceptumEscrow code deployment has been published for mainnet {network}"
    )
    assert report.status == "PARTIALLY VERIFIED"
    # Trusting it explicitly is the caller's decision.
    trusted = verify(signed, allow_unbound=True, trusted_escrows=[contract])
    assert trusted.levels["settlement"].status == "pass"


def test_mainnet_soroban_escrow_reports_untrusted_deployment(vectors, monkeypatch):
    import test_soroban as t
    from receptum_verify import soroban
    from receptum_verify.stellar import STELLAR_PUBNET_PASSPHRASE

    contract = TRUSTED_ESCROWS["stellar:testnet"][0]  # testnet trust must not carry over
    net = "stellar:pubnet"
    payment = {"rail": "escrow:receptum-soroban", "network": net, "asset": t.USDC_SAC,
               "amount": "1000000", "reference": f"{net}:{contract}:17",
               "payer": f"{net}:{t.BUYER}", "payee": f"{net}:{t.SELLER}"}
    signed = resign(vectors, payment, {"mode": "buyer", "reviewWindowSeconds": 600})
    rec = t.record(receipt_hash=t.bytes_(bytes.fromhex(signed["receiptHash"])))
    fake = t.FakeSoroban(record_xdr=rec, passphrase=STELLAR_PUBNET_PASSPHRASE)
    urls = []
    monkeypatch.setattr(soroban, "_json_rpc_call", lambda url: urls.append(url) or fake)
    report = verify(signed, allow_unbound=True)
    s = report.levels["settlement"]
    assert s.status == "pending", s.detail
    assert s.detail.startswith("untrusted deployment: no ReceptumEscrow wasm deployment")
    assert urls == ["https://mainnet.sorobanrpc.com"]
    # A testnet reference behind a pubnet receipt fails before any RPC.
    payment["reference"] = f"stellar:testnet:{contract}:17"
    res = verify(resign(vectors, payment, {"mode": "buyer", "reviewWindowSeconds": 600}), allow_unbound=True)
    assert res.levels["settlement"].status == "fail"
    assert "is on stellar:testnet" in res.levels["settlement"].detail


def test_cli_header_labels_mainnet(vectors, tmp_path, capsys):
    path = tmp_path / "mainnet.json"
    path.write_text(json.dumps(resign(vectors, x402())))
    assert main([str(path), "--offline"]) == 3
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "=== MAINNET receipt (eip155:8453) — real funds ==="
    assert any(l.strip() == "network      eip155:8453 (mainnet)" for l in lines)


online = pytest.mark.skipif(os.environ.get("RECEPTUM_OFFLINE") == "1", reason="RECEPTUM_OFFLINE=1")


@pytest.mark.online
@online
@pytest.mark.parametrize("network", ["eip155:8453", "eip155:5042"])
def test_mainnet_rpc_serves_its_chain(network):
    # Read-only: eth_chainId only.
    try:
        got = JsonRpc(DEFAULT_RPCS[network]).call("eth_chainId", [])
    except Exception as exc:  # pragma: no cover - network dependent
        pytest.skip(f"RPC unavailable: {exc}")
    assert int(got, 16) == int(network.split(":")[1])
