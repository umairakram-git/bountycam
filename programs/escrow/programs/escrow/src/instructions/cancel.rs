use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::EscrowError, events::BountyCancelled, state::*};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = requester,
        has_one = requester @ EscrowError::UnauthorizedRequester,
        constraint = bounty.state == BountyState::Funded @ EscrowError::BountyNotCancellable,
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
    #[account(
        mut,
        constraint = requester_ata.mint == config.usdc_mint @ EscrowError::MintMismatch,
        constraint = requester_ata.owner == requester.key() @ EscrowError::TokenAccountOwnerMismatch
    )]
    pub requester_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// SPEC 7.3. One handler check, then D76's effect order: refund the entire
/// vault balance, emit, close the vault, close the bounty.
pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bounty = &ctx.accounts.bounty;
    let refunded_amount = ctx.accounts.bounty_vault.amount;

    // Check 1: the vault holds at least reward_amount. Unreachable by
    // construction, since only the bounty PDA can move vault tokens; checked
    // to fail closed (SPEC 7.3).
    require!(
        refunded_amount >= bounty.reward_amount,
        EscrowError::VaultBalanceBelowReward
    );

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

    // Effect 1: the vault's entire balance to requester_ata, signed by the
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

    // Effect 2: emit, before the accounts close (D76).
    emit!(BountyCancelled {
        bounty: bounty.key(),
        bounty_id,
        requester: requester_key,
        usdc_mint: ctx.accounts.config.usdc_mint,
        reward_amount: bounty.reward_amount,
        refunded_amount,
        cancelled_at: now,
    });

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

    // Effect 4: the bounty is closed to the requester by the `close`
    // constraint after this handler returns.
    Ok(())
}
