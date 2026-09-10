use anchor_lang::prelude::*;

// Final on-chain error codes are these discriminants plus Anchor's custom
// error offset of 6000 (e.g. InvalidRewardAmount = 6000).
#[error_code]
pub enum EscrowError {
    #[msg("reward_amount must be greater than zero")]
    InvalidRewardAmount = 0,
    #[msg("deadline must be in the future")]
    DeadlineInPast = 1,
    #[msg("required_assurance must not exceed the maximum assurance level")]
    AssuranceTooHigh = 2,
    #[msg("token account mint does not match the bounty USDC mint")]
    MintMismatch = 3,
    #[msg("only the bounty requester may perform this action")]
    UnauthorizedRequester = 4,
    #[msg("bounty can only be cancelled while it is in the Funded state")]
    BountyNotCancellable = 5,
    #[msg("arithmetic overflow while computing fee or total")]
    AmountOverflow = 6,
}
