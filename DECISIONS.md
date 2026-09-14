# BountyCam — Decisions

Each entry records what was decided and why. Where a decision was reversed,
the reversal is recorded rather than the original being edited.

---

## Architecture

**D1 — Chain footprint: six instructions; acceptance stays off-chain.**
Acceptance is a reservation, not a fund movement, so it does not need
consensus. A Postgres row lock is sufficient and far cheaper.

**D2 — Gas: a backend relayer pays; the Scout signs messages only.**
The Scout never needs SOL. The relayer is trusted for liveness, not for funds —
it can stall a submission but cannot move USDC. Only `approve` (requester) or
`resolve` (arbiter) moves money. State this openly rather than hiding it.

**D3 — App shell: Expo with dev client and prebuild; EAS builds the APK.**

**D4 — Evidence storage: Cloudflare R2, private, presigned URLs, 15-minute TTL.**

**D5 — Hashing: sorted-key JSON, numbers as strings, SHA-256, Merkle root.**
No floats anywhere — GPS coordinates are strings. Float serialisation differs
across languages and would break cross-implementation agreement.
*Reversal note:* superseded in part by D26. Safe integers serialise as JSON numbers;
floats remain banned; fractional quantities travel as strings under fixed profiles.

**D6 — Identity: wallet address is the primary key; SIWS issues a 7-day JWT.**

**D7 — Notifications: FCM cut from MVP. Polling only.**

**D8 — Money: devnet USDC only. `platform_fee` field exists, set to 0.**
Devnet-only is what makes the build pace safe — an escrow bug costs a redeploy,
not money. If this rule ever looks negotiable, the risk profile changes and the
plan needs rewriting.

**D9 — Dispute: state transition plus an admin CLI arbiter. No console.**

---

## Positioning

**D10 — Evidence-conditional settlement. C2PA and Android attestation are
inputs, not inventions.**

Arrived at after three rounds of competitor analysis:

- Field marketplaces exist: iVueit (400k+ inspectors, REST API, individual
  Vues from $25), Premise (2M+ contributors), Field Agent, Gigwalk, Observa
- Attested capture exists and is patented: Truepic Lens (Controlled Capture,
  C2PA certificate authority, insurance customers)
- The standard exists: C2PA (Adobe, Microsoft, Intel, Arm, BBC, Linux
  Foundation), and it verifies offline with no blockchain required
- Blockchain-anchored provenance exists: Nodle ContentSign, Numbers Protocol
- Agent-hires-human exists: RentAHuman.ai (Feb 2026, REST + MCP, escrow)
- Assurance-thresholded payment exists: Nodle Smart Missions

We therefore do **not** claim novelty in field verification, content
provenance, or connecting evidence to payment. The claim is a Seeker-native
composition: requesters define the assurance level before work begins,
evidence is verified using existing standards, and Solana releases payment
only when the precommitted policy is satisfied.

Rejected alternatives:
- *Consumer-to-consumer white space* — iVueit already sells individual
  inspections to property investors at $25+
- *A new provenance standard (GroundProof)* — competes with C2PA's governance
  position and Truepic's patents. A hackathon project does not win a standards
  race.

**D11 — Verification: an off-chain verifier issues a signed attestation; the
program checks the attester signature and the assurance level.**
Parsing certificate chains, Android attestation and C2PA manifests inside a
Solana program is expensive and unnecessary. The chain enforces "release only
when the verifier I named attests that policy X was satisfied." The attester is
a trusted party — say so. It is named in the policy at creation time and chosen
by the requester, and the evidence remains independently re-verifiable against
the committed policy hash.

**D12 — Release: policy pass opens a challenge window, then auto-releases.
Never immediate.**
Immediate release on the receipt alone would repeat, one layer up, the error
that `photo → hash → chain` makes. A perfect A4 capture of the wrong object
passes policy. The requester may dispute within the window and must name the
failing requirement. Silence auto-releases. 60 seconds for the demo.

**D13 — Assurance ladder A0–A4 for MVP. A5 (second attester) deferred.**

| Level | Payment requires |
|---|---|
| A0 | Worker submission only |
| A1 | Live challenge + evidence |
| A2 | Valid C2PA capture |
| A3 | A2 + device attestation |
| A4 | A3 + Verified Seeker + wallet signature |

Higher assurance costs more. This is the product, not just architecture — the
requester decides how much certainty to buy.

**D14 — Demo: remote purchase verification, Sydney to Melbourne.**
Show it succeed, then show a gallery upload fail and the money stay locked.
The contrast is the demonstration.

**D15 — Capture: c2pa-android with Android Keystore, development certificate,
disclosed.**
Hardware-backed signing needs certificate enrolment. Our certificate will not
chain to the official C2PA trust list, so validators will report an
unrecognised issuer. State this on the slide rather than let a judge find it.

**D16 — The C2PA signing key and the attestation key are separate. No signing
server in MVP.**
Software-backed Keystore C2PA signing needs no configuration; only the
StrongBox path requires an enrolment server. The verifier checks both keys
independently and combines them into an assurance level. Removes certificate
enrolment from the critical path and makes A3 reachable without StrongBox.

**D17 — The escrow stores `policy_hash` plus `required_assurance` as a
readable field.**
The escrow gates on assurance, so the program compares it directly rather than
trusting the attester's word. Also makes on-chain state legible to a judge
without off-chain data. Costs a few bytes.

---

## Environment and tooling

**D18 — No Docker.** Postgres runs natively via Homebrew. Docker Desktop costs
2–4 GB of RAM permanently on a 16 GB fanless machine, to run one database.

**D19 — `anchor-lang` pinned to `=1.1.2`.** Caret semantics silently resolved
to 1.2.0 against a 1.1.2 CLI. Verify pins with `cargo tree`, not `Cargo.toml`.

**D20 — Uppercase for all enum values**, matching `bounty_state`.

**D21 — Coordinates as PostGIS `geography(Point, 4326)`** with a GIST index.
Capture radius is a policy term the escrow depends on, so distance must be
computed correctly rather than approximately.

**D22 — `[provider] cluster = "localnet"` is the default.** `anchor test`
deploys before running scripts, so a devnet default meant every test run
pushed an upgrade and burned SOL. Deliberate deploys pass
`--provider.cluster devnet` explicitly. Safe by default beats remembering a flag.

**D23 — No npm script may be named with a `pre` or `post` prefix.** npm treats
those as lifecycle hooks and runs them uninvited — a script named `prebuild`
caused `pnpm -r build` to run `expo prebuild` and CocoaPods.

**D24 — Platform fee is 0.** A 2.5% constant was invented during Session 4 and
was not in the specification.

**D25 — The program builds under Rust 1.89.0** via the Anchor template's
`rust-toolchain.toml`, independent of the shell default of 1.98.1. Leave it —
a per-directory pin is correct for reproducible program builds.

---

## Canonicalisation and hashing (SPEC.md, Session 5)

**D26 — `canonicalise` accepts only safe integers; every other number is
rejected.** RFC 8785 is the baseline, but its ECMAScript float serialisation
is a cross-language hazard and D5 already bans floats. Fractional quantities
travel as strings under fixed profiles: GPS at exactly 7 decimal places,
token amounts as base-unit integer strings.

**D27 — No unicode normalisation in `canonicalise`.** Matches RFC 8785.
Normalisation tables vary by Unicode version and platform library, which
would make the hash depend on the runtime. Differently-composed strings are
different strings; producers normalise before calling if they need equality.

**D28 — Key ordering is UTF-16 code unit order, per RFC 8785 §3.2.3.**
Chosen over UTF-8 byte order so off-the-shelf JCS libraries agree. The two
orders differ for keys containing characters outside the BMP; SPEC.md
carries an explicit warning for UTF-8-native implementations (Rust).

