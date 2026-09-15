# BountyCam — Handoff

**Date:** 16 September 2026
**Sessions complete:** 1–6 (6 as 6a, 6b part 1, 6b part 2), 7a, 7b (complete)
**Next session:** 8 — Escrow: `accept`, `submit_attestation`, capture nonce issuance (BACKLOG)
**Deadline:** 8 October 2026 (22 days remaining)
**Repo:** https://github.com/umairakram-git/bountycam (public)
**Local path:** `/Users/umairakram/Developer/hackathon202609`

---

## What this project is

A Solana escrow that releases payment only when submitted evidence meets an
assurance policy fixed before the work started.

A requester posts a job at a location, locks USDC, and specifies what proof
they require. A Scout travels there and captures evidence through the app —
live capture only, signed on-device, bound to a challenge issued after the
job was posted. A verification service checks the evidence against the policy
and issues a signed attestation. The on-chain program releases funds only if
that attestation meets the precommitted assurance level.

**Positioning:** we are not inventing authenticated capture (C2PA and Truepic
exist) or field-work marketplaces (iVueit, Premise, Field Agent exist). We are
making authenticated evidence economically executable. The claim is narrow and
deliberate — see DECISIONS.md D10.

**Honest limit, stated in the pitch:** assurance measures how evidence was
captured, not what it depicts. A perfect A4 receipt on a photo of the wrong
object still passes policy. Policy compliance is necessary for payment, not
sufficient for truth.

---

## Environment (all verified from raw output)

| Component | Version | Notes |
|---|---|---|
| Node | 22.22.2 | |
| pnpm | 11.22.0 | |
| Rust | 1.98.1 | program builds under 1.89.0 via `rust-toolchain.toml` |
| solana-cli | 3.1.10 (Agave) | |
| anchor-cli | 1.1.2 | from crates.io, `--locked` |
| PostgreSQL | 17.11 | Homebrew, native — no Docker |
| PostGIS | 3.6.4 | |
| Device | Seeker, API 36, StrongBox present | |

**Keys** — `~/bountycam-keys/`, mode 600, outside the repo:
`upgrade-authority.json`, `relayer.json`, `attester.json`, `escrow-keypair.json`

**Devnet balances:** upgrade authority ~3.87 SOL, relayer 5 SOL

**Deployed program:** `6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS` (devnet, IDL published)

---

## Repository state

```
hackathon202609/
├── apps/
│   ├── api/          Fastify + TS, SIWS auth, five bounty endpoints, 6 migrations
│   └── mobile/       Expo + TS skeleton, android/ kept, ios/ deleted
├── packages/
│   └── shared/       SPEC.md (normative) + implementation, 66 passing tests
└── programs/
    └── escrow/       Anchor 1.1.2, SPEC.md, 10 passing tests
```

All work committed and pushed to `main`. History: `git log`.

---

## Session 1 — Environment

Toolchain installed and version-pinned. Anchor stewardship was investigated
after `coral-xyz` URLs redirected to `otter-sec`: this is a legitimate GitHub
repo transfer, confirmed via crates.io ownership (`solana-foundation-tech`,
`trixter-osec`, `otter-sec:anchor-managers`). `anchor-cli` installed from
crates.io rather than `--git`, so the install is immutable and checksummed.

---

## Session 2 — Scaffold

pnpm monorepo, four packages, TypeScript strict throughout. `packages/shared`
is the only place hashing logic may live — mobile and api both depend on it.

`anchor-lang` had silently resolved to 1.2.0 through caret semantics despite a
1.1.2 CLI. Pinned to `=1.1.2` and verified with `cargo tree`.

---

## Session 3 — Database schema

Nine tables, two migrations, rollback test passing. Verified directly with
`\d` rather than from the tool's report.

Load-bearing constraints:

- `decisions` CHECK — a REJECT outcome requires `failed_requirement_id`.
  This is the structured-rejection rule enforced by the database, not by
  convention.
- `assignments` unique partial index on `(bounty_id) WHERE status = 'ACTIVE'`.
  Prevents two Scouts accepting the same bounty. Test this with two real
  devices racing.
- `policies.canonical_json` — the exact serialisation `policy_hash` was
  computed over. Never regenerate or reformat it.
- `bounties.location` is `geography(Point, 4326)` with a GIST index.

---

## Session 4 — Escrow accounts

