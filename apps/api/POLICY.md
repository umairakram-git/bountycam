# `apps/api` — Policy and Bounty Specification

**Status:** normative for Session 7b. Written before implementation (Session 7a).
**Scope:** the policy object version 1, its canonical form and hash, the bounty resource
and its endpoints, and the migrations these require (prose here; code in Session 7b).
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.
**Amended:** Session 17 (P1) — sections 1, 2.6, 5, 7.2, 8.7, 8.8 and 14, and the new
section 15: funding from the device and the funding projection (D117 to D121).
**Amended:** Session 18 (P2) — sections 8.2, 8.4, 8.5, 8.8 and 14, and the new
section 16: discovery, acceptance and the acceptance projection (D124 to D127).
**Amended:** Session 20 (P4) — sections 8.2, 17.6 and 17.7, and the new section 18: evidence
upload and submission (D138 to D144).
**Amended:** Session 20 build — section 18.10 test 16, amendment A1.
**Amended:** Session 21 (P5) — the new section 19: the verifier and the attestation (D146 to
D153); it extends sections 7.2, 16.4 and 18.7 in place.
**Amended:** Session 21 build — section 19.2, amendment A1.
**Amended:** Session 22 (P6) — the new section 20: review, settlement and the settlement
projection (D155 to D163); it extends sections 7.2, 16.4, 16.5 and 19.11 in place.

Policies and bounties share this document deliberately: the hashed policy object and the
bounty row that references it must not drift, and a split document is how they would.

Where this spec and the implementation disagree, the spec wins and the implementation is
buggy.

---

## 1. Scope, status and precedence

Normative in this document:

- the policy object version 1: fields, sources, rejection rules (section 2)
- the canonical form, the policy hash, and its representations (section 3)
- policy immutability (section 4)
- the GPS seven-decimal profile and where it is enforced (section 5)
- the reward amount: wire form, column, bounds (section 6)
- the bounty resource and its states as Session 7 uses them (section 7)
- the endpoints, check orders and error codes (section 8)
- location approximation (section 9) and idempotency (section 10)
- the Session 7b migrations in prose (section 11) and the test list (section 12)
- funding from the device, and the projection that makes a funded bounty `AVAILABLE`
  (section 15)

Normative elsewhere, and winning on conflict in their own scope:

- `SECURITY.md` — binding invariants; wins over this document everywhere (D50)
- `packages/shared/SPEC.md` — `canonicalise`, `sha256`, `merkleRoot`; wins on
  serialisation and hashing
- `apps/api/AUTH.md` — authentication, JWT verification, and the middleware this
  document's protected endpoints reuse (section 8.1)
- the escrow program and its specification, `programs/escrow/SPEC.md` (D80) — the
  on-chain state machine and every financial transition; until Session 9 reconciles
  the enums, the chain is authoritative for financial truth and the database
  `bounty_state` is workflow display (SECURITY.md section 0; section 7 here)

This document wins over any implementation of it.

---

## 2. The policy object, version 1

The policy object is the complete, self-contained statement of what a Scout must prove
and what the escrow will pay. It is built by the server from the create request (section
8.3), canonicalised and hashed (section 3), stored once, and never edited (section 4).
The create response returns the full object beside its hash so any client can
re-canonicalise and verify independently.

The rule that draws every line in this section: **anything the verifier or the escrow
program relies on is inside the hashed policy; everything else is mutable bounty-row
workflow data.** Section 2.4 lists both sides of the line.

Enum-like values are uppercase (D20): the domain tag and the requirement `type`. The
`chain` and `cluster` values are lowercase protocol identifiers following the SIWS chain
grammar and the AUTH.md section 4 table; they are not database enums and D20 does not
apply to them.

Every value below is producible by Session 7 code (D34, D44, the `Cancelled` finding):
all sixteen fields are written at creation, and no allowed value exists that creation
cannot store.

**Frozen (D84, D112).** This version of the policy object is frozen at commit
`dbc0ec77ed55059db6d8019ea5e7631742178dc2`, the first in which `packages/shared` and
this API reproduce every vector in section 13 and every profile-hash vector in
`packages/shared/SPEC.md` section 7.4. From that commit, any change to the canonical
bytes, to a field's semantics, to the profile-hash derivation or to an existing V1 or
V2 vector is a new policy version with a new domain tag. Request validation, error
codes, discovery and the read model are outside the freeze and remain amendable,
because none of them changes a hashed byte.

### 2.1 Fields

Fields are listed in canonical order — ascending UTF-16 code unit order of the keys
(SPEC.md section 1.2) — which is also their order in the canonical text.

Source column: **request** — supplied by the client, validated; **request, optional** —
validated if present, configured default when absent; **constant** — injected by the
server, one lawful value, never accepted from the client; **assigned** — generated by
the server at creation.

| Field | Source | Type | Rule |
|---|---|---|---|
| `acceptance_window_seconds` | request | integer | 60 to 2592000 inclusive |
| `capture_radius_m` | request | integer | 10 to 10000 inclusive |
| `chain` | constant | string | exactly `solana` |
| `challenge_window_seconds` | request | integer | 60 to 86400 inclusive |
| `cluster` | request, optional | string | the configured cluster; currently `devnet` |
| `completion_window_seconds` | request | integer | section 17.4 floor to 2592000 inclusive |
| `domain_tag` | constant | string | exactly `BOUNTYCAM_POLICY_V1` |
| `eligibility_profile_id` | request | string | a section 2.5 registry id; see 2.5 |
| `evidence_requirements` | request | array | 1 to 20 items, each per section 2.2 |
| `fee_amount` | constant | string | exactly the one-character string `0` (D24) |
| `lat` | request | string | GPS profile (section 5); -90 to 90 |
| `lon` | request | string | GPS profile (section 5); -180 to 180 |
| `required_assurance` | request | integer | 0 to 4 — the D13 ladder A0 to A4 |
| `reward_amount` | request | string | base-unit integer string (section 6) |
| `salt` | assigned | string | lowercase hex, exactly 64 characters (section 9.4) |
| `settlement_mint` | request, optional | string | base58, 32 bytes; the configured mint |

Notes:

- `cluster` and `settlement_mint` may be sent by the client so that a misconfigured
  client talking to the wrong environment fails loudly instead of creating a policy it
  did not intend. When absent, the configured values are used. Only the canonical
  cluster form (`devnet`) is accepted: the `solana:` prefixed form from the SIWS grammar
  is an auth message form, not a policy value.
- `fee_amount` is not a request field. The server writes the only lawful value (D24 —
  the fee is exactly 0; Session 4's invented fee constant is the incident this rule
  exists to prevent). A future non-zero fee is a new policy version behind a D-entry
  with its own spec, never a wider validation rule here.
- `attester_pubkey` was a policy field until D82 and is gone. The attester is read
  from the immutable on-chain configuration account, the currently configured key
  governs at submission, and no bounty snapshots it. A policy carrying the field is an
  unknown field and fails as `INVALID_REQUEST`.
- `eligibility_profile_id` names the committed rule set a Scout must satisfy to accept
  the bounty (D69, D84, D107). It must be a registry id from section 2.5 and must be
  admissible for the requested `required_assurance`; section 2.5 gives both rules and
  their codes. Its 32-byte hash, derived per `packages/shared/SPEC.md` section 7, is
  what `create_and_fund` stores on the bounty account and what both binary signed
  messages carry — so the id is hashed inside the policy and its meaning is hashed
  separately, which is the point of D107.
- `required_assurance` is the integer form of the D13 ladder: 0 is A0 through 4 is A4.
  A5 does not exist (D13 defers it), so 5 is rejected. The integer form matches the
  database smallint and the program's numeric comparison (D17); the A-names are display
  labels, never stored or hashed.
- `salt` is 32 random bytes rendered as exactly 64 lowercase hex characters. The
  source is normative: `randomBytes` from `node:crypto`, reached through an injectable
  randomness module mirroring the clock pattern (AUTH.md section 8) — production binds
  `node:crypto`, tests inject a deterministic double and assert the value propagates
  (section 12). The salt exists solely to blind the policy hash against preimage
  search (section 9.4): it is never accepted from the client, never appears in any
  public view, list item, error message or log line, and is disclosed with the rest
  of the policy only to the requester and, after acceptance, the assigned Scout. No
  verifier logic reads it; every consumer treats it as opaque.
- The three windows are durations in seconds, never absolute times. Their meanings:
  `acceptance_window_seconds` — how long the bounty remains open for acceptance once it
  is discoverable; `completion_window_seconds` — from acceptance to the submission
  deadline; `challenge_window_seconds` — from policy pass to auto-release, within which
  the requester may dispute (D12). Absolute deadlines are derived workflow data
  (section 2.4). The minimum of 60 seconds admits the D12 demo review window; the
  maxima — 30 days for acceptance and completion, 24 hours for review — bound
  derived deadlines to sane timestamps. The review maximum is deliberately the
  shortest: the review window holds a Scout's already-earned payment awaiting
  requester silence, and a week-long hold is a marketplace failure, not a parameter
  choice. The bounds are provisional product values; changing them is a spec
  amendment and does not affect any existing hash.
- Mapping (D72): the canonical policy JSON field `challenge_window_seconds`, the
  on-chain field `review_window_secs`, and the prose term *review window* are the
  same concept. `challenge_window_seconds` is retained solely for compatibility with
  the existing hashed-policy schema and must never be read as the SIWS challenge or
  the capture nonce.

### 2.2 Evidence requirements

Each element of `evidence_requirements` is an object with exactly these keys, shown in
canonical order:

| Key | Source | Type | Rule |
|---|---|---|---|
| `id` | assigned | string | uuid, lowercase hyphenated form |
| `prompt` | request | string | 1 to 500 UTF-16 code units |
| `required` | request | boolean | at least one item in the list is true |
| `type` | request | string | exactly `PHOTO` |

- The array order in the request is the mission order, and the canonical array order
  is what the hash commits to: arrays preserve order in canonical JSON (SPEC.md
  section 1.1). The server assigns `id` as a fresh version 4 uuid from the injectable
  randomness module (production binds `randomUUID` from `node:crypto`; section 2.1's
  salt note); a request item containing `id` is rejected as an unknown field
  (`INVALID_REQUEST`).
- There is deliberately no `sequence` field. It would always equal the item's 1-based
  position, so it carries no information the array does not, and an always-derivable
  field inside a hash invites a future implementation to derive it differently — the
  D34 unreachable-code reasoning applied to data. The database `sequence` column
  remains as a derived read-model copy of the array position (section 11), never
  authoritative.
- `id` is the stable identifier the rest of the system uses: `evidence_requirements.id`
  in the database, `failed_requirement_id` in structured rejection, and the binding of
  each evidence item at submission. It sits inside the hash, so a later rejection names
  a requirement the requester provably precommitted to.
- `type` has the single value `PHOTO` — the only capture Session 12 plans and the only
  value Session 7 code stores. New types are added here by amendment in the session
  whose code produces them (D34 reasoning).
- At least one item must carry `required` true. A policy whose requirements are all
  optional is satisfiable by an empty submission; that fails closed here rather than
  surfacing in the verifier.
- Bounds — 1 to 20 items, prompt 1 to 500 UTF-16 code units — cap the canonical text
  near 50 KB worst case and keep a mission humanly completable. Provisional product
  values, same status as the window bounds.

### 2.3 Rejection rules

Validation runs before canonicalisation. Type errors are `INVALID_REQUEST`: integer
fields accept only JSON numbers that are integers in the safe range (SPEC.md section
1.3); fractions, digit strings, booleans and nulls in an integer field are type errors,
as are missing fields, unknown fields, and wrong JSON types anywhere. A well-typed value
that breaks a field rule gets the field's own code. A value that passes every rule below
but still throws `SpecError` in `canonicalise` (for example a lone surrogate in a
prompt) is `INVALID_REQUEST`.

| Code | Status | Failure |
|---|---|---|
| `INVALID_REQUEST` | 400 | body shape: missing or unknown field, wrong type, `SpecError` |
| `INVALID_ASSURANCE` | 400 | `required_assurance` integer but outside 0 to 4 |
| `PROFILE_UNKNOWN` | 400 | `eligibility_profile_id` is not a section 2.5 registry id |
| `PROFILE_ASSURANCE_MISMATCH` | 400 | the profile is not admissible for `required_assurance` |
| `CLUSTER_NOT_ALLOWED` | 400 | `cluster` present and not the configured cluster |
| `MINT_NOT_ALLOWED` | 400 | `settlement_mint` present and not the configured mint |
| `INVALID_GPS` | 400 | `lat` or `lon` fails the section 5 profile or range |
| `INVALID_CAPTURE_RADIUS` | 400 | `capture_radius_m` integer but outside 10 to 10000 |
| `INVALID_WINDOW` | 400 | a window field integer but outside its section 2.1 bounds |
| `INVALID_REWARD_AMOUNT` | 400 | `reward_amount` fails a section 6 rule |
| `INVALID_REQUIREMENTS` | 400 | list empty, over 20 items, or no `required` true item |
| `REQUIREMENT_TYPE_NOT_ALLOWED` | 400 | a requirement `type` is not `PHOTO` |
| `INVALID_REQUIREMENT_PROMPT` | 400 | a `prompt` empty or over 500 code units |

The numbered check order for the endpoint, placing these among auth and idempotency
checks, is section 8.3.

### 2.4 The hashed boundary

Inside the hashed policy — everything the verifier or the escrow program relies on:

| Group | Fields | Relied on by |
|---|---|---|
| money | `chain`, `cluster`, `settlement_mint`, `reward_amount`, `fee_amount` | escrow |
| proof | `required_assurance`, `evidence_requirements` | verifier, escrow |
| who | `eligibility_profile_id` | eligibility service (2.5) |
| place | `lat`, `lon`, `capture_radius_m` | verifier |
| time | the three window fields (section 2.1) | verifier, escrow (D12) |
| format | `domain_tag` | every consumer |
| privacy | `salt` | the hash's preimage resistance (section 9.4) |

Outside — bounty-row workflow data, mutable or derived, never hashed:

| Field | Role |
|---|---|
| `bounties.id` | resource identity; join key |
| `bounties.requester_id` | party binding — see the note below |
| `bounties.policy_id` | reference to the hashed policy row |
| `title`, `category` | display only; the verifier and the program never read them |
| `state` | workflow display (section 7); never proof of an on-chain transition |
| `program_account` | pointer to the on-chain bounty; presence is not proof of funding |
| absolute deadlines | derived: funding, acceptance and policy-pass times plus windows |
| idempotency key | transport concern (section 10) |
| `created_at` | audit |

The `policies` row's own `id`, `requester_id` and `created_at` are likewise workflow
data: the commitment is the hash, not the row. The derived read-model copies —
`bounties.location`, the PostGIS geography built from the policy `lat` and `lon` for the
discovery index (D21), and any column duplicating a policy value for query (section 11
decides which stay) — are never authoritative. The policy canonical text is; the
verifier and the escrow read only policy values.

The requester and the Scout are deliberately outside the policy. The policy commits to
the task; the parties are bound where binding is enforced — the requester and Scout
wallets in the on-chain bounty account, and both, plus the policy hash, inside the
attestation (SECURITY.md section 6). Keeping identity out of the policy also leaves
policy reuse open as a later endpoint rather than a schema change.

### 2.5 The eligibility profile registry

Two profiles exist (D107). `packages/shared/SPEC.md` section 7 gives the object, the
id format, the hash derivation and the vectors; this table is the registry.

| `eligibility_profile_id` | `requires_sgt` | Qualifying rule |
|---|---|---|
| `BASE_V1` | false | the Scout's wallet is SIWS-proved and the user row is `ACTIVE` |
| `A4_SEEKER_V1` | true | the same, plus a server-side Seeker Genesis Token check |

An id outside this table is `PROFILE_UNKNOWN`, whatever its syntax. That check runs at
step 5 of section 8.3 in the canonical field position of `eligibility_profile_id`,
because registry membership depends on no other field.

Admissibility is a strict bijection against `required_assurance`:

| `required_assurance` | admissible profile |
|---|---|
| 0, 1, 2, 3 | `BASE_V1` only |
| 4 | `A4_SEEKER_V1` only |

Any other pair is `PROFILE_ASSURANCE_MISMATCH`. That check also runs at step 5, but
immediately after `required_assurance` has passed its own range rule rather than at the
profile's canonical position (D110). It is the one field rule not evaluated where its
field sorts, because a pair cannot be judged against an assurance level that is itself
invalid: judged earlier, `required_assurance` of -1 beside `BASE_V1` would return
`PROFILE_ASSURANCE_MISMATCH` where section 12 test 23 requires `INVALID_ASSURANCE`.

Accepted limitation (D107): a requester cannot demand a Seeker for a job below
assurance 4. Widening the admissible set is a change to this table and to request
validation; it changes no stored hash.

A consequence worth recording: because the pairing is a bijection,
`required_assurance` determines the profile. The list item view (section 8.2)
therefore already tells a Scout whether they qualify, and carries no profile field;
adding one would duplicate a fact the caller can already derive.

The qualifying rules above are what the eligibility service enforces before it issues
a voucher. They are stated here because the policy commits to the id and a reader of a
policy must be able to learn what the id meant; the issuance mechanics are
`apps/api/ELIGIBILITY.md`.

### 2.6 The binding register

Three values are committed in more than one place, and every copy must agree before a
bounty is discoverable (D79, D84). The register exists so that "every binding agrees"
in section 7.2 names a closed set rather than a sentiment.

Every row is checked when funding is confirmed.

| Value | In the policy | On chain |
|---|---|---|
| `policy_hash` | hash of the canonical text | `bounty.policy_hash` |
| `eligibility_profile_id` | a hashed field | `bounty.eligibility_profile_hash` |
| `required_assurance` | a hashed field | `bounty.required_assurance` |

The on-chain copy of the profile is the 32-byte hash, not the id, so the check is
`eligibilityProfileHash(registry[id]) == bounty.eligibility_profile_hash`. A
disagreement in any row leaves the bounty unprojected: it never reaches `AVAILABLE`,
so it is never discoverable and never acceptable. The reconciler reports it; nothing
repairs it, because a bounty funded against a policy it does not match is not a
recoverable state.

**Amended in Session 17 (D119).** The three rows above are the register the voucher
re-checks (ELIGIBILITY.md section 4, check 7). The funding projection (section 15.3)
checks a wider set: every field of the funded account that a Scout relies on must equal
its source. The additions:

| Value | Source | On chain |
|---|---|---|
| bounty id | the 16 bytes of `bounties.id` (D117) | `bounty.bounty_id` |
| requester | the requester's `users.wallet_address` | `bounty.requester` |
| `reward_amount` | the policy string, as an unsigned integer | `bounty.reward_amount` |
| `fee_amount` | the policy's `0` | `bounty.platform_fee` |
| `acceptance_window_seconds` | a hashed field | `bounty.acceptance_window_secs` |
| `completion_window_seconds` | a hashed field | `bounty.completion_window_secs` |
| `challenge_window_seconds` | a hashed field (D72) | `bounty.review_window_secs` |

Why. Discovery shows the policy's reward (the section 8.2 list item reads the read-model
column), but the program pays the account's. Without the reward row a direct caller
could fund one base unit against a policy promising more; the bounty would become
discoverable, and the Scout would learn the difference at payout. Without the window
rows a mismatch surfaces only when the attester refuses it (MESSAGES.md section 3),
after the Scout's work. Checked at projection, either mismatch keeps the bounty
undiscoverable, so no Scout starts it. The windows are still verified by the attester
as well. The voucher does not repeat the additions: each is immutable on chain once
funded, and the voucher only ever reads bounties the projection admitted.

---

## 3. Canonical form and the policy hash

### 3.1 The exact input bytes

The policy hash is SHA-256 over the UTF-8 encoding of `canonicalise(policy)` — the
canonical text of the section 2 object — computed with the `canonicalise` and `sha256`
exported by `packages/shared` and nothing else (SECURITY.md section 5; SPEC.md is
normative for both functions). No route, helper, test or migration reimplements either.

The input is exactly those bytes: no byte-order mark, no trailing line feed, no length
prefix, no domain prefix, no concatenated context. The object carries exactly the
sixteen section 2.1 fields; an object with a seventeenth field or a missing field is a
different object with a different hash, and creation must be structurally incapable of
producing one.

### 3.2 The domain tag is a field, not a prefix

`domain_tag`, value `BOUNTYCAM_POLICY_V1`, is a field inside the object. It is not a
byte prefix over the canonical text. Three reasons:

- `policies.canonical_json` stores the exact bytes hashed (section 3.4; the Session 3
  column comment). With a prefix, the stored value is either no longer valid JSON or no
  longer the bytes hashed — the storage rule and a prefix cannot both hold.
- A field survives any consumer that parses and re-canonicalises the JSON: the tag is
  data, so it round-trips. A prefix lives outside the data and must be re-attached by
  convention; a consumer that forgets it computes a plausible-looking wrong hash
  silently.
- SECURITY.md section 5 governs signed objects, and its tags separate signature
  domains. The policy hash is an unsigned commitment — nothing signs the policy object
  itself — so placing the versioned tag inside the object extends the tag convention to
  commitments without weakening section 5: a signature in one domain still fails in
  every other, and the policy object is in no signature domain at all.

Because keys sort canonically, the tag is not the first bytes of the canonical text. Its
position carries no meaning; its presence and value are what the hash commits to.

Proposed as a D-entry at the end of Session 7a.

### 3.3 Output encoding and representations

`sha256` returns the raw 32-byte digest. One representation per medium, no alternatives:

| Medium | Representation |
|---|---|
| API requests and responses | lowercase hex, exactly 64 characters, no prefix |
| database | `policies.policy_hash` bytea, exactly 32 bytes |
| on-chain | the 32-byte `policy_hash` field of the bounty account, raw bytes |

The hex convention is SPEC.md section 2: lowercase, unprefixed, 64 characters. Hex
exists only at the API surface and in logs; the database and the chain hold raw bytes.
Nothing ever stores or compares a re-encoded form against another medium without first
normalising to bytes.

### 3.4 The stored canonical text

`policies.canonical_json` stores the exact canonical text — the string whose UTF-8
encoding was hashed. It is written once at creation and never regenerated, reformatted,
re-serialised or re-encoded afterwards, for any reason, including migrations, ORM round
trips and pretty-printing tools. The database encoding must be UTF-8 (it is), so the
stored text re-encodes to the identical bytes. The canonical text contains no raw
control characters — SPEC.md section 1.4 escapes them — so a text column holds it
exactly.

Two invariants, both tested (section 12):

- for every row, `sha256` over the UTF-8 bytes of `canonical_json` equals `policy_hash`;
- parsing `canonical_json` and re-canonicalising the parsed object reproduces the stored
  text byte for byte.

A consumer verifying a policy hashes the stored text's bytes directly. Re-canonicalising
is a conformance check on the pipeline, not the verification path; the stored text is
authoritative.

### 3.5 Client verification before funding

The server-assigned salt and requirement ids sit inside the hash, so a requester
cannot compute the policy hash from their request alone. The hash the wallet signs
over must therefore be verified client-side, from the returned object, before any
funding signature. This is a
SECURITY.md section 3 obligation — money transactions come only from typed builders fed
verified inputs — stated here so Sessions 11 and 16 inherit it rather than rediscover
it.

Before requesting a funding signature, the client must:

1. re-canonicalise the returned policy object with `packages/shared` and hash it;
2. check that result equals the returned policy hash;
3. check every field of the returned object against its source (section 2.1): each
   request field equals what the client sent, each constant equals its documented
   value, each configured field equals the value the client expects for its
   environment; the assigned salt and requirement ids are the only values it cannot
   predict;
4. build the funding transaction so it carries exactly the verified hash and a u64
   amount parsed from the verified object's `reward_amount` (section 6.3), then
   validate the complete transaction per SECURITY.md section 3 before the wallet sees
   it.

A malicious or buggy API returning a tampered object with a self-consistent hash passes
steps 1 and 2; step 3 is what catches it. A wallet must never sign a funding
transaction whose policy hash or amount was taken from a server response that skipped
these checks.

---

## 4. Immutability

A policy is write-once. The policy row, its requirement rows and its bounty row are
inserted in one database transaction (section 8); after that transaction commits, no
statement updates or deletes a `policies` row or an `evidence_requirements` row, and
`bounties.policy_id` is never rewritten — before funding or after. There is no edit
endpoint and no update path in Session 7b code.

Changing any term is creating a new policy with a new hash. In this API that means a
new bounty: cancel the unfunded bounty (section 8) and create again. A later
policy-reuse or edit-by-supersession endpoint must preserve exactly this property: new
object, new hash, old row untouched.

A policy with no bounty cannot arise: policies are created only inside bounty creation,
in the same transaction, and cancellation marks the bounty `CANCELLED` rather than
deleting either row (section 8). The pairing is one policy to exactly one bounty for
the life of the database; reuse, if it ever arrives, relaxes this to one-to-many by
amendment. There is consequently no orphan-policy case to specify.

