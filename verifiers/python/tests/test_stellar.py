"""Stellar: StrKey, SAC contract ids, x402:exact on stellar:testnet and anchor:stellar, with a
mocked Horizon."""

import base64
import urllib.parse

import pytest

from receptum_verify.stellar import (
    HorizonError,
    HorizonNotFound,
    check_stellar_anchor,
    check_stellar_x402_exact,
    from_stellar_amount,
    is_valid_account,
    is_valid_contract,
    parse_asset,
    sac_contract_id,
    token_contract_id,
)

from conftest import RH

BUYER = "GAJGU63DDMPR6DU2LVMMFOV5DUSPTHG6PSGV7N3E72TXWMK74ZEOCNWI"
SELLER = "GCKJSBZNHSKEPM7VEM6CQ6RGP2HNNMJOUIEXGYABRSRJVI73K6YDSRIT"
ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
USDC = f"USDC:{ISSUER}"
USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
TX = "198c86d8d96e2a16eefbae190d5af82c7aba3b88dcb7a059df60b84260637401"


class FakeHorizon:
    """Routes ``/path`` (query ignored) to a JSON reply, an exception, or 404."""

    def __init__(self, routes):
        self.routes = routes
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        path = urllib.parse.urlsplit(url).path
        reply = self.routes.get(path)
        if reply is None:
            raise HorizonNotFound(path)
        if isinstance(reply, Exception):
            raise reply
        return reply


def collection(records, next_href=None):
    doc = {"_embedded": {"records": records}}
    if next_href:
        doc["_links"] = {"next": {"href": next_href}}
    return doc


# --- StrKey and assets ---------------------------------------------------------------------------


def test_sac_contract_ids():
    assert sac_contract_id(USDC) == USDC_SAC
    assert sac_contract_id("native") == NATIVE_SAC == token_contract_id("XLM")
    assert token_contract_id(USDC_SAC) == USDC_SAC


@pytest.mark.parametrize(
    "asset",
    ["", "USDC", f"USDC:{ISSUER}:x", f":{ISSUER}", "USDC:GABC", f"TOOLONGCODE13:{ISSUER}", f"US-D:{ISSUER}", f"USDC:{USDC_SAC}"],
)
def test_bad_assets(asset):
    with pytest.raises(ValueError):
        token_contract_id(asset)


def test_alphanum12_asset():
    assert parse_asset(f"LONGERCODE:{ISSUER}") == ("LONGERCODE", ISSUER)
    assert sac_contract_id(f"LONGERCODE:{ISSUER}") != sac_contract_id(f"LONGE:{ISSUER}")


def test_strkeys():
    assert is_valid_account(BUYER) and not is_valid_account(USDC_SAC)
    assert is_valid_contract(USDC_SAC) and not is_valid_contract(BUYER)
    assert not is_valid_account(BUYER[:-1] + ("A" if BUYER[-1] != "A" else "B"))  # checksum
    assert not is_valid_account(BUYER.lower())


def test_amounts():
    assert from_stellar_amount("0.0100000") == "100000"
    assert from_stellar_amount("12") == "120000000"
    for bad in ("1.12345678", "-1", "1e3", "", ".5"):
        with pytest.raises(ValueError):
            from_stellar_amount(bad)


# --- x402:exact --------------------------------------------------------------------------------


def x402_receipt(**over):
    pay = {
        "rail": "x402:exact",
        "network": "stellar:testnet",
        "asset": USDC_SAC,
        "amount": "100000",
        "reference": TX,
        "payer": f"stellar:testnet:{BUYER}",
        "payee": f"stellar:testnet:{SELLER}",
    }
    pay.update(over)
    return {"payment": pay}


def change(**over):
    c = {"asset_type": "credit_alphanum4", "asset_code": "USDC", "asset_issuer": ISSUER,
         "type": "transfer", "from": BUYER, "to": SELLER, "amount": "0.0100000"}
    c.update(over)
    return c


def settlement(changes=None, successful=True, op_type="invoke_host_function"):
    return FakeHorizon({
        f"/transactions/{TX}": {"hash": TX, "successful": successful, "ledger": 5005091},
        f"/transactions/{TX}/operations": collection(
            [{"type": op_type, "asset_balance_changes": [change()] if changes is None else changes}]
        ),
    })


def x402(fetch, payer=BUYER, payee=SELLER, **over):
    return check_stellar_x402_exact(x402_receipt(**over), payer, payee, fetch=fetch)


def test_x402_transfer_passes():
    res = x402(settlement())
    assert res.status == "pass" and "ledger 5005091" in res.detail
    assert x402(settlement(), asset=USDC).status == "pass"
    assert x402(settlement(), payer=None).status == "pass"  # payer is optional


@pytest.mark.parametrize(
    "changes",
    [
        [change(amount="0.0099999")],
        [change(to=BUYER)],
        [change(**{"from": SELLER})],
        [change(type="mint")],
        [change(asset_type="native", asset_code=None, asset_issuer=None)],
        [change(asset_code="USDT")],
        [],
    ],
)
def test_x402_without_the_transfer_fails(changes):
    res = x402(settlement(changes))
    assert res.status == "fail" and "no transfer" in res.detail


def test_x402_only_counts_invoke_host_function():
    assert x402(settlement(op_type="payment")).status == "fail"


def test_x402_native_asset():
    assert x402(settlement([change(asset_type="native", asset_code=None, asset_issuer=None)]),
                asset="native").status == "pass"


def test_x402_failed_or_unknown_transaction_fails():
    assert x402(settlement(successful=False)).status == "fail"
    assert x402(FakeHorizon({})).status == "fail"


def test_x402_receipt_side_failures_need_no_horizon():
    fetch = FakeHorizon({})
    assert x402(fetch, reference=TX.upper()).status == "fail"
    assert x402(fetch, asset="USDC").status == "fail"
    assert x402(fetch, payee=None).status == "unavailable"
    assert fetch.urls == []


def test_x402_horizon_errors_are_unavailable():
    assert x402(FakeHorizon({f"/transactions/{TX}": HorizonError("down")})).status == "unavailable"
    bad = settlement([change(amount="1e-7")])
    assert x402(bad).status == "unavailable"


# --- anchor:stellar ----------------------------------------------------------------------------


def anchor_tx(memo=RH, memo_type="hash", successful=True):
    return FakeHorizon({f"/transactions/{TX}": {
        "hash": TX, "successful": successful, "memo_type": memo_type,
        "memo": base64.b64encode(bytes.fromhex(memo)).decode(), "created_at": "2026-10-03T17:37:02Z",
    }})


def test_stellar_anchor():
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=anchor_tx()).status == "pass"
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=anchor_tx(memo="00" * 32)).status == "fail"
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=anchor_tx(memo_type="text")).status == "fail"
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=anchor_tx(successful=False)).status == "fail"
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=FakeHorizon({})).status == "fail"
    assert check_stellar_anchor("stellar:testnet", TX.upper(), RH, fetch=anchor_tx()).status == "fail"
    down = FakeHorizon({f"/transactions/{TX}": HorizonError("down")})
    assert check_stellar_anchor("stellar:testnet", TX, RH, fetch=down).status == "unavailable"
    assert check_stellar_anchor("stellar:pubnet", TX, RH, fetch=anchor_tx()).status == "unavailable"