`Bounty` PDA seeded on `["bounty", requester, bounty_id]`, 17 fields.
Two instructions: `create_and_fund`, `cancel`. Ten tests, including all eight
required negative cases.

Two security properties verified by reading the source, not the summary:

- `has_one = requester @ EscrowError::UnauthorizedRequester` — the signer is
  bound to the requester stored in the PDA, not merely any signer.
- `associated_token::authority = bounty` — USDC is held in a PDA-owned token
  account, so each bounty's funds are structurally isolated.

Deployed to devnet and confirmed working.

---

## Session 5 (part 1) — shared package specification

`packages/shared/SPEC.md` written before any implementation, and committed.
Normative for `canonicalise`, `sha256`, `merkleRoot`. Key choices (recorded
as D26–D30):

- RFC 8785 baseline with stated deviations: only safe integers accepted as
  numbers, everything else rejected; fractional quantities travel as strings
  under fixed profiles (GPS at exactly 7 decimal places, token amounts in
  base units)
- No unicode normalisation; key order is UTF-16 code unit order, with an
  explicit warning for UTF-8-native implementations
- Merkle: RFC 6962-style domain separation (one-byte leaf and internal
  prefixes), left-to-right pairing, odd node promoted not duplicated,
  empty list rejected, single element is its leaf node
- Rejection rules are normative — agreement on failure is part of the spec
  (depth limit 64, undefined rejected, lone surrogates rejected)

Five worked test vectors computed from raw terminal output. Merkle roots
re-verified by recomputing from the intermediate digests published in the
spec itself — all three checks pass.

Process incident worth keeping: escape sequences written literally as
examples were interpreted in transit twice, and the spec's longest table
rows displayed truncated during review, reading as corrupted normative
text. The spec now describes escape forms in words, in tables, and no line
exceeds 100 characters (verified with awk). Recorded as D31.

---

## Session 5 (part 2) — shared package implementation

SPEC.md was amended **before** implementation: error model (§6, one exported
class `SpecError` with a readonly uppercase code), value model (plain-object
and array shape rules, §1.1/§1.7), byte-input rules (§2, §3.2), and two
normative check orders — cycle before depth, and plainness before any
own-property check (§6.3). Recorded as D33–D35.

- SHA-256 backend: `@noble/hashes`, exact-pinned 2.4.0 (D33), cross-checked
  in tests against `node:crypto` as a test-only oracle.
- 66 conformance tests, all passing; the five spec vectors reproduced
  byte-for-byte from the amended spec.
- `node --test dist` on Node 22.22.2 executed no test files and reported one
  trivial pass — every earlier green run in this package had run nothing.
  Found from raw output, fixed by naming `dist/index.test.js` explicitly
  (D36); a missing file now exits 1.
- An accessor property with `get` and `set` both undefined was serialised as
  its (absent) value instead of rejected. Found test-first: the two new tests
  failed red reporting UNDEFINED before the one-line fix in each of
  `serialiseArray` and `serialiseObject`.

---

## Session 6a — auth specification

`apps/api/AUTH.md` written before implementation and committed (D37–D48, D51).
Normative: SIWS challenge/verify flow, exact-bytes verification (never rebuild
the message from a template), numbered check order with one error code per
failure, HS256 JWT via jose, two migrations in prose, a 37-test list, and a
worked vector cross-checked against RFC 8032 section 7.1 TEST 1. SECURITY.md
and SECURITY-PRODUCTION.md added in the same session block (D49–D50).

## Session 6b (part 1) — pins, dependencies, migrations

Three single-purpose commits, each verified from raw output:

- `apps/api` registry deps pinned exactly: fastify 5.12.3, @types/node
  22.20.1, node-pg-migrate 9.0.0, pg 8.23.0, typescript 5.9.3. The lockfile
  diff changed specifier lines only; `@hackathon/shared` stays `workspace:*`.
- Auth dependencies exact-pinned: jose 6.2.12, @noble/curves 2.4.0,
  @solana/wallet-standard-util 1.1.2. AUTH.md section 3.2 gate passed from
  `pnpm why`: curves 2.4.0 direct, 1.9.7 only under wallet-standard-util;
  hashes 2.4.0 is the only backend outside that subtree.
