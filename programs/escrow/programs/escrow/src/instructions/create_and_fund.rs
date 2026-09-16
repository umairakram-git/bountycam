use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, error::EscrowError, state::*};

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 16])]
pub struct CreateAndFund<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init,
        payer = requester,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, requester.key().as_ref(), bounty_id.as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = requester,
        associated_token::mint = usdc_mint,
        associated_token::authority = bounty
    )]
    pub bounty_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = requester_ata.mint == usdc_mint.key() @ EscrowError::MintMismatch,
        constraint = requester_ata.owner == requester.key() @ EscrowError::TokenAccountOwnerMismatch
    )]
    pub requester_ata: Account<'info, TokenAccount>,
    /// CHECK: only the address is recorded as the arbiter authority
    pub arbiter_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_create_and_fund(
    ctx: Context<CreateAndFund>,
    bounty_id: [u8; 16],
    reward_amount: u64,
    policy_hash: [u8; 32],
    required_assurance: u8,
    attester_authority: Pubkey,
    deadline: i64,
    review_window_secs: i64,
) -> Result<()> {
    require!(reward_amount > 0, EscrowError::InvalidRewardAmount);
    require!(
        deadline > Clock::get()?.unix_timestamp,
        EscrowError::DeadlineInPast
    );
    require!(
        required_assurance <= MAX_ASSURANCE_LEVEL,
        EscrowError::AssuranceTooHigh
    );

    let platform_fee = reward_amount
        .checked_mul(PLATFORM_FEE_BPS)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(EscrowError::AmountOverflow)?;
    let total = reward_amount
        .checked_add(platform_fee)
        .ok_or(EscrowError::AmountOverflow)?;

    ctx.accounts.bounty.set_inner(Bounty {
        bounty_id,
        requester: ctx.accounts.requester.key(),
        scout: None,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        reward_amount,
        platform_fee,
        policy_hash,
        required_assurance,
        attester_authority,
        arbiter_authority: ctx.accounts.arbiter_authority.key(),
        deadline,
        review_window_secs,
        submitted_at: None,
        merkle_root: None,
        achieved_assurance: None,
        state: BountyState::Funded,
        bump: ctx.bumps.bounty,
    });

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.requester_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.bounty_vault.to_account_info(),
                authority: ctx.accounts.requester.to_account_info(),
            },
        ),
        total,
        ctx.accounts.usdc_mint.decimals,
    )?;

    Ok(())
}