**D29 — Merkle construction: RFC 6962-style domain separation; odd nodes
promoted.** Leaf nodes re-hash the input under a one-byte leaf prefix and
internal nodes use a distinct one-byte prefix — without the separation an
internal node can be presented as a leaf, which is unfixable after launch.
Odd node counts promote the last node unchanged; Bitcoin's duplicate-last
lets two distinct lists share a root (CVE-2012-2459). Empty list rejected;
single-element root is the leaf node.

**D30 — Nesting depth limit 64; agreement on failure is normative.** An
input accepted by one implementation and rejected by another is a spec
violation, so stack-overflow behaviour cannot be left to differ.

**D31 — Spec documents describe escape sequences in words, never as literal
text, and keep every line ≤ 100 characters.** Literal escapes were
interpreted in transit twice during Session 5, and over-long table rows
displayed truncated during review — in a normative document, display
corruption is indistinguishable from a defective rule.

**D32 — Memory files under ~/.claude/ are written without an approval
prompt.** This happened twice in Session 5, including once after the rule
requiring approval for files outside the repository was added. The
approval gate appears not to cover those writes. Treat those files as
able to change without review, and inspect them periodically rather than
relying on the rule.

---

## Shared package implementation (Session 5 part 2)

**D33 — SHA-256 backend: `@noble/hashes`, exact-pinned at 2.4.0.** It is synchronous,
pure JS, and runs identically in Node and React Native. Rejected: `node:crypto` (absent
in React Native; would force a backend swap at Session 10) and a hand-rolled
implementation (conformance would rest on our tests alone). The test suite cross-checks
it against `node:crypto` as a test-only oracle.

**D34 — Error model: one exported class, `SpecError`, with a readonly uppercase `code`
(SPEC.md §6).** Codes are normative for the TypeScript package only; other
implementations must reject the same inputs but need not match codes. No code exists
for duplicate keys, because this package cannot receive them and a code that can never
be thrown misleads — the same reasoning as the unreachable `Cancelled` variant. Check
order is normative: cycle check before depth check at every container. For multi-fault
inputs the thrown code is unspecified, and tests must not pin one. The plainness check
precedes property checks, and NON_INTEGER_NUMBER applies to finite numbers only. This
removes the two overlaps the conformance tests pin; other overlaps remain unspecified
under §6.3.

**D35 — Value model: accept only values that map exactly onto the JSON data model;
reject anything the implementation would otherwise drop or guess about.** Plain objects
have prototype `Object.prototype` or `null`. Arrays have prototype `Array.prototype`,
are dense, and carry no extra properties. Symbol keys, accessors, non-enumerable
properties and boxed primitives are rejected. Proxies cannot be detected portably and
are a stated caller error. `sha256` and `merkleRoot` accept any `Uint8Array`, including
`Buffer`, hashing exactly the bytes in view; all other byte-like types are rejected.

**D36 — Test scripts name test files explicitly.** On Node 22.22.2, `node --test dist`
executed no test files and reported one trivial pass (tests 1, pass 1, fail 0), so every
earlier pass in packages/shared ran nothing. The script now runs dist/index.test.js; a
missing file exits 1. A test run is only evidence if its summary shows the expected test
count.

---

## API auth (Session 6a)

**D37 — Wallet address is the unique identity key; `users.id` (uuid) is the primary key.**
*Reversal note on D6.* D6 said the wallet address is the primary key. The Session 3 schema
keys every foreign key on `users.id` (uuid) with `wallet_address` unique and not null; that
structure stands. Identity is established by proving control of the wallet key; the uuid is
the join key and the JWT subject. D6's SIWS-and-7-day-JWT content is unchanged.

**D38 — SIWS message format comes from the published standard, and the published package is
the only parser and builder.** Grammar: `phantom/sign-in-with-solana` README at commit
`6f085ace640e58e64e729ac4e8452abb7d3833bb`, quoted in `apps/api/AUTH.md`. Parser/builder:
`@solana/wallet-standard-util` exact-pinned 1.1.2, whose `src/signIn.ts` was verified
byte-identical to `anza-xyz/wallet-standard` commit `dbb6a9821c3d79affc05b2340310941e85d306cd`
(tarball shasum `1e281178c04b52923ea530799c589ed64e5526bc`; empty diff — the registry has no
gitHead, so the diff is the evidence). Only `parseSignInMessageText` and
`createSignInMessageText` are used; `verifySignIn` is never called (it rebuilds the message
from a template, which D39 forbids as the basis of verification).

**D39 — The server verifies the signature over the exact signed bytes it receives, then
parses those bytes and checks fields against the stored challenge. Never rebuild the message
from a template.** Rebuilding assumes the wallet built exactly what we would build; any
divergence would verify a message the user never saw or reject one they did. Works
identically whether the app used wallet `signIn` or built the message itself for a
`signMessage` fallback (fallback named by the MWA spec, commit `0e6d7e75`).

**D40 — ed25519 verification via `@noble/curves`, exact-pinned 2.4.0.** Its sole dependency
is `@noble/hashes` pinned exactly 2.4.0 — the same version as D33, so one hash backend.
`@solana/wallet-standard-util` carries its own `@noble/curves` (caret 1.8.0 range, which
excludes 2.4.0): two instances coexist and this is accepted — only 2.4.0 makes verification
decisions; the 1.x copy just ships with the parser. Gate: `pnpm why @noble/curves` must show
exactly the two expected versions.

**D41 — `auth_challenges` table; single-use enforced by the database.** 128-bit random nonce
(32 lowercase hex), 5-minute expiry, consumed by one atomic UPDATE that sets `consumed_at`
to the app clock passed as a bind parameter — never the database's `now()` — where it is
null and `expires_at` is later than that same parameter, RETURNING the row. One clock for
issuance, expiry and tests. A failed field check after consumption burns the nonce
deliberately: any failed attempt invalidates the challenge.

**D42 — JWT: HS256 via `jose`, exact-pinned 6.2.12.** Published 2026-09-05; major 6.0.0 is
from 2025-02-22, so not a fresh major. Algorithm pinned on verify — the accepted list is
exactly HS256, so `none` and every other algorithm are rejected. Claims: `sub` = `users.id`,
`wallet` = base58 address, `iss` and `aud` (checked on verify), `iat`, `exp` = `iat` + 7 days
(D6). Clock-skew tolerance 60 seconds on time claims. Secret: 256 random bits as 64 lowercase
hex characters in a mode-600 file under `~/bountycam-keys/`, path from `JWT_SECRET_PATH`.
The HMAC key is the 32 bytes decoded from the hex, not the hex text. Generated in Session
6b, never committed.

**D43 — User rows are created lazily on first successful verify.** Upsert keyed on the
unique `wallet_address`; no registration endpoint. Proving control of the key is the whole
of registration.

**D44 — `users.status` becomes enum `user_status` with the single value `ACTIVE`.** By new
migration (D20 uppercase rule). The enum contains only values Session 6 code can produce —
no unreachable variants, the same reasoning as D34 and the `Cancelled` finding. Sessions
that introduce suspension or bans add values by migration when the code that sets them
arrives.

**D45 — Chain allowlist is configuration; devnet only for now.** Message forms `devnet` and
`solana:devnet` both map to canonical `devnet`; every other form is rejected with
`CHAIN_NOT_ALLOWED`. Mainnet later is a config change. There is deliberately no
`CHAIN_MISMATCH` code: with a single-entry allowlist it could never be returned (D34).

**D46 — No token revocation.** A 7-day token remains valid until expiry. Accepted limit,
devnet only (D8); must be revisited before any mainnet plan.

**D47 — No rate limiting on auth endpoints.** Accepted limit for devnet. The nonce is
single-use and challenges expire in 5 minutes, which bounds replay but not brute-force
traffic.