- Migrations 3 (`auth_challenges`) and 4 (`users.status` to `user_status`
  enum, single value `ACTIVE`) per AUTH.md section 11. Scratch-database test
  applied and rolled back both (tests 1, pass 1); `\d` verified against
  `bountycam_dev`, which now has all four migrations applied.

## Session 6b (part 2) — auth implementation

Four single-purpose commits, each verified from raw output:

- AUTH.md amended first: test 38 — two concurrent verifies with one nonce,
  exactly one 200, the other 401 `NONCE_CONSUMED` (SECURITY.md section 4).
  The D36 count gate is now exactly 38.
- `@scure/base` 2.4.0 added for base58 (D52): zero runtime dependencies,
  @noble author, major 2.0.0 from 2025-08-25. The lockfile integrity hash
  was matched against the registry entry before install.
- Implementation: `src/config.ts` (section 9 env vars; JWT secret file read
  once at startup, trimmed, must be exactly 64 lowercase hex or the process
  exits non-zero), `src/clock.ts` (the one injectable clock), `src/auth/`
  (section 4 chain table; jwt issue/verify pinned to HS256 with iss, aud and
  60-second tolerance; routes with the section 6 check order verbatim). The
  nonce is consumed by the single atomic `UPDATE ... RETURNING` with the app
  clock as a bind parameter. `verifySignIn` is never imported anywhere
  (verified by grep).
- Tests: auth summary "tests 38, pass 38, fail 0"; migrations summary
  "tests 1, pass 1, fail 0"; both against scratch databases. Test 9
  reproduced the AUTH.md section 12 signature byte-for-byte with
  `@noble/curves` 2.4.0; test 10 reproduced the 333 message bytes with the
  pinned builder; test 38 raced two verifies via `Promise.all` against a
  pool asserted to allow at least 2 connections.
- Plumbing: `pg` moved to dependencies (runtime use in `src/index.ts`);
  `@types/pg` 8.23.1 exact-pinned, `@types/node` stays single-version
  22.20.1; tsconfig gained `rewriteRelativeImportExtensions`; the test
  script names both test files explicitly (D36).

## Session 7a — policy and bounty specification

`apps/api/POLICY.md` written before implementation and committed (1328 lines, no
line over 100, D53–D62): policy object v1, canonical form and hash, immutability,
GPS profile, reward amount, bounty resource and states, five endpoints with
numbered check orders, location approximation, idempotency, migrations 5 and 6 in
prose, a 75-test list, worked vectors, open questions.

Four rulings shaped the final document:

1. **The salt is field sixteen** — the substantive one. Server-assigned, 64
   lowercase hex, 32 bytes from `node:crypto` `randomBytes` via an injectable
   randomness module, source tested. It exists because of the section 9.4 finding:
   the policy hash is public on-chain after funding, and with everything else
   disclosed the exact coordinates have about 2^33 candidates per snapped
   0.01-degree cell — GPU-trivial, SECURITY.md section 11's warning realised.
   Blinding must not be a side effect of a field that exists to identify
   requirements — a future log line or error exposing a requirement id would
   silently destroy the property — so the salt carries location privacy and the
   requirement ids' pre-acceptance non-disclosure remains as defence in depth only.
2. Session 11's race test seeds an `AVAILABLE` bounty by direct SQL — recorded as
   decided, not a scheduling conflict; the `FUNDED` flip arrives with Session 15.
3. Idempotency keys never expire in the MVP — recorded as a production retention
   item (POLICY.md section 14, SECURITY-PRODUCTION.md section 5).
4. Section 9 states the accepted disclosure: two bounties in one cell reveal
   co-location to within roughly a kilometre.

A late fix worth keeping: the first draft named Session 11 as owner of the GPS
profile lift into `packages/shared`. Session 11 only consumes bounties, so the
lift now has **no owner** — the gap is named in POLICY.md sections 5 and 14 and
in D61, to be assigned when a session gains a client-side create flow.

Two vectors published and verified by three routes each (`packages/shared`,
`node:crypto`, `shasum -a 256`), all raw output:

- V1 policy hash, 624 bytes:
  `60b987301f7731a32c6de0ec871fae6e2e6f30dc99e2d1b202ca267d408591ea`
- V2 request digest, 567 bytes:
  `2dec8d20e7e49d2a4be1c3c67d6866a6cd77bcf8cf8b682847bc5a57e55d8a60`

