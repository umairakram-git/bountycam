use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BountyState {
    Funded,
    Accepted,
    Submitted,
    InReview,
    Approved,
    Rejected,
    Disputed,
    Paid,
    Refunded,
    Expired,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub bounty_id: [u8; 16],
    pub requester: Pubkey,
    pub scout: Option<Pubkey>,
    pub usdc_mint: Pubkey,
    pub reward_amount: u64,
    pub platform_fee: u64,
    pub policy_hash: [u8; 32],
    pub required_assurance: u8,
    pub attester_authority: Pubkey,
    pub arbiter_authority: Pubkey,
    pub deadline: i64,
    pub review_window_secs: i64,
    pub submitted_at: Option<i64>,
    pub merkle_root: Option<[u8; 32]>,
    pub achieved_assurance: Option<u8>,
    pub state: BountyState,
    pub bump: u8,
}