**D48 — Seeker SGT verification deferred to Session 10.** Sign-in proves key possession
only; Seeker-gating belongs to the mobile session that can read the device.

---

## Security documents (12 September)

**D49 — Acceptance moves on-chain; `cancel` fails after it.** D1 kept acceptance
off-chain as a database row lock. That cannot enforce "the requester cannot withdraw
after acceptance" against a requester who calls `cancel` directly. Session 8 adds an
`accept` instruction that moves zero USDC and records the Scout; `cancel` is rejected
from ACCEPTED onward. The database row lock remains as the race arbiter for who gets
to accept first; the chain records the outcome. Supersedes the second half of D1.

**D50 — `SECURITY.md` binds every session; `SECURITY-PRODUCTION.md` binds mainnet
planning.** Changes to either need a D-entry. Read SECURITY.md before touching the
escrow, auth, verifier, canonical serialisation, evidence storage or any key.

**D51 — SIWS statement is "Sign in to BountyCam. This proves you control this wallet
and moves no funds."** The statement is the one line the user reads in the wallet, so it
states what the signature does and does not authorise (SECURITY.md section 4). Vector in
AUTH.md section 12 regenerated; the key and address are unchanged.

**D52 — base58 via `@scure/base`, exact-pinned 2.4.0.** AUTH.md requires base58 (Bitcoin
alphabet) decoding of wallet addresses to 32 public-key bytes but names no library.
`@scure/base` is by the @noble author (paulmillr, sole npm maintainer; repo
`paulmillr/scure-base`), has zero runtime dependencies, and its major 2.0.0 dates from
2025-08-25 — not a fresh major (SECURITY.md section 10 rule). Latest 2.4.0 published
2026-08-28; version-aligned with the pinned `@noble/curves` 2.4.0 and `@noble/hashes`
2.4.0. Gate after install: `pnpm why @scure/base` shows 2.4.0 as a direct dependency of
`apps/api` only.

---

## Session 7a — policy and bounty specification (12 September)

**D53 — The policy domain tag is a field, not a byte prefix.** `domain_tag`, value
`BOUNTYCAM_POLICY_V1`, sits inside the hashed object. A prefix cannot coexist with the
`canonical_json` storage rule (the stored value would be either invalid JSON or not the
bytes hashed); a field round-trips through every consumer that parses and
re-canonicalises; and the policy hash is an unsigned commitment, so placing the versioned
tag inside extends SECURITY.md section 5's signed-object tag convention to commitments
without weakening it.

**D54 — Policy v1 has sixteen fields; a server-assigned salt carries the hash blinding.**
`salt` is 64 lowercase hex characters — 32 bytes from `node:crypto` `randomBytes` through
an injectable randomness module mirroring the clock pattern, source tested. The policy
hash is public on-chain after funding, and with everything else disclosed the exact
coordinates have about 2^33 candidates per snapped cell — GPU-trivial, exactly
SECURITY.md section 11's warning. The salt, not the requirement ids, blinds that search:
ids exist to identify requirements and identifiers get printed, so their non-disclosure
before acceptance stays as defence in depth only, and a leaked id is an ordinary bug
rather than a broken cryptographic property. The salt is never client-supplied, never in
any public view, list item, error or log, and travels with the policy after acceptance.

**D55 — One endpoint creates policy and bounty in a single transaction.** `POST
/bounties` inserts the policy row, the requirement rows and the bounty row together and
returns the full object beside its hash. Policies are write-once; one policy to exactly
one bounty for the life of the database; no orphan-policy case exists to specify. Policy
reuse, if it ever arrives, relaxes this by amendment.

**D56 — Cancellation is a soft state change; `CANCELLED` means unfunded only.** Rows are
never deleted; cancel is a conditional update from `DRAFT`, idempotent by state. A
`CANCELLED` row has `program_account` null — no escrow ever existed for it. Funded
cancellation, and the normative mapping of the remaining `bounty_state` values to their
producing sessions, belong to Session 9's enum reconciliation; the enum is not narrowed.

**D57 — `reward_amount` is a u64 base-unit string; `numeric(20, 0)` column; no doubles.**
Wire form: ASCII digits only, no leading zeros, minimum 1, maximum 18446744073709551615.
The column gains scale zero and a CHECK for the same bounds. No bound check may pass the
value through an IEEE-754 double — above 2^53 a double rounds silently. The funding
transaction's u64 is parsed from the client-verified policy object, never from the
column.

**D58 — Location privacy is a deterministic 0.01-degree grid snap.** Scaled-integer
arithmetic (units of one ten-millionth of a degree), floor division into 0.01-degree
cells, clamped extremes, cell centre returned — no floating point, no jitter, no
server-computed distance in any response. Discovery filters and orders only on the
snapped `location_public` column. Two bounties in one cell disclose co-location to
within roughly a kilometre; accepted, and stated in the spec.

**D59 — Idempotent create via a requester-scoped key and a canonical-form digest.**
`idempotency_key` is a client uuid, unique per requester; `request_digest` is sha256
over the canonical form of the whole request body, so transport re-serialisation still
replays. Same key and digest: 201 replay of the stored bounty. Same key, different
digest: 409. Failed validation never consumes the key. Keys never expire in the MVP —
retention is a recorded production item (POLICY.md section 14, SECURITY-PRODUCTION.md
section 5).

**D60 — No derivable fields inside a hash.** The requirement object has no `sequence`:
it would always equal the item's array position, and an always-derivable field inside a
hash invites a later implementation to derive it differently — the D34 unreachable-code
reasoning applied to data. Canonical array order is the commitment; the database
`sequence` column is a derived read-model copy, never authoritative.

**D61 — GPS profile validated at the producer boundary; the lift has no owner yet.** The
seven-decimal form rules are request validation in `apps/api`, the only producer of
policy objects. They lift into `packages/shared` when a second producer exists — a
client that formats coordinates for a create request. No session in the current plan
builds a mobile bounty-create flow (Session 11 is discovery, detail and accept, all
consumers), so no session owns the lift; the gap is named in POLICY.md sections 5 and
14, and the session that first gives a client a create flow inherits it. `canonicalise`
is never changed for this.

**D62 — Bounty columns follow the policy.** `deadline` and `review_window_seconds` are
dropped: the policy carries durations, and an absolute deadline cannot exist before the
transition that starts its window — a NOT NULL deadline at creation would force an
invented value, the Session 4 fee-constant incident as a column. `title` and
`instructions` collapse to one `prompt` column matching the hashed object. Both by the
Session 7b migrations, whose rollbacks are valid only while the tables are empty
(POLICY.md section 11.3).

**D63 — Session 7b pre-implementation rulings; salt-absence tests named.** Four rulings,
amended into POLICY.md before any code. (1) The 1-to-20 requirements bound runs at step
5 in canonical field position; it is the section 2.1 field rule. The ambiguity came from
the section 2.1 table cell doing double duty — it sets the list bound AND defers
per-item rules to section 2.2 — noted here so the next reader does not re-derive the
question. Test 40 pins the ordering: an empty list beside a malformed `lat` returns
`INVALID_REQUIREMENTS`. (2) Step 6 checks items in index order, keys in canonical order
within an item (`prompt` bounds, then `type` value); a non-boolean `required` is a step
2 type failure, so the only step 6 `required` rule is the list-level
at-least-one-true check, run last. (3) Query integers are validated as strings before
any numeric parse: ASCII digits only, no sign, no leading zeros, at most nine digits —
the length check means no accepted value ever approaches where a double rounds (the D57
rule at the query boundary). (4) The discovery tie-break is `id` ascending: offset
pagination needs a total order. Also recorded: D54 promises the salt never appears in
any public view, list item, error or log — the test naming each surface is test 10
(error body, captured log), test 54 (list item), test 59 (public view). Tests 54 and 59
assert the whole-body property — the salt value and each requirement uuid appear
nowhere in the serialised response, under any key, at any depth — by scanning for the
known injected values. A decision with no named test is how a property survives on
paper and dies in code. The 75-test gate is unchanged; every addition is an assert
inside an existing numbered test. (Gate later moved to 76 within Session 7b: a
ruling added test 76, the `authUser()` wiring guard, amending POLICY.md section 12
and HANDOFF together in their own commit.)

