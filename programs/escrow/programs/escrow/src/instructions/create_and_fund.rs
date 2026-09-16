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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = requester,
        space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, requester.key().as_ref(), bounty_id.as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,
    /// The configured mint by address (D83); `Account<Mint>` enforces the owner.
    #[account(address = config.usdc_mint @ EscrowError::MintMismatch)]
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
        constraint = requester_ata.mint == config.usdc_mint @ EscrowError::MintMismatch,
        constraint = requester_ata.owner == requester.key() @ EscrowError::TokenAccountOwnerMismatch
    )]
    pub requester_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// SPEC 7.2. No attester, arbiter, fee, mint or absolute-deadline argument
/// (D67, D74, D81, D82, D83).
#[allow(clippy::too_many_arguments)]
pub fn handle_create_and_fund(
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
    let now = Clock::get()?.unix_timestamp;

    // Check 1.
    require!(reward_amount > 0, EscrowError::InvalidRewardAmount);
    // Check 2.
    require!(
        required_assurance <= MAX_ASSURANCE_LEVEL,
        EscrowError::AssuranceTooHigh
    );
    // Checks 3 to 5: each window in 1 to its compiled ceiling (D81).
    require!(
        (1..=MAX_ACCEPTANCE_WINDOW_SECS).contains(&acceptance_window_secs),
        EscrowError::InvalidAcceptanceWindow
    );
    require!(
        (1..=MAX_COMPLETION_WINDOW_SECS).contains(&completion_window_secs),
        EscrowError::InvalidCompletionWindow
    );
    require!(
        (1..=MAX_REVIEW_WINDOW_SECS).contains(&review_window_secs),
        EscrowError::InvalidReviewWindow
    );
    // Check 6: the cutoff must not overflow i64.
    let acceptance_cutoff = now
        .checked_add(acceptance_window_secs)
        .ok_or(EscrowError::TimestampOverflow)?;

    // Effect 1: write the bounty. `eligibility_profile_hash` is stored without
    // validation (D84); policy agreement is enforced off-chain.
    ctx.accounts.bounty.set_inner(Bounty {
        bounty_id,
        requester: ctx.accounts.requester.key(),
        reward_amount,
        // Exactly 0 (D24, D67). No fee arithmetic exists.
        platform_fee: 0,
        policy_hash,
        eligibility_profile_hash,
        required_assurance,
        acceptance_window_secs,
        completion_window_secs,
        review_window_secs,
        acceptance_cutoff,
        state: BountyState::Funded,
        bump: ctx.bumps.bounty,
        scout: None,
        deadline: None,
        submitted_at: None,
        evidence_root: None,
        achieved_assurance: None,
    });

    // Effect 2: exactly reward_amount, checked against the mint's decimals.
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
        reward_amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    Ok(())
}
