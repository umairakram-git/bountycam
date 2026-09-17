use anchor_lang::prelude::*;

/// One account per deployment (D83). PDA on `CONFIG_SEED`, canonical bump.
/// Written only by `initialize`, once. No instruction updates or closes it.
/// Space: 8 discriminator bytes plus 130 (SPEC section 3).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub deployment_id: u8,
    pub usdc_mint: Pubkey,
    pub eligibility_authority: Pubkey,
    pub attester_authority: Pubkey,
    pub arbiter_authority: Pubkey,
    pub bump: u8,
}

/// SPEC section 5.1. Exactly the states these instructions enter (D76).
/// Append-only: discriminants never change (D96). `Paid` and `Refunded` are
/// terminal; no instruction accepts either as a source state.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BountyState {
    Funded,    // 0
    Accepted,  // 1
    Submitted, // 2
    Disputed,  // 3
    Paid,      // 4
    Refunded,  // 5
}

/// SPEC section 4.1. PDA on `BOUNTY_SEED`, the requester key and `bounty_id`.
/// Fixed-width fields first, every `Option` last, so non-`Option` fields keep
/// stable offsets for account filters. Space: 8 discriminator bytes plus 266
/// (D93).
///
/// `Option` invariant: while `Funded` all six are `None`; `accept` sets
/// `scout` and `deadline`; `submit_attestation` sets `submitted_at`,
/// `evidence_root` and `achieved_assurance`; `reject` sets
/// `failed_requirement_id`. Nothing clears a field once set (D96).
#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub bounty_id: [u8; 16],                // offset 8
    pub requester: Pubkey,                  // 24
    pub reward_amount: u64,                 // 56
    pub platform_fee: u64,                  // 64, always 0 (D67)
    pub policy_hash: [u8; 32],              // 72
    pub eligibility_profile_hash: [u8; 32], // 104 (D84)
    pub required_assurance: u8,             // 136
    pub acceptance_window_secs: i64,        // 137 (D81)
    pub completion_window_secs: i64,        // 145 (D81)
    pub review_window_secs: i64,            // 153
    pub acceptance_cutoff: i64,             // 161
    pub state: BountyState,                 // 169
    pub bump: u8,                           // 170
    pub scout: Option<Pubkey>,              // 171, written by accept
    pub deadline: Option<i64>,              // written by accept
    pub submitted_at: Option<i64>,          // written by submit_attestation
    pub evidence_root: Option<[u8; 32]>,    // written by submit_attestation
    pub achieved_assurance: Option<u8>,     // written by submit_attestation
    pub failed_requirement_id: Option<[u8; 16]>, // written by reject (D93)
}
