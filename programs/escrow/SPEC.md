# Escrow Program Specification

**Path:** `programs/escrow/SPEC.md`
**Status:** normative for the escrow program's accounts, state machine, authorities and the
instructions `initialize`, `create_and_fund`, `cancel`, `accept` and `submit_attestation`.
**Supersedes:** the Session 4 post-hoc specification (file sha256
`a50e20d905b11cc087c8f58db747d67cb36ee85a8cacf771106f70b6ca0fadb8`), wholesale, per D80. That
file documented what was built rather than constraining it. Git history preserves it; it is
never read as authority.
**Change control:** a change to this document that alters behaviour needs a D-entry.
**Style:** per D31 — no line over 100 characters; escape sequences described in words.

---

## 1. Authority, scope and terms

### 1.1 Authority order

On conflict, in order (D50, D80):

1. `SECURITY.md`, then held DECISIONS.md entries.
2. The intended state machine and policy specifications: `apps/api/POLICY.md` for the policy
   object, `packages/shared/SPEC.md` for canonicalisation and hashing,
   `packages/shared/MESSAGES.md` and its published vectors for the two signed binary layouts.
3. This document.
4. Existing source and tests, only for behaviour nothing above governs.

The Session 4 specification is not in this list. Where current source differs from this
document, the difference is an implementation task (section 13), never a reason to widen this
document to match.

This document references byte layouts rather than restating them. `MESSAGES.md` wins on every
offset, width, signedness and domain tag.

### 1.2 Scope

In scope: the configuration account, the bounty account, the on-chain state enum and every
transition into and out of the states it holds, and five instructions.

Out of scope and named only: `approve`, `reject`, `resolve` and `expire`, which are Session 9's
to specify (D80), together with the states they introduce and the Scout payout account. Writing
them here would repeat, in the other direction, the error D80 corrects.

D1's "six instructions" is superseded. After Session 9 the program has nine: the five here and
Session 9's four.

### 1.3 Terms

- **now** — `Clock::get()?.unix_timestamp`, read once per instruction, signed 64-bit.
- **at or before** — an instruction succeeds when `now` is less than or equal to the bound,
  and fails one second later (D81).
- **configured** — held in the configuration account (section 3).
- **fail closed** — any unexpected account, owner, mint, signer, program, state or byte shape is
  rejected with the error named for it (SECURITY.md section 0).

Naming mapping (D72). The canonical policy JSON field `challenge_window_seconds`, the on-chain
field `review_window_secs`, and the prose term *review window* are the same concept.
`challenge_window_seconds` is retained solely for compatibility with the hashed-policy schema
and must never be read as the SIWS challenge or the capture nonce. Bare "challenge" is not a
term in this document.

---

## 2. Authorities

| Authority | Established by | Source of the key |
|---|---|---|
| upgrade authority | `Signer`, equal to ProgramData's recorded authority | ProgramData |
| requester | `Signer`, `has_one` to the bounty | bounty account |
| Scout | `Signer` at `accept`; stored by `accept` | voucher, then bounty |
| eligibility authority | designated ed25519 verification (section 6) | configuration |
| attester authority | designated ed25519 verification (section 6) | configuration |
| arbiter authority | `Signer` in Session 9's `resolve` | configuration |
| relayer | transaction fee payer only | none — never read |

Rules:

- The eligibility and attester authorities are never transaction signers (SECURITY.md section 8).
- No instruction takes an authority key from instruction arguments or an unchecked account, and
  no bounty snapshots one (D74, D82, D83). The key in configuration at execution time governs.
- The three configured keys are pairwise distinct and none is the all-zero key (section 7.1).
- The relayer has no program-level identity. Every instruction is safe if the fee payer is
  malicious (SECURITY.md section 2).
- `accept` requires the Scout to differ from the requester (section 7.4). SECURITY.md section 8
  requires distinct roles to be distinct accounts, and a requester accepting their own bounty
  would inflate their own reputation.

---

## 3. The configuration account

One account per deployment (D83). PDA seeded on the single literal `b"config"`, canonical bump.

| Field | Type | Purpose |
|---|---|---|
| `deployment_id` | `u8` | signed into both binary messages; cluster separation (D70) |
| `usdc_mint` | `Pubkey` | the only mint any instruction accepts (D83) |
| `eligibility_authority` | `Pubkey` | verifies acceptance vouchers (D68) |
| `attester_authority` | `Pubkey` | verifies attestations (D82) |
| `arbiter_authority` | `Pubkey` | read by Session 9's `resolve` (D74) |
| `bump` | `u8` | canonical PDA bump |

Space: 8 discriminator bytes plus 130, total 138. All fields are fixed width.

Written only by `initialize`, once. No instruction updates or closes it. Rotation of any value
requires a deliberately authorised upgrade carrying a migration or a new versioned account,
under its own D-entry; under SECURITY-PRODUCTION.md section 1 that mechanism is a mainnet
blocker (D83).

`arbiter_authority` has no reader until Session 9. It is stored now because the configuration is
immutable and Session 9 cannot add it without a migration.

---

## 4. The bounty account

PDA seeded on `b"bounty"`, the requester's 32 key bytes, and the 16 `bounty_id` bytes, with the
canonical bump. `bounty_id` is unique only per requester (MESSAGES.md section 4).

### 4.1 Fields, in serialised order

Fixed-width fields come first and every `Option` field comes last. Borsh writes `None` as one
byte and `Some` as one byte plus the value, so anything after an `Option` has no fixed offset.
This order gives every non-`Option` field a stable offset for account filters.

