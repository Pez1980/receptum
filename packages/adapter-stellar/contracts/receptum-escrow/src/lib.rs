//! ReceptumEscrow for Soroban.
//!
//! Holds a token payment (normally a Stellar Asset Contract such as testnet USDC) for one job
//! until the seller delivers and the delivery is accepted. The seller commits the Receptum
//! `receiptHash` on delivery; the hash is the on-chain anchor for the signed receipt (RRF v1,
//! docs/SPEC.md §7). Same state machine as the EVM `ReceptumEscrow`:
//!
//! ```text
//! open ──deliver (seller, ≤ deliver_by)──▶ delivered ──accept (buyer/evaluator, any time)──▶ released
//!  │                                          │      ──release (anyone, ≥ delivered_at + window)──▶ released
//!  │                                          │      ──reject (buyer/evaluator, < delivered_at + window)──▶ refunded
//!  │                                          └──────seller_refund (seller)──▶ refunded
//!  ├──refund (anyone, > deliver_by)──▶ refunded
//!  └──seller_refund (seller)──▶ refunded
//! ```
//!
//! Funds only ever move to the escrow's buyer or seller.
//!
//! **Unaudited. Testnet use only until an independent audit is published.**
#![no_std]
// `open` mirrors the EVM signature; the contract macros generate wrappers with the same arity.
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The escrow is not in a state that allows this call.
    BadState = 1,
    /// The caller is not allowed to make this call.
    NotAllowed = 2,
    /// Too early: the deadline or review window has not passed yet.
    TooEarly = 3,
    /// Too late: the deadline or review window has passed.
    TooLate = 4,
    /// Invalid arguments.
    InvalidArgs = 5,
    /// The token did not move exactly `amount` into the escrow.
    UnsupportedToken = 6,
    /// No escrow with this id.
    NotFound = 7,
    /// Checked arithmetic overflowed.
    Overflow = 8,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    Open = 1,
    Delivered = 2,
    Released = 3,
    Refunded = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub buyer: Address,
    pub seller: Address,
    /// May accept or reject in addition to the buyer. `None` = buyer only.
    pub evaluator: Option<Address>,
    pub token: Address,
    pub amount: i128,
    /// Unix seconds. The seller must deliver at or before this time, otherwise anyone can refund.
    pub deliver_by: u64,
    /// Seconds after delivery during which the buyer/evaluator may reject.
    pub review_window: u32,
    /// Unix seconds of the delivery (0 until delivered).
    pub delivered_at: u64,
    pub status: Status,
    /// Receipt hash committed on delivery.
    pub receipt_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    NextId,
    Escrow(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Opened {
    #[topic]
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub deliver_by: u64,
    pub review_window: u32,
    pub evaluator: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delivered {
    #[topic]
    pub id: u64,
    pub receipt_hash: BytesN<32>,
}

/// `by` is the accepting buyer/evaluator, or `None` for a permissionless release after the window.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub id: u64,
    pub receipt_hash: BytesN<32>,
    pub by: Option<Address>,
}

/// `by` is the rejecting buyer/evaluator or the refunding seller, or `None` for a permissionless
/// refund after a missed deadline.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub id: u64,
    pub by: Option<Address>,
}

// Ledgers close about every 5 seconds: keep escrow entries alive for ~30 days after each write
// and extend whenever fewer than ~7 days remain. Archived entries can be restored by anyone.
const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contract]
pub struct ReceptumEscrow;

#[contractimpl]
impl ReceptumEscrow {
    /// Buyer locks `amount` of `token` for `seller`. The buyer's authorization covers the token
    /// transfer into the escrow. Returns the escrow id (starting at 1).
    pub fn open(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        deliver_by: u64,
        review_window: u32,
        evaluator: Option<Address>,
    ) -> Result<u64, Error> {
        buyer.require_auth();
        let this = env.current_contract_address();
        if amount <= 0 || seller == buyer || seller == this || buyer == this {
            return Err(Error::InvalidArgs);
        }
        if let Some(ev) = &evaluator {
            if *ev == buyer || *ev == seller || *ev == this {
                return Err(Error::InvalidArgs);
            }
        }
        if token == this {
            return Err(Error::UnsupportedToken);
        }
        if deliver_by <= env.ledger().timestamp() {
            return Err(Error::InvalidArgs);
        }
        // deliver_by + review_window must be representable.
        deliver_by
            .checked_add(review_window as u64)
            .ok_or(Error::Overflow)?;

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let next = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage().instance().set(&DataKey::NextId, &next);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        let escrow = Escrow {
            buyer: buyer.clone(),
            seller: seller.clone(),
            evaluator: evaluator.clone(),
            token: token.clone(),
            amount,
            deliver_by,
            review_window,
            delivered_at: 0,
            status: Status::Open,
            receipt_hash: None,
        };
        save(&env, id, &escrow);
        Opened {
            id,
            buyer: buyer.clone(),
            seller,
            token: token.clone(),
            amount,
            deliver_by,
            review_window,
            evaluator,
        }
        .publish(&env);

        // Soroban forbids re-entering this contract during the token call, so no lock is needed.
        let t = token::TokenClient::new(&env, &token);
        let before = t.balance(&this);
        t.transfer(&buyer, &this, &amount);
        let after = t.balance(&this);
        let received = after.checked_sub(before).ok_or(Error::Overflow)?;
        if received != amount {
            return Err(Error::UnsupportedToken);
        }
        Ok(id)
    }

