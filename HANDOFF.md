# BountyCam — Handoff

**Date:** 18 September 2026
**Sessions complete:** 1–6 (6 as 6a, 6b part 1, 6b part 2), 7a, 7b; Session 8 rulings;
spec session steps 1 to 3; Session 8 build parts 1 and 2; Session 9 specification and build
**Next session:** Session 11 — rehearse and run `initialize` on devnet, then the mobile scope
Session 10 did not reach: MWA sign-in, SIWS on device, SGT verification. The escrow is deployed
at eleven instructions with no configuration account, so every instruction fails on the config
PDA until `initialize` runs.
**Deadline:** 8 October 2026 (20 days remaining)
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
`upgrade-authority.json`, `relayer.json`, `attester.json`, `escrow-keypair.json`,
`eligibility.json`, `arbiter.json`, `usdc-mint.json`

**Devnet balances:** upgrade authority ~2.44 SOL after the extend and upgrade, relayer 5 SOL

**Deployed program:** `6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS`, carrying the eleven-
instruction layout since 18 September. ProgramData `EMHjBWwTWVMyucASSXTZ3YN1uGAs5awDD6rX4UpZRaKf`,
488736 bytes. The published IDL is still the Session 4 one: the upgrade landed, the IDL metadata
write failed. No configuration account exists, so every instruction fails on the config PDA.

**Devnet USDC mint (D102):** `ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR`, 6 decimals, mint
authority the upgrade authority, no freeze authority.

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
    └── escrow/       Anchor 1.1.2, SPEC.md, 95 SPEC tests plus test_id passing
