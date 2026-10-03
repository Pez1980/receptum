#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, EnvTestConfig, Events as _,
        Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    Event as _, IntoVal,
};

const T0: u64 = 1_800_000_000;
const AMOUNT: i128 = 10_000_000;
const DEADLINE: u64 = T0 + 3_600;
const WINDOW: u32 = 600;

struct Setup<'a> {
    env: Env,
    id: Address,
    escrow: ReceptumEscrowClient<'a>,
    token: TokenClient<'a>,
    buyer: Address,
    seller: Address,
    evaluator: Address,
    stranger: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_timestamp(T0);
    env.mock_all_auths();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    let buyer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&buyer, &(AMOUNT * 100));
    let id = env.register(ReceptumEscrow, ());
    let escrow = ReceptumEscrowClient::new(&env, &id);
    Setup {
        seller: Address::generate(&env),
        evaluator: Address::generate(&env),
        stranger: Address::generate(&env),
        env,
        id,
        escrow,
        token,
        buyer,
    }
}

fn hash(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

impl Setup<'_> {
    fn open_with(&self, evaluator: Option<Address>, window: u32) -> u64 {
        self.escrow.open(
            &self.buyer,
            &self.seller,
            &self.token.address,
            &AMOUNT,
            &DEADLINE,
            &window,
            &evaluator,
        )
    }
    fn open(&self) -> u64 {
        self.open_with(None, WINDOW)
    }
    fn at(&self, t: u64) {
        self.env.ledger().set_timestamp(t);
    }
    fn bal(&self, a: &Address) -> i128 {
        self.token.balance(a)
    }
    fn status(&self, id: u64) -> Status {
        self.escrow.get(&id).status
    }
    /// Drop all mocked auths: every require_auth must now be satisfied explicitly.
    fn no_auth(&self) {
        self.env.set_auths(&[]);
    }
    /// Authorize exactly one invocation of `fn_name` on the escrow by `who`.
    fn auth_as(&self, who: &Address, fn_name: &str, args: soroban_sdk::Vec<soroban_sdk::Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

/// A missing or wrong signature aborts in the host (not a contract `Error`).
fn is_auth_error<T, E, C>(r: &Result<T, Result<C, E>>) -> bool {
    matches!(r, Err(Err(_)))
}

// ─── open ──────────────────────────────────────────────────────────────────

#[test]
fn open_locks_funds_and_records_terms() {
    let s = setup();
    let before = s.bal(&s.buyer);
    let id = s.open_with(Some(s.evaluator.clone()), WINDOW);
    // The buyer authorized open, and with it the token transfer into the escrow.
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.buyer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.id.clone(),
                    soroban_sdk::Symbol::new(&s.env, "open"),
                    (
                        s.buyer.clone(),
                        s.seller.clone(),
                        s.token.address.clone(),
                        AMOUNT,
                        DEADLINE,
                        WINDOW,
                        Some(s.evaluator.clone()),
                    )
                        .into_val(&s.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        s.token.address.clone(),
                        soroban_sdk::Symbol::new(&s.env, "transfer"),
                        (s.buyer.clone(), s.id.clone(), AMOUNT).into_val(&s.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );
    assert_eq!(id, 1);
    assert_eq!(s.escrow.next_id(), 2);
    assert_eq!(s.bal(&s.buyer), before - AMOUNT);
    assert_eq!(s.bal(&s.id), AMOUNT);
    let e = s.escrow.get(&id);
    assert_eq!(
        e,
        Escrow {
            buyer: s.buyer.clone(),
            seller: s.seller.clone(),
            evaluator: Some(s.evaluator.clone()),
            token: s.token.address.clone(),
            amount: AMOUNT,
            deliver_by: DEADLINE,
            review_window: WINDOW,
            delivered_at: 0,
            status: Status::Open,
            receipt_hash: None,
        }
    );
    assert_eq!(s.open(), 2);
}

#[test]
fn open_emits_opened_event() {
    let s = setup();
    let id = s.open();
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Opened {
            id,
            buyer: s.buyer.clone(),
            seller: s.seller.clone(),
            token: s.token.address.clone(),
            amount: AMOUNT,
            deliver_by: DEADLINE,
            review_window: WINDOW,
            evaluator: None,
        }
        .to_xdr(&s.env, &s.id)]
    );
}

#[test]
fn open_rejects_bad_arguments() {
    let s = setup();
    let t = &s.token.address;
    let e = &s.escrow;
    let bad = |r: Result<Result<u64, _>, Result<Error, _>>, want: Error| {
        assert_eq!(r.err().unwrap().unwrap(), want);
    };
    bad(
        e.try_open(&s.buyer, &s.seller, t, &0, &DEADLINE, &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.seller, t, &-1, &DEADLINE, &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.buyer, t, &AMOUNT, &DEADLINE, &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.id, t, &AMOUNT, &DEADLINE, &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(
            &s.buyer,
            &s.seller,
            t,
            &AMOUNT,
            &DEADLINE,
            &WINDOW,
            &Some(s.buyer.clone()),
        ),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(
            &s.buyer,
            &s.seller,
            t,
            &AMOUNT,
            &DEADLINE,
            &WINDOW,
            &Some(s.seller.clone()),
        ),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.seller, t, &AMOUNT, &T0, &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.seller, t, &AMOUNT, &(T0 - 1), &WINDOW, &None),
        Error::InvalidArgs,
    );
    bad(
        e.try_open(&s.buyer, &s.seller, t, &AMOUNT, &u64::MAX, &1, &None),
        Error::Overflow,
    );
    bad(
        e.try_open(
            &s.buyer, &s.seller, &s.id, &AMOUNT, &DEADLINE, &WINDOW, &None,
        ),
        Error::UnsupportedToken,
    );
    // Nothing was stored or moved.
    assert_eq!(e.next_id(), 1);
    assert_eq!(s.bal(&s.id), 0);
}

#[test]
fn open_requires_the_buyers_auth() {
    let s = setup();
    s.no_auth();
    let r = s.escrow.try_open(
        &s.buyer,
        &s.seller,
        &s.token.address,
        &AMOUNT,
        &DEADLINE,
        &WINDOW,
        &None,
    );
    assert!(is_auth_error(&r), "{:?}", r);
    // A stranger can't open an escrow funded by the buyer.
    s.auth_as(
        &s.stranger,
        "open",
        (
            s.buyer.clone(),
            s.seller.clone(),
            s.token.address.clone(),
            AMOUNT,
            DEADLINE,
            WINDOW,
            None::<Address>,
        )
            .into_val(&s.env),
    );
    let r = s.escrow.try_open(
        &s.buyer,
        &s.seller,
        &s.token.address,
        &AMOUNT,
        &DEADLINE,
        &WINDOW,
        &None,
    );
    assert!(r.is_err());
    assert_eq!(s.bal(&s.id), 0);
}

#[test]
fn open_fails_when_the_buyer_cannot_pay() {
    let s = setup();
    let poor = Address::generate(&s.env);
    let r = s.escrow.try_open(
        &poor,
        &s.seller,
        &s.token.address,
        &AMOUNT,
        &DEADLINE,
        &WINDOW,
        &None,
    );
    assert!(r.is_err());
    assert_eq!(s.escrow.next_id(), 1);
}

// A token that reports success but moves nothing (or less than asked).
#[contract]
struct LyingToken;
#[contractimpl]
impl LyingToken {
    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

#[test]
fn open_rejects_tokens_that_do_not_deliver_the_amount() {
    let s = setup();
    let liar = s.env.register(LyingToken, ());
    let r = s.escrow.try_open(
        &s.buyer, &s.seller, &liar, &AMOUNT, &DEADLINE, &WINDOW, &None,
    );
    assert_eq!(r.err().unwrap().unwrap(), Error::UnsupportedToken);
    // The failed call rolled back: no escrow exists.
    assert_eq!(s.escrow.next_id(), 1);
    assert_eq!(
        s.escrow.try_get(&1).err().unwrap().unwrap(),
        Error::NotFound
    );
}

// ─── deliver ───────────────────────────────────────────────────────────────

#[test]
fn deliver_records_hash_time_and_event() {
    let s = setup();
    let id = s.open();
    s.at(T0 + 100);
    s.escrow.deliver(&id, &hash(&s.env, 7));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Delivered {
            id,
            receipt_hash: hash(&s.env, 7)
        }
        .to_xdr(&s.env, &s.id)]
    );
    let e = s.escrow.get(&id);
    assert_eq!(e.status, Status::Delivered);
    assert_eq!(e.delivered_at, T0 + 100);
    assert_eq!(e.receipt_hash, Some(hash(&s.env, 7)));
    // Funds are still held.
    assert_eq!(s.bal(&s.id), AMOUNT);
}

