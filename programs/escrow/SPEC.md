# Escrow Program Specification

**Path:** `programs/escrow/SPEC.md`
**Status:** normative for the escrow program's accounts, state machine, authorities and its
eleven instructions: `initialize`, `create_and_fund`, `cancel`, `accept`, `submit_attestation`,
`approve`, `release`, `reject`, `resolve`, `expire_unaccepted` and `expire_accepted`.
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
transition into and out of the states it holds, the Scout payout and requester refund accounts,
and eleven instructions.

D1's "six instructions" is superseded. The program has eleven (D98): the five Session 8 built,
and Session 9's `approve`, `release`, `reject`, `resolve`, `expire_unaccepted` and
`expire_accepted` (D92 to D95). Session 9's plan named four; `release` and the split of expiry
into two instructions are D92's and D95's.

### 1.3 Terms

- **now** — `Clock::get()?.unix_timestamp`, read once per instruction, signed 64-bit.
- **at or before** — an instruction succeeds when `now` is less than or equal to the bound,
  and fails one second later (D81).
- **strictly later** — an instruction succeeds when `now` is greater than the bound, so it fails
  at the bound and succeeds one second later. It is the complement of *at or before* on the same
  bound, so the two never both succeed (D92, D93, D95).
- **review window end** — `submitted_at` plus `review_window_secs`, the addition checked.
- **entire balance** — the vault's token amount when the handler reads it, including any
  unsolicited deposit (section 7.3).
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
| arbiter authority | `Signer` in `resolve`, address equal to configuration | configuration |
| relayer | transaction fee payer only | none — never read |
| any fee payer | submits `release`, `expire_unaccepted`, `expire_accepted` | none — never read |

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
- `resolve` requires the arbiter to differ from the bounty's requester and its Scout (section
  7.9, D94).
- `release`, `expire_unaccepted` and `expire_accepted` take no signer beyond the fee payer. Every
  account, amount, destination and time bound they use is fixed by stored state, so the caller
  chooses nothing (D92, D95; SECURITY.md section 2). They do not reject CPI: a caller gains
  nothing by invoking through another program.

---

## 3. The configuration account

One account per deployment (D83). PDA seeded on the single literal `b"config"`, canonical bump.

| Field | Type | Purpose |
|---|---|---|
| `deployment_id` | `u8` | signed into both binary messages; cluster separation (D70) |
| `usdc_mint` | `Pubkey` | the only mint any instruction accepts (D83) |
| `eligibility_authority` | `Pubkey` | verifies acceptance vouchers (D68) |
| `attester_authority` | `Pubkey` | verifies attestations (D82) |
| `arbiter_authority` | `Pubkey` | read by `resolve` (D74, D94) |
| `bump` | `u8` | canonical PDA bump |

Space: 8 discriminator bytes plus 130, total 138. All fields are fixed width.

Written only by `initialize`, once. No instruction updates or closes it. Rotation of any value
requires a deliberately authorised upgrade carrying a migration or a new versioned account,
under its own D-entry; under SECURITY-PRODUCTION.md section 1 that mechanism is a mainnet
blocker (D83).

`arbiter_authority` has one reader, `resolve` (section 7.9).

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
| 153 | `review_window_secs` | `i64` | create | review window (D92, D93); signed |
| 161 | `acceptance_cutoff` | `i64` | create | last second `accept` succeeds |
| 169 | `state` | `BountyState` | all | section 5 |
| 170 | `bump` | `u8` | create | canonical PDA bump |
| 171 | `scout` | `Option<Pubkey>` | accept | payout identity; message field |
| var | `deadline` | `Option<i64>` | accept | last second an attestation lands |
| var | `submitted_at` | `Option<i64>` | submit | review window start (D92, D93) |
| var | `evidence_root` | `Option<[u8; 32]>` | submit | attested evidence commitment |
| var | `achieved_assurance` | `Option<u8>` | submit | attested level; legible record (D17) |
| var | `failed_requirement_id` | `Option<[u8; 16]>` | reject | named failing requirement (D93) |

Maximum space: 8 discriminator bytes plus 266, total 274, allocated at creation (D93).

`Option` invariant: while `Funded`, all six `Option` fields are `None`. `accept` sets `scout`
and `deadline`. `submit_attestation` sets `submitted_at`, `evidence_root` and
`achieved_assurance`. `reject` sets `failed_requirement_id`. Nothing clears a field once set, and
no instruction clears `scout` or `deadline` (D96).