```

All work committed to `main`; Umair pushes. History: `git log`.

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

What the spec session inherited is listed above under Session 8. Steps 1 to 3
are done; step 3's main deliverable, the replacement `programs/escrow/SPEC.md`,
landed in dfd821b (see the completion section below).

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

## Spec session — step 3 completion (16 September)

Four single-file commits, each applied by a script that replaces text matching exactly
once, with a dry run and a result hash checked before commit:

- 06548b5 — HANDOFF header: "capture nonce", replacing a D72 non-term.
- dfd821b — `programs/escrow/SPEC.md` replaced wholesale per D80 (sha 0b7ed67e).
- a923060 — BACKLOG: the escrow SPEC.md item closed; three findings added (sha a1e32015).
- This commit — HANDOFF.

What the new spec decides beyond D67 to D86. Each is a technical call with its reason
written in the spec:

- The on-chain enum holds only `Funded`, `Accepted` and `Submitted`. Session 9 appends
  its states; discriminants never change (SECURITY.md section 9).
- Bounty fields: fixed-width first, every `Option` last, so non-`Option` fields keep
  stable offsets for account filters. `usdc_mint` is removed (configuration is the only
  mint); `merkle_root` becomes `evidence_root`; `deadline` is an `Option`; `issued_at`
  is not stored.
- `accept` rejects a Scout equal to the requester (`ScoutIsRequester`).
- `cancel` refunds the vault's entire balance, so a donated token cannot block closure.
- Error codes 0 to 33 are fixed. 6001 and 6006 are retired, never emitted. All ed25519
  shape failures share one code.
- Check order: trusted state, then the signature, then signed caller values.
- `initialize` rejects an all-zero authority key.
- The only event is `BountyCancelled`.

Facts read from crate source this session, in the spec and nowhere else:

- The native ed25519 verifier (`agave-precompiles` 3.1.14 and 4.2.2) reads the signature
  count from byte 0 only, never checks the padding byte, accepts trailing bytes, and
  accepts a two-byte zero-signature instruction. The program must check all of these
  itself; SPEC tests 75, 77 and 81 exist for it.
- The off-chain `get_stack_height` stub returns 0. CPI rejection is testable only through
  a test-only caller program under litesvm (SPEC tests 55 and 69).
- Transaction budget, counted by the SPEC appendix script: `submit_attestation` 780 bytes
  with 7 keys; `accept` 795 bytes with 8 keys; limit 1232.

For the implementation session:

- The gate is 94 tests (SPEC section 12). Tasks are SPEC section 13.
- Rewards stay locked in `Accepted` and `Submitted` until Session 9 specifies the exits.
  Devnet test USDC only.
- Capture nonce issuance (D73) was in the original Session 8 scope. It is API work with
  no endpoint specification yet: specification before code, as always.
- The POLICY.md amendments for D82 and D84 stay blocked by OPEN-1. They do not block the
  escrow, which stores `eligibility_profile_hash` without validating it.

Working practice added: line-length limits (D31) are kept quietly for new text and not
reported or re-checked; they break nothing.

---

## Session 8 build, part 1 — escrow accounts, `initialize`, `create_and_fund`, `cancel`

Claude Code built SPEC tasks 1 to 11, 15 and 17 against `programs/escrow/SPEC.md` (dfd821b).
The architect chat reviewed every diff and counted run; Umair ran and committed each from raw
output. Thirteen commits on 16 September:

- e6a5da4 — test dev-dependencies exact-pinned; `serde_json` =1.0.151 added (task 17).
- e1680ff — errors 7 to 33 appended; `TokenAccountOwnerMismatch` split out (task 8, D75).
- 21cc2fd — platform fee deleted; funding transfers exactly `reward_amount` (task 1, D67).
- 7ee906a — configuration account and `initialize` (task 9, D83).
- f3fec01 — mint constrained to `config.usdc_mint` in both instructions (task 10).
- ed529c0 — bounty layout per section 4.1, three windows, `eligibility_profile_hash`, enum
  trimmed to three variants (tasks 2 to 7 and 15).
- 396013d — `cancel` balance check and `BountyCancelled`, in D76's order (task 11).
- 240c955, aac6e5b — D87 and the SPEC amendment for test 39.
- 8f70474 — test 39.
- 94844e3, 3e2aacc — D88 and the SECURITY.md section 8 amendment.
- d521c87 — test 40.

Gate at d521c87: 44 integration tests and 1 unit test (`test_id`), counted from the raw
summary. The 44 are SPEC tests 1 to 30, 33 to 41 and 91 to 94, plus the legacy
`cancel_when_accepted_fails`, which still plants `Accepted` and is not SPEC test 31.

Two conflicts found from raw output and ruled:

- D87 — test 39, the vault passed as `requester_ata`, fails with Anchor's
  `ConstraintDuplicateMutableAccount` (2040), not `TokenAccountOwnerMismatch`. SPEC sections
  10, 11 and 12 amended; no `dup` constraint added.
- D88 — SECURITY.md section 8 literally forbade the same-transaction re-creation that SPEC test
  40 requires. Raw logs showed both accounts recreated from empty. The invariant now forbids
  revival and permits re-creation only through `init`.

Facts read from crate source or raw output this session, recorded nowhere else:

- Anchor 1.1.2 validates accounts in three phases: `init` fields, then the duplicate-mutable
  check, then per-field constraints in declaration order (`anchor-syn` `try_accounts.rs`).
  Where two constraints raise the same error name, the negative test pins the account Anchor
  names through `assert_named_error_at`; tests 20, 21, 35 and 36 use it.
- Anchor's explicit-bump seeds check calls `create_program_address` with the stored bump and
  compares addresses; it does not re-derive canonicality. Test 94 plants a copy that keeps its
  canonical bump. A plant that also rewrote the stored bump would pass, but only `init` at the
  canonical bump creates an escrow-owned bounty. The test states the limit.
- `anchor build` prints `Finished` yet leaves `target/idl/escrow.json` stale when the test crate
  fails to compile, because IDL generation compiles it. It leaves `escrow.so` untouched when
  only tests change. Counted runs therefore show both timestamps.
- litesvm 0.10.0 loads SPL Token 3.5.0 and Token-2022 10.0.0 by default. ProgramData metadata
  is 45 bytes: the upgrade-authority `Option` tag at offset 12, the key at 13 to 44. The
  harness overwrite reads its result back through Anchor's `ProgramData`.
- anchor-lang 1.1.2 re-exports base64 0.21.7 as `anchor_lang::__private::base64`; event decoding
  uses it under the exact pin. Borsh 1 has no `try_to_vec`. `ERROR_CODE_OFFSET` is 6000.
- `coral-xyz/sealevel-attacks` was read at 24555d0 (July 2022); Anchor's security-exploits page
  now only links to it.

Owed, not done:

- `VaultBalanceBelowReward` is unreachable by construction (SPEC section 7.3) and has no failing
  run: review item.
- Test 28's compile-error run and the pre-change runs of tests 12 and 18 were collapsed in
  Claude Code's output and never shown raw. Each test's passing run is raw.
- SPEC task 18's review items were outside part 1's scope.
- SPEC section 16's reconciliation row names D67 to D86, not D87 or D88.
- The devnet deployment is still the Session 4 layout. SPEC section 13's operational items come
  before any redeploy.

Part 2 scope: SPEC tasks 12, 13, 14, 16 and 18; tests 31 (replacing the legacy test), 32,
42 to 90, and the `accept` case of test 91, raising its case count to 3.

Process notes. Claude Code's footer showed auto mode once, after an interrupted request; it was
switched back to manual before any edit. Its project memory index names a spec-editing file
that does not exist. The repo's `.claude/settings.local.json` holds two read-only allow rules
for `~/.claude` and is excluded by the global git ignore.

---

## Session 8 build, part 2 — designated verification, `accept`, `submit_attestation`

Claude Code built SPEC tasks 12, 13, 14, 16, 18 and 19 against `programs/escrow/SPEC.md`
(c2f74c9). The architect chat reviewed shapes and diffs before each commit; Umair ran the
counted runs and committed each from raw output. Twelve commits since 1c18dac, all pushed;
origin/main is 0297dce:

- 3b0c851 — D89: the escrow tests run the native ed25519 verifier; test 95; dev dependencies.
- c2f74c9 — SPEC: precompiles harness rule, test 95, task 19; sections 11 and 16 through D89.
- 93cc024 — litesvm `precompiles` feature; `solana-ed25519-program` =3.0.0 (task 19).
- a54447d — message builders; unit test 90 reproduces the 17 published vectors (task 12a).
- 542b16b — harness: `Setup`'s three authorities become per-run keypairs.
- a695ccc — D90: the CPI caller is excluded from Anchor's workspace; counted run gains
  `cargo build-sbf`.
- 9b25c69 — test-only `cpi_caller` for tests 55 and 69 (task 16, D90).
- aee46f2 — D91: the escrow depends directly on `solana-instructions-sysvar` =3.0.1.
- 90ae536 — that dependency; program graph unchanged (D91).
- 97f0732 — verification routine and `accept`; tests 31, 42 to 55, 91 at three cases
  (tasks 12b, 13a, 14).
- b4e1f26 — `submit_attestation`; tests 32 and 56 to 89 (task 13b).
- 0297dce — test 95, a flipped signature bit rejected by the native verifier on both paths.

Gate at 0297dce: 95 SPEC tests plus `test_id`, counted per binary from the raw summary:
`test_escrow` 94, escrow unit 2 (`test_id`, test 90), `cpi_caller` unit 1 (its own `test_id`).
The legacy `cancel_when_accepted_fails`, which planted `Accepted`, was removed in 97f0732;
test 31 reaches `Accepted` through a real `accept`.

Every negative test whose check lives in the program was shown red at runtime first: the
instruction landed with its checks absent and the transaction succeeding, then the checks
landed and the run went green (47 passed, 11 failed before `accept`'s checks; 67 passed,
26 failed before `submit_attestation`'s). Test 91's third case went red at its
`assert!(meta.is_signer)` precondition, because the red form declared no Scout signer. Tests
82 and 95 fail in the native verifier, outside the program, and are guards shown passing.
Tests 31 and 32 guard `cancel`'s existing state constraint, reached through real `accept` and
`submit_attestation` calls, and were shown passing.

Task 18 review, against the source at 0297dce:

- Every check precedes any CPI. The program makes exactly three CPIs, all token program calls:
  `create_and_fund.rs` line 111 (`transfer_checked`), `cancel.rs` lines 67 and 94
  (`transfer_checked`, `close_account`). In `create_and_fund.rs` the last check is line 84;
  in `cancel.rs` line 49. `initialize`, `accept` and `submit_attestation` make no CPI; their
  last checks are lines 60, 85 and 100, and every write follows them.
- No instruction reads remaining accounts: `remaining_accounts` does not occur in the escrow
  program source. The test-only `cpi_caller` forwards them by design and is never deployed.
- No dependence on recursion: no instruction invokes any program but the token program, and
  none invokes the escrow. `accept` and `submit_attestation` reject any non-top-level
  invocation before reading state (tests 55 and 69).
- Every builder call site passes `crate::ID`: the program's only calls of
  `eligibility_message` and `attestation_message` are `accept.rs` line 70 and
  `submit_attestation.rs` line 76, whose prefixes set `program_id` to `crate::ID` at lines 62
  and 68. Test 90 calls them at `messages.rs` lines 211 and 220 with the vectors'
  fill-pattern program id, by design.
- Untested checks, each implemented per the SPEC with no runtime red: `accept` check 7
  (`TimestampOverflow`) needs a funding clock within 30 days of `i64::MAX`, which no real
  chain reaches, and a test would change the 95-test gate; `submit_attestation` check 2
  (`StateInvariantViolated`) is unreachable without planting, since only `accept` writes
  `scout` and `deadline`, always together; the seeds constraints on `accept` and
  `submit_attestation` have the same form as `cancel`'s, which tests 25 and 94 exercise.
- `VaultBalanceBelowReward` (part 1's open item): `cancel.rs` line 49 checks it before the
  transfer at line 67, and only the bounty PDA can sign for the vault.

Facts read from crate source or raw output this session:

- anchor-lang 1.1.2 re-exports neither `load_current_index_checked` nor
  `load_instruction_at_checked` (its `solana_program::sysvar::instructions` holds only the
  `BorrowedInstruction` types and, off-chain, `construct_instructions_data`), nor the ed25519
  or compute-budget program ids. Hence D91's direct dependency. The ed25519 id is a
  `Pubkey::from_str_const` literal in `constants.rs`; the compute-budget id is a literal in the
  tests only; both are solana-sdk-ids 3.1.0 values. `TRANSACTION_LEVEL_STACK_HEIGHT` and
  `get_stack_height` are re-exported.
- litesvm 0.10.0 runs precompiles only with its `precompiles` feature (`src/callback.rs`);
  without it the ed25519 program account is never loaded (D89). agave-precompiles resolves to
  3.1.14; section 6.1's four statements about the verifier were re-read from its
  `src/ed25519.rs` lines 19, 26, 27 and 16 to 22.
- A precompile failure reaches litesvm as `TransactionError::InstructionError(index,
  Custom(n))`, n being the `PrecompileError` variant index (solana-precompile-error 3.0.0;
  program-runtime 3.1.14 `invoke_context.rs` line 502; instruction-error 2.5.0 lines 371 to
  412): `InvalidSignature` is `Custom(2)`, `InvalidInstructionDataSize` `Custom(4)`. Tests 82
  and 95 assert these.
- Anchor CLI 1.1.2's program-ID check is a warning: it prints the first mismatch it finds and
  continues building, so an included test program with an unmatchable id would hide an
  escrow mismatch. `[workspace] exclude` in Anchor.toml removes the caller from the check
  (D90). `cargo build-sbf` writes to the same `target/deploy`.
- RUSTSEC acceptances for tests only (D89): `ed25519-dalek` 1.0.1 (RUSTSEC-2022-0093) and
  `curve25519-dalek` 3.2.0 (RUSTSEC-2024-0344), reachable only through the two dev
  dependency edges; `cargo tree -e normal,build` finds neither.
- The 0xC7 fill pattern is off the ed25519 curve, verified by an RFC 8032 decompression
  check validated against the escrow id (on curve) and the native ed25519 program id (off);
  0xCC, 0xC1 and 0xAA fills are on curve and were rejected.

Process facts:

- D89 was applied by an unbriefed Claude Code session that had started in auto mode, then
  verified and committed from Umair's terminal. New Claude Code sessions start in auto mode:
  check the footer before the opening prompt.
- Read-only phases may use plan mode; every write phase uses manual mode with per-edit
  approval.
- Commits are made from Umair's terminal by count-guarded scripts that count tests per
  binary name, since the result lines no longer map one-to-one to escrow suites.
- Two helper defects surfaced in red runs and were fixed before the checks landed: an
  identical re-creation needs `expire_blockhash` (tests 52 and 54), and the integration file
  needed its own hex decoder (test 65).

Next. Session 9 builds `approve`, `reject`, `resolve` and `expire`, and owns the
double-release, payout-destination and refund-after-payout tests (SPEC 12.7). Before any
devnet deploy of this layout, SPEC section 13's operational steps: generate the eligibility
and arbiter development keys; rehearse `initialize` on localnet with the exact devnet public
keys; cancel program-owned devnet accounts holding test USDC while the Session 4 program can
still read them. Open items go to BACKLOG in C9.

## Session 9 specification — rulings, D92 to D98, three amendments (17 September)

Architect chat and Umair only; no Claude Code session. Before any work the uploaded files were
verified against b48ac9a: 36 paths byte for byte, with HEAD, the local origin/main and GitHub's
main all at b48ac9a.

SPEC section 1.2 and D80 left the settlement instructions unspecified, so Session 9 opened as a
spec session. Umair ruled R1 to R10, each as recommended; every payout destination, refund path
and arbiter power came to him before it was written. Four commits, each made by a count-guarded
script whose counted run showed `test_escrow` 94, escrow unit 2, `cpi_caller` 1 and two empty
doc-test runs. No source changed:

- 32e943b — D92 to D98.
- eecf47c — SECURITY.md sections 2 and 7 (D92 to D95).
- e5bab87 — escrow SPEC: sections 7.6 to 7.11, errors 34 to 48, tests 96 to 140, tasks 20
  to 25 (D92 to D98).
- 655262b — POLICY.md section 7.2, the `bounty_state` mapping (D97).

What was decided:

- `approve` (requester) and `release` (any fee payer, strictly after the review window end) pay
  the stored Scout's associated token account the vault's entire balance (D92).
- `reject` (requester, at or before the review window end) stores a 16-byte requirement id and
  enters `Disputed`; no money moves (D93).
- `resolve` (the configured arbiter, never a party to the bounty) pays the entire balance to the
  Scout or to the requester, never split; a dispute has no timeout (D94).
- `expire_unaccepted` and `expire_accepted` (any fee payer) refund the requester's associated
  token account after `acceptance_cutoff` or `deadline`. The first closes the bounty; the second
  leaves it `Refunded` (D95).
- `Disputed`, `Paid` and `Refunded` are appended. Settled bounty accounts are never closed, so
  D86's replay trigger is not tripped (D96).
- The database mapping follows confirmed transactions; a funded `cancel` ends `CANCELLED` (D97).
- The program has eleven instructions. Cut-off: end of 22 September, Sydney time; if no
  committed build shows every Session 9 test passing by then, Umair rules on BACKLOG's
  contingency (D98).

Facts read from crate source (`anchor-lang`, `anchor-syn` and `anchor-spl` 1.1.2 from crates.io,
checksums equal to `Cargo.lock`'s):

- Generated `try_accounts` decodes `#[instruction]` arguments, loads every account in declaration
  order, runs `init` constraints, then the duplicate-mutable check, then each account's
  constraints in declaration order (`anchor-syn` `codegen/accounts/try_accounts.rs`).
