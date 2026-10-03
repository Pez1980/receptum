"""escrow:receptum-soroban with mocked Soroban RPC: wasm identity, trusted registry, storage
decoding (hand-written XDR), terms and status."""

import base64
import hashlib
import json
import re
import struct

import pytest

from receptum_verify.evm import RpcError
from receptum_verify.soroban import (
    INSTANCE_KEY,
    RECEPTUM_SOROBAN_WASM_HASH,
    TRUSTED_SOROBAN_ESCROWS,
    check_soroban_escrow,
    contract_data_ledger_key,
    decode_contract_data_entry,
    decode_escrow_record,
    encode_sc_address,
    escrow_storage_key,
    parse_soroban_escrow_id,
)
from receptum_verify.stellar import STELLAR_TESTNET_PASSPHRASE

from conftest import PACKAGES, RH, bare, escrow_signed

CONTRACT_DIR = PACKAGES / "adapter-stellar" / "contracts" / "receptum-escrow"
CONTRACT = "CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG"
BUYER = "GAJGU63DDMPR6DU2LVMMFOV5DUSPTHG6PSGV7N3E72TXWMK74ZEOCNWI"
SELLER = "GCKJSBZNHSKEPM7VEM6CQ6RGP2HNNMJOUIEXGYABRSRJVI73K6YDSRIT"
EVALUATOR = "GDRRAY37TFOYGILUQKM4S2ELADCVBOLWUVRDAWCPTS4UOVNVHJX2KQAY"
USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
NET = "stellar:testnet"

# getLedgerEntries replies captured from Soroban testnet (escrow 17: buyer accepted).
LIVE_INSTANCE = "AAAABgAAAAAAAAABCgsyYhIRViwTpnpmBY+BOpwmr99kuqRNQfx2AiVI0CoAAAAUAAAAAQAAABMAAAAADcaxdJUcrRZjCrHWYA5U1LY3jZ0Hb9DQxZNuK8qj3q8AAAABAAAAAQAAABAAAAABAAAAAQAAAA8AAAAGTmV4dElkAAAAAAAFAAAAAAAAABY="
LIVE_ESCROW_17 = "AAAABgAAAAAAAAABCgsyYhIRViwTpnpmBY+BOpwmr99kuqRNQfx2AiVI0CoAAAAQAAAAAQAAAAIAAAAPAAAABkVzY3JvdwAAAAAABQAAAAAAAAARAAAAAQAAABEAAAABAAAACgAAAA8AAAAGYW1vdW50AAAAAAAKAAAAAAAAAAAAAAAAAA9CQAAAAA8AAAAFYnV5ZXIAAAAAAAASAAAAAAAAAAASantjGx8fDppdWMK6vR0k+ZzefI1ft2T+p3sxX+ZI4QAAAA8AAAAKZGVsaXZlcl9ieQAAAAAABQAAAABqwVBiAAAADwAAAAxkZWxpdmVyZWRfYXQAAAAFAAAAAGrBT8wAAAAPAAAACWV2YWx1YXRvcgAAAAAAAAEAAAAPAAAADHJlY2VpcHRfaGFzaAAAAA0AAAAgGs04LZi39igJK4wvBRB7tzi/2caAd8Ea4h5izHR3NqQAAAAPAAAADXJldmlld193aW5kb3cAAAAAAAADAAACWAAAAA8AAAAGc2VsbGVyAAAAAAASAAAAAAAAAACUmQctPJRHs/UjPCh6Jn6O1rEuoglzYAGMopqj+1ewOQAAAA8AAAAGc3RhdHVzAAAAAAADAAAAAwAAAA8AAAAFdG9rZW4AAAAAAAASAAAAAVBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8B"


# --- pins -------------------------------------------------------------------------------------


def test_wasm_hash_matches_the_published_wasm_and_the_typescript_constant():
    assert hashlib.sha256((CONTRACT_DIR / "receptum_escrow.wasm").read_bytes()).hexdigest() == RECEPTUM_SOROBAN_WASM_HASH
    deployment = json.loads((CONTRACT_DIR / "deployment.testnet.json").read_text())
    assert deployment["wasmHash"] == RECEPTUM_SOROBAN_WASM_HASH
    src = (PACKAGES / "adapter-stellar" / "src" / "soroban.ts").read_text()
    assert f'"{RECEPTUM_SOROBAN_WASM_HASH}"' in src
    assert TRUSTED_SOROBAN_ESCROWS[NET] == (deployment["contractId"],)
    ts = (PACKAGES / "verify" / "src" / "index.ts").read_text()
    assert re.search(rf'"stellar:testnet":\s*\[\s*"{deployment["contractId"]}"\s*\]', ts)


