//! Test-only program for SPEC tests 55 and 69 (section 12 harness rules,
//! task 16). It forwards one instruction to the escrow program by CPI so the
//! tests can show `accept` and `submit_attestation` rejecting a non-top-level
//! invocation. It is excluded from Anchor's workspace (Anchor.toml
//! `[workspace] exclude`) and built with `cargo build-sbf` as the second step
//! of the counted run. It is never deployed: its ID is an off-curve fill
//! pattern no keypair can match, and devnet deploys use
//! `anchor deploy --program-name escrow` only.

use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke},
};

declare_id!("ESrpUvg2gM75m1mzoSuquCaoabs42edBCCdabdvDgJBg");

/// The only CPI target. Hard-coded; a transaction naming any other program
/// account fails the `address` constraint below.
pub const ESCROW_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS");

#[program]
pub mod cpi_caller {
    use super::*;

    /// Invokes the escrow program with `data` unchanged and every remaining
    /// account forwarded with its signer and writable flags as received.
    pub fn forward<'info>(ctx: Context<'info, Forward<'info>>, data: Vec<u8>) -> Result<()> {
        let accounts = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction { program_id: ESCROW_PROGRAM_ID, accounts, data };
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.escrow_program.to_account_info());
        invoke(&ix, &infos)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: the escrow program account, pinned by address and required to be
    /// executable; it exists so the runtime can resolve the CPI target.
    #[account(address = ESCROW_PROGRAM_ID, executable)]
    pub escrow_program: UncheckedAccount<'info>,
}