**D64 — Geography entry rule: float8 storage is chosen; read-back is forbidden.** The
gap: POLICY.md named `location_public` as PostGIS geography (D21, section 11) but
never said how a rendered profile string becomes a stored point — found at the first
`ST_MakePoint` call site. Now spec text in section 9.1. Choosing geography chose
float8 storage: every entry path (`ST_MakePoint`, WKT, EWKB) lands in float8 pairs,
so the section 9.1 scaled-integer rule governs the snap computation, not the storage
format. Entry is safe by arithmetic, a claim that stays true: a profile string
carries at most ten significant digits, and decimal text round-trips exactly through
float8 up to fifteen, so the stored double is the unique float8 for the rendered
string. The reverse direction is a prohibition, not an observation about today's
code: no code path may render coordinates back out of a geography column — string
coordinates are produced only by the section 5 profile check and the section 9.1
snap, from the policy `lat` and `lon`; the column may feed PostGIS distance
internals (section 8.4) and nothing else. The reason travels with the rule: a
read-back reintroduces floating point into a value whose whole point is exactness,
and silently — the first fifteen digits agree, so no test comparing rendered strings
would catch the substitution.

**D65 — List-item `required_assurance` comes from the policies read-model column.**
The section 8.2 list-item table gave `reward_amount` a source — the read-model
column — but was silent on `required_assurance`; both lawful readings (the section
7.1 read-model copy on `policies`, or the parsed `canonical_json`) produce the
hashed value. Ruled: the read-model column, the same source as `reward_amount`.
Three reasons. The join to `policies` already exists because `canonical_json` is
needed for the section 9.1 snap, so the column costs nothing. It parallels
`reward_amount` in the same section 8.2 table — one sourcing rule, not two. And a
later assurance filter in discovery indexes that column, so filter and output agree
by construction. The risk that comes with the ruling: a read-model copy can diverge
from the hashed value it copies, and the hash is the only authority — a diverged
column would serve a value the requester never committed to. Drift guard: test 8
gains an assert that `policies.required_assurance` equals the policy value at
creation. Per D63 this is an assert inside an existing numbered test; the 76 gate
is unchanged.

**D66 — Cancel body rule numbered; empty object ruled; the reload is single.** Three
rulings for section 8.7, amended before the code. (1) The no-body rule moved from
prose into the check order as step 2 — before the id form check — so "first failing
step wins" (8.1) has meaning for it; the later steps renumber to 3 through 8. (2) An
empty JSON object is a present body and returns `INVALID_REQUEST`: the rule is body
presence on the wire, not object contents — two bytes of `{}` are a body. Test 69
names the case. (3) Step 7's re-application after a zero-row conditional update is a
single reload, never a loop: by step 5 the caller is proven the requester and
`requester_id` never changes, so zero rows means the state left `DRAFT`, and 7.2 has
no transition back into `DRAFT` — the reloaded row terminates in the cancelled arm
(200) or the not-cancellable arm (409). A second zero-row result would falsify the
state machine and must surface as an error, not a retry; recorded so nobody later
writes a retry loop around an invariant.

---

## Session 8 rulings (14 September)

Seven rulings closing the six questions in
`notes/session8-part1-conflicts-memo.md`. No spec prose existed before these;
the memo deliberately resolved nothing. Item 2 produced two entries because the
A4 hardwiring needed its own.

**D67 — The escrow vault holds the Scout reward and nothing else.**
`create_and_fund` transfers `reward_amount`, not `reward_amount + platform_fee`,
even though the two are equal while the fee is zero. The vault is therefore
definitionally the Scout's reward, and payout releases its full balance without
reasoning about a second claimant. `platform_fee` is removed from the instruction
arguments entirely and is not client-supplied; it remains a stored account field
(D8) that the program initialises to zero. There is no fee input to validate and
nothing in the IDL implying fees are supported behaviour. `PLATFORM_FEE_BPS` and
the fee arithmetic are deleted. Tests assert that the vault balance after funding
equals `reward_amount` and that `platform_fee` is zero. Supersedes the stale
`programs/escrow/SPEC.md` fee row, which recorded an invented 250 bps that never
existed in committed code.

When fees are introduced they do not enter the reward vault. The requester's
payment splits at source — reward to the bounty escrow, fee to separate fee
handling — so settlement never divides a mixed balance. Adding a fee argument or
configuration is part of that deliberate work, together with the destination,
authorisation model, refund and dispute behaviour, tests and disclosure required
by SECURITY.md section 8. Whether the fee is earned at funding or at successful
settlement is left open: collecting at funding creates a refund path for
cancelled bounties that collecting at settlement avoids. Decided when
monetisation is built.

**D68 — Acceptance requires a server-issued eligibility voucher; the Scout still
signs and submits.** Supersedes D49's arbiter sentence. A permissionless `accept`
lets any wallet claim every funded bounty for transaction fees alone, blocking
legitimate Scouts and locking requester funds until expiry — and under D2 the
relayer would fund that attack. An API co-signature on the transaction itself was
rejected as broader authority than necessary and contrary to SECURITY.md
section 2.

The BountyCam eligibility service issues a narrowly scoped authorisation: Scout X
may accept Bounty Y under the already-committed policy until time T. The voucher
binds `bounty_id`, the Scout wallet, the committed policy hash, an expiry, a
unique voucher id, and the program id. The Scout signs and submits `accept`
themselves, so a copied voucher is useless to another wallet. The database
atomically reserves the bounty before issuing, so at most one active voucher
exists per bounty; the program remains the final authority on whether acceptance
succeeds. The reservation is enforced by a uniqueness or locking constraint, not
application logic, and chain safety does not depend on it: if two valid vouchers
were issued in error, only the first on-chain `accept` succeeds, because the
Funded-to-Accepted transition happens once.

The voucher attests that a Scout satisfies a policy committed at funding. It can
never set or change that policy. The service cannot move funds, change the
reward, the requester or the evidence policy, or accept on a Scout's behalf.

Mechanics: a dedicated eligibility key, separate from the attester key, so a leak
of one does not grant the other; a single program-level eligibility authority for
the MVP rather than a per-bounty choice, held as explicit program or config state
and never an implicit client assumption; and no on-chain nonce account — the
state transition is the replay defence and the voucher id serves the database
only.

Voucher verification establishes, at minimum: a correct ed25519 verification
instruction; the expected eligibility authority public key; the exact expected
voucher message schema and domain; the correct program id and domain separation;
voucher `bounty_id` matches the bounty being accepted; voucher Scout wallet
equals the `accept` signer; voucher policy hash equals the policy hash already
committed for that bounty; the voucher has not expired per the on-chain Clock,
not merely per the issuing service; and the bounty is in a state that permits
acceptance. The precompile-mechanics checks are common with `submit_attestation`
and specified once (D71); the bindings above are acceptance-specific.

Availability: if the eligibility service is down, new accepts stop. Funding,
already-accepted missions and settlement remain operable. Accepted for the MVP as
the cost of preventing permissionless claim griefing. `expire` remains mandatory
in Session 9 — vouchers prevent unauthorised accepts, not abandonment, so the
requester still needs a deterministic recovery path.