What this section protects: the hash the requester funded is the hash the Scout worked
under and the hash the attestation names (SECURITY.md section 6). An edit that kept the
row while changing content would silently break all three agreements at once.

---

## 5. The GPS seven-decimal profile

SPEC.md section 1.3 defines the profile as normative for producers and deliberately
leaves `canonicalise` profile-agnostic — domain validation stays out of the hash
primitive. The check therefore lives at the producer boundary. Session 7's only
producer of policy objects is `apps/api`, so the check is request validation in
`apps/api`, specified here, run before canonicalisation (section 2.3), failing with
`INVALID_GPS`. The stated trigger was a second
producer of policy objects: a client that formats coordinates for a create request.
Session 17's mobile create flow is that producer, so the lift is done (D121). The rules
below are implemented once, as `isValidLat` and `isValidLon` in `packages/shared`
(SPEC.md section 8.1), which `apps/api` calls at request validation; the phone formats
every coordinate it sends with `formatCoordinate` from the same section. This section
remains the statement of the rules. `canonicalise` itself is never changed for this.

`lat` and `lon` each pass exactly when every rule below holds. Characters are named in
words with their code points; all allowed characters are printable ASCII, so forms are
shown literally where useful (D31 concerns escape sequences, which do not arise here).

1. **Alphabet.** Only the hyphen-minus (U+002D), the digits zero to nine (U+0030 to
   U+0039) and the full stop (U+002E) may appear, each only where the rules below
   place it. Digit characters from any other script, the plus sign, exponent markers,
   whitespace and grouping separators are rejected.
2. **Sign.** At most one hyphen-minus, only as the first character, and only when the
   value is strictly negative (rule 6). Zero and positive values are unsigned.
3. **Integer part.** Either the single digit `0`, or a nonzero digit followed by zero
   or more digits. No leading zeros.
4. **Separator.** Exactly one full stop, immediately after the integer part.
5. **Fraction.** Exactly seven digits after the full stop — not six, not eight.
6. **Negative zero.** Prohibited. The value zero is written `0.0000000`: the digit
   zero, the full stop, seven zero digits, no sign. A hyphen-minus followed by an
   all-zero numeral is rejected; the canonical representation of negative zero is the
   unsigned zero form, and only canonical forms are accepted.
7. **Range.** Checked numerically after the form rules: `lat` from -90 to 90
   inclusive, `lon` from -180 to 180 inclusive. The extremes are `90.0000000`,
   `-90.0000000`, `180.0000000` and `-180.0000000`; any greater magnitude fails,
   whatever its form.

-180 and 180 denote the same meridian yet are distinct strings and distinct policy
values. The spec does not fold one into the other: folding is a normalisation, and the
hash pipeline performs none (D27's reasoning, applied to coordinates). Producers emit
what the position fix gives them. The consequence is owned, not implied: evaluation of
the capture radius across the antimeridian — a capture circle spanning the 180th
meridian — is unspecified here and belongs to Session 14's verifier specification.
Nothing in Session 7 computes a distance to a policy location; discovery distance runs
on PostGIS geography against the snapped public point (sections 8 and 9), which
handles meridian wraparound itself.

Why exactly seven digits stands in SPEC.md section 1.3: about 1.1 cm at the equator,
finer than any GPS fix, and a fixed count removes all formatting discretion.

---

## 6. Reward amount

D26 fixes the wire rule: fractional-looking quantities travel as base-unit integer
strings, never JSON numbers. BACKLOG leaves `bounties.reward_amount` as `numeric` with
no scale. This section decides the wire form and the column together so they cannot
drift.

### 6.1 Accepted form

`reward_amount` is a string of ASCII digits (U+0030 to U+0039) and nothing else:

- no sign, no separators, no exponent marker, no whitespace, no full stop;
- no leading zeros — the first digit is nonzero;
- minimum value 1: zero is rejected. A bounty that escrows nothing is not a bounty,
  and the program's zero-amount rejection (SECURITY.md section 8) is this rule's
  on-chain twin;
- maximum value 18446744073709551615, the largest unsigned 64-bit integer: the escrow
  amount is a u64, and a value the program cannot hold must fail at creation, not at
  funding.

Every other form — empty string, any sign, zero, leading zeros, non-digit characters,
values above the maximum — is `INVALID_REWARD_AMOUNT` (section 2.3).

The bound check must never pass the value through an IEEE-754 double: above 2 to the
power 53 a double rounds silently, so a corrupt value could pass a float comparison and
differ from the number funded. Session 7b compares with BigInt, or by digit-string
length and lexicographic order.

The unit is the base unit of `settlement_mint` — for USDC, one millionth. Nothing here
assumes six decimals: conversion to a display amount is the client's concern and
happens only at display (SECURITY.md section 14).

### 6.2 The column

`bounties.reward_amount` becomes `numeric(20, 0)` with a check constraint enforcing the
section 6.1 bounds — at least 1, at most 18446744073709551615 (migration prose, section
11). Twenty digits of precision hold the full u64 range; scale zero forbids fractional
storage at the type level.

Rejected alternatives: `bigint` tops out at 2 to the power 63 minus 1, half the u64
range, so the column would reject values the program accepts; `text` cannot order
numerically, and ordering for discovery is the one job this derived column has.

The column is a read-model copy (section 2.4), written once at creation from the policy
string. Neither the verifier nor any escrow code path reads it.

### 6.3 The path to the escrow

The value reaches the escrow unchanged by this route and no other:

1. the client sends the base-unit string; validation accepts or rejects, never edits;
2. the server places the exact string in the policy object, and the hash commits to
   it;
3. the funding transaction's u64 amount is parsed from the `reward_amount` of the
   client-verified policy object (section 3.5) — never from `bounties.reward_amount`,
   never from a separate response field, never from client UI state;
4. the program stores the amount in immutable bounty state, and every later transfer
   uses that stored value (SECURITY.md section 8: amounts never come from the client
   at transfer time).

No arithmetic occurs anywhere on this route: the fee is exactly the one-character
string `0` (D24), so the funded amount equals the reward amount and there is nothing to
add, split or round. Any response that carries an amount carries the same base-unit
string.

---

## 7. The bounty resource

### 7.1 What creation writes

The single `POST /bounties` transaction (section 8.3) inserts three kinds of row:

- **one `policies` row** — `canonical_json` (section 3.4), `policy_hash` (32-byte
  bytea, section 3.3), `requester_id`, `created_at`, and the read-model copies
  `required_assurance` and `eligibility_profile_id` (migration 7, section 11.3);
- **one `evidence_requirements` row per item** — `id` is the assigned uuid inside the
  hash (section 2.2), with `policy_id`, `type`, `required`, the prompt, and `sequence`
  holding the 1-based array position as a derived copy. The Session 3 `title` and
  `instructions` pair collapses to a single `prompt` column in the 7b migration
  (section 11): the hashed object has one prompt string, and two columns for it is a
  drift surface;
- **one `bounties` row** — `title`, `category`, `requester_id`, `policy_id`, `state`
  `DRAFT`, `program_account` null, `created_at`, the read-model copies
  `reward_amount` and `capture_radius_m`, `location` (exact PostGIS point from the
  policy `lat` and `lon`, D21), `location_public` (the snapped point, section 9),
  and the idempotency pair `idempotency_key` and `request_digest` (section 10).

The Session 3 columns `deadline` and `review_window_seconds` are dropped in the 7b
migration (section 11). The policy carries durations, not absolute times (section
2.1); an absolute deadline cannot exist before the transition that starts its window,
and a NOT NULL deadline at creation would force the server to invent one — the
Session 4 fee-constant incident as a column.

### 7.2 States

`bounty_state` keeps all thirteen values; the enum is not narrowed (D56). Session 7 code
produces exactly two: `DRAFT`, and `CANCELLED` for an unfunded bounty.

The mapping below is normative (D97). The database tracks confirmed chain state (D79). Apart
from `DRAFT` and unfunded `CANCELLED`, every value is written only on confirmation of the named
transaction, never from voucher issuance, a database reservation, or a submission response
(SECURITY.md section 12). Session 15 reconciliation is the backstop that repairs missed or
inconsistent projections, not the mechanism by which the application discovers what happened
(D79).

| State | Produced by |
|---|---|
| `DRAFT` | creation (section 8.3) |
| `CANCELLED` | unfunded cancellation (section 8.7); or confirmed `cancel` of a funded bounty, |
| | with its transaction signature and `BountyCancelled` event recorded (D76) |
| `AVAILABLE` | confirmed `create_and_fund` with every binding agreeing (D79, D84) |
| `ACCEPTED` | confirmed `accept` (D79) |
| `SUBMITTED` | confirmed `submit_attestation` |
| `DISPUTED` | confirmed `reject`; the `decisions` row's `failed_requirement_id` matches the chain |
| `PAID` | confirmed `approve`, `release`, or `resolve` paying the Scout |
| `REFUNDED` | confirmed `expire_accepted`, or `resolve` refunding the requester |
| `EXPIRED` | confirmed `expire_unaccepted`; the account is closed, so its transaction signature |
| | and `BountyExpired` event are recorded, as for a funded cancellation |

An unfunded `CANCELLED` row has `program_account` null: no on-chain account was ever created,
there is no escrow to refund and nothing to reconcile. A funded cancellation ends `CANCELLED`,
not `REFUNDED` (D76, D97).

Retained without a producer and never written (D97); reads treat them as opaque display values:

- `FUNDED` — its use for a malformed funded bounty remains Session 15's (D77, D84).
- `IN_REVIEW` — the same chain state as `SUBMITTED`; the review window is derived from
  `submitted_at` and `review_window_secs`.
- `APPROVED`, `REJECTED` — each is confirmed in the same transaction as `PAID` or `DISPUTED`, so
  no confirmed chain state corresponds to it.

Where each producer's code path ships is informative, recorded so a later session's claim to a
value is checked against a written plan rather than memory:

| State | Code path expected in (informative) |
|---|---|
| `AVAILABLE` | Session 17, P1: the funding projection (section 15) |
| `ACCEPTED` | Session 11 |
| `SUBMITTED` | Session 13 — evidence upload and submission |
| `DISPUTED`, `PAID`, `REFUNDED` | Session 22, P6: the settlement projection (section 20) |
| `EXPIRED` | not yet scheduled |
| funded `CANCELLED` | not yet scheduled |

Decided now, so nobody reads a scheduling conflict into the table: Session 11's
assignment race test targets the `assignments` unique partial index, not the funding
path, so it seeds an `AVAILABLE` bounty by direct SQL — exactly as the section 8
tests seed states no API can yet produce. Session 11 owns that seeding. The
`AVAILABLE` projection through the API arrives with the funding confirmation path
(D79); no session before that path depends on the API producing `AVAILABLE`.

### 7.3 Discoverability

**An unfunded bounty is never discoverable.** D79 narrows the set further: a bounty
is discoverable exactly when its `bounty_state` is `AVAILABLE` and no `assignments`
row for it has `status = 'ACTIVE'`. That conjunction is the complete rule. A
reservation is expired when its row no longer holds `status = 'ACTIVE'` — the status
flip, never a timestamp comparison in the discovery query. The query therefore never
excludes a bounty the Session 3 unique partial index would admit: discovery and
reservation cannot disagree about whether a reservation has expired, and concurrent
claims are still resolved by the index. The flip's timestamp source, writer and lag
bound are owed by the voucher-issuance session (section 14).

The rule is enforced in the discovery query (section 8.4) — in SQL, not in
serialisation and not in the client; widening the set again is an amendment by the
session whose transition justifies it. Until voucher issuance ships, nothing writes
an `ACTIVE` reservation, so the reservation conjunct is unenforced against live
data. Since Session 7 code cannot produce `AVAILABLE`, discovery over real data
returns an empty list, and the section 12 tests seed states directly to prove both
directions: an `AVAILABLE` row appears, and `DRAFT` and `CANCELLED` rows are absent.

The conjunction governs discovery only: single-bounty reads by id do not apply it — a
caller holding the id learns nothing from a reservation's existence, and a reserved
bounty remains readable by id (section 8.5). `DRAFT` and `CANCELLED` rows are visible
to their requester only, and to anyone else they are `NOT_FOUND` — indistinguishable
from absence, so an id leak does not become an existence oracle (section 8.5).

---

## 8. Endpoints

### 8.1 Common rules

**Auth.** Every endpoint in this document requires `Authorization: Bearer <JWT>`. The
middleware is `GET /auth/me`'s verification, unchanged (AUTH.md sections 5.3 and 9):
HS256 only, `iss` and `aud` checked, 60-second tolerance; failures are
`TOKEN_MISSING`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, all 401. On success the middleware
places the token subject's user id and wallet address on the request; handlers read
the caller's identity from there and nowhere else.

**Errors.** The shape is AUTH.md section 7's: a JSON object whose single key `error`
holds the code string, with the HTTP status shown in the tables. One code per
distinct failure. Every code is returnable and has at least one section 12 test;
where no API path can yet produce the state that triggers a code, the test seeds that
state by direct SQL, so the D34 no-unreachable-codes rule holds through the tests.

**Check orders.** Numbered and normative; the first failing step wins and its code is
returned; no later step runs.

**Configuration.** Three keys join AUTH.md's, same startup rule — read once at
startup, and the process exits non-zero before listening if a required value is
missing or malformed:

| Key | Rule |
|---|---|
| `SOLANA_CLUSTER` | optional; default `devnet`; the policy `cluster` value |
| `SETTLEMENT_MINT` | required; base58 for exactly 32 bytes; no default |

`ATTESTER_PUBKEYS` is gone (D82). The attester is the key in the immutable on-chain
configuration account, so the API neither reads nor validates an attester at startup.
The variable may remain set in an environment without effect; nothing consults it.
No default for `SETTLEMENT_MINT`: a wrong-environment mint must fail at startup, not
create policies against the wrong token.

**Clock.** Any timestamp the API writes or compares comes from the one injectable
clock (AUTH.md section 8). Session 7 adds no expiry predicates.

### 8.2 The two views

A bounty is serialised in one of two views, chosen by who is asking. Nothing else is
ever serialised from a bounty row.

**Owner view** — the bounty's requester only:

| Key | Value |
|---|---|
| `id`, `title`, `category`, `state` | bounty row |
| `program_account` | bounty row; null throughout Session 7 |
| `created_at` | bounty row |
| `policy_hash` | lowercase 64-character hex (section 3.3) |
| `policy` | the full sixteen-field object, exactly as hashed |

`policy` is byte-faithful: it is produced by parsing the stored `canonical_json`
(section 3.4), never by re-assembling from columns, so what the owner verifies
(section 3.5) is what was hashed.

Section 18.7 adds `submission` to the owner view of a bounty in state `ACCEPTED` (D138).

**Public view** — any other authenticated caller, for states that are visible at all
(section 7.3):

| Key | Value |
|---|---|
| `id`, `title`, `category`, `state`, `created_at` | bounty row |
| `policy_hash` | lowercase hex, as above |
| `location_public` | object with `lat` and `lon`, the snapped strings (section 9) |
| `policy_public` | the policy minus `lat`, `lon`, `salt`, and every requirement `id` |

`policy_public` is the parsed policy object with exactly those removals — thirteen
top-level fields, and requirement items of `prompt`, `required`, `type`. It is
deliberately not canonicalisable to `policy_hash`, and no consumer may hash it; the
hash is verified only ever against the full object, which non-requesters do not hold
before acceptance (section 9.4). The withheld values — exact coordinates, the salt
and the requirement ids — are the section 9 privacy material, and their absence from
every public response is tested (section 12).

**List item view** — used by both list endpoints, one shape:

| Key | Value |
|---|---|
| `id`, `title`, `category`, `state`, `created_at` | bounty row |
| `reward_amount` | base-unit string, from the read-model column |
| `required_assurance` | integer 0 to 4, from the read-model column (D65) |
| `location_public` | as above |

Lists never carry policies or requirement data; the detail endpoint does.

Section 16.4 adds `program_account` to the public view and defines a third view,
the assigned-Scout view (D127).

### 8.3 `POST /bounties`

Creates the policy and the bounty in one database transaction and returns the owner
view. The body is a JSON object with exactly four keys:

| Key | Type | Rule |
|---|---|---|
| `idempotency_key` | string | uuid, lowercase hyphenated form (section 10) |
| `title` | string | 1 to 120 UTF-16 code units |
| `category` | string | 1 to 50 UTF-16 code units; taxonomy open, section 14 |
| `policy` | object | the request-source fields of section 2.1, and nothing else |

`policy` carries exactly the fields whose source is request or request-optional:
`acceptance_window_seconds`, `capture_radius_m`, `challenge_window_seconds`,
`completion_window_seconds`, `eligibility_profile_id`, `evidence_requirements`,
`lat`, `lon`, `required_assurance`, `reward_amount`, and optionally `cluster` and
`settlement_mint`. `challenge_window_seconds` is the review window (section 2.1
mapping note). A constant or assigned field in the request — `chain`,
`domain_tag`, `fee_amount`, `salt`, a requirement `id` — is an unknown field.

Check order:

1. **Auth.** The middleware; 401 codes per section 8.1.
2. **Body shape.** A JSON object with exactly the four keys; `idempotency_key` in
   uuid form; every field of `policy` present, known and correctly typed per section
   2.3's type rules. Failure: `INVALID_REQUEST` (400).
3. **Title.** Length bounds. Failure: `INVALID_TITLE` (400).
4. **Category.** Length bounds. Failure: `INVALID_CATEGORY` (400).
5. **Policy field rules**, in the canonical field order of section 2.1; each failure
   returns its own section 2.3 code (400).
6. **Requirement rules** per section 2.2; codes per section 2.3 (400). The list bound —
   1 to 20 items — is the section 2.1 field rule for `evidence_requirements` and was
   already checked at step 5, in canonical field position. This step checks the items,
   item index ascending, keys in canonical order within each item: the `prompt` bounds,
   then the `type` value. `required` carries no per-item rule here — a non-boolean
   `required` is a step 2 type failure (`INVALID_REQUEST`) — so its only step 6 rule is
   list-level: the at-least-one-`required`-true check, run last, after every per-item
   check.
7. **Build and hash.** Inject the constants and configured defaults, assign the salt
   and fresh requirement uuids, canonicalise the sixteen-field object and hash it
   (section 3);
   canonicalise the full four-key request body and hash that as `request_digest`
   (section 10.2). A `SpecError` from either canonicalisation: `INVALID_REQUEST`
   (400).
8. **Idempotency** (section 10.3). Read the caller's row for `idempotency_key`. Found
   with equal `request_digest`: respond 201 with the stored bounty's owner view — the
   step 7 build is discarded. Found with different digest: `IDEMPOTENCY_KEY_REUSED`
   (409), nothing written.
9. **Transaction.** Insert the `policies` row, the `evidence_requirements` rows and
   the `bounties` row (section 7.1). A unique violation on the idempotency index —
   a concurrent duplicate — aborts the transaction; re-read the winner's row and
   apply step 8's two outcomes.
10. **Respond** 201 with the owner view.

Validation failure at steps 2 to 7 stores nothing: the key is not consumed, and a
corrected body may retry under the same key (section 10.3).

### 8.4 `GET /bounties` — discovery

Returns discoverable bounties (section 7.3) near a point, as list items. Query
parameters:

| Parameter | Rule |
|---|---|
| `lat`, `lon` | required; the section 5 profile and ranges |
| `radius_m` | required; integer, 100 to 50000 inclusive |
| `limit` | optional; integer, 1 to 100; default 20 |
| `offset` | optional; integer, 0 or more; default 0 |

Check order:

1. **Auth**; 401 codes.
2. **Parameter shape.** Unknown parameters, missing required parameters, a
   non-integer `radius_m`, `limit` or `offset`, or `limit` or `offset` outside their
   bounds: `INVALID_REQUEST` (400). Integer form is a string check run before any
   numeric parse: ASCII digits only (U+0030 to U+0039), no sign, no leading zeros
   (the single digit `0` is allowed), and at most nine digits. The length bound
   keeps every accepted numeral inside safe integer range — a 40-digit `offset` is
   a form failure at this step, never a value a double has rounded (section 6.1's
   no-doubles rule applied at the query boundary).
3. **Coordinates.** `lat` and `lon` against the section 5 rules: `INVALID_GPS` (400).
4. **Radius.** Bounds: `INVALID_QUERY_RADIUS` (400).
5. **Query.** Rows with `state` in the discoverable set — exactly `AVAILABLE` —
   within `radius_m` metres of the query point, measured against `location_public`
   only; ordered by distance to `location_public` ascending, then `created_at`
   descending, then `id` ascending. The last key makes the order total — offset
   pagination requires one; equal distances and equal timestamps cannot reorder
   rows between pages. The query point is the caller's own and is not snapped; it
   commits the caller's location to nothing.
6. **Respond** 200 with an object whose single key `bounties` holds the list items.

Distance is computed inside the query for filtering and ordering and never appears in
the response (section 9.3). The bounty's exact `location` column appears in no
discovery predicate, no ordering and no output.

The radius and pagination bounds are provisional product values, same status as the
section 2.1 window bounds.

Section 16.3 adds the acceptance-cutoff conjunct to step 5 (D126). Section 16.11
governs how the request is logged.

### 8.5 `GET /bounties/:id`

Check order:

1. **Auth**; 401 codes.
2. **Id form.** `:id` must be a lowercase hyphenated uuid; anything else is
   `NOT_FOUND` (404) — a malformed id and an absent row are deliberately
   indistinguishable.
3. **Load.** No row: `NOT_FOUND` (404).
4. **Owner.** Caller is the bounty's requester: 200, owner view — every state,
   including `DRAFT` and `CANCELLED`.
5. **Others.** State `DRAFT` or `CANCELLED`: `NOT_FOUND` (404), per section 7.3.
   Any other state: 200, public view. (No such state is producible by Session 7
   code; the test seeds one by SQL.)

Section 16.4 inserts step 4a, the assigned-Scout view (D127); section 17.7 adds its
`capture` key.

### 8.6 `GET /me/bounties`

The caller's own bounties, all states, newest first.

1. **Auth**; 401 codes.
2. **Parameters.** `limit` and `offset` as in section 8.4; unknown parameters
   `INVALID_REQUEST` (400).
3. **Query.** Rows with the caller as requester, ordered by `created_at` descending
   then `id` ascending — the section 8.4 tie-break, because offset pagination needs
   a total order (D63); respond 200 with `bounties` holding list items.

The route is `GET /me/bounties`, not `GET /bounties/mine`: `mine` would be captured
by the `:id` segment of section 8.5, and a route whose reachability depends on
registration order is a bug waiting for a refactor.

### 8.7 `POST /bounties/:id/cancel`

Soft-cancels an unfunded bounty (sections 4 and 7.2). No idempotency key: the
operation is idempotent by state (section 10.4). No request body (step 2).

1. **Auth**; 401 codes.
2. **Body.** Any present request body is `INVALID_REQUEST` (400) — an empty JSON
   object included: the rule is body presence on the wire, not object contents
   (D66). Runs before the id form check.
3. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
4. **Load.** No row: `NOT_FOUND` (404).
5. **Caller.** Not the requester: `NOT_FOUND` (404) if the state is `DRAFT` or
   `CANCELLED` (hidden, section 7.3); `FORBIDDEN` (403) otherwise — the caller can
   see the bounty but cannot cancel it. (The 403 arm is unreachable through Session
   7 APIs; the test seeds the state by SQL.)
6. **Already cancelled.** State `CANCELLED`: 200 with the owner view. A retry of a
   cancel is a success, not a conflict.
7. **Cancel.** State `DRAFT`: one conditional update — set `state` to `CANCELLED`
   where the id, the requester and `state = 'DRAFT'` all match, returning the row.
   Zero rows returned means a concurrent transition won; reload once and re-apply
   steps 6 to 8 — a second zero-row result falsifies the 7.2 state machine and
   surfaces as an error, never a retry (D66). On success: 200, owner view.
8. **Anything else.** `BOUNTY_NOT_CANCELLABLE` (409). Funded-state cancellation is
   Session 9's (section 7.2). (Unreachable through Session 7 APIs; seeded by SQL in
   the test.)

Section 15.6 inserts a chain read between steps 6 and 7 for a `DRAFT` bounty (D120).

The policy row and the requirement rows are untouched: cancellation is a bounty
state change, never a deletion (section 4).

### 8.8 Error codes new in this document

The complete Session 7 surface is: the three middleware codes (AUTH.md section 7),
the thirteen section 2.3 policy codes, and these seven:

| Code | Status | Failure |
|---|---|---|
| `INVALID_TITLE` | 400 | `title` empty or over 120 UTF-16 code units |
| `INVALID_CATEGORY` | 400 | `category` empty or over 50 UTF-16 code units |
| `INVALID_QUERY_RADIUS` | 400 | `radius_m` integer but outside 100 to 50000 |
| `NOT_FOUND` | 404 | no bounty visible to the caller at the id (section 8.5) |
| `FORBIDDEN` | 403 | bounty visible but the caller lacks the right |
| `BOUNTY_NOT_CANCELLABLE` | 409 | state admits no cancellation (section 8.7) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key, different `request_digest` (section 10) |