#[test]
fn deliver_deadline_boundary() {
    let s = setup();
    let a = s.open();
    let b = s.open();
    s.at(DEADLINE);
    s.escrow.deliver(&a, &hash(&s.env, 1)); // exactly at deliver_by: allowed
    s.at(DEADLINE + 1);
    assert_eq!(
        s.escrow
            .try_deliver(&b, &hash(&s.env, 1))
            .err()
            .unwrap()
            .unwrap(),
        Error::TooLate
    );
}

#[test]
fn deliver_rules() {
    let s = setup();
    let id = s.open();
    assert_eq!(
        s.escrow
            .try_deliver(&id, &hash(&s.env, 0))
            .err()
            .unwrap()
            .unwrap(),
        Error::InvalidArgs
    );
    assert_eq!(
        s.escrow
            .try_deliver(&99, &hash(&s.env, 1))
            .err()
            .unwrap()
            .unwrap(),
        Error::NotFound
    );
    s.escrow.deliver(&id, &hash(&s.env, 1));
    // No redelivery: the first committed hash is final.
    assert_eq!(
        s.escrow
            .try_deliver(&id, &hash(&s.env, 2))
            .err()
            .unwrap()
            .unwrap(),
        Error::BadState
    );
    assert_eq!(s.escrow.get(&id).receipt_hash, Some(hash(&s.env, 1)));
}

