"""Level-3 dispatch in verify(): every rail and anchor network the TypeScript verifier checks,
the shared payer/payee network rule, trusted escrows and the CLI flags. No network."""

import copy
import importlib

import pytest

from receptum_verify import verify
from receptum_verify.cli import main
from receptum_verify.evm import CheckResult
from receptum_verify.verify import check_anchor, check_settlement

from test_spec_alignment import BASE, _resign

verify_mod = importlib.import_module("receptum_verify.verify")

calls = []


def fake(name):
    def check(*args, **kw):
        calls.append((name, args, kw))
        return CheckResult("pass", name)

    return check


@pytest.fixture(autouse=True)
def patched(monkeypatch):
    calls.clear()
    for name in ("check_evm_escrow", "check_soroban_escrow", "check_stellar_claimable",
                 "check_xrpl_x402_exact", "check_stellar_x402_exact", "check_x402_exact",
                 "check_xrpl_escrow_payment", "check_evm_anchor", "check_xrpl_anchor",
                 "check_stellar_anchor"):
        monkeypatch.setattr(verify_mod, name, fake(name))


def signed_with(**payment):
    r = copy.deepcopy(BASE)
    for k, v in payment.items():
        if v is None:
            r["payment"].pop(k, None)
        else:
            r["payment"][k] = v
    return _resign(r)


@pytest.mark.parametrize(
    "rail,network,want",
    [
        ("escrow:receptum-evm", "eip155:5042002", "check_evm_escrow"),
        ("escrow:receptum-soroban", "stellar:testnet", "check_soroban_escrow"),
        ("escrow:stellar-claimable", "stellar:testnet", "check_stellar_claimable"),
        ("escrow:xrpl", "xrpl:1", "check_xrpl_escrow_payment"),
        ("x402:exact", "stellar:testnet", "check_stellar_x402_exact"),
        ("x402:exact", "stellar:pubnet", "check_stellar_x402_exact"),
        ("escrow:xrpl", "xrpl:0", "check_xrpl_escrow_payment"),
        ("x402:exact", "xrpl:1", "check_xrpl_x402_exact"),
        ("x402:exact", "eip155:84532", "check_x402_exact"),
    ],
)
def test_each_rail_has_its_check(rail, network, want):
    signed = signed_with(rail=rail, network=network, payer=None, payee=None)
    res = check_settlement(signed, rpcs={}, trusted_escrows=["x"])
    assert res.detail == want
    if want in ("check_evm_escrow", "check_soroban_escrow"):
        assert calls[0][2]["trusted"] == ["x"]


def test_unsupported_rails_and_networks_are_unavailable():
    for rail, network in (("x402:exact", "stellar:futurenet"), ("escrow:other", "eip155:1"), ("x402:upto", "eip155:1")):
        res = check_settlement(signed_with(rail=rail, network=network, payer=None, payee=None), rpcs={})
        assert res.status == "unavailable"
    assert calls == []


@pytest.mark.parametrize("rail", ["escrow:receptum-evm", "escrow:xrpl", "x402:upto", "escrow:other"])
def test_payer_or_payee_on_another_network_fails_first(rail):
    # As in the TypeScript verifier, this applies to every rail before it is dispatched.
    for who in ("payer", "payee"):
        signed = signed_with(**{"rail": rail, "network": "xrpl:1", "payer": None, "payee": None,
                                 who: "eip155:1:0x" + "11" * 20})
        res = check_settlement(signed, rpcs={})
        assert res.status == "fail" and who in res.detail
    assert calls == []


def test_escrow_rails_reach_verified_without_an_anchor():
    signed = signed_with(rail="escrow:receptum-evm", network="eip155:5042002", payer=None, payee=None)
    report = verify(signed, None, allow_unbound=True)
    assert report.levels["settlement"].status == "pass"
    assert report.levels["anchor"].status == "skipped"
    # Only the missing file keeps it from VERIFIED: the rail commits receiptHash itself.
    assert report.status == "PARTIALLY VERIFIED"
    assert len(report.missing) == 1 and report.missing[0].startswith("L1")


@pytest.mark.parametrize(
    "ref,want",
    [
        ("eip155:5042002:0x" + "ab" * 32, "check_evm_anchor"),
        ("xrpl:1:" + "AB" * 32, "check_xrpl_anchor"),
        ("stellar:testnet:" + "ab" * 32, "check_stellar_anchor"),
    ],
)
def test_anchor_networks(ref, want):
    assert check_anchor(ref, "00" * 32, rpcs={}).detail == want


def test_other_anchor_networks():
    rh = "00" * 32
    assert check_anchor("not-an-anchor", rh, rpcs={}).status == "fail"
    # Mainnets are read like testnets (as in the TypeScript verifier); the rail check then
    # rejects a malformed hash itself.
    assert check_anchor("xrpl:0:" + "AB" * 32, rh, rpcs={}).detail == "check_xrpl_anchor"
    assert check_anchor("xrpl:5:" + "AB" * 32, rh, rpcs={}).status == "unavailable"
    assert check_anchor("xrpl:5:" + "AB" * 32, rh, rpcs={}, user_rpcs={"xrpl:5": "http://x"}).detail == "check_xrpl_anchor"
    assert check_anchor("stellar:pubnet:" + "ab" * 32, rh, rpcs={}).detail == "check_stellar_anchor"
    assert check_anchor("stellar:futurenet:" + "ab" * 32, rh, rpcs={}).status == "unavailable"
    assert check_anchor("cosmos:hub-4:" + "ab" * 32, rh, rpcs={}).status == "unavailable"


def test_cli_passes_trusted_escrows_and_horizons(monkeypatch, tmp_path):
    seen = {}

    def fake_verify(signed, file_bytes, **kw):
        seen.update(kw)
        return verify_mod.Report("VERIFIED", None, None, {})

    import receptum_verify.cli as cli

    monkeypatch.setattr(cli, "verify", fake_verify)
    path = tmp_path / "r.json"
    path.write_text('{"receipt": {}}')
    code = main([str(path), "--trust-escrow", "0xabc", "--trust-escrow", "CABC",
                 "--horizon", "stellar:testnet=http://h", "--rpc", "stellar:testnet=http://s"])
    assert code == 0
    assert seen["trusted_escrows"] == ["0xabc", "CABC"]
    assert seen["horizons"] == {"stellar:testnet": "http://h"}
    assert seen["rpcs"] == {"stellar:testnet": "http://s"}
    assert main([str(path), "--horizon", "nope"]) == 2


SOLANA_REF = (
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:2neqpNegEPy9zYppnbMtksNdoXLE9XDesAbBEqKUqTsg"
    ":HrV3o4gmWbjBD52tudx5RAMyJu9tJz5mrJDJMwXtTT8o"
)


@pytest.mark.parametrize("network", ["eip155:84532", "xrpl:1", "stellar:testnet", "eip155:8453"])
@pytest.mark.parametrize("reference", [SOLANA_REF, "0x" + "11" * 32])
def test_solana_escrow_rail_on_another_network_fails(network, reference):
    # Review round 4: escrow:receptum-solana is dispatched by rail first, so a non-Solana
    # payment.network is a contradiction (fail -> NOT VERIFIED), with no RPC query — the same
    # result as the TypeScript verifier.
    signed = signed_with(rail="escrow:receptum-solana", network=network, reference=reference,
                         payer=None, payee=None)
    res = check_settlement(signed, rpcs={})
    assert res.status == "fail"
    assert ("receipt says " + network) in res.detail or "invalid Solana escrowId" in res.detail
    report = verify(signed, None, allow_unbound=True)
    assert report.status == "NOT VERIFIED"
