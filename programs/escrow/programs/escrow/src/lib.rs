pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS");

#[program]
pub mod escrow {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn create_and_fund(
        ctx: Context<CreateAndFund>,
        bounty_id: [u8; 16],
        reward_amount: u64,
        policy_hash: [u8; 32],
        required_assurance: u8,
        attester_authority: Pubkey,
        deadline: i64,
        review_window_secs: i64,
    ) -> Result<()> {
        instructions::create_and_fund::handle_create_and_fund(
            ctx,
            bounty_id,
            reward_amount,
            policy_hash,
            required_assurance,
            attester_authority,
            deadline,
            review_window_secs,
        )
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }
}
