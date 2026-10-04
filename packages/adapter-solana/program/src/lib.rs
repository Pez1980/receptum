//! ReceptumEscrow for Solana (`receptum_escrow`).
//!
//! Holds an SPL Token payment (normally Circle's devnet USDC) for one job until the seller
//! delivers and the delivery is accepted. The seller commits the Receptum `receiptHash` on
//! delivery; the hash is the on-chain commitment for the signed receipt (RRF v1, docs/SPEC.md §7).
//! Same state machine as the EVM `ReceptumEscrow` and the Soroban escrow:
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
//! Funds only ever move from the escrow's vault to a token account owned by the escrow's buyer or
//! seller. There is no admin, no fee and no upgrade authority (the deployment is made immutable).
//! The escrow account is kept after settlement so that anyone can read its final state; the
//! vault is closed and its rent returned to the buyer.
//!
//! Accounts
//! - escrow: PDA `["escrow", buyer, id (u64 LE)]`, owned by this program, `ESCROW_LEN` bytes.
//! - vault:  PDA `["vault", escrow]`, an SPL Token account for `mint` whose owner is the escrow.
//!
//! Only the classic SPL Token program is accepted (no Token-2022: transfer fees and hooks would
//! break the exact-amount invariant).
//!
//! **Unaudited. Devnet use only until an independent audit is published.**
#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Errors, numbered like the Soroban escrow's.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowError {
    /// The escrow is not in a state that allows this call.
    BadState = 1,
    /// The caller is not allowed to make this call (or did not sign).
    NotAllowed = 2,
    /// Too early: the deadline or review window has not passed yet.
    TooEarly = 3,
    /// Too late: the deadline or review window has passed.
    TooLate = 4,
    /// Invalid arguments or accounts.
    InvalidArgs = 5,
    /// The token program, mint or token account is not supported, or the vault did not receive
    /// exactly `amount`.
    UnsupportedToken = 6,
    /// No escrow at this account.
    NotFound = 7,
    /// Checked arithmetic overflowed.
    Overflow = 8,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

use EscrowError::*;

pub const SPL_TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

/// First 8 bytes of every escrow account.
pub const DISCRIMINATOR: [u8; 8] = *b"rcptesc1";
pub const VERSION: u8 = 1;
pub const ESCROW_LEN: usize = 272;
const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

pub const STATUS_OPEN: u8 = 1;
pub const STATUS_DELIVERED: u8 = 2;
pub const STATUS_RELEASED: u8 = 3;
pub const STATUS_REFUNDED: u8 = 4;

/// Instruction tags (first byte of instruction data).
pub mod ix {
    pub const OPEN: u8 = 0;
    pub const DELIVER: u8 = 1;
    pub const ACCEPT: u8 = 2;
    pub const REJECT: u8 = 3;
    pub const RELEASE: u8 = 4;
    pub const REFUND: u8 = 5;
    pub const SELLER_REFUND: u8 = 6;
}

/// Escrow account state. Layout (little-endian), `ESCROW_LEN` = 272 bytes:
///
/// | off | size | field |
/// | --- | --- | --- |
/// | 0 | 8 | discriminator `rcptesc1` |
/// | 8 | 1 | version (1) |
/// | 9 | 1 | status (1 open, 2 delivered, 3 released, 4 refunded) |
/// | 10 | 1 | escrow PDA bump |
/// | 11 | 1 | vault PDA bump |
/// | 12 | 32 | buyer |
/// | 44 | 32 | seller |
/// | 76 | 32 | evaluator (all zero = none) |
/// | 108 | 32 | mint |
/// | 140 | 32 | vault |
/// | 172 | 32 | settled_by: accepting/rejecting judge or refunding seller (zero = permissionless) |
/// | 204 | 8 | id (u64) |
/// | 212 | 8 | amount (u64, token base units) |
/// | 220 | 8 | deliver_by (i64 unix seconds) |
/// | 228 | 4 | review_window (u32 seconds) |
/// | 232 | 8 | delivered_at (i64 unix seconds, 0 until delivered) |
/// | 240 | 32 | receipt_hash (zero until delivered) |
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Escrow {
    pub status: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub evaluator: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub settled_by: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub deliver_by: i64,
    pub review_window: u32,
    pub delivered_at: i64,
    pub receipt_hash: [u8; 32],
}

fn pk(b: &[u8]) -> Pubkey {
    let mut a = [0u8; 32];
    a.copy_from_slice(&b[..32]);
    Pubkey::new_from_array(a)
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}
fn i64_at(b: &[u8], o: usize) -> i64 {
    u64_at(b, o) as i64
}

