use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, error::EscrowError, state::*};

/// SPEC 7.9. The two outcomes are D94's; another needs its own D-entry.
/// Serialised as one byte; any other value fails argument decoding with
/// `InstructionDidNotDeserialize` before any account is loaded.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResolveOutcome {
    PayScout,        // 0
    RefundRequester, // 1
}

/// SPEC 7.9. The configured arbiter resolves a disputed bounty to one side,
/// never split (D94). The destination is a plain token account checked in
/// the handler, because the wallet it must belong to depends on the outcome.
/// Four accounts are boxed (D100).
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(address = config.arbiter_authority @ EscrowError::UnauthorizedArbiter)]
    pub arbiter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: never read and does not sign; bound to the bounty's stored
    /// requester by has_one (RequesterAccountMismatch) and used only as the
    /// rent destination (SPEC 7.9, D94).
    #[account(mut)]
    pub requester: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = requester @ EscrowError::RequesterAccountMismatch,
        constraint = bounty.state == BountyState::Disputed @ EscrowError::BountyNotResolvable,
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
    /// The paid party's token account: the Scout payout account for
    /// `PayScout`, the requester's associated token account for
    /// `RefundRequester`. Checked in the handler (SPEC 7.9 checks 3 to 5).
    #[account(mut)]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// SPEC 7.9. Six handler checks, then the effects in D99's order: the
/// terminal state for the outcome is written before the token CPI, then the
/// entire vault balance goes to the destination and the vault is closed. The
/// bounty account stays open (D96). No event.
pub fn handle_resolve(ctx: Context<Resolve>, outcome: ResolveOutcome) -> Result<()> {
    let bounty = &ctx.accounts.bounty;
    let config = &ctx.accounts.config;
    let destination = &ctx.accounts.destination;
    let arbiter = ctx.accounts.arbiter.key();
    let settled_amount = ctx.accounts.bounty_vault.amount;

    // Check 1: the section 4.1 invariant, at the field this instruction reads.
    // A review item: `accept` writes it and every path to `Disputed` passes
    // through it.
    let scout = bounty.scout.ok_or(EscrowError::StateInvariantViolated)?;
    // Check 2: the arbiter is neither party (D94). D83's distinctness covers
    // the configured keys only.
    require!(
        arbiter != bounty.requester && arbiter != scout,
        EscrowError::ArbiterIsParty
    );
    // Check 3: the named wallet owns the destination. Owner before address,
    // as the associated-token constraint orders them (SPEC 7.6, 7.10).
    let (named_wallet, settled_state) = match outcome {
        ResolveOutcome::PayScout => (scout, BountyState::Paid),
        ResolveOutcome::RefundRequester => (bounty.requester, BountyState::Refunded),
    };
    require_keys_eq!(
        destination.owner,
        named_wallet,
        EscrowError::TokenAccountOwnerMismatch
    );
    // Check 4: the destination is that wallet's associated token account for
    // the configured mint under the classic SPL Token program.
    require_keys_eq!(
        destination.key(),
        get_associated_token_address(&named_wallet, &config.usdc_mint),
        EscrowError::DestinationAccountMismatch
    );
    // Check 5: cannot fail once check 4 holds; checked to fail closed.
    require_keys_eq!(destination.mint, config.usdc_mint, EscrowError::MintMismatch);
    // Check 6: the vault holds at least reward_amount. Unreachable by
    // construction, since only the bounty PDA can move vault tokens; checked
    // to fail closed (SPEC 7.3).
    require!(
        settled_amount >= bounty.reward_amount,
        EscrowError::VaultBalanceBelowReward
    );

    // Effect 1: the outcome's terminal state, before any CPI (D99).
    let bounty = &mut ctx.accounts.bounty;
    bounty.state = settled_state;

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

    // Effect 2: the vault's entire balance to the destination, signed by the
    // bounty PDA. Donated tokens go with the reward (D94).
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.bounty_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.bounty.to_account_info(),
            },
            signer_seeds,
        ),
        settled_amount,
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