    /// Seller commits the receipt hash at or before `deliver_by`. Starts the review window.
    pub fn deliver(env: Env, id: u64, receipt_hash: BytesN<32>) -> Result<(), Error> {
        let mut e = load(&env, id)?;
        if e.status != Status::Open {
            return Err(Error::BadState);
        }
        e.seller.require_auth();
        let now = env.ledger().timestamp();
        if now > e.deliver_by {
            return Err(Error::TooLate);
        }
        if receipt_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(Error::InvalidArgs);
        }
        e.status = Status::Delivered;
        e.delivered_at = now;
        e.receipt_hash = Some(receipt_hash.clone());
        save(&env, id, &e);
        Delivered { id, receipt_hash }.publish(&env);
        Ok(())
    }

    /// Buyer or evaluator (`by`) accepts the delivery at any time; the seller is paid in full.
    pub fn accept(env: Env, id: u64, by: Address) -> Result<(), Error> {
        let e = load(&env, id)?;
        if e.status != Status::Delivered {
            return Err(Error::BadState);
        }
        if !can_judge(&e, &by) {
            return Err(Error::NotAllowed);
        }
        by.require_auth();
        release_to_seller(&env, id, e, Some(by))
    }

    /// Buyer or evaluator (`by`) rejects the delivery within the review window; the buyer is
    /// refunded.
    pub fn reject(env: Env, id: u64, by: Address) -> Result<(), Error> {
        let e = load(&env, id)?;
        if e.status != Status::Delivered {
            return Err(Error::BadState);
        }
        if !can_judge(&e, &by) {
            return Err(Error::NotAllowed);
        }
        by.require_auth();
        if env.ledger().timestamp() >= review_ends(&e)? {
            return Err(Error::TooLate);
        }
        refund_to_buyer(&env, id, e, Some(by))
    }

    /// Anyone can release to the seller once the review window has passed without rejection.
    pub fn release(env: Env, id: u64) -> Result<(), Error> {
        let e = load(&env, id)?;
        if e.status != Status::Delivered {
            return Err(Error::BadState);
        }
        if env.ledger().timestamp() < review_ends(&e)? {
            return Err(Error::TooEarly);
        }
        release_to_seller(&env, id, e, None)
    }

    /// Anyone can refund the buyer if nothing was delivered by the deadline.
    pub fn refund(env: Env, id: u64) -> Result<(), Error> {
        let e = load(&env, id)?;
        if e.status != Status::Open {
            return Err(Error::BadState);
        }
        if env.ledger().timestamp() <= e.deliver_by {
            return Err(Error::TooEarly);
        }
        refund_to_buyer(&env, id, e, None)
    }

    /// The seller may return the funds to the buyer at any time before release — e.g. to settle a
    /// dispute, or when transfers to the seller are blocked by the asset issuer.
    pub fn seller_refund(env: Env, id: u64) -> Result<(), Error> {
        let e = load(&env, id)?;
        if e.status != Status::Open && e.status != Status::Delivered {
            return Err(Error::BadState);
        }
        e.seller.require_auth();
        let seller = e.seller.clone();
        refund_to_buyer(&env, id, e, Some(seller))
    }

    /// Reads an escrow.
    pub fn get(env: Env, id: u64) -> Result<Escrow, Error> {
        load(&env, id)
    }

    /// The id the next `open` will return.
    pub fn next_id(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(1)
    }
}

fn load(env: &Env, id: u64) -> Result<Escrow, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Escrow(id))
        .ok_or(Error::NotFound)
}

fn save(env: &Env, id: u64, e: &Escrow) {
    let key = DataKey::Escrow(id);
    env.storage().persistent().set(&key, e);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn can_judge(e: &Escrow, by: &Address) -> bool {
    *by == e.buyer || e.evaluator.as_ref() == Some(by)
}

fn review_ends(e: &Escrow) -> Result<u64, Error> {
    e.delivered_at
        .checked_add(e.review_window as u64)
        .ok_or(Error::Overflow)
}

fn release_to_seller(env: &Env, id: u64, mut e: Escrow, by: Option<Address>) -> Result<(), Error> {
    let receipt_hash = e.receipt_hash.clone().ok_or(Error::BadState)?;
    e.status = Status::Released;
    save(env, id, &e);
    Released {
        id,
        receipt_hash,
        by,
    }
    .publish(env);
    token::TokenClient::new(env, &e.token).transfer(
        &env.current_contract_address(),
        &e.seller,
        &e.amount,
    );
    Ok(())
}

fn refund_to_buyer(env: &Env, id: u64, mut e: Escrow, by: Option<Address>) -> Result<(), Error> {
    e.status = Status::Refunded;
    save(env, id, &e);
    Refunded { id, by }.publish(env);
    token::TokenClient::new(env, &e.token).transfer(
        &env.current_contract_address(),
        &e.buyer,
        &e.amount,
    );
    Ok(())
}

#[cfg(test)]
mod test;
