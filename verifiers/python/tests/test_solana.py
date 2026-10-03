"""Solana rails (SPEC §4.1, §7.1, §7.3) against a fake JSON-RPC."""

import base64
import copy
import hashlib
import struct
from pathlib import Path

import pytest

from receptum_verify import solana
from receptum_verify.evm import RpcError
from receptum_verify.solana import (
    RECEPTUM_SOLANA_PROGRAM_ID,
    SOLANA_DEVNET,
    b58decode,
    b58encode,
    check_solana_anchor,
    check_solana_escrow,
    check_solana_x402_exact,
    find_program_address,
    is_on_curve,
)

GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1y1MCnvwMbRuv"
USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
SIG = b58encode(bytes([7]) * 64)
PAYER = b58encode(bytes([1]) * 32)
PAYEE = b58encode(bytes([2]) * 32)
SRC = b58encode(bytes([3]) * 32)
DST = b58encode(bytes([4]) * 32)
FEE = b58encode(bytes([5]) * 32)
HASH = "ab" * 32
RPCS = {SOLANA_DEVNET: "http://fake"}
REPO = Path(__file__).resolve().parents[3]


def fake(monkeypatch, handlers):
    def call(self, method, params):
        if method == "getGenesisHash":
            return handlers.get("getGenesisHash", lambda p: GENESIS)(params)
        if method not in handlers:
            raise RpcError(f"unexpected {method}")
        return handlers[method](params)

    monkeypatch.setattr(solana.JsonRpc, "call", call)


def bal(i, owner, amount):
    return {"accountIndex": i, "mint": USDC, "owner": owner, "uiTokenAmount": {"amount": amount, "decimals": 6}}


def x402_tx(amount="10000", dest=DST, err=None, post="10000"):
    return {
        "slot": 123,
        "meta": {
            "err": err,
            "preTokenBalances": [bal(1, PAYER, "5000000"), bal(2, PAYEE, "0")],
            "postTokenBalances": [bal(1, PAYER, "4990000"), bal(2, PAYEE, post)],
            "innerInstructions": [],
        },
        "transaction": {
            "signatures": [SIG],
            "message": {
                "accountKeys": [{"pubkey": k} for k in (FEE, SRC, DST)],
                "instructions": [
                    {
                        "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                        "program": "spl-token",
                        "parsed": {
                            "type": "transferChecked",
                            "info": {
                                "source": SRC,
                                "destination": dest,
                                "mint": USDC,
                                "tokenAmount": {"amount": amount, "decimals": 6},
                            },
                        },
                    },
                    {
                        "programId": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
                        "program": "spl-memo",
                        "parsed": f"receptum/1:{HASH}",
                    },
                ],
            },
        },
    }


RECEIPT = {
    "payment": {
        "rail": "x402:exact",
        "network": SOLANA_DEVNET,
        "asset": USDC,
        "amount": "10000",
        "reference": SIG,
        "payee": f"{SOLANA_DEVNET}:{PAYEE}",
        "payer": f"{SOLANA_DEVNET}:{PAYER}",
    }
}


def with_payment(**over):
    r = copy.deepcopy(RECEIPT)
    r["payment"].update(over)
    return r


def test_base58_and_curve():
    for b in (bytes(32), b"\0\0\1\2", b"\xff" * 64):
        assert b58decode(b58encode(b)) == b
    pda, _ = find_program_address([b"x"], RECEPTUM_SOLANA_PROGRAM_ID)
    assert not is_on_curve(b58decode(pda))
    # The ATA Circle's faucet created on devnet (owner, token program, mint).
    ata, _ = find_program_address(
        [
            b58decode("H1QWkpBSkGndggiLQqu7Eosuupu6oxFFzHK5HofUf4yc"),
            b58decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            b58decode(USDC),
        ],
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    )
    assert ata == "JBj9Wa3frnoxP3qG8MjAp49C8NP4y6WerSjNdaoCSEoq"