| Offset | Field | Type | Written by | Purpose |
|---|---|---|---|---|
| 8 | `bounty_id` | `[u8; 16]` | create | PDA seed; message field |
| 24 | `requester` | `Pubkey` | create | PDA seed; authority; refund owner |
| 56 | `reward_amount` | `u64` | create | vault funding amount (D67) |
| 64 | `platform_fee` | `u64` | create, always 0 | D8 field; no reader (D67) |
| 72 | `policy_hash` | `[u8; 32]` | create | commitment; message field |
| 104 | `eligibility_profile_hash` | `[u8; 32]` | create | message field (D84) |
| 136 | `required_assurance` | `u8` | create | payout gate (D17); message field |
| 137 | `acceptance_window_secs` | `i64` | create | cutoff source (D81) |
| 145 | `completion_window_secs` | `i64` | create | deadline source (D81) |
| 153 | `review_window_secs` | `i64` | create | Session 9 review window; signed |
| 161 | `acceptance_cutoff` | `i64` | create | last second `accept` succeeds |
| 169 | `state` | `BountyState` | all | section 5 |
| 170 | `bump` | `u8` | create | canonical PDA bump |
| 171 | `scout` | `Option<Pubkey>` | accept | payout identity; message field |
| var | `deadline` | `Option<i64>` | accept | last second an attestation lands |
| var | `submitted_at` | `Option<i64>` | submit | review window start for Session 9 |
| var | `evidence_root` | `Option<[u8; 32]>` | submit | attested evidence commitment |
| var | `achieved_assurance` | `Option<u8>` | submit | attested level; legible record (D17) |

Maximum space: 8 discriminator bytes plus 249, total 257, allocated at creation.

`Option` invariant: while `Funded`, all five `Option` fields are `None`. `accept` sets `scout`
and `deadline`. `submit_attestation` sets `submitted_at`, `evidence_root` and
`achieved_assurance`. Nothing clears a field once set. An instruction finding the invariant
broken fails with `StateInvariantViolated`.

`deadline` is `Option` rather than a zero sentinel because zero is a valid signed timestamp in
the published vectors, so a sentinel could not be told apart from a value (D81 leaves the
pre-acceptance representation to this document).

### 4.2 Fields removed from the Session 4 account

| Removed | Decision | Replacement |
|---|---|---|
| `attester_authority` | D82 | configuration |
| `arbiter_authority` | D74 | configuration |
| absolute `deadline` input | D81 | three windows; `deadline` computed at `accept` |
| `usdc_mint` | D83 | configuration; no instruction read the copy |
| `merkle_root` | naming | `evidence_root`, the `MESSAGES.md` field name |

`issued_at` is not stored. D82 forbids treating it as on-chain evidence of time; the chain's own
`submitted_at` is stored instead.

---

## 5. State machine

### 5.1 The enum

```
enum BountyState {
    Funded,     // 0
    Accepted,   // 1
    Submitted,  // 2
}
```

SECURITY.md section 9 permits a variant only if an instruction enters it with defined exits and
tests. The enum therefore holds exactly the states these instructions enter. `Cancelled` is
removed (D76). Session 9 appends its states after `Submitted`; variants are append-only, so the
discriminants above never change.

### 5.2 Transitions

| Instruction | From | To | Signer | Money |
|---|---|---|---|---|
| `create_and_fund` | none | `Funded` | requester | requester ATA to vault: `reward_amount` |
| `cancel` | `Funded` | closed | requester | vault to requester ATA: full balance |
| `accept` | `Funded` | `Accepted` | Scout | none |
| `submit_attestation` | `Accepted` | `Submitted` | none required | none |

Failed instructions change nothing; Solana transactions are atomic.

### 5.3 Exits

- `Funded`: `accept` and `cancel`, specified here. Session 9's `expire` after
  `acceptance_cutoff`.
- `Accepted`: `submit_attestation`, specified here. `cancel` is rejected (D49). Session 9's
  `expire` after `deadline`. An attested shortfall leaves the bounty `Accepted` (D85).
- `Submitted`: Session 9's approval, automatic release at the end of the review window, rejection
  with a named requirement, and dispute resolution (D12).

Stated limit: until Session 9 lands, `Accepted` and `Submitted` have no exit, so their reward
stays locked. Acceptable on devnet test USDC only (D8).

### 5.4 Database projection (informative)

Normative mapping is Session 9's enum reconciliation. Already fixed: a confirmed
`create_and_fund` projects to `AVAILABLE` only when every policy-to-chain binding agrees (D79,
D84); a confirmed `accept` projects to `ACCEPTED` (D79); a confirmed `cancel` of a funded bounty
is `CANCELLED` with the transaction signature and event recorded (D76). `SUBMITTED` is expected
from a confirmed `submit_attestation` (POLICY.md section 7.2).

---

## 6. Designated ed25519 verification

One routine, `verify_ed25519_instruction(sysvar, index, expected_authority, expected_message)`,
used by `accept` and `submit_attestation` (D71). It establishes only that the designated earlier
native ed25519 instruction verified exactly `expected_message` under exactly
`expected_authority`. It knows nothing of vouchers or attestations.

### 6.1 Canonical shape

The one shape accepted, with every offset read little-endian:

| Bytes | Content | Required value |
|---|---|---|
| 0 | signature count | 1 |
| 1 | padding | 0 |
| 2 to 3 | signature offset | 48 |
| 4 to 5 | signature instruction index | 65535 (`u16::MAX`, this instruction) |
| 6 to 7 | public key offset | 16 |
| 8 to 9 | public key instruction index | 65535 |
| 10 to 11 | message offset | 112 |
| 12 to 13 | message size | the expected message length |
| 14 to 15 | message instruction index | 65535 |
| 16 to 47 | public key | the expected authority |
| 48 to 111 | signature | not read by the program |
| 112 to end | message | the expected message |

Total data length: 112 plus the message length — 324 for `BOUNTYCAM_ELIGIBILITY_V1`, 373 for
`BOUNTYCAM_ATTESTATION_V1`. The instruction carries zero accounts.

This is the layout of `new_ed25519_instruction_with_signature` in `solana-ed25519-program`
3.0.0. The native verifier (`agave-precompiles` 3.1.14 and 4.2.2) reads the count from byte 0
only, never checks byte 1, accepts trailing bytes, and accepts a two-byte zero-signature
instruction. The program therefore checks count, padding and exact length itself.