Section 15.7 adds two codes for funding; section 16.9 adds two for acceptance; section 17.10
adds five for the capture nonce.

---

## 9. Location approximation

Exact bounty coordinates are disclosed before acceptance to no one but the requester.
What everyone else sees is specified numerically here. SECURITY.md section 11's
warning — a hash of guessable coordinates is not anonymous — is the load-bearing
constraint; section 9.4 works it through.

### 9.1 The snap

The public point is a deterministic grid snap of the policy coordinates, computed in
scaled integers — never floating point:

1. **Scale.** Convert the profile string (section 5) to a signed integer count of
   ten-millionths of a degree: remove the full stop and parse the remaining signed
   digits. Exact by construction — the profile fixes seven fraction digits.
2. **Cell.** Divide by 100000 with floor division — rounding toward negative
   infinity, so a scaled value of -1 lands in cell -1, not cell 0. Cells are 0.01
   degrees: about 1.11 km of latitude; a longitude cell narrows toward the poles by
   the cosine of the latitude.
3. **Clamp.** Latitude cell into -9000 to 8999 inclusive; longitude cell into
   -18000 to 17999 inclusive. The extremes snap inward: latitude `90.0000000` gives
   cell 9000, clamped to 8999.
4. **Centre.** The snapped scaled value is the cell times 100000, plus 50000.
5. **Render** the scaled value back to a section 5 profile string: sign if strictly
   negative, integer part, full stop, seven fraction digits. The centre is never
   zero, so negative zero cannot arise.

Worked: latitude `90.0000000` scales to 900000000, cell 9000 clamps to 8999, centre
899950000, rendered `89.9950000`. Longitude `-180.0000000` scales to -1800000000,
cell -18000 (in range), centre -1799950000, rendered `-179.9950000`.

The snapped pair is written once at creation to `bounties.location_public` (PostGIS
geography with a GIST index, D21; migration in section 11) and is the only location
data any non-requester response or query predicate ever touches.

How coordinates enter the column: PostGIS geography stores coordinates as float8
pairs, so choosing the column type chose float8 storage — every entry path
(`ST_MakePoint`, WKT, EWKB) lands there, and the scaled-integer rule above governs
the snap computation, not the storage format. The entry is safe by arithmetic: a
profile string carries at most ten significant digits, and decimal text round-trips
exactly through float8 up to fifteen, so the stored double is the unique float8 for
the rendered string. In the other direction the rule is a prohibition: no code path
may render coordinates back out of a geography column — string coordinates are
produced only by the section 5 profile check and the snap above, from the policy
`lat` and `lon`. The column may feed PostGIS distance internals (section 8.4) and
nothing else. A read-back would reintroduce floating point into a value whose whole
point is exactness, and it would do so silently: the first fifteen digits agree, so
no test that compares rendered strings would catch the substitution.

### 9.2 Deterministic, no jitter

The same input snaps to the same output, forever, so repeated queries reveal nothing
beyond the cell. Random jitter was rejected: jitter re-drawn per response averages
away under repeated sampling, and jitter drawn once per bounty adds nothing over a
deterministic snap while requiring a stored secret offset. The snap discloses the
cell, states that it discloses the cell, and discloses nothing else.

One consequence is stated because a privacy reviewer asks it first: two bounties in
the same cell share the same centre, so an observer learns they are co-located to
within roughly a kilometre. That disclosure is accepted — approximate co-location is
what a location-based discovery feed exists to show.

### 9.3 No distance field

No response carries a server-computed distance, bearing or travel estimate involving
a bounty's exact location. Discovery distance (section 8.4) is computed against
`location_public` inside the query and discarded. A caller issuing many queries from
chosen points — trilateration — recovers at most the snapped point, which is already
disclosed in the response.

### 9.4 The preimage search, and the salt that blinds it

After funding, the policy hash is public on-chain, and the public view (section 8.2)
discloses every policy field except `lat`, `lon`, `salt` and the requirement ids.
Were the coordinates the only unknown, the hash would hide nothing: 100000 by 100000
candidate pairs per disclosed 0.01-degree cell — 10 to the power 10, about 2 to the
power 33 hashes — is trivial for one GPU, and exactly the SECURITY.md section 11
warning. Snapping alone protects nothing against the hash.

The stated mechanism is the `salt` field: 32 bytes from the injectable randomness
module, production-bound to `randomBytes` from `node:crypto` (section 2.1), sitting
inside the hashed object and undisclosed before acceptance. With the salt unknown
the preimage search faces at least 2 to the power 256 candidates whatever else is
public. The salt exists for this and nothing else — it identifies nothing, no
verifier logic reads it, and its normative rules are in the section 2.1 salt note:
CSPRNG source (tested), never client-supplied, never in any public view, list item,
error or log, disclosed with the rest of the policy after acceptance. The section 12
tests assert its absence from every public response.

The requirement ids stay withheld before acceptance as defence in depth. They exist
to identify requirements — in the database, in structured rejection, in evidence
binding — and identifiers get printed: a log line, an error message or a future
public preview that exposes one is an ordinary bug, not a broken cryptographic
property, precisely because the salt carries the property and the ids do not. The
non-disclosure rule stands so that such a leak stays a finding rather than a habit,
but nothing structural rests on it.

After acceptance the assigned Scout needs the exact location and the full policy —
salt and ids included — to do the work and to verify the hash. That disclosure
belongs to the acceptance flow (Sessions 8 and 11), which inherits this rule: the
full policy object goes only ever to the requester and the assigned Scout.

---

## 10. Idempotency

`POST /bounties` moves money eventually; a retried create must not make two bounties.

### 10.1 The key

`idempotency_key` is a body field: a uuid in lowercase hyphenated form, generated by
the client, fresh per create intent, reused on retry of the same intent. It is
scoped per requester by a unique index on the pair of `requester_id` and
`idempotency_key` (section 11); two requesters using the same key never collide.

### 10.2 The digest

`request_digest` is `sha256` over the UTF-8 encoding of `canonicalise` applied to
the entire four-key request body. Canonical form rather than raw received bytes,
deliberately: JSON key order and whitespace are transport noise, so a retry
serialised differently by a different HTTP client still replays instead of failing
with a 409 over bytes that mean the same thing. Both functions are the
`packages/shared` exports (section 3.1); the digest is stored as a 32-byte bytea
beside the key on the bounty row.

### 10.3 Behaviour

| Situation | Outcome |
|---|---|
| first use, validation passes | 201; the row stores the key and digest |
| any validation failure (steps 2 to 7) | error; nothing stored; the key is not consumed |
| same key, equal digest | 201 replay: the stored bounty, owner view |
| same key, different digest | 409 `IDEMPOTENCY_KEY_REUSED`; nothing written |
| concurrent, same key | one insert wins; the loser re-reads and takes a row above |

A replay returns the stored bounty as it now is: the ids, the policy and the hash
are identical to the original response; the state may have moved on (a replayed
create of a since-cancelled bounty returns it as `CANCELLED`). The status is 201 on
replay, deliberately: create is idempotent, and a client cannot and need not
distinguish the original response from a replay.

Keys never expire: bounty rows are never deleted (section 4), so a key, once
consumed by a successful create, refers to that bounty forever. Cancelling the
bounty does not free its key. Consumed keys therefore accumulate without bound —
accepted for the MVP, recorded in section 14 as a production retention item under
SECURITY-PRODUCTION.md section 5 (evidence lifecycle).

### 10.4 Cancel needs no key

Cancellation is idempotent by state (section 8.7): the conditional update fires at
most once, and a retry lands in the already-cancelled arm and succeeds with the same
terminal state. A key would add a second idempotency mechanism to an operation that
already has one.

---

## 11. Migrations — prose

Three migrations, numbered 5, 6 and 7, continuing the existing four. Prose here; code
in Session 7b. Every table touched is empty in every environment — no code before
Session 7b writes `policies`, `evidence_requirements`, or `bounties` — so no data
movement arises, and rollbacks that re-add NOT NULL columns are valid for exactly as
long as the tables stay empty (section 11.4). The
verification pattern is Session 6b's: apply all three and roll back all three on a scratch
database in one test whose summary must read exactly `tests 1, pass 1, fail 0`, then
apply for real and verify the shapes with `\d` against `bountycam_dev` from raw
`psql` output.

### 11.1 Migration 5 — policies and evidence requirements

Forward:

1. On `policies`, add a named check constraint: the octet length of `policy_hash` is
   exactly 32 (section 3.3 — the column stores the raw digest, nothing else).
2. On `evidence_requirements`, rename `title` to `prompt`. The hashed object has one
   prompt string (section 2.2); the column takes its name.
3. On `evidence_requirements`, drop `instructions`. Two prose columns for one hashed
   string is a drift surface (section 7.1).

Rollback, in reverse: re-add `instructions` with its Session 3 definition, rename
`prompt` back to `title`, drop the check constraint.

### 11.2 Migration 6 — bounties

Forward:

1. Change `reward_amount` to `numeric(20, 0)` and add a named check constraint:
   at least 1 and at most 18446744073709551615 (section 6.2).
2. Drop `deadline` and `review_window_seconds` (section 7.1: durations live in the
   policy; absolute deadlines cannot exist before the transitions that start them).
3. Add `location_public` as `geography(Point, 4326)`, NOT NULL, with a GIST index
   (D21) — the snapped point of section 9.1, and the only geography discovery may
   touch (section 8.4).
4. Add `idempotency_key` as uuid, NOT NULL, and `request_digest` as bytea, NOT NULL,
   with a named check constraint that the octet length of `request_digest` is
   exactly 32 (section 10.2).
5. Add a unique index on the pair `requester_id`, `idempotency_key` (section 10.1) —
   the constraint the section 8.3 step 9 race resolution relies on.

Rollback, in reverse: drop the unique index, the idempotency columns and their
check; drop the GIST index and `location_public`; re-add `review_window_seconds` and
`deadline` with their Session 3 definitions; drop the reward check and return
`reward_amount` to unconstrained `numeric`.

The existing `location` column (exact point) and every other column are untouched.
`policies.canonical_json` is not touched by any migration, ever (section 3.4).

### 11.3 Migration 7 — the policy read-model column

Up: on `policies`, drop `attester_pubkey` and add `eligibility_profile_id text NOT
NULL`. Down: the reverse. Both are read-model copies of a hashed field, never
authoritative — the canonical text is (section 2.4) — so neither carries a constraint
beyond NOT NULL, and a value disagreeing with the canonical text is a bug in creation,
not a state the column is expected to police.

The rollback is subject to section 11.4: re-adding `attester_pubkey` as NOT NULL
without a default fails once a single row exists.

### 11.4 Rollback validity expires with the first data

All three rollbacks are valid **only against empty tables**, and all three are
affected: migration 7's rollback re-adds `attester_pubkey` as `text NOT NULL`,
migration 5's rollback re-adds `instructions` as `text NOT NULL`, and migration 6's
rollback re-adds `deadline` as `timestamptz NOT NULL` and `review_window_seconds` as
`integer NOT NULL` — the Session 3 definitions. Re-adding a NOT NULL column without
a default cannot succeed once a single row exists; the statement fails, and the
rollback with it.

That is fine at 7b, where the scratch test and any real rollback run against empty
tables. It stops being fine the moment Session 7b's endpoints write the first row.
From then on, rolling back 5 or 6 requires a data-preserving down migration written
at that time — one that decides what value the re-added columns take for existing
rows — and the shipped rollbacks must be treated as documentation of the reverse
shape, not as runnable escape hatches. Recorded here so the assumption expires
loudly instead of in week three.

---

## 12. Tests

Runner and rules are Session 6b's: `node:test` against a scratch database, test
files named explicitly in the test script (D36), the injectable clock, and — new in
this session — the injectable randomness module (section 2.1) with deterministic
doubles. The D36 gate: **the suite passes only if the summary reads exactly
`tests 76, pass 76, fail 0`**, and the migration scratch test reads exactly
`tests 1, pass 1, fail 0`. A green banner with any other count is a failure. 76 is
the Session 7b shipped count: tests 77 and 78 have no implementation yet, and the
expected count becomes 78 in the session that writes them.

Where a test needs a state no Session 7 API can produce (`AVAILABLE`, `FUNDED`), it
seeds the row by direct SQL (sections 7.2, 8.1).

Middleware:

1. `POST /bounties` without an Authorization header — 401 `TOKEN_MISSING`.
2. Tampered token signature — 401 `TOKEN_INVALID`.
3. Token expired beyond the 60-second tolerance — 401 `TOKEN_EXPIRED`.
4. Each of the other four endpoints without a token — 401 `TOKEN_MISSING`.

Create — success and invariants:

5. Valid create — 201 owner view; the policy has exactly sixteen fields;
   re-canonicalising the returned policy reproduces `policy_hash` (the section 3.5
   client check, exercised in test).
6. Stored `canonical_json`: `sha256` over its UTF-8 bytes equals `policy_hash`
   (section 3.4, first invariant).
7. Parsing `canonical_json` and re-canonicalising reproduces the stored text byte
   for byte (section 3.4, second invariant).
8. Rows per section 7.1: requirement rows with `prompt` and `sequence` equal to
   array position; bounty `DRAFT`; `program_account` null; the `reward_amount`
   column equals the policy string; `policies.required_assurance` equals the
   policy integer (D65).
9. `location` is the exact point; `location_public` equals the section 9.1 snap of
   the same coordinates.
10. The salt is exactly 64 lowercase hex characters and equals the injected
    randomness double's output — the source test (section 2.1). Two further
    asserts in the same test: a failed create's error body is exactly the
    one-key `error` object, and the injected salt's hex appears nowhere in log
    output captured across one successful and one failed create with logging
    enabled — the D54 never-in-error-or-log clause, tested (sections 2.1, 9.4).
11. Each requirement id is a lowercase version 4 uuid and equals the injected
    double's output — the source test (section 2.2).
12. `cluster` and `settlement_mint` absent — the configured values appear in the
    returned policy.
13. `cluster` and `settlement_mint` present and equal to the configured values —
    201.

Create — body shape (`INVALID_REQUEST`, 400):

14. Body not a JSON object.
15. A missing top-level key.
16. An unknown top-level key.
17. `idempotency_key` not in uuid form.
18. `policy` missing a required field.
19. `policy` with an unknown field.
20. A constant or assigned field present in the request: `fee_amount`, `salt`, and
    a requirement `id` (three asserts).
21. An integer field mistyped: as a digit string and as a fraction (two asserts).
22. A lone surrogate in a prompt — `SpecError` surfaces as `INVALID_REQUEST`.

Create — field rules (400, one code each):

23. `required_assurance` -1 and 5 — `INVALID_ASSURANCE`.
24. `eligibility_profile_id` syntactically valid but not in the section 2.5 registry —
    `PROFILE_UNKNOWN`. A well-formed id outside the table is the case that matters; a
    malformed id is a section 2.3 type failure and is covered by test 21.
25. Each inadmissible pair of `required_assurance` and profile — assurance 4 with
    `BASE_V1`, and assurance 0 and 3 with `A4_SEEKER_V1` —
    `PROFILE_ASSURANCE_MISMATCH`. Both lawful pairs create successfully.
26. `cluster` present, not the configured value — `CLUSTER_NOT_ALLOWED`.
27. `settlement_mint` present, not the configured value — `MINT_NOT_ALLOWED`.
28. `capture_radius_m` 9 and 10001 — `INVALID_CAPTURE_RADIUS`.
29. Each of the three windows below its minimum and above its maximum —
    `INVALID_WINDOW` (six asserts).
30. `reward_amount` the string `0` — `INVALID_REWARD_AMOUNT`.
31. `reward_amount` with a leading zero — `INVALID_REWARD_AMOUNT`.
32. `reward_amount` with a sign, a full stop, an exponent marker, a non-digit —
    `INVALID_REWARD_AMOUNT` (four asserts).
33. `reward_amount` at the u64 maximum — 201, stored exactly; one above it —
    `INVALID_REWARD_AMOUNT`. The pair a double-based comparison cannot tell apart.
34. GPS alphabet violations: a non-ASCII digit, a plus sign, whitespace —
    `INVALID_GPS`.
35. Negative zero and a misplaced sign — `INVALID_GPS`.
36. A leading zero in the integer part — `INVALID_GPS`.
37. Six and eight fraction digits — `INVALID_GPS`.
38. A missing and a doubled full stop — `INVALID_GPS`.
39. `lat` beyond 90 and `lon` beyond 180 — `INVALID_GPS`; all four extremes of
    section 5 rule 7 — 201.
40. Requirements empty and at 21 items — `INVALID_REQUIREMENTS`.
41. No requirement with `required` true — `INVALID_REQUIREMENTS`.
42. A requirement `type` other than `PHOTO` — `REQUIREMENT_TYPE_NOT_ALLOWED`.
43. A prompt empty and at 501 code units — `INVALID_REQUIREMENT_PROMPT`.
44. `title` empty and at 121 code units — `INVALID_TITLE`.
45. `category` empty and at 51 code units — `INVALID_CATEGORY`.

Idempotency:

46. Same key, same body, sequential — second response 201 with identical id, policy
    and hash; exactly one bounty row.
47. Same key, different body — 409 `IDEMPOTENCY_KEY_REUSED`; nothing written.
48. Two concurrent creates with one key via `Promise.all`, against a pool asserted
    to allow at least 2 connections — exactly one bounty row; both responses 201
    with the same id.
49. A failed validation does not consume the key: 400, then 201 with the same key
    and a corrected body.
50. The same body re-serialised with different JSON key order — 201 replay (the
    digest is over canonical form, section 10.2).

Discovery:

51. A seeded `AVAILABLE` bounty within the radius is returned; with two seeded rows
    the order is distance ascending.
52. `DRAFT` and `CANCELLED` rows within the radius are absent — unfunded is never
    discoverable (section 7.3).
53. An `AVAILABLE` row outside the radius is absent.
54. List items contain no exact coordinates, no salt, no requirement id and no
    distance field (sections 8.2, 9.3, 9.4). The property: the salt value and
    each requirement uuid appear nowhere in the serialised response body, under
    any key, at any depth. The test asserts it by scanning the whole body for
    the known injected values from the randomness double; whatever replaces the
    double must still supply the values to scan for.
55. Parameter failures: missing `lat` — `INVALID_REQUEST`; malformed `lon` —
    `INVALID_GPS`; `radius_m` 99 and 50001 — `INVALID_QUERY_RADIUS`; `limit` 0 and
    101 — `INVALID_REQUEST`.
56. `limit` and `offset` produce a deterministic slice of the section 8.4 ordering.

Detail:

57. Owner reads own `DRAFT` — 200 owner view; salt and requirement ids present.
58. A non-requester reads a `DRAFT` — 404 `NOT_FOUND`.
59. A non-requester reads a seeded `AVAILABLE` — 200 public view: no `lat`, no
    `lon`, no salt, no requirement ids; `policy_public` has exactly thirteen
    top-level fields; `location_public` present. Same whole-body property as
    test 54: the salt value and each requirement uuid appear nowhere in the
    serialised response body, under any key, at any depth, asserted by scanning
    for the known injected values.
60. A malformed id and an absent uuid — both 404 with identical bodies.
61. Owner reads own `CANCELLED` — 200; a non-requester — 404.

`GET /me/bounties`:

62. Returns only the caller's bounties, every state, newest first.
63. An unknown query parameter — `INVALID_REQUEST`.

Cancel:

64. Owner cancels a `DRAFT` — 200 `CANCELLED`; the policy row, requirement rows and
    `canonical_json` are byte-identical before and after.
65. Cancel again — 200, same terminal state (idempotent by state).
66. A non-owner cancels a `DRAFT` — 404 `NOT_FOUND`.
67. A non-owner cancels a seeded `AVAILABLE` — 403 `FORBIDDEN`.
68. Owner cancels a seeded `FUNDED` — 409 `BOUNTY_NOT_CANCELLABLE`.
69. A non-empty request body — 400 `INVALID_REQUEST`; an empty JSON object is a
    present body and fails identically (step 2, before the id form check).

Configuration:

70. Missing `SETTLEMENT_MINT` — the process exits non-zero before listening.
71. `ATTESTER_PUBKEYS` present in the environment — ignored (D82). The process
    starts, and a policy created afterwards carries no attester field.
72. `SOLANA_CLUSTER` absent — a created policy carries `devnet`.

Snap unit tests:

73. The section 9.1 worked examples and the V3 rows reproduce, plus the positive
    longitude clamp extreme `180.0000000` to `179.9950000` — not in V3, computed
    and verified by the Session 7b test run. The clamp moves only the two
    positive extremes; `-180.0000000` is exact, its cell already in range.
74. `-0.0000001` snaps to centre `-0.0050000` — floor division, not truncation.
75. Snap output always passes the section 5 form rules, and the same input twice
    gives identical output.

Middleware unit test — no database, no app boot, like 73 to 75:

76. `authUser()` on a request that did not pass `requireAuth` throws. The
    accessor's wiring-bug guard: a route registered without the preHandler
    fails closed at first read, not silently with an undefined identity.

Discovery, reservation exclusion (section 7.3):

77. An `AVAILABLE` bounty with a seeded `assignments` row at `status = 'ACTIVE'` is
    absent from discovery — reserved is never discoverable. Migration 12 dropped
    `challenge_nonce` (D131); the seeded row sets no nonce.
78. The same bounty with the row flipped to `EXPIRED` is returned — the flip, not a
    timestamp, restores discoverability (section 14 item 6).

---

## 13. Worked vectors

Computed live during Session 7a by calling the built `packages/shared` (the Session
5 implementation, `dist/index.js`), from raw terminal output. Each hash was then
recomputed by two independent routes: `createHash` from `node:crypto` over the same
bytes in-process, and `shasum -a 256` over the canonical text written byte-exactly
to a file — a different hash implementation in a different process. All three agree
for both vectors. Session 7b's tests 5 to 7 must reproduce these values.

**Superseded and regenerated (D108).** V1 and V2 below are not the values Session 7a
published. D82 removed `attester_pubkey` from the policy and D84 added
`eligibility_profile_id`, so the hashed object changed shape and both vectors changed
with it. The Session 7a values were V1 `60b987301f7731a32c6de0ec871fae6e2e6f30dc99e2d1b
202ca267d408591ea` over 624 bytes and V2 `2dec8d20e7e49d2a4be1c3c67d6866a6cd77bcf8cf8b6
82847bc5a57e55d8a60` over 567 bytes, both shown wrapped here as elsewhere in this
section. They are recorded so a reader who saw them can tell what happened, and they
are not a compatibility surface: no bounty was ever funded against either, and no
second implementation ever verified them. `MESSAGES.md` vectors are on the signed path
and keep their immutability rule unchanged (its section 8).

The values below were derived while D108 was written, by replaying the published
Session 7a texts to confirm they reproduce the published hashes, then applying the
field change — and then verified on 20 September against the built
`packages/shared` by all three routes. That verification also re-canonicalised each
parsed object and confirmed it reproduces the text below byte for byte, so the wrap
is display-only and the key order is canonical.

Canonical texts below are single lines with no line breaks, shown wrapped at 88
characters (D31 — the wrap is display only). Every character is printable ASCII, so
characters equal UTF-8 bytes and the text can be reconstructed by joining the lines
with nothing between them; the byte length and hash confirm the reconstruction.

### 13.1 Vector V1 — policy hash

The full sixteen-field policy object. The assigned values are fixed for the vector:
the salt is the 32 bytes 00 through 1f in order, hex-encoded; the requirement id is
a fixed uuid with valid version and variant nibbles. `settlement_mint` uses the
base58 string of 32 zero bytes — a syntactically valid 32-byte key; the vector
exercises canonicalisation and hashing, not the config allowlists. The profile is
`BASE_V1`, which is the admissible one for `required_assurance` 3 (section 2.5), so
the vector is internally consistent with the pairing rule. Input fields, in canonical
order:

| Field | Value |
|---|---|
| `acceptance_window_seconds` | 86400 |
| `capture_radius_m` | 50 |
| `chain` | `solana` |
| `challenge_window_seconds` | 3600 |
| `cluster` | `devnet` |
| `completion_window_seconds` | 7200 |
| `domain_tag` | `BOUNTYCAM_POLICY_V1` |
| `eligibility_profile_id` | `BASE_V1` |
| `evidence_requirements` | one item; see below |
| `fee_amount` | `0` |
| `lat` | `40.4405556` |
| `lon` | `-79.9961111` |
| `required_assurance` | 3 |
| `reward_amount` | `5000000` |
| `salt` | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| `settlement_mint` | `11111111111111111111111111111111` |

The single requirement: `id` `11111111-1111-4111-8111-111111111111`, `prompt`
`Storefront with signage visible`, `required` true, `type` `PHOTO`.

Canonical text — 606 characters, 606 UTF-8 bytes:

