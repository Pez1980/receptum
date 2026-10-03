"""escrow:stellar-claimable with a mocked Horizon: history-derived delivery (MEMO_HASH + data
entry), settlement by claimant, batch-claim payment allocation, terms."""

import base64
from datetime import datetime, timezone

import pytest

from receptum_verify.stellar import HorizonError
from receptum_verify.stellar_claimable import (
    BatchClaim,
    ClaimPayment,
    allocate_claim_payments,
    check_stellar_claimable,
    parse_balance_id,
    parse_escrow_terms,
)

from conftest import RH, bare, escrow_signed
from test_stellar import FakeHorizon, collection

BUYER = "GAJGU63DDMPR6DU2LVMMFOV5DUSPTHG6PSGV7N3E72TXWMK74ZEOCNWI"
SELLER = "GCKJSBZNHSKEPM7VEM6CQ6RGP2HNNMJOUIEXGYABRSRJVI73K6YDSRIT"
OTHER = "GDRRAY37TFOYGILUQKM4S2ELADCVBOLWUVRDAWCPTS4UOVNVHJX2KQAY"
USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
BAL = "00000000" + "38" * 32
BAL2 = "00000000" + "cf" * 32
CREATED = 1791048857  # 17:34:17Z
DEADLINE = 1791048942
RELEASE = 1791049002  # 60 s review window
NET = "stellar:testnet"


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def b64(hexstr):
    return base64.b64encode(bytes.fromhex(hexstr)).decode()


def claimants(buyer=BUYER, seller=SELLER, deadline=DEADLINE, release=RELEASE):
    ab = lambda t: {"abs_before": iso(t), "abs_before_epoch": str(t)}  # noqa: E731
    return [
        {"destination": seller, "predicate": {"not": ab(release)}},
        {"destination": buyer, "predicate": {"and": [{"not": ab(deadline)}, ab(release)]}},
    ]


def create_op(bal=BAL, amount="1.0000000", asset=USDC, cl=None):
    return {"type": "create_claimable_balance", "transaction_hash": f"create-{bal[-4:]}",
            "transaction_successful": True, "asset": asset, "amount": amount,
            "claimants": cl or claimants()}


def delivery_tx(h, memo=RH, at=CREATED + 30, value=None, successful=True, memo_type="hash", name=None):
    tx = {"hash": h, "successful": successful, "created_at": iso(at), "memo_type": memo_type,
          "memo": b64(memo)}
    ops = [{"type": "manage_data", "source_account": SELLER, "name": name or BAL[8:],
            "value": b64(value or memo)}]
    return tx, ops


class Chain:
    """A tiny Horizon world for one (or two) escrow balances."""

    def __init__(self):
        self.routes = {}
        self.ops = {BAL: [create_op()]}
        self.seller_txs = []
        self.set_create_tx(BAL)

    def set_create_tx(self, bal):
        self.routes[f"/transactions/create-{bal[-4:]}"] = {
            "hash": f"create-{bal[-4:]}", "created_at": iso(CREATED), "paging_token": "100"}

    def deliver(self, *args, **kw):
        tx, ops = delivery_tx(*args, **kw)
        self.seller_txs.append(tx)
        self.routes[f"/transactions/{tx['hash']}/operations"] = collection(ops)
        return self

    def claim(self, claimant, payments=(), extra_claims=(), tx="claim-tx"):
        rec = {"type": "claim_claimable_balance", "transaction_hash": tx, "transaction_successful": True,
               "balance_id": BAL, "claimant": claimant}
        self.ops[BAL].append(rec)
        ops = [rec, *extra_claims, *[{"type": "payment", **p} for p in payments]]
        self.routes[f"/transactions/{tx}/operations"] = collection(ops)
        return self

    def fetch(self):
        routes = dict(self.routes)
        for bal, ops in self.ops.items():
            routes[f"/claimable_balances/{bal}/operations"] = collection(ops)
        # Seller history in pages of two, chained by next links.
        pages = [self.seller_txs[i:i + 2] for i in range(0, len(self.seller_txs), 2)] or [[]]
        for i, page in enumerate(pages):
            path = f"/accounts/{SELLER}/transactions" if i == 0 else f"/page{i}"
            nxt = f"https://horizon.test/page{i + 1}"
            routes[path] = collection(page, nxt)
        routes[f"/page{len(pages)}"] = collection([])
        return FakeHorizon(routes)


def pay(frm=BUYER, to=SELLER, amount="1.0000000", code="USDC"):
    return {"from": frm, "to": to, "amount": amount, "asset_type": "credit_alphanum4",
            "asset_code": code, "asset_issuer": USDC.split(":")[1]}


