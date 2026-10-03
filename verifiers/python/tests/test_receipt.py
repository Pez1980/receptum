import copy

import pytest

from receptum_verify import validate_receipt

from conftest import VECTORS, load_json

BASE = load_json(VECTORS)["vectors"][0]["receipt"]
EVAL = load_json(VECTORS)["vectors"][1]["receipt"]


def mutate(base, path, value, delete=False):
    r = copy.deepcopy(base)
    obj = r
    for key in path[:-1]:
        obj = obj[key]
    if delete:
        del obj[path[-1]]
    else:
        obj[path[-1]] = value
    return r


VALID = [
    (("deliveredAt",), "2026-10-04T12:00:00Z"),
    (("deliveredAt",), "2024-02-29T23:59:59.123456789Z"),
    (("receiptId",), "RCPT-0000-ZZZZ"),
    (("acceptance", "reviewWindowSeconds"), 0),
    (("acceptance", "reviewWindowSeconds"), 3.0),  # JSON cannot tell 3 from 3.0
    (("payment", "amount"), "0"),
    (("payment", "payee"), "eip155:84532:0x6344D17a80775A71b51A61124767AbCD22B0328B"),
    (("buyer",), {"id": "did:web:buyer.example"}),
    (("seller", "id"), "eip155:84532:0x6344D17a80775A71b51A61124767AbCD22B0328B"),
    (("remedy",), {"kind": "terms", "termsSha256": "a" * 64}),
    (("evidence",), {}),
]


@pytest.mark.parametrize("path,value", VALID)
def test_valid_variants(path, value):
    assert validate_receipt(mutate(BASE, path, value)) == []


INVALID = [
    (("version",), "receptum/2"),
    (("receiptId",), "RCPT-7F3A-21C"),
    (("receiptId",), "RCPT-7F3A-21CI"),  # I is not Crockford
    (("receiptId",), "RCPT-7F3A-21CU"),
    (("receiptId",), "rcpt-7f3a-21c9"),
    (("jobIdHash",), "462C22C8DABDACBA3DF2FBB9F3AF81B142C87A5087333EDC229A3B9CD03F2CEF"),
    (("jobIdHash",), "00"),
    (("seller", "id"), "did:web:render.example"),
    (("seller", "id"), "did:key:z6DtABC"),
    (("seller", "id"), BASE["seller"]["id"][:-1]),  # truncated key
    (("seller", "name"), ""),
    (("seller", "name"), None),
    (("seller", "extra"), "x"),
    (("buyer",), {"id": "alice@example.com"}),
    (("buyer",), None),
    (("inputSha256",), []),
    (("inputSha256",), "a" * 64),
    (("inputSha256",), ["A" * 64]),
    (("outputSha256",), "g" * 64),
    (("evidence",), {"qaReport": "x"}),
    (("payment", "network"), "base-sepolia"),
    (("payment", "amount"), 2500000),
    (("payment", "amount"), "-1"),
    (("payment", "amount"), "01"),
    (("payment", "amount"), "1.5"),
    (("payment", "amount"), "1e6"),
    (("payment", "rail"), ""),
    (("payment", "payee"), "0x6344D17a80775A71b51A61124767AbCD22B0328B"),
    (("payment", "payer"), None),
    (("payment", "memo"), "hi"),
    (("acceptance", "mode"), "manual"),
    (("acceptance", "reviewWindowSeconds"), -1),
    (("acceptance", "reviewWindowSeconds"), 1.5),
    (("acceptance", "reviewWindowSeconds"), True),
    (("acceptance", "reviewWindowSeconds"), "60"),
    (("acceptance", "reviewWindowSeconds"), 2**53),
    (("acceptance", "mode"), "evaluator"),  # evaluator missing
    (("remedy", "kind"), "terms"),  # termsSha256 missing
    (("remedy", "kind"), "apology"),
    (("remedy", "withinDays"), 1.5),
    (("supersedes",), None),
    (("supersedes",), "abc"),
    (("deliveredAt",), "2026-10-04T12:00:00.000+00:00"),
    (("deliveredAt",), "2026-10-04t12:00:00Z"),
    (("deliveredAt",), "2026-10-04T12:00:00z"),
    (("deliveredAt",), "2026-10-04 12:00:00Z"),
    (("deliveredAt",), "2026-10-04T12:00:00.Z"),
    (("deliveredAt",), "2026-02-30T12:00:00Z"),
    (("deliveredAt",), "2026-10-04T24:00:00Z"),
    (("deliveredAt",), "2026-10-04T12:00:60Z"),
    (("deliveredAt",), "2026-10-04T12:00Z"),
    (("deliveredAt",), 1791115200),
    (("extra",), 1),
]


@pytest.mark.parametrize("path,value", INVALID, ids=[f"{'.'.join(p)}={v!r}"[:60] for p, v in INVALID])
def test_invalid_variants(path, value):
    assert validate_receipt(mutate(BASE, path, value)) != []


@pytest.mark.parametrize(
    "path", [("version",), ("receiptId",), ("seller",), ("payment", "reference"), ("deliveredAt",)]
)
def test_missing_required(path):
    assert validate_receipt(mutate(BASE, path, None, delete=True)) != []


def test_evaluator_identity():
    assert validate_receipt(EVAL) == []
    assert validate_receipt(mutate(EVAL, ("acceptance", "evaluator"), "")) != []
    assert validate_receipt(mutate(EVAL, ("acceptance", "evaluator"), None, delete=True)) != []


def test_not_an_object():
    assert validate_receipt([]) != []
    assert validate_receipt(None) != []