```
{"acceptance_window_seconds":86400,"capture_radius_m":50,"chain":"solana","challenge_win
dow_seconds":3600,"cluster":"devnet","completion_window_seconds":7200,"domain_tag":"BOUN
TYCAM_POLICY_V1","eligibility_profile_id":"BASE_V1","evidence_requirements":[{"id":"1111
1111-1111-4111-8111-111111111111","prompt":"Storefront with signage visible","required":
true,"type":"PHOTO"}],"fee_amount":"0","lat":"40.4405556","lon":"-79.9961111","required_
assurance":3,"reward_amount":"5000000","salt":"000102030405060708090a0b0c0d0e0f101112131
415161718191a1b1c1d1e1f","settlement_mint":"11111111111111111111111111111111"}
```

Policy hash, all three routes (verified 20 September, D108):

```
sha256 (packages/shared): 711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b
sha256 (node:crypto):     711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b
shasum -a 256:            711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b
```

### 13.2 Vector V2 — request digest

The four-key request body (section 8.3) that would create V1's bounty: `category`
`verification`, `idempotency_key` `22222222-2222-4222-8222-222222222222`, `title`
`Photograph the storefront`, and `policy` holding the twelve request-source fields —
no `chain`, no `domain_tag`, no `fee_amount`, no `salt`, and the requirement item
without `id`. The count is still twelve: `attester_pubkey` left and
`eligibility_profile_id` arrived.

Canonical text — 549 characters, 549 UTF-8 bytes:

```
{"category":"verification","idempotency_key":"22222222-2222-4222-8222-222222222222","pol
icy":{"acceptance_window_seconds":86400,"capture_radius_m":50,"challenge_window_seconds"
:3600,"cluster":"devnet","completion_window_seconds":7200,"eligibility_profile_id":"BASE
_V1","evidence_requirements":[{"prompt":"Storefront with signage visible","required":tru
e,"type":"PHOTO"}],"lat":"40.4405556","lon":"-79.9961111","required_assurance":3,"reward
_amount":"5000000","settlement_mint":"11111111111111111111111111111111"},"title":"Photog
raph the storefront"}
```

`request_digest` (section 10.2), all three routes (verified 20 September, D108):

```
sha256 (packages/shared): 44b067e66ae8dc9939fcf3b2d9ff340e6b0f0d4535fd9b0a01e319c20d86fc65
sha256 (node:crypto):     44b067e66ae8dc9939fcf3b2d9ff340e6b0f0d4535fd9b0a01e319c20d86fc65
shasum -a 256:            44b067e66ae8dc9939fcf3b2d9ff340e6b0f0d4535fd9b0a01e319c20d86fc65
```

### 13.3 Vector V3 — snap

The section 9.1 algorithm run in scaled-integer arithmetic (BigInt), raw output:

```
lat  90.0000000  -> 89.9950000
lon -180.0000000 -> -179.9950000
lat  -0.0000001  -> -0.0050000
lat  40.4405556  -> 40.4450000
lon -79.9961111  -> -79.9950000
```

The first three reproduce the section 9.1 worked examples and the test 73 and 74
expectations; the last two are V1's coordinates, so V1's `location_public` is
`lat` `40.4450000`, `lon` `-79.9950000`.

---

## 14. Open questions

Undecided values live here, not silently in prose (the Session 4 fee-constant
incident). Each carries its revisit condition.

1. **The program id is deliberately not in the policy.** The policy commits to the
   task; the binding between a bounty and the escrow program is structural — the
   funding transaction writes the policy hash into an account owned by the program,
   so the chain itself records which program holds the commitment. Revisit if a
   second program deployment ever coexists with the first (an upgrade that changes
   semantics, or a mainnet deployment beside devnet), or if a consumer must verify
   a policy with no chain access at all: either would need the policy to name its
   program, which is a new policy version under a new domain tag, never a
   seventeenth field in v1.
2. **Category taxonomy.** `category` is free text, 1 to 50 code units (section
   8.3). Whether it becomes a fixed enum — and what the values are — is a product
   decision owed by the first session that builds category browsing UI (Session 11
   per the current plan). Moving to an enum tightens validation only; existing
   hashes are unaffected because `category` is outside the policy (section 2.4).
3. **Provisional product bounds.** Window bounds (section 2.1), requirement count
   and prompt length (section 2.2), capture radius (section 2.1), title and
   category lengths (section 8.3), query radius and pagination (section 8.4).
   Changing any of these is a spec amendment; none affects an existing hash.
   Review once real bounties exist — Session 20's two-device runs at the latest.
4. **Idempotency key retention.** Consumed keys accumulate without bound (section
   10.3) — accepted for the MVP. Production needs a retention decision under
   SECURITY-PRODUCTION.md section 5 (evidence lifecycle): when a key row may be
   pruned, and what a replay after pruning returns. Owed before any mainnet
   deployment (SECURITY-PRODUCTION.md section 11), not before the hackathon.
5. **The GPS profile lift — closed in Session 17 (D121).** The mobile create flow is
   the second producer. The section 5 rules are implemented once, in `packages/shared`
   SPEC.md section 8.1.
6. **Reservation expiry mechanics.** Section 7.3 defines a reservation as expired
   when its `assignments` row no longer holds `status = 'ACTIVE'`: the write-time
   flip is the definition, and the discovery query never compares timestamps.
   Undecided: the timestamp source the flip reads — no reservation-expiry column
   exists, and `assignments.deadline` is the completion deadline of an accepted
   assignment, not a reservation TTL; the sweeper or opportunistic write that flips
   `ACTIVE` off; and the bound on the lag between true expiry and the flip. The
   interval is operational; POLICY names no interval. All three are owed by the
   session that ships voucher issuance.
7. **Discovery lists bounties past their acceptance cutoff.** A projected bounty stays
   `AVAILABLE` until a confirmed `expire_unaccepted` (section 7.2), but no code calls
   that instruction yet, and the cutoff is on chain only. After the cutoff such a bounty
   is still listed, and its voucher answers `ACCEPTANCE_WINDOW_CLOSED`. Owed by P2, which
   builds discovery on the device: store the cutoff at projection and filter on it, or
   expire the bounty. Closed in P2 (D126): section 16.3.
8. **Recovering an escrow the database will never project.** A mismatched funding
   (section 15.3) and a funding confirmed after cancellation (section 15.6) both leave
   money in escrow under a row that is not `AVAILABLE`. The program returns it through
   `cancel` or `expire_unaccepted`, which nothing but the CLI calls today. Owed by O1.
9. **Commitment.** Projection reads at `confirmed` (section 15.3). `finalized` is owed a
   decision before any mainnet deployment, alongside item 4.

---

## 15. Funding and the funding projection

Session 17 (P1). Normative; written before implementation. The client is
`apps/mobile/FUNDING.md`. The helpers both sides share are `packages/shared/SPEC.md`
section 8.

### 15.1 The bounty id on chain (D117)

`create_and_fund` takes `bounty_id: [u8; 16]` and seeds the bounty account with it. That
value is `uuidBytes(bounties.id)` (SPEC.md section 8.3): the row's own primary key, which
the create response already returns as `id`. The database generates it, by the column
default. No client chooses it.

Consequences:

- The account's address is a function of two values the server already holds: the
  requester's wallet and `bounties.id`. Section 15.3 derives it, so nothing about the
  funding has to be reported for the server to find it.
- A row has exactly one possible account. Creation is idempotent (section 10), so a
  retried create returns the same `id`, a repeated funding targets the same address, and
  the program refuses the second as already in use. A bounty cannot be funded twice.
- On chain, `bounty_id` need only be unique per requester (MESSAGES.md section 4). Here
  it is also globally unique, at no cost.

### 15.2 What the client funds with

The client learns everything from the create response, the section 8.2 owner view: `id`,
`policy_hash` and `policy`. No other endpoint is involved. It runs section 3.5 through
`verifyCreatedBounty` (SPEC.md section 8.5) and builds the instruction data with
`createAndFundData` (SPEC.md section 8.4) from that function's return value only:

| Argument | From the verified object |
|---|---|
| `bounty_id` | `uuidBytes(id)` |
| `reward_amount` | `reward_amount` as an unsigned 64-bit integer |
| `policy_hash` | the 32 bytes of `policy_hash` |
| `eligibility_profile_hash` | the registry object's hash, for `eligibility_profile_id` |
| `required_assurance` | `required_assurance` |
| `acceptance_window_secs` | `acceptance_window_seconds` |
| `completion_window_secs` | `completion_window_seconds` |
| `review_window_secs` | `challenge_window_seconds` (D72) |

The requester signs with the wallet their session signed in with. Any other wallet funds
an address section 15.3 never reads, so the phone refuses it (FUNDING.md section 2.3).

### 15.3 The projection (D118)

One function, `projectFunding`, is the only writer of `AVAILABLE`. It has two callers:
the report endpoint (section 15.4) and the funding sweep (section 15.5).

Its evidence is the bounty account, not a transaction. `create_and_fund` emits no event,
and `programs/escrow/SPEC.md` section 8 names surviving accounts as the reconciliation
source for every instruction except the two that close them. A signature proves that a
transaction ran; the account proves what it left behind, which is what section 2.6
compares. No signature is required or read.

Steps, in order. The first failing step ends the call. Only step 7 writes.

1. **Load** the row with its policy and its requester's `users.wallet_address`. Only a
   `DRAFT` row proceeds; the callers handle every other state.
2. **Derive** the address: the program-derived address of the escrow program over the
   seeds `bounty`, the 32 bytes of the requester's wallet, and `uuidBytes(bounties.id)`,
   with the canonical bump. Bumps are tried from 255 down; the first whose hash is not a
   valid ed25519 point wins, as in the Solana runtime. The on-curve test accepts the same
   encodings as the runtime's decompression, non-canonical y values included. It lives
   in `apps/api/src/chain/pda.ts`, over `@noble/curves` and `@noble/hashes`, which the API
   already uses. Its first vector is the live configuration account: the seed `config`
   alone gives `DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb`, bump 255.
3. **Read** the account at `confirmed` with the existing reader (ELIGIBILITY.md section
   3). A reader failure is `CHAIN_UNAVAILABLE`. No account is `NOT_FUNDED`.
4. **Decode** with the existing decoder, `chain/bounty.ts`. A failure is
   `BINDING_MISMATCH`.
5. **State.** The account is `Funded`, else `BINDING_MISMATCH`. No later state is
   reachable before projection: every later instruction needs a voucher, and the voucher
   needs `program_account` (ELIGIBILITY.md section 4, check 4).
6. **Equality.** Every row of both section 2.6 tables compares equal, else
   `BINDING_MISMATCH`. Policy values come from the stored canonical text (section 3.4),
   parsed, never from read-model columns.
7. **Write**, one conditional update: `state` to `AVAILABLE` and `program_account` to the
   derived address in base58, where the id matches and `state = 'DRAFT'`, returning the
   row. One row is `PROJECTED`. Zero rows means a concurrent writer won; reload once. A
   row now `AVAILABLE` with the same `program_account` is `PROJECTED`. A row now
   `CANCELLED` is `FUNDED_AFTER_CANCEL`. Anything else is an error, never a retry (D66's
   reasoning).

The outcomes are `PROJECTED`, `NOT_FUNDED`, `CHAIN_UNAVAILABLE`, `BINDING_MISMATCH` and
`FUNDED_AFTER_CANCEL`. The last two are alarms: each writes one error-level log line
naming the outcome and the bounty id, and nothing else — no account bytes, wallet or
policy text. A mismatched bounty stays `DRAFT` for good (section 2.6); its escrow returns
to the requester only through the program (section 14, item 8).

Commitment is `confirmed`, matching the voucher. A confirmed block later rolled back
would leave an `AVAILABLE` row with no account behind it; the voucher already maps a
missing account to `BOUNTY_NOT_ACCEPTABLE`, so the failure is safe. Section 14, item 9.

### 15.4 `POST /bounties/:id/funding`

The requester's device asks the server to look. The request carries no evidence and no
body: the server reads what it needs from the chain, so the request cannot assert a
false fact. The phone calls it after every funding attempt, whether the wallet reported
success or failure, and whenever it shows a `DRAFT` bounty (FUNDING.md).

Check order:

1. **Auth.** 401 codes per section 8.1.
2. **Body.** Any present body is `INVALID_REQUEST` (400), section 8.7's rule.
3. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
4. **Load.** No row: `NOT_FOUND` (404).
5. **Caller.** Not the requester: `NOT_FOUND` (404) when the state is `DRAFT` or
   `CANCELLED`, `FORBIDDEN` (403) otherwise — section 8.7's split.
6. **Already projected.** Any state but `DRAFT` and `CANCELLED`: 200, owner view. A
   repeated report is a success.
7. **Cancelled.** Run section 15.3 steps 2 to 4 without writing; a decodable account
   logs `FUNDED_AFTER_CANCEL`. Respond `BOUNTY_NOT_FUNDABLE` (409) whatever the read
   found, including a failed read: the alarm is best effort, the answer is not.
8. **Project** (section 15.3). `PROJECTED`: 200, owner view, now `AVAILABLE` with its
   `program_account`. `NOT_FUNDED`: 409. `CHAIN_UNAVAILABLE`: 503. `BINDING_MISMATCH`:
   409. `FUNDED_AFTER_CANCEL`: `BOUNTY_NOT_FUNDABLE` (409).

`NOT_FUNDED` is the expected answer while a transaction is in flight. The phone repeats
the call on FUNDING.md's schedule; the requester is not shown an error for it.

The route is registered only when the chain dependencies exist, as the voucher route is.
Every production start provides them.

### 15.5 The funding sweep

The backstop for a report that never arrives: the app killed after the wallet sent, the
network lost, or the wallet reporting failure for a transaction that landed (the MWA case
D79 cites).

Every 30 seconds — the reservation sweeper's interval, and like it carrying no
correctness weight — select `DRAFT` rows created within 24 hours of the injectable
clock's now, newest first, at most 50, and run section 15.3 on each in turn. `NOT_FUNDED`
and `CHAIN_UNAVAILABLE` are silent; the alarms log as section 15.3 says. A tick that
throws reports through the same error callback as the reservation sweeper, and the next
tick runs normally. The timer is unreferenced, like the reservation sweeper's.

Why 24 hours and 50: in the only client, funding follows creation within minutes, so an
older `DRAFT` is an abandoned one, and each row costs one account read per tick. A
`DRAFT` older than 24 hours is still projected when its requester opens it, because the
phone calls section 15.4 then. Both numbers are operational. A production reconciler
reads confirmations rather than polling (O1).

Lag: a landed funding with no report is projected within 30 seconds, plus one read per
newer row, provided it is among the 50 newest `DRAFT` rows under 24 hours old.

### 15.6 Cancel reads the chain first (D120)

Section 8.7, amended. Between its steps 6 and 7, for a `DRAFT` bounty:

6a. Run section 15.3 steps 2 and 3. A reader failure is `CHAIN_UNAVAILABLE` (503) and
    nothing is written: a cancel is refused rather than risk cancelling a funded bounty.
    No account: continue to step 7. An account: run section 15.3 in full, which projects
    it or raises its alarm, and respond `BOUNTY_NOT_CANCELLABLE` (409) whatever the
    outcome.

The race that remains: a funding that confirms after step 7 commits leaves a `CANCELLED`
row with money in escrow. The phone reports after every funding attempt, so section
15.4 step 7 logs it; the money returns as section 14, item 8 describes. The phone never
offers Cancel while a funding attempt is running, which narrows the window to a second
device or a direct caller.

As in section 15.4, step 6a runs only when the chain dependencies exist. A test build
without them keeps section 8.7 as written, which is what the section 12 cancel tests
exercise, so their count is unchanged.

### 15.7 Error codes

| Code | Status | Failure |
|---|---|---|
| `NOT_FUNDED` | 409 | no bounty account at the derived address yet (section 15.4) |
| `BOUNTY_NOT_FUNDABLE` | 409 | the bounty is `CANCELLED` (section 15.4) |

`BINDING_MISMATCH` (409) and `CHAIN_UNAVAILABLE` (503) are ELIGIBILITY.md's codes,
reused; `BINDING_MISMATCH` here covers the wider section 2.6 set.

### 15.8 Tests

A new file, `apps/api/test/funding.test.ts`, named in the test script after
`eligibility.test.ts`. D36 gate: `tests 24, pass 24, fail 0`. Every other suite keeps its
count, bounties' 78 included (section 15.6).

Fixtures are recorded raw from the first real funding on devnet (Session 17), under
`apps/api/test/fixtures/devnet/`: the create response for that bounty as returned, and
the `getAccountInfo` response for its account at `confirmed`. A test seeds the user,
policy and bounty rows by SQL from the recorded create response — id, canonical text and
hash exactly as recorded — so the account's bindings agree with the row by construction,
not by editing. A mismatch test edits one field of the account bytes in memory, behind
the unedited control of test 3: Session 16's pattern. Each negative test is shown red
before the gate by a scripted mutation of the check it names.

Derivation:

1. `pda.ts` over the seed `config` gives `DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb`,
   bump 255.
2. Over the section 15.3 seeds for the recorded bounty, it gives the recorded address.

Report:

3. A `DRAFT` row and the recorded account: 200, owner view, `state` `AVAILABLE`,
   `program_account` the recorded address. The control for tests 7 to 17.
4. The same report again: 200, the same view; the row is written once.
5. No account: 409 `NOT_FUNDED`; the row is `DRAFT` with `program_account` null.
6. The reader throws `ChainError`: 503 `CHAIN_UNAVAILABLE`; the row is unchanged.
7. to 17. One account field edited each: 409 `BINDING_MISMATCH`, row unchanged, one
   alarm line. The fields: `bounty_id`, `requester`, `reward_amount`, `platform_fee`,
   `policy_hash`, `eligibility_profile_hash`, `required_assurance`,
   `acceptance_window_secs`, `completion_window_secs`, `review_window_secs`, and the
   state byte set to `Accepted`.
18. A request body: 400 `INVALID_REQUEST`.
19. Another user, `DRAFT` row: 404 `NOT_FOUND`.
20. A `CANCELLED` row and the recorded account: 409 `BOUNTY_NOT_FUNDABLE`, one
    `FUNDED_AFTER_CANCEL` alarm line.

Sweep:

21. Three `DRAFT` rows — the recorded one, one with no account, and one created 25 hours
    before the injected clock. After one sweep call only the first is `AVAILABLE`, and
    the reader was never asked for the third row's address.

Cancel (section 15.6):

22. A `DRAFT` row and the recorded account: 409 `BOUNTY_NOT_CANCELLABLE`; the row is
    `AVAILABLE`.
23. The reader throws: 503 `CHAIN_UNAVAILABLE`; the row is `DRAFT`.
24. No account: 200, `CANCELLED`.

---

## 16. Discovery, acceptance and the acceptance projection

Session 18 (P2). Normative; written before implementation. The client is
`apps/mobile/DISCOVERY.md`. The helpers the phone uses are `packages/shared/SPEC.md` section 9.
ELIGIBILITY.md governs the voucher and is amended only where this section says so.

### 16.1 What P2 adds

Migration 11 (section 16.2); the acceptance cutoff, written at funding projection and read by
discovery (16.3); `program_account` in the public view and the assigned-Scout view (16.4);
`GET /me/missions` (16.5); reading the account's acceptance fields (16.6); the projection
(16.7); `POST /bounties/:id/acceptance` (16.8); error codes (16.9); tests (16.10); the request
log (16.11); the race gate's scripted Scout (16.12).

### 16.2 Migration 11

Up, two changes:

- `bounties` gains `acceptance_cutoff timestamptz`, nullable, with no default. Section 16.3
  names its only writer.
- `assignments` gains the constraint `assignments_acceptance_pair`: `(accepted_at IS NULL) =
  (deadline IS NULL)`. Every row the code writes today is a reservation with both null, so
  the constraint is valid against existing data. A row that violates it fails the migration,
  which is the intended result.

`challenge_nonce` is not touched (D125).

Down: drop the constraint, then the column. Valid against any table state.

