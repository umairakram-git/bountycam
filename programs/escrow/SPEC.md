# Escrow Program Specification (Session 4)

Scope: account structure and two instructions only. No submission, no
approval, no attestation logic.

USDC is held in a PDA-owned associated token account, never by a
program-wide authority.

## Bounty account

PDA seeded on `["bounty", requester, bounty_id]`.

| Field | Type | Notes |
|---|---|---|
| bounty_id | `[u8; 16]` | uuid from the database |
| requester | `Pubkey` | |
| scout | `Option<Pubkey>` | `None` until accepted |
| usdc_mint | `Pubkey` | |
| reward_amount | `u64` | |
| platform_fee | `u64` | computed: `reward_amount * PLATFORM_FEE_BPS / 10_000`, `PLATFORM_FEE_BPS = 250` (not an instruction argument) |
| policy_hash | `[u8; 32]` | |
| required_assurance | `u8` | max 4 (`MAX_ASSURANCE_LEVEL`) |
| attester_authority | `Pubkey` | instruction argument |
| arbiter_authority | `Pubkey` | taken from an account in the context (not an instruction argument) |
| deadline | `i64` | unix timestamp |
| review_window_secs | `i64` | |
| submitted_at | `Option<i64>` | |
| merkle_root | `Option<[u8; 32]>` | |
| achieved_assurance | `Option<u8>` | |
| state | `BountyState` | |
| bump | `u8` | PDA bump |

## BountyState

`Funded, Accepted, Submitted, InReview, Approved, Rejected, Disputed,
Paid, Refunded, Expired, Cancelled`

## Instructions

### 1. `create_and_fund(bounty_id, reward_amount, policy_hash, required_assurance, attester_authority, deadline, review_window_secs)`

- Signer: requester
- Initialises the Bounty PDA and its USDC associated token account
  (authority = bounty PDA)
- Transfers `reward_amount + platform_fee` from the requester's USDC ATA
  into the vault (`transfer_checked` via anchor_spl; no hand-rolled CPI)
- Sets `state = Funded`
- Rejects (custom errors):
  - `reward_amount == 0` → `InvalidRewardAmount`
  - `deadline <= now` → `DeadlineInPast`
  - `required_assurance > 4` → `AssuranceTooHigh`
  - requester token account mint mismatch → `MintMismatch`

### 2. `cancel()`

- Signer: requester only (`has_one` → `UnauthorizedRequester`)
- Only valid while `state == Funded` (no scout has accepted) →
  `BountyNotCancellable` otherwise
- Returns all USDC to the requester's ATA, closes the vault token
  account and the Bounty PDA, rent back to requester

## Custom errors (error.rs, explicit discriminants; on-chain code = 6000 + n)

| n | Name | Message |
|---|---|---|
| 0 | InvalidRewardAmount | reward_amount must be greater than zero |
| 1 | DeadlineInPast | deadline must be in the future |
| 2 | AssuranceTooHigh | required_assurance must not exceed the maximum assurance level |
| 3 | MintMismatch | token account mint does not match the bounty USDC mint |
| 4 | UnauthorizedRequester | only the bounty requester may perform this action |
| 5 | BountyNotCancellable | bounty can only be cancelled while it is in the Funded state |
| 6 | AmountOverflow | arithmetic overflow while computing fee or total |

## Negative test cases (tests written before implementation)

Each must fail with a named error, not a generic panic:

1. Non-requester calls `cancel` → `UnauthorizedRequester`
2. `cancel` when state is Accepted → `BountyNotCancellable`
3. `create_and_fund` with `reward_amount = 0` → `InvalidRewardAmount`
4. `create_and_fund` with a past deadline → `DeadlineInPast`
5. `create_and_fund` with `required_assurance = 5` → `AssuranceTooHigh`
6. `create_and_fund` twice with the same `bounty_id` (PDA collision) →
   system program `AccountAlreadyInUse` ("already in use"); a custom
   error is unreachable because the collision is rejected inside the
   system program CPI before program code runs
7. `cancel` twice (account already closed) → Anchor
   `AccountNotInitialized`; a custom error is unreachable because
   deserialisation of the closed account fails before the handler
8. Transfer attempted with the wrong mint → `MintMismatch`