### 6.2 Check order

The first failing check reports its error.

1. The Instructions sysvar account key equals the native Instructions sysvar ID —
   `InvalidInstructionsSysvar`. Enforced as an account address constraint.
2. The current top-level index is loaded from the sysvar.
3. `index` is less than the current index — `VerificationIndexInvalid`. This covers an index
   equal to or after the current instruction and any out-of-range index.
4. The instruction at `index` has the native ed25519 program ID — `NotEd25519Instruction`.
5. Its account list is empty, its data length equals 112 plus the expected message length, and
   bytes 0 to 15 equal the table in section 6.1 — `MalformedVerificationInstruction`.
6. Bytes 16 to 47 equal `expected_authority` — `VerificationAuthorityMismatch`.
7. Bytes 112 to end equal `expected_message` — `VerificationMessageMismatch`.

The program never reads the signature. The designated instruction executed earlier in the same
transaction, and a failed native verification fails the whole transaction.

### 6.3 Rules

- **Top-level only.** Before the routine runs, both callers require `get_stack_height()` to
  equal `TRANSACTION_LEVEL_STACK_HEIGHT` (1) — `InvocationNotTopLevel`. CPI is rejected outright.
- **Reconstruct, then compare.** The caller builds the complete expected message from
  configuration, bounty state and validated arguments (MESSAGES.md section 5). The program never
  parses fields out of the supplied message. It cannot say which field differed, so every
  content difference reports `VerificationMessageMismatch`.
- **Shape failures share one code.** Every section 6.1 deviation is the same client failure —
  the instruction was not built in BountyCam's canonical form.
- **Duplicates.** Other ed25519 instructions neither satisfy nor invalidate the designated one.
  Uniqueness is not scanned for.
- **Cross-type.** An eligibility message on the attestation path, or the reverse, fails check 5:
  the lengths differ (212 against 261), independently of the domain tag.
- **Index type.** `verification_instruction_index` is `u16`, the sysvar's own index type.

---

## 7. Instructions

Within each instruction: Anchor account validation runs first, then the handler checks in the
listed order, then effects. Negative tests introduce exactly one fault each, so no test depends
on Anchor's order across different accounts.

### 7.1 `initialize`

Arguments: `deployment_id: u8`, `eligibility_authority: Pubkey`,
`attester_authority: Pubkey`, `arbiter_authority: Pubkey`.

Accounts:

| Account | Type and constraints |
|---|---|
| `authority` | `Signer`, mutable (rent payer) |
| `config` | `init`, seeds `[b"config"]`, canonical bump, space 138 |
| `usdc_mint` | `Account<Mint>` from `anchor_spl::token` (classic SPL Token owner) |
| `program_data` | `Account<ProgramData>`; address per check 1 |
| `system_program` | `Program<System>` |

Checks:

1. `program_data` key equals the ProgramData address derived from the escrow program ID under
   the upgradeable loader (`find_program_address` over the program ID's 32 bytes, loader
   `BPFLoaderUpgradeab1e11111111111111111111111`) — `InvalidProgramData`.
2. `program_data.upgrade_authority_address` is not `None` — `ProgramNotUpgradeable`.
3. It equals `authority` — `UnauthorizedInitializer`.
4. None of the three keys is the all-zero key — `InvalidAuthorityKey`.
5. The three keys are pairwise distinct — `AuthoritiesNotDistinct`.

A caller-supplied claimed-authority account never suffices (D83). Anchor's documented pattern
trusts the address a program account records; this document requires the derivation D83 names.

A second `initialize` fails in the system program because the PDA exists ("already in use").

Effects: writes every section 3 field. No money moves. No event.

### 7.2 `create_and_fund`

Arguments, in order: `bounty_id: [u8; 16]`, `reward_amount: u64`, `policy_hash: [u8; 32]`,
`eligibility_profile_hash: [u8; 32]`, `required_assurance: u8`, `acceptance_window_secs: i64`,
`completion_window_secs: i64`, `review_window_secs: i64`.

There is no attester, arbiter, fee, mint or absolute-deadline argument (D67, D74, D81, D82, D83).

Accounts:

| Account | Type and constraints |
|---|---|
| `requester` | `Signer`, mutable (rent payer) |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | `init`, seeds section 4, canonical bump, space 257 |
| `usdc_mint` | `Account<Mint>`, address equals `config.usdc_mint` — `MintMismatch` |
| `bounty_vault` | `init`, associated token account, mint `usdc_mint`, authority `bounty` |
| `requester_ata` | mutable; mint equals `config.usdc_mint` — `MintMismatch`; owner equals |
| | `requester` — `TokenAccountOwnerMismatch` |
| `token_program` | `Program<Token>` |
| `associated_token_program` | `Program<AssociatedToken>` |
| `system_program` | `Program<System>` |

Handler checks:

1. `reward_amount` greater than 0 — `InvalidRewardAmount`.
2. `required_assurance` at most `MAX_ASSURANCE_LEVEL` (4) — `AssuranceTooHigh`.
3. `acceptance_window_secs` in 1 to 2592000 — `InvalidAcceptanceWindow`.
4. `completion_window_secs` in 1 to 2592000 — `InvalidCompletionWindow`.
5. `review_window_secs` in 1 to 86400 — `InvalidReviewWindow`.
6. `now` plus `acceptance_window_secs` does not overflow `i64` — `TimestampOverflow`.

Effects, in order:

1. Write the bounty: arguments as given; `requester` from the signer; `platform_fee` 0;
   `acceptance_cutoff` from check 6; `state` `Funded`; every `Option` `None`; `bump`.
2. `transfer_checked` of exactly `reward_amount` from `requester_ata` to `bounty_vault`, with
   the mint's decimals (D67). No other amount is computed.