Process note for the record: while adding the salt, an error was found in text
already reviewed and approved — section 8.2 said `policy_public` had "twelve
top-level fields" where the arithmetic gives thirteen. The re-derivation forced by
the salt edit caught it; this is the working rules producing exactly what they
exist to produce, and a reason to keep re-deriving counts rather than trusting
approved prose.

## Session 7b (commits 0–4c) — policy creation implemented

Spec-first held: three POLICY.md amendments each rode in their own commit before
the code they govern — D63 (check order, integer form, tie-break, salt-absence
tests), test 76 (the `authUser()` wiring-guard unit test; gate moved 75 to 76),
and D64 (section 9.1 geography entry rule).

Delivered, single-purpose commits, verified from raw output (06733ae..454489c):

- Migrations 5 and 6: policy-hash CHECK and prompt rename; bounty columns —
  `numeric(20,0)` reward with a u64 CHECK, `location` and `location_public`
  geography, and the idempotency unique index whose exact name the route's
  23505 handler matches.
- Injectable randomness module (salt bytes, requirement uuids), mirroring the
  clock (D54); tests inject a deterministic double and source-test both values.
- GPS profile form rules, scaled-integer BigInt snap, and the sixteen-field
  policy build hashed via `packages/shared` only.
- Startup config: `SOLANA_CLUSTER` (default devnet), `SETTLEMENT_MINT`
  (required, base58/32), `ATTESTER_PUBKEYS` (strict comma split — no trim, no
  empty elements, no duplicates); malformed values exit non-zero before listening.
- `requireAuth` preHandler and the throwing `authUser()` accessor.
- POST /bounties: the section 8.3 ten-step check order verbatim; the request
  digest preserves optional-key presence (section 10.2); replay and 409 served
  from stored rows; 23505 discriminated by constraint name; the collision
  re-read goes to the pool, never the possibly-dead transaction client.

The gate, all from raw output: bounties `tests 56, pass 56, fail 0`; auth
`tests 38, pass 38, fail 0`; migrations `tests 1, pass 1, fail 0`; lint exit 0.
Test 5 reproduced V1's policy hash end to end through the HTTP path; test 47
carries the omitted-vs-present optional-key 409.

## Session 7b commit 5 — the four endpoints and the full test suite

Thirteen single-purpose commits (c7964bf..fa42c0e), spec-first held: three
amendments each rode ahead of the code they govern — D65 (list-item
`required_assurance` from the policies read-model column; test 8 gains the
drift-guard assert), the section 8.6 tie-break amendment (`id` ascending,
matching 8.4), and D66 (cancel body rule numbered as step 2 before the id
form; an empty JSON object is a present body; the step 7 reload is single —
a second zero-row result falsifies the 7.2 state machine and throws).

Delivered, all verified from raw output:

- `publicView` and `listItem` in views.ts: allow-list rebuilds with keys
  written literally, eight keys each; `StoredPolicy` omits `salt` and the
  requirement `id` so a leak cannot even compile.
- `GET /bounties` (8.4): geography `ST_DWithin` in metres — both operands
  stay geography; a geometry cast would filter in degrees and match the
  planet — ordering distance ascending, `created_at` DESC, `id` ASC.
- `GET /bounties/:id` (8.5): owner/public split by requester; the malformed
  id and the absent uuid return byte-identical 404 bodies (7.3).
- `GET /me/bounties` (8.6): its own extractor — `limit` and `offset` only;
  the discovery parameters are unknown here — no state filter.
- `POST /bounties/:id/cancel` (8.7 as amended): eight steps verbatim, one
  conditional UPDATE, owner view served from the step 4 load.
- Tests 4 and 51–69. Load-bearing details: whole-body scans with vacuity
  guards before them (54, 59 — every scanned-for value proven a real string
  of the expected form first); test 51's two rows sit at different bearings
  from a latitude-60 query point, so a planar degree-space ordering flips
  the pair; tests 52, 53 and 62 carry presence controls proving each
  absence assert could have failed; test 56 asserts pages partition the
  full ordering; test 65 asserts the cancel retry body is byte-identical.

The gate: bounties `tests 76, pass 76, fail 0`; auth `tests 38, pass 38,
fail 0`; migrations `tests 1, pass 1, fail 0`; lint exit 0.

## Next: Session 8 — what must survive compaction