**D69 — A4 stops naming Seeker hardware; the qualifying rule set is committed in
the policy.** D13's ladder defines A4 as "A3 + Verified Seeker + wallet
signature", making the top assurance tier unreachable without one Android
handset. The integer travels into policy v1 as `required_assurance`, into the
escrow as a `u8`, and into the on-chain payout comparison (D17), while its
meaning lives only in prose — so redefining A4 later would change what
already-committed policy hashes meant with no hash changing. That contradicts PRD
section 8, where Seeker is the initial distribution layer rather than the market
boundary, and section 52.

The ladder now describes the level of trust required. Seeker and SGT become one
qualifying route rather than the definition. The program continues to compare the
`u8`; what satisfies it is decided off-chain against a rule set named in the
policy.

The committed policy therefore carries two fields, not one: `required_assurance`
and an `eligibility_profile_id` with its hash, identifying the qualifying rule
set for that bounty. For the MVP the only A4 profile is `A4_SEEKER_V1` = valid A3
evidence + Scout wallet signature + verified SGT eligibility. D68's voucher
attests that the named Scout satisfies that specific committed profile, never
that the service currently considers them level 4.

A new A4 route — another hardware-backed identity, a verified credential path —
is a new profile, never an edit to `A4_SEEKER_V1`. New bounties may adopt it;
already-funded bounties keep the meaning they were funded with. A general
`policy_version` system is deliberately not built: a stable committed profile
identifier is sufficient for the MVP and leaves a clean migration path if the
ladder itself ever changes.

In practice A4 still means Verified Seeker for the hackathon, because SGT is the
only implemented route. The difference is that the ladder does not say so, and a
second route later is a verifier and profile change rather than a redefinition of
the ladder or a change to payout logic.

Sequencing: adding `eligibility_profile_id` is a policy v1 field addition and
changes the canonical object, so every policy hash changes. Harmless now — no
bounties exist outside testing — but it must land before any bounty intended to
outlive development, or the migration this entry exists to avoid is inherited
anyway.

**D70 — On-chain signed messages are fixed binary layouts, never canonical
JSON.** SECURITY.md section 5 forbids a second canonical-serialisation
implementation; section 6 requires on-chain attestation verification. Both hold
only if the bytes the program verifies are not canonical JSON: otherwise the
program must rebuild them in Rust, which is the forbidden second implementation,
and must agree byte-for-byte with TypeScript across the UTF-16 key-ordering rule
`packages/shared/SPEC.md` already flags as a cross-language hazard.

Two separate schemas, each with its own domain tag, so an eligibility signature
can never validate as an evidence attestation or the reverse:
`BOUNTYCAM_ELIGIBILITY_V1` for D68 acceptance vouchers, and
`BOUNTYCAM_ATTESTATION_V1` for evidence and assurance attestations. Both carry a
`schema_version` in the signed bytes from the outset, so a future format change
cannot silently reinterpret old signatures. `schema_version` is retained even
though `_V1` appears in the domain tag: the tag identifies the message namespace,
the field gives the verifier an unambiguous value to compare and reject on.

Each schema defines its complete field set, with exact widths and offsets. There
are no optional fields in a schema. Fields required only by one message type
exist only in that message type — the two schemas are intentionally different and
neither reserves space for the other's fields. Whether
`eligibility_profile_hash` belongs in the attestation is decided in the binary
specification: if yes, 32 bytes always allocated; if no, absent entirely. Voucher
expiry always exists, per D68. Attestation expiry exists only if the attestation
needs it, never for symmetry.

The attestation payload carries, at fixed offsets: domain tag; schema version;
deployment identifier; program id; bounty id or address; requester wallet; Scout
wallet; evidence root; committed policy hash; achieved assurance level;
issued-at. The voucher payload carries the acceptance-specific set per D68.

Encoding rules for the signed path: public keys and hashes as 32 raw bytes;
assurance level and version as fixed-width integers; timestamps as fixed-width
integers; little-endian byte order, aligned with Solana and Rust convention and
locked by the test vectors; fixed-byte-length domain tags, never variable runtime
strings; no strings, delimiters, optional fields or key ordering anywhere on the
signed path. Cluster separation uses a fixed deployment identifier committed in
program configuration, never a signed variable string such as "devnet", so a
signature issued for one deployment cannot replay against another.

The richer JSON attestation survives off-chain for APIs, storage and human
inspection, and is non-authoritative for settlement. The verifier builds both
representations from the same typed internal object and never generates the
signed binary payload by parsing the published JSON.

Specification before implementation, in either language. For each message type
the vectors give: a field table with offset, width and encoding; exact input
values; the expected byte sequence in hexadecimal; the expected signature
message; integer and timestamp boundary cases; a mutation test per
security-relevant field; cross-type rejection proving a voucher cannot validate
as an attestation; and version and domain mismatch rejection. TypeScript and Rust
tests consume the same immutable vectors. Rust implements no canonical JSON at
all — it checks fixed offsets against the bytes the ed25519 precompile verified.

**D71 — Ed25519 verification: canonical shape only, explicit index, top-level
only.** D68 and D70 put off-chain signature verification on the money path in two
instructions. A Solana program cannot verify ed25519 directly; the native
verifier runs as a separate top-level instruction and the program confirms,
through the Instructions sysvar, that the verification it depends on already
happened over the bytes it expects. Every rule below closes a gap between "a
signature was verified" and "my signer signed my message".

Invocation context. `accept` and `submit_attestation` require the current
invocation stack height to be exactly the top-level height. Invocation through
CPI is rejected outright. The Instructions sysvar is used only to locate and
inspect the designated ed25519 instruction, never to infer how BountyCam itself
was reached.

Locating the verification. Each instruction takes a
`verification_instruction_index` — not the preceding instruction, not a
hard-coded transaction index. The program verifies the supplied Instructions
sysvar account key is exactly the native Instructions sysvar; reads the current
top-level index; requires `verification_instruction_index <
current_instruction_index`, so the verification has already executed; loads
exactly that instruction; and requires its program id to be the native ed25519
verifier. A wrong, missing or out-of-range index is rejected. Because adjacency
is not required, compute-budget and other unrelated instructions compose freely.

Canonical shape. The shared routine is not a general ed25519 instruction parser;
it recognises the one shape BountyCam produces. All three instruction-reference
fields — `signature_instruction_index`, `public_key_instruction_index`,
`message_instruction_index` — must indicate the ed25519 instruction itself
(`u16::MAX`), so signature, key and message can never be sourced from elsewhere
in the transaction. This makes the verified-here-but-read-from-there class
structurally impossible rather than caught by a check. Required exactly:
signature count 1; the canonical padding byte; one 14-byte offset structure; key,
signature and message each at their exact expected offsets; message length equal
to the expected D70 message length; total instruction-data length equal to the
canonical layout plus that message length; no trailing or unreferenced bytes; and
the expected account shape with no unexpected accounts.

Message comparison is reconstruct-then-compare. The program builds the complete
expected D70 binary message from trusted on-chain state and validated instruction
inputs, then requires the message in the designated ed25519 instruction to equal
it byte for byte. It must never parse attacker-supplied message fields and
selectively compare them against state: a field nobody thought to compare is a
field the attacker chooses.

Shared mechanics, separate bindings. One helper —
`verify_ed25519_instruction(sysvar, index, expected_authority,
expected_message)` — establishes only that exactly one verification at the
designated index verified exactly those bytes under exactly that key. It knows
nothing of eligibility versus evidence. `accept` constructs the
`BOUNTYCAM_ELIGIBILITY_V1` bytes and supplies the eligibility authority;
`submit_attestation` constructs the `BOUNTYCAM_ATTESTATION_V1` bytes and supplies
the attester authority. D70's separate domains keep the two un-interchangeable.

Duplicates. Multiple ed25519 instructions may exist in a transaction. Only the
one at the supplied index binds this invocation; others neither satisfy nor
invalidate it. Uniqueness is not scanned for — the explicit index is the binding.

