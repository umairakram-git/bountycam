use anchor_lang::prelude::*;

// SPEC section 10. Final on-chain error codes are these discriminants plus
// Anchor's custom error offset of 6000 (e.g. InvalidRewardAmount = 6000).
// Append-only (D75): existing variants are never reordered, inserted around or
// removed. A retired variant keeps its code and is never emitted.
#[error_code]
pub enum EscrowError {
    #[msg("reward_amount must be greater than zero")]
    InvalidRewardAmount = 0,
    /// Retired by D81; never emitted.
    #[msg("deadline must be in the future")]
    DeadlineInPast = 1,
    #[msg("required_assurance must not exceed the maximum assurance level")]
    AssuranceTooHigh = 2,
    #[msg("mint or token account mint does not match the configured USDC mint")]
    MintMismatch = 3,
    #[msg("only the bounty requester may perform this action")]
    UnauthorizedRequester = 4,
    #[msg("bounty can only be cancelled while it is in the Funded state")]
    BountyNotCancellable = 5,
    /// Retired by D67; reserved, never emitted.
    #[msg("arithmetic overflow while computing fee or total")]
    AmountOverflow = 6,
    #[msg("token account is not owned by the expected wallet")]
    TokenAccountOwnerMismatch = 7,
    #[msg("acceptance_window_secs must be between 1 and 2592000")]
    InvalidAcceptanceWindow = 8,
    #[msg("completion_window_secs must be between 1 and 2592000")]
    InvalidCompletionWindow = 9,
    #[msg("review_window_secs must be between 1 and 86400")]
    InvalidReviewWindow = 10,
    #[msg("clock plus window overflows i64")]
    TimestampOverflow = 11,
    #[msg("ProgramData account is not at the derived address")]
    InvalidProgramData = 12,
    #[msg("ProgramData records no upgrade authority")]
    ProgramNotUpgradeable = 13,
    #[msg("signer is not the recorded upgrade authority")]
    UnauthorizedInitializer = 14,
    #[msg("two configured authorities are equal")]
    AuthoritiesNotDistinct = 15,
    #[msg("a configured authority is the all-zero key")]
    InvalidAuthorityKey = 16,
    #[msg("bounty can only be accepted while it is in the Funded state")]
    BountyNotAcceptable = 17,
    #[msg("acceptance_cutoff has passed")]
    AcceptanceWindowClosed = 18,
    #[msg("scout must differ from the requester")]
    ScoutIsRequester = 19,
    #[msg("voucher expires_at has passed")]
    VoucherExpired = 20,
    #[msg("attestation can only be submitted while the bounty is Accepted")]
    BountyNotAttestable = 21,
    #[msg("submission deadline has passed")]
    SubmissionDeadlinePassed = 22,
    #[msg("achieved_assurance exceeds the maximum assurance level")]
    AchievedAssuranceOutOfRange = 23,
    #[msg("achieved_assurance is below required_assurance")]
    InsufficientAssurance = 24,
    #[msg("instruction must be invoked at the transaction top level")]
    InvocationNotTopLevel = 25,
    #[msg("account is not the Instructions sysvar")]
    InvalidInstructionsSysvar = 26,
    #[msg("verification instruction index is not before the current instruction")]
    VerificationIndexInvalid = 27,
    #[msg("designated instruction is not the native ed25519 program")]
    NotEd25519Instruction = 28,
    #[msg("designated ed25519 instruction is not in the canonical shape")]
    MalformedVerificationInstruction = 29,
    #[msg("verified public key is not the configured authority")]
    VerificationAuthorityMismatch = 30,
    #[msg("verified message differs from the reconstruction")]
    VerificationMessageMismatch = 31,
    #[msg("vault balance is below reward_amount")]
    VaultBalanceBelowReward = 32,
    #[msg("bounty Option field invariant is broken")]
    StateInvariantViolated = 33,
}
