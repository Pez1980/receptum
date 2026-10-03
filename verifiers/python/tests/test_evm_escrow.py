"""escrow:receptum-evm with a mocked JSON-RPC: code identity, trusted registry, terms, status."""

import re

import pytest

from receptum_verify.evm import RpcError
from receptum_verify.evm_escrow import (
    ESCROWS_SELECTOR,
    RECEPTUM_ESCROW_CODE_HASH,
    TRUSTED_EVM_ESCROWS,
    check_evm_escrow,
)
from receptum_verify.hashes import keccak256

from conftest import PACKAGES, RH, bare, escrow_signed

ARTIFACT = PACKAGES / "adapter-evm" / "src" / "artifact.ts"
CONTRACT = "0x20d69c6c647559f48a7e6b0a3f922e99a4068f16"
BUYER = "0x62E5fFEcdc8be558F0a05031242ea1E9D3e921e5"
SELLER = "0x6344D17a80775A71b51A61124767AbCD22B0328B"
EVALUATOR = "0x" + "ee" * 20
TOKEN = "0x3600000000000000000000000000000000000000"
NET = "eip155:5042002"


def deployed_bytecode() -> str:
    m = re.search(r'receptumEscrowDeployedBytecode\s*=\s*"(0x[0-9a-fA-F]+)"', ARTIFACT.read_text())
    assert m, "deployedBytecode not found in artifact.ts"
    return m.group(1)


def test_vendored_code_hash_matches_the_artifact():
    assert keccak256(bytes.fromhex(deployed_bytecode()[2:])).hex() == RECEPTUM_ESCROW_CODE_HASH


def test_trusted_registry_mirrors_the_typescript_verifier():
    src = (PACKAGES / "verify" / "src" / "index.ts").read_text()
    m = re.search(r'"eip155:5042002":\s*\[\s*"(0x[0-9a-fA-F]{40})"\s*\]', src)
    assert m and TRUSTED_EVM_ESCROWS[NET] == (m.group(1).lower(),)


def test_selector():
    assert ESCROWS_SELECTOR == "012f52ee"


def word(v) -> str:
    if isinstance(v, str):
        return v[2:].lower().rjust(64, "0")
    return f"{v:064x}"


def record(**over):
    r = {
        "buyer": BUYER,
        "seller": SELLER,
        "evaluator": "0x" + "00" * 20,
        "token": TOKEN,
        "amount": 2500000,
        "deliverBy": 1_800_000_000,
        "reviewWindow": 600,
        "deliveredAt": 1_799_000_000,
        "status": 3,
        "receiptHash": "0x" + RH,
    }
    r.update(over)
    order = ["buyer", "seller", "evaluator", "token", "amount", "deliverBy", "reviewWindow",
             "deliveredAt", "status", "receiptHash"]
    return "0x" + "".join(word(r[k]) for k in order)


class FakeRpc:
    url = "mock://evm"

    def __init__(self, code=None, data=None, chain="0x4cef52", fail=None):
        self.code = deployed_bytecode() if code is None else code
        self.data = record() if data is None else data
        self.chain = chain
        self.fail = fail
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        if self.fail == method:
            raise RpcError(f"{method}: boom")
        if method == "eth_chainId":
            return self.chain
        if method == "eth_getCode":
            return self.code
        if method == "eth_call":
            assert params[0]["data"] == "0x" + ESCROWS_SELECTOR + f"{1:064x}"
            return self.data
        raise AssertionError(method)


def payment(**over):
    p = {
        "rail": "escrow:receptum-evm",
        "network": NET,
        "asset": TOKEN,
        "amount": "2500000",
        "reference": f"{NET}:{CONTRACT}:1",
        "payer": f"{NET}:{BUYER}",
        "payee": f"{NET}:{SELLER}",
    }
    p.update(over)
    return p


