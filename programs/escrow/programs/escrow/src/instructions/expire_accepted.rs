use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::EscrowError, state::*};

/// SPEC 7.11. No signer beyond the fee payer (D95): every account, amount,
/// destination and time bound is fixed by stored state. The account list is
/// section 7.10's; the bounty is not closed (D96).
#[derive(Accounts)]
pub struct ExpireAccepted<'info> {
    /// CHECK: never read and does not sign; bound to the bounty's stored
    /// requester by has_one (RequesterAccountMismatch) and used only as the
    /// rent destination and the refund account's derivation wallet (SPEC
    /// 7.11, D95).
    #[account(mut)]
    pub requester: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = requester @ EscrowError::RequesterAccountMismatch,
        constraint = bounty.state == BountyState::Accepted @ EscrowError::BountyNotExpirable,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump
    )]
    pub bounty: Account<'info, Bounty>,
    /// The configured mint by address (D83); `Account<Mint>` enforces the owner.
    #[account(address = config.usdc_mint @ EscrowError::MintMismatch)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bounty
    )]
    pub bounty_vault: Account<'info, TokenAccount>,
    /// The requester's associated token account, not any account the
    /// requester owns: the requester does not sign, so no caller chooses
    /// among the requester's accounts (D95).
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = requester,
        constraint = requester_ata.mint == config.usdc_mint @ EscrowError::MintMismatch
    )]
    pub requester_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// SPEC 7.11. Three handler checks, then the effects in D99's order: the
/// terminal state is written before the token CPI, then the entire vault
/// balance is refunded and the vault closed. The bounty account stays open
/// (D96). No event. Covers an abandoned mission and an attested shortfall
/// alike (D85, D95).
pub fn handle_expire_accepted(ctx: Context<ExpireAccepted>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bounty = &ctx.accounts.bounty;
    let refunded_amount = ctx.accounts.bounty_vault.amount;

    // Check 1: the section 4.1 invariant, at the field this instruction reads.
    // A review item: `accept` writes it as it enters `Accepted`.
    let deadline = bounty
        .deadline
        .ok_or(EscrowError::StateInvariantViolated)?;
    // Check 2: strictly later than the deadline, the complement of
    // `submit_attestation`'s at-or-before on the same bound (D81, D95).
    require!(now > deadline, EscrowError::SubmissionDeadlineOpen);
    // Check 3: the vault holds at least reward_amount. Unreachable by
    // construction, since only the bounty PDA can move vault tokens; checked
    // to fail closed (SPEC 7.3).
    require!(
        refunded_amount >= bounty.reward_amount,
        EscrowError::VaultBalanceBelowReward
    );

    // Effect 1: state Refunded, before any CPI (D99).
    let bounty = &mut ctx.accounts.bounty;
    bounty.state = BountyState::Refunded;

    let requester_key = bounty.requester;
    let bounty_id = bounty.bounty_id;
    let bump = bounty.bump;
    let seeds: &[&[u8]] = &[
        BOUNTY_SEED,
        requester_key.as_ref(),
        bounty_id.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[seeds];

    // Effect 2: the vault's entire balance to requester_ata, signed by the
    // bounty PDA. Donated tokens return with the reward (SPEC 7.3).
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.bounty_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.requester_ata.to_account_info(),
                authority: ctx.accounts.bounty.to_account_info(),
            },
            signer_seeds,
        ),
        refunded_amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // Effect 3: close the vault, lamports to the requester.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.bounty_vault.to_account_info(),
            destination: ctx.accounts.requester.to_account_info(),
            authority: ctx.accounts.bounty.to_account_info(),
        },
        signer_seeds,
    ))?;

    Ok(())
}