def test_live_entries_decode():
    _, _, _, inst = decode_contract_data_entry(LIVE_INSTANCE)
    (kind, wasm), _ = inst.value
    assert kind == "wasm" and wasm.hex() == RECEPTUM_SOROBAN_WASM_HASH
    contract, key, durability, val = decode_contract_data_entry(LIVE_ESCROW_17)
    assert contract == CONTRACT and durability == 1
    e = decode_escrow_record(val)
    assert (e.buyer, e.seller, e.token, e.amount, e.review_window, e.status) == (
        BUYER, SELLER, USDC_SAC, 1000000, 600, "released"
    )
    assert e.evaluator is None and e.receipt_hash == RH


def test_ledger_keys_are_canonical_xdr():
    # The key the RPC echoed for escrow 17.
    entry_key = contract_data_ledger_key(CONTRACT, escrow_storage_key(17))
    raw = base64.b64decode(entry_key)
    assert raw[:4] == struct.pack(">I", 6) and raw[-4:] == struct.pack(">I", 1)
    assert base64.b64decode(LIVE_ESCROW_17)[8:8 + len(raw) - 8] == raw[4:-4]


@pytest.mark.parametrize(
    "ref",
    [
        f"stellar:testnet:{CONTRACT}:0",
        f"stellar:testnet:{CONTRACT}:01",
        f"stellar:testnet:{CONTRACT}:18446744073709551616",
        f"stellar:pubnet:{CONTRACT}:1",
        f"stellar:testnet:{CONTRACT[:-1]}A:1",
        f"stellar:testnet:{CONTRACT}:1\n",
    ],
)
def test_bad_escrow_ids(ref):
    with pytest.raises(ValueError):
        parse_soroban_escrow_id(ref)


# --- an XDR encoder for test records -----------------------------------------------------------


def _opaque(b: bytes) -> bytes:
    return struct.pack(">I", len(b)) + b + b"\0" * (-len(b) % 4)


def sym(s):
    return struct.pack(">I", 15) + _opaque(s.encode())


def u32(v):
    return struct.pack(">II", 3, v)


def u64(v):
    return struct.pack(">IQ", 5, v)


def i128(v):
    return struct.pack(">IqQ", 10, v >> 64, v & ((1 << 64) - 1))


def addr(a):
    return struct.pack(">I", 18) + encode_sc_address(a)


def void():
    return struct.pack(">I", 1)


def bytes_(b):
    return struct.pack(">I", 13) + _opaque(b)


def scmap(fields: dict) -> bytes:
    out = struct.pack(">III", 17, 1, len(fields))
    for k, v in fields.items():
        out += sym(k) + v
    return out


def entry(contract: str, key: bytes, val: bytes) -> str:
    raw = struct.pack(">II", 6, 0) + encode_sc_address(contract) + key + struct.pack(">I", 1) + val
    return base64.b64encode(raw).decode()


def instance(wasm_hash: bytes | None) -> bytes:
    exe = struct.pack(">I", 0) + wasm_hash if wasm_hash is not None else struct.pack(">I", 1)
    return struct.pack(">I", 19) + exe + struct.pack(">I", 0)


def record(**over):
    f = {
        "amount": i128(1000000),
        "buyer": addr(BUYER),
        "deliver_by": u64(1791053922),
        "delivered_at": u64(1791053772),
        "evaluator": void(),
        "receipt_hash": bytes_(bytes.fromhex(RH)),
        "review_window": u32(600),
        "seller": addr(SELLER),
        "status": u32(3),
        "token": addr(USDC_SAC),
    }
    for k, v in over.items():
        if v is None:
            del f[k]
        else:
            f[k] = v
    return scmap(f)


class FakeSoroban:
    def __init__(self, record_xdr=None, wasm=bytes.fromhex(RECEPTUM_SOROBAN_WASM_HASH),
                 passphrase=STELLAR_TESTNET_PASSPHRASE, missing=(), fail=None, contract=CONTRACT):
        self.contract = contract
        self.entries = {
            contract_data_ledger_key(contract, INSTANCE_KEY): entry(
                contract, struct.pack(">I", 20), instance(wasm)
            ),
            contract_data_ledger_key(contract, escrow_storage_key(17)): entry(
                contract, escrow_storage_key(17), record() if record_xdr is None else record_xdr
            ),
        }
        for k in missing:
            key = contract_data_ledger_key(contract, INSTANCE_KEY if k == "instance" else escrow_storage_key(17))
            del self.entries[key]
        self.passphrase = passphrase
        self.fail = fail
        self.calls = []

    def __call__(self, method, params):
        self.calls.append(method)
        if self.fail == method:
            raise RpcError(f"{method}: boom")
        if method == "getNetwork":
            return {"passphrase": self.passphrase}
        if method == "getLedgerEntries":
            (key,) = params["keys"]
            return {"entries": [{"key": key, "xdr": self.entries[key]}] if key in self.entries else [],
                    "latestLedger": 1}
        raise AssertionError(method)


def payment(**over):
    p = {
        "rail": "escrow:receptum-soroban",
        "network": NET,
        "asset": USDC_SAC,
        "amount": "1000000",
        "reference": f"{NET}:{CONTRACT}:17",
        "payer": f"{NET}:{BUYER}",
        "payee": f"{NET}:{SELLER}",
    }
    p.update(over)
    return p