#[test]
fn deliver_requires_the_sellers_auth() {
    let s = setup();
    let id = s.open();
    s.no_auth();
    assert!(is_auth_error(&s.escrow.try_deliver(&id, &hash(&s.env, 1))));
    for who in [&s.buyer, &s.stranger, &s.evaluator] {
        s.auth_as(who, "deliver", (id, hash(&s.env, 1)).into_val(&s.env));
        assert!(s.escrow.try_deliver(&id, &hash(&s.env, 1)).is_err());
    }
    s.auth_as(&s.seller, "deliver", (id, hash(&s.env, 1)).into_val(&s.env));
    s.escrow.deliver(&id, &hash(&s.env, 1));
    assert_eq!(s.status(id), Status::Delivered);
}

// ─── accept ────────────────────────────────────────────────────────────────

#[test]
fn buyer_accepts_any_time_after_delivery() {
    let s = setup();
    let id = s.open();
    s.at(T0 + 10);
    s.escrow.deliver(&id, &hash(&s.env, 3));
    // Long after the window and the deadline: acceptance is still allowed.
    s.at(DEADLINE + 10 * WINDOW as u64);
    s.escrow.accept(&id, &s.buyer);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Released {
            id,
            receipt_hash: hash(&s.env, 3),
            by: Some(s.buyer.clone())
        }
        .to_xdr(&s.env, &s.id)]
    );
    assert_eq!(s.status(id), Status::Released);
    assert_eq!(s.bal(&s.seller), AMOUNT);
    assert_eq!(s.bal(&s.id), 0);
}

#[test]
fn evaluator_accepts() {
    let s = setup();
    let id = s.open_with(Some(s.evaluator.clone()), WINDOW);
    s.escrow.deliver(&id, &hash(&s.env, 3));
    s.auth_as(
        &s.evaluator,
        "accept",
        (id, s.evaluator.clone()).into_val(&s.env),
    );
    s.escrow.accept(&id, &s.evaluator);
    assert_eq!(s.bal(&s.seller), AMOUNT);
}

