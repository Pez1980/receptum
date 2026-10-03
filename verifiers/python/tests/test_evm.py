"""Level 3 logic against a fake JSON-RPC (no network)."""

import copy

import pytest

from receptum_verify import evm
from receptum_verify.evm import TRANSFER_TOPIC, check_evm_anchor, check_x402_exact

ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x62E5fFEcdc8be558F0a05031242ea1E9D3e921e5"
PAYEE = "0x6344D17a80775A71b51A61124767AbCD22B0328B"
TX = "0x" + "90" * 32
RH = "cb27b5b6a98fdaecb96fbedf557acba67bdad3a2fa6505f9836c49fbc766ba4a"


def topic(addr):
    return "0x" + "0" * 24 + addr[2:].lower()


def transfer_log(frm=PAYER, to=PAYEE, amount=250000, asset=ASSET):
    return {
        "address": asset.lower(),
        "topics": [TRANSFER_TOPIC, topic(frm), topic(to)],
        "data": "0x" + f"{amount:064x}",
        "removed": False,
    }


RECEIPT = {
    "payment": {
        "rail": "x402:exact",
        "network": "eip155:84532",
        "asset": ASSET,
        "amount": "250000",
        "reference": TX,
        "payee": f"eip155:84532:{PAYEE}",
        "payer": f"eip155:84532:{PAYER}",
    }
}


class FakeRpc:
    def __init__(self, responses):
        self.responses = responses

    def __call__(self, url, timeout=20.0):
        self.url = url
        return self

    def call(self, method, params):
        value = self.responses[method]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


@pytest.fixture
def rpc(monkeypatch):
    def install(**responses):
        responses.setdefault("eth_chainId", "0x14a34")
        fake = FakeRpc(responses)
        monkeypatch.setattr(evm, "JsonRpc", fake)
        return fake

    return install


def settled(logs=None, status="0x1"):
    return {"status": status, "blockNumber": "0x10", "logs": logs if logs is not None else [transfer_log()]}


def test_settlement_pass(rpc):
    rpc(eth_getTransactionReceipt=settled())
    assert check_x402_exact(RECEIPT).status == "pass"


def test_settlement_without_payer_pass(rpc):
    rpc(eth_getTransactionReceipt=settled())
    r = copy.deepcopy(RECEIPT)
    del r["payment"]["payer"]
    assert check_x402_exact(r).status == "pass"


@pytest.mark.parametrize(
    "logs,status",
    [
        ([transfer_log()], "0x0"),
        ([transfer_log(amount=1)], "0x1"),
        ([transfer_log(amount=250001)], "0x1"),
        ([transfer_log(to=PAYER)], "0x1"),
        ([transfer_log(frm=PAYEE)], "0x1"),
        ([transfer_log(asset="0x" + "11" * 20)], "0x1"),
        ([{**transfer_log(), "removed": True}], "0x1"),
        ([], "0x1"),
    ],
)
def test_settlement_mismatch_fails(rpc, logs, status):
    rpc(eth_getTransactionReceipt=settled(logs, status))
    assert check_x402_exact(RECEIPT).status == "fail"


def test_settlement_not_found_fails(rpc):
    rpc(eth_getTransactionReceipt=None)
    assert check_x402_exact(RECEIPT).status == "fail"


def test_wrong_chain_is_unavailable(rpc):
    rpc(eth_chainId="0x1", eth_getTransactionReceipt=settled())
    assert check_x402_exact(RECEIPT).status == "unavailable"


def test_rpc_error_is_unavailable(rpc):
    rpc(eth_getTransactionReceipt=evm.RpcError("down"))
    assert check_x402_exact(RECEIPT).status == "unavailable"


def test_symbol_asset_and_missing_payee_are_unavailable(rpc):
    rpc(eth_getTransactionReceipt=settled())
    r = copy.deepcopy(RECEIPT)
    r["payment"]["asset"] = "USDC"
    assert check_x402_exact(r).status == "unavailable"
    r = copy.deepcopy(RECEIPT)
    del r["payment"]["payee"]
    assert check_x402_exact(r).status == "unavailable"


def test_payee_on_other_chain_fails(rpc):
    rpc(eth_getTransactionReceipt=settled())
    r = copy.deepcopy(RECEIPT)
    r["payment"]["payee"] = f"eip155:1:{PAYEE}"
    assert check_x402_exact(r).status == "fail"


ANCHOR = "eip155:5042002:0x" + "e7" * 32
CALLDATA = "0x" + b"receptum/1".hex() + RH


def anchor_rpc(rpc, input_=CALLDATA, value="0x0", status="0x1", block="0x5"):
    rpc(
        eth_chainId="0x4cef52",
        eth_getTransactionByHash={"input": input_, "value": value, "chainId": "0x4cef52", "from": PAYEE},
        eth_getTransactionReceipt={"status": status, "blockNumber": block, "logs": []},
    )


def test_anchor_pass(rpc):
    anchor_rpc(rpc)
    assert check_evm_anchor(ANCHOR, RH).status == "pass"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"input_": "0x" + b"receptum/1".hex() + "00" * 32},
        {"input_": "0x" + RH},
        {"input_": CALLDATA + "00"},
        {"input_": "0x" + b"receptum/1".hex() + RH.encode().hex()},  # hex text, not raw bytes
        {"value": "0x1"},
        {"status": "0x0"},
        {"block": None},
    ],
)
def test_anchor_mismatch_fails(rpc, kwargs):
    anchor_rpc(rpc, **kwargs)
    assert check_evm_anchor(ANCHOR, RH).status == "fail"


def test_anchor_malformed():
    assert check_evm_anchor("0xdeadbeef", RH).status == "fail"
    assert check_evm_anchor("eip155:5042002:0x12", RH).status == "fail"
    assert check_evm_anchor("xrpl:1:" + "AB" * 32, RH).status == "unavailable"