Scope (BACKLOG remaining plan): Escrow — `accept`, `submit_attestation`,
challenge nonce issuance. D49 fixes `accept`'s shape: it moves zero USDC,
records the Scout, and `cancel` is rejected from ACCEPTED onward.

Three facts from commit 5 that the diffs do not show:

- **`created_at` takes the column default `now()`** — the database clock,
  outside the injectable clock. Ordering tests seed timestamps by SQL
  (test 62). A session wanting deterministic `created_at` has to route it
  through the clock first.
- **The randomness double is fixed for the salt and queued for the uuids.**
  Every `randomBytes` call returns V1's 32 bytes; `randomUUID` shifts
  `uuidQueue` first, then falls back to a counter. A test pushing N uuids
  must create a bounty with exactly N requirements, or the leftovers land
  in the next create inside the same test.
- **Three lines over 100 in bounties.test.ts** (the test-name lines of
  tests 07, 08, 32) predate commit 5 — verified against HEAD's copy via
  `git show`. BACKLOG item, not a blocker.

Still standing from the commit-5 list, both durable: the D64 read-back
prohibition (no code path renders coordinates out of a geography column —
the views.ts header names the tempting optimisation), and the migration 5
and 6 rollbacks being documentation only now that rows exist (POLICY.md
section 11.3) — never claim them as demonstrated.

Riding along from earlier sessions: AUTH.md section 14.2 domain value and the
fallback signing path both validate on device in Session 10. The three test
tsconfig instances recorded in BACKLOG are owed to commit 7's before-count.

---

## Session 8 — conflicts memo, fourteen rulings, and how part 1 failed

`notes/session8-part1-conflicts-memo.md` holds the six-item conflicts memo for
ruling: platform fee, the accept race, attestation serialisation, the ed25519
mechanism, the three meanings of "challenge", and capture nonce origin, plus a
"flagged for your ruling" list of seven further items. All are now ruled
(below); no spec prose exists yet.

Settled from raw output this session: `PLATFORM_FEE_BPS` has been `0` in every
committed version, so the 250 bps figure exists only in the stale
`programs/escrow/SPEC.md` and the code complies with D24. The griefing and
fee-sponsorship analysis in item 2 is complete; D2 means `accept` is sponsored
by default, so on the app path the relayer funds any griefing.

Part 2 (commit a964519) wrote three of those four. m5 is a minimum trust level
at accept, explicitly not SGT gating — the program reads no device artifact,
and because trust levels live off-chain, m5 binds a direct caller only as
issuance policy inside an m3-style voucher. Item 8 records the A4 hardwiring
and cross-references the BACKLOG open finding. Amendment 2 removed the
Wormhole citation from four places and dropped the dollar figure; the
line-level `load_instruction_at` claim is attributed to RareSkills as
third-party, and the 403 and 429 attempts plus an empty `gh` search for a
first-party fix commit are recorded in the memo. Amendment 3 was retired as
obsolete: the `notes/` check existed to decide whether the memo would survive
to be committed, and it did, so section 0 item 4 records that answer instead.
The m1 closing sentence was fixed in the close-out script.

**All fourteen rulings are held.** D67 to D73 close the six questions; D74 to
D80 close the seven flagged items. Commits c0e3f71 and c4d9e03, with the
earlier 9dd2ee6 and 628696e. The memo is fully discharged and nothing further
is owed to it.

What changed materially, for anyone reading the rulings cold. Acceptance is no
longer permissionless: a server-issued eligibility voucher is required and the
Scout still signs (D68), which closed a griefing attack that would have let any
wallet lock the whole marketplace for transaction fees — funded by our own
relayer under D2. A4 no longer names Seeker hardware; the qualifying rule set is
committed in the policy as an eligibility profile (D69). On-chain signed
messages are fixed binary layouts rather than canonical JSON (D70), which
removes the section 5 versus section 6 contradiction without a second
serialiser. Ed25519 verification accepts only BountyCam's canonical
self-contained shape, at an explicitly supplied index, top-level only (D71). The
arbiter becomes program state rather than a caller-supplied account (D74).
Policy-to-chain consistency is enforced by the attester, the only layer that
sees both representations (D77).

What the spec session inherits, in order:

1. **POLICY.md currently contradicts two held decisions.** D79 amends sections
   7.2 and 7.3 — `AVAILABLE` is produced by confirmed funding rather than by
   Session 15, and discoverability requires no active reservation as well as
   the state. D72 requires a naming mapping note. Make those edits before
   writing anything new.