def run(rpc=None, acceptance=None, trusted=(), receipt_hash=RH, **pay):
    p = payment(**pay)
    signed = escrow_signed(p, acceptance, receipt_hash)
    return check_evm_escrow(
        signed, bare(p.get("payer")), bare(p.get("payee")), trusted=trusted, rpc=rpc or FakeRpc()
    )


def test_released_escrow_passes():
    res = run()
    assert res.status == "pass", res.detail


def test_wrong_runtime_code_fails():
    assert run(FakeRpc(code="0x6080")).status == "fail"
    res = run(FakeRpc(code="0x"))
    assert res.status == "fail" and "not ReceptumEscrow" in res.detail


def test_untrusted_deployment_is_pending_unless_trusted():
    other = "0x" + "ab" * 20
    res = run(reference=f"{NET}:{other}:1")
    assert res.status == "pending" and "trusted registry" in res.detail
    assert run(reference=f"{NET}:{other}:1", trusted=[other.upper().replace("0X", "0x")]).status == "pass"


@pytest.mark.parametrize(
    "data,acceptance,needle",
    [
        (record(amount=1), None, "amount differs"),
        (record(token="0x" + "11" * 20), None, "token differs"),
        (record(buyer="0x" + "22" * 20), None, "buyer differs"),
        (record(seller="0x" + "33" * 20), None, "seller differs"),
        (record(reviewWindow=60), None, "review window differs"),
        (record(receiptHash="0x" + "00" * 32), None, "committed receiptHash differs"),
        (record(evaluator=EVALUATOR), None, "evaluator the receipt doesn't declare"),
        (record(), {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"{NET}:{EVALUATOR}"},
         "evaluator differs"),
        (record(evaluator="0x" + "44" * 20),
         {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"{NET}:{EVALUATOR}"},
         "evaluator differs"),
        (record(evaluator=EVALUATOR), {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": "did:web:x.example"},
         "evaluator differs"),
    ],
)
def test_wrong_terms_fail(data, acceptance, needle):
    res = run(FakeRpc(data=data), acceptance)
    assert res.status == "fail" and needle in res.detail, res.detail


def test_matching_evaluator_passes():
    acc = {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"{NET}:{EVALUATOR.upper().replace('0X', '0x')}"}
    assert run(FakeRpc(data=record(evaluator=EVALUATOR)), acc).status == "pass"


def test_wrong_payee_fails():
    res = run(payee=f"{NET}:0x" + "55" * 20)
    assert res.status == "fail" and "seller differs" in res.detail


def test_status_rules():
    assert run(FakeRpc(data=record(status=2))).status == "pending"  # delivered, not released
    for status in (0, 1, 4, 9):
        res = run(FakeRpc(data=record(status=status)))
        assert res.status == "fail" and "not released" in res.detail, res.detail


def test_no_payee_is_unavailable():
    p = payment()
    del p["payee"]
    res = check_evm_escrow(escrow_signed(p), bare(p["payer"]), None, rpc=FakeRpc())
    assert res.status == "unavailable"


def test_malformed_or_foreign_reference_fails_without_rpc():
    rpc = FakeRpc()
    assert run(rpc, reference=f"{NET}:demo-x402").status == "fail"
    assert run(rpc, reference=f"eip155:84532:{CONTRACT}:1").status == "fail"
    assert rpc.calls == []


def test_rpc_problems_are_unavailable():
    assert run(FakeRpc(chain="0x1")).status == "unavailable"
    for method in ("eth_chainId", "eth_getCode", "eth_call"):
        assert run(FakeRpc(fail=method)).status == "unavailable"
    assert run(FakeRpc(data="0x1234")).status == "unavailable"


def test_unsupported_network_is_unavailable():
    p = payment(network="eip155:1", reference=f"eip155:1:{CONTRACT}:1", payer=f"eip155:1:{BUYER}",
                payee=f"eip155:1:{SELLER}")
    assert check_evm_escrow(escrow_signed(p), BUYER, SELLER, rpcs={}).status == "unavailable"