def run(rpc=None, acceptance=None, trusted=(), **pay):
    p = payment(**pay)
    return check_soroban_escrow(
        escrow_signed(p, acceptance), bare(p.get("payer")), bare(p.get("payee")),
        trusted=trusted, call=rpc or FakeSoroban(),
    )


def test_released_escrow_passes():
    assert run().status == "pass"
    # The asset may be named CODE:ISSUER: assets compare by their SAC contract id.
    assert run(asset=USDC).status == "pass"


def test_wrong_wasm_fails():
    res = run(FakeSoroban(wasm=b"\x01" * 32))
    assert res.status == "fail" and "published ReceptumEscrow wasm" in res.detail
    assert run(FakeSoroban(wasm=None)).status == "fail"  # a Stellar Asset Contract


def test_untrusted_deployment_is_pending_unless_trusted():
    other = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    rpc = FakeSoroban(contract=other)
    res = run(rpc, reference=f"{NET}:{other}:17")
    assert res.status == "pending" and "trusted registry" in res.detail
    assert run(FakeSoroban(contract=other), reference=f"{NET}:{other}:17", trusted=[other]).status == "pass"


@pytest.mark.parametrize(
    "rec,acceptance,needle",
    [
        (record(amount=i128(5)), None, "amount differs"),
        (record(token=addr("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC")), None, "token differs"),
        (record(buyer=addr(EVALUATOR)), None, "buyer differs"),
        (record(seller=addr(EVALUATOR)), None, "seller differs"),
        (record(review_window=u32(60)), None, "review window differs"),
        (record(receipt_hash=bytes_(b"\0" * 32)), None, "committed receiptHash differs"),
        (record(receipt_hash=void()), None, "committed receiptHash differs"),
        (record(evaluator=addr(EVALUATOR)), None, "evaluator the receipt doesn't declare"),
        (record(), {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"{NET}:{EVALUATOR}"},
         "evaluator differs"),
    ],
)
def test_wrong_terms_fail(rec, acceptance, needle):
    res = run(FakeSoroban(rec), acceptance)
    assert res.status == "fail" and needle in res.detail, res.detail


def test_matching_evaluator_passes():
    acc = {"mode": "evaluator", "reviewWindowSeconds": 600, "evaluator": f"{NET}:{EVALUATOR}"}
    assert run(FakeSoroban(record(evaluator=addr(EVALUATOR))), acc).status == "pass"


def test_wrong_payee_fails():
    res = run(payee=f"{NET}:{EVALUATOR}")
    assert res.status == "fail" and "seller differs" in res.detail


def test_status_rules():
    assert run(FakeSoroban(record(status=u32(2)))).status == "pending"
    for s in (1, 4):
        res = run(FakeSoroban(record(status=u32(s))))
        assert res.status == "fail" and "not released" in res.detail
    assert run(FakeSoroban(record(status=u32(9)))).status == "fail"  # not a record


@pytest.mark.parametrize(
    "rec",
    [
        record(extra=u32(1)),
        record(token=None),
        record(amount=i128(0)),
        record(amount=u32(5)),
        record(review_window=u64(600)),
        record(receipt_hash=bytes_(b"\0" * 31)),
        record(buyer=u32(1)),
        record(token=addr(BUYER)),
        record(deliver_by=u64(2**60)),
        u32(1),
    ],
)
def test_records_without_the_contract_shape_fail(rec):
    res = run(FakeSoroban(rec))
    assert res.status == "fail" and "not a ReceptumEscrow record" in res.detail, res.detail


def test_unknown_escrow_fails_but_a_missing_instance_is_unavailable():
    res = run(FakeSoroban(missing=["escrow"]))
    assert res.status == "fail" and "unknown escrow" in res.detail
    assert run(FakeSoroban(missing=["instance"])).status == "unavailable"


def test_rpc_problems_are_unavailable():
    assert run(FakeSoroban(passphrase="Public Global Stellar Network ; September 2015")).status == "unavailable"
    assert run(FakeSoroban(fail="getLedgerEntries")).status == "unavailable"
    rpc = FakeSoroban()
    rpc.entries[next(iter(rpc.entries))] = "AAAA"  # truncated XDR
    assert run(rpc).status == "unavailable"


def test_malformed_reference_fails_and_other_networks_are_unavailable():
    rpc = FakeSoroban()
    assert run(rpc, reference=f"{NET}:{CONTRACT}:x").status == "fail"
    assert rpc.calls == []
    p = payment(network="stellar:pubnet", payer=f"stellar:pubnet:{BUYER}", payee=f"stellar:pubnet:{SELLER}")
    assert check_soroban_escrow(escrow_signed(p), BUYER, SELLER, call=rpc).status == "unavailable"


def test_no_payee_is_unavailable():
    p = payment()
    del p["payee"]
    assert check_soroban_escrow(escrow_signed(p), BUYER, None, call=FakeSoroban()).status == "unavailable"