- Within one account the order is seeds, associated token, mut, signer, `has_one`, raw, owner,
  close, address (`codegen/accounts/constraints.rs`, `linearize`).
- `Account::try_from` returns `AccountNotInitialized` for an account owned by the system program
  with zero lamports (`anchor-lang` `accounts/account.rs` line 315). A closed vault therefore
  fails at load, before any state constraint; SPEC tests 134 and 135 rely on this.
- The associated-token constraint checks the token account's owner (`ConstraintTokenOwner`),
  then the derived address (`ConstraintAssociated`), and never the mint separately
  (`generate_constraint_associated_token`).
- The program dispatcher decodes instruction arguments before any account and maps a failure to
  `InstructionDidNotDeserialize` (`codegen/program/handlers.rs`). SPEC test 116 relies on this.
- `init` of an associated token account always calls the Associated Token program's
  non-idempotent `create`; only `init_if_needed` accepts an existing account
  (`constraints.rs`, the `InitKind::AssociatedToken` branch). See BACKLOG on vault pre-creation.
- `anchor_spl::associated_token` re-exports `get_associated_token_address` and
  `get_associated_token_address_with_program_id`.

Process facts:

- At step 3c `COMMIT` was typed before the architect had seen the output. The commit was
  verified afterwards and is correct; every later prompt waited for review.