impl Escrow {
    pub fn unpack(d: &[u8]) -> Result<Self, ProgramError> {
        if d.len() != ESCROW_LEN || d[..8] != DISCRIMINATOR || d[8] != VERSION {
            return Err(NotFound.into());
        }
        let mut rh = [0u8; 32];
        rh.copy_from_slice(&d[240..272]);
        let mut w = [0u8; 4];
        w.copy_from_slice(&d[228..232]);
        Ok(Escrow {
            status: d[9],
            bump: d[10],
            vault_bump: d[11],
            buyer: pk(&d[12..]),
            seller: pk(&d[44..]),
            evaluator: pk(&d[76..]),
            mint: pk(&d[108..]),
            vault: pk(&d[140..]),
            settled_by: pk(&d[172..]),
            id: u64_at(d, 204),
            amount: u64_at(d, 212),
            deliver_by: i64_at(d, 220),
            review_window: u32::from_le_bytes(w),
            delivered_at: i64_at(d, 232),
            receipt_hash: rh,
        })
    }

    pub fn pack(&self, d: &mut [u8]) {
        d[..8].copy_from_slice(&DISCRIMINATOR);
        d[8] = VERSION;
        d[9] = self.status;
        d[10] = self.bump;
        d[11] = self.vault_bump;
        d[12..44].copy_from_slice(self.buyer.as_ref());
        d[44..76].copy_from_slice(self.seller.as_ref());
        d[76..108].copy_from_slice(self.evaluator.as_ref());
        d[108..140].copy_from_slice(self.mint.as_ref());
        d[140..172].copy_from_slice(self.vault.as_ref());
        d[172..204].copy_from_slice(self.settled_by.as_ref());
        d[204..212].copy_from_slice(&self.id.to_le_bytes());
        d[212..220].copy_from_slice(&self.amount.to_le_bytes());
        d[220..228].copy_from_slice(&self.deliver_by.to_le_bytes());
        d[228..232].copy_from_slice(&self.review_window.to_le_bytes());
        d[232..240].copy_from_slice(&self.delivered_at.to_le_bytes());
        d[240..272].copy_from_slice(&self.receipt_hash);
    }

    fn has_evaluator(&self) -> bool {
        self.evaluator != Pubkey::default()
    }

    fn can_judge(&self, by: &Pubkey) -> bool {
        *by == self.buyer || (self.has_evaluator() && *by == self.evaluator)
    }

    fn review_ends(&self) -> Result<i64, ProgramError> {
        self.delivered_at
            .checked_add(self.review_window as i64)
            .ok_or_else(|| Overflow.into())
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(ProgramError::from(InvalidArgs))?;
    match tag {
        ix::OPEN => open(program_id, accounts, rest),
        ix::DELIVER => deliver(program_id, accounts, rest),
        ix::ACCEPT => judge(program_id, accounts, rest, true),
        ix::REJECT => judge(program_id, accounts, rest, false),
        ix::RELEASE => release(program_id, accounts, rest),
        ix::REFUND => refund(program_id, accounts, rest),
        ix::SELLER_REFUND => seller_refund(program_id, accounts, rest),
        _ => Err(InvalidArgs.into()),
    }
}

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

fn take<'a, 'b>(accounts: &'a [AccountInfo<'b>], n: usize) -> Result<&'a [AccountInfo<'b>], ProgramError> {
    if accounts.len() < n {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    Ok(&accounts[..n])
}

/// A classic SPL Token mint: returns its decimals.
fn mint_decimals(mint: &AccountInfo) -> Result<u8, ProgramError> {
    if *mint.owner != SPL_TOKEN_ID {
        return Err(UnsupportedToken.into());
    }
    let d = mint.try_borrow_data()?;
    if d.len() != MINT_LEN || d[45] != 1 {
        return Err(UnsupportedToken.into());
    }
    Ok(d[44])
}

/// An initialized SPL Token account for `mint` owned by `owner`; returns its balance.
fn token_account(acc: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<u64, ProgramError> {
    if *acc.owner != SPL_TOKEN_ID {
        return Err(UnsupportedToken.into());
    }
    let d = acc.try_borrow_data()?;
    // state: 1 = initialized (2 = frozen is rejected: it could not move funds anyway).
    if d.len() != TOKEN_ACCOUNT_LEN || d[108] != 1 {
        return Err(UnsupportedToken.into());
    }
    if pk(&d[0..]) != *mint || pk(&d[32..]) != *owner {
        return Err(InvalidArgs.into());
    }
    Ok(u64_at(&d, 64))
}

fn system_ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: SYSTEM_PROGRAM_ID, accounts, data }
}