Non-test gate, from raw output: after up, every `assignments` column default is listed.
`status` defaults to `ACTIVE`; `id` to `gen_random_uuid()`; no other column has a default
(D115's lesson, D125).

### 16.3 The acceptance cutoff (D126)

Section 15.3 step 7 also writes `acceptance_cutoff`: the account's `acceptance_cutoff`, a
Unix second count, as a UTC timestamp, in the same conditional update. The value is immutable
on chain after funding, so no other writer exists.

Section 8.4 step 5 gains a conjunct: `acceptance_cutoff >= $now`, where `$now` is the
injectable clock's instant passed as a parameter. That is ELIGIBILITY.md check 6's comparison,
so discovery and the voucher agree to the second. A null cutoff never satisfies it.

Rows projected before migration 11 carry a null cutoff and are no longer listed. They stay
readable by id, and the voucher treats them as before.

Every section 12 test that seeds an `AVAILABLE` row also sets its cutoff one day after the
test clock.

### 16.4 Views (D127)

**Public view.** Section 8.2's table gains `program_account`: the base58 string from the
bounty row, or null. The phone needs it to build `accept`. The account is public on chain; the
client never displays the requester wallet it contains.

**Assigned-Scout view.** Section 8.5 gains step 4a, after the owner check. The caller holds
the bounty's acceptance when an `assignments` row for the bounty has `status = 'ACTIVE'`,
`accepted_at` set and `scout_id` equal to the caller, and the bounty's state is `ACCEPTED`.
That caller gets 200 with:

| Key | Value |
|---|---|
| every public-view key | as the public view |
| `policy` | the full sixteen-field object, parsed from the stored canonical text |
| `assignment` | object: `accepted_at` and `deadline`, ISO 8601 UTC strings |

`policy` carries the exact `lat` and `lon`, the salt and the requirement ids: section 9.4's
disclosure to the assigned Scout. Exact coordinates reach the response only through the
policy strings; section 9.1's prohibition on reading a geography column back holds.

Later states (`SUBMITTED` onward) extend step 4a in the session that projects them.

### 16.5 `GET /me/missions`

The caller's acceptances. A phone has no local storage, so this is how it finds an accepted
mission after a restart.

1. **Auth**; 401 codes.
2. **Parameters.** `limit` and `offset` as section 8.4; unknown parameters `INVALID_REQUEST`
   (400).
3. **Query.** `assignments` rows with `status = 'ACTIVE'`, `accepted_at` set and `scout_id`
   the caller, joined to their bounties; ordered by `accepted_at` descending, then bounty
   `id` ascending.
4. **Respond** 200 with an object whose single key `missions` holds list items (section 8.2),
   each with one added key, `deadline`, an ISO 8601 UTC string.

The route is `/me/missions` for section 8.6's reason.

### 16.6 Reading the acceptance fields (D129)

`decodeBountyAccount` (`chain/bounty.ts`) is unchanged: it reads the fixed prefix only. A new
function, `readAcceptance`, reads the two fields `accept` writes, from an `Accepted` account
only. Anchor allocates the full 274 bytes; each `Option` is serialised as a tag byte, 0 for
none and 1 for some, followed by its value only when the tag is 1. In an `Accepted` account
byte 169 is 1, byte 171 (the `scout` tag) is 1, `scout` is bytes 172 to 203, byte 204 (the
`deadline` tag) is 1, and `deadline` is the little-endian signed 64-bit integer at bytes 205
to 212.

Anything else, including an account shorter than 213 bytes, is the new error `BAD_TAIL`. The
result is `scout` (32 bytes) and `deadline` (`bigint`). The layout is confirmed against the
recorded account of section 16.10.

### 16.7 The projection (D124)

One function, `projectAcceptance(bountyId)`, is the only writer of `ACCEPTED` and of
`assignments.accepted_at` and `deadline`. Its evidence is the account, not a transaction.
Steps in order; the first failing step ends the call. Only step 7 writes.

1. **Load** the row with its `program_account`. States other than `AVAILABLE` and `ACCEPTED`
   are `NOT_APPLICABLE`, with no read.
2. **Read** the account at `program_account` at `confirmed`. A reader failure is
   `CHAIN_UNAVAILABLE`. No account is `NOT_ACCEPTED`: a closed account belongs to `cancel` or
   `expire_unaccepted`, whose projections are not P2's.
3. **Decode** the prefix. A failure, or an account `bounty_id` other than the row id's 16
   bytes, is `BINDING_MISMATCH` (D129).
4. **State.** `Funded` is `NOT_ACCEPTED`. Any state other than `Accepted` is
   `UNPROJECTED_STATE`: no projector for it exists yet. `Accepted` continues with
   `readAcceptance` (section 16.6); `BAD_TAIL` is `BINDING_MISMATCH`.
5. **Scout.** The `users` row whose `wallet_address` is the base58 of `scout`. None is
   `UNKNOWN_SCOUT`. A voucher requires a session, so an unknown Scout means a voucher was
   signed outside this service.
6. **Times.** `deadline` is the account's. `accepted_at` is `deadline` minus the account's
   `completion_window_secs`, which equals the chain clock at `accept` (escrow SPEC section 7.4
   check 7).
7. **Write**, one transaction:
   1. Lock the bounty row. State `ACCEPTED`: if the chain's Scout holds an `ACTIVE` row with
      `accepted_at` set, the outcome is `PROJECTED` and nothing is written; otherwise the
      section 7.2 state machine is falsified, and the call raises an error and rolls back.
      Any state other than `AVAILABLE` or `ACCEPTED`: roll back, `NOT_APPLICABLE`.
   2. Set `status = 'EXPIRED'` on every `ACTIVE` row of the bounty whose `scout_id` is not the
      chain's Scout.
   3. If the chain's Scout holds an `ACTIVE` row, set its `accepted_at` and `deadline`.
      Otherwise insert one: the bounty, the Scout, status `ACTIVE`, both times, and
      `expires_at` equal to `accepted_at`. That case arises when the reservation was flipped
      before any projection ran.
   4. Set the bounty's `state` to `ACCEPTED` where its id matches and `state = 'AVAILABLE'`.

   The outcome is `PROJECTED`.

The outcomes are `PROJECTED`, `NOT_ACCEPTED`, `NOT_APPLICABLE`, `CHAIN_UNAVAILABLE`,
`BINDING_MISMATCH`, `UNPROJECTED_STATE` and `UNKNOWN_SCOUT`. The last three are alarms, each
logged as section 15.3 says: one error-level line naming the outcome and the bounty id, and
nothing else.

**Callers.**

- `POST /bounties/:id/acceptance` (section 16.8).
- **The voucher endpoint.** ELIGIBILITY.md check 5, amended: when the account is `Accepted`,
  the endpoint runs the projection, then answers `BOUNTY_NOT_ACCEPTABLE` whatever the
  outcome.
- **The reservation sweep.** ELIGIBILITY.md section 6.1, amended: each tick first selects
  `ACTIVE` rows with `accepted_at` null and `expires_at` at or before now, and runs the
  projection for each row's bounty. It then runs the existing flip, whose predicate is
  unchanged; a projected row no longer matches it. A failed projection does not stop the
  flip, because a stale reservation affects visibility only.

**Lag.** An accept whose report never arrives is projected when its reservation expires: at
most 300 seconds after the voucher was issued, plus the sweep's 60-second lag bound. Until
then the reservation itself keeps the bounty out of discovery.

**Clock skew.** The program compares `expires_at` with the chain clock; the sweep compares it
with the API clock. When the chain trails, an `accept` can land after the API flipped the
reservation, and possibly after another Scout reserved. Step 7.2 settles it for the chain's
Scout. The other Scout's `accept` fails on chain with `BountyNotAcceptable`, and the phone
says so plainly (ELIGIBILITY.md section 10).

Commitment is `confirmed`, as section 15.3; section 14, item 9 applies.

### 16.8 `POST /bounties/:id/acceptance`

The Scout's phone asks the server to look. No body and no evidence; the server reads the
chain. The phone calls it after every accept attempt, whatever the wallet reported.

1. **Auth.** 401 codes per section 8.1.
2. **Body.** Any present body is `INVALID_REQUEST` (400), section 8.7's rule.
3. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
4. **Load.** No row: `NOT_FOUND` (404).
5. **Hidden.** State `DRAFT` or `CANCELLED` and the caller is not the requester: `NOT_FOUND`
   (404).
6. **Project** (section 16.7), unless the state is already `ACCEPTED`.
7. **Respond**, from the row as it now stands:
   - `ACCEPTED`, caller holds the acceptance: 200, assigned-Scout view.
   - `ACCEPTED`, caller is the requester: 200, owner view.
   - `ACCEPTED`, anyone else: `ACCEPTED_BY_OTHER` (409).
   - Still `AVAILABLE`, by outcome: `NOT_ACCEPTED` is `NOT_ACCEPTED` (409);
     `CHAIN_UNAVAILABLE` is 503; `BINDING_MISMATCH` is 409; `UNKNOWN_SCOUT` is
     `ACCEPTED_BY_OTHER` (409), since the caller is a known user and not that Scout;
     `UNPROJECTED_STATE` is `BOUNTY_NOT_ACCEPTABLE` (409).
   - Any other state: `BOUNTY_NOT_ACCEPTABLE` (409).

`NOT_ACCEPTED` is the expected answer while a transaction is in flight. The phone repeats the
call on DISCOVERY.md's schedule without showing an error.

The route is registered only when the chain dependencies exist, as section 15.4's is.

### 16.9 Error codes

| Code | Status | Failure |
|---|---|---|
| `NOT_ACCEPTED` | 409 | the account is not `Accepted`, or no account exists (section 16.8) |
| `ACCEPTED_BY_OTHER` | 409 | the bounty was accepted by a different Scout |

Reused: `BOUNTY_NOT_ACCEPTABLE`, `BINDING_MISMATCH` and `CHAIN_UNAVAILABLE` from
ELIGIBILITY.md; `INVALID_REQUEST` and `NOT_FOUND` from section 8.

### 16.10 Tests

Fixtures are recorded raw from the first live accept on devnet (Session 18), under
`apps/api/test/fixtures/devnet/`: the voucher response as returned, the create response of
the accepted bounty, and the `getAccountInfo` response for its account at `confirmed` after
the accept. Seeds come from the recorded create response, as in section 15.8. Mismatch tests
edit one field of the account bytes in memory, behind an unedited control. Each negative test
is shown red before the gate by a scripted mutation of the check it names.

A new file, `apps/api/test/acceptance.test.ts`, named in the test script after
`funding.test.ts`. D36 gate: `tests 16, pass 16, fail 0`.

1. The recorded account: state byte 1, and `readAcceptance` returns the recorded Scout wallet
   and the recorded `deadline`.
2. The recorded account with byte 171 set to 0: `BAD_TAIL`.
3. The recorded account with byte 204 set to 0, and the recorded account cut to 212 bytes:
   `BAD_TAIL`.
4. Report with the chain's Scout holding the reservation: 200, assigned-Scout view; the row is
   `ACCEPTED`; the assignment is `ACTIVE`, its `deadline` is the account's and its
   `accepted_at` is `deadline` minus `completion_window_secs`.
5. The assigned-Scout view's keys are exactly the public-view keys plus `policy` and
   `assignment`; `policy` hashes to `policy_hash`.
6. A repeated report: 200, no second row, values unchanged.
7. Report by another Scout: `ACCEPTED_BY_OTHER`.
8. Report by the requester: 200, owner view, state `ACCEPTED`.
9. The recorded account with its state byte set to `Funded`: `NOT_ACCEPTED`; nothing written.
10. The reader throws: 503 `CHAIN_UNAVAILABLE`; nothing written.
11. No account: `NOT_ACCEPTED`.
12. The chain's Scout holds no `ACTIVE` row and another Scout does: that row becomes
    `EXPIRED`; a new `ACTIVE` row for the chain's Scout carries both times, with `expires_at`
    equal to `accepted_at`.
13. The chain's Scout has no `users` row: `ACCEPTED_BY_OTHER`; the bounty stays `AVAILABLE`;
    the log line names `UNKNOWN_SCOUT`.
14. The account's state byte set to `Refunded`: `BOUNTY_NOT_ACCEPTABLE`; nothing written; the
    log line names `UNPROJECTED_STATE`.
15. An `assignments` insert with `accepted_at` set and `deadline` null fails on
    `assignments_acceptance_pair`.
16. `GET /me/missions` lists the acceptance for its Scout, with `deadline`, and nothing for
    another caller; `GET /bounties/:id` gives the Scout the assigned-Scout view (step 4a) and
    anyone else the public view.

Other suites:

- **Eligibility** gains test 25: a voucher request on an `Accepted` account whose Scout holds
  the reservation answers `BOUNTY_NOT_ACCEPTABLE`, and the bounty is then `ACCEPTED`. And test
  26: a sweep tick over two expired reservations, one whose account is `Accepted` and one
  whose account is `Funded`; the first is projected and not flipped, the second is flipped to
  `EXPIRED`. Gate 26.
- **Bounties** gains test 79: discovery excludes an `AVAILABLE` row whose cutoff is one second
  before the clock and includes it when the cutoff equals the clock. And test 80: discovery
  excludes an `AVAILABLE` row with a null cutoff. Test 59's public-view key set gains
  `program_account`. Gate 80.
- **Funding**: the projection test that asserts `AVAILABLE` also asserts `acceptance_cutoff`
  equals the recorded account's. Gate unchanged at 24.

Every other suite keeps its count.

### 16.11 The Scout's position is not logged

Discovery's query string carries the Scout's position. The production logger records each
request's URL, and until now that included the query string. The request log serialises the
path only, with no query string, for every route. Non-test gate: one live log line from a
device discovery call is read from raw output and shows the path without coordinates.

### 16.12 The race gate's scripted Scout (D123 ruling 5)

BACKLOG.md's gate "Assignment cannot double-book" is run with the A30 and a laptop script,
`apps/api/scripts/scout-race.mjs`. The script is a development tool, not a test.

- Its key is `~/bountycam-keys/scout2.json`, mode 600, funded with 0.05 SOL from the
  relayer.
- It signs in by SIWS against the local API (AUTH.md), then counts down 3, 2, 1 and requests
  a voucher at GO, while the operator taps Accept on the A30 at GO. It prints the raw HTTP
  status and body.
- If it wins the reservation, it builds and sends `accept` with the SPEC.md section 9 helpers
  and checks, then calls section 16.8 and prints the answer.

Pass, from raw output and the explorer: exactly one voucher request answers 200 and the other
`BOUNTY_RESERVED`; exactly one `accept` confirms on chain; the database shows `ACCEPTED` with
the winner's acceptance.

---

## 17. The capture nonce

Session 19 (P3). Normative; written before implementation. D73 defines the mechanism; D131 to
D137 settle what it left open. The client is `apps/mobile/CAPTURE.md`. The location helpers
are `packages/shared/SPEC.md` section 10.

### 17.1 What P3 adds

Migration 12 (section 17.2); seven configuration keys (17.3); a completion-window minimum at
creation (17.4); the start gate's server check and the stored start fix (17.5);
`POST /bounties/:id/capture-nonce` (17.6); the `capture` key of the assigned-Scout view (17.7);
`consumeCaptureNonce`, which P4's submission calls (17.8); what P4 and P5 must bind (17.9);
error codes (17.10); tests (17.11); the live run's deferral to P4 (17.12).

Capture itself, the camera, evidence and the manifest are P4's.

### 17.2 Migration 12

Up, in order:

1. `CREATE TYPE capture_nonce_status AS ENUM ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'CONSUMED')`.
2. `assignments` gains `assignments_binding_key UNIQUE (id, bounty_id, scout_id)`, the target of
   step 3's foreign key.
3. The table `capture_nonces`:

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` | primary key, default `gen_random_uuid()`; the capture-session id (D134) |
| `assignment_id` | `uuid` | not null |
| `bounty_id` | `uuid` | not null |
| `scout_id` | `uuid` | not null |
| `deployment_id` | `smallint` | not null, 0 to 255 |
| `value` | `bytea` | not null, unique, exactly 32 bytes |
| `status` | `capture_nonce_status` | not null, no default |
| `issued_at` | `timestamptz` | not null |
| `expires_at` | `timestamptz` | not null, after `issued_at` |
| `consumed_at` | `timestamptz` | set exactly when `status` is `CONSUMED` |
| `start_lat` | `text` | not null; the start fix, GPS profile string |
| `start_lon` | `text` | not null |
| `start_accuracy_m` | `double precision` | not null, 0 or more |
| `start_fixed_at` | `timestamptz` | not null; the phone's fix time, recorded, never judged |

   Constraints: `capture_nonces_assignment_fkey`, a foreign key on `(assignment_id, bounty_id,
   scout_id)` to `assignments_binding_key`, so a nonce cannot name a bounty or Scout other than
   its assignment's; `capture_nonces_expiry_after_issue`; `capture_nonces_consumed_pair`,
   `(status = 'CONSUMED') = (consumed_at IS NOT NULL)`; and the partial unique index
   `capture_nonces_one_active_idx` on `(assignment_id) WHERE status = 'ACTIVE'`.
4. `assignments` drops `challenge_nonce`, and with it `assignments_challenge_nonce_key` (D131).
   No row has ever held a value.

Down, in reverse: `challenge_nonce bytea UNIQUE`, nullable, is restored; the table, the
binding key and the type are dropped. Valid against any table state.

Non-test gate, from raw output: after up, every `capture_nonces` column default is listed;
only `id` has one. `\d assignments` shows no `challenge_nonce`.

### 17.3 Configuration

Seven keys join section 8.1's, all optional, each a positive integer when set; anything else
exits at startup, as section 8.1 says. They are operational configuration, never policy
fields: the V1 policy is frozen (D112).

| Key | Default | Meaning |
|---|---|---|
| `CAPTURE_NONCE_LIFETIME_S` | 1200 | a nonce's longest capture window |
| `CAPTURE_DEADLINE_BUFFER_S` | 600 | time kept clear before the deadline |
| `CAPTURE_MIN_WINDOW_S` | 600 | the shortest capture window any Start may give |
| `CAPTURE_SUBMISSION_GRACE_S` | 480 | how long after `expires_at` consumption succeeds |
| `LOCATION_MAX_ACCURACY_M` | 200 | the initial configured accuracy ceiling (D133) |
| `LOCATION_FIX_TIMEOUT_S` | 10 | the phone's wait for a fix |
| `LOCATION_MAX_AGE_S` | 30 | the oldest fix the phone may use |

Two invariants, checked at startup: `CAPTURE_NONCE_LIFETIME_S >= CAPTURE_MIN_WINDOW_S`, so every
issued nonce gives at least the minimum window; and `CAPTURE_SUBMISSION_GRACE_S <
CAPTURE_DEADLINE_BUFFER_S`, so a submission accepted at the end of its grace still leaves time
before the deadline for verification and `submit_attestation` (D132).

The 200 m figure is a configured ceiling on the phone's reported uncertainty, not a claim that
200 m is the correct threshold; tuning it is a configuration change, not a change to the model
of section 17.5.

### 17.4 The completion window minimum (D135)

Section 2.1's rule for `completion_window_seconds` becomes: `CAPTURE_DEADLINE_BUFFER_S +
CAPTURE_MIN_WINDOW_S` (1200 by default) to 2592000 inclusive; failure `INVALID_WINDOW`, at the
same place in section 8.3's step 5. A shorter window would close Start at the moment of
acceptance: the Scout could accept but never capture. The bound is request validation, which
D112 leaves amendable; no hash changes. Bounties already created keep their windows.

### 17.5 The start gate on the server (D133)

The phone decides whether to offer Start (CAPTURE.md). The server repeats the decision with the
same function, `checkCaptureStart` (SPEC.md section 10), on the fix the phone sends: the target
is the policy's `lat` and `lon` strings, parsed from the stored canonical text as section 16.4
does, the radius is the policy's `capture_radius_m`, and the ceiling is
`LOCATION_MAX_ACCURACY_M`. `IMPRECISE` is `LOCATION_TOO_IMPRECISE`; `TOO_FAR` is
`LOCATION_TOO_FAR`.

The rule, stated here once: `effective_distance_m = max(0, distance_m -
horizontal_accuracy_m)`, where `distance_m` is the haversine distance of SPEC.md section 10.1;
the gate passes when `horizontal_accuracy_m <= LOCATION_MAX_ACCURACY_M` and
`effective_distance_m <= capture_radius_m`. It answers "is presence plausible enough to start
collecting evidence", nothing more. The fix is phone-reported and can be spoofed; the check
exists to keep honest Scouts and the server in agreement, not as proof of presence.

The fix's age is judged on the phone, against the phone's clock that stamped it; the server
records `fixed_at` and never compares it with its own clock (D133).

**The stored fix.** Each issued nonce stores its start fix (section 17.2). It appears in no
view, response, error or log line, never reaches the requester, and is read only by an operator
investigating a start report. Its retention is O6's to set. The request log already carries
the path only (section 16.11); the body is never logged.

### 17.6 `POST /bounties/:id/capture-nonce`

The Scout's phone starts a capture session. Every successful call issues a new nonce (D134).

Body, a JSON object with exactly four keys:

| Key | Type | Rule |
|---|---|---|
| `lat` | string | GPS profile (section 5), -90 to 90 |
| `lon` | string | GPS profile (section 5), -180 to 180 |
| `horizontal_accuracy_m` | number | finite, 0 or more |
| `fixed_at` | string | ISO 8601 UTC: `YYYY-MM-DDTHH:MM:SS`, optional `.` and 1 to 3 digits, `Z` |

Check order; the first failing step wins:

1. **Auth.** 401 codes per section 8.1.
2. **Body shape.** Missing body, a missing or unknown key, a wrong type, a non-finite or
   negative accuracy, a malformed `fixed_at`: `INVALID_REQUEST` (400). Runs before the id form,
   as section 8.7 step 2 does.
3. **Coordinates.** `lat` or `lon` failing its profile or range: `INVALID_GPS` (400).
4. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
5. **Load.** No row: `NOT_FOUND` (404).
6. **Hidden.** State `DRAFT` or `CANCELLED` and the caller is not the requester: `NOT_FOUND`
   (404).
7. **State.** Any state other than `ACCEPTED`: `BOUNTY_NOT_CAPTURABLE` (409). This covers a
   reservation (`AVAILABLE`), and every later or terminal state.
8. **Holder.** The caller holds the acceptance, as section 16.4 step 4a defines it; otherwise
   `NOT_ASSIGNED` (403). The requester, other Scouts and a Scout whose earlier assignment of the
   bounty is no longer `ACTIVE` all land here.
8a. **Submitted** (section 18.7, D142). The assignment has a `submissions` row:
    `ALREADY_SUBMITTED` (409).
9. **Time.** With `now` from the injectable clock and `deadline` the assignment's: `now >
   deadline - CAPTURE_DEADLINE_BUFFER_S - CAPTURE_MIN_WINDOW_S` is `CAPTURE_WINDOW_CLOSED` (409).
   Start is allowed at equality.
10. **Location** (section 17.5): `LOCATION_TOO_IMPRECISE` or `LOCATION_TOO_FAR` (400).
11. **Write**, one transaction:
    1. Lock the bounty row, then the assignment row (the projection's order). If step 7 or 8
       would now fail, roll back and return that step's code.
    2. Set `status = 'SUPERSEDED'` on the assignment's `ACTIVE` row, if one exists, whatever its
       expiry. Reissue always supersedes; `EXPIRED` is written only by section 17.8.
    3. Insert the new row: the assignment's `id`, `bounty_id` and `scout_id`; `deployment_id`
       from the configuration account (ELIGIBILITY.md section 3); `value` from
       `randomness.randomBytes(32)` (D54); `status` `ACTIVE`; `issued_at` `now`; `expires_at =
       min(now + CAPTURE_NONCE_LIFETIME_S, deadline - CAPTURE_DEADLINE_BUFFER_S)`; the four
       start-fix columns from the body.
12. **Respond** 201 with an object whose single key `capture` is section 17.7's object, its
    `capture_nonce` the row just inserted.

Steps 9 and 11.3 give every issued nonce a window of at least `CAPTURE_MIN_WINDOW_S`: at the
latest permitted start, `now + CAPTURE_NONCE_LIFETIME_S` is at or after `deadline -
CAPTURE_DEADLINE_BUFFER_S`, which is then exactly `CAPTURE_MIN_WINDOW_S` after `now`.

The server's clock decides every time. The phone never computes an expiry (D132).

The route is registered only when the chain dependencies exist, as section 16.8's is, because
`deployment_id` comes from them. It reads nothing from the chain: the acceptance and its
deadline are already projected from the account, and the deadline is immutable.

### 17.7 The assigned-Scout view gains `capture` (D134)

Section 16.4's assigned-Scout view gains one key, `capture`, and its `assignment` object gains
`id`, which P4's manifest carries (section 17.9). `capture` is an object:

| Key | Value |
|---|---|
| `server_time` | the clock's `now`, ISO 8601 UTC |
| `start_closes_at` | `deadline - CAPTURE_DEADLINE_BUFFER_S - CAPTURE_MIN_WINDOW_S`, ISO 8601 UTC |
| `max_location_accuracy_m` | `LOCATION_MAX_ACCURACY_M` |
| `location_fix_timeout_s` | `LOCATION_FIX_TIMEOUT_S` |
| `max_location_age_s` | `LOCATION_MAX_AGE_S` |
| `capture_nonce` | null, or the object below |

`capture_nonce` is the assignment's `ACTIVE` row when `now < expires_at`, else null. Its keys:
`id` (the capture-session id), `value` (64 lowercase hex characters), `issued_at` and
`expires_at` (ISO 8601 UTC), and `submit_by` (section 18.7). The phone restores a session from
here after a restart or a failed restart request, instead of superseding it.

The nonce need not be secret after issuance (D73), so serving it to its holder again costs
nothing. It is served to nobody else: the owner and public views are unchanged.

### 17.8 Consumption: `consumeCaptureNonce` (D137)

P3 builds and tests the function; P4's submission calls it inside its own transaction, so the
nonce is consumed atomically with the submission's write. Placement: `src/capture/nonce.ts`.

Input: the 32-byte `value` and the expected `bounty_id`, `assignment_id`, `scout_id` and
`deployment_id`; `now` from the clock. Steps; the first that applies decides:

1. Select the row by `value`, locking it. None: `UNKNOWN`.
2. Any of the four binding fields differs: `BINDING_MISMATCH`. Nothing written.
3. `CONSUMED`: `ALREADY_CONSUMED`. `SUPERSEDED`: `SUPERSEDED`. `EXPIRED`: `EXPIRED`.
4. `ACTIVE` and `now >= expires_at + CAPTURE_SUBMISSION_GRACE_S`: set `status = 'EXPIRED'`;
   `EXPIRED`.
5. Otherwise set `status = 'CONSUMED'` and `consumed_at = now`: `CONSUMED`.

Only `CONSUMED` lets a submission claim A1 freshness. The grace lets evidence captured inside
the window be uploaded after it closes; section 17.3's invariant keeps the grace inside the
deadline buffer.

### 17.9 What P4 and P5 must bind

Fixed now so that P3's format never changes:

- **Manifest keys.** P4's evidence manifest carries `bounty_id` (uuid), `assignment_id` (uuid,
  from section 17.7) and `capture_nonce` (the `value`, 64 lowercase hex characters, exactly as
  issued). The manifest's canonical form is P4's, in `packages/shared`.
- **Capture times.** For A1, every evidence item's capture time lies in `[issued_at,
  expires_at)` of the consumed nonce. P4 records the times; P5 checks them.
- **Location.** P4 records each item's `lat`, `lon`, `horizontal_accuracy_m` and fix time. P4
  and P5 must take the reported accuracy into account and must never treat coordinates as exact
  points. Their acceptance rule and accuracy ceiling are defined and tested when they are built,
  and need not equal the start gate's (D133): the start gate measures plausibility, payment needs
  sufficient evidence of presence. They reuse SPEC.md section 10.1's `distanceM`.
- **Offline.** Evidence carrying no consumed nonce cannot be graded A1 (D73). The UI says so
  before capture begins (P4).

### 17.10 Error codes

| Code | Status | Failure |
|---|---|---|
| `BOUNTY_NOT_CAPTURABLE` | 409 | the bounty is not `ACCEPTED` (section 17.6 step 7) |
| `NOT_ASSIGNED` | 403 | the caller does not hold the acceptance (step 8) |
| `CAPTURE_WINDOW_CLOSED` | 409 | too little time remains before the deadline (step 9) |
| `LOCATION_TOO_IMPRECISE` | 400 | the fix's accuracy exceeds the ceiling (step 10) |
| `LOCATION_TOO_FAR` | 400 | the fix fails the start gate's distance rule (step 10) |

Reused: `INVALID_REQUEST`, `INVALID_GPS`, `NOT_FOUND` and the 401 codes. The outcomes of section
17.8 are return values, not HTTP codes; P4 maps them.

### 17.11 Tests

A new file, `apps/api/test/capture.test.ts`, named in the test script after
`acceptance.test.ts`. Seeds come from the recorded Session 18 accept, as section 16.10's do: the
create response and the account after `accept`, projected through section 16.7, give an
`ACCEPTED` bounty (radius 150 m) with its Scout's acceptance. The clock and randomness are
injected. Each negative test is shown red before the gate by a scripted mutation of the check
it names. D36 gate: `tests 25, pass 25, fail 0`.

Fixes are at the policy's spot unless stated. "North by 0.002" is the spot with 0.002 added to
the latitude; its `distance` is taken from `distanceM`, about 222 m.

Issuance:

1. The holder, clock two hours before the deadline: 201; `capture` has exactly section 17.7's
   keys; `capture_nonce.value` is the injected bytes in hex; `issued_at` is the clock;
   `expires_at` is `issued_at` plus 1200 s. One `ACTIVE` row, with the assignment's three ids,
   `deployment_id` 2 and the start fix as sent.
2. Clock 25 minutes before the deadline: `expires_at` is `deadline` minus 600 s.
3. Clock exactly 1200 s before the deadline: 201 and a window of exactly 600 s. One
   millisecond later: `CAPTURE_WINDOW_CLOSED`, nothing written.
4. A second start before expiry: the first row `SUPERSEDED`, a different value, exactly one
   `ACTIVE` row.
5. A second start after the first nonce's `expires_at`: the first row `SUPERSEDED`, not
   `EXPIRED`.
6. With the production randomness module, two starts give different values.
7. Two starts sent together: both 201; one row `SUPERSEDED` and one `ACTIVE`.

Refusals:

8. A signed-in user with no assignment, and the requester: `NOT_ASSIGNED` (two asserts).
9. A reservation only (bounty `AVAILABLE`, both times null): `BOUNTY_NOT_CAPTURABLE`.
10. Bounty states `EXPIRED`, `SUBMITTED` and `PAID`, seeded by SQL: `BOUNTY_NOT_CAPTURABLE`;
    `CANCELLED`: `NOT_FOUND` for the Scout (four asserts).
11. The Scout's own assignment `EXPIRED` while another Scout holds the acceptance:
    `NOT_ASSIGNED`.
12. No body; `{}`; a fifth key; accuracy as a string; accuracy -1; `fixed_at` without `Z`:
    `INVALID_REQUEST` (six asserts).
13. `lat` with six fraction digits: `INVALID_GPS`.
14. Accuracy 200.5: `LOCATION_TOO_IMPRECISE`. Accuracy 200: 201.
15. North by 0.002 with accuracy `distance - 150 - 1`: `LOCATION_TOO_FAR`, nothing written;
    with accuracy `distance - 150 + 1`: 201.
16. No token: `TOKEN_MISSING`; a malformed id and an unknown id: `NOT_FOUND`.

Views and privacy:

17. The assigned-Scout view: `capture_nonce` null before any start; equal to the 201's after
    one; null again once the clock passes `expires_at`; `start_closes_at` is `deadline` minus
    1200 s; `server_time` is the clock; `assignment.id` is the row's id.
18. The start fix's strings appear in no response body (201, assigned-Scout, owner and public
    views) and in no log line captured through a stream.

Consumption (section 17.8), with the clock injected:

19. A fresh nonce: `CONSUMED`, `consumed_at` the clock; again: `ALREADY_CONSUMED`.
20. At `expires_at + 480 s - 1 ms`: `CONSUMED`. Another nonce at `expires_at + 480 s`:
    `EXPIRED`, and the row is `EXPIRED`.
21. A superseded value: `SUPERSEDED`.
22. Another bounty id, Scout id, assignment id and deployment id: `BINDING_MISMATCH`, the row
    unchanged (four asserts).
23. A value never issued: `UNKNOWN`.

Constraints and configuration:

24. By SQL: a second `ACTIVE` row for one assignment fails on `capture_nonces_one_active_idx`; a
    31-byte value fails; `CONSUMED` with `consumed_at` null fails; a row whose `scout_id` is not
    its assignment's fails on `capture_nonces_assignment_fkey` (four asserts).
25. `loadConfig` gives section 17.3's seven defaults; it throws for a lifetime of 599 against a
    minimum window of 600, for a grace of 600 against a buffer of 600, and for `1.5`.

Other suites:

- **Bounties.** Test 29's completion-window floor becomes 1199, still `INVALID_WINDOW`; new test
  81: a completion window of 1200 creates. Gate 81.
- **Acceptance.** Test 5's key set gains `capture`, and `assignment` gains `id`. Gate 16.
- **Migrations.** The expected tables gain `capture_nonces`; after rollback the type
  `capture_nonce_status` is gone. Gate 1.
- **Shared.** SPEC.md section 10.4, tests 127 to 130. Gate 130.

Every other suite keeps its count.

**D73's minimum tests, where each lands.** Non-assigned wallet: 8, 11. No issuance before
acceptance: 9. None for a completed, cancelled or expired bounty: 10. Unpredictably distinct: 6
(and 1 for propagation). Expired rejected: 20. Consumed rejected: 19. Another bounty, Scout or
earlier assignment: 22, 11. Re-issue supersedes: 4, 5, 7. Evidence under a superseded nonce
cannot be A1: 21 here, graded in P5. Consumed exactly once: 19, 7. Offline evidence without a
valid nonce cannot be A1: P5, per section 17.9.

### 17.12 The live run is deferred to P4 (D136)

No bounty is funded for P3. P4's first live run on the A30 must also show, from raw output:

1. Start Capture at the spot issues a nonce, and the row holds the start fix as sent.
2. The phone's countdown ends at the response's `expires_at`, judged against `server_time`.
3. A second Start after the warning supersedes the first: two rows, one `SUPERSEDED`.
4. Start Capture indoors, or with the phone moved away, shows the phone's own failure numbers.
5. The request log line for the call carries the path only, with no coordinates.

---

## 18. Evidence upload and submission

Session 20 (P4). Normative; written before implementation. The client is
`apps/mobile/CAPTURE.md` section 7. The manifest, its root and the signed statement are
`packages/shared/SPEC.md` section 11. Rulings: D138 (Umair) and D139 to D144.

### 18.1 What P4 adds

Migration 13 (section 18.2); the evidence store configuration and client (18.3, 18.4);
`POST /bounties/:id/evidence/upload-url` (18.5); `POST /bounties/:id/submission` (18.6); the
views and section 17.6's new step (18.7); stated limits (18.8); error codes (18.9); tests and two
scripts (18.10); the live run (18.11).

A submission moves no bounty or assignment state (D142). `bounties.state` follows confirmed chain
state (D79), and the chain reaches `Submitted` only at `submit_attestation`, which is P5's. Until
then the bounty stays `ACCEPTED`, the assignment `ACTIVE`, and the `submissions` row is the
record.

### 18.2 Migration 13

`submissions` and `evidence_items` exist since migration 1 and have never been written. Up
refuses to run if either holds a row. Up, in order:

1. `submissions`: drop `manifest_hash` and the foreign key `submissions_assignment_id_fkey`;
   rename `merkle_root` to `evidence_root`; drop `NOT NULL` from `achieved_assurance`, which P5
   sets; drop the default of `submitted_at`, which the clock sets. Add:

| Column | Type | Rule |
|---|---|---|
| `bounty_id` | `uuid` | not null |
| `scout_id` | `uuid` | not null |
| `capture_nonce_id` | `uuid` | not null, unique, references `capture_nonces (id)` |
| `manifest` | `text` | not null; `canonicalise(manifest)` exactly as received and checked |
| `statement_signature` | `bytea` | not null, exactly 64 bytes |

   Constraints: `submissions_binding_fkey`, a foreign key on `(assignment_id, bounty_id,
   scout_id)` to `assignments_binding_key`; `submissions_one_per_assignment`, unique on
   `assignment_id` (D138 ruling 3); `submissions_root_length`, `evidence_root` exactly 32 bytes.
2. `evidence_items`: add `byte_length bigint` not null and above 0; `lat text` and `lon text`,
   not null; `horizontal_accuracy_m integer` not null and 0 or more; `fixed_at timestamptz` not
   null. Constraints: `evidence_items_hash_length`, `hash` exactly 32 bytes;
   `evidence_items_one_per_requirement`, unique on `(submission_id, requirement_id)`.
   `c2pa_present` keeps its type and gains no default; P4 writes false.

Down, in reverse, restores migration 12's shape; like up, it refuses to run over rows.

Non-test gate, from raw output: `\d submissions` and `\d evidence_items` show the columns and
constraints above, and only `id` carries a default on either table.

### 18.3 Configuration

Seven keys join section 17.3's. The four marked *store* go together: all four set means the
evidence store is configured, none set means it is not and the two routes of sections 18.5 and
18.6 are not registered, and any other combination exits at startup. Every other key keeps
section 8.1's startup rule.

| Key | Default | Rule |
|---|---|---|
| `EVIDENCE_STORE_ENDPOINT` | *store* | `http` or `https` origin, no path, query or fragment |
| `EVIDENCE_STORE_BUCKET` | *store* | 3 to 63 of lowercase letters, digits and hyphens |
| `EVIDENCE_STORE_ACCESS_KEY_ID` | *store* | 1 to 128 printable ASCII characters |
| `EVIDENCE_STORE_SECRET_PATH` | *store* | a file holding the secret key on one line, not empty |
| `EVIDENCE_STORE_REGION` | `us-east-1` | the signing region; R2 uses `auto` |
| `EVIDENCE_MAX_BYTES` | 10485760 | positive integer; the largest photo accepted |
| `EVIDENCE_UPLOAD_URL_TTL_S` | 900 | positive integer, at most 900 (D4) |

The secret follows `JWT_SECRET_PATH`'s pattern: it lives in a file outside the repo, which
`scripts/dev.sh` requires to be mode 600, and it is never logged, echoed or returned.

The endpoint's host is signed into every upload URL, so the phone must reach that same host: in
development `http://127.0.0.1:7070` through `adb reverse`, which is also how the laptop reaches
it (D140).

### 18.4 The store

**Development** is versitygw on the laptop, serving a folder outside the repo; production is
Cloudflare R2 (D4). Both speak the S3 API; changing between them is configuration (D140).

**Object keys** are `evidence/<bounty_id>/<capture_session_id>/<requirement_id>/<photo_sha256>.jpg`,
all lowercase. A key names its content, so an upload retried with the same photo writes the same
object. A retaken photo has a new key; the replaced object stays unused, and its deletion is
O6's retention rule.

**Upload URLs** are presigned with AWS Signature Version 4 in query form, implemented in
`src/evidence/sigv4.ts` without an SDK (D140): method `PUT`, path style
(`/<bucket>/<key>`), payload `UNSIGNED-PAYLOAD`, expiry `EVIDENCE_UPLOAD_URL_TTL_S`, and signed
headers exactly `content-length`, `host` and `x-amz-checksum-sha256`. The store refuses any
upload whose length or sha256 differs from the signed values, so the stored bytes are the bytes
the phone hashed, and the API never reads a photo (SECURITY.md section 14). Verified on the
laptop's versitygw on 1 October (D139).

**The existence check** is a header-signed `HEAD` with `x-amz-checksum-mode: ENABLED`. It
returns the object's length and its base64 sha256, or 404.

**Interface.** Routes see only `EvidenceStore`:

```ts
interface EvidenceStore {
  presignPut(key: string, sha256: Uint8Array, byteLength: number, now: Date):
    { url: string; headers: Record<string, string>; expiresAt: Date };
  head(key: string): Promise<{ byteLength: number; sha256Base64: string } | null>;
}
```

`head` throws when the store cannot be reached or answers anything but 200 or 404. Tests inject
a double whose answers copy the shapes recorded from versitygw.

### 18.5 `POST /bounties/:id/evidence/upload-url`

The phone asks where to put one photo. Every call issues a fresh URL; nothing is written.

Body, a JSON object with exactly four keys:

| Key | Type | Rule |
|---|---|---|
| `capture_session_id` | string | uuid, lowercase |
| `requirement_id` | string | uuid, lowercase |
| `photo_sha256` | string | 64 lowercase hex characters |
| `byte_length` | number | a safe integer, 1 or more |

Check order; the first failing step wins:

1. **Auth.** 401 codes per section 8.1.
2. **Body shape.** Anything outside the table: `INVALID_REQUEST` (400).
3. **Size.** `byte_length` above `EVIDENCE_MAX_BYTES`: `EVIDENCE_TOO_LARGE` (400).
4. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
5. **Load.** No row: `NOT_FOUND` (404).
6. **Hidden.** As section 17.6 step 6: `NOT_FOUND` (404).
7. **State.** Not `ACCEPTED`: `BOUNTY_NOT_CAPTURABLE` (409).
8. **Holder**, as section 17.6 step 8: `NOT_ASSIGNED` (403).
9. **Submitted.** The assignment has a `submissions` row: `ALREADY_SUBMITTED` (409).
10. **Requirement.** `requirement_id` is not an id in the policy's `evidence_requirements`:
    `UNKNOWN_REQUIREMENT` (400).
11. **Session.** The `capture_nonces` row whose `id` is `capture_session_id` must belong to this
    assignment, have status `ACTIVE`, and satisfy `now < expires_at +
    CAPTURE_SUBMISSION_GRACE_S`; otherwise `CAPTURE_SESSION_NOT_LIVE` (409). The grace lets a
    photo taken before `expires_at` finish uploading after it (D132).
12. **Respond** 200 with an object whose single key `upload` is:

| Key | Value |
|---|---|
| `method` | `PUT` |
| `url` | the presigned URL |
| `headers` | exactly `content-type` (`image/jpeg`) and `x-amz-checksum-sha256` (base64) |
| `expires_at` | the URL's expiry, ISO 8601 UTC |

The phone sends exactly those headers; its HTTP client sets `content-length` from the file. The
URL is never logged, stored or returned by any other route (SECURITY.md section 3).

### 18.6 `POST /bounties/:id/submission`

The Scout submits. Body, a JSON object with exactly two keys: `manifest`, an object, and
`signature`, 128 lowercase hex characters, the 64-byte ed25519 signature over section 11.6's
statement.

Check order; the first failing step wins:

1. **Auth.** 401 codes per section 8.1.
2. **Body shape.** Anything outside the rule above: `INVALID_REQUEST` (400).
3. **Manifest.** `checkEvidenceManifest` (SPEC.md section 11.7) throws: `INVALID_MANIFEST`
   (400).
4. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
5. **Load.** No row: `NOT_FOUND` (404).
6. **Hidden.** As section 17.6 step 6: `NOT_FOUND` (404).
7. **State.** Not `ACCEPTED`: `BOUNTY_NOT_CAPTURABLE` (409).
8. **Holder**, as section 17.6 step 8: `NOT_ASSIGNED` (403).
9. **Submitted.** The assignment has a `submissions` row. If its `evidence_root` equals this
   manifest's root and its `statement_signature` equals `signature`, respond 200 with step 17's
   body for that row: a retry after a lost response. Otherwise `ALREADY_SUBMITTED` (409).
10. **Bindings.** The header's `bounty_id` is the path id, `assignment_id` the holder's
    assignment, `scout` the caller's wallet, `policy_hash` the bounty's policy hash in hex, and
    `deployment_id` the configuration account's; otherwise `MANIFEST_MISMATCH` (400).
11. **Requirements.** Every item's `requirement_id` is in the policy, else
    `UNKNOWN_REQUIREMENT` (400); the items follow the policy's order, else `MANIFEST_MISMATCH`
    (400); every requirement with `required` true has an item, else `REQUIREMENTS_INCOMPLETE`
    (400); no `byte_length` exceeds `EVIDENCE_MAX_BYTES`, else `EVIDENCE_TOO_LARGE` (400).
12. **Signature.** `signature` verifies, under the caller's wallet key, over
    `evidenceStatement(id, evidenceRoot(manifest))`; otherwise `SUBMISSION_SIGNATURE_INVALID`
    (400).
13. **Session.** The `capture_nonces` row whose `value` is the header's `capture_nonce` and
    whose `assignment_id` is the holder's assignment; none is `CAPTURE_NONCE_INVALID` (409). Its
    `id` is the capture-session id of step 15's keys.
14. **Times and places.** Every item's `captured_at` lies in `[issued_at, expires_at)` of that
    row, else `CAPTURED_OUTSIDE_SESSION` (400). Every item passes `checkCaptureStart` with its
    own `lat`, `lon` and `horizontal_accuracy_m`, the policy's `lat`, `lon` and
    `capture_radius_m`, and `LOCATION_MAX_ACCURACY_M`: `IMPRECISE` is `LOCATION_TOO_IMPRECISE`
    and `TOO_FAR` is `LOCATION_TOO_FAR` (400) (D143).
15. **Uploads.** For every item, `head` of its key: null, a different length or a different
    sha256 is `EVIDENCE_NOT_UPLOADED` (409); `head` throwing is `STORAGE_UNAVAILABLE` (503).
16. **Write**, one transaction:
    1. Lock the bounty row, then the assignment row. If step 7 or 8 would now fail, roll back
       and return that step's code. If a `submissions` row now exists, roll back and apply step
       9's rule.
    2. `consumeCaptureNonce` (section 17.8) with the header's nonce, the path id, the holder's
       assignment, the caller and the configured `deployment_id`:
       - `CONSUMED`: insert the `submissions` row (the assignment, bounty and caller; the nonce
         row's `id`; `manifest` as `canonicalise(manifest)`; the root; the signature;
         `achieved_assurance` and `attester_signature` null; `submitted_at` the clock) and one
         `evidence_items` row per item (its key, `photo_sha256` as `hash`, `c2pa_present`
         false, and the item's fields); commit.
       - `EXPIRED`: commit, keeping the nonce's new status; `CAPTURE_SESSION_EXPIRED` (409).
       - `SUPERSEDED`: roll back; `CAPTURE_SESSION_SUPERSEDED` (409).
       - `ALREADY_CONSUMED`: roll back; `CAPTURE_SESSION_USED` (409).
       - `UNKNOWN`, `BINDING_MISMATCH`: roll back; `CAPTURE_NONCE_INVALID` (409).
17. **Respond** 201 with an object whose single key `submission` holds `id`, `submitted_at`
    (ISO 8601 UTC), `evidence_root` (64 lowercase hex) and `item_count`.

Steps 13 to 15 read without locks and step 16 decides: a nonce superseded or consumed between
them is caught by `consumeCaptureNonce` under its row lock. Nothing is written before step 16.

The route is registered only when the chain dependencies exist, for `deployment_id`, and the
store is configured. The body is never logged: it carries every photo's coordinates.

### 18.7 Views, and section 17.6's new step

- **Assigned-Scout view** (section 16.4) gains `submission`: null, or an object with `id`,
  `submitted_at`, `evidence_root` and `item_count`. After a submission, `capture.capture_nonce`
  is null, because the row is `CONSUMED`.
- **Section 17.7's `capture_nonce` object** gains `submit_by`, ISO 8601 UTC: `expires_at` plus
  `CAPTURE_SUBMISSION_GRACE_S`, the last moment an upload URL is issued or a submission can
  consume the nonce. The phone shows it and stops retrying at it (CAPTURE.md section 7.4).
- **Owner view** of a bounty in state `ACCEPTED` gains `submission`: null, or an object with
  exactly `submitted_at` and `item_count` (D138 ruling 5). No photo, key, coordinate, root or
  Scout detail reaches the requester before P6. Owner views of other states are unchanged.
- **Public view** is unchanged.
- **Section 17.6** gains step 8a, after the holder check: the assignment has a `submissions`
  row: `ALREADY_SUBMITTED` (409). A submitted mission cannot start a new capture session.

### 18.8 Stated limits

- `captured_at` is the phone's claim, made on its estimate of the server's clock; `lat`, `lon`
  and the accuracy are the phone's reported fix. Step 14 keeps honest phones and the server in
  agreement; it does not prove when or where a photo was taken (D133, D73).
- Step 15 proves the store holds bytes of the declared length and sha256. It says nothing about
  what they depict (HANDOFF, honest limit).
- The statement signature proves the Scout's wallet committed to the root. It does not make the
  photos genuine.

### 18.9 Error codes

| Code | Status | Failure |
|---|---|---|
| `EVIDENCE_TOO_LARGE` | 400 | a photo above `EVIDENCE_MAX_BYTES` (18.5 step 3, 18.6 step 11) |
| `ALREADY_SUBMITTED` | 409 | the assignment already has a submission (18.5, 18.6, 17.6) |
| `UNKNOWN_REQUIREMENT` | 400 | a requirement id not in the policy (18.5 step 10, 18.6 step 11) |
| `CAPTURE_SESSION_NOT_LIVE` | 409 | the session is not this assignment's live one (18.5 step 11) |
| `INVALID_MANIFEST` | 400 | the manifest fails SPEC.md section 11 (18.6 step 3) |
| `MANIFEST_MISMATCH` | 400 | a header binding or the item order is wrong (steps 10, 11) |
| `REQUIREMENTS_INCOMPLETE` | 400 | a required requirement has no item (step 11) |
| `SUBMISSION_SIGNATURE_INVALID` | 400 | the statement signature fails (step 12) |
| `CAPTURE_NONCE_INVALID` | 409 | no such nonce for this assignment (steps 13, 16) |
| `CAPTURED_OUTSIDE_SESSION` | 400 | a capture time outside the session (step 14) |
| `EVIDENCE_NOT_UPLOADED` | 409 | a photo is missing from the store or differs (step 15) |
| `STORAGE_UNAVAILABLE` | 503 | the store could not be asked (step 15) |
| `CAPTURE_SESSION_EXPIRED` | 409 | the nonce's grace has passed (step 16) |
| `CAPTURE_SESSION_SUPERSEDED` | 409 | a later Start replaced the session (step 16) |
| `CAPTURE_SESSION_USED` | 409 | the nonce was consumed without this submission (step 16) |

Reused: `INVALID_REQUEST`, `NOT_FOUND`, `BOUNTY_NOT_CAPTURABLE`, `NOT_ASSIGNED`,
`LOCATION_TOO_IMPRECISE`, `LOCATION_TOO_FAR` and the 401 codes.

### 18.10 Tests and scripts

A new file, `apps/api/test/evidence.test.ts`, named in the test script after `capture.test.ts`.
The bounty and policy come from the recorded Session 18 create response, as section 17.11's do.
The acceptance is seeded by SQL for a Scout whose wallet is the SPEC.md section 11.8 test key,
because the signature tests need a key the suite holds. Clock, randomness and store are injected;
the store double's answers copy shapes recorded from versitygw. Each negative test is shown red
before the gate by a scripted mutation of the check it names. D36 gate: `tests 26, pass 26, fail
0`.

The valid submission below has two required items, both uploaded, taken at the policy's spot
with accuracy 12 inside a session issued two hours before the deadline.

Upload URL:

1. The holder, live session: 200; `upload` has exactly section 18.5's keys and `headers` exactly
   its two; the checksum is the digest in base64; `expires_at` is the clock plus 900 s; the
   double recorded the key of section 18.4, the length and the digest.
2. `CAPTURE_SESSION_NOT_LIVE`: at `expires_at + 480 s`; a superseded session; another
   assignment's session; a session id never issued. At `expires_at + 479 s`: 200 (five asserts).
3. `byte_length` one above the maximum: `EVIDENCE_TOO_LARGE`; exactly the maximum: 200.
4. A requirement id not in the policy: `UNKNOWN_REQUIREMENT`.
5. `INVALID_REQUEST`: no body; a fifth key; an uppercase digest; `byte_length` 0; `byte_length`
   1.5; a session id that is not a uuid (six asserts).
6. The requester and a stranger: `NOT_ASSIGNED`; an `AVAILABLE` bounty: `BOUNTY_NOT_CAPTURABLE`;
   no token: `TOKEN_MISSING`; an unknown id: `NOT_FOUND` (five asserts).

Submission:

7. The valid submission: 201 with exactly step 17's keys; the row holds the canonical manifest,
   the root recomputed from it, the signature, the nonce row's id, null assurance, `submitted_at`
   the clock; two `evidence_items` rows with their keys and fields; the nonce `CONSUMED` at the
   clock; the bounty `ACCEPTED` and the assignment `ACTIVE`, unchanged.
8. The same body again: 200, the same body, one row. A different, validly signed manifest
   afterwards: `ALREADY_SUBMITTED`. An upload URL afterwards: `ALREADY_SUBMITTED`.
9. A policy with a third, optional requirement and no item for it: 201. The same with a required
   item removed: `REQUIREMENTS_INCOMPLETE`.
10. Items swapped: `MANIFEST_MISMATCH`; an item naming a requirement outside the policy:
    `UNKNOWN_REQUIREMENT`.
11. `MANIFEST_MISMATCH` for the header's bounty id, assignment id, Scout, policy hash and
    deployment id, one at a time, each re-signed (five asserts).
12. `INVALID_REQUEST`: no body; no `signature`; a 127-character signature. `INVALID_MANIFEST`: an
    uppercase digit in the nonce (four asserts).
13. `SUBMISSION_SIGNATURE_INVALID`: one bit flipped; signed by another key; a valid signature
    over another root (three asserts).
14. `CAPTURE_NONCE_INVALID`: a nonce never issued; another assignment's nonce (two asserts).
15. `CAPTURED_OUTSIDE_SESSION` at `issued_at` minus 1 ms and at `expires_at`; 201 at
    `expires_at` minus 1 ms (three asserts, fresh seeds each).
16. An item's accuracy 201: `LOCATION_TOO_IMPRECISE`; an item north by 0.002 with accuracy
    `floor(distance - 151)`: `LOCATION_TOO_FAR`; with `ceil(distance - 149)`: 201. Amendment A1
    (Session 20, before the code): the manifest's accuracy is a whole number (SPEC.md 11.3), so
    the values first written here, 200.5 and `distance - 150` plus or minus 1, could not be sent.
17. `EVIDENCE_NOT_UPLOADED` for an item never uploaded and for one stored with another length;
    `STORAGE_UNAVAILABLE` when `head` throws; the nonce still `ACTIVE` after each (three asserts).
18. At `expires_at + 480 s`: `CAPTURE_SESSION_EXPIRED`, the nonce row `EXPIRED`, no submission.
19. A second Start after the uploads: `CAPTURE_SESSION_SUPERSEDED`, no submission.
20. A nonce set `CONSUMED` by SQL with no submission: `CAPTURE_SESSION_USED`.
21. The nonce row's `deployment_id` set to 3 by SQL: `CAPTURE_NONCE_INVALID`, the row unchanged.
22. The valid body sent twice together: one 201 and one 200, one row.
23. Views: the assigned-Scout view's `submission` is null before and step 17's object after, and
    its `capture.capture_nonce` null after; the nonce object's `submit_by` is `expires_at` plus
    480 s; the owner view of the `ACCEPTED` bounty has `submission` with exactly `submitted_at`
    and `item_count`; the public view is unchanged; a capture-nonce request after the submission
    is `ALREADY_SUBMITTED`.
24. Privacy: the upload URL, the signature and every item's `lat` appear in no log line captured
    through a stream; the request log lines carry the paths only.
25. The presigner reproduces AWS's published Signature Version 4 query example (the `GET` of
    `test.txt` in `examplebucket`, 24 May 2013, signature
    `aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`), and for a `PUT` lists
    exactly `content-length;host;x-amz-checksum-sha256` as signed headers.
26. `loadConfig`: none of the store keys, no store; all four, the three defaults; two of the
    four, a throw; `EVIDENCE_UPLOAD_URL_TTL_S` 901, a throw; an empty secret file, a throw (five
    asserts).

Other suites:

- **Capture.** Tests 1 and 17: the nonce object's keys gain `submit_by`. Gate 25.
- **Acceptance.** Test 5's key set gains `submission`. Gate 16.
- **Migrations.** Unchanged: both tables already exist. Gate 1.

Every other suite keeps its count.

**Scripts**, run by hand, not in the gate:

- `apps/api/scripts/evidence-store.sh` starts versitygw on `127.0.0.1:7070` over
  `~/bountycam-evidence`, with its keys read from `~/bountycam-env` rather than the command line.
- `apps/api/scripts/evidence-store-check.mjs` creates the bucket if absent and runs the spike's
  nine storage checks (D139) through `src/evidence`, against the configured store.
- `apps/api/scripts/submission-check.mjs <bounty_id>` reads the submission, recomputes the root
  from the stored manifest, verifies the statement signature, and downloads every photo through
  a presigned `GET` to recompute its sha256. Each result prints as one PASS or FAIL line.

### 18.11 The live run

On the A30 and the Seeker, with the API, versitygw and Metro on the laptop. Setup: versitygw
through `evidence-store.sh`; the store keys in `~/bountycam-env/api.env`; `evidence-store-check`
passes; `adb reverse` for 3000, 8081 and 7070 on both phones. A fresh bounty funded from the
Seeker at a spot you can stand at, with two required photo requirements and one optional, and
the default 7200-second completion window; accepted from the A30. From raw output:

1. Section 17.12's five items.
2. Each required photo reaches Uploaded; the Metro log shows each photo's size and hash time;
   `~/bountycam-evidence` holds objects named by their digests.
3. Submit: what Solflare shows for the statement is recorded; the response is 201.
4. `submission-check` passes every line; the nonce row is `CONSUMED`; the bounty is `ACCEPTED`
   and the assignment `ACTIVE`.
5. The Seeker's bounty screen reads "Evidence received, being checked." with the time and count.
6. The API's log lines for the upload URLs and the submission carry paths only: no URL, no
   coordinates, no signature.

---

## 19. The verifier and the attestation

Session 21 (P5). Normative; written before implementation. Rulings: D146 (Umair) and D147 to
D153. The message is `packages/shared/MESSAGES.md` section 3, built by `attestationMessage`
(`packages/shared/SPEC.md` section 12); the instruction is `programs/escrow/SPEC.md` section 7.5.
What the phones show is `apps/mobile/CAPTURE.md` section 8.

### 19.1 What P5 adds

Migration 14 (section 19.2); the verifier's configuration and process (19.3, 19.4); its loop
(19.5); the checks and the grade (19.6, 19.7); signing (19.8); the transaction (19.9);
confirmation and the projection (19.10); views (19.11); logging (19.12); stated limits (19.13);
tests and a script (19.14); the live run (19.15).

### 19.2 Migration 14

Up, in order:

1. `CREATE TYPE attestation_status AS ENUM ('PENDING', 'SIGNED', 'SUBMITTED', 'REFUSED',
   'SHORTFALL', 'LAPSED')`.
2. The table `attestations`, one row per submission (D148):

| Column | Type | Rule |
|---|---|---|
| `submission_id` | `uuid` | primary key, references `submissions (id)` |
| `status` | `attestation_status` | not null |
| `achieved_assurance` | `smallint` | 0 to 4; the grade, once graded |
| `message` | `bytea` | exactly 261 bytes; the signed `BOUNTYCAM_ATTESTATION_V1` |
| `signature` | `bytea` | exactly 64 bytes |
| `reason` | `text` | the refusal or lapse code of section 19.6 |
| `tries` | `integer` | not null, 0 or more; consecutive transient failures |
| `sends` | `integer` | not null, 0 or more; transactions sent |
| `next_attempt_at` | `timestamptz` | not null |
| `tx_signature` | `text` | base58; the last transaction sent |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

   Constraints: `attestations_signed`, `status NOT IN ('SIGNED', 'SUBMITTED') OR message IS NOT
   NULL` (amendment A1); `attestations_signature_pair`, `(message IS NULL) = (signature IS NULL)`;
   `attestations_graded`, `status NOT IN ('SIGNED', 'SUBMITTED', 'SHORTFALL') OR
   achieved_assurance IS NOT NULL`; `attestations_reason`, `(status IN ('REFUSED', 'LAPSED')) =
   (reason IS NOT NULL)`; `attestations_submitted_tx`, `status <> 'SUBMITTED' OR tx_signature IS
   NOT NULL`; the two length checks and the assurance range. The partial index
   `attestations_due_idx` on `(next_attempt_at) WHERE status IN ('PENDING', 'SIGNED')`.

No column has a default. Down drops the table and the type; valid against any table state.

Non-test gate, from raw output: `\d attestations` shows the columns and constraints above and
no default.

**Amendment A1 (Session 21 build).** `attestations_signed` was first written as an equality,
which forbade a row that had been signed from ever leaving `SIGNED` or `SUBMITTED` with its
message: section 19.10's `CHAIN_STATE` refusal and section 19.9's lapse of a `SIGNED` row both
violate it. The rule is now one-way: `SIGNED` and `SUBMITTED` require the signed bytes, and a
row refused or lapsed after signing keeps them, so the record of what was signed survives.
Section 19.14 test 16 checks that a refused row keeps its message.

### 19.3 Configuration

The verifier reads the API's environment file through its own loader. It requires
`DATABASE_URL`, `SOLANA_RPC_URL`, `ESCROW_PROGRAM_ID`, `ESCROW_CONFIG_ACCOUNT` and the four store
keys of section 18.3; it reads section 17.3's capture keys and `EVIDENCE_MAX_BYTES` with their
defaults; and it adds:

| Key | Default | Rule |
|---|---|---|
| `ATTESTER_KEY_PATH` | required | a Solana keypair file, a JSON array of 64 bytes, mode 600 |
| `RELAYER_KEY_PATH` | required | the same form |
| `VERIFIER_POLL_S` | 5 | positive integer; seconds between ticks |
| `VERIFIER_DEADLINE_MARGIN_S` | 30 | positive integer; no send this close to the deadline |
| `VERIFIER_CONFIRM_S` | 60 | positive integer; how long one send waits for confirmation |

Startup, each failure exiting non-zero before the first tick: each key file parses and its
public half matches its seed, as `loadEligibilityConfig` checks; the attester's public key
equals the configuration account's `attester_authority`, read from the chain at `confirmed`;
the relayer key differs from the attester key; and `VERIFIER_DEADLINE_MARGIN_S <
CAPTURE_DEADLINE_BUFFER_S - CAPTURE_SUBMISSION_GRACE_S` (D152). `deployment_id` comes from the
configuration account, as the API's does.

The API's `loadConfig` never reads `ATTESTER_KEY_PATH` or `RELAYER_KEY_PATH`, and the API
process never holds either key (D147).

### 19.4 The process

`apps/api/src/verifier/main.ts`, started by `apps/api/scripts/verifier.sh`, which loads
`~/bountycam-env/api.env` and checks that it and both key files are mode 600, as `dev.sh` does,
printing paths but never contents. The process listens on no port. One instance runs.

`EvidenceStore` (section 18.4) gains one method, used by the verifier only:

```ts
get(key: string, maxBytes: number): Promise<Uint8Array | null>;
```

A header-signed `GET`, signed as `head` is but without `x-amz-checksum-mode`. 404 is null. It
stops reading after `maxBytes + 1` bytes and returns what it read, so an oversized object fails
the length comparison of section 19.6 step 8 rather than filling memory. It throws as `head`
does. No API route calls it.

### 19.5 The loop

Every `VERIFIER_POLL_S`, with `now` from the injectable clock:

1. **Enqueue.** For each `submissions` row with no `attestations` row, insert one: `PENDING`,
   `tries` and `sends` 0, `next_attempt_at`, `created_at` and `updated_at` `now`. A conflict on
   the key inserts nothing.
2. **Select** rows in `PENDING` or `SIGNED` whose `next_attempt_at` is at or before `now`,
   oldest `created_at` first.
3. **Run** each in turn: a `PENDING` row through sections 19.6 to 19.10, a `SIGNED` row through
   section 19.6 steps 1 to 3 and then 19.9.

**Outcomes.** *Refuse*: status `REFUSED`, the code as `reason`; final. *Lapse*: status
`LAPSED`, reason `DEADLINE`; final. *Retry*: the status is kept, `tries` increases by one, and
`next_attempt_at` is `now` plus 5, 10, 20, 40 or 60 seconds for `tries` 1, 2, 3, 4 and 5 or
more. Signing (section 19.8) sets `tries` to 0. Every write sets `updated_at`.

### 19.6 The checks

For a `PENDING` row. Steps in order; the first that decides ends the run. Nothing is written
before step 8 passes except an outcome.

1. **Load** the submission, its `evidence_items`, its `capture_nonces` row by
   `capture_nonce_id`, its assignment, the bounty with `program_account`, the policy's
   `canonical_json` and `policy_hash`, and the requester's and Scout's wallets.
2. **Deadline.** `now` later than the assignment's `deadline` minus
   `VERIFIER_DEADLINE_MARGIN_S`: lapse.
3. **Chain.** Read `program_account` at `confirmed`. A reader failure: retry. No account, or
   one `decodeBountyAccount` rejects: refuse, `CHAIN_STATE`. For a `SIGNED` row, `Submitted`
   goes to section 19.10's projection; for a `PENDING` row it is refused, `CHAIN_STATE`, since
   no attestation was signed. `Accepted` continues with `readAcceptance`, whose `BAD_TAIL` is
   `CHAIN_STATE`; every other state is refused, `CHAIN_STATE`.
4. **Bindings** (D77, D84). `sha256` of the UTF-8 `canonical_json` equals `policy_hash`, and
   every row of section 2.6 agrees exactly as section 15.3 step 6 checks it, by the same
   function; otherwise refuse, `BINDING_MISMATCH`.
5. **Parties.** The account's `scout` is the Scout's wallet decoded, and its `deadline` is the
   assignment's `deadline` in whole seconds; otherwise refuse, `PARTY_MISMATCH`.
6. **Submission.** All of: the stored `manifest` equals `canonicalise` of
   `checkEvidenceManifest` applied to its parse; `evidenceRoot` of it equals `evidence_root`; the
   header's `bounty_id`, `assignment_id`, `scout`, `policy_hash` and `deployment_id` are the
   bounty's, the assignment's, the Scout's wallet, the policy hash in hex and the configured
   deployment; `statement_signature` verifies under the Scout's wallet over
   `evidenceStatement(bounty id, evidence_root)`; and the items and the `evidence_items` rows
   correspond one to one by `requirement_id`, with equal digest, length, `captured_at`, `lat`,
   `lon`, `horizontal_accuracy_m` and `fixed_at`. Otherwise refuse, `SUBMISSION_INVALID`.
7. **Requirements**, as section 18.6 step 11 against the policy: every item's requirement in
   the policy, in its order, and every requirement with `required` true present. Otherwise
   refuse, `REQUIREMENTS_INCOMPLETE`.
8. **Photos.** For each item, `get(storage_key, EVIDENCE_MAX_BYTES)`. A throw: retry. Null, a
   length other than `byte_length`, or a `sha256` other than the item's digest: refuse,
   `EVIDENCE_MISSING` (D146 ruling 1).

### 19.7 The grade

**A1** when all of these hold; otherwise **A0** (D149):

- the nonce row is the submission's `capture_nonce_id`, its status is `CONSUMED`, its `value` in
  lowercase hex is the manifest's `capture_nonce`, and its assignment, bounty, Scout and
  `deployment_id` are the submission's;
- every item's `captured_at` lies in `[issued_at, expires_at)` of that row;
- every item passes `checkCaptureStart` with its own `lat`, `lon` and `horizontal_accuracy_m`,
  the policy's `lat`, `lon` and `capture_radius_m`, and `LOCATION_MAX_ACCURACY_M` (D143).

The thresholds are P4's; P5 does not tighten them. Levels above A1 wait for A2 and A3.

**Shortfall.** When the grade is below the account's `required_assurance`: status
`SHORTFALL`, `achieved_assurance` the grade; nothing is signed or sent (D85, D149).

### 19.8 Signing

`issued_at` is the clock's `now` in whole seconds, rounded down, as an `i64`. The message is
`attestationMessage` with `deploymentId` from the configuration account; `programId` the
escrow's; `bountyId`, `requester`, `scout`, `policyHash`, `eligibilityProfileHash`,
`requiredAssurance`, `deadline` and `reviewWindowSecs` from the account read in step 3;
`evidenceRoot` the submission's; `achievedAssurance` the grade; `issuedAt` as above. The
signature is ed25519 over the message with the attester's seed, and is verified under the
attester's public key before it is stored.

Write: status `SIGNED`, the grade, the message and the signature, `next_attempt_at` `now`. The
row is never signed again: every send uses the stored bytes (D150).

### 19.9 The transaction

Built in `apps/api/src/chain/tx.ts` as a legacy message (D151):

| Index | Account key | Signer | Writable |
|---|---|---|---|
| 0 | the relayer, fee payer | yes | yes |
| 1 | the bounty account | no | yes |
| 2 | the configuration account | no | no |
| 3 | `Sysvar1nstructions1111111111111111111111111` | no | no |
| 4 | `Ed25519SigVerify111111111111111111111111111` | no | no |
| 5 | the escrow program | no | no |

The header is 1, 0, 4. Instruction 0: program index 4, no accounts, data
`ed25519InstructionData(attester public key, signature, message)` (SPEC.md section 9.2), 373
bytes. Instruction 1: program index 5, accounts 2, 1 and 3 in that order, data the 8 bytes
`eedcff69b7d32853` (the first eight of `sha256` of `global:submit_attestation`), then
`evidence_root`, `achieved_assurance` as `u8`, `issued_at` as little-endian `i64` and
`verification_instruction_index` 0 as little-endian `u16`: 51 bytes. The recent blockhash comes
from `getLatestBlockhash` at `confirmed`; the relayer signs. Total 728 bytes.

The JSON-RPC reader gains `getLatestBlockhash`, `sendTransaction` (base64, preflight at
`confirmed`) and `getSignatureStatuses`, with section 15's error handling: no response body or
URL in any error.

**A send.** Step 2 runs first: past the margin, lapse. Then send, increase `sends`, store
`tx_signature`, and poll `getSignatureStatuses` every 2 seconds for up to `VERIFIER_CONFIRM_S`.
Confirmed or finalized without an error: section 19.10. An error, no confirmation in time, or a
reader failure: read the account. `Submitted` with this submission's root: section 19.10.
`Accepted`: retry, and the next send carries the same message and signature with a fresh
blockhash. Anything else: refuse, `CHAIN_STATE`.

### 19.10 Confirmation and the projection

Read the account at `confirmed`. It must be `Submitted`, with `evidence_root` the submission's
and `achieved_assurance` the row's; while it is still `Accepted`, retry; anything else is
refused, `CHAIN_STATE`. Then one transaction:

1. Lock the bounty row. `ACCEPTED`: set `SUBMITTED`. Already `SUBMITTED`: change nothing. Any
   other state: roll back and refuse, `CHAIN_STATE`.
2. Set the submission's `achieved_assurance` to the grade and `attester_signature` to the
   stored signature.
3. Set the row's status to `SUBMITTED`.

The assignment stays `ACTIVE` until P6. This projection is section 7.2's only writer of
`SUBMITTED` (D153).

### 19.11 Views

A submission's `verification` is `VERIFIED` when the bounty's state is `SUBMITTED` or any later
state; `NOT_VERIFIED` when its `attestations` row is `REFUSED`, `SHORTFALL` or `LAPSED`; and
`CHECKING` otherwise.

- **Assigned-Scout view.** Section 16.4 step 4a also serves a bounty in state `SUBMITTED`. Its
  `submission` object (section 18.7) gains `verification`.
- **Owner view.** A bounty in state `ACCEPTED` or `SUBMITTED` carries `submission` with exactly
  `submitted_at`, `item_count` and `verification`. Still no photo, key, coordinate, root, grade
  or Scout detail (D138 ruling 5, D146 ruling 3).
- **`GET /me/missions`** is unchanged: the assignment stays `ACTIVE`, so the mission stays
  listed.
- **Public view** is unchanged.

### 19.12 Logging

One line per outcome: the submission id, the status, the reason and the transaction
signature. `CHAIN_STATE`, `BINDING_MISMATCH`, `PARTY_MISMATCH`, `SUBMISSION_INVALID` and
`EVIDENCE_MISSING` are error-level. No line carries a URL, a store key, a coordinate, a message,
a signature other than the transaction's, or any key material.

### 19.13 Stated limits

- One verifier instance. A second would race to send; the chain takes one and the other's
  transaction fails, after which it reads the account and projects. Correct, but untested.
- A0 is reachable only if the database stops agreeing with what P4 checked (D149).
- After `REFUSED`, `SHORTFALL` or `LAPSED` the USDC returns only by CLI `expire_accepted` after
  the deadline (D146 ruling 2).
- The verifier's clock gives `issued_at`, which nothing compares (D82).
- A submission resent after the bounty became `SUBMITTED` answers `BOUNTY_NOT_CAPTURABLE` from
  section 18.6 step 7 rather than step 9's 200; the phone reloads the view, which shows the
  submission.
- The attester and relayer keys share one process in development. Production custody is
  SECURITY-PRODUCTION.md section 1's.

### 19.14 Tests and a script

A new file, `apps/api/test/verifier.test.ts`, named in the test script after
`evidence.test.ts`. The bounty, policy and submission are seeded by SQL from the recorded
Session 20 rows, re-signed with the SPEC.md section 11.8 test Scout key where a test needs a
manifest of its own. Clock, store, chain reader and sender are injected. The account is the
recorded `Accepted` account of bounty `3591bf4c`, with its `bounty_id`, `scout` and `deadline`
overwritten at section 16.6's offsets where a test needs others: harness setup, stated in the
test. Each negative test is shown red before the gate by a scripted mutation of the check it
names. D36 gate: `tests 20, pass 20, fail 0`.

1. **The valid job.** One tick after a submission: A1, `SIGNED`; the message equals
   `attestationMessage` of the account's fields, the root and grade 1; the signature verifies
   under the attester key; the sender received exactly `tx.ts`'s bytes. Confirmed: the bounty
   `SUBMITTED`, the submission's grade and signature set, the row `SUBMITTED` with the
   transaction signature, the assignment `ACTIVE`.
2. **Recorded data.** The `3591bf4c` manifest, root and statement signature pass step 6
   unchanged.
3. **Enqueue.** A submission without a row gets one `PENDING` row; a second tick adds none.
4. **Deadline.** At `deadline - 30 s` the job proceeds; one second later it is `LAPSED`, with no
   store read and no send (two asserts).
5. **Retry.** The reader throws: status kept, `tries` 1, due in 5 s; then 10, 20, 40, 60 and 60
   (six asserts).
6. **Chain state.** No account, `Funded`, `Refunded`, and `Submitted` for a `PENDING` row:
   `CHAIN_STATE` (four asserts).
7. **Bindings.** Each of reward, profile hash, required assurance, the three windows and the
   policy hash mismatched alone, and the canonical text altered by one byte:
   `BINDING_MISMATCH` (eight asserts).
8. **Parties.** Another Scout on the account; another deadline: `PARTY_MISMATCH`.
9. **Submission.** A non-canonical manifest text; the stored root altered; the signature with
   one bit flipped; an `evidence_items` digest differing from its item; the header's deployment
   id 3, re-signed: `SUBMISSION_INVALID` (five asserts).
10. **Requirements.** A required requirement without an item: `REQUIREMENTS_INCOMPLETE`.
11. **Photos.** `get` null; one byte longer; equal length, other bytes: `EVIDENCE_MISSING`. `get`
    throws: retry. The double saw `GET` on each item's key (five asserts).
12. **A0.** On a bounty requiring 0: the nonce row `SUPERSEDED` by SQL; an item's
    `captured_at` at `expires_at`, re-signed; an item 0.002 north with accuracy `floor(distance
    - 151)`, re-signed. Each `SIGNED` at 0 (three asserts).
13. **Shortfall.** The first case of test 12 on a bounty requiring 1: `SHORTFALL`, grade 0, no
    message, no send.
14. **A failed send.** The sender reports an error and the account is still `Accepted`: `SIGNED`,
    `sends` 1, `tries` 1; the next tick's transaction carries the identical message and
    signature (byte comparison).
15. **Unconfirmed, then found.** No confirmation within the window and the account `Submitted`
    with this root: projected.
16. **Restart.** A `SIGNED` row whose account is already `Submitted` with this root: projected
    with no send. With another root: `CHAIN_STATE` (two asserts).
17. **Projection.** The account `Submitted` with another grade: retry, nothing projected. The
    bounty row already `SUBMITTED`: the row `SUBMITTED`, nothing else changed (two asserts).
18. **Views.** `verification` is `CHECKING` before and `VERIFIED` after in both views; it is
    `NOT_VERIFIED` for `REFUSED`, `SHORTFALL` and `LAPSED`; the owner view of a `SUBMITTED`
    bounty has `submission` with exactly section 19.11's keys; the assigned-Scout view is served
    in `SUBMITTED`.
19. **The transaction.** For a fixed blockhash, relayer seed and attestation, `tx.ts`'s bytes
    equal the vector produced by `@solana/web3.js` in the architect's sandbox; the length is 728;
    instruction 1's data begins `eedcff69b7d32853`. After the live run the recorded transaction's
    message joins as a second vector.
20. **Configuration and logs.** The verifier's loader refuses: no attester key; a key file whose
    public half mismatches; the relayer key equal to the attester's; an attester other than the
    recorded configuration account's; a margin of 120 with the default buffer and grace (five
    asserts). The API's `loadConfig` starts with neither key path set. No log line from tests 1
    and 11 carries a store key, a coordinate, the message or the attestation signature in hex.