#[test]
fn accept_rules() {
    let s = setup();
    let id = s.open();
    // Not delivered yet.
    assert_eq!(
        s.escrow.try_accept(&id, &s.buyer).err().unwrap().unwrap(),
        Error::BadState
    );
    s.escrow.deliver(&id, &hash(&s.env, 3));
    // Only the buyer or the evaluator, and there is no evaluator here.
    for who in [&s.seller, &s.stranger, &s.evaluator] {
        assert_eq!(
            s.escrow.try_accept(&id, who).err().unwrap().unwrap(),
            Error::NotAllowed
        );
    }
    // `by` must actually authorize: naming the buyer without its signature fails.
    s.auth_as(
        &s.stranger,
        "accept",
        (id, s.buyer.clone()).into_val(&s.env),
    );
    assert!(is_auth_error(&s.escrow.try_accept(&id, &s.buyer)));
    s.no_auth();
    assert!(is_auth_error(&s.escrow.try_accept(&id, &s.buyer)));
    assert_eq!(s.status(id), Status::Delivered);
    assert_eq!(s.bal(&s.id), AMOUNT);
}

// ─── reject ────────────────────────────────────────────────────────────────

#[test]
fn reject_window_boundary() {
    let s = setup();
    let a = s.open();
    let b = s.open();
    s.at(T0 + 50);
    s.escrow.deliver(&a, &hash(&s.env, 1));
    s.escrow.deliver(&b, &hash(&s.env, 2));
    let ends = T0 + 50 + WINDOW as u64;
    s.at(ends - 1);
    s.escrow.reject(&a, &s.buyer); // last second of the window
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Refunded {
            id: a,
            by: Some(s.buyer.clone())
        }
        .to_xdr(&s.env, &s.id)]
    );
    s.at(ends);
    assert_eq!(
        s.escrow.try_reject(&b, &s.buyer).err().unwrap().unwrap(),
        Error::TooLate
    );
    assert_eq!(s.status(a), Status::Refunded);
    assert_eq!(s.status(b), Status::Delivered);
}

#[test]
fn review_window_runs_from_delivery_not_deadline() {
    let s = setup();
    let id = s.open();
    // Deliver at the deadline: the window extends past it.
    s.at(DEADLINE);
    s.escrow.deliver(&id, &hash(&s.env, 1));
    s.at(DEADLINE + WINDOW as u64 - 1);
    assert_eq!(
        s.escrow.try_release(&id).err().unwrap().unwrap(),
        Error::TooEarly
    );
    s.escrow.reject(&id, &s.buyer);
    assert_eq!(s.bal(&s.id), 0);
}

#[test]
fn evaluator_rejects_and_others_cannot() {
    let s = setup();
    let id = s.open_with(Some(s.evaluator.clone()), WINDOW);
    s.escrow.deliver(&id, &hash(&s.env, 1));
    for who in [&s.seller, &s.stranger] {
        assert_eq!(
            s.escrow.try_reject(&id, who).err().unwrap().unwrap(),
            Error::NotAllowed
        );
    }
    s.auth_as(
        &s.stranger,
        "reject",
        (id, s.evaluator.clone()).into_val(&s.env),
    );
    assert!(is_auth_error(&s.escrow.try_reject(&id, &s.evaluator)));
    s.auth_as(
        &s.evaluator,
        "reject",
        (id, s.evaluator.clone()).into_val(&s.env),
    );
    let before = s.bal(&s.buyer);
    s.escrow.reject(&id, &s.evaluator);
    assert_eq!(s.bal(&s.buyer), before + AMOUNT);
    assert_eq!(s.bal(&s.seller), 0);
}

#[test]
fn reject_requires_delivery() {
    let s = setup();
    let id = s.open();
    assert_eq!(
        s.escrow.try_reject(&id, &s.buyer).err().unwrap().unwrap(),
        Error::BadState
    );
}

// ─── release ───────────────────────────────────────────────────────────────

