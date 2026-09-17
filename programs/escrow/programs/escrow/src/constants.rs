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

/// The native ed25519 verifier (SPEC 6.2 check 4). Literal from solana-sdk-ids
/// 3.1.0 `ed25519_program`, which anchor-lang 1.1.2 does not re-export.
pub const ED25519_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");

/// SPEC section 6.1 and section 9: the canonical ed25519 instruction layout of
/// `solana-ed25519-program` 3.0.0. Bytes 0 to 15 are the header; the public
/// key, signature and message follow at these offsets.
pub const ED25519_HEADER_LEN: usize = 16;
pub const ED25519_PUBKEY_OFFSET: usize = 16;
pub const ED25519_SIGNATURE_OFFSET: usize = 48;
pub const ED25519_MESSAGE_OFFSET: usize = 112;