Other suites:

- **Migrations.** The expected table list gains `attestations`. Gate 1.
- **Evidence.** Tests 7 and 23: the `submission` objects gain `verification`, `CHECKING`. Gate 26.

Every other suite keeps its count.

**Script**, run by hand: `apps/api/scripts/attestation-check.mjs <bounty_id>` reads the
`attestations` row and the account, rebuilds the message from the account and the row's grade
and `issued_at`, compares it with the stored message, verifies the signature under the
configuration account's attester, confirms the account is `Submitted` with the submission's root
and grade, and confirms the transaction at `confirmed`. Each result prints as one PASS or FAIL
line.

### 19.15 The live run

On the A30 and the Seeker, with versitygw, the API, the verifier and Metro on the laptop. Setup as
section 18.11, plus `verifier.sh` running. A fresh bounty funded from the Seeker, two required
photo requirements, the default 7200-second completion window and `required_assurance` 1,
accepted from the A30. Every step happens between the accept and its deadline. From raw output:

1. Section 18.11 items 2 to 4.
2. The verifier's log shows the job `SIGNED` then `SUBMITTED` with its transaction signature;
   the time from submission to `SUBMITTED` is recorded.
3. `attestation-check` passes every line.
4. The bounty is `SUBMITTED`; the submission carries grade 1 and the attester signature.
5. The A30's Mission screen and the Seeker's bounty screen show CAPTURE.md section 8's verified
   lines.