- Apply scripts embed the whole reviewed file and check the base hash, result hash, line counts
  and hunk count, restoring from HEAD on a mismatch. Commit scripts re-check the file hash and
  count tests per binary name before the prompt.

Next: Session 9 build. Claude Code builds SPEC tasks 20 to 25 against the SPEC at e5bab87, in a
fresh session that first follows SECURITY.md section 16. Proposed commit order:

1. Layout: the three enum variants, `failed_requirement_id`, space 274, errors 34 to 48,
   `BountyExpired`; tests 92 and 93 modified; test 28 covers the new codes.
2. `reject`; tests 108 to 111 and 113.
3. `expire_unaccepted`; tests 123 to 127.
4. `expire_accepted`; tests 128 to 133.
5. `approve`; tests 96 to 102, and 112, whose `Paid` case needs `approve`.
6. `release`; tests 103 to 107.
7. `resolve`; tests 114 to 122.
8. Cross-cutting tests 134 to 140, then task 25's review items against the final source.

A test lands in the first commit where every instruction it calls exists. Each instruction first
lands with its accounts and effects but no checks, and its negative tests are shown red at their
own expected-error assertion. Tests whose failure is raised by Anchor's account loading, argument
decoding or the system program cannot be red in that form and are expected to be guards shown
passing, as tests 82 and 95 were: 101, 102, 116, 134, 136, 139 and 140. Each is ruled on when it
appears. Gate at the end: 140 SPEC tests plus `test_id` — `test_escrow` 139, escrow unit 2,
`cpi_caller` 1.

