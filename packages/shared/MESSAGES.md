# BountyCam binary signed messages

**Path:** `packages/shared/MESSAGES.md`
**Style:** per D31 — escape sequences described in words; lines kept short.

This document is normative for the two fixed binary layouts that carry off-chain
signatures onto the money path: `BOUNTYCAM_ATTESTATION_V1` and
`BOUNTYCAM_ELIGIBILITY_V1`. It is separate from `programs/escrow/SPEC.md` because
its consumers are the escrow program, the verifier service and the Session 17
independent verifier, and only the first reads an escrow specification (D80).

Canonical JSON, `sha256` and `merkleRoot` remain in `packages/shared/SPEC.md`.
Nothing here is canonical JSON, and no consumer of this document parses any.

On conflict: `SECURITY.md` wins (D50), then this document, then any
implementation of it.

---

## 1. Why these are binary

SECURITY.md section 5 forbids a second canonical-serialisation implementation.
Section 6 requires on-chain attestation verification. Both hold only if the bytes
the program verifies are not canonical JSON, because otherwise the program would
have to rebuild canonical JSON in Rust and agree byte-for-byte with TypeScript
across the UTF-16 key-ordering rule flagged as a cross-language hazard (D70).

So the signed path carries fixed offsets and fixed widths. No strings other than
the fixed-length domain tag, no delimiters, no optional fields, no key ordering,
no padding.

---

## 2. Encoding rules

- Byte order is little-endian for every multi-byte integer.
- Public keys and hashes are raw bytes, never base58 on the signed path.
- Integers are fixed width. Signedness is normative, not incidental.
- The domain tag is a fixed 24-byte ASCII literal, never a runtime string.
- There is no padding anywhere. Field offsets are contiguous.
- Total message length is fixed per schema and is itself a validated property.

Signedness matters as much as width. `deadline`, `issued_at` and `expires_at` are
signed 64-bit because Solana's `Clock::unix_timestamp` is signed. An
implementation reading them as unsigned agrees with a conforming one until a
negative value appears, and then disagrees silently.

---

## 3. `BOUNTYCAM_ATTESTATION_V1`

Total length **261 bytes**.

| Offset | Width | Field | Type | Source |
|---|---|---|---|---|
| 0 | 24 | `domain_tag` | ascii | const |
| 24 | 2 | `schema_version` | u16 | const |
| 26 | 1 | `deployment_id` | u8 | config |
| 27 | 32 | `program_id` | raw | const |
| 59 | 16 | `bounty_id` | raw | state |
| 75 | 32 | `requester` | raw | state |
| 107 | 32 | `scout` | raw | state |
| 139 | 32 | `policy_hash` | raw | state |
| 171 | 32 | `eligibility_profile_hash` | raw | state |
| 203 | 1 | `required_assurance` | u8 | state |
| 204 | 8 | `deadline` | i64 | state |
| 212 | 8 | `review_window_secs` | i64 | state |
| 220 | 32 | `evidence_root` | raw | caller |
| 252 | 1 | `achieved_assurance` | u8 | caller |
| 253 | 8 | `issued_at` | i64 | caller |

Domain tag value: the ASCII text `BOUNTYCAM_ATTESTATION_V1`, which is exactly 24
bytes.

---

## 4. `BOUNTYCAM_ELIGIBILITY_V1`

Total length **212 bytes**.

| Offset | Width | Field | Type | Source |
|---|---|---|---|---|
| 0 | 24 | `domain_tag` | ascii | const |
| 24 | 2 | `schema_version` | u16 | const |
| 26 | 1 | `deployment_id` | u8 | config |
| 27 | 32 | `program_id` | raw | const |
| 59 | 16 | `bounty_id` | raw | state |
| 75 | 32 | `requester` | raw | state |
| 107 | 32 | `scout` | raw | state |
| 139 | 32 | `policy_hash` | raw | state |
| 171 | 32 | `eligibility_profile_hash` | raw | state |
| 203 | 1 | `required_assurance` | u8 | state |
| 204 | 8 | `expires_at` | i64 | caller |

