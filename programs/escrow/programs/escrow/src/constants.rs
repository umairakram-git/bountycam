use anchor_lang::prelude::*;

#[constant]
pub const BOUNTY_SEED: &[u8] = b"bounty";

/// Highest assurance level a policy may require.
#[constant]
pub const MAX_ASSURANCE_LEVEL: u8 = 4;
