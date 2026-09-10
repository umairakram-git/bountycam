use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::EscrowError, state::*};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        mut,
        close = requester,
        has_one = requester @ EscrowError::UnauthorizedRequester,
        has_one = usdc_mint @ EscrowError::MintMismatch,
        constraint = bounty.state == BountyState::Funded @ EscrowError::BountyNotCancellable,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump
    )]
    pub bounty: Account<'info, Bounty>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bounty
    )]
    pub bounty_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = requester_ata.mint == usdc_mint.key() @ EscrowError::MintMismatch,
        constraint = requester_ata.owner == requester.key() @ EscrowError::UnauthorizedRequester
    )]
    pub requester_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let requester_key = ctx.accounts.bounty.requester;
    let bounty_id = ctx.accounts.bounty.bounty_id;
    let bump = ctx.accounts.bounty.bump;
    let seeds: &[&[u8]] = &[
        BOUNTY_SEED,
        requester_key.as_ref(),
        bounty_id.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[seeds];

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
        ctx.accounts.bounty_vault.amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.bounty_vault.to_account_info(),
            destination: ctx.accounts.requester.to_account_info(),
            authority: ctx.accounts.bounty.to_account_info(),
        },
        signer_seeds,
    ))?;

    // The Bounty PDA itself is closed to the requester by the `close`
    // constraint after this handler returns.
    Ok(())
}
