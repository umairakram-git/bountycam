use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::EscrowError, state::*};

/// SPEC 7.6. The requester approves a submitted bounty; the vault's entire
/// balance goes to the Scout payout account (D92).
#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = requester @ EscrowError::UnauthorizedRequester,
        constraint = bounty.state == BountyState::Submitted @ EscrowError::BountyNotApprovable,
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
    /// (SPEC 7.6).
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

/// SPEC 7.6. One handler check, then the effects in D99's order: the
/// terminal state is written before the token CPI, then the entire vault
/// balance is paid to the Scout and the vault closed. The bounty account
/// stays open (D96). No event.
pub fn handle_approve(ctx: Context<Approve>) -> Result<()> {
    let payout_amount = ctx.accounts.bounty_vault.amount;

    // Check 1: the vault holds at least reward_amount. Unreachable by
    // construction, since only the bounty PDA can move vault tokens; checked
    // to fail closed (SPEC 7.3).
    require!(
        payout_amount >= ctx.accounts.bounty.reward_amount,
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