def test_x402_pass(monkeypatch):
    fake(monkeypatch, {"getTransaction": lambda p: x402_tx()})
    r = check_solana_x402_exact(RECEIPT, RPCS)
    assert r.status == "pass" and "(finalized)" in r.detail


@pytest.mark.parametrize(
    "tx", [x402_tx(amount="9999"), x402_tx(dest=SRC), x402_tx(err={"x": 1}), x402_tx(post="20000")]
)
def test_x402_fail(monkeypatch, tx):
    fake(monkeypatch, {"getTransaction": lambda p: tx})
    assert check_solana_x402_exact(RECEIPT, RPCS).status == "fail"


def test_x402_wrong_payer_fails(monkeypatch):
    fake(monkeypatch, {"getTransaction": lambda p: x402_tx()})
    assert check_solana_x402_exact(with_payment(payer=f"{SOLANA_DEVNET}:{PAYEE}"), RPCS).status == "fail"


@pytest.mark.parametrize(
    "over",
    [
        {"reference": "0x" + "ab" * 32},
        {"asset": "USDC"},
        {"amount": "1.5"},
        {"payee": f"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{PAYEE}"},
    ],
)
def test_x402_malformed_fails_offline(monkeypatch, over):
    fake(monkeypatch, {})
    assert check_solana_x402_exact(with_payment(**over), RPCS).status == "fail"