/// Creates a program-derived account even if someone pre-funded its address (transfer, allocate,
/// assign — CreateAccount would fail on a funded address).
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    let need = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    if have < need {
        let mut d = vec![2, 0, 0, 0];
        d.extend_from_slice(&(need - have).to_le_bytes());
        invoke(
            &system_ix(vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*target.key, false)], d),
            &[payer.clone(), target.clone(), system.clone()],
        )?;
    }
    let mut d = vec![8, 0, 0, 0];
    d.extend_from_slice(&(space as u64).to_le_bytes());
    invoke_signed(
        &system_ix(vec![AccountMeta::new(*target.key, true)], d),
        &[target.clone(), system.clone()],
        &[seeds],
    )?;
    let mut d = vec![1, 0, 0, 0];
    d.extend_from_slice(owner.as_ref());
    invoke_signed(
        &system_ix(vec![AccountMeta::new(*target.key, true)], d),
        &[target.clone(), system.clone()],
        &[seeds],
    )
}

fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let mut d = vec![12u8];
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(decimals);
    let ix = Instruction {
        program_id: SPL_TOKEN_ID,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: d,
    };
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s]),
        None => invoke(&ix, &infos),
    }
}

// ─── open ────────────────────────────────────────────────────────────────────

/// data: id u64, amount u64, deliver_by i64, review_window u32, evaluator [32] (zero = none).
/// accounts: buyer (signer, writable), seller, escrow (writable), vault (writable),
/// buyer_token (writable), mint, token_program, system_program.
fn open(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 8 + 8 + 8 + 4 + 32 {
        return Err(InvalidArgs.into());
    }
    let id = u64_at(data, 0);
    let amount = u64_at(data, 8);
    let deliver_by = i64_at(data, 16);
    let mut w = [0u8; 4];
    w.copy_from_slice(&data[24..28]);
    let review_window = u32::from_le_bytes(w);
    let evaluator = pk(&data[28..]);

    let a = take(accounts, 8)?;
    let (buyer, seller, escrow_ai, vault_ai, buyer_token, mint, token_program, system) =
        (&a[0], &a[1], &a[2], &a[3], &a[4], &a[5], &a[6], &a[7]);
    if !buyer.is_signer {
        return Err(NotAllowed.into());
    }
    if *token_program.key != SPL_TOKEN_ID {
        return Err(UnsupportedToken.into());
    }
    if *system.key != SYSTEM_PROGRAM_ID {
        return Err(InvalidArgs.into());
    }
    let zero = Pubkey::default();
    if amount == 0
        || *seller.key == *buyer.key
        || *seller.key == zero
        || *seller.key == *program_id
        || evaluator == *buyer.key
        || evaluator == *seller.key
        || evaluator == *program_id
    {
        return Err(InvalidArgs.into());
    }
    if deliver_by <= now()? {
        return Err(InvalidArgs.into());
    }
    deliver_by.checked_add(review_window as i64).ok_or(ProgramError::from(Overflow))?;
    let decimals = mint_decimals(mint)?;
    token_account(buyer_token, mint.key, buyer.key)?;

    let id_le = id.to_le_bytes();
    let (escrow_key, bump) = Pubkey::find_program_address(&[b"escrow", buyer.key.as_ref(), &id_le], program_id);
    if escrow_key != *escrow_ai.key {
        return Err(InvalidArgs.into());
    }
    let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", escrow_key.as_ref()], program_id);
    if vault_key != *vault_ai.key {
        return Err(InvalidArgs.into());
    }
    // A fresh escrow: the address holds no data and belongs to the system program.
    if escrow_ai.data_len() != 0 || *escrow_ai.owner != SYSTEM_PROGRAM_ID {
        return Err(BadState.into());
    }
    if vault_ai.data_len() != 0 || *vault_ai.owner != SYSTEM_PROGRAM_ID {
        return Err(BadState.into());
    }

    let escrow_seeds: &[&[u8]] = &[b"escrow", buyer.key.as_ref(), &id_le, &[bump]];
    create_pda(buyer, escrow_ai, system, ESCROW_LEN, program_id, escrow_seeds)?;
    let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
    create_pda(buyer, vault_ai, system, TOKEN_ACCOUNT_LEN, &SPL_TOKEN_ID, vault_seeds)?;
    // InitializeAccount3(owner = escrow PDA).
    let mut d = vec![18u8];
    d.extend_from_slice(escrow_key.as_ref());
    invoke(
        &Instruction {
            program_id: SPL_TOKEN_ID,
            accounts: vec![AccountMeta::new(vault_key, false), AccountMeta::new_readonly(*mint.key, false)],
            data: d,
        },
        &[vault_ai.clone(), mint.clone(), token_program.clone()],
    )?;

    let escrow = Escrow {
        status: STATUS_OPEN,
        bump,
        vault_bump,
        buyer: *buyer.key,
        seller: *seller.key,
        evaluator,
        mint: *mint.key,
        vault: vault_key,
        settled_by: zero,
        id,
        amount,
        deliver_by,
        review_window,
        delivered_at: 0,
        receipt_hash: [0u8; 32],
    };
    escrow.pack(&mut escrow_ai.try_borrow_mut_data()?);

    transfer_checked(token_program, buyer_token, mint, vault_ai, buyer, amount, decimals, None)?;
    if token_account(vault_ai, mint.key, &escrow_key)? != amount {
        return Err(UnsupportedToken.into());
    }
    msg!("receptum/1 open {} {}", escrow_key, amount);
    Ok(())
}