Domain tag value: the ASCII text `BOUNTYCAM_ELIGIBILITY_V1`, also exactly 24
bytes.

The two schemas share the structure of their first 204 bytes but are never
interchangeable: the domain tag differs at offset 0, and the total lengths differ
(261 against 212), so D71's exact-length check rejects a cross-presented message
independently of the tag comparison.

`requester` is present because the bounty PDA is seeded on requester and
`bounty_id` together, so `bounty_id` is unique only per requester. A voucher
naming `bounty_id` and `scout` alone would be ambiguous across two requesters who
chose the same id.

---

## 5. Field sourcing

Four sources, and the distinction is load-bearing for D71's
reconstruct-then-compare.

- **const** — compiled into the program.
- **config** — program or configuration state.
- **state** — read from the bounty account.
- **caller** — supplied as an instruction argument and spliced in.

The caller-supplied set is closed. For `submit_attestation` it is exactly
`evidence_root`, `achieved_assurance` and `issued_at`. For `accept` it is exactly
`expires_at`. A caller-supplied value is safe only because the authority's
signature covers it: a wrong value produces a message that differs from the
reconstruction and fails.

The program must never accept caller-supplied duplicates of state-derived fields
for convenience. Each caller field is placed contiguously at the end of its
layout so that reconstruction is one state-derived prefix followed by one
supplied suffix.

---

## 6. Validity model

There is no attestation expiry field in V1. The signed bytes carry `issued_at`,
which the program does not compare against the Clock.

An attestation is valid while all of the following hold:

1. The bounty is in a state that permits attestation submission.
2. The current on-chain time is not later than the bounty's committed `deadline`.
3. The signature verifies under the **currently configured** attester authority.
4. Every state-derived field still matches the bounty account (D77).

`issued_at` records the timestamp the attester asserted and signed. The program
does not independently establish that this was the real-world issuance time, and
it must not be described as on-chain evidence of when capture, verification or
signing physically occurred.

The eligibility voucher does carry `expires_at`, which the program checks against
the Clock (D68).

**Stated limit.** An attestation issued early remains submittable until the bounty
deadline unless the bounty state changes or the attester authority is rotated.
That is a deliberate MVP trade-off. Evidence freshness is governed by the capture
nonce and the evidence policy (D72, D73), not by how recently the attester signed
its conclusion.

**Rotation is semantics, not a button.** Bounties do not snapshot the attester
authority; the currently configured authority governs at submission time, so
rotation reaches outstanding attestations. But following D74, no broadly callable
rotation instruction exists. Revoking a compromised attester key in the MVP
requires the authorised configuration mechanism or a program upgrade, not a
runtime call. Any future rotation instruction needs its own decision covering who
may rotate, recovery, tests and auditability.

---

## 7. Transaction budget

Computed, not discovered on device (D77). Limit is 1232 bytes.

| Component | Bytes |
|---|---|
| Signature count byte plus two signatures | 129 |
| Message header | 3 |
| Account key count plus eight keys | 257 |
| Recent blockhash | 32 |
| Instruction count byte | 1 |
| ed25519 instruction (header, key, signature, 261-byte message, framing) | 377 |
| `submit_attestation` instruction (discriminator, three caller fields, index) | 60 |
| Two compute-budget instructions | 22 |
| **Total** | **881** |
| **Headroom** | **351** |

The ed25519 instruction data alone is 373 bytes: one count byte, one padding
byte, a 14-byte offset structure, a 32-byte key, a 64-byte signature and the
261-byte message.

The account count is the largest variable term. Each additional account costs 32
bytes in the key array plus one byte of instruction index, so 33 bytes. The
headroom therefore tolerates about ten more accounts, giving a **ceiling of
roughly eighteen accounts** for the attestation transaction.