def test_x402_unavailable(monkeypatch):
    r = with_payment()
    del r["payment"]["payee"]
    fake(monkeypatch, {})
    assert check_solana_x402_exact(r, RPCS).status == "unavailable"
    fake(monkeypatch, {"getGenesisHash": lambda p: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"})
    assert check_solana_x402_exact(RECEIPT, RPCS).status == "unavailable"
    fake(monkeypatch, {"getTransaction": lambda p: None})
    assert check_solana_x402_exact(RECEIPT, RPCS).status == "unavailable"
    assert check_solana_x402_exact(RECEIPT, {}).status == "unavailable"


def test_anchor(monkeypatch):
    fake(monkeypatch, {"getTransaction": lambda p: x402_tx()})
    assert check_solana_anchor(SOLANA_DEVNET, SIG, HASH, RPCS).status == "pass"
    assert check_solana_anchor(SOLANA_DEVNET, SIG, "cd" * 32, RPCS).status == "fail"
    assert check_solana_anchor(SOLANA_DEVNET, "abc", HASH, RPCS).status == "fail"
    fake(monkeypatch, {"getTransaction": lambda p: x402_tx(err="x")})
    assert check_solana_anchor(SOLANA_DEVNET, SIG, HASH, RPCS).status == "fail"
    fake(monkeypatch, {"getTransaction": lambda p: None})
    assert check_solana_anchor(SOLANA_DEVNET, SIG, HASH, RPCS).status == "fail"


# --- escrow ----------------------------------------------------------------------

SO = (REPO / "packages" / "adapter-solana" / "program" / "receptum_escrow.so").read_bytes()
PROGRAM_DATA = b58encode(bytes([8]) * 32)
ESCROW_ID = 42
ESCROW, BUMP = find_program_address([b"escrow", b58decode(PAYER), struct.pack("<Q", ESCROW_ID)], RECEPTUM_SOLANA_PROGRAM_ID)
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"


def program_account():
    return struct.pack("<I", 2) + bytes([8]) * 32


def program_data(authority=None, so=SO):
    head = struct.pack("<I", 3) + bytes(8) + (b"\1" + authority if authority else bytes(33))
    return head + so + bytes(1000)


def escrow_data(status=3, h=HASH, evaluator=None):
    vault, vbump = find_program_address([b"vault", b58decode(ESCROW)], RECEPTUM_SOLANA_PROGRAM_ID)
    d = bytearray(272)
    d[0:8] = b"rcptesc1"
    d[8], d[9], d[10], d[11] = 1, status, BUMP, vbump
    d[12:44] = b58decode(PAYER)
    d[44:76] = b58decode(PAYEE)
    if evaluator:
        d[76:108] = b58decode(evaluator)
    d[108:140] = b58decode(USDC)
    d[140:172] = b58decode(vault)
    struct.pack_into("<QQqIq", d, 204, ESCROW_ID, 2_500_000, 1_800_003_600, 600, 1_800_000_100)
    d[240:272] = bytes.fromhex(h)
    return bytes(d)


def chain(monkeypatch, escrow=None, pdata=None):
    accounts = {
        RECEPTUM_SOLANA_PROGRAM_ID: (LOADER, program_account(), True),
        PROGRAM_DATA: (LOADER, pdata if pdata is not None else program_data(), False),
        ESCROW: (RECEPTUM_SOLANA_PROGRAM_ID, escrow if escrow is not None else escrow_data(), False),
    }

    def info(params):
        a = accounts.get(params[0])
        if not a:
            return {"value": None}
        owner, data, executable = a
        return {"value": {"owner": owner, "executable": executable, "lamports": 1, "data": [base64.b64encode(data).decode(), "base64"]}}

    fake(monkeypatch, {"getAccountInfo": info})


def signed(acceptance=None, **over):
    pay = {
        "rail": "escrow:receptum-solana",
        "network": SOLANA_DEVNET,
        "asset": USDC,
        "amount": "2500000",
        "reference": f"{SOLANA_DEVNET}:{RECEPTUM_SOLANA_PROGRAM_ID}:{ESCROW}",
        "payer": f"{SOLANA_DEVNET}:{PAYER}",
        "payee": f"{SOLANA_DEVNET}:{PAYEE}",
        **over,
    }
    return {
        "receiptHash": HASH,
        "receipt": {"acceptance": acceptance or {"mode": "buyer", "reviewWindowSeconds": 600}, "payment": pay},
    }


def run(s, trusted=(RECEPTUM_SOLANA_PROGRAM_ID,)):
    pay = s["receipt"]["payment"]
    payer = pay["payer"].rpartition(":")[2]
    payee = pay["payee"].rpartition(":")[2] if pay["payee"].startswith(SOLANA_DEVNET) else False
    return check_solana_escrow(s, payer, payee, trusted=trusted, rpcs=RPCS)


def test_escrow_pass(monkeypatch):
    chain(monkeypatch)
    assert run(signed()).status == "pass"


def test_escrow_pending(monkeypatch):
    chain(monkeypatch, escrow=escrow_data(status=2))
    assert run(signed()).status == "pending"
    chain(monkeypatch)
    assert run(signed(), trusted=()).status == "pending"
    chain(monkeypatch, pdata=program_data(authority=bytes([9]) * 32))
    r = run(signed())
    assert r.status == "pending" and "upgradeable" in r.detail


EV = f"{SOLANA_DEVNET}:{FEE}"


@pytest.mark.parametrize(
    "case",
    [
        (signed(), {"escrow": escrow_data(status=4)}),
        (signed(), {"escrow": escrow_data(h="cd" * 32)}),
        (signed(amount="1"), {}),
        (signed(payee=f"{SOLANA_DEVNET}:{PAYER}"), {}),
        (signed({"mode": "buyer", "reviewWindowSeconds": 601}), {}),
        (signed({"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": EV}), {}),
        (signed(), {"escrow": escrow_data(evaluator=FEE)}),
        (signed(), {"pdata": program_data(so=b"not the build")}),
        (signed(reference="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:nope"), {}),
    ],
)
def test_escrow_fail(monkeypatch, case):
    s, over = case
    chain(monkeypatch, **over)
    r = run(s)
    assert r.status == "fail", r.detail


def test_escrow_evaluator(monkeypatch):
    chain(monkeypatch, escrow=escrow_data(evaluator=FEE))
    assert run(signed({"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": EV})).status == "pass"


def test_published_build_hash():
    assert hashlib.sha256(SO.rstrip(b"\0")).hexdigest() == solana.RECEPTUM_SOLANA_PROGRAM_HASH