Interoperability trade-off, chosen deliberately. BountyCam accepts only its
canonical self-contained one-signature shape. A differently encoded but
cryptographically valid ed25519 verification is rejected. This is intentional on
the settlement path; integrations construct the canonical form.

Tests, at minimum: fake Instructions sysvar; wrong verification index; index
equal to or after the current instruction; wrong program at the index; zero
signatures; two signatures; correct signature over the wrong message; correct
message signed by the wrong authority; eligibility message presented to the
attestation path and the reverse; each of the three offset instruction-index
fields redirected elsewhere; malformed or truncated offsets; shifted key,
signature or message offsets; wrong message length; trailing bytes; mutation of
every signed field; `accept` through CPI rejected; `submit_attestation` through
CPI rejected; two identical valid ed25519 instructions with the first designated,
succeeding; the same with the second designated, succeeding; and a valid matching
signature present elsewhere while the designated index does not match, rejected.

Invariant: BountyCam does not prove that an ed25519 verification exists somewhere
in the transaction. It proves that the designated earlier native ed25519
instruction verified exactly one BountyCam-defined message under exactly the
authority this instruction expects.

**D72 — Three concepts, three names; "challenge" alone is not a valid term.** The
word appears 124 times across the repo carrying three unrelated meanings:
authentication, evidence freshness, and the post-submission dispute period.
Session 8 introduces the second as new normative text and Session 9 the third as
an on-chain transition, so two unrelated concepts called "challenge" would arrive
in adjacent sessions.

From this point: **SIWS challenge** is the authentication challenge proving
wallet control; **capture nonce** is the unpredictable value issued for a mission
and bound into captured evidence; **review window** is the period after a valid
submission in which the requester may dispute before automatic settlement. Bare
"challenge" is not a normative BountyCam term and is not used for either the
capture nonce or the review window.

Existing committed names are kept. The hashed-policy wire field stays
`challenge_window_seconds`: renaming it would change the canonical policy
representation and every hash for no benefit. The on-chain field stays
`review_window_secs`, which is the better name and becomes the preferred
terminology everywhere outside the existing wire representation. The shipped
authentication interface — `/auth/siws/challenge` and the `auth_challenges` table
— is external and unchanged; `siws_challenge` applies to new prose, types and
code only.

A mapping note goes in POLICY.md, the Session 8 specification, and anywhere the
policy schema is documented: the canonical policy JSON field
`challenge_window_seconds`, the on-chain field `review_window_secs`, and the
prose term review window are the same concept; `challenge_window_seconds` is
retained solely for compatibility with the existing hashed-policy schema and must
never be read as the SIWS challenge or the capture nonce.

The new capture mechanism uses `capture_nonce` consistently in specifications,
APIs, database fields, typed objects, evidence manifests, tests and comments. A
field named merely `nonce` is not used — authentication already has nonce
terminology of its own. No on-chain or canonical-policy migration is required.

**D73 — The capture nonce is issued at capture-session start, not at accept.** No
normative definition existed anywhere: one line in an informative POLICY.md table
and one positioning sentence in HANDOFF. Issuing at accept would let a Scout hold
the nonce for hours before arriving, leaving a staging window wide enough that A1
would promise more than it delivers. The value of the mechanism is the narrowness
of that window.

Mechanism, deliberately thin. The Scout accepts normally. On arrival they press
Start Capture and the app calls a dedicated endpoint. The API verifies the
authenticated Scout holds the active assignment and the bounty is in a state
permitting capture, generates a `capture_nonce` through the existing injectable
randomness module (D54), and stores it server-side bound to bounty, Scout and
assignment with issue time, expiry, and status (active, consumed, expired). The
nonce returns to the app and is bound into the evidence manifest. A valid
submission consumes it atomically, so a retry cannot produce a second A1
submission from the same value. No persistent capture-session domain object is
built: for the MVP, capture-session start is the issuance event plus its validity
window.

A1 is therefore defined as: evidence bound to a fresh, unpredictable capture
nonce issued to the assigned Scout after capture was explicitly started and
before the evidence was produced. A1 is never described as proof that the
physical scene is genuine. It establishes freshness relative to issuance, subject
to trust in the issuer and the capture pipeline.

Expiry and re-issue. The nonce has a short TTL, configured in one authoritative
place rather than as literals in clients, short enough that live capture stays
meaningful and long enough for a normal mission. An existing nonce is never
silently extended. On re-issue the previous nonce is marked superseded and a new
random value issued; evidence intended for A1 must carry the currently valid
nonce, and evidence captured under a superseded nonce is never upgraded to A1
because the Scout later reconnects.

Binding. The verifier confirms the nonce was issued for the same bounty, assigned
Scout, assignment, deployment and validity interval. The assignment identifier is
bound as well as the bounty identifier, so a nonce from an earlier assignment
cannot be reused after a bounty expires and is reassigned. The nonce need not
stay secret after issuance: its property is unpredictability before issuance plus
single use, not confidentiality.

Offline. A1 requires connectivity at capture-session start. The app may still
permit offline capture if the product wants that fallback, but such evidence
cannot honestly satisfy A1, and no nonce is issued retroactively. The UI
distinguishes live capture, where A1 and above are possible, from offline
capture, where the maximum assurance is below A1 — stated before capture begins,
not discovered at grading.

Tests, at minimum: a wallet other than the assigned Scout cannot request a nonce;
no issuance before acceptance; none for a completed, cancelled or expired bounty;
two issued values are unpredictably distinct; expired rejected; consumed
rejected; a nonce from another bounty rejected; from another Scout rejected; from
an earlier assignment of the same bounty rejected; re-issue supersedes the
previous; evidence under a superseded nonce cannot satisfy A1; a successful
submission consumes the nonce exactly once; offline evidence with no previously
issued valid nonce cannot be graded A1.

---

## Session 8 flagged-item rulings (14 September)

The seven items the conflicts memo flagged outside the six questions. D74, D75
and D76 touch what Session 8 builds; D77 to D80 shape the spec session and
Session 9.

**D74 — One program-level arbiter authority; no per-bounty arbiter.**
`create_and_fund` currently takes `arbiter_authority` as an unchecked account and
stores it per bounty, so a direct caller names any arbiter including themselves.
Inert today — nothing reads it — but Session 9's `resolve` moves money to one side
of a dispute, and a self-nominated arbiter would resolve every dispute in their
own favour. D9 already describes a dedicated administrative arbiter, singular and
protocol-level; the code does not enforce that reading.

For the MVP: `arbiter_authority` is removed from `create_and_fund` arguments and
from the per-bounty escrow account. The authorised arbiter public key is held in
explicit program or config state. `resolve` requires the signer to equal that
configured authority. The key is dedicated — separate from the eligibility
authority (D68), the evidence attester, the relayer, and any ordinary API key. A
direct caller has no way to nominate an arbiter.

The arbiter is materially more privileged than D68's eligibility authority and is
separately keyed and separately documented for that reason: eligibility
authorises who may accept work; the arbiter causes locked funds to be released to
one side of a dispute.

Rotation semantics, defined now though rotation is not implemented. The
configured arbiter is protocol state and bounties do not snapshot an arbiter at
funding. If the protocol rotates the arbiter through an authorised configuration
change or upgrade, the currently configured arbiter becomes authoritative for all
unresolved disputes, including bounties funded earlier. This avoids stranded
disputes if a key is lost or compromised — `resolve` being the only exit from
`DISPUTED` — and matches a protocol-level administrative role rather than a
per-bounty contractual choice. No broadly callable `set_arbiter` instruction is
added: introducing rotation requires its own authorisation model, tests and
SECURITY decision.