/// Loads an escrow account owned by this program and checks its address is the escrow PDA.
fn load(program_id: &Pubkey, ai: &AccountInfo) -> Result<Escrow, ProgramError> {
    if *ai.owner != *program_id || !ai.is_writable {
        return Err(NotFound.into());
    }
    let e = Escrow::unpack(&ai.try_borrow_data()?)?;
    let key = Pubkey::create_program_address(
        &[b"escrow", e.buyer.as_ref(), &e.id.to_le_bytes(), &[e.bump]],
        program_id,
    )
    .map_err(|_| ProgramError::from(NotFound))?;
    if key != *ai.key {
        return Err(NotFound.into());
    }
    Ok(e)
}

fn save(ai: &AccountInfo, e: &Escrow) -> ProgramResult {
    e.pack(&mut ai.try_borrow_mut_data()?);
    Ok(())
}

// ─── deliver ─────────────────────────────────────────────────────────────────

/// data: receipt_hash [32]. accounts: seller (signer), escrow (writable).
fn deliver(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 32 {
        return Err(InvalidArgs.into());
    }
    let a = take(accounts, 2)?;
    let (seller, escrow_ai) = (&a[0], &a[1]);
    let mut e = load(program_id, escrow_ai)?;
    if e.status != STATUS_OPEN {
        return Err(BadState.into());
    }
    if *seller.key != e.seller || !seller.is_signer {
        return Err(NotAllowed.into());
    }
    let t = now()?;
    if t > e.deliver_by {
        return Err(TooLate.into());
    }
    if data.iter().all(|b| *b == 0) {
        return Err(InvalidArgs.into());
    }
    e.status = STATUS_DELIVERED;
    e.delivered_at = t;
    e.receipt_hash.copy_from_slice(data);
    save(escrow_ai, &e)?;
    msg!("receptum/1 delivered {}", escrow_ai.key);
    Ok(())
}

// ─── payouts ─────────────────────────────────────────────────────────────────

/// Moves the whole vault to `dest` (a token account owned by `recipient`), closes the vault
/// (rent to the buyer) and records the final state.
#[allow(clippy::too_many_arguments)]
fn pay_out<'a>(
    escrow_ai: &AccountInfo<'a>,
    mut e: Escrow,
    vault: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    buyer: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    to_seller: bool,
    by: Pubkey,
) -> ProgramResult {
    if *token_program.key != SPL_TOKEN_ID || *mint.key != e.mint || *vault.key != e.vault {
        return Err(InvalidArgs.into());
    }
    if *buyer.key != e.buyer || !buyer.is_writable {
        return Err(InvalidArgs.into());
    }
    let recipient = if to_seller { e.seller } else { e.buyer };
    token_account(dest, &e.mint, &recipient)?;
    let held = token_account(vault, &e.mint, escrow_ai.key)?;
    if held != e.amount {
        return Err(UnsupportedToken.into());
    }
    let decimals = mint_decimals(mint)?;
    e.status = if to_seller { STATUS_RELEASED } else { STATUS_REFUNDED };
    e.settled_by = by;
    save(escrow_ai, &e)?;

    let id_le = e.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"escrow", e.buyer.as_ref(), &id_le, &[e.bump]];
    transfer_checked(token_program, vault, mint, dest, escrow_ai, e.amount, decimals, Some(seeds))?;
    // CloseAccount(vault → buyer), authority = escrow.
    invoke_signed(
        &Instruction {
            program_id: SPL_TOKEN_ID,
            accounts: vec![
                AccountMeta::new(*vault.key, false),
                AccountMeta::new(*buyer.key, false),
                AccountMeta::new_readonly(*escrow_ai.key, true),
            ],
            data: vec![9],
        },
        &[vault.clone(), buyer.clone(), escrow_ai.clone(), token_program.clone()],
        &[seeds],
    )?;
    msg!(
        "receptum/1 {} {}",
        if to_seller { "released" } else { "refunded" },
        escrow_ai.key
    );
    Ok(())
}

