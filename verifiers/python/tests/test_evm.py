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


def test_symbol_asset_fails_and_missing_payee_is_unavailable(rpc):
    rpc(eth_getTransactionReceipt=settled())
    r = copy.deepcopy(RECEIPT)
    # SPEC §7.3: payment.asset MUST be the token contract address for x402:exact on eip155.
    r["payment"]["asset"] = "USDC"
    res = check_x402_exact(r)
    assert res.status == "fail"
    assert "token contract address" in res.detail
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


# SPEC §7.3: exactly three topics (selector, from, to) and exactly 32 bytes of data.
@pytest.mark.parametrize(
    "data",
    [
        "0x" + f"{250000:x}",  # shorter than one word
        "0x" + "00" * 32 + f"{250000:064x}",  # two words, value in the second
        "0x" + f"{250000:064x}" + "00",  # one word plus a byte
        "0x_" + f"{250000:064x}"[1:],  # Python int() accepts underscores
        "0X" + f"{250000:064x}",
    ],
)
def test_transfer_data_must_be_one_word(rpc, data):
    log = transfer_log()
    log["data"] = data
    rpc(eth_getTransactionReceipt=settled([log]))
    assert check_x402_exact(RECEIPT).status == "fail"


def test_transfer_with_four_topics_fails(rpc):
    log = transfer_log()
    log["topics"] = log["topics"] + ["0x" + f"{250000:064x}"]
    rpc(eth_getTransactionReceipt=settled([log]))
    assert check_x402_exact(RECEIPT).status == "fail"


def test_transfer_address_topic_with_dirty_upper_bytes_fails(rpc):
    log = transfer_log()
    log["topics"][2] = "0x" + "0" * 23 + "1" + PAYEE[2:].lower()
    rpc(eth_getTransactionReceipt=settled([log]))
    assert check_x402_exact(RECEIPT).status == "fail"


# History RPCs (HISTORY_RPCS): a transaction the primary RPC does not know is looked up on the
# network's history RPCs, used only when they serve the CAIP-2 chain id and return that very
# transaction, mined.
PRIMARY = evm.DEFAULT_RPCS["eip155:5042002"]
DRPC, DRPC_ORG = evm.HISTORY_RPCS["eip155:5042002"]
ARC_CHAIN = "0x4cef52"
ANCHOR_TX = ANCHOR.rpartition(":")[2]


class Node:
    def __init__(self, url, responses, log):
        self.url = url
        self.responses = responses
        self.log = log

    def call(self, method, params):
        self.log.append((self.url, method))
        value = self.responses.get(method)
        if callable(value):
            value = value(params)
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


@pytest.fixture
def nodes(monkeypatch):
    """Installs one fake JSON-RPC node per URL; an unknown URL is a network error."""

    def install(by_url):
        log = []

        def factory(url, timeout=20.0):
            return Node(url, by_url.get(url, {"eth_chainId": evm.RpcError(f"{url} unreachable")}), log)

        monkeypatch.setattr(evm, "JsonRpc", factory)
        return log

    return install


def arc_node(chain=ARC_CHAIN, knows=False, tx_hash=ANCHOR_TX, settlement=None):
    tx = {"hash": tx_hash, "input": CALLDATA, "value": "0x0", "chainId": ARC_CHAIN, "from": PAYEE}
    rec = {"transactionHash": tx_hash, "status": "0x1", "blockNumber": "0x3e4a8fc", "logs": []}

    def by_hash(params):
        return tx if knows and params[0] == ANCHOR_TX else None

    def receipt(params):
        if knows and params[0] == ANCHOR_TX:
            return rec
        if settlement is not None and params[0] == TX:
            return settlement
        return None

    return {"eth_chainId": chain, "eth_getTransactionByHash": by_hash, "eth_getTransactionReceipt": receipt}


def test_history_rpcs_for_arc_testnet():
    assert evm.HISTORY_RPCS["eip155:5042002"] == (
        "https://rpc.drpc.testnet.arc.network",
        "https://arc-testnet.drpc.org",
    )


def test_anchor_found_on_a_history_rpc_passes(nodes):
    log = nodes({PRIMARY: arc_node(), DRPC: arc_node(knows=True)})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "pass"
    assert "via history RPC rpc.drpc.testnet.arc.network" in res.detail
    assert (DRPC, "eth_chainId") in log
    assert not any(url == DRPC_ORG for url, _ in log)


def test_history_rpc_on_another_chain_is_ignored(nodes):
    nodes({PRIMARY: arc_node(), DRPC: arc_node(chain="0x14a34", knows=True), DRPC_ORG: arc_node()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_next_history_rpc_after_wrong_chain_or_network_error(nodes):
    nodes({PRIMARY: arc_node(), DRPC: arc_node(chain="0x1", knows=True), DRPC_ORG: arc_node(knows=True)})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "pass"
    assert "via history RPC arc-testnet.drpc.org" in res.detail
    nodes({PRIMARY: arc_node(), DRPC_ORG: arc_node(knows=True)})  # DRPC unreachable
    assert check_evm_anchor(ANCHOR, RH).status == "pass"


def test_history_rpc_answering_another_transaction_is_ignored(nodes):
    nodes({PRIMARY: arc_node(), DRPC: arc_node(knows=True, tx_hash="0x" + "ee" * 32), DRPC_ORG: arc_node()})
    assert check_evm_anchor(ANCHOR, RH).status == "fail"


def test_not_found_on_every_rpc_still_fails(nodes):
    nodes({PRIMARY: arc_node(), DRPC: arc_node(), DRPC_ORG: arc_node()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_primary_answer_is_never_replaced(nodes):
    primary = arc_node(knows=True)
    primary["eth_getTransactionByHash"] = lambda params: {"hash": ANCHOR_TX, "input": "0x", "value": "0x0", "from": PAYEE}
    log = nodes({PRIMARY: primary, DRPC: arc_node(knows=True)})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "calldata" in res.detail
    assert not any(url == DRPC for url, _ in log)


def test_primary_rpc_error_stays_unavailable(nodes):
    primary = arc_node()
    primary["eth_getTransactionByHash"] = evm.RpcError("down")
    log = nodes({PRIMARY: primary, DRPC: arc_node(knows=True)})
    assert check_evm_anchor(ANCHOR, RH).status == "unavailable"
    assert not any(url == DRPC for url, _ in log)


ARC_RECEIPT = {
    "payment": {
        **RECEIPT["payment"],
        "network": "eip155:5042002",
        "payee": f"eip155:5042002:{PAYEE}",
        "payer": f"eip155:5042002:{PAYER}",
    }
}


def test_settlement_found_on_a_history_rpc_passes(nodes):
    found = {**settled(), "transactionHash": TX}
    nodes({PRIMARY: arc_node(), DRPC: arc_node(settlement=found)})
    res = check_x402_exact(ARC_RECEIPT)
    assert res.status == "pass"
    assert "via history RPC rpc.drpc.testnet.arc.network" in res.detail


def test_settlement_history_rpc_on_another_chain_or_hash_is_ignored(nodes):
    nodes({
        PRIMARY: arc_node(),
        DRPC: arc_node(chain="0x14a34", settlement={**settled(), "transactionHash": TX}),
        DRPC_ORG: arc_node(settlement={**settled(), "transactionHash": "0x" + "ee" * 32}),
    })
    res = check_x402_exact(ARC_RECEIPT)
    assert res.status == "fail"
    assert "not found" in res.detail
