use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    constants::*,
    error::EscrowError,
    messages::{eligibility_message, MessagePrefix},
    state::*,
    verification::verify_ed25519_instruction,
};

#[derive(Accounts)]
pub struct Accept<'info> {
    pub scout: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump,
        constraint = bounty.state == BountyState::Funded @ EscrowError::BountyNotAcceptable
    )]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: address-constrained to the native Instructions sysvar (SPEC 6.2
    /// check 1); read only through the sysvar loaders.
    #[account(address = solana_instructions_sysvar::ID @ EscrowError::InvalidInstructionsSysvar)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// SPEC 7.4. Trusted state first, then the signature, then the signed caller
/// value (D85's rule). No token accounts: `accept` moves no USDC (D49).
pub fn handle_accept(
    ctx: Context<Accept>,
    expires_at: i64,
    verification_instruction_index: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Check 1 (section 6.3): top level only; CPI is rejected outright (D71).
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        EscrowError::InvocationNotTopLevel
    );

    let bounty = &ctx.accounts.bounty;
    let config = &ctx.accounts.config;
    let scout = ctx.accounts.scout.key();

    // Check 2.
    require!(
        now <= bounty.acceptance_cutoff,
        EscrowError::AcceptanceWindowClosed
    );
    // Check 3.
    require_keys_neq!(scout, bounty.requester, EscrowError::ScoutIsRequester);

    // Check 4: reconstruct the 212-byte voucher (MESSAGES.md sections 4 and 5).
    let prefix = MessagePrefix {
        deployment_id: config.deployment_id,
        program_id: &crate::ID,
        bounty_id: &bounty.bounty_id,
        requester: &bounty.requester,
        scout: &scout,
        policy_hash: &bounty.policy_hash,
        eligibility_profile_hash: &bounty.eligibility_profile_hash,
        required_assurance: bounty.required_assurance,
    };
    let message = eligibility_message(&prefix, expires_at);

    // Check 5: section 6 against the configured eligibility authority.
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        verification_instruction_index,
        &config.eligibility_authority,
        &message,
    )?;

    // Check 6: the signed caller value, reported only once authenticated.
    require!(now <= expires_at, EscrowError::VoucherExpired);
    // Check 7.
    let deadline = now
        .checked_add(bounty.completion_window_secs)
        .ok_or(EscrowError::TimestampOverflow)?;

    // Effects: scout, deadline, state. No money moves. No event.
    let bounty = &mut ctx.accounts.bounty;
    bounty.scout = Some(scout);
    bounty.deadline = Some(deadline);
    bounty.state = BountyState::Accepted;
    Ok(())
}