---

## Session 9 build — six instructions, the gate at 140 (18 September)

Claude Code in manual mode, per-edit approval, every commit made by a hash- and count-guarded
script. Eleven commits on 16ae262, the Session 9 specification baseline, in the nine rows below,
then the two records commits. All of it is pushed: `origin/main` is 85abdf6.

| Commit | Content |
|---|---|
| 97e7a11 | the three states, `failed_requirement_id`, errors 34 to 48, `BountyExpired` |
| 29eb8f5 | `reject` (SPEC 7.8); tests 108 to 111, 113 |
| 096f33d | `expire_unaccepted` (7.10); tests 123 to 127 |
| 008a069 | `expire_accepted` (7.11); tests 128 to 133 |
| 13ab47d, c19838e | D99 and its SPEC amendment |
| 5b01043, fcc4d19 | D100 and its SPEC amendment |
| 4b5eef2 | `approve` (7.6), `release` (7.7); tests 96 to 107, 112 |
| 7a77185 | `resolve` (7.9); tests 114 to 122 |
| 68750b1 | Cross-cutting tests 134 to 140; the gate |

The final counted run on 68750b1: `test_escrow` 139, escrow unit 2, `cpi_caller` 1, two empty
doc-test runs, 49 IDL error codes, no `cpi_caller` line and no stack-frame message in the
`anchor build` output. That is SPEC section 12's 140 and satisfies D98's cut-off four days early.
The breakdown sums to 142 because `declare_id!` generates a `test_id` test that the escrow crate
and `cpi_caller` each carry; a grep for the test attribute cannot see them and returns 139, 1 and
0. Two reviews have now read this line as an arithmetic error. 139 integration tests plus SPEC
test 90 in `messages.rs` make 140; the two generated tests make 142 executed.