#[test]
fn anyone_releases_after_the_window_without_auth() {
    let s = setup();
    let id = s.open();
    s.at(T0 + 5);
    s.escrow.deliver(&id, &hash(&s.env, 9));
    let ends = T0 + 5 + WINDOW as u64;
    s.no_auth();
    s.at(ends - 1);
    assert_eq!(
        s.escrow.try_release(&id).err().unwrap().unwrap(),
        Error::TooEarly
    );
    s.at(ends);
    s.escrow.release(&id); // no signature needed
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Released {
            id,
            receipt_hash: hash(&s.env, 9),
            by: None
        }
        .to_xdr(&s.env, &s.id)]
    );
    assert!(s.env.auths().is_empty());
    assert_eq!(s.bal(&s.seller), AMOUNT);
    // Rejection is closed once released.
    s.env.mock_all_auths();
    assert_eq!(
        s.escrow.try_reject(&id, &s.buyer).err().unwrap().unwrap(),
        Error::BadState
    );
}

#[test]
fn zero_review_window_releases_immediately_and_cannot_be_rejected() {
    let s = setup();
    let id = s.open_with(None, 0);
    s.escrow.deliver(&id, &hash(&s.env, 1));
    assert_eq!(
        s.escrow.try_reject(&id, &s.buyer).err().unwrap().unwrap(),
        Error::TooLate
    );
    s.escrow.release(&id);
    assert_eq!(s.bal(&s.seller), AMOUNT);
}

#[test]
fn release_requires_delivery() {
    let s = setup();
    let id = s.open();
    s.at(DEADLINE + 10_000);
    assert_eq!(
        s.escrow.try_release(&id).err().unwrap().unwrap(),
        Error::BadState
    );
    assert_eq!(
        s.escrow.try_release(&42).err().unwrap().unwrap(),
        Error::NotFound
    );
}

// ─── refund ────────────────────────────────────────────────────────────────

#[test]
fn anyone_refunds_after_a_missed_deadline() {
    let s = setup();
    let id = s.open();
    let before = s.bal(&s.buyer);
    s.no_auth();
    s.at(DEADLINE);
    assert_eq!(
        s.escrow.try_refund(&id).err().unwrap().unwrap(),
        Error::TooEarly
    );
    s.at(DEADLINE + 1);
    s.escrow.refund(&id);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Refunded { id, by: None }.to_xdr(&s.env, &s.id)]
    );
    assert_eq!(s.bal(&s.buyer), before + AMOUNT);
    assert_eq!(s.status(id), Status::Refunded);
    // A refunded escrow can't be delivered any more.
    s.env.mock_all_auths();
    assert_eq!(
        s.escrow
            .try_deliver(&id, &hash(&s.env, 1))
            .err()
            .unwrap()
            .unwrap(),
        Error::BadState
    );
}

#[test]
fn refund_is_impossible_once_delivered() {
    let s = setup();
    let id = s.open();
    s.escrow.deliver(&id, &hash(&s.env, 1));
    s.at(DEADLINE + 1);
    assert_eq!(
        s.escrow.try_refund(&id).err().unwrap().unwrap(),
        Error::BadState
    );
}

// ─── seller_refund ─────────────────────────────────────────────────────────

#[test]
fn seller_refunds_open_or_delivered() {
    let s = setup();
    let a = s.open();
    let b = s.open();
    let before = s.bal(&s.buyer);
    s.auth_as(&s.seller, "seller_refund", (a,).into_val(&s.env));
    s.escrow.seller_refund(&a);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.id),
        [Refunded {
            id: a,
            by: Some(s.seller.clone())
        }
        .to_xdr(&s.env, &s.id)]
    );
    s.env.mock_all_auths();
    s.escrow.deliver(&b, &hash(&s.env, 1));
    s.at(DEADLINE + 100_000); // even after the window, as long as nobody released it
    s.escrow.seller_refund(&b);
    assert_eq!(s.bal(&s.buyer), before + 2 * AMOUNT);
    assert_eq!(s.bal(&s.seller), 0);
}

