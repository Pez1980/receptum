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


# History RPCs (HISTORY_RPCS) are only locators: when the primary RPC's transaction index does not
# know a hash, a history RPC on the right chain may say which block holds it; the block and its
# receipts are then read from the PRIMARY RPC, and every checked field is the primary's.
PRIMARY = evm.DEFAULT_RPCS["eip155:5042002"]
DRPC, DRPC_ORG = evm.HISTORY_RPCS["eip155:5042002"]
ARC_CHAIN = "0x4cef52"
ANCHOR_TX = ANCHOR.rpartition(":")[2]
BLOCK_NO = "0x3e4abfc"  # 65317884
BLOCK_HASH = "0x" + "2a" * 32
OTHER_HASH = "0x" + "ee" * 32


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


def arc_node(chain=ARC_CHAIN, index=False, blocks=False, block_hash=BLOCK_HASH, without_anchor=False,
             anchor_tx=None, anchor_receipt=None, settlement=None):
    """One node's view: block BLOCK_NO holds the settlement TX and the anchor transaction.
    ``index`` answers by-hash lookups; ``blocks`` serves the block and its receipts."""
    where = {"blockHash": block_hash, "blockNumber": BLOCK_NO}
    txs = [{"hash": TX, "input": "0x", "value": "0x0", "from": PAYER, **where}]
    receipts = [{**settled(), "transactionHash": TX, **where, **(settlement or {})}]
    if not without_anchor:
        txs.append({"hash": ANCHOR_TX, "input": CALLDATA, "value": "0x0", "chainId": ARC_CHAIN,
                    "from": PAYEE, **where, **(anchor_tx or {})})
        receipts.append({"transactionHash": ANCHOR_TX, "status": "0x1", "logs": [], **where,
                         **(anchor_receipt or {})})

    def by_hash(params):
        return next((t for t in txs if t["hash"] == params[0]), None) if index else None

    def receipt(params):
        return next((r for r in receipts if r["transactionHash"] == params[0]), None) if index else None

    def block(params):
        if blocks and params[0] == BLOCK_NO and params[1] is True:
            return {"number": BLOCK_NO, "hash": block_hash, "transactions": txs}
        return None

    def block_receipts(params):
        return receipts if blocks and params[0] == BLOCK_NO else None

    return {"eth_chainId": chain, "eth_getTransactionByHash": by_hash, "eth_getTransactionReceipt": receipt,
            "eth_getBlockByNumber": block, "eth_getBlockReceipts": block_receipts}


def pruned(**kw):
    """The usual case: the primary serves the block but its transaction index lost the hashes."""
    return arc_node(blocks=True, **kw)


def history(**kw):
    return arc_node(index=True, **kw)


LOCATED = "block located via history RPC rpc.drpc.testnet.arc.network"


def test_history_rpcs_for_arc_testnet():
    assert evm.HISTORY_RPCS["eip155:5042002"] == (
        "https://rpc.drpc.testnet.arc.network",
        "https://arc-testnet.drpc.org",
    )


def test_honest_history_rpc_and_primary_block_pass(nodes):
    log = nodes({PRIMARY: pruned(), DRPC: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "pass"
    assert LOCATED in res.detail
    # The history RPC is only asked for the locator; block data comes from the primary.
    assert [m for url, m in log if url == DRPC] == ["eth_chainId", "eth_getTransactionReceipt"]
    assert (PRIMARY, "eth_getBlockByNumber") in log and (PRIMARY, "eth_getBlockReceipts") in log
    assert not any(url == DRPC_ORG for url, _ in log)


@pytest.mark.parametrize(
    "primary_view,detail",
    [
        ({"anchor_tx": {"input": "0x"}}, "calldata"),
        ({"anchor_tx": {"value": "0x1"}}, "zero-value"),
        ({"anchor_receipt": {"status": "0x0"}}, "reverted"),
    ],
)
def test_checked_fields_come_from_the_primary(nodes, primary_view, detail):
    # The history RPC's own view would pass; the primary's block says otherwise.
    nodes({PRIMARY: pruned(**primary_view), DRPC: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert detail in res.detail


def test_history_rpc_with_another_block_hash_is_rejected(nodes):
    nodes({PRIMARY: pruned(), DRPC: history(block_hash=OTHER_HASH), DRPC_ORG: history(block_hash=OTHER_HASH)})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_located_block_without_the_transaction_on_the_primary_fails(nodes):
    nodes({PRIMARY: pruned(without_anchor=True), DRPC: history(), DRPC_ORG: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_primary_not_serving_the_block_stays_not_found(nodes):
    nodes({PRIMARY: arc_node(), DRPC: history(), DRPC_ORG: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_history_rpc_on_another_chain_is_ignored(nodes):
    nodes({PRIMARY: pruned(), DRPC: history(chain="0x14a34"), DRPC_ORG: arc_node()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_next_history_rpc_after_wrong_chain_a_lie_or_network_error(nodes):
    nodes({PRIMARY: pruned(), DRPC: history(chain="0x1"), DRPC_ORG: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "pass"
    assert "block located via history RPC arc-testnet.drpc.org" in res.detail
    nodes({PRIMARY: pruned(), DRPC: history(block_hash=OTHER_HASH), DRPC_ORG: history()})
    assert check_evm_anchor(ANCHOR, RH).status == "pass"
    nodes({PRIMARY: pruned(), DRPC_ORG: history()})  # DRPC unreachable
    assert check_evm_anchor(ANCHOR, RH).status == "pass"


def test_not_found_on_every_rpc_still_fails(nodes):
    nodes({PRIMARY: pruned(), DRPC: arc_node(), DRPC_ORG: arc_node()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "not found" in res.detail


def test_primary_index_answer_is_never_replaced(nodes):
    log = nodes({PRIMARY: arc_node(index=True, anchor_tx={"input": "0x"}), DRPC: history()})
    res = check_evm_anchor(ANCHOR, RH)
    assert res.status == "fail"
    assert "calldata" in res.detail
    assert not any(url == DRPC for url, _ in log)


def test_primary_rpc_error_stays_unavailable(nodes):
    primary = pruned()
    primary["eth_getTransactionByHash"] = evm.RpcError("down")
    log = nodes({PRIMARY: primary, DRPC: history()})
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


def test_settlement_located_by_a_history_rpc_passes_with_the_primary_receipt(nodes):
    nodes({PRIMARY: pruned(), DRPC: history()})
    res = check_x402_exact(ARC_RECEIPT)
    assert res.status == "pass"
    assert LOCATED in res.detail


def test_settlement_logs_come_from_the_primary(nodes):
    # The history RPC's receipt has the transfer; the primary's receipt in that block doesn't.
    nodes({PRIMARY: pruned(settlement={"logs": [transfer_log(amount=1)]}), DRPC: history()})
    res = check_x402_exact(ARC_RECEIPT)
    assert res.status == "fail"
    assert "no Transfer" in res.detail


def test_settlement_history_rpc_on_another_chain_or_block_is_ignored(nodes):
    nodes({PRIMARY: pruned(), DRPC: history(chain="0x14a34"), DRPC_ORG: history(block_hash=OTHER_HASH)})
    res = check_x402_exact(ARC_RECEIPT)
    assert res.status == "fail"
    assert "not found" in res.detail