Each instruction landed twice: accounts and effects with no checks, its negative tests shown red
at their own expected-error assertions, then the checks, then the commit. The guards the plan
predicted behaved as predicted (101, 102, 116, 134, 136, 139, 140), and three more turned up that
it had not: 127, 133 and the first three cases of 100 and 107, all caught by the associated-token
constraint rather than by a check.

Two rulings came out of the build. D99: settlement writes the terminal state before the token
CPI, because SECURITY.md section 8 outranks the SPEC's effect order; closures through Anchor's
`close` constraint necessarily follow the CPI and are the stated exception. D100: `approve`'s
generated `try_accounts` exceeded SBF's 4096-byte stack frame by 8 bytes, `cargo build-sbf`
printed an error, exited 0 and wrote an unusable `escrow.so`, and every approve transaction died
inside validation; four accounts are now boxed, and the counted run fails on any stack-frame
message whatever the exit status.

Process facts, including what went wrong:

- The build-5 commit script was run a second time after `release` had been written, and `COMMIT`
  was answered. It staged the three shared files by name, so it committed release's registration
  and tests without `release.rs`: commit 9044791 could not compile. Its own post-commit hash
  check caught the mismatch, after the commit. Amended to 4b5eef2, which adds `release.rs` and
  carries both instructions; nothing was pushed, so no rewritten commit left this machine.