def payment(**over):
    p = {"rail": "escrow:stellar-claimable", "network": NET, "asset": USDC, "amount": "10000000",
         "reference": BAL, "payer": f"{NET}:{BUYER}", "payee": f"{NET}:{SELLER}"}
    p.update(over)
    return p


def run(chain, acceptance=None, max_history=1000, **over):
    p = payment(**over)
    acc = acceptance or {"mode": "auto", "reviewWindowSeconds": 60}
    return check_stellar_claimable(escrow_signed(p, acc), bare(p.get("payer")), bare(p.get("payee")),
                                   fetch=chain.fetch(), max_history=max_history)


# --- settlement --------------------------------------------------------------------------------


def test_seller_release_passes():
    res = run(Chain().deliver("d1").claim(SELLER))
    assert res.status == "pass" and "(seller)" in res.detail and "d1" in res.detail


def test_buyer_acceptance_passes():
    res = run(Chain().deliver("d1").claim(BUYER, [pay()]), {"mode": "buyer", "reviewWindowSeconds": 60})
    assert res.status == "pass" and "buyer-acceptance" in res.detail


def test_buyer_claim_without_payment_is_a_refund():
    res = run(Chain().deliver("d1").claim(BUYER), {"mode": "buyer", "reviewWindowSeconds": 60})
    assert res.status == "fail" and "refunded" in res.detail
    for wrong in (pay(amount="0.9999999"), pay(to=OTHER), pay(frm=OTHER), pay(code="USDT")):
        assert run(Chain().deliver("d1").claim(BUYER, [wrong])).status == "fail"


def test_one_payment_backs_only_one_batch_claimed_escrow():
    # Two escrows from the same buyer to the same seller, claimed together, paid once: the
    # earlier claim in operation order takes the payment; ours is refunded.
    chain = Chain()
    chain.ops[BAL2] = [create_op(BAL2)]
    chain.set_create_tx(BAL2)
    other_claim = {"type": "claim_claimable_balance", "balance_id": BAL2, "claimant": BUYER,
                   "transaction_hash": "claim-tx"}
    chain.deliver("d1")
    rec = {"type": "claim_claimable_balance", "transaction_hash": "claim-tx",
           "transaction_successful": True, "balance_id": BAL, "claimant": BUYER}
    chain.ops[BAL].append(rec)
    chain.routes["/transactions/claim-tx/operations"] = collection(
        [other_claim, rec, {"type": "payment", **pay()}]
    )
    assert run(chain).status == "fail"
    # With a second payment both are accepted.
    chain.routes["/transactions/claim-tx/operations"] = collection(
        [other_claim, rec, {"type": "payment", **pay()}, {"type": "payment", **pay()}]
    )
    assert run(chain).status == "pass"


def test_allocation_skips_non_buyer_claims_and_reuses_nothing():
    claims = [BatchClaim("a", BUYER, BUYER, SELLER, USDC, "1"), BatchClaim("b", BUYER, BUYER, SELLER, USDC, "1"),
              BatchClaim("c", SELLER, BUYER, SELLER, USDC, "1")]
    pays = [ClaimPayment(BUYER, SELLER, USDC, "1.0000000")]
    assert allocate_claim_payments(claims, pays) == {"a": 0}


def test_claim_by_a_stranger_is_unavailable():
    assert run(Chain().deliver("d1").claim(OTHER)).status == "unavailable"


# --- delivery ----------------------------------------------------------------------------------


def test_delivered_but_unclaimed_is_pending_and_undelivered_fails():
    assert run(Chain().deliver("d1")).status == "pending"
    res = run(Chain())
    assert res.status == "fail" and "no delivery anchor" in res.detail


def test_first_delivery_wins():
    chain = Chain().deliver("d1", memo="ab" * 32).deliver("d2").claim(SELLER)
    res = run(chain)
    assert res.status == "fail" and "no delivery anchor" in res.detail


def test_delivery_at_or_after_the_deadline_is_ignored():
    assert run(Chain().deliver("late", at=DEADLINE).claim(SELLER)).status == "fail"


def test_memo_without_matching_data_entry_is_ignored():
    for chain in (
        Chain().deliver("d1", value="00" * 32).claim(SELLER),  # entry holds another hash
        Chain().deliver("d1", name="00" * 32).claim(SELLER),  # entry for another balance
        Chain().deliver("d1", memo_type="text").claim(SELLER),
        Chain().deliver("d1", successful=False).claim(SELLER),
    ):
        assert run(chain).status == "fail"
    chain = Chain().deliver("d1")
    chain.routes["/transactions/d1/operations"]["_embedded"]["records"][0]["source_account"] = OTHER
    assert run(chain.claim(SELLER)).status == "fail"


