use anchor_lang::prelude::*;

#[constant]
pub const BOUNTY_SEED: &[u8] = b"bounty";

/// Platform fee in basis points, charged on top of the reward.
#[constant]
pub const PLATFORM_FEE_BPS: u64 = 0;

/// Highest assurance level a policy may require.
#[constant]
pub const MAX_ASSURANCE_LEVEL: u8 = 4;