The program stores `eligibility_profile_hash` without validating its content (D84). Policy
agreement is enforced off-chain at funding projection, voucher issuance and attestation (D77,
D84). A direct caller may fund inconsistent values; such a bounty cannot obtain a voucher or an
attestation and harms only its own funder.

### 7.3 `cancel`

No arguments.

Accounts:

| Account | Type and constraints |
|---|---|
| `requester` | `Signer`, mutable (receives rent) |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `UnauthorizedRequester`; `state == Funded` — `BountyNotCancellable`; `close = requester` |
| `usdc_mint` | `Account<Mint>`, address equals `config.usdc_mint` — `MintMismatch` |
| `bounty_vault` | mutable, associated token account, mint `usdc_mint`, authority `bounty` |
| `requester_ata` | mutable; mint equals `config.usdc_mint` — `MintMismatch`; owner equals |
| | `requester` — `TokenAccountOwnerMismatch` |
| `token_program` | `Program<Token>` |

Handler checks:

1. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`. Unreachable
   by construction, since only the bounty PDA can move vault tokens; checked to fail closed.

Effects, in D76's order:

1. `transfer_checked` of the vault's entire balance to `requester_ata`, signed by the bounty PDA.
2. Emit `BountyCancelled` (section 8).
3. Close `bounty_vault`, lamports to `requester`.
4. Close `bounty`, lamports to `requester`, by the `close` constraint after the handler.

Why the entire balance. Anyone can transfer tokens into the vault. Refunding only
`reward_amount` would leave a balance, closing the vault would then fail, and a one-unit
donation could block every refund. Donated tokens return to the requester. D67's "the vault
holds the reward and nothing else" governs what `create_and_fund` deposits; it cannot prevent
unsolicited deposits.

### 7.4 `accept`

Arguments: `expires_at: i64`, `verification_instruction_index: u16`.

Accounts:

| Account | Type and constraints |
|---|---|
| `scout` | `Signer` |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `state == Funded` — |
| | `BountyNotAcceptable` |
| `instructions_sysvar` | address is the Instructions sysvar ID — `InvalidInstructionsSysvar` |

No token accounts: `accept` moves no USDC (D49).

Handler checks. Trusted state first, then the signature, then the signed caller value — an error
about a caller-supplied value is reported only once that value is authenticated (D85's rule,
applied uniformly):

1. Top-level invocation — `InvocationNotTopLevel`.
2. `now` at or before `acceptance_cutoff` — `AcceptanceWindowClosed`.
3. `scout` differs from `bounty.requester` — `ScoutIsRequester`.
4. Build the 212-byte `BOUNTYCAM_ELIGIBILITY_V1` message: constants; `config.deployment_id`;
   bounty state; `scout` from the signer; `expires_at` from the argument (MESSAGES.md
   sections 4 and 5).
5. Section 6 verification against `config.eligibility_authority`.
6. `now` at or before `expires_at` — `VoucherExpired`.
7. `now` plus `completion_window_secs` does not overflow — `TimestampOverflow`.

Effects: `scout` set; `deadline` set from check 7; `state` `Accepted`. No money moves. No event.

The Scout's own signature makes a copied voucher useless to another wallet: the signer's key is
spliced into the reconstruction, so any other signer produces `VerificationMessageMismatch`
(D68). If two valid vouchers exist for one bounty, only the first confirmed `accept` succeeds;
the second finds `Accepted` (D68).

### 7.5 `submit_attestation`

Arguments: `evidence_root: [u8; 32]`, `achieved_assurance: u8`, `issued_at: i64`,
`verification_instruction_index: u16`.

Accounts:

| Account | Type and constraints |
|---|---|
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `state == Accepted` — |
| | `BountyNotAttestable` |
| `instructions_sysvar` | address is the Instructions sysvar ID — `InvalidInstructionsSysvar` |

No Scout signature is required. Any fee payer may submit; normally the relayer does (D85).

Handler checks:

1. Top-level invocation — `InvocationNotTopLevel`.
2. `scout` and `deadline` are `Some` — `StateInvariantViolated`.
3. `now` at or before `deadline` — `SubmissionDeadlinePassed`.
4. Build the 261-byte `BOUNTYCAM_ATTESTATION_V1` message: constants; `config.deployment_id`;
   bounty state including the stored Scout, `deadline` and `review_window_secs`;
   `evidence_root`, `achieved_assurance` and `issued_at` from the arguments (MESSAGES.md
   sections 3 and 5).
5. Section 6 verification against `config.attester_authority`.
6. `achieved_assurance` at most `MAX_ASSURANCE_LEVEL` — `AchievedAssuranceOutOfRange`.
7. `achieved_assurance` at least `required_assurance` — `InsufficientAssurance`. No state change,
   no field written, no event (D85).

Effects: `evidence_root` and `achieved_assurance` from the arguments; `submitted_at` `now`;
`state` `Submitted`. No money moves. No event.

`issued_at` is compared with nothing (D82). An attestation issued early remains submittable until
`deadline` unless the state changes or the configured attester changes (MESSAGES.md section 6).

---

## 8. Events

One event:

```
BountyCancelled {
    bounty: Pubkey,          // account address; unique, unlike bounty_id
    bounty_id: [u8; 16],
    requester: Pubkey,
    usdc_mint: Pubkey,       // config.usdc_mint
    reward_amount: u64,
    refunded_amount: u64,    // entire vault balance transferred; at least reward_amount
    cancelled_at: i64,       // now
}
```

It exists because `cancel` closes the account, leaving no state to read (D76). Surviving accounts
are the reconciliation source for every other instruction (SECURITY.md section 12), so no other
event is emitted. Events live in transaction logs and are not an archival guarantee; the database
is the durable record (D76).

---

## 9. Constants

| Name | Value | Source |
|---|---|---|
| `BOUNTY_SEED` | `b"bounty"` | section 4 |
| `CONFIG_SEED` | `b"config"` | section 3 |
| `MAX_ASSURANCE_LEVEL` | 4 | D13, MESSAGES.md vectors |
| `MAX_ACCEPTANCE_WINDOW_SECS` | 2592000 | D81 |
| `MAX_COMPLETION_WINDOW_SECS` | 2592000 | D81 |
| `MAX_REVIEW_WINDOW_SECS` | 86400 | D81 |
| domain tags, `schema_version`, message lengths | as published | MESSAGES.md and vectors |
| ed25519 offsets 16, 48, 112 | section 6.1 | `solana-ed25519-program` 3.0.0 |

`PLATFORM_FEE_BPS` is deleted with its arithmetic (D67).

`MESSAGES.md` gives `schema_version` as a `u16` constant but states its value only through the
vectors. The program's value equals the vectors'.

---

## 10. Errors

Append-only (D75). On-chain code is 6000 plus the index. Existing variants are never reordered,
inserted around or removed. A retired variant keeps its code and is never emitted.

| n | Name | Meaning |
|---|---|---|
| 0 | `InvalidRewardAmount` | `reward_amount` is zero |
| 1 | `DeadlineInPast` | retired by D81; never emitted |
| 2 | `AssuranceTooHigh` | `required_assurance` above the maximum |
| 3 | `MintMismatch` | mint, or a token account's mint, is not the configured mint |
| 4 | `UnauthorizedRequester` | signer is not the bounty's requester |
| 5 | `BountyNotCancellable` | `cancel` outside `Funded` |
| 6 | `AmountOverflow` | retired by D67; reserved, never emitted |
| 7 | `TokenAccountOwnerMismatch` | token account not owned by the expected wallet (D75) |
| 8 | `InvalidAcceptanceWindow` | outside 1 to 2592000 |
| 9 | `InvalidCompletionWindow` | outside 1 to 2592000 |
| 10 | `InvalidReviewWindow` | outside 1 to 86400 |
| 11 | `TimestampOverflow` | clock plus window overflows `i64` |
| 12 | `InvalidProgramData` | ProgramData account not at the derived address |
| 13 | `ProgramNotUpgradeable` | ProgramData records no upgrade authority |
| 14 | `UnauthorizedInitializer` | signer is not the recorded upgrade authority |
| 15 | `AuthoritiesNotDistinct` | two configured authorities are equal |
| 16 | `InvalidAuthorityKey` | a configured authority is the all-zero key |
| 17 | `BountyNotAcceptable` | `accept` outside `Funded` |
| 18 | `AcceptanceWindowClosed` | `accept` after `acceptance_cutoff` |
| 19 | `ScoutIsRequester` | Scout equals requester |
| 20 | `VoucherExpired` | `accept` after the voucher's `expires_at` |
| 21 | `BountyNotAttestable` | `submit_attestation` outside `Accepted` |
| 22 | `SubmissionDeadlinePassed` | attestation after `deadline` |
| 23 | `AchievedAssuranceOutOfRange` | attested level above the maximum |
| 24 | `InsufficientAssurance` | attested level below required (D85) |
| 25 | `InvocationNotTopLevel` | called through CPI (D71) |
| 26 | `InvalidInstructionsSysvar` | sysvar account is not the Instructions sysvar |
| 27 | `VerificationIndexInvalid` | index not before the current instruction |
| 28 | `NotEd25519Instruction` | designated instruction is not native ed25519 |
| 29 | `MalformedVerificationInstruction` | not the section 6.1 canonical shape |
| 30 | `VerificationAuthorityMismatch` | verified key is not the configured authority |
| 31 | `VerificationMessageMismatch` | verified message differs from the reconstruction |
| 32 | `VaultBalanceBelowReward` | vault holds less than `reward_amount` |
| 33 | `StateInvariantViolated` | a section 4.1 `Option` invariant is broken |

`MintMismatch`'s message text changes from "the bounty USDC mint" to "the configured USDC mint",
because the bounty no longer stores a mint. Its code does not change.

Errors named by tests but raised outside this program, from Anchor 1.1.2 (`anchor-lang-error`)
unless stated: `AccountNotInitialized`, `AccountNotSigner`, `AccountOwnedByWrongProgram`,
`ConstraintAssociated`, `ConstraintDuplicateMutableAccount` (D87), `ConstraintSeeds`,
`InvalidProgramId`; `InvalidAccountData` from the SPL Token mint unpack; and the system
program's "already in use".

---

## 11. Invariants

Each SECURITY.md section 8 invariant, its mechanism here, and its tests (section 12).

| Invariant | Mechanism | Tests |
|---|---|---|
| Authority validation | section 2; `has_one`; section 6; ProgramData | 2, 3, 4, 30, 47, 48, 50, |
| | | 64, 91 |
| Account ownership and type | typed Anchor accounts | 10, 11, 25, 41 |
| PDA validation | seeds with the stored canonical bump | 25, 94 |
| Exact USDC mint | address equals `config.usdc_mint` | 10, 20, 21, 35, 36 |
| Escrow token account | associated-token constraint on the bounty PDA | 12, 29, 37 |
| Scout payout account | Session 9 | Session 9 |
| Checked transfers | `transfer_checked` only | 12, 29; review item |
| Arbitrary CPI | `Program<Token>`, `Program<AssociatedToken>`, `Program<System>` | 26 |
| State before transfer | every check precedes the token CPI | review item |
| Recursion | no dependence; explicit state checks | review item |
| Double release | Session 9 | Session 9 |
| Amount integrity | stored `reward_amount`; checked `i64` additions | 12, 18, 27 |
| Fee | `platform_fee` 0; no fee argument | 12, 23 |
| Account closure | `cancel` closes both; close-then-reinit | 29, 33, 40 |
| Duplicate accounts | Anchor duplicate-mutable check (D87); owner constraints; | 39, 48 |
| | `ScoutIsRequester` | |
| Remaining accounts | never read | review item |

D71's invariant is section 6, tested by 55, 69 and 70 to 90.

SECURITY-PRODUCTION.md section 8 classes in scope for these instructions:

- wrong, missing or substituted signer — 2, 30, 47, 91
- wrong bounty, Scout or requester — 47, 63, 68
- wrong PDA or non-canonical derivation — 25, 94
- wrong mint, fake USDC, wrong token program — 10, 20, 21, 26, 35, 36
- attacker escrow account; duplicate account aliasing — 37, 39
- modified attestation — 65
- attestation for another bounty, Scout or evidence root — 63, 65, 68
- insufficient assurance — 59
- expired or replayed attestation — 58, 66
- wrong state — 31, 32, 49, 66, 67
- arithmetic boundaries — 18, 27
- unexpected CPI — 55, 69
- close-then-reinit — 40

Amount modification has no surface here: the only amount argument is at funding, and every later
movement uses stored state. Payout, double-payout, double-refund and refund-after-payout classes
are Session 9's.

---

## 12. Tests

Gate: **94 tests**, counted from the raw summary (D36). A test iterating cases asserts its case
count first, so an empty case list fails.

Harness rules:

- litesvm loads the program with no recorded upgrade authority (litesvm 0.10.0 `src/lib.rs`
  lines 857 and 931). Positive `initialize` tests overwrite ProgramData first, stated in the test
  as harness setup (D83). Confirm the locked litesvm version with `cargo tree` before relying on
  this.
- Keys are generated per run, except where a test reproduces published `MESSAGES.md` vectors
  with their fixed test seeds (SECURITY.md section 7).
- The clock is set through the Clock sysvar.
- Tests 55 and 69 need a test-only program that CPIs into the escrow. It lives in the test
  workspace and is never deployed. The off-chain stack-height stub returns 0, so no plain Rust
  unit test can exercise the check.
- A state is reached through the real instructions, never by rewriting the bounty account. Only
  exploit tests plant foreign accounts (25, 41, 94), and each says so.
- Each negative test introduces exactly one fault.

### 12.1 `initialize`

1. Positive: stores exactly the supplied values and the canonical bump.
2. Signer other than the recorded upgrade authority — `UnauthorizedInitializer`.
3. A real ProgramData account of another program — `InvalidProgramData`.
4. Recorded authority `None`, the harness default — `ProgramNotUpgradeable`.
5. Second `initialize` — system "already in use".
6. Eligibility equals attester — `AuthoritiesNotDistinct`.
7. Eligibility equals arbiter — `AuthoritiesNotDistinct`.
8. Attester equals arbiter — `AuthoritiesNotDistinct`.
9. Each authority all-zero in turn, three cases — `InvalidAuthorityKey`.
10. A Token-2022 mint — `AccountOwnedByWrongProgram`.
11. A classic token account passed as the mint — `InvalidAccountData`.

### 12.2 `create_and_fund`

12. Existing `create_and_fund_succeeds`, modified: every field per section 4.1; vault balance
    equals `reward_amount`; `platform_fee` 0; requester balance down by exactly
    `reward_amount`; `acceptance_cutoff` equals clock plus window; every `Option` `None`; state
    `Funded`.
13. Existing `create_with_zero_reward_fails` — `InvalidRewardAmount`.
14. Existing `create_with_assurance_above_max_fails` — 5 gives `AssuranceTooHigh`; 4 succeeds.
15. Acceptance window at 0, minus 1 and 2592001 — `InvalidAcceptanceWindow`; 1 and 2592000
    succeed.
16. Completion window, the same cases — `InvalidCompletionWindow`.
17. Review window at 0, minus 1 and 86401 — `InvalidReviewWindow`; 1 and 86400 succeed.
18. `reward_amount` of `u64::MAX` with a matching balance succeeds; the vault holds `u64::MAX`.
19. Existing `create_twice_with_same_bounty_id_fails` — system "already in use".
20. A second real mint, with the requester's token account for it — `MintMismatch`.
21. Existing `create_with_wrong_mint_fails`: correct mint, token account of another mint —
    `MintMismatch`.
22. Correct mint, token account owned by another wallet — `TokenAccountOwnerMismatch`.
23. The generated IDL lists exactly the eight section 7.2 arguments, in order: no attester,
    arbiter, fee, mint or deadline input (D67, D74, D82).
24. `eligibility_profile_hash` stored byte for byte, including all-zero and all-ones (D84).
25. Configuration substitutes, two cases, planted: a same-layout account owned by another
    program — `AccountOwnedByWrongProgram`; a program-owned one at a non-PDA address —
    `ConstraintSeeds`.
26. The Token-2022 program ID as `token_program` — `InvalidProgramId`.
27. Clock set so clock plus acceptance window exceeds `i64::MAX` — `TimestampOverflow`.
28. Every section 10 variant has its listed code (D75).

### 12.3 `cancel`

29. Existing `cancel_succeeds`, modified: balance restored; vault and bounty closed; rent to the
    requester; `BountyCancelled` fields exact.
30. Existing `cancel_by_non_requester_fails` — `UnauthorizedRequester`.
31. Existing `cancel_when_accepted_fails`, rewritten to reach `Accepted` through a real
    `accept` — `BountyNotCancellable`.
32. After a real `submit_attestation` — `BountyNotCancellable`.
33. Existing `cancel_twice_fails` — `AccountNotInitialized`.
34. Token account owned by another wallet — `TokenAccountOwnerMismatch`.
35. Token account of another mint — `MintMismatch`.
36. Mint account other than the configured mint — `MintMismatch`.
37. The bounty's associated token account for another mint as the vault — `ConstraintAssociated`.
38. Tokens donated to the vault: cancel succeeds; `refunded_amount` equals reward plus donation.
39. `requester_ata` set to the vault address — `ConstraintDuplicateMutableAccount`, caused by
    `requester_ata` (D87).
40. Close-then-reinit: `cancel` and `create_and_fund` with the same id in one transaction produce
    a fresh `Funded` bounty; vault equals `reward_amount`; every `Option` `None`.
41. A same-layout bounty owned by another program, planted — `AccountOwnedByWrongProgram`.

### 12.4 `accept`

42. Positive: `scout` stored; `deadline` equals clock plus completion window; state `Accepted`;
    no token balance changes anywhere.
43. At exactly `acceptance_cutoff` succeeds (D81).
44. One second after — `AcceptanceWindowClosed`.
45. At exactly `expires_at` succeeds.
46. One second after `expires_at` — `VoucherExpired`.
47. Signer other than the voucher's Scout — `VerificationMessageMismatch`.
48. A valid voucher naming the requester, signed by the requester — `ScoutIsRequester`.
49. A second Scout with its own valid voucher after the first `accept` — `BountyNotAcceptable`.
50. Voucher signed by the attester, the arbiter and a fresh key, three cases —
    `VerificationAuthorityMismatch`.
51. One mutation per signed voucher field, eleven cases — `VerificationMessageMismatch`.
52. Replay after `cancel` and identical re-creation succeeds, documenting D86's limit.
53. The same replay with `policy_hash`, `eligibility_profile_hash` or `required_assurance`
    changed at re-creation, three cases — `VerificationMessageMismatch` (D86).
54. Replay after voucher expiry — `VoucherExpired` (D86).
55. Through CPI — `InvocationNotTopLevel`.

### 12.5 `submit_attestation`

56. Positive, submitted by an arbitrary fee payer with no Scout signature: fields written,
    `submitted_at` equals clock, state `Submitted` (D85).
57. At exactly `deadline` succeeds (D81).
58. One second after — `SubmissionDeadlinePassed`.
59. Achieved below required — `InsufficientAssurance`; the bounty account is byte-identical.
60. Achieved equal to required succeeds.
61. Achieved above required succeeds.
62. Achieved 5, validly signed — `AchievedAssuranceOutOfRange`.
63. Attestation naming another Scout — `VerificationMessageMismatch`.
64. Signed by the eligibility key, the arbiter and a fresh key, three cases —
    `VerificationAuthorityMismatch`.
65. The fifteen published attestation mutation vectors, each — `VerificationMessageMismatch`.
66. Second submission of the same attestation — `BountyNotAttestable`.
67. Before `accept` — `BountyNotAttestable`.
68. A valid attestation for another bounty — `VerificationMessageMismatch`.
69. Through CPI — `InvocationNotTopLevel`.

### 12.6 Designated verification, through `submit_attestation` unless stated

70. A fake account as the Instructions sysvar — `InvalidInstructionsSysvar`.
71. Index equal to the current instruction — `VerificationIndexInvalid`.
72. Index after the current instruction — `VerificationIndexInvalid`.
73. Index beyond the instruction count — `VerificationIndexInvalid`.
74. Index at a compute-budget instruction — `NotEd25519Instruction`.
75. Two-byte zero-signature instruction, which the native verifier accepts —
    `MalformedVerificationInstruction`.
76. A valid two-signature instruction — `MalformedVerificationInstruction`.
77. Padding byte non-zero, which the native verifier ignores — `MalformedVerificationInstruction`.
78. Each of the three instruction-index fields pointed at another instruction holding valid
    bytes, three cases — `MalformedVerificationInstruction`.
79. Key, signature and message offsets moved to a valid alternative layout, three cases —
    `MalformedVerificationInstruction`.
80. Message size field not the expected length — `MalformedVerificationInstruction`.
81. Trailing bytes after the message, which the native verifier accepts —
    `MalformedVerificationInstruction`.
82. Truncated offsets: the transaction fails, in the native verifier or with
    `MalformedVerificationInstruction`; the test asserts failure and names which occurred.
83. Designated instruction carrying one account — `MalformedVerificationInstruction`.
84. A valid signature over a different message of the right length —
    `VerificationMessageMismatch`.
85. A voucher on the attestation path, and an attestation on the `accept` path, two cases —
    `MalformedVerificationInstruction` by length.
86. Two identical valid ed25519 instructions, the first designated, succeeds.
87. The same, the second designated, succeeds.
88. A valid matching ed25519 instruction elsewhere while the designated one does not match —
    `VerificationMessageMismatch`.
89. Compute-budget instructions between the verification and the program instruction succeed.
90. Unit test: the program's message builders reproduce all 17 published message vectors byte
    for byte (D78's vectors, consumed by the program).

### 12.7 Cross-cutting and layout

91. Missing signer, three cases: `create_and_fund` requester, `cancel` requester, `accept`
    Scout — `AccountNotSigner`.
92. Serialised bounty and configuration layouts match sections 3 and 4.1: fixed offsets, `None`
    as one byte, maximum sizes 257 and 138.
93. `BountyState` discriminants: `Funded` 0, `Accepted` 1, `Submitted` 2.
94. A program-owned bounty at a non-canonical PDA address, planted — `ConstraintSeeds`.

Session 9 owns the double-release, payout-destination and refund-after-payout tests.

---

## 13. Implementation tasks

Each is a difference between current source and this document (D80).

1. Delete `PLATFORM_FEE_BPS` and the fee arithmetic; transfer `reward_amount`; store
   `platform_fee` 0 (D67). The test helper `fee()` goes with it.
2. Remove the `attester_authority` argument and field (D82).
3. Remove the `arbiter_authority` account and field (D74).
4. Replace the `deadline` argument with the three windows; add `acceptance_cutoff` and optional
   `deadline` (D81).
5. Add the `eligibility_profile_hash` argument and field (D84).
6. Remove `Cancelled`, `InReview`, `Approved`, `Rejected`, `Disputed`, `Paid`, `Refunded` and
   `Expired` from the enum (section 5.1, D76).
7. Remove the bounty's `usdc_mint`; rename `merkle_root` to `evidence_root`; reorder fields per
   section 4.1.
8. Append errors 7 to 33; change `MintMismatch`'s message text; move `cancel.rs` line 30 and
   `create_and_fund.rs` line 33 to `TokenAccountOwnerMismatch` (D75).
9. Add the configuration account and `initialize` (D83).
10. Constrain the mint account to `config.usdc_mint` in `create_and_fund` and `cancel`; today
    `create_and_fund` accepts any mint (D83).
11. `cancel`: add the balance check and emit `BountyCancelled` in D76's order (D76).
12. Implement section 6's routine and the two message builders.
13. Implement `accept` and `submit_attestation`.
14. Rewrite `cancel_when_accepted_fails` to use a real `accept`.
15. Replace `create_with_past_deadline_fails` with tests 15 to 17; `DeadlineInPast` is retired.
16. Add the test-only CPI caller program (section 12).
17. Exact-pin the escrow test dev-dependencies after confirming locked versions with
    `cargo tree` (SECURITY.md section 10; BACKLOG).
18. Review items with no single test: every check precedes the token CPI; no instruction reads
    remaining accounts; no dependence on recursion behaviour.

Operational, before any devnet deployment of this layout (BACKLOG):

- Generate the eligibility and arbiter development keys (D83).
- Rehearse `initialize` on localnet with the exact devnet public keys (D83).
- List program-owned devnet accounts and cancel any holding test USDC while the Session 4
  program can still read them. The layout change makes them unreadable.

---

## 14. Transaction budget

Counted by the appendix A script. Legacy messages; no lookup tables (SECURITY.md section 3);
relayer as fee payer; two compute-budget instructions.

| | `submit_attestation` | `accept` |
|---|---|---|
| Account keys | 7 | 8 |
| Signatures | 1 | 2 |
| Bytes | 780 of 1232 | 795 of 1232 |
| Headroom | 452 | 437 |
| Key ceiling | 20 | 21 |

Both lists are well under `MESSAGES.md` section 7's ceiling of roughly eighteen accounts, which
was stated against its 881-byte upper bound.

Correction noted, not edited into `MESSAGES.md`: its 60-byte `submit_attestation` row reproduces
only without the two-byte index field (62 with it). Its total is declared an upper bound and
already counts a second signature, 64 bytes of slack against a two-byte error.

---

## 15. Stated limits

- **Voucher replay across cancellation** — D86, with revisit triggers in BACKLOG.
- **Early attestation** — valid until `deadline` unless state or the configured attester changes
  (D82).
- **Malformed direct funding** — a policy-chain mismatch cannot attest and locks only its
  funder's USDC, recoverable through Session 9's `expire` (D77).
- **Eligibility availability** — if the eligibility service is down, new accepts stop (D68).
- **Immutable configuration** — replacing a leaked configured key needs an upgrade with a
  migration (D83).
- **Donations** — tokens sent to a vault return to the requester on `cancel`.
- **No exits yet** — `Accepted` and `Submitted` lock the reward until Session 9 (section 5.3).

Not this document's: `CAPTURE_START_DEADLINE_BUFFER_SECS` (operational, MESSAGES.md section 10);
OPEN-1 profiles below A4 (BACKLOG); the policy binding register (POLICY.md, D84).

---

## 16. D80 reconciliation

| Check | Result |
|---|---|
| Every existing instruction represented | `create_and_fund` 7.2, `cancel` 7.3 |
| Every account field has a purpose | section 4.1 and section 3 purpose columns |
| Every stored field required or removed | removals in section 4.2 |
| Every enum state reachable with exits | section 5.1 and 5.3 |
| Every authority defined and enforced | section 2 |
| Every money path has preconditions and destination | section 5.2; sections 7.2 and 7.3 |
| D67 to D86 reflected | D67 7.2; D68 7.4; D69 via D84; D70 and D71 6; D72 1.3; |
| | D73 off-chain, no program surface; D74 3; D75 10; D76 5.1, 7.3, 8; |
| | D77 7.2, 15; D78 test 90; D79 5.4; D80 this document; D81 4.1, 7.2, 7.4; |
| | D82 2, 7.5; D83 3, 7.1; D84 7.2; D85 7.5; D86 tests 52, 53, 54 |
| Existing tests checked | nine kept or modified as tests 12, 13, 14, 19, 21, 29, 30, 31, 33; |
| | `create_with_past_deadline_fails` replaced (task 15) |
| Source differences are tasks | section 13 |

---

## Appendix A — budget script

Run with `python3`. The output reproduces section 14.

```python
#!/usr/bin/env python3
"""Legacy transaction size for accept and submit_attestation. No lookup tables."""
LIMIT = 1232