Tests, at minimum: the requester cannot supply an arbiter during funding; an
arbitrary signer cannot resolve; the requester cannot resolve their own dispute by
virtue of being requester; the Scout cannot resolve; the eligibility, attester and
relayer keys cannot resolve; the configured arbiter can resolve only from
`DISPUTED`; the arbiter cannot alter the reward amount or destination beyond the
finite outcomes `resolve` encodes; and altering unrelated bounty or account data
cannot substitute another arbiter. The account-layout change lands in the Session
8 redeploy.

**D75 — `UnauthorizedRequester` is split; error variants are append-only.** One
error currently serves two failures: "the signer is not the requester"
(`cancel.rs:13`) and "this token account is not yours" (`cancel.rs:30`,
`create_and_fund.rs:33`). Error codes are the API surface the mobile app reads,
and a user told they lack requester authority when they actually supplied a wrong
account looks in the wrong place. Session 8 adds errors regardless, so the split
costs one appended variant now rather than a renumber later.

Three distinct meanings: `UnauthorizedRequester` — the signer is not the requester
authorised for this bounty, retained at `cancel.rs:13`.
`TokenAccountOwnerMismatch` — the supplied token account is not owned by the
expected wallet; new, taking over `cancel.rs:30` and `create_and_fund.rs:33`.
`MintMismatch` — the supplied token account has the wrong mint, unchanged.

Ownership and mint are not combined. They are already checked independently and
are different failures; keeping them separate gives the client materially better
feedback. The new variant is named for the account relationship that failed, not
as another generic `Unauthorized...`.

Compatibility rule, binding on the program from here: Anchor error variants are
append-only. New errors are added at the end of the enum. Existing variants are
never reordered, inserted around, or removed, so previously published numeric
codes — 6000 plus the variant index — remain stable across upgrades. If an
existing error later needs finer semantics, the old variant keeps its code for its
existing uses and a new variant is appended for the newly distinguished condition;
the enum is not restructured.

Tests, at minimum: wrong requester signer yields `UnauthorizedRequester`; correct
requester with a token account owned by another wallet yields
`TokenAccountOwnerMismatch`; correct owner with the wrong mint yields
`MintMismatch`; correct requester, owner and mint passes these checks; and
existing error variants retain their current numeric codes after the Session 8
additions.

**D76 — The on-chain `Cancelled` variant is removed; cancellation is an event plus
a database record.** `cancel` returns the USDC and closes both the vault and the
bounty account, so no observer ever sees a bounty in `Cancelled` — they see an
account that used to exist. SECURITY.md section 9 requires that a variant exist
only if an instruction can enter it with defined exits and tests both ways; this
one fails that on its own terms. Setting the state immediately before closure
would satisfy the letter while leaving the data unreadable, which is worse than
dropping it because it looks solved.

Cancellation is therefore: `Funded` → refund reward → emit `BountyCancelled` →
close the reward vault → close the bounty account. The event carries enough stable
information for reconciliation: bounty identifier or address, requester, reward
amount refunded, token mint, and cancellation time or slot. Events live in
transaction logs and are not an archival guarantee — the database is the durable
record and the event is the reconciliation anchor.

The database keeps `bounty_state = CANCELLED`, `cancelled_at`, the cancellation
transaction signature, whether the bounty had previously been funded, and any
other lifecycle information needed for requester statistics. Requester profile
metrics derive from the database, never from persistent cancelled Solana accounts.

Cancellation is distinguished from harmful requester behaviour: cancelling before
a Scout accepts may be counted but normally carries little or no reputation
impact; after acceptance the requester cannot unilaterally cancel under the escrow
rules; disputes, settlement outcomes and approval behaviour are tracked separately
and are the more meaningful trust signals.

The intended mapping, which settles half of the enum reconciliation BACKLOG
assigns to Session 9: DB `CANCELLED` unfunded means no on-chain bounty ever
existed (POLICY.md 7.2); DB `CANCELLED` funded means the bounty existed on-chain,
was refunded and closed, with the cancellation transaction and event recorded; the
on-chain `Cancelled` enum variant is removed.

**D77 — Policy-to-chain bindings are enforced by the attester, not the program.**
`create_and_fund` takes `required_assurance`, `deadline` and `review_window_secs`
as arguments and stores `policy_hash` as opaque bytes. Nothing makes the two
representations agree, so a direct caller can fund a bounty whose on-chain gate
says assurance 0 while its committed policy says 4. The program cannot check this:
doing so requires parsing the canonical policy, which D70 keeps off-chain. After
D69 the gap is sharper still — the program gates on `required_assurance` while
that number's meaning lives in an eligibility profile inside the policy.

The attester is the only layer that sees both. Before signing it must obtain the
exact canonical policy whose hash is committed on-chain; recompute and verify
`policy_hash`; read the settlement-critical values from that policy; read the
corresponding values from the on-chain bounty account; require exact agreement;
and refuse to attest on any disagreement.

The bound set is not an open-ended manual list. **Policy-to-chain bindings**
becomes a normative concept in the policy specification: whenever a policy value
is duplicated into program state, its binding rule is registered there. The
current set is `required_assurance`; `deadline`; `review_window_secs` against the
canonical policy's `challenge_window_seconds` (D72's mapping); and D69's
eligibility profile identifier and hash.

`BOUNTYCAM_ATTESTATION_V1` carries the settlement-critical chain values the
attester checked — `policy_hash`, `required_assurance`, `deadline`,
`review_window_secs`, `eligibility_profile_hash`, achieved assurance, alongside
the existing bounty, requester, Scout and evidence bindings. The signature then
means: I verified evidence against Policy P, and I verified that this bounty's
settlement-critical chain state agrees with Policy P. The program reconstructs
those values from its own account state and compares the complete message
byte-for-byte per D71, so it never parses canonical JSON. A second property
follows and should not be optimised away as redundant: because reconstruction uses
current state, an attestation cannot be valid for a bounty whose
settlement-critical state differs from what the attester inspected.

This resolves D70's first open question: `eligibility_profile_hash` is present in
the attestation, 32 bytes always allocated. Attestation expiry remains open.

Transaction budget. The ed25519 instruction carries the message inline plus a
32-byte key, 64-byte signature and 16-byte header, so the additional bindings push
it toward 400 bytes. With `submit_attestation`'s own data, its account keys, the
fee payer signature and the blockhash, the 1232-byte transaction limit is
reachable. The binary specification computes this budget explicitly rather than
discovering it on device; domain tag length is a deliberate lever.

Authority split, stated rather than hidden. `policy_hash` is the immutable
commitment to what the requester specified. The duplicated on-chain fields are
authoritative for the program's mechanical state transitions. A bounty whose two
representations disagree is malformed: it can never receive a valid attestation
and therefore cannot progress through the attestation-gated settlement path.

Defence in depth. The API performs the same comparison before a bounty becomes
discoverable, so honest users never create malformed jobs — but chain safety does
not depend on it, because a direct caller bypasses the API. Session 15's
reconciliation classifies a policy-chain mismatch as malformed and surfaces it
rather than guessing which representation was intended.

Honest limitation. A direct caller may still fund inconsistent values. That locks
their own funds in a bounty that cannot attest, harms no one else, never becomes
discoverable, and recovers through `expire`. Acceptable for the MVP because the
inconsistency cannot lower the evidence bar and still produce a valid payout.

Tests, at minimum: all bindings match, attester issues; policy hash does not match
the canonical policy, refuse; on-chain `required_assurance` differs from the
policy, refuse; deadline differs, refuse; review window differs, refuse;
eligibility profile differs, refuse; one-field mutation after attestation, the
program rejects because the reconstructed D70 bytes no longer match; a malformed
direct-funded bounty is not discoverable by the API; a malformed bounty cannot
obtain a valid attestation; and a malformed bounty remains recoverable through the
defined expiry path.