/// accept / reject. data: none.
/// accounts: judge (signer), escrow (w), vault (w), dest token account (w; seller's for accept,
/// buyer's for reject), buyer (w), mint, token_program.
fn judge(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], accept: bool) -> ProgramResult {
    if !data.is_empty() {
        return Err(InvalidArgs.into());
    }
    let a = take(accounts, 7)?;
    let (by, escrow_ai) = (&a[0], &a[1]);
    let e = load(program_id, escrow_ai)?;
    if e.status != STATUS_DELIVERED {
        return Err(BadState.into());
    }
    if !by.is_signer || !e.can_judge(by.key) {
        return Err(NotAllowed.into());
    }
    if !accept && now()? >= e.review_ends()? {
        return Err(TooLate.into());
    }
    let who = *by.key;
    pay_out(escrow_ai, e, &a[2], &a[3], &a[4], &a[5], &a[6], accept, who)
}

/// Anyone, once the review window has passed. data: none.
/// accounts: escrow (w), vault (w), seller token account (w), buyer (w), mint, token_program.
fn release(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if !data.is_empty() {
        return Err(InvalidArgs.into());
    }
    let a = take(accounts, 6)?;
    let e = load(program_id, &a[0])?;
    if e.status != STATUS_DELIVERED {
        return Err(BadState.into());
    }
    if now()? < e.review_ends()? {
        return Err(TooEarly.into());
    }
    pay_out(&a[0], e, &a[1], &a[2], &a[3], &a[4], &a[5], true, Pubkey::default())
}

/// Anyone, if nothing was delivered by the deadline. data: none.
/// accounts: escrow (w), vault (w), buyer token account (w), buyer (w), mint, token_program.
fn refund(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if !data.is_empty() {
        return Err(InvalidArgs.into());
    }
    let a = take(accounts, 6)?;
    let e = load(program_id, &a[0])?;
    if e.status != STATUS_OPEN {
        return Err(BadState.into());
    }
    if now()? <= e.deliver_by {
        return Err(TooEarly.into());
    }
    pay_out(&a[0], e, &a[1], &a[2], &a[3], &a[4], &a[5], false, Pubkey::default())
}

/// The seller returns the funds at any time before settlement. data: none.
/// accounts: seller (signer), escrow (w), vault (w), buyer token account (w), buyer (w), mint,
/// token_program.
fn seller_refund(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if !data.is_empty() {
        return Err(InvalidArgs.into());
    }
    let a = take(accounts, 7)?;
    let (seller, escrow_ai) = (&a[0], &a[1]);
    let e = load(program_id, escrow_ai)?;
    if e.status != STATUS_OPEN && e.status != STATUS_DELIVERED {
        return Err(BadState.into());
    }
    if *seller.key != e.seller || !seller.is_signer {
        return Err(NotAllowed.into());
    }
    let who = *seller.key;
    pay_out(escrow_ai, e, &a[2], &a[3], &a[4], &a[5], &a[6], false, who)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_round_trips() {
        let e = Escrow {
            status: STATUS_DELIVERED,
            bump: 254,
            vault_bump: 253,
            buyer: Pubkey::new_from_array([1; 32]),
            seller: Pubkey::new_from_array([2; 32]),
            evaluator: Pubkey::new_from_array([3; 32]),
            mint: Pubkey::new_from_array([4; 32]),
            vault: Pubkey::new_from_array([5; 32]),
            settled_by: Pubkey::new_from_array([6; 32]),
            id: 7,
            amount: 8,
            deliver_by: 9,
            review_window: 10,
            delivered_at: 11,
            receipt_hash: [12; 32],
        };
        let mut d = [0u8; ESCROW_LEN];
        e.pack(&mut d);
        assert_eq!(Escrow::unpack(&d).unwrap(), e);
        d[0] = b'x';
        assert!(Escrow::unpack(&d).is_err());
    }
}