def cu16(n):  # compact-u16 length prefix size
    return 1 if n < 0x80 else 2 if n < 0x4000 else 3

def ix(n_accounts, data_len):  # program id index + account list + data
    return 1 + cu16(n_accounts) + n_accounts + cu16(data_len) + data_len

def tx(name, signers, keys, instructions):
    size = (cu16(signers) + 64 * signers + 3 + cu16(len(keys)) + 32 * len(keys)
            + 32 + cu16(len(instructions)) + sum(ix(a, d) for _, a, d in instructions))
    head = LIMIT - size
    print(f"{name}: keys {len(keys)}, signatures {signers}, total {size}, "
          f"headroom {head}, key ceiling {len(keys) + head // 33}")

ED_HEADER = 2 + 14 + 32 + 64          # count, padding, offsets, key, signature
CB = [("limit", 0, 1 + 4), ("price", 0, 1 + 8)]
DISC, INDEX = 8, 2                    # Anchor discriminator; u16 verification index

tx("submit_attestation", 1,
   ["relayer", "config", "bounty", "sysvar", "escrow", "ed25519", "compute_budget"],
   CB + [("ed25519", 0, ED_HEADER + 261), ("submit", 3, DISC + 32 + 1 + 8 + INDEX)])
tx("accept", 2,
   ["relayer", "scout", "config", "bounty", "sysvar", "escrow", "ed25519", "compute_budget"],
   CB + [("ed25519", 0, ED_HEADER + 212), ("accept", 4, DISC + 8 + INDEX)])
```