6. The transaction is fetched and recorded; its message becomes section 19.14 test 19's
   second vector.
7. The verifier's log lines carry no URL, store key or coordinate.

The laptop needs a connection for the verifier to reach devnet. If it has none at the spot, the
job retries until it does, and the deadline still bounds it.

---

## 20. Review, settlement and the settlement projection

Session 22 (P6). Normative; written before implementation. Rulings: D155 (Umair) and D156 to
D163. The instructions are `programs/escrow/SPEC.md` sections 7.6 to 7.9 and 7.11, deployed since
18 September; P6 changes no program. The phone's side is `apps/mobile/REVIEW.md`; the shared
transaction checks are `packages/shared/SPEC.md` section 13.

### 20.1 What P6 adds

Migration 15 (section 20.2); reading the account's tail (20.3); the settlement projection (20.4);
`POST /bounties/:id/settlement` (20.5); the verifier's settlement pass and `release` (20.6); the
transactions the server builds (20.7); views (20.8); `GET /bounties/:id/evidence` (20.9);
`settle.mjs` (20.10); configuration, logging and error codes (20.11); stated limits (20.12); tests
(20.13); the live runs (20.14).

### 20.2 Migration 15

Up, in order:

1. `CREATE TYPE settlement_kind AS ENUM ('APPROVED', 'RELEASED', 'RESOLVED_PAID',
   'RESOLVED_REFUNDED', 'EXPIRED_REFUNDED')`.