The invariant is checked where a field is read, not everywhere: `submit_attestation` requires
`scout` and `deadline`; `release` and `reject` require `submitted_at`; `resolve` requires
`scout`; `expire_accepted` requires `deadline`. Each fails with `StateInvariantViolated`. Other
instructions read no `Option` field, or read `scout` only through an account constraint, and do
not check it.

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
    Disputed,   // 3
    Paid,       // 4
    Refunded,   // 5
}
```

SECURITY.md section 9 permits a variant only if an instruction enters it with defined exits and
tests. The enum therefore holds exactly the states these instructions enter. `Cancelled` is
removed (D76). Variants are append-only, so discriminants never change (D96).

`Paid` and `Refunded` are terminal. No instruction accepts either as a source state, and their
bounty accounts are never closed (D96).

### 5.2 Transitions

| Instruction | From | To | Signer | Money |
|---|---|---|---|---|
| `create_and_fund` | none | `Funded` | requester | requester ATA to vault: `reward_amount` |
| `cancel` | `Funded` | closed | requester | vault to requester ATA: full balance |
| `accept` | `Funded` | `Accepted` | Scout | none |
| `submit_attestation` | `Accepted` | `Submitted` | none | none |
| `approve` | `Submitted` | `Paid` | requester | vault to Scout payout account: full balance |
| `release` | `Submitted` | `Paid` | none | vault to Scout payout account: full balance |
| `reject` | `Submitted` | `Disputed` | requester | none |
| `resolve` | `Disputed` | `Paid` or `Refunded` | arbiter | vault to the named party: full balance |
| `expire_unaccepted` | `Funded` | closed | none | vault to requester ATA: full balance |
| `expire_accepted` | `Accepted` | `Refunded` | none | vault to requester ATA: full balance |

A signer of `none` means no signer beyond the fee payer. Every instruction that moves the vault's
balance also closes the vault, lamports to the requester. Only `cancel` and `expire_unaccepted`
close the bounty account.

Failed instructions change nothing; Solana transactions are atomic.

### 5.3 Exits

- `Funded`: `accept` at or before `acceptance_cutoff`; `cancel` at any time; `expire_unaccepted`
  strictly later than `acceptance_cutoff`.
- `Accepted`: `submit_attestation` at or before `deadline`; `expire_accepted` strictly later than
  `deadline`. `cancel` is rejected (D49). An attested shortfall leaves the bounty `Accepted`
  until `deadline` passes (D85, D95).
- `Submitted`: `approve` at any time; `reject` at or before the review window end; `release`
  strictly later than the review window end (D92, D93).
- `Disputed`: `resolve` only (D74, D94). The arbiter has no deadline (section 15).
- `Paid`, `Refunded`: none (D96).

### 5.4 Database projection (informative)

Normative mapping: D97 and `apps/api/POLICY.md` section 7.2. From confirmed transactions
only: `create_and_fund` to `AVAILABLE` when every binding agrees (D79, D84); `accept` to
`ACCEPTED`; `submit_attestation` to `SUBMITTED`; `reject` to `DISPUTED`; `approve`, `release`,
and `resolve` paying the Scout to `PAID`; `expire_accepted`, and `resolve` refunding the
requester, to `REFUNDED`; `expire_unaccepted` to `EXPIRED`; `cancel` of a funded bounty to
`CANCELLED` (D76).

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

The account tables name types as `Account<...>`. An account may be held as `Box<Account<...>>`
where the generated validation would otherwise exceed SBF's 4096-byte stack frame, which
`approve` does (D100). Boxing moves the decoded data to the heap and changes no constraint,
error, ordering or on-chain result.

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
| `bounty` | `init`, seeds section 4, canonical bump, space 274 |
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

### 7.6 `approve`

No arguments.

Accounts:

| Account | Type and constraints |
|---|---|
| `requester` | `Signer`, mutable (receives the vault's rent) |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `UnauthorizedRequester`; `state == Submitted` — `BountyNotApprovable` |
| `usdc_mint` | `Account<Mint>`, address equals `config.usdc_mint` — `MintMismatch` |
| `bounty_vault` | mutable, associated token account, mint `usdc_mint`, authority `bounty` |
| `scout` | `UncheckedAccount`; `bounty.scout` equals `Some(scout)` — `ScoutMismatch` |
| `scout_payout` | mutable, associated token account, mint `usdc_mint`, authority `scout`; mint |
| | equals `config.usdc_mint` — `MintMismatch` |
| `token_program` | `Program<Token>` |

`scout_payout` is the Scout payout account (D92). Anchor 1.1.2's associated-token constraint
checks the owner and then the derived address (`anchor-syn`,
`generate_constraint_associated_token`): an account owned by another wallet reports
`ConstraintTokenOwner`, and a Scout-owned account at another address reports
`ConstraintAssociated`. Only the Associated Token program can create an account at the derived
address, and it initialises that account with the derivation's mint, so the mint constraint
cannot fail on a real chain; it is checked to fail closed.

The program never creates `scout_payout` (D92). If it does not exist, Anchor's account load fails
with `AccountNotInitialized` before any constraint runs.

Handler checks:

1. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`, as section 7.3.

Effects, in order:

1. `state` `Paid`.
2. `transfer_checked` of the vault's entire balance to `scout_payout`, signed by the bounty PDA.
3. Close `bounty_vault`, lamports to `requester`. The bounty account stays open (D96). No event.

The state is written before the token CPI, as SECURITY.md section 8 requires (D99). Anchor
serialises the bounty at exit either way, so this changes no observable result; what it fixes is
what the handler has established before it calls another program.

### 7.7 `release`