- The flaw was in the commit scripts, not in Claude Code's work. They now re-hash every file
  immediately before staging and require the staged set to be exactly the expected files.
- Build commit 5's own counted run, `approve` green at 118 without `release` present, was checked
  in the architect chat but is under no commit. 4b5eef2 carries a single run of both.
- Test 135 first failed at its own assertion with `AlreadyProcessed`: a byte-identical repeat is
  refused by the runtime before the program sees it. Claude Code diagnosed it, expired the
  blockhash as tests 19, 33 and 134 do, and re-ran.
- ~~SPEC task 25's review items have not been performed against the final source. They are the
  section 11 rows marked "review item" and the check-1 invariants; owed before any devnet
  deploy.~~ Done in Session 10 against fe70f34, no findings.

---

## Session 10 — records, SPEC task 25, the devnet deploy (18 September)

Planned as mobile. Ruled at the start that the deploy and task 25 came first: the deploy was the
only remaining item of unbounded duration, and one step in it looked irreversible. Mobile moves to
Session 11 and the sessions after it shift by one.

Five commits, no program source touched: 0a4fc40 D101, fe70f34 the SPEC 7.7 wording, c5db706
D102, df7e418 D103, 4fbe8b4 BACKLOG.

**SPEC task 25 — discharged, no findings.** Read against the source at fe70f34 in a read-only
session, with `cancel` added to the Session 9 set. Every settlement instruction writes its
terminal state before its token CPI (D99); the two `close`-constraint closures follow the CPI as
the stated exception. None of the untested checks can be made to fail. `reject` issues no token
CPI, proved from its account struct rather than from the SPEC: it declares only `requester` and
`bounty`, so the accounts needed to move tokens are not in its context.