2. The table `settlements`, one row per settled bounty (D158):

| Column | Type | Rule |
|---|---|---|
| `bounty_id` | `uuid` | primary key, references `bounties (id)` |
| `kind` | `settlement_kind` | not null |
| `tx_signature` | `text` | not null; base58 |
| `settled_at` | `timestamptz` | not null; the transaction's block time |
| `projected_at` | `timestamptz` | not null; the clock |

3. `decisions`: add `tx_signature text`; add the constraint `decisions_one_per_submission`,
   unique on `submission_id`; add `decisions_tx_signature`, `outcome = 'DISPUTE' OR tx_signature
   IS NOT NULL`. The table holds no rows (migration 1 to 14 wrote none); up refuses to run over a
   row.
4. `submissions`: add `review_ends_at timestamptz`, nullable.

No new column has a default. Down reverses each step; it refuses to run if `settlements` or
`decisions` holds a row.

Non-test gate, from raw output: `\d settlements` and `\d decisions` show the columns and
constraints above.

### 20.3 Reading the account's tail

`readTail(info)` in `src/chain/bounty.ts` decodes the six `Option` fields in serialised order
(escrow SPEC.md section 4.1) from byte 171: each a tag byte, 0 for none and 1 for some, followed
by the value only when the tag is 1. Values: `scout` 32 bytes, `deadline` `i64`, `submittedAt`
`i64`, `evidenceRoot` 32 bytes, `achievedAssurance` `u8`, `failedRequirementId` 16 bytes. A tag
other than 0 or 1, or data ending inside a field, is `BAD_TAIL`. `readAcceptance` and
`readSubmission` are unchanged. The reader is confirmed against the recorded `Accepted`,
`Submitted`, `Paid` and `Refunded` accounts (section 20.13 test 1).

Positions differ by path: after `expire_accepted` from `Accepted`, `submittedAt` is none, so every
later tag moves. Only a sequential reader handles both.

### 20.4 The projection (D157)

`projectSettlement(bountyId)` in `src/settlement/project.ts`. Steps in order; the first that
decides ends the call. Only step 8 writes.

1. **Load** the bounty with `program_account`, the requester's wallet, the policy's
   `canonical_json`, the assignment with `accepted_at` set (status `ACTIVE`, `COMPLETED` or
   `EXPIRED`), its Scout's wallet, and its submission if any.
   `PAID` and `REFUNDED` with a `settlements` row are `PROJECTED`, with no read. States other
   than `ACCEPTED`, `SUBMITTED` and `DISPUTED` are `NOT_APPLICABLE`.
2. **Read** the account at `confirmed`. A reader failure is `CHAIN_UNAVAILABLE`. No account is
   `BINDING_MISMATCH`: no settling instruction closes it (D96).
3. **Decode** the prefix and the tail (section 20.3). A failure, or an account `bounty_id` other
   than the row id's 16 bytes, is `BINDING_MISMATCH`.
4. **Scout.** The tail's `scout` is the assignment's Scout wallet decoded, else
   `PARTY_MISMATCH`.
5. **State.** By the chain state and the row's state:

| Chain | Row | Result |
|---|---|---|
| `Accepted` | `ACCEPTED` | `NOT_SETTLED`, nothing written |
| `Submitted` | `SUBMITTED` | `NOT_SETTLED`; step 8 sets `review_ends_at` if null |
| `Submitted` | `ACCEPTED` | `NOT_SETTLED`; the verifier projects `SUBMITTED` (19.10) |
| `Disputed` | `SUBMITTED` | step 6, `reject` |
| `Paid` | `SUBMITTED` | step 6, `approve` or `release` |
| `Paid` | `DISPUTED` | step 6, `resolve` paying the Scout |
| `Refunded` | `ACCEPTED` | step 6, `expire_accepted` |
| `Refunded` | `DISPUTED` | step 6, `resolve` refunding the requester |
| `Disputed` | `DISPUTED` | `NOT_SETTLED` |
| any other pair | | `UNPROJECTED_STATE` |

   For a chain state past `Accepted` reached from `SUBMITTED` or `DISPUTED`, the tail's
   `evidenceRoot` must equal the submission's, else `BINDING_MISMATCH`.
6. **Signature.** `getSignaturesForAddress(program_account, limit 20)` at `confirmed`, newest
   first. For each entry without an error, `getTransaction` at `confirmed` with
   `maxSupportedTransactionVersion` 0 and `json` encoding. The first transaction with a top-level
   instruction whose program is the escrow, whose account at the instruction's bounty position
   (escrow SPEC.md section 7: index 2 for `approve`, `release` and `expire_accepted`, 1 for
   `reject`, 3 for `resolve`) is `program_account`, and whose data begins with one of step 5's
   discriminators wins:

| Instruction | Discriminator (hex) |
|---|---|
| `approve` | `454ad9247375614c` |
| `release` | `fdf90fce1c7fc1f1` |
| `reject` | `87073f5583726fe0` |
| `resolve` | `f696ecce6c3f3a0a`, then the outcome byte: 0 `PayScout`, 1 `RefundRequester` |
| `expire_accepted` | `17526b3cd6ac3bbc` |

   A `resolve` whose outcome byte disagrees with the chain state is `BINDING_MISMATCH`. No match
   among the 20 is `CHAIN_UNAVAILABLE`: a signature list can lag the account, and the next caller
   tries again. A reader failure is `CHAIN_UNAVAILABLE`. `settled_at` is the transaction's
   `blockTime`.
7. **Requirement**, for `reject` only. The tail's `failedRequirementId` as a uuid is an `id` in
   the policy's `evidence_requirements`; if not, the outcome is `FOREIGN_REQUIREMENT` and step 8
   writes no `decisions` row (D161).
8. **Write**, one transaction. Lock the bounty row; if its state is no longer step 5's row state,
   roll back and run the call once more from step 1. Then by the instruction:
   - `reject`: the bounty `DISPUTED`; a `decisions` row (the submission, `REJECT`, the id,
     `reason` null, `decided_by` the requester, `decided_at` the clock, the signature) unless step
     7 said otherwise. The assignment stays `ACTIVE`.
   - `approve`: the bounty `PAID`; a `decisions` row (`APPROVE`, no id, the requester, the
     signature); `settlements` `APPROVED`; the assignment `COMPLETED`.
   - `release`: as `approve` without the `decisions` row; `settlements` `RELEASED`.
   - `resolve`, paying: the bounty `PAID`; `settlements` `RESOLVED_PAID`; the assignment
     `COMPLETED`. Refunding: the bounty `REFUNDED`; `RESOLVED_REFUNDED`; `COMPLETED`.
   - `expire_accepted`: the bounty `REFUNDED`; `settlements` `EXPIRED_REFUNDED`; the assignment
     `EXPIRED`.
   - In every case, and for `NOT_SETTLED` from chain `Submitted`, the submission's
     `review_ends_at` is set to `submittedAt` plus `review_window_secs` from the tail and prefix
     when it is null and a submission exists.

The outcomes are `PROJECTED`, `NOT_SETTLED`, `NOT_APPLICABLE`, `CHAIN_UNAVAILABLE`,
`BINDING_MISMATCH`, `PARTY_MISMATCH`, `UNPROJECTED_STATE` and `FOREIGN_REQUIREMENT`. The last four
are alarms: one error-level line naming the outcome and the bounty id, and nothing else.
`FOREIGN_REQUIREMENT` has still projected `DISPUTED`.

Commitment is `confirmed`, as section 15.3; section 14, item 9 applies.

Section 7.2's mapping is unchanged; its informative table is updated in place.

### 20.5 `POST /bounties/:id/settlement`

A phone asks the server to look, after every `approve` or `reject` attempt whatever the wallet
reported, and whenever it shows a bounty in `SUBMITTED` or `DISPUTED`. No body; the server reads
the chain.

1. **Auth.** 401 codes per section 8.1.
2. **Body.** Any present body is `INVALID_REQUEST` (400).
3. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
4. **Load.** No row: `NOT_FOUND` (404).
5. **Caller.** The requester, or the Scout of an assignment with `accepted_at` set. Anyone else:
   `NOT_FOUND` (404) for `DRAFT` and `CANCELLED`, `FORBIDDEN` (403) otherwise.
6. **Project** (section 20.4). `CHAIN_UNAVAILABLE` is 503; `BINDING_MISMATCH`, `PARTY_MISMATCH`
   and `UNPROJECTED_STATE` are `BINDING_MISMATCH` (409). Every other outcome continues.
7. **Respond** 200 with the caller's view as the row now stands: the owner view to the requester,
   the assigned-Scout view to the Scout.

`NOT_SETTLED` is a 200: the phone reads the state and repeats the call on REVIEW.md's schedule.

Registered only when the chain dependencies exist, as section 15.4's route is.

### 20.6 The verifier's settlement pass and `release` (D159)

After section 19.5's steps, each tick:

1. **Select** bounties in `SUBMITTED` or `DISPUTED`, oldest `created_at` first, at most 50.
2. **Project** each (section 20.4).
3. **Release** when the outcome is `NOT_SETTLED` from chain `Submitted`, `review_ends_at` is set,
   `now` is later than `review_ends_at` plus `VERIFIER_RELEASE_MARGIN_S`, and the bounty is not
   waiting out a retry. Build section 20.7's `release` transaction, send it with preflight at
   `confirmed`, and poll `getSignatureStatuses` every 2 seconds for up to `VERIFIER_CONFIRM_S`.
   Then, whatever happened, project again. `PROJECTED`: done. Still `NOT_SETTLED`: the bounty
   waits 5, 10, 20, 40, then 60 seconds before its next send, held in memory.

A `Disputed` bounty is projected and never released: only `resolve` exits it (D74).

### 20.7 Transactions the server builds

In `src/chain/tx.ts`, legacy messages built by hand as section 19.9's (D151), each pinned by a
vector produced with `@solana/web3.js` 1.98.4 in the architect's sandbox. Instruction account
orders and flags are the program's account structs (escrow SPEC.md sections 7.7, 7.9, 7.11). The
Associated Token program's idempotent create carries accounts payer (signer, writable), the
associated account (writable), its owner, the mint, the System program and the Token program, and
data the single byte 1.

| Transaction | Fee payer | Instructions |
|---|---|---|
| `release` | relayer | idempotent create of the Scout's payout account; `release` |
| `expire_accepted` | relayer | idempotent create of the requester's account; `expire_accepted` |
| `resolve` | relayer | idempotent create of the destination; `resolve`, signed by the arbiter |

`release` accounts: requester (writable), config, bounty (writable), mint, vault (writable),
Scout, Scout payout (writable), Token program; data the discriminator. `expire_accepted`: requester
(writable), config, bounty (writable), mint, vault (writable), requester's account (writable),
Token program. `resolve`: arbiter (signer), config, requester (writable), bounty (writable), mint,
vault (writable), destination (writable), Token program; data the discriminator and the outcome
byte. Every address is derived from the account just read and the configuration; nothing comes
from a caller (SECURITY.md section 2).

The JSON-RPC reader gains `getSignaturesForAddress` and `getTransaction`, with section 15's error
handling.

### 20.8 Views

- **Owner view** of a bounty in `ACCEPTED`, `SUBMITTED`, `DISPUTED`, `PAID` or `REFUNDED` carries
  `submission` (null, or section 19.11's three keys plus `review_ends_at`, ISO 8601 UTC or null),
  `dispute` (null, or an object with exactly `failed_requirement_id`, the uuid or null for
  `FOREIGN_REQUIREMENT`) and `settlement` (null, or an object with exactly `kind`,
  `tx_signature`, `settled_at` and `amount`, the reward as a base-unit string).
- **Assigned-Scout view.** Section 16.4 step 4a also serves `DISPUTED`, `PAID` and `REFUNDED`,
  to the Scout of the assignment with `accepted_at` set, whatever its status. It gains `dispute`
  and `settlement` as above. `REFUNDED` by `expire_accepted` is served too, so a Scout sees why a
  mission ended.
- **`GET /me/missions`.** Section 16.5 step 3 selects assignments in `ACTIVE`, `COMPLETED` or
  `EXPIRED` with `accepted_at` set. Ordering and the item shape are unchanged.
- **Public view** is unchanged. Discovery is unchanged.

No view carries a photo URL, a store key, a coordinate, the Scout's wallet or the requester's.

### 20.9 `GET /bounties/:id/evidence` (D156)

1. **Auth.** 401 codes per section 8.1.
2. **Parameters.** Any query parameter is `INVALID_REQUEST` (400).
3. **Id form**, as section 8.5 step 2: `NOT_FOUND` (404).
4. **Load.** No row: `NOT_FOUND` (404).
5. **Owner.** Not the requester: `NOT_FOUND` (404) for `DRAFT` and `CANCELLED`, `FORBIDDEN` (403)
   otherwise.
6. **Evidence.** The state is `SUBMITTED`, `DISPUTED`, `PAID` or `REFUNDED`, a submission exists
   and its `attestations` row is `SUBMITTED`; otherwise `NO_EVIDENCE` (409).
7. **Respond** 200 with an object whose single key `evidence` holds `expires_at` (ISO 8601 UTC)
   and `items`, in policy order, each with exactly `requirement_id`, `captured_at` and `url`.

`EvidenceStore` gains `presignGet(key, now)`: SigV4 in query form, method `GET`, path style,
payload `UNSIGNED-PAYLOAD`, signed header `host` only, expiry `EVIDENCE_READ_URL_TTL_S`. Every
URL in one response shares one expiry. Registered only when the store is configured.

### 20.10 `settle.mjs` (D162)

`apps/api/scripts/settle.mjs`, run by hand from `apps/api`, reading `~/bountycam-env/api.env`,
not in the gate:

- `release <bounty_id>`, `expire <bounty_id>`: the relayer signs section 20.7's transaction.
- `resolve <bounty_id> pay|refund`: prints the named requirement's prompt (or "not in the
  policy", D161), downloads every photo through `EvidenceStore.get` to
  `~/Downloads/bountycam-dispute-<bounty_id>/`, checking each against its stored sha256, then the
  arbiter signs and the relayer pays. It reads `ARBITER_KEY_PATH`, mode 600; the API and the
  verifier never read it.
- `project <bounty_id>`: sends nothing.

Each send first prints the chain state and asks once; each command ends with
`projectSettlement`'s outcome and, for a settlement, the explorer link of D155 ruling 6.

### 20.11 Configuration, logging and error codes

| Key | Reader | Default | Rule |
|---|---|---|---|
| `EVIDENCE_READ_URL_TTL_S` | API | 300 | positive integer, at most 900 |
| `VERIFIER_RELEASE_MARGIN_S` | verifier | 10 | positive integer |
| `ARBITER_KEY_PATH` | `settle.mjs` | none | a Solana keypair file, mode 600 |

Logging: one line per release send (the bounty id, the outcome, the transaction signature), and
section 20.4's alarms. No line carries a URL, a store key, a coordinate or key material.

| Code | Status | Failure |
|---|---|---|
| `NO_EVIDENCE` | 409 | no verified submission to show (section 20.9) |

Reused: `INVALID_REQUEST`, `NOT_FOUND`, `FORBIDDEN`, `BINDING_MISMATCH`, `CHAIN_UNAVAILABLE`.

### 20.12 Stated limits

- A `Submitted` account is approvable after its window closes as well as releasable; whichever
  lands first settles it, and the other fails on state. Both pay the same Scout the same amount.
- The verifier releases only while it runs. Release is permissionless, so `settle.mjs release`
  does the same by hand.
- A dispute the arbiter never resolves leaves the reward in the vault (D94).
- `expire_unaccepted` and funded `cancel` still have no projection; bounties `46551b54` and
  `b15bd4a5` stay `AVAILABLE` in the database after their cutoffs.
- A rejection that lands before the verifier projects `SUBMITTED` leaves the row `ACCEPTED`: the
  verifier refuses `CHAIN_STATE` and the projection answers `UNPROJECTED_STATE`. The phone offers
  Reject only on a `SUBMITTED` row, so only another client can cause it.
- The signature lookup reads 20 entries. A bounty account touched more than 20 times after
  settling would hide its settling transaction; nothing touches a settled account.

### 20.13 Tests

A new file, `apps/api/test/settlement.test.ts`, named in the test script after
`verifier.test.ts`. Fixtures are D163's recorded responses under
`apps/api/test/fixtures/devnet/`. Clock, chain reader, sender and store are injected. Each negative
test is shown red before the gate by a scripted mutation of the check it names. D36 gate: `tests
18, pass 18, fail 0`.

1. **Tail.** `readTail` of the recorded `Accepted`, `Submitted`, `Paid` and `Refunded` accounts
   gives their recorded fields; a tag of 2 and data cut inside `evidenceRoot` are `BAD_TAIL` (six
   asserts).
2. **Release transaction.** For fixed inputs the bytes equal the web3.js vector; the recorded
   release transaction's message is a second vector (two asserts).
3. **Expire and resolve transactions.** The bytes equal their web3.js vectors; the recorded
   expire transaction's message is a further vector (three asserts).
4. **Released.** The recorded `Paid` account and transactions: `PAID`, the assignment `COMPLETED`,
   `settlements` `RELEASED` with the recorded signature and block time, `review_ends_at` set, no
   `decisions` row.
5. **Approved.** The recorded release transaction with its data replaced by `approve`'s, as harness
   setup: `APPROVED`, a `decisions` `APPROVE` row by the requester with the signature.
6. **Disputed.** The recorded `Submitted` account with state 3 and a requirement id appended, and
   the recorded transaction with `reject`'s data, as harness setup: `DISPUTED`, a `REJECT` row
   with that id and the signature, the assignment `ACTIVE`.
7. **Foreign requirement.** Test 6 with an id outside the policy: `DISPUTED`, no `decisions` row,
   one error-level line `FOREIGN_REQUIREMENT`.
8. **Resolved.** From `DISPUTED`, `resolve` paying and refunding as harness setup: `PAID` and
   `REFUNDED` with their kinds; an outcome byte disagreeing with the state is `BINDING_MISMATCH`
   (three asserts).
9. **Expired.** The recorded `Refunded` account and transactions of `3591bf4c`: `REFUNDED`, the
   assignment `EXPIRED`, `EXPIRED_REFUNDED`.
10. **Not settled.** Chain `Submitted` with `review_ends_at` null: it is set, nothing else; chain
    `Accepted`: nothing written (two asserts).
11. **Idempotent.** A second call writes nothing; a `PAID` row with its `settlements` row reads
    nothing (two asserts).
12. **Lookup.** An errored entry and a non-escrow transaction are skipped; no match is
    `CHAIN_UNAVAILABLE` with nothing written; a throwing reader is `CHAIN_UNAVAILABLE` (four
    asserts).
13. **Alarms.** No account; another `bounty_id`; another Scout; chain `Funded` under `ACCEPTED`:
    each logs one line carrying only the outcome and the bounty id (four asserts).
14. **Settlement route.** Requester 200 owner view; Scout 200 assigned-Scout view; another user
    403; a `DRAFT` bounty for another user 404; a body 400; a throwing reader 503 (six asserts).
15. **Evidence route.** The requester gets one `GET` URL per item in policy order, over the item's
    key, with one expiry 300 s ahead; another user 403; `ACCEPTED` and an attestation `REFUSED`
    are `NO_EVIDENCE`; no log line carries a URL (five asserts).
16. **`presignGet`.** The AWS Signature Version 4 documentation's presigned `GET` example is
    reproduced byte for byte.
17. **Views.** The owner view in `DISPUTED`, `PAID` and `REFUNDED` has exactly section 20.8's
    keys; the assigned-Scout view is served in those states; `/me/missions` lists a `COMPLETED`
    and an accepted `EXPIRED` mission (three asserts).
18. **Release pass.** Before `review_ends_at` plus the margin, no send; after, one send of
    `tx.ts`'s bytes, then `PAID` and `RELEASED`; a failed send with the account now `Paid` is
    projected without a second send; with the account still `Submitted`, the next send waits 5 s;
    a `DISPUTED` bounty is projected and never sent (five asserts).

Other suites: **Migrations**, the table list gains `settlements` (gate 1). **Verifier**, unchanged
at 20. Every other suite keeps its count.

### 20.14 The live runs

Setup as section 19.15, plus `adb reverse tcp:7070 tcp:7070` on the Seeker, which now loads
photos. Before each run the store check prints 403. From raw output:

**Run A — approve.** A fresh bounty funded from the Seeker, two required photos,
`required_assurance` 1, accepted, captured and submitted on the A30, attested. On the Seeker: the
photos show; "Reject by HH:MM" shows; Approve, the confirm step, the wallet. Then: the bounty
`PAID`, `settlements` `APPROVED`; the payout transaction, opened from the explorer link, shows the
vault's 5 USDC reaching the A30's account; the A30, once reloaded, shows "Paid N USDC." with the
same link.

**Run B — reject and resolve.** A second bounty through the same steps to `SUBMITTED`. On the
Seeker inside the window: Reject, one requirement, the wallet. Then `DISPUTED` with the `REJECT`
row; both phones show their dispute lines. `settle.mjs resolve <id> pay` or `refund`, the arbiter's
choice after looking at the photos; the bounty `PAID` or `REFUNDED`, both phones showing the
arbiter's line and the link.

The release of `d649d6f4` and the three expiries (D163) precede both runs; their projection by
`settle.mjs project` follows the build.

### 20.15 Amendments found while implementing (Session 22)

Committed before the code they govern.

- **A1, tests 2 and 3.** `@solana/web3.js` sorts account keys within each signer and
  writable class, so no hand-built message equals its bytes unless it copies that sort.
  `tx.ts` keeps D163's order instead (section 20.7). Release and expire are pinned to the
  recorded messages, both as the recording script built them and as the landed transactions
  carry them. Resolve, which has no recording yet, is compared instruction by instruction
  (program, keys with their signer and writable flags, data), decoded from `tx.ts`'s bytes,
  with `test/fixtures/vectors/resolve_web3.json`, which web3.js 1.98.4 compiled from the same
  inputs.
- **A2, section 20.8.** `dispute` and `settlement` are keys of the owner view and the
  assigned-Scout view in `DISPUTED`, `PAID` and `REFUNDED` only. In `ACCEPTED` and `SUBMITTED`
  both views keep their keys, the requester's `submission` gaining `review_ends_at`. Reason:
  existing tests pin the assigned-Scout view's keys in `ACCEPTED`, and neither key can be
  non-null before settlement or a dispute.
- **A3, section 20.9 and test 16.** `presignGet(key, ttlS, now)` takes its lifetime as an
  argument; the API reads `EVIDENCE_READ_URL_TTL_S` into the configuration's own
  `evidenceReadUrlTtlS`, outside `EvidenceConfig`, whose shape a test pins. AWS's published
  presigned `GET` example is virtual-hosted and the store is path style, so test 16 cannot
  reproduce it: it checks that `presignGet` equals section 18.4's `presignQuery` over the
  path-style object path, and evidence test 25 already pins `presignQuery` to that example.
- **A4, existing tests.** The requester's `submission` key list in evidence test 23 and
  verifier test 18 gains `review_ends_at`; the migrations test's table list gains
  `settlements`. No count changes.
- **A5, section 20.6 and test 18.** Before sending, the release step reads the account again
  and builds `release` only from a `Submitted` one. A `DISPUTED` bounty is therefore refused
  twice, by the pass and by the send, and no single mutation turns test 18 red for that case;
  the apply script's mutation list leaves it out and says so.
- **A6, test 12.** The skipped entries are: an errored entry whose transaction would
  otherwise match; the recorded `expire_accepted` of `3591bf4c`, an escrow instruction of
  another kind on another account; and the recorded release with its escrow instruction
  removed, leaving only the Associated Token instruction.
- **A7, section 20.10.** `settle.mjs` reads `ARBITER_KEY_PATH` from `api.env`, defaulting
  to `~/bountycam-keys/arbiter.json` when unset.
