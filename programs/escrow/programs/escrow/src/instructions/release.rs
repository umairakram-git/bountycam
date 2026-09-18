use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::EscrowError, state::*};

/// SPEC 7.7. No signer beyond the fee payer (D92): once the review window
/// has passed, anyone may pay the stored Scout the vault's entire balance.
/// The account list is section 7.6's with the requester unsigned. Four
/// accounts are boxed (D100).
#[derive(Accounts)]
pub struct Release<'info> {
    /// CHECK: never read and does not sign; bound to the bounty's stored
    /// requester by has_one (RequesterAccountMismatch) and used only as the
    /// rent destination (SPEC 7.7, D92).
    #[account(mut)]
    pub requester: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = requester @ EscrowError::RequesterAccountMismatch,
        constraint = bounty.state == BountyState::Submitted @ EscrowError::BountyNotReleasable,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump
    )]
    pub bounty: Box<Account<'info, Bounty>>,
    /// The configured mint by address (D83); `Account<Mint>` enforces the owner.
    #[account(address = config.usdc_mint @ EscrowError::MintMismatch)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bounty
    )]
    pub bounty_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: never read; bound to the stored Scout by the ScoutMismatch
    /// constraint and used only as the payout account's derivation wallet
    /// (SPEC 7.7).
    #[account(constraint = bounty.scout == Some(scout.key()) @ EscrowError::ScoutMismatch)]
    pub scout: UncheckedAccount<'info>,
    /// The Scout payout account (D92): the stored Scout's associated token
    /// account for the configured mint. The program never creates it.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = scout,
        constraint = scout_payout.mint == config.usdc_mint @ EscrowError::MintMismatch
    )]
    pub scout_payout: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// SPEC 7.7. Four handler checks, then the effects of section 7.6 in D99's
/// order: the terminal state is written before the token CPI, then the
/// entire vault balance is paid to the Scout and the vault closed. The
/// bounty account stays open (D96). No event.
pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bounty = &ctx.accounts.bounty;
    let payout_amount = ctx.accounts.bounty_vault.amount;

    // Check 1: the section 4.1 invariant, at the field this instruction reads.
    // A review item: `submit_attestation` writes it as it enters `Submitted`.
    let submitted_at = bounty
        .submitted_at
        .ok_or(EscrowError::StateInvariantViolated)?;
    // Check 2: the review window end, the addition checked (SPEC 1.3).
    let review_window_end = submitted_at
        .checked_add(bounty.review_window_secs)
        .ok_or(EscrowError::TimestampOverflow)?;
    // Check 3: strictly later than the end, the complement of `reject`'s
    // at-or-before on the same bound (D81, D92, D93).
    require!(now > review_window_end, EscrowError::ReviewWindowOpen);
    // Check 4: the vault holds at least reward_amount. Unreachable by
    // construction, since only the bounty PDA can move vault tokens; checked
    // to fail closed (SPEC 7.3).
    require!(
        payout_amount >= bounty.reward_amount,
        EscrowError::VaultBalanceBelowReward
    );

    // Effect 1: state Paid, before any CPI (D99).
    let bounty = &mut ctx.accounts.bounty;
    bounty.state = BountyState::Paid;

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

    // Effect 2: the vault's entire balance to scout_payout, signed by the
    // bounty PDA. Donated tokens go to the Scout (D92).
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.bounty_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.scout_payout.to_account_info(),
                authority: ctx.accounts.bounty.to_account_info(),
            },
            signer_seeds,
        ),
        payout_amount,
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