def test_delivery_on_a_later_page_is_found():
    chain = Chain().deliver("x1", memo="01" * 32, memo_type="text").deliver("x2", memo="02" * 32, memo_type="text")
    assert run(chain.deliver("d1").claim(SELLER)).status == "pass"


def test_truncated_history_is_unavailable():
    chain = Chain().deliver("x1", memo_type="text").deliver("x2", memo_type="text").deliver("d1").claim(SELLER)
    res = run(chain, max_history=2)
    assert res.status == "unavailable"


def test_horizon_errors_are_unavailable():
    chain = Chain().deliver("d1").claim(SELLER)
    fetch = chain.fetch()
    fetch.routes[f"/accounts/{SELLER}/transactions"] = HorizonError("down")
    p = payment()
    res = check_stellar_claimable(escrow_signed(p, {"mode": "auto", "reviewWindowSeconds": 60}),
                                  BUYER, SELLER, fetch=fetch)
    assert res.status == "unavailable"


# --- terms -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "over,acceptance,needle",
    [
        ({"amount": "1"}, None, "amount differs"),
        ({"asset": "native"}, None, "asset differs"),
        ({"payer": f"{NET}:{OTHER}"}, None, "buyer differs"),
        ({"payee": f"{NET}:{OTHER}"}, None, "seller differs"),
        ({}, {"mode": "auto", "reviewWindowSeconds": 61}, "review window differs"),
        ({}, {"mode": "evaluator", "reviewWindowSeconds": 60, "evaluator": f"{NET}:{OTHER}"}, "can't enforce an evaluator"),
    ],
)
def test_wrong_terms_fail(over, acceptance, needle):
    res = run(Chain().deliver("d1").claim(SELLER), acceptance, **over)
    assert res.status == "fail" and needle in res.detail, res.detail


def test_asset_by_contract_id_matches():
    assert run(Chain().deliver("d1").claim(SELLER), asset="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA").status == "pass"


def test_no_payee_is_unavailable():
    p = payment()
    del p["payee"]
    res = check_stellar_claimable(escrow_signed(p, {"mode": "auto", "reviewWindowSeconds": 60}),
                                  BUYER, None, fetch=Chain().deliver("d1").claim(SELLER).fetch())
    assert res.status == "unavailable"


def test_unknown_escrow_fails_and_non_receptum_balances_are_unavailable():
    res = run(Chain(), reference="00000000" + "99" * 32)
    assert res.status == "fail" and "unknown escrow" in res.detail
    chain = Chain()
    chain.ops[BAL] = [create_op(cl=[{"destination": SELLER, "predicate": {"unconditional": True}}])]
    assert run(chain).status == "unavailable"


def test_escrow_ids():
    assert parse_balance_id(BAL.upper()) == BAL
    assert parse_balance_id("BAAM7FVFDUSXSVCCZUF42D7O2VCLA32COX2RFG2BCOULE3AGWINEYLEVEQ") == (
        "00000000cf96a51d25795442cd0bcd0feed544b06f4275f5129b4113a8b26c06b21a4c2c"
    )
    for bad in ("01000000" + "00" * 32, BAL[:-2], "B" + "A" * 57):
        with pytest.raises(ValueError):
            parse_balance_id(bad)
    # As for the TypeScript verifier, a malformed reference is undecided, not a contradiction.
    assert run(Chain(), reference="nope").status == "unavailable"


@pytest.mark.parametrize(
    "cl",
    [
        claimants(release=DEADLINE),  # empty buyer window
        claimants(buyer=SELLER),  # same party
        claimants()[:1],
        [claimants()[0], {"destination": BUYER, "predicate": {"and": [{"not": {"abs_before": iso(DEADLINE)}}, {"abs_before": iso(RELEASE + 1)}]}}],
    ],
)
def test_terms_need_the_exact_receptum_shape(cl):
    with pytest.raises(ValueError):
        parse_escrow_terms(cl)


def test_terms_without_epoch_use_the_timestamp():
    cl = [
        {"destination": SELLER, "predicate": {"not": {"abs_before": iso(RELEASE)}}},
        {"destination": BUYER, "predicate": {"and": [{"abs_before": iso(RELEASE)}, {"not": {"abs_before": iso(DEADLINE)}}]}},
    ]
    t = parse_escrow_terms(cl)
    assert (t.buyer, t.seller, t.deadline, t.release_at) == (BUYER, SELLER, DEADLINE, RELEASE)
