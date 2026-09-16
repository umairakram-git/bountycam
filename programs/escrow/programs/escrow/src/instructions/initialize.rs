use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable};
use anchor_spl::token::Mint;

use crate::{constants::*, error::EscrowError, state::*};

/// The ProgramData address of this program under the upgradeable loader
/// (SPEC 7.1 check 1, D83). Derived, never taken from a caller-supplied
/// program account.
pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// Classic SPL Token mint: `Account<Mint>` enforces the owner (D83).
    pub usdc_mint: Account<'info, Mint>,
    #[account(address = program_data_address() @ EscrowError::InvalidProgramData)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    deployment_id: u8,
    eligibility_authority: Pubkey,
    attester_authority: Pubkey,
    arbiter_authority: Pubkey,
) -> Result<()> {
    // SPEC 7.1 checks 2 and 3: the recorded upgrade authority exists and is
    // the signer.
    let recorded = ctx
        .accounts
        .program_data
        .upgrade_authority_address
        .ok_or(EscrowError::ProgramNotUpgradeable)?;
    require_keys_eq!(
        recorded,
        ctx.accounts.authority.key(),
        EscrowError::UnauthorizedInitializer
    );

    // Check 4: no configured key is the all-zero key.
    let keys = [eligibility_authority, attester_authority, arbiter_authority];
    require!(
        keys.iter().all(|k| *k != Pubkey::default()),
        EscrowError::InvalidAuthorityKey
    );

    // Check 5: the three keys are pairwise distinct.
    require!(
        keys[0] != keys[1] && keys[0] != keys[2] && keys[1] != keys[2],
        EscrowError::AuthoritiesNotDistinct
    );

    ctx.accounts.config.set_inner(Config {
        deployment_id,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        eligibility_authority,
        attester_authority,
        arbiter_authority,
        bump: ctx.bumps.config,
    });

    Ok(())
}
