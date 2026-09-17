pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod messages;
pub mod state;
pub mod verification;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS");

#[program]
pub mod escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        deployment_id: u8,
        eligibility_authority: Pubkey,
        attester_authority: Pubkey,
        arbiter_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(
            ctx,
            deployment_id,
            eligibility_authority,
            attester_authority,
            arbiter_authority,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_and_fund(
        ctx: Context<CreateAndFund>,
        bounty_id: [u8; 16],
        reward_amount: u64,
        policy_hash: [u8; 32],
        eligibility_profile_hash: [u8; 32],
        required_assurance: u8,
        acceptance_window_secs: i64,
        completion_window_secs: i64,
        review_window_secs: i64,
    ) -> Result<()> {
        instructions::create_and_fund::handle_create_and_fund(
            ctx,
            bounty_id,
            reward_amount,
            policy_hash,
            eligibility_profile_hash,
            required_assurance,
            acceptance_window_secs,
            completion_window_secs,
            review_window_secs,
        )
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    pub fn accept(
        ctx: Context<Accept>,
        expires_at: i64,
        verification_instruction_index: u16,
    ) -> Result<()> {
        instructions::accept::handle_accept(ctx, expires_at, verification_instruction_index)
    }
}
