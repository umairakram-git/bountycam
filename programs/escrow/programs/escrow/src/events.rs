use anchor_lang::prelude::*;

/// The only event (D76, SPEC section 8). `cancel` closes both accounts,
/// leaving no state to read, so this is the reconciliation anchor; the
/// database is the durable record. Every other instruction leaves a
/// surviving account instead, and emits nothing.
#[event]
pub struct BountyCancelled {
    /// Account address; unique, unlike `bounty_id`.
    pub bounty: Pubkey,
    pub bounty_id: [u8; 16],
    pub requester: Pubkey,
    /// `config.usdc_mint`.
    pub usdc_mint: Pubkey,
    pub reward_amount: u64,
    /// Entire vault balance transferred; at least `reward_amount`.
    pub refunded_amount: u64,
    /// `now`.
    pub cancelled_at: i64,
}