#[test]
fn only_the_seller_can_seller_refund() {
    let s = setup();
    let id = s.open();
    for who in [&s.buyer, &s.stranger] {
        s.auth_as(who, "seller_refund", (id,).into_val(&s.env));
        assert!(is_auth_error(&s.escrow.try_seller_refund(&id)));
    }
    s.no_auth();
    assert!(is_auth_error(&s.escrow.try_seller_refund(&id)));
    assert_eq!(s.status(id), Status::Open);
}

// ─── no double spend; conservation ─────────────────────────────────────────

#[test]
fn settled_escrows_are_final() {
    let s = setup();
    let released = s.open();
    let refunded = s.open();
    s.escrow.deliver(&released, &hash(&s.env, 1));
    s.escrow.accept(&released, &s.buyer);
    s.at(DEADLINE + 1);
    s.escrow.refund(&refunded);
    for id in [released, refunded] {
        let e = &s.escrow;
        assert_eq!(
            e.try_accept(&id, &s.buyer).err().unwrap().unwrap(),
            Error::BadState
        );
        assert_eq!(
            e.try_reject(&id, &s.buyer).err().unwrap().unwrap(),
            Error::BadState
        );
        assert_eq!(e.try_release(&id).err().unwrap().unwrap(), Error::BadState);
        assert_eq!(e.try_refund(&id).err().unwrap().unwrap(), Error::BadState);
        assert_eq!(
            e.try_seller_refund(&id).err().unwrap().unwrap(),
            Error::BadState
        );
        assert_eq!(
            e.try_deliver(&id, &hash(&s.env, 2)).err().unwrap().unwrap(),
            Error::BadState
        );
    }
    assert_eq!(s.bal(&s.id), 0);
    assert_eq!(s.bal(&s.seller), AMOUNT);
}

#[test]
fn balances_are_conserved_across_many_escrows() {
    let s = setup();
    let total = s.bal(&s.buyer);
    let ids: std::vec::Vec<u64> = (0..6)
        .map(|_| s.open_with(Some(s.evaluator.clone()), WINDOW))
        .collect();
    let held = |s: &Setup| {
        ids.iter()
            .filter(|id| matches!(s.status(**id), Status::Open | Status::Delivered))
            .count() as i128
            * AMOUNT
    };
    let check = |s: &Setup| {
        assert_eq!(s.bal(&s.id), held(s));
        assert_eq!(s.bal(&s.buyer) + s.bal(&s.seller) + s.bal(&s.id), total);
        assert_eq!(s.bal(&s.evaluator), 0);
        assert_eq!(s.bal(&s.stranger), 0);
    };
    check(&s);
    s.escrow.deliver(&ids[0], &hash(&s.env, 1));
    s.escrow.deliver(&ids[1], &hash(&s.env, 2));
    s.escrow.deliver(&ids[2], &hash(&s.env, 3));
    s.escrow.deliver(&ids[3], &hash(&s.env, 4));
    check(&s);
    s.escrow.accept(&ids[0], &s.evaluator);
    check(&s);
    s.escrow.reject(&ids[1], &s.buyer);
    check(&s);
    s.escrow.seller_refund(&ids[4]);
    check(&s);
    s.at(DEADLINE + 1);
    s.escrow.refund(&ids[5]);
    s.escrow.release(&ids[2]);
    s.escrow.release(&ids[3]);
    check(&s);
    assert_eq!(s.bal(&s.id), 0);
    assert_eq!(s.bal(&s.seller), 3 * AMOUNT);
    assert_eq!(s.bal(&s.buyer), total - 3 * AMOUNT);
}

#[test]
fn escrows_are_isolated() {
    // Settling one escrow never touches another's funds or state.
    let s = setup();
    let a = s.open();
    let b = s.open();
    s.escrow.deliver(&a, &hash(&s.env, 1));
    s.escrow.accept(&a, &s.buyer);
    assert_eq!(s.status(b), Status::Open);
    assert_eq!(s.bal(&s.id), AMOUNT);
    assert_eq!(s.escrow.get(&b).receipt_hash, None);
}