2. The binary-message specification for D70 and D71, with golden vectors, as a
   dedicated artifact — it is consumed by the program, the verifier service and
   the Session 17 independent verifier.
3. The replacement `programs/escrow/SPEC.md` per D80: wholesale, not patched,
   with the authority order that decision fixes.

Still no Rust until those exist. Two questions are deliberately open for the
spec session: whether attestations carry an expiry (D70, D77), and the
transaction-size budget D77 requires be computed rather than discovered on
device. Smaller and noted rather than blocking: SECURITY section 2's API server
entry still says "store challenges", which D72 made a non-term.

Two schema findings from reading migration 1 directly, for whoever picks up the
`assignments` table — recorded nowhere else:

- **`assignment_status` has no reservation label.** The enum is `ACTIVE`,
  `ABANDONED`, `EXPIRED`, `COMPLETED`. Nothing distinguishes a pre-confirmation
  reservation from a confirmed assignment, so D79's Session 15 case — stale
  reservation without on-chain acceptance — cannot be found, and D79's "moves from
  reservation to confirmed" has no schema representation.
- **`assignments.challenge_nonce` is a D72 non-term whose role predates D73.** The
  D73 capture-nonce store carries its own issue time, expiry and status server-side,
  so the column's purpose is unsettled: rename, supersede, or both. The rename
  touches the column and POLICY section 12 test 77. Do not reuse the column as the
  reservation TTL — POLICY section 14 item 6 owes that timestamp to the
  voucher-issuance session.

Part 2 ran in a fresh session and produced no re-proposals: it blocked rather
than reconstruct output it had not seen, corrected a commit SHA it was given,
and found two stale cross-references unprompted. That supports compaction as
part 1's cause rather than anything about the task.

How the session failed, worth not rediscovering: after a wide reading pass and
five external fetches, a one-sentence edit could not be applied across five
attempts, including two where the literal `old_str` and `new_str` were supplied
and one where a diagnostic command was requested instead. The tell was the
agent reading four unrelated documents between each refusal and an identical
re-proposal. Different signature from 7b's re-send: there the answer repeated,
here the edit repeated while the reading widened. Treat a small edit that will
not land after a long reading pass as a signal to end the session rather than
to rephrase.

Also recorded, because it cost three refusals: the edit approval prompt renders
a replacement as the deleted lines stacked above their replacement, with no
marker between them. That reads as a duplicate insertion. It is not. Verify
with `grep -n` against the file before refusing an edit on that basis.

---

## Spec session — steps 1 to 3 (15 and 16 September)

What the spec session inherited is listed above under Session 8. Steps 1 and 2
are done; step 3 is done except for its main deliverable, the replacement
`programs/escrow/SPEC.md`.

**Step 1** (e98976b, 603f168): POLICY.md amended for D79 discoverability and
the D72 naming note; the two `assignments` schema findings recorded above.

**Step 2** (2ccc405): `packages/shared/MESSAGES.md` specifies both binary
signed messages, with 35 generated vectors. Attestations carry no expiry; the
transaction budget is 881 of 1232 bytes with a ceiling of roughly eighteen
accounts.

**Step 3, done.** Six rulings and four amendments, each applied by a script
that replaces text matching exactly once, with a dry run, and the result hash
checked on both machines before a single-file commit:

- eaeb8a3 — DECISIONS.md, D81 to D86 (result sha 46ca2ac6).
- 34820e1 — SECURITY.md sections 1, 2, 6, 7 and 8 (bb9fcc09).
- 5bb67f9 — MESSAGES.md wording only; no table row or vector changed
  (6dcde549).
- 5bcd219 — BACKLOG.md: D69, D75 and D76 items closed; a new step 3 section
  holds OPEN-1 and every other owed item (2f32a667).

What D81 to D86 change for the escrow, for anyone reading them cold:

- D81 — `create_and_fund` takes three durations, each with a compiled ceiling;
  the program computes the acceptance cutoff at funding and `deadline` at
  `accept`.
- D82 — one configured attester; `attester_pubkey` leaves the policy; no
  attestation expiry; the key id is the ed25519 instruction's public key.