No arguments. No signer beyond the fee payer (D92).

Accounts: as section 7.6, with two rows changed.

| Account | Type and constraints |
|---|---|
| `requester` | `UncheckedAccount`, mutable (receives the vault's rent) |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `RequesterAccountMismatch`; `state == Submitted` — `BountyNotReleasable` |

Handler checks:

1. `submitted_at` is `Some` — `StateInvariantViolated`.
2. The review window end does not overflow `i64` — `TimestampOverflow`.
3. `now` strictly later than the review window end — `ReviewWindowOpen`.
4. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`.

Checks 1 and 2 cannot fail through the instructions: `submit_attestation` writes `submitted_at`
as it enters `Submitted`, and `submitted_at` is at most `deadline`, far below the `i64` limit.
They are review items (section 13), as `submit_attestation` check 2 is.

Effects: as section 7.6.

### 7.8 `reject`

Arguments: `failed_requirement_id: [u8; 16]`.

Accounts:

| Account | Type and constraints |
|---|---|
| `requester` | `Signer` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `UnauthorizedRequester`; `state == Submitted` — `BountyNotRejectable` |

No configuration, mint or token accounts: `reject` moves no USDC (D93).

Handler checks. Trusted state first, then the argument (D85's rule):

1. `submitted_at` is `Some` — `StateInvariantViolated`.
2. The review window end does not overflow `i64` — `TimestampOverflow`.
3. `now` at or before the review window end — `ReviewWindowClosed`.
4. `failed_requirement_id` is not all zero — `InvalidRequirementId`.

Checks 1 and 2 are review items, for section 7.7's reason.

Effects: `failed_requirement_id` set to the argument; `state` `Disputed`. No money moves. No
event.

The program does not check that the id names a requirement in the committed policy. The API
checks it before building the transaction and the arbiter checks it before resolving (D93).

### 7.9 `resolve`

Arguments: `outcome: ResolveOutcome`.

```
enum ResolveOutcome {
    PayScout,         // 0
    RefundRequester,  // 1
}
```

Serialised as one byte. Any other value fails argument decoding with
`InstructionDidNotDeserialize` before any account is loaded (`anchor-syn` 1.1.2, program
handlers). The two variants are D94's; another needs its own D-entry.

Accounts:

| Account | Type and constraints |
|---|---|
| `arbiter` | `Signer`; address equals `config.arbiter_authority` — `UnauthorizedArbiter` |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `requester` | `UncheckedAccount`, mutable (receives the vault's rent) |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `RequesterAccountMismatch`; `state == Disputed` — `BountyNotResolvable` |
| `usdc_mint` | `Account<Mint>`, address equals `config.usdc_mint` — `MintMismatch` |
| `bounty_vault` | mutable, associated token account, mint `usdc_mint`, authority `bounty` |
| `destination` | `Account<TokenAccount>`, mutable; handler checks 3 to 5 |
| `token_program` | `Program<Token>` |

The destination is checked in the handler because the wallet it must belong to depends on the
argument. Carrying only the paid party's account means a missing account on the other side
cannot block resolution.

Handler checks:

1. `scout` is `Some` — `StateInvariantViolated`.
2. `arbiter` differs from `bounty.requester` and from the stored Scout — `ArbiterIsParty`.
3. The named wallet is the stored Scout for `PayScout` and `bounty.requester` for
   `RefundRequester`. `destination.owner` equals it — `TokenAccountOwnerMismatch`.
4. `destination` equals the associated token account of the named wallet for
   `config.usdc_mint` under the classic SPL Token program — `DestinationAccountMismatch`.
5. `destination.mint` equals `config.usdc_mint` — `MintMismatch`. It cannot fail once check 4
   holds; checked to fail closed.
6. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`.

Checks 3 and 4 keep the associated-token constraint's order, owner and then address, so a
substituted destination reports the same kind of failure here as in sections 7.6 and 7.10.
Check 1 is a review item: `accept` writes `scout` and every path to `Disputed` passes through it.

Effects, in order:

1. `state` `Paid` for `PayScout`, `Refunded` for `RefundRequester` (D99).
2. `transfer_checked` of the vault's entire balance to `destination`, signed by the bounty PDA.
3. Close `bounty_vault`, lamports to `requester`. The bounty account stays open (D96). No
   event.

### 7.10 `expire_unaccepted`

No arguments. No signer beyond the fee payer (D95).

Accounts:

| Account | Type and constraints |
|---|---|
| `requester` | `UncheckedAccount`, mutable (receives both accounts' rent) |
| `config` | seeds `[b"config"]`, `bump = config.bump` |
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `RequesterAccountMismatch`; `state == Funded` — `BountyNotExpirable`; |
| | `close = requester` |
| `usdc_mint` | `Account<Mint>`, address equals `config.usdc_mint` — `MintMismatch` |
| `bounty_vault` | mutable, associated token account, mint `usdc_mint`, authority `bounty` |
| `requester_ata` | mutable, associated token account, mint `usdc_mint`, authority `requester`; |
| | mint equals `config.usdc_mint` — `MintMismatch` |
| `token_program` | `Program<Token>` |

`requester_ata` is the requester's associated token account, not any account the requester owns:
the requester does not sign, so no caller chooses among the requester's accounts (D95). Its
constraints report as section 7.6 describes. `cancel`'s rule in section 7.3 is unchanged.

Handler checks:

1. `now` strictly later than `acceptance_cutoff` — `AcceptanceWindowOpen`.
2. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`.

Effects, in D76's order:

1. `transfer_checked` of the vault's entire balance to `requester_ata`, signed by the bounty PDA.
2. Emit `BountyExpired` (section 8).
3. Close `bounty_vault`, lamports to `requester`.
4. Close `bounty`, lamports to `requester`, by the `close` constraint after the handler.

This instruction writes no state: the bounty is closed instead, and its closure necessarily
follows the token CPI because Anchor's `close` constraint runs at exit. `cancel` has worked this
way since D76; D99 records why SECURITY.md section 8 is still satisfied.

### 7.11 `expire_accepted`

No arguments. No signer beyond the fee payer (D95).

Accounts: as section 7.10, with the bounty row changed.

| Account | Type and constraints |
|---|---|
| `bounty` | mutable; seeds section 4 with `bump = bounty.bump`; `has_one = requester` — |
| | `RequesterAccountMismatch`; `state == Accepted` — `BountyNotExpirable`; no `close` |

Handler checks:

1. `deadline` is `Some` — `StateInvariantViolated`.
2. `now` strictly later than `deadline` — `SubmissionDeadlineOpen`.
3. `bounty_vault.amount` is at least `reward_amount` — `VaultBalanceBelowReward`.

Check 1 is a review item: `accept` writes `deadline` as it enters `Accepted`.

Effects, in order:

1. `state` `Refunded` (D99).
2. `transfer_checked` of the vault's entire balance to `requester_ata`, signed by the bounty PDA.
3. Close `bounty_vault`, lamports to `requester`. The bounty account stays open (D96). No event.

This covers an abandoned mission and an attested shortfall alike (D85, D95).

---

## 8. Events

Two events, with the same fields except the timestamp's name:

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

BountyExpired {
    bounty: Pubkey,
    bounty_id: [u8; 16],
    requester: Pubkey,
    usdc_mint: Pubkey,
    reward_amount: u64,
    refunded_amount: u64,
    expired_at: i64,         // now
}
```

They exist because `cancel` and `expire_unaccepted` close the bounty account, leaving no state to
read (D76, D95). Surviving accounts are the reconciliation source for every other instruction
(SECURITY.md section 12), including the four settlements that leave a terminal account (D96), so
no other event is emitted. Events live in transaction logs and are not an archival guarantee; the
database is the durable record (D76).

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
| 34 | `BountyNotApprovable` | `approve` outside `Submitted` |
| 35 | `BountyNotReleasable` | `release` outside `Submitted` |
| 36 | `ReviewWindowOpen` | `release` at or before the review window end |
| 37 | `BountyNotRejectable` | `reject` outside `Submitted` |
| 38 | `ReviewWindowClosed` | `reject` after the review window end |
| 39 | `InvalidRequirementId` | `failed_requirement_id` is all zero |
| 40 | `BountyNotResolvable` | `resolve` outside `Disputed` |
| 41 | `UnauthorizedArbiter` | signer is not the configured arbiter |
| 42 | `ArbiterIsParty` | arbiter is the bounty's requester or Scout (D94) |
| 43 | `BountyNotExpirable` | `expire_unaccepted` outside `Funded`, or `expire_accepted` outside |
| | | `Accepted` |
| 44 | `AcceptanceWindowOpen` | `expire_unaccepted` at or before `acceptance_cutoff` |
| 45 | `SubmissionDeadlineOpen` | `expire_accepted` at or before `deadline` |
| 46 | `ScoutMismatch` | account passed as the Scout is not the stored Scout |
| 47 | `RequesterAccountMismatch` | unsigned account passed as the requester is not the bounty's |
| 48 | `DestinationAccountMismatch` | `resolve` destination is not the named wallet's associated |
| | | token account |

`MintMismatch`'s message text changes from "the bounty USDC mint" to "the configured USDC mint",
because the bounty no longer stores a mint. Its code does not change.

Errors named by tests but raised outside this program, from Anchor 1.1.2 (`anchor-lang-error`)
unless stated: `AccountNotInitialized`, `AccountNotSigner`, `AccountOwnedByWrongProgram`,
`ConstraintAssociated`, `ConstraintDuplicateMutableAccount` (D87), `ConstraintSeeds`,
`ConstraintTokenOwner`, `InstructionDidNotDeserialize`, `InvalidProgramId`; `InvalidAccountData`
from the SPL Token mint unpack; and the system program's "already in use".

---

## 11. Invariants

Each SECURITY.md section 8 invariant, its mechanism here, and its tests (section 12).

| Invariant | Mechanism | Tests |
|---|---|---|
| Authority validation | section 2; `has_one`; section 6; ProgramData; | 2, 3, 4, 30, 47, 48, 50, |
| | arbiter address | 64, 91, 98, 111, 117, 118, |
| | | 119, 137 |
| Account ownership and type | typed Anchor accounts | 10, 11, 25, 41, 102 |
| PDA validation | seeds with the stored canonical bump | 25, 94 |
| Exact USDC mint | address equals `config.usdc_mint` | 10, 20, 21, 35, 36, 138 |
| Escrow token account | associated-token constraint on the bounty PDA | 12, 29, 37 |
| Scout payout account | associated-token constraint on the stored Scout | 100, 101, 102, 107, 121 |
| | (7.6, 7.7); handler checks (7.9) | |
| Requester refund account | associated-token constraint on the stored | 121, 127, 133 |
| | requester (7.10, 7.11); handler checks (7.9) | |
| Checked transfers | `transfer_checked` only | 12, 29, 96, 114, 115, 123, |
| | | 128; review item |
| Arbitrary CPI | `Program<Token>`, `Program<AssociatedToken>`, | 26, 139 |
| | `Program<System>` | |
| State before transfer | every check and state write precedes the token CPI | review item |
| Recursion | no dependence; explicit state checks | review item |
| Double release | terminal states without exits; vault closed at | 134, 135 |
| | settlement; state constraints (D96) | |
| Amount integrity | stored `reward_amount`; entire balance; no amount | 12, 18, 27, 97, 140 |
| | argument after funding; checked `i64` additions | |
| Fee | `platform_fee` 0; no fee argument | 12, 23 |
| Account closure | `cancel` and `expire_unaccepted` close both; | 29, 33, 40, 123, 128, 136 |
| | settlements close the vault only; terminal | |
| | accounts never close; close-then-reinit | |
| Duplicate accounts | Anchor duplicate-mutable check (D87), which covers | 39, 48, 101, 118, 119 |
| | only account types that serialise at exit; owner | |
| | constraints; `has_one` and address constraints on | |
| | the others; `ScoutIsRequester`; `ArbiterIsParty` (D99) | |
| Remaining accounts | never read | review item |

D71's invariant is section 6, tested by 55, 69, 70 to 90 and 95.

SECURITY-PRODUCTION.md section 8 classes in scope for these instructions:

- wrong, missing or substituted signer — 2, 30, 47, 91, 98, 111, 117, 137
- wrong bounty, Scout or requester — 47, 63, 68, 100, 106, 122, 126, 132
- wrong PDA or non-canonical derivation — 25, 94
- wrong mint, fake USDC, wrong token program — 10, 20, 21, 26, 35, 36, 138, 139
- attacker payout, refund or escrow account; duplicate account aliasing — 37, 39, 100, 101, 107,
  121, 127, 133
- modified attestation — 65, 95
- attestation for another bounty, Scout or evidence root — 63, 65, 68
- insufficient assurance — 59, 130
- expired or replayed attestation — 58, 66
- double payout, double refund, payout after refund, refund after payout — 134, 135
- wrong state — 31, 32, 49, 66, 67, 99, 105, 112, 120, 125, 131
- arithmetic and time boundaries — 18, 27, 104, 109, 110, 124, 129
- unexpected CPI — 55, 69
- close-then-reinit — 40, 136

Amount modification has no surface: the only amount argument is at funding, and every later
movement transfers the vault's entire balance as stored state directs (test 140).

---

## 12. Tests

Gate: **140 tests**, counted from the raw summary (D36): 139 in `test_escrow` and test 90 in the
escrow unit binary, beside `test_id`. A test iterating cases asserts its case
count first, so an empty case list fails.

Harness rules:

- litesvm loads the program with no recorded upgrade authority (litesvm 0.10.0 `src/lib.rs`
  lines 857 and 931). Positive `initialize` tests overwrite ProgramData first, stated in the test
  as harness setup (D83). Confirm the locked litesvm version with `cargo tree` before relying on
  this.
- The native ed25519 verifier runs only when litesvm is built with its `precompiles` feature
  (litesvm 0.10.0 `src/callback.rs`); the dev-dependency enables it (D89). Well-formed
  designated instructions are built by `solana-ed25519-program` 3.0.0, and malformed variants
  are derived from its output, so test and program cannot share one misreading of section 6.1.
  Confirm with `cargo tree` that `agave-precompiles` resolves to 3.1.14; if it does not, re-read
  section 6.1's statements about the native verifier from the resolved source before writing
  tests 75, 77, 81 and 82.
- Keys are generated per run, except where a test reproduces published `MESSAGES.md` vectors
  with their fixed test seeds (SECURITY.md section 7).
- The clock is set through the Clock sysvar.
- Tests 55 and 69 need a test-only program that CPIs into the escrow. It lives in the test
  workspace and is never deployed. The off-chain stack-height stub returns 0, so no plain Rust
  unit test can exercise the check.
- A state is reached through the real instructions, never by rewriting the bounty account. Only
  exploit tests plant foreign accounts (25, 41, 94), and each says so.
- Each negative test introduces exactly one fault.
- Tests 96 to 140 reach `Submitted`, `Disputed`, `Paid` and `Refunded` through real `accept`,
  `submit_attestation`, `reject` and settling instructions. Test 135's re-created vault is made by
  the Associated Token program's idempotent create and a third party's token transfer, both real
  instructions, not planting.
- An arbitrary fee payer is a fresh funded key that is none of the requester, the Scout or the
  configured authorities.

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
95. Guard, on each path, two cases: a designated instruction canonical in shape, naming the
    expected authority and carrying the expected message, with one signature bit flipped. The
    transaction fails at the designated instruction's index, not the escrow instruction's, and
    the bounty account is byte-identical (D89). The check runs in the native verifier, outside
    the program, so no runtime red is possible.

### 12.7 Cross-cutting and layout

91. Missing signer, three cases: `create_and_fund` requester, `cancel` requester, `accept`
    Scout — `AccountNotSigner`.
92. Modified: serialised bounty and configuration layouts match sections 3 and 4.1: fixed
    offsets, `None` as one byte, `failed_requirement_id` last, maximum sizes 274 and 138 (D96).
93. Modified: `BountyState` discriminants `Funded` 0, `Accepted` 1, `Submitted` 2, `Disputed` 3,
    `Paid` 4, `Refunded` 5 (D96).
94. A program-owned bounty at a non-canonical PDA address, planted — `ConstraintSeeds`.

### 12.8 `approve`

96. Positive, after a real `submit_attestation`: the Scout payout account rises by the vault's
    entire balance; the vault is closed with its rent to the requester; `state` `Paid`; the
    bounty account is open with every other field unchanged.
97. Tokens donated to the vault first: the Scout receives reward plus donation (D92).
98. Signer other than the requester, two cases, the Scout and a fresh key —
    `UnauthorizedRequester`.
99. Outside `Submitted`, two cases: `Accepted` with no attestation, and `Disputed` after a real
    `reject` — `BountyNotApprovable`.
100. Payout substitutes, four cases: the requester's associated token account —
     `ConstraintTokenOwner`; an attacker's — `ConstraintTokenOwner`; the Scout's for a second real
     mint — `ConstraintAssociated`; another wallet as `scout`, with its own associated token
     account as `scout_payout` — `ScoutMismatch`.
101. `scout_payout` set to the vault address — `ConstraintDuplicateMutableAccount`, caused by
     `scout_payout` (D87's mechanism).
102. The Scout has no associated token account for the configured mint — `AccountNotInitialized`;
     the bounty account and vault balance are unchanged (D92).

### 12.9 `release`

103. Positive, one second after the review window end, submitted by an arbitrary fee payer with no
     other signer: test 96's effects.
104. At exactly the review window end — `ReviewWindowOpen`.
105. Outside `Submitted`, test 99's two cases — `BountyNotReleasable`.
106. `requester` account other than the bounty's requester — `RequesterAccountMismatch`.
107. Payout substitutes, test 100's four cases, with its errors.

### 12.10 `reject`

108. Positive: `state` `Disputed`; `failed_requirement_id` stored byte for byte; vault balance and
     every other field unchanged.
109. At exactly the review window end succeeds (D81, D93).
110. One second after — `ReviewWindowClosed`.
111. Signer other than the requester, two cases, the Scout and a fresh key —
     `UnauthorizedRequester`.
112. Outside `Submitted`, three cases: `Accepted`; `Disputed` after a first `reject`; `Paid` after
     `approve` — `BountyNotRejectable`.
113. All-zero `failed_requirement_id` — `InvalidRequirementId`.

### 12.11 `resolve`

114. `PayScout` after a real `reject`, with tokens donated to the vault: the Scout payout account
     receives the entire balance; the vault is closed with its rent to the requester; `state`
     `Paid`; the bounty account is open.
115. `RefundRequester`, the same setup: the requester's associated token account receives the
     entire balance; `state` `Refunded`.
116. Outcome byte 2 — `InstructionDidNotDeserialize`.
117. Signer other than the arbiter, five cases: the eligibility authority, the attester authority,
     a fresh key, the requester and the Scout — `UnauthorizedArbiter`.
118. The configured arbiter key as the bounty's requester: it funds, a Scout accepts and attests,
     it rejects, then resolves — `ArbiterIsParty`.
119. The configured arbiter key as the bounty's Scout, accepting with a valid voucher naming it —
     `ArbiterIsParty`.
120. From `Submitted` — `BountyNotResolvable`.
121. Destination substitutes, six cases. `PayScout` with the requester's associated token account
     and an attacker's, and `RefundRequester` with the Scout's and an attacker's —
     `TokenAccountOwnerMismatch`; `PayScout` with the Scout's for a second real mint, and
     `RefundRequester` with the requester's for a second real mint — `DestinationAccountMismatch`.
122. `requester` account other than the bounty's requester — `RequesterAccountMismatch`.

### 12.12 `expire_unaccepted`

123. Positive, one second after `acceptance_cutoff`, by an arbitrary fee payer, with tokens donated
     to the vault: the requester's associated token account receives the entire balance;
     `BountyExpired` fields exact; vault and bounty closed with rent to the requester.
124. At exactly `acceptance_cutoff` — `AcceptanceWindowOpen`.
125. From `Accepted` — `BountyNotExpirable`.
126. `requester` account other than the bounty's requester — `RequesterAccountMismatch`.
127. Refund account substitutes, three cases: a non-associated token account the requester owns
     for the configured mint — `ConstraintAssociated`; an attacker's associated token account —
     `ConstraintTokenOwner`; the requester's for a second real mint — `ConstraintAssociated`.

### 12.13 `expire_accepted`

128. Positive, one second after `deadline`, by an arbitrary fee payer, with tokens donated to the
     vault: the requester's associated token account receives the entire balance; the vault is
     closed with its rent to the requester; `state` `Refunded`; the bounty account is open with
     every other field unchanged.
129. At exactly `deadline` — `SubmissionDeadlineOpen`.
130. After an attested shortfall, a real `submit_attestation` failing with
     `InsufficientAssurance`: succeeds once `deadline` has passed; `state` `Refunded` (D85, D95).
131. Outside `Accepted`, three cases: `Funded`, `Submitted` and `Disputed` — `BountyNotExpirable`.
132. `requester` account other than the bounty's requester — `RequesterAccountMismatch`.
133. Refund account substitutes, test 127's three cases, with its errors.

### 12.14 Settlement, cross-cutting

134. Plain repeat, three cases: `approve` twice, `resolve` twice, `expire_accepted` twice —
     `AccountNotInitialized`, from the closed vault. Anchor loads every account before it runs
     any constraint (`anchor-syn` 1.1.2, `try_accounts`), so the state constraint is not reached.
135. Repeat against a re-created vault, eight cases. After settlement a third party re-creates the
     vault and transfers one token unit into it; the instruction then fails on state, and the
     vault, Scout and requester balances are unchanged. `approve` after `approve`, after `release`
     and after `expire_accepted` — `BountyNotApprovable`; `release` after `approve` —
     `BountyNotReleasable`; `resolve` after `resolve` (`RefundRequester`) and after `release` —
     `BountyNotResolvable`; `expire_accepted` after `expire_accepted` and after `approve` —
     `BountyNotExpirable`.
136. `create_and_fund` with the `bounty_id` of a `Paid` bounty — system "already in use" (D96).
137. Missing signer, three cases: `approve` requester, `reject` requester, `resolve` arbiter —
     `AccountNotSigner`.
138. Mint account other than the configured mint, five cases: `approve`, `release`, `resolve`,
     `expire_unaccepted` and `expire_accepted` — `MintMismatch`.
139. The Token-2022 program ID as `token_program`, test 138's five cases — `InvalidProgramId`.
140. The generated IDL lists no arguments for `approve`, `release`, `expire_unaccepted` and
     `expire_accepted`, exactly `failed_requirement_id` for `reject`, and exactly `outcome` with
     two variants for `resolve`: no amount, destination or wallet argument (D92, D94).

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
19. Enable litesvm's `precompiles` feature and add `solana-ed25519-program` `=3.0.0` as a
    dev-dependency; confirm `agave-precompiles` 3.1.14 with `cargo tree` (D89).
19a. Box `bounty`, `usdc_mint`, `bounty_vault` and `scout_payout` in `approve`, and any account
    of `release` or `resolve` their builds require (D100). Review item: the `anchor build`
    output names no function over the stack limit.
20. Append `Disputed`, `Paid` and `Refunded` to `BountyState`; add `failed_requirement_id` last;
    bounty space 274 in `create_and_fund` (D93, D96).
21. Append errors 34 to 48 (D75).
22. Add `BountyExpired` (D95).
23. Add `ResolveOutcome`; implement `approve`, `release`, `reject`, `resolve`,
    `expire_unaccepted` and `expire_accepted` per sections 7.6 to 7.11.
24. Modify tests 92 and 93; add tests 96 to 140.
25. Review items with no single test: every Session 9 check precedes its token CPI; `release`
    checks 1 and 2, `reject` checks 1 and 2, `resolve` checks 1 and 5, `expire_accepted` check
    1, the mint constraints on `scout_payout` and `requester_ata`, and every
    `VaultBalanceBelowReward` check cannot fail through the instructions.

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

Session 9's instructions carry no designated verification. Each is counted with the client's
idempotent create for its destination account placed first (D92, D95); `reject` has none.

| | Keys | Signatures | Bytes | Headroom |
|---|---|---|---|---|
| `approve` | 13 | 2 | 631 | 601 |
| `release` | 13 | 1 | 567 | 665 |
| `reject` | 5 | 2 | 375 | 857 |
| `resolve` | 14 | 2 | 664 | 568 |
| `expire_unaccepted` | 12 | 1 | 534 | 698 |
| `expire_accepted` | 12 | 1 | 534 | 698 |

`resolve` is counted with `PayScout`, whose create names the Scout wallet; `RefundRequester`
names the requester, already a key, so it needs one key fewer.

---

## 15. Stated limits

- **Voucher replay across closure** — D86, after `cancel` or `expire_unaccepted`, with revisit
  triggers in BACKLOG. No other instruction closes a bounty account (D96).
- **Early attestation** — valid until `deadline` unless state or the configured attester changes
  (D82).
- **Malformed direct funding** — a policy-chain mismatch cannot attest and locks only its
  funder's USDC until `expire_unaccepted` (D77, D95).
- **Eligibility availability** — if the eligibility service is down, new accepts stop (D68).
- **Immutable configuration** — replacing a leaked configured key needs an upgrade with a
  migration (D83).
- **Donations** — tokens sent to a live vault go, with the reward, to whoever the settling or
  cancelling instruction pays.
- **Unresolved dispute** — a `Disputed` bounty's balance stays in the vault until the arbiter
  resolves it; no timeout exists (D94).
- **Missing or frozen destination** — settlement fails with nothing moved while the payout or
  refund account does not exist or is frozen by the mint's freeze authority. The balance stays in
  the vault, payable to the same party, until the account is created or thawed (D92, D95).
- **Rent in settled bounties** — each `Paid` or `Refunded` account keeps the requester's 2797920
  lamports; no instruction closes it (D96).
- **Tokens sent to a settled bounty's vault address** — anyone can re-create an associated token
  account there and deposit into it, and no instruction moves tokens once the bounty is `Paid` or
  `Refunded` (test 135). Such tokens are unrecoverable.
- **Requirement membership** — the program stores `failed_requirement_id` without checking it
  against the policy (D93).

Not this document's: `CAPTURE_START_DEADLINE_BUFFER_SECS` (operational, MESSAGES.md section 10);
OPEN-1 profiles below A4 (BACKLOG); the policy binding register (POLICY.md, D84).

---

## 16. D80 reconciliation

| Check | Result |
|---|---|
| Every existing instruction represented | `create_and_fund` 7.2, `cancel` 7.3; the six new |
| | instructions in 7.6 to 7.11 |
| Every account field has a purpose | section 4.1 and section 3 purpose columns |
| Every stored field required or removed | removals in section 4.2 |
| Every enum state reachable with exits | section 5.1 and 5.3 |
| Every authority defined and enforced | section 2 |
| Every money path has preconditions and destination | section 5.2; sections 7.2, 7.3, 7.6, 7.7, |
| | 7.9, 7.10 and 7.11 |
| D67 to D98 reflected | D67 7.2; D68 7.4; D69 via D84; D70 and D71 6; D72 1.3; |
| | D73 off-chain, no program surface; D74 3; D75 10; D76 5.1, 7.3, 8; |
| | D77 7.2, 15; D78 test 90; D79 5.4; D80 this document; D81 4.1, 7.2, 7.4; |
| | D82 2, 7.5; D83 3, 7.1; D84 7.2; D85 7.5, 7.11; D86 tests 52, 53, 54; |
| | D87 10, 11, test 39; D88 test 40; D89 11, 12, 13, test 95; |
| | D90 12 harness, tests 55 and 69; D91 6.2, no behaviour of its own; |
| | D92 2, 7.6, 7.7; D93 4.1, 7.8; D94 2, 7.9, 15; D95 7.10, 7.11, 8; |
| | D96 4.1, 5.1, 5.3, 15, tests 92, 93, 134 to 136; D97 5.4; D98 1.2; |
| | D99 7.6, 7.9, 7.10, 7.11, 11; D100 7 preamble, 13 |
| Existing tests checked | nine kept or modified as tests 12, 13, 14, 19, 21, 29, 30, 31, 33; |
| | `create_with_past_deadline_fails` replaced (task 15); 92 and 93 modified |
| | for D96 |
| Source differences are tasks | section 13 |

---

## Appendix A — budget script

Run with `python3`. The output reproduces section 14.

```python
#!/usr/bin/env python3
"""Legacy transaction sizes for section 14's instructions. No lookup tables."""
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

ATA = [("create_idempotent", 6, 1)]   # payer, account, wallet, mint, system, token
BASE = ["relayer", "config", "bounty", "mint", "vault", "token", "escrow", "compute_budget",
        "system", "associated_token", "requester"]
tx("approve", 2, BASE + ["scout", "scout_payout"], CB + ATA + [("approve", 8, DISC)])
tx("release", 1, BASE + ["scout", "scout_payout"], CB + ATA + [("release", 8, DISC)])
tx("reject", 2, ["relayer", "requester", "bounty", "escrow", "compute_budget"],
   CB + [("reject", 2, DISC + 16)])
tx("resolve", 2, BASE + ["arbiter", "destination", "scout"], CB + ATA + [("resolve", 8, DISC + 1)])
tx("expire_unaccepted", 1, BASE + ["requester_ata"], CB + ATA + [("expire_unaccepted", 7, DISC)])
tx("expire_accepted", 1, BASE + ["requester_ata"], CB + ATA + [("expire_accepted", 7, DISC)])
```