**D78 — One canonical implementation for production; independent implementation
for verification only.** SECURITY.md section 5 says canonical serialisation has one
implementation and nobody keeps an alternative. `packages/shared/SPEC.md` says the
functions are computed independently by the mobile app, the API and a standalone
verifier, gives Rust implementers normative key-ordering guidance, and BACKLOG's
verification gate requires that a standalone script reproduce the Merkle root byte
for byte. A gate satisfied by the same code that produced the value proves
nothing, so the rule and the gate pull opposite ways. D70 did not resolve this: it
removed canonical JSON from the program, while Session 17 is off-chain tooling
whose purpose is reproducibility for a human.

Production rule, unchanged in substance: production producers and money-path
consumers use the single canonical implementation in `packages/shared`. No
production service, mobile client or settlement component maintains an
alternative.

Independent verification tooling is a deliberate exception, because independence
is its purpose. The Session 17 verifier is implemented independently of
`packages/shared`, preferably in a different language or runtime such as Rust so
it does not inherit implementation assumptions; it consumes the normative
specification directly and passes the same immutable vectors. It never signs
attestations, issues eligibility vouchers, determines whether payout occurs, feeds
reconstructed values back into the program, or forms part of the mobile app's
normal operation. It is never bundled into capture, submission, acceptance or
settlement — a verifier that becomes a runtime dependency stops being independent
and becomes a second production implementation on the money path.

Authority when implementations disagree, in order: the normative specification;
the published immutable vectors; the production `packages/shared` implementation;
the independent verifier. Neither implementation is authoritative merely because
it existed first. Where a disagreement concerns an input a normative rule already
covers, whichever violates the specification is wrong. Where the specification
does not resolve it, this is a specification gap: clarify the normative rule, add
a worked vector for the case, and update whichever implementations fail the
clarified rule. Published vectors are not silently rewritten; a genuine change of
semantics goes through an explicit specification version change.

CI uses the verifier as a development and release gate, never a runtime
dependency. Both implementations run the shared vectors. The load-bearing check is
cross-generation: one implementation generates evidence bundles and the other
verifies their roots, with varying inputs rather than a fixed pair — a fixed pair
is only another vector, and divergence outside the published vector set is exactly
what this catches. CI fails if either implementation diverges from the normative
vectors or from the other.

**D79 — `bounties.state` tracks confirmed chain state; `assignments` owns the
reservation.** POLICY.md 7.2 names Session 8 as the first producer of `ACCEPTED`
but defines no transition into it, and D68 introduced a gap between voucher
issuance and on-chain confirmation that the database had no way to represent.

No `RESERVED` bounty state is added. Reservation is not a lifecycle state of the
bounty; it is a transient claim attempt by one Scout, and `assignments` already
owns it through the unique partial index on `(bounty_id) WHERE status = 'ACTIVE'`
built in Session 3. A `RESERVED` state would duplicate that, add an enum value
with no chain counterpart, add timeout transitions, add reconciliation cases, and
create a second place for the bounty row and the assignment row to disagree.

Voucher issuance atomically creates the active assignment reservation under the
existing constraint, issues the voucher bound to that Scout and bounty, and leaves
the bounty state `AVAILABLE`. `AVAILABLE` means the bounty has not been confirmed
as accepted on-chain; it does not mean the bounty is currently offerable.
Discoverability therefore requires both `bounty_state = AVAILABLE` and no active
unexpired assignment reservation — amending POLICY.md 7.3, which currently makes
the discoverable set exactly `AVAILABLE`. A second Scout never sees a bounty while
the first is submitting.

The durable transition `AVAILABLE` to `ACCEPTED` occurs only on confirmed on-chain
acceptance, at which point the assignment moves from reservation to confirmed. The
chain is authoritative: voucher issuance or database reservation alone never
produces `ACCEPTED`. "Confirmed" means observed from chain confirmation, never
from a submission response — SECURITY.md section 12, and the MWA case in BACKLOG
where the wallet submitted successfully while the app reported failure.

If the Scout never submits, the transaction fails, or the voucher or reservation
TTL expires before confirmation, the reservation is released or expired and the
bounty remains `AVAILABLE`, provided the chain still shows it acceptable. A stale
database reservation never permanently blocks a bounty.

Adjacent correction to POLICY.md 7.2: Session 15 is not the first producer of
`AVAILABLE`. The production path projects confirmed chain results into the
database immediately — confirmed `create_and_fund` produces `AVAILABLE`, confirmed
`accept` produces `ACCEPTED`. Session 15 reconciliation is the backstop that
repairs missed, crashed or inconsistent projections, not the mechanism by which
the application discovers what happened. Otherwise a newly funded bounty would be
undiscoverable until a later reconciliation pass.

Session 15 reconciles: chain funded but database behind, repair to `AVAILABLE`;
chain accepted but database behind, repair to `ACCEPTED`; database accepted with
no chain acceptance, flag and repair against confirmed transaction history; stale
reservation without on-chain acceptance, expire the reservation.

Tests, at minimum: confirmed funding moves the database to `AVAILABLE`; voucher
issuance creates one active reservation and leaves the bounty `AVAILABLE`; a
reserved bounty is excluded from discovery; a second active reservation cannot be
created; confirmed on-chain accept moves the bounty to `ACCEPTED`; voucher
issuance without an on-chain accept never produces `ACCEPTED`; a failed accept
releases the reservation and the bounty becomes discoverable again; an expired
voucher or reservation becomes claimable again; two racing Scouts yield only the
chain-confirmed winner as the accepted assignment; a database winner cannot
override a different valid on-chain winner; and reconciliation repairs a missed
`AVAILABLE` or `ACCEPTED` projection.

**D80 — `programs/escrow/SPEC.md` is replaced wholesale, not patched.** The
existing file was written after Session 4's implementation, documents what was
built rather than constraining it, and recorded an invented 250 bps fee as though
intended — superseded by D67, but the rest has never been checked against
anything. Correcting one row and adding Session 8's normative material would
legitimise every unreviewed statement around it by proximity.

Authority order for the replacement: held D-entries and SECURITY decisions first;
the intended state machine and policy specifications second; existing source and
tests third, and only for behaviour no decision or specification already governs;
the old SPEC.md fourth, as a checklist of topics that may need covering and never
as authority.

Existing behaviour is read from source and tests directly, and is not
automatically converted into a normative requirement. Where current code conflicts
with a held decision, a security invariant or the intended lifecycle, that is
recorded as an implementation discrepancy to fix — never laundered into the new
specification by widening it to match.

The old file is superseded rather than incrementally repaired; git history
preserves it and the active tree carries no second stale normative document. The
new file states at the top that it supersedes the previous post-hoc
specification.

Scope: the whole account structure and state machine, and the instructions that
exist or are being built. `approve`, `reject`, `resolve` and `expire` remain
Session 9's to specify — writing them now would repeat the same error in the other
direction.

Structure is modular. `programs/escrow/SPEC.md` carries normative program
behaviour, accounts, instructions, state transitions, authorities and invariants.
The D70 and D71 binary layouts and their golden vectors live in a dedicated
binary-message specification, because they are consumed by the program, the
verifier service and the Session 17 independent verifier, and only the first of
those reads an escrow specification. Shared policy and canonicalisation rules stay
in `packages/shared/SPEC.md`. The escrow spec references these rather than
duplicating byte-level definitions.

Reconciliation before the replacement is declared complete: every existing
instruction is represented; every account field has a defined purpose; every enum
state is reachable with defined exits; every authority is defined and enforced;
every money-moving path has explicit preconditions and destinations; every stored
field is either required by the specification or removed; every held decision D67
to D79 is reflected; existing tests are checked against the new requirements; and
any source behaviour differing from the new spec becomes an explicit
implementation task.
