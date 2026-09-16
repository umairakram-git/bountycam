use anchor_lang::prelude::*;

#[constant]
pub const BOUNTY_SEED: &[u8] = b"bounty";

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Highest assurance level a policy may require.
#[constant]
pub const MAX_ASSURANCE_LEVEL: u8 = 4;

/// Compiled ceilings for the three windows (D81). Each window must be at
/// least 1 and at most its ceiling.
#[constant]
pub const MAX_ACCEPTANCE_WINDOW_SECS: i64 = 2_592_000;

#[constant]
pub const MAX_COMPLETION_WINDOW_SECS: i64 = 2_592_000;

#[constant]
pub const MAX_REVIEW_WINDOW_SECS: i64 = 86_400;
