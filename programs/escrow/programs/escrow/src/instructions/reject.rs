use anchor_lang::prelude::*;

use crate::{constants::*, error::EscrowError, state::*};

/// SPEC 7.8. No configuration, mint or token accounts: `reject` moves no
/// USDC (D93).
#[derive(Accounts)]
pub struct Reject<'info> {
    pub requester: Signer<'info>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump,
        has_one = requester @ EscrowError::UnauthorizedRequester,
        constraint = bounty.state == BountyState::Submitted @ EscrowError::BountyNotRejectable
    )]
    pub bounty: Account<'info, Bounty>,
}

/// SPEC 7.8. Trusted state first, then the argument (D85's rule). Every
/// check precedes every write. Effects: `failed_requirement_id` from the
/// argument; `state` `Disputed`. No money moves. No event.
pub fn handle_reject(ctx: Context<Reject>, failed_requirement_id: [u8; 16]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bounty = &ctx.accounts.bounty;

    // Check 1: the section 4.1 invariant, at the field this instruction reads.
    // A review item: `submit_attestation` writes it as it enters `Submitted`.
    let submitted_at = bounty
        .submitted_at
        .ok_or(EscrowError::StateInvariantViolated)?;
    // Check 2: the review window end, the addition checked (SPEC 1.3).
    let review_window_end = submitted_at
        .checked_add(bounty.review_window_secs)
        .ok_or(EscrowError::TimestampOverflow)?;
    // Check 3: at or before the end (D81, D93).
    require!(now <= review_window_end, EscrowError::ReviewWindowClosed);
    // Check 4: the argument, checked after the trusted state. No version 4
    // uuid is all zero (D93).
    require!(
        failed_requirement_id != [0u8; 16],
        EscrowError::InvalidRequirementId
    );

    // Effects.
    let bounty = &mut ctx.accounts.bounty;
    bounty.failed_requirement_id = Some(failed_requirement_id);
    bounty.state = BountyState::Disputed;
    Ok(())
}