- D83 — one immutable configuration account (deployment id, USDC mint,
  eligibility, attester and arbiter keys), written once by the upgrade
  authority as read from ProgramData; the three keys must differ.
- D84 — the policy-to-chain binding register, checked at funding projection,
  voucher issuance and attestation; `eligibility_profile_id` joins policy V1
  with a frozen byte-level hash rule; V1 freezes at the first implementation
  commit that reproduces the regenerated vectors.
- D85 — `submit_attestation` needs no Scout signature; an attested shortfall
  is rejected with no state change.
- D86 — voucher replay across cancel and re-creation is a stated limit, with
  revisit triggers in BACKLOG.

Deferred on purpose: the POLICY.md amendments for D82 and D84, blocked by
OPEN-1 (profiles below A4), which needs the Session 8 memo's m5 ruling. The
full list is in BACKLOG.

**Step 3, remaining: the SPEC.md replacement.** Recommended in a fresh chat,
because this one grew long enough for compaction to threaten spec detail. It
must cover, per D80: a supersession header and authority order; the
configuration account and `initialize` (D83); the bounty account field by
field (D67, D74, D81, D82, D84); the state enum without `Cancelled` (D76),
with `Funded` as the state a bounty is accepted or cancelled from and Session
9's exits named but not specified; `create_and_fund`, `cancel`, `accept` and
`submit_attestation`; the error table, append-only, with code 6006
`AmountOverflow` reserved (D67, D75); invariants mapped to the SECURITY.md
section 8 and SECURITY-PRODUCTION.md section 8 tests; the `accept` and
`submit_attestation` account lists counted by script against the ceiling; the
implementation-task list; and D80's reconciliation checklist.

Upload to that chat, copied by a hash-checking script as in step 3:
DECISIONS.md, SECURITY.md, SECURITY-PRODUCTION.md, BACKLOG.md, this file,
`apps/api/POLICY.md`, `packages/shared/MESSAGES.md`, the old
`programs/escrow/SPEC.md`, both escrow `Cargo.toml` files, `Anchor.toml`, all
seven `.rs` files under the crate's `src/`, and `tests/test_escrow.rs`.

Facts read from source this session and recorded nowhere else:

- `create_and_fund` accepts any mint account the caller supplies; there is no
  address constraint. D83 closes it; the code change is owed.
- `cancel` emits no event, although D76 requires `BountyCancelled`.
- `cancel_when_accepted_fails` fakes the `Accepted` state by rewriting the
  account; it must use a real `accept` once one exists.
- `overflow-checks = true` sits under `[profile.release]` in the workspace
  `Cargo.toml`, as SECURITY.md section 8 requires.
- litesvm 0.10.0's `add_program` loads under the upgradeable loader with the
  upgrade authority recorded as none (its `src/lib.rs`, lines 857 and 931), so
  a positive `initialize` test must overwrite ProgramData first.

Working practice settled this session:

- Downloads always land in `~/Downloads`. Clear our files there before
  downloading, and select files by hash: a browser renames a repeat download.
- A file card opens a preview; its download button saves the file.
- In zsh, a bare wildcard that matches nothing aborts the whole command.
  Checks use `find` or quoted names instead.
- Claude makes technical calls — placement, formats, check order, test design
  — with a one-line reason. Umair decides what changes the user experience,
  when money moves, scope, and deadline trade-offs. Per-edit approval and
  running every command stay unchanged.

---

## Working rules

- Read SECURITY.md before touching the escrow, auth, verifier, or any key (D50).
- Per-edit approval. Never blanket "allow all".
- No autonomous commits or pushes. Umair pushes.
- Single-purpose commits.
- Verify from raw terminal output. Claude Code's self-reports are not evidence
  — this caught the `anchor-lang` version drift, the silently-ignored
  `skip_deploy` key, and the failing devnet deploy.
- Write the spec before the implementation, in its own session, and commit it.
  In Session 4 the spec was written afterwards and documented an invented fee
  constant as though it were intended.
- Start a fresh Claude Code session per numbered session. Compaction loses
  spec detail.
- Approve a write only after seeing it.
- A test pass counts only if the summary shows the expected test count. A
  green run that executed nothing looks identical from the exit banner alone
  (D36).
- Never `git stash`. It moves uncommitted work out of the working tree and
  the pop can fail. For a read-only comparison against HEAD, read the
  committed file from the object store: `git show HEAD:<path>`.