**Two corrections came out of that review.** D101: a counted run must prove the program was
compiled. D100 Ruling 2's `Stack offset` grep passes vacuously on an incremental build, and a
first freshness guard also passed while nothing compiled, because `cargo clean -p escrow` leaves
the sbpf object and `anchor build` re-derives the deploy copy from it. The rule now deletes
`target/sbpf-solana-solana`, measures freshness on the compiled object rather than the derived
copy, and requires dependency compile lines in the log. The SPEC 7.7 amendment: release check 2
rested on a bound the program does not establish; the accurate reason is that nothing but the
cluster clock feeds `submitted_at`, and `review_window_secs` is capped at 86400.

**One finding rejected.** The review read the counted-run breakdown above as wrong because a grep
counts 139, 1 and 0. `declare_id!` generates a `test_id` test the grep cannot see; the runner
reported 139, 2 and 1 on five subsequent cold runs.

**The deploy.** `getProgramAccounts` returned empty before anything was touched, which removed the
irreversible step: the program owned no accounts, so none held test USDC and none needed
cancelling. ProgramData extended by 270000 bytes to 488736 for 1.37 SOL, 32000 more than this
build needs. Upgraded, then verified from the chain rather than from the tool: the first 456736
bytes of `solana program dump` hash to 04dd0c29, equal to `target/deploy/escrow.so`, and the rest
is zero. No buffer stranded. The IDL metadata write failed afterwards at 2.44 SOL available.

**The build is reproducible.** Five cold rebuilds from a deleted target tree produced the same
565544-byte object, bbf2e314, whose stripped 456736-byte copy is what devnet holds. That is what
makes "the chain holds the reviewed bytes" checkable rather than assumed.

**The four immutable configuration values, approved and generated, not yet written.**

| Field | Value |
|---|---|
| `deployment_id` | 2 (D103) |
| `usdc_mint` | `ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR` (D102) |
| `attester_authority` | `2KAuf8WWHGDm4rA1MCCQ9UciEAiqyTHaKeyBHZFF3wZ5` |
| `eligibility_authority` | `Bg6SsTTH6EX5AaeQQ9i4yhDTwsSjxnHx9AV8cqa97xmp` |
| `arbiter_authority` | `6YPX1obwh62N2DDyxtNa2RwkriWUUWLzjAvEWJFbvK1K` |

SPEC 7.1 check 3 requires the signer to be the on-chain upgrade authority, so
`upgrade-authority.json` signs `initialize` and the other three are arguments, never signers.
Checks 4 and 5 hold: three distinct keys, none all-zero. The localnet rehearsal with these exact
keys is still owed (D83).

---

## Working rules

- Read SECURITY.md before touching the escrow, auth, verifier, or any key (D50).
- Per-edit approval. Never blanket "allow all". Claude Code stays in manual mode.
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
- A counted escrow run (D90) is `anchor build`; `cargo build-sbf --manifest-path
  programs/cpi_caller/Cargo.toml`; the `escrow.so`, IDL and `cpi_caller.so` timestamps; then
  `cargo test --locked`, in one output. The summary shows five result lines (three test
  binaries and two doc-test runs); count each by name.
- A test pass counts only if the summary shows the expected test count. A
  green run that executed nothing looks identical from the exit banner alone
  (D36).
- Never `git stash`. It moves uncommitted work out of the working tree and
  the pop can fail. For a read-only comparison against HEAD, read the
  committed file from the object store: `git show HEAD:<path>`.
- Devnet deploys use `anchor deploy --program-name escrow` only. Never run
  `anchor keys sync` or `anchor build --ignore-keys`: the first would replace a program id,
  the second would silence the escrow's own id check (D90).
- Claude Code sessions start in auto mode. Check the footer before the opening prompt; every
  write phase is manual with per-edit approval.
- Answer a commit script's prompt only after the architect has checked the pasted output, and
  answer it once. A script re-run later against a changed tree commits the wrong thing; this
  produced 9044791, a commit that could not compile.
- A commit script re-hashes every file immediately before staging and requires the staged set to
  be exactly its own file list. A list of names alone stages whatever those files now contain.