The 24-byte domain tag remains the deliberate lever. It is not needed at this
budget and should not be shortened for its own sake; shortening it later shifts
every offset and invalidates every vector, so it is a last resort.

`submit_attestation` does not yet exist, so the eight-account figure is an
estimate. Step 3 must check its real account list against the eighteen-account
ceiling rather than re-deriving the budget.

---

## 8. Golden vectors

The vectors are generated by `gen_vectors.py` and published as `vectors.json`.
Signing keys are derived from fixed ASCII seeds so any implementation can
regenerate the same keypairs without shipping key material. The seeds are test
values and must never be used on any live deployment.

Current set: 17 message vectors, 15 attestation mutation vectors (one per signed
field), and 3 cross-type rejection cases.

Coverage includes: nominal messages for both schemas; `i64` maximum and minimum
for `deadline`; zero and negative `review_window_secs`; the assurance floor and
the `MAX_ASSURANCE_LEVEL` ceiling of 4; achieved exceeding required; `deployment_id`
at 0 and 255; epoch-zero timestamps; all-zero and all-ones hash fields; and for
the voucher, `expires_at` at the `i64` ceiling and zero.

Published vectors are immutable. A genuine change of semantics goes through an
explicit schema version change, never a silent rewrite (D78).

Authority on disagreement, in order: this document; the published vectors; the
production `packages/shared` implementation; the independent verifier.

---

## 9. Required tests

Layout and vectors:

- Each schema's canonical message has exactly the specified byte length.
- Field offsets match the published table.
- Both implementations reproduce every published vector byte for byte.
- Cross-generation: one implementation produces messages, the other verifies,
  with varying inputs rather than a fixed pair (D78).

Mutation:

- Mutating any signed field produces a message the program rejects, because the
  reconstruction no longer matches. One case per field, 15 for the attestation.

Cross-type and authority:

- An eligibility message presented to the attestation path is rejected.
- An attestation message presented to the eligibility path is rejected.
- An attestation signed by the eligibility authority is rejected.
- An attestation signed by a former, non-current authority is rejected.

Temporal:

- A valid attestation before the bounty deadline is accepted.
- The same attestation after the deadline is rejected.
- An attestation for a bounty that has already transitioned is rejected.

Length and shape: covered by D71's canonical-shape and exact-length requirements
rather than duplicated here. Appending or truncating bytes fails the length check.

---

## 10. Dependencies on the escrow specification

This layout cannot be implemented until step 3 resolves the following. Each is an
implementation discrepancy under D80, to be fixed rather than specified around.

1. **`eligibility_profile_hash` is not stored on-chain.** The bounty account must
   carry it as `[u8; 32]`, and `create_and_fund` must receive and store it.
   Without it the attestation cannot be reconstructed.
2. **`attester_authority` is a caller-supplied instruction argument stored per
   bounty.** A direct caller names themselves and later signs their own
   attestations. It must become program or configuration state.
3. **`arbiter_authority` is still an `UncheckedAccount` stored per bounty.** D74
   ordered it removed from both the arguments and the account.
4. **`deadline` has no upper bound.** Only a past-deadline check exists. With no
   attestation expiry, an unbounded deadline is close to no time bound at all, so
   a maximum is required.
5. **`review_window_secs` is unvalidated.** It is `i64` and a negative value is
   currently storable.
6. **D67 has not landed.** `PLATFORM_FEE_BPS` still exists, the fee arithmetic
   still runs, and funding still transfers reward plus fee. It is harmless only
   because the constant is zero.
7. **The `Cancelled` enum variant is still present** and there is no `Available`
   variant.

Also open, and not this document's to settle: `CAPTURE_START_DEADLINE_BUFFER_SECS`,
the nonce-service rule that stops a Scout beginning work too close to the deadline
to settle. It is operational configuration, deliberately not part of the hashed
policy or of either layout.
