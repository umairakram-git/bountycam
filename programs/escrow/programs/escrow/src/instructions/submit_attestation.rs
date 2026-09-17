use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    constants::*,
    error::EscrowError,
    messages::{attestation_message, MessagePrefix},
    state::*,
    verification::verify_ed25519_instruction,
};

/// No signer account (D85): any fee payer may submit; normally the relayer
/// does. The authority is the attester's signature, verified per section 6.
#[derive(Accounts)]
pub struct SubmitAttestation<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [BOUNTY_SEED, bounty.requester.as_ref(), bounty.bounty_id.as_ref()],
        bump = bounty.bump,
        constraint = bounty.state == BountyState::Accepted @ EscrowError::BountyNotAttestable
    )]
    pub bounty: Account<'info, Bounty>,
    /// CHECK: address-constrained to the native Instructions sysvar (SPEC 6.2
    /// check 1); read only through the sysvar loaders.
    #[account(address = solana_instructions_sysvar::ID @ EscrowError::InvalidInstructionsSysvar)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// SPEC 7.5. Every check precedes every write, so a failing check writes
/// nothing (D85). No money moves. No event.
pub fn handle_submit_attestation(
    ctx: Context<SubmitAttestation>,
    evidence_root: [u8; 32],
    achieved_assurance: u8,
    issued_at: i64,
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

    // Check 2: both accept-written fields are Some (section 4.1 invariant).
    // A match on the pair, so neither Option is unwrapped; any other
    // combination is the named error.
    let (scout, deadline) = match (bounty.scout, bounty.deadline) {
        (Some(scout), Some(deadline)) => (scout, deadline),
        _ => return err!(EscrowError::StateInvariantViolated),
    };
    // Check 3.
    require!(now <= deadline, EscrowError::SubmissionDeadlinePassed);

    // Check 4: reconstruct the 261-byte attestation (MESSAGES.md sections 3
    // and 5): the shared prefix from configuration and state, then deadline
    // and review window from state, then the three caller arguments.
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
    let message = attestation_message(
        &prefix,
        deadline,
        bounty.review_window_secs,
        &evidence_root,
        achieved_assurance,
        issued_at, // compared with nothing (D82)
    );

    // Check 5: section 6 against the configured attester (D82).
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        verification_instruction_index,
        &config.attester_authority,
        &message,
    )?;

    // Check 6.
    require!(
        achieved_assurance <= MAX_ASSURANCE_LEVEL,
        EscrowError::AchievedAssuranceOutOfRange
    );
    // Check 7: an attested shortfall, reported only once authenticated; no
    // state change, no field written, no event (D85).
    require!(
        achieved_assurance >= bounty.required_assurance,
        EscrowError::InsufficientAssurance
    );

    // Effects: evidence_root, achieved_assurance, submitted_at, state.
    let bounty = &mut ctx.accounts.bounty;
    bounty.evidence_root = Some(evidence_root);
    bounty.achieved_assurance = Some(achieved_assurance);
    bounty.submitted_at = Some(now);
    bounty.state = BountyState::Submitted;
    Ok(())
}
