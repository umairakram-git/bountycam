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

---

## Spec session step 3 rulings (16 September)

Six rulings from the escrow specification session, step 3. They close the implementation
discrepancies recorded in `packages/shared/MESSAGES.md` section 10 and the further gaps found
by reading the Session 4 source, and precede the wholesale replacement of
`programs/escrow/SPEC.md` under D80.

**D81 — Windows are stored as durations; absolute times are computed on-chain.**
`create_and_fund` takes an absolute `deadline`. D62 removed absolute deadlines from the policy
because none can exist before the event that starts its window, so D77's deadline binding
compared the chain against nothing, and `MESSAGES.md` section 6 used that value as the
attestation's only time bound. The missing upper bound and the unvalidated review window
(`MESSAGES.md` section 10, items 4 and 5) are symptoms of the same gap.

`create_and_fund` takes `acceptance_window_secs`, `completion_window_secs` and
`review_window_secs`, each `i64`, and no absolute deadline. All three are stored on the bounty
account. The program requires each to be greater than zero and no greater than a compiled
ceiling: 2592000 seconds (30 days) for acceptance, 2592000 for completion, 86400 (24 hours)
for review. Review greater than zero is D12's never-immediate rule, not a parameter choice.
The 60-second product minimums stay off-chain in POLICY.md section 2.1, so tightening a
product limit needs no upgrade; widening past a ceiling does.

At funding the program stores `acceptance_cutoff` as the Clock `unix_timestamp` plus
`acceptance_window_secs`. At `accept` it stores `deadline` as the Clock `unix_timestamp` plus
`completion_window_secs`. Both additions are checked even though the ceilings make overflow
practically unreachable. `accept` succeeds while the current time is at or before
`acceptance_cutoff`. `deadline` has no meaningful value before acceptance: it is written by
`accept` and consumed only from `Accepted` onward; its representation before that is the
specification's to define, and no instruction reads it in `Funded`. The cutoff is anchored to
the funding transaction's Clock, not to database discoverability; the two differ by projection
lag and the chain value governs.

`acceptance_window_secs` and `completion_window_secs` are stored on-chain but are not
duplicated into `BOUNTYCAM_ATTESTATION_V1`. The attester verifies both against the policy
(D84). `deadline`, computed and stored at `accept`, is the signed consequence of
`completion_window_secs`. No instruction can change any duration or the cutoff after creation,
so D77's second property — an attestation cannot be valid for state other than what the
attester inspected — is not weakened by their absence from the signed bytes.
`review_window_secs` remains signed. The layout and published vectors are unchanged; only
`MESSAGES.md` wording changes.

Tests, at minimum: each duration at zero, negative, and one above its ceiling is rejected;
each at one and at its ceiling is accepted; `acceptance_cutoff` equals the funding Clock plus
the window; `accept` exactly at the cutoff succeeds and one second after is rejected;
`deadline` equals the accept Clock plus the completion window; an attestation exactly at
`deadline` is accepted and one second after is rejected.

**D82 — One configured attester; `attester_pubkey` leaves the policy; attestations carry no
expiry.**
Amends D11 and SECURITY.md sections 2 and 6. D11 and SECURITY.md section 2 have the requester
name the attester in the policy, while the code stores a caller-supplied attester per bounty,
so a direct caller names themselves and signs their own attestations. `MESSAGES.md` section 6,
committed in 2ccc405, already adopted a configured authority without a D-entry; SECURITY.md
change control requires one, and this entry supplies it.

`submit_attestation` verifies against the attester authority held in the configuration account
(D83), read at submission time. Bounties do not snapshot an attester, so rotation reaches
outstanding bounties, through D83's mechanism only. `attester_authority` is removed from the
`create_and_fund` arguments and from the bounty account.

`attester_pubkey` is removed from the policy object rather than renamed. POLICY.md section 2.4
defines the hashed policy as what the verifier or the program relies on; nothing relies on a
requester-named attester once the configured authority governs, and an audit-only field would
widen that boundary for no security benefit. Which key attested any settlement remains
auditable from the ed25519 verification instruction in that transaction, the configuration in
force at submission, and the transaction itself. Removing the field changes every policy hash
and is landed together with D84 under one V1 supersession. Consequences in `apps/api`: the
request field, `ATTESTER_NOT_ALLOWED` in its policy-validation sense, the `ATTESTER_PUBKEYS`
configuration key, the `policies` read-model column POLICY.md section 7.1 names and its
migration, tests 24, 25 and 71, and vectors V1 and V2.

No attestation expiry. `BOUNTYCAM_ATTESTATION_V1` carries `issued_at`, which records what the
attester asserted and signed; the program does not compare it with the Clock and it is never
described as on-chain evidence of when capture, verification or signing occurred. Validity is
bounded by bounty state, the `deadline` set at `accept` (D81), the currently configured
attester authority, and exact reconstruction (D71, D77). Stated limit: an attestation issued
early remains submittable until `deadline` unless the bounty state changes or the authority is
rotated. Evidence freshness belongs to the capture nonce (D73), not to how recently the
attester signed.

Attester key id. SECURITY.md section 6 lists an attester key id, and SECURITY-PRODUCTION.md
section 1 requires one so a rotated key can be retired without invalidating history. It is
satisfied by the verifying public key in the ed25519 instruction, recorded permanently with
the transaction. The signed bytes do not repeat it: settlement verifies only against the
configured key, so an in-message id would add no settlement binding. Revisit before mainnet if
any consumer must verify an attestation detached from its transaction; the off-chain JSON
representation carries the key in any case.

Tests, at minimum: an attestation signed by a key other than the configured attester is
rejected; one signed by the eligibility or arbiter key is rejected; `create_and_fund` exposes
no attester input; a policy request carrying `attester_pubkey` fails under the POLICY.md
section 8.3 unknown-field rule.

**D83 — One immutable configuration account, initialised once by the upgrade authority.**
The account holds `deployment_id` (`u8`), `usdc_mint`, `eligibility_authority`,
`attester_authority`, `arbiter_authority` and its bump. It is the explicit program state D68
requires for the eligibility authority, D74 for the arbiter, D70 for the deployment identifier
and D82 for the attester, and it is the one configured mint SECURITY.md section 8 requires.

`initialize` is the only instruction that writes it, and it succeeds once: the account is a
single PDA on a fixed seed and a second initialisation fails. The signer must be the program's
upgrade authority, established from the ProgramData account: its address is derived from the
escrow program id under the upgradeable loader, and its recorded upgrade authority equals the
signer. A recorded authority of none is rejected. A caller-supplied claimed-authority account
never suffices. `eligibility_authority`, `attester_authority` and `arbiter_authority` must be
pairwise distinct or `initialize` fails; an immutable configuration turns a key collision into
a deployment-level mistake, so it is a hard invariant rather than an operational convention.
The relayer is not in configuration and its separation remains operational (SECURITY.md
section 7). `usdc_mint` must be a mint owned by the classic SPL Token program; Token-2022 is
unsupported (SECURITY.md section 8). Every instruction that touches tokens requires the
supplied mint to equal the configured `usdc_mint` by address.

No update instruction exists. Upgrading program code does not change an existing account's
data, so rotation of any configured value requires a deliberately authorised upgrade that
itself introduces a migration or a new versioned configuration account, under its own D-entry
covering who may rotate, recovery, tests and auditability. D74's prohibition on a broadly
callable `set_arbiter` is unchanged. Under SECURITY-PRODUCTION.md section 1 that deferred
mechanism is a mainnet blocker, not a known limitation.

Compiled constants were rejected: the test suite creates a fresh mint per run and SECURITY.md
section 7 requires test keys generated per run, which compiled values cannot match, and a test
build carrying compiled test keys is a devnet deployment risk. Operationally: the development
key inventory gains dedicated eligibility and arbiter keys, which neither SECURITY.md section
7 nor `~/bountycam-keys/` currently holds; `initialize` is rehearsed on localnet with the
exact devnet public keys before devnet. A mistaken devnet initialisation costs an upgrade
carrying migration code, or a fresh program id.

Test harness note: litesvm 0.10.0 `add_program` loads under the upgradeable loader with the
upgrade authority recorded as none (`src/lib.rs` lines 857 and 931), so positive `initialize`
tests overwrite the ProgramData account first, stated in the test as harness setup. The locked
version is confirmed with `cargo tree` before relying on this.

Tests, at minimum: a signer other than the upgrade authority is rejected; a ProgramData
account at the wrong address is rejected; a recorded authority of none is rejected; a second
`initialize` is rejected; each of the three equal-authority pairs is rejected; a positive
initialisation stores exactly the supplied values; `create_and_fund` with a mint other than
the configured mint is rejected; no instruction takes the mint from the caller without
comparing it to configuration. The account adds one read-only account to `accept` and
`submit_attestation`; the specification checks both lists against the `MESSAGES.md` section 7
ceiling.

**D84 — The policy-to-chain binding register; `eligibility_profile_id` joins policy V1; V1 is
superseded once, then frozen.**
D77 made policy-to-chain bindings a normative concept in the policy specification; POLICY.md
never gained the register. It is now, with each canonical policy field paired with its
on-chain field: `required_assurance` with `required_assurance`; `acceptance_window_seconds`
with `acceptance_window_secs`; `completion_window_seconds` with `completion_window_secs`;
`challenge_window_seconds` with `review_window_secs` (D72's mapping); the hash derived from
`eligibility_profile_id` with `eligibility_profile_hash`; `reward_amount` with
`reward_amount`, the base-unit string parsed exactly to `u64` per POLICY.md section 6.3.
Outside the register: the mint, pinned by the program (D83) and by the API's
`MINT_NOT_ALLOWED`; the fee, fixed at zero by the program (D67); the attester, which is not a
binding (D82). Any future duplication of a policy value into program state is registered
before code.

Every binding is checked as exact equality, with refusal on any mismatch, at three boundaries.
Funding projection: a confirmed `create_and_fund` is projected to `AVAILABLE` only when every
binding agrees; otherwise it is never projected to `AVAILABLE` and is classified malformed.
This amends D79's sentence that confirmed `create_and_fund` produces `AVAILABLE`; the database
representation of a malformed funded bounty remains Session 15's under D77. Voucher issuance:
the eligibility service reads the chain and refuses on mismatch. Attestation: the attester
refuses per D77. The first two occur before a Scout does any work, which is why
`reward_amount` is registered: otherwise a Scout is shown the policy's amount while the chain
holds another. The program stores `eligibility_profile_hash` as `[u8; 32]` from
`create_and_fund` and cannot validate its content.

Policy V1 gains `eligibility_profile_id`. The canonical policy carries the id only, never the
hash: the hash is always derivable from the id, and D60 forbids derivable fields inside a
hash. D69's "identifier with its hash" is satisfied by one normative derivation rule, not by a
second field. The program stores the derived 32-byte value because D70 reconstruction needs
fixed bytes and the program never derives it.

Profile id format, frozen: ASCII only, matching the pattern of one uppercase letter followed
by zero to 63 characters each an uppercase letter, a digit or an underscore, so 1 to 64 bytes.
Lowercase, spaces, hyphens, any non-ASCII character and any other character are rejected,
never normalised. Every allowed character is written literally in canonical JSON, so the id's
bytes inside the policy and its bytes in the derivation are identical and no escaping rule is
involved. An id must also be present in the profile registry; format validity alone admits
nothing.

Derivation, frozen: `eligibility_profile_hash` is SHA-256 over the 32 ASCII bytes of the
domain separator `BOUNTYCAM_ELIGIBILITY_PROFILE_V1` immediately followed by the id's ASCII
bytes. No length prefix, delimiter, terminator, JSON or hex encoding. The separator is
fixed-length and the id is the only variable part, so the concatenation is unambiguous. This
is a byte rule rather than canonical JSON so the independent verifier and any Rust consumer
reproduce it without a canonical-JSON implementation (D70, D78). The hash is an identifier
commitment, not blinding: the registry is small and public, so the hash is trivially
invertible, and nothing relies on it being otherwise. The rule set's meaning is fixed by the
id because profile definitions are immutable once any bounty uses them (D69); a new route is a
new id.

Placement: the format and derivation are specified once in `packages/shared/SPEC.md`,
implemented once in `packages/shared`, and covered by generated vectors in
`packages/shared/vectors`, because the API, the eligibility service, the attester and the
independent verifier all consume them (D80's placement rule). POLICY.md holds the registry and
references the rule.

V1 supersession. Removing `attester_pubkey` (D82) and adding `eligibility_profile_id` change
the canonical object, every policy hash, and worked vectors V1 and V2 in POLICY.md section 13;
V3 is unaffected. The domain tag stays `BOUNTYCAM_POLICY_V1` under D69, which permits a V1
field change while no lasting bounty exists. The previous development V1 and V2 vectors are
superseded as an intentional pre-freeze schema correction before V1 becomes externally stable,
not a silent rewrite of an established vector (D78). The replacements are generated by script.
Existing development rows keep verifying against their stored `canonical_json` and are never
treated as lasting.

Freeze point. The revised `BOUNTYCAM_POLICY_V1` becomes frozen at the first Git commit in
which the production `packages/shared` implementation and the API reproduce every regenerated
V1 and V2 policy vector and every profile-hash vector, with the expected test count shown
(D36). The specification and vectors are committed before that implementation, as always, but
remain correctable until it lands, so an error found by running the code is fixed in V1 rather
than forcing V2. A commit cannot contain its own hash, so its full SHA is recorded immediately
after it lands, in a new append-only DECISIONS.md entry; no held entry is edited to insert it.
The same SHA is then cited in POLICY.md. An annotated tag `policy-v1-freeze` may point at it,
but a tag can be moved or deleted, so the full commit SHA is the reference. After that commit,
any change affecting canonical policy bytes, field semantics, the profile-hash derivation, or
any existing V1 vector requires a new policy version and domain tag.

Open, blocking the POLICY.md edit but not this entry: D69 names only `A4_SEEKER_V1`, so
profile ids for `required_assurance` 0 to 3, and the compatibility rule between an assurance
level and a profile, are undecided (OPEN-1 below).

Tests, at minimum: for each registered binding, a direct-funded bounty mismatching that one
field is never projected to `AVAILABLE`, is refused a voucher, and is refused an attestation;
derivation vectors for `A4_SEEKER_V1`, a 1-byte id and a 64-byte id; format rejection vectors
for a 65-byte id, an empty id, a leading digit, a lowercase letter, a hyphen and a non-ASCII
character; a policy without `eligibility_profile_id` is rejected; a well-formed id absent from
the registry is rejected; an incompatible level-and-profile pair is rejected once OPEN-1 is
ruled.

**D85 — `submit_attestation` needs no Scout signature; insufficient assurance is rejected
without a state change.**
Any fee payer may submit a valid attestation; normally the relayer does (D2). The authority is
the attester's signature, verified per D71 against the configured attester (D82, D83). The
Scout is not a transaction signer. The stored Scout remains in the reconstructed message, so a
valid attestation cannot move between Scouts or between assignments, and later settlement can
target only the Scout stored by `accept` (SECURITY.md section 8). This fits SECURITY.md
section 15, where attestation runs after upload and the Scout may be offline.

`achieved_assurance` is compared with `required_assurance` only after the message verifies, so
the failure reports a genuinely attested shortfall rather than an unauthenticated input. If
achieved is lower than required, the instruction fails with its own error code: no state
change, no stored field written, no event. Whether an attested shortfall later produces an
explicit failure or dispute state is Session 9's decision.

`MESSAGES.md` section 7 counted two signatures; with one, its published total is an upper
bound and is not re-derived.

Tests, at minimum: a valid attestation submitted by an arbitrary fee payer succeeds with no
Scout signature; an attestation naming a different Scout is rejected; achieved lower than
required is rejected and the bounty account is byte-identical afterwards; achieved equal to
required succeeds; achieved higher than required succeeds.

**D86 — Voucher replay across cancellation and re-creation is a stated MVP limit.**
`cancel` closes the bounty account (D76), so the same requester can re-create a bounty at the
same address. An unexpired `BOUNTYCAM_ELIGIBILITY_V1` voucher issued for the closed bounty
then verifies for the new one when all of these match: `bounty_id`, requester and therefore
address, `policy_hash`, `eligibility_profile_hash`, `required_assurance`, Scout, deployment
and program. Acceptance then proceeds without a new database reservation.

Accepted for the MVP. Only the requester can re-create; the terms must be identical; vouchers
are short-lived; the normal API never reuses a `bounty_id`, so this is principally a
direct-caller, self-created edge case; and the voucher still attests only that this Scout
satisfies these exact committed terms. Attestation replay by the same path depends on which
Session 9 paths close accounts, and is assessed there. No incarnation or non-reuse subsystem
is built.

Revisit triggers: any supported client path makes bounty ids reusable; voucher validity
becomes long-lived; or a Session 9 path closes an account that can hold a valid attestation.
Any of them requires a program-bound bounty incarnation identifier, never reliance on API
uniqueness.

Tests, at minimum: an unexpired voucher replayed after cancel and identical re-creation
succeeds, documenting the limit; the same replay with any one bound field changed fails, one
case per field; the replay after voucher expiry fails.

---

## Session 8 build rulings (16 September)

Rulings made while implementing `programs/escrow/SPEC.md` in Session 8 part 1, where raw test
output contradicted the specification.

**D87 — Anchor's duplicate-mutable-account check rejects a vault passed as `requester_ata`;
SPEC test 39 names that error.** SPEC test 39 passes the bounty vault's address as
`requester_ata` to `cancel` and expected `TokenAccountOwnerMismatch`. Raw output shows
`ConstraintDuplicateMutableAccount`, Anchor error 2040, caused by `requester_ata`. Anchor 1.1.2
validates accounts in three phases: `init` accounts, then a check that no two mutable accounts
share an address unless marked `dup`, then per-field constraints in declaration order
(`anchor-syn` 1.1.2, `codegen/accounts/try_accounts.rs`). `bounty_vault` and `requester_ata`
are both mutable, so the duplicate check fires before the owner constraint can run. The
specification was wrong about which layer rejects the input, not about whether it is rejected.

The test expects `ConstraintDuplicateMutableAccount` caused by `requester_ata`. Anchor's default
check stays in force: no `dup` constraint is added, and adding one to any money-moving
instruction needs its own D-entry. For mutable accounts that check is the mechanism for
SECURITY.md section 8's duplicate-accounts invariant; owner constraints and `ScoutIsRequester`
remain the mechanism elsewhere. The client receives code 2040, not 6007, for this input, so
SPEC section 10 lists the error among those raised outside the program.

This does not widen the specification. The set of rejected inputs is unchanged and no program
code changes; only the named error moves to the layer that actually raises it.

Tests, at minimum: `cancel` with `requester_ata` set to the vault address fails with
`ConstraintDuplicateMutableAccount` caused by `requester_ata`.

**D88 — Same-transaction re-creation after `cancel` is permitted; SECURITY.md section 8 forbids
revival, not fresh creation.** SECURITY.md section 8 read "no reinitialisation into a
financially meaningful state in the same transaction", while SPEC test 40 expects `cancel`
followed by `create_and_fund` with the same `bounty_id` in one transaction to succeed. Read
literally the two conflict, and SECURITY.md wins on conflict (D50), so the conflict is settled
here rather than in either document alone.

The hazard the rule targets is revival: a closed account whose old data survives, or which is
kept funded, being used again with its prior state (`coral-xyz/sealevel-attacks`,
`9-closing-accounts`). That does not happen here. Anchor 1.1.2's `close` moves the bounty's
lamports to the requester, assigns the account to the system program and empties its data.
In the next instruction, `init` recreates the bounty, and the associated token program the
vault, through the system program's create path, which succeeds only for an empty,
zero-lamport, system-owned account; so both closures left nothing behind. Every field is
written from that instruction's own arguments and clock, and the requester funds the new vault
from their own token account.

Raw output (Session 8 part 1; litesvm 0.10.0, SPL Token 3.5.0 as loaded by litesvm): one
transaction, `cancel` then `create_and_fund` with the same id. The logs show the refund, the
event and the vault closure, then a single system-program call for the bounty and another for
the vault; `init` and the associated token program take the create path in one call only when
the account is empty, and otherwise make several.
The new bounty is `Funded` with every `Option` `None` and `acceptance_cutoff` from the clock;
the vault holds exactly `reward_amount`; the requester is down by exactly `reward_amount`.

Forbidding it on-chain would need `create_and_fund` to scan the Instructions sysvar for an
earlier `cancel` of the same address: new attack surface with no safety gain. The requester
moves only their own funds, and re-creation in a separate transaction already carries the same
exposure; its one known consequence, voucher replay, is D86's stated limit.

SECURITY.md section 8's account-closure invariant is reworded to forbid revival and to permit
same-transaction re-creation only through `init`, only when the result is indistinguishable
from a first creation. SPEC test 40 stands unchanged. The test asserts freshness, not merely
success.

Tests, at minimum: `cancel` then `create_and_fund` with the same `bounty_id` in one transaction
succeeds; the bounty is `Funded` with every `Option` `None` and `acceptance_cutoff` equal to the
clock plus the window; the vault holds exactly `reward_amount`; the requester's token balance is
down by exactly `reward_amount`.

**D89 — The escrow test harness runs the native ed25519 verifier; a forged signature is
tested.** SPEC section 6 checks the designated instruction's shape, key and message, never its
signature. A wrong signature is rejected only because the runtime runs the native ed25519
verifier on that instruction before the program executes. litesvm 0.10.0 does so only when
built with its `precompiles` feature (`src/callback.rs`); without it, `is_precompile` takes
`solana-svm-callback` 3.1.14's default of false and the ed25519 program account is never
loaded. The escrow tests enable no litesvm features, and neither `agave-precompiles` nor
`solana-ed25519-program`, both cited in SPEC section 6.1, is in `Cargo.lock`. The harness
could not execute tests 42 to 89 as written, and no test varied the signature alone.

Ruling. The litesvm dev-dependency enables `precompiles`. `solana-ed25519-program` is added
as a dev-dependency pinned `=3.0.0`, publisher and repository verified (D19); it builds every
well-formed designated instruction, and malformed variants are derived from its output, so
test and program cannot share one misreading of the offset table. Resolution is confirmed
with `cargo tree`. If `agave-precompiles` resolves to other than 3.1.14, section 6.1's
statements about the native verifier are re-read from the resolved source before tests 75,
77, 81 and 82 are written.

SPEC test 95 is added to section 12.6. Numbering it 95 keeps 91 to 94, which other documents
cite, unchanged. It is a guard: the check runs outside the program, so no runtime red is
possible by withholding program code.

Dependencies. The feature and the builder add 19 packages to `Cargo.lock` and move no existing
version. Each is new to the lock and reachable only through these two dev-dependency edges, so
none can enter the program build; `cargo tree -e normal,build` finds none of them.
`agave-precompiles` 3.1.14 builds OpenSSL 3.6.3 from source (`openssl-src`) for its secp256r1
verifier, a one-time cost per clean test build. Checked against `rustsec/advisory-db` at
e2e6404, two carry advisories: `ed25519-dalek` 1.0.1, RUSTSEC-2022-0093, a signing oracle when
a public key is supplied apart from its secret key; and `curve25519-dalek` 3.2.0,
RUSTSEC-2024-0344, timing variability in scalar subtraction. Both are accepted for tests only.
`ed25519-dalek` 1.0.1 is the version `agave-precompiles` 3.1.14 depends on, which the harness
must run, and tests hold only per-run keys or the published test seeds, so neither advisory
exposes a secret. The acceptance extends to no crate built into the program, the API or a
client.

Tests, at minimum: on each path, two cases, a designated instruction canonical in shape,
naming the expected authority and carrying the expected message, with one signature bit
flipped. The transaction fails at the designated instruction's index, not the escrow
instruction's, and the bounty account is byte-identical.

**D90 — The test-only CPI caller is excluded from Anchor's workspace and built with
`cargo build-sbf`.** SPEC task 16 adds `programs/cpi_caller`, an Anchor program that forwards one
instruction to the escrow by CPI for tests 55 and 69. Its ID,
`ESrpUvg2gM75m1mzoSuquCaoabs42edBCCdabdvDgJBg`, is 32 bytes of 0xC7, which is not a point on the
ed25519 curve, so no secret key exists for it and nothing can be deployed at that address. While
the caller sat in Anchor's workspace, `anchor build` generated
`target/deploy/cpi_caller-keypair.json` and printed a program-ID mismatch for the caller. Anchor
CLI 1.1.2 prints that mismatch as a warning, continues building, and reports only the first
mismatch it finds (`src/lib.rs`, the check before building), so a permanent caller warning could
hide a real mismatch for the escrow.

Ruling. `Anchor.toml` gains `[workspace]` with `exclude = ["programs/cpi_caller"]`, which Anchor
CLI 1.1.2 honours (`src/config.rs`, `get_program_list`); `anchor build` and its program-ID check
then cover the escrow alone. The caller stays a Cargo workspace member and is built with
`cargo build-sbf --manifest-path programs/cpi_caller/Cargo.toml`. A counted run is now: `anchor
build`; that `cargo build-sbf`; the `escrow.so`, escrow IDL and `cpi_caller.so` timestamps; then
`cargo test`, whose summary also shows the caller's unit and doc-test binaries, 1 and 0 (D36).

The caller has no IDL, so tests 55 and 69 carry its `forward` discriminator as the literal
`2d a5 c9 74 ce e1 f1 12`, the first eight bytes of sha256 of `global:forward`. A wrong literal
fails the call with Anchor's fallback error, never with the error those tests expect.
`--ignore-keys` and `anchor keys sync` are not used: the first would silence the escrow's check,
and the second would replace the caller's ID. Devnet deploys name the program:
`anchor deploy --program-name escrow`. The keypair file Anchor generated is an ignored build
artefact, not a key in SECURITY.md section 7's inventory, and is never used.

Tests, at minimum: tests 55 and 69 load `target/deploy/cpi_caller.so` at the caller's ID; every
counted run shows the caller's binaries, and an `anchor build` output that names no `cpi_caller`.

**D91 — The escrow program depends directly on `solana-instructions-sysvar` `=3.0.1`.** SPEC
section 6.2 loads the current instruction index and the designated instruction from the
Instructions sysvar. `anchor-lang` 1.1.2 depends on `solana-instructions-sysvar` 3.0.1 but does
not re-export `load_current_index_checked` or `load_instruction_at_checked`, and a crate cannot
name a dependency it does not declare. The alternative, parsing the sysvar's serialised format in
the program, would be a second implementation of a runtime format on the money path.

Ruling. `programs/escrow/programs/escrow/Cargo.toml` gains `solana-instructions-sysvar = "=3.0.1"`
under `[dependencies]`, with no features; the crate declares no default features. It is already
compiled into the program at exactly that version through `anchor-lang`, so no package enters
`Cargo.lock` and no version moves: the lock changes only by listing the crate among escrow's
dependencies, and the program graph's resolved features are unchanged. This entry is SECURITY.md
section 17's deliberate review of a new dependency. It is not a new major version, so section
10's deadline rule does not apply. An `anchor-lang` upgrade re-checks this pin against the
version `anchor-lang` then requires.

Tests, at minimum: `cargo tree -e normal,features` for the escrow package is identical before and
after the manifest change; the lock diff is that one line; the counted run shows 44 integration
and 2 escrow unit tests.

---

## Session 9 rulings (17 September)

Rulings R1 to R10 from the opening of Session 9. `programs/escrow/SPEC.md` section 1.2 and D80
left `approve`, `reject`, `resolve` and `expire` unspecified. Umair ruled every payout
destination, refund path and arbiter power; choices made on technical grounds say so. These
entries precede the Session 9 SPEC amendment, which carries accounts, check order, errors and
the full test list.

**D92 — Approval and release pay the stored Scout the whole vault balance; release needs no
signer.** `approve`: the requester signs, bound by `has_one`; the bounty is `Submitted`; there is
no time condition. `release`, a new instruction: no signer beyond the fee payer; the bounty is
`Submitted`; it succeeds only when `now` is strictly later than `submitted_at` plus
`review_window_secs`, the addition checked. Both transfer the vault's entire balance to the
Scout payout account, close the vault with its rent to the requester, and set `Paid`. Neither
takes an amount, destination or wallet argument.

The entire balance, not `reward_amount`, for `cancel`'s reason (D76, SPEC section 7.3): anyone
can deposit into the vault, and a residue would block its closure. Donated tokens go to the
Scout.

This is how D12's "silence auto-releases" is realised. A program acts only when a transaction
arrives, so nothing is automatic: once the review window has passed, any fee payer may submit
`release`, normally the relayer. A release nobody submits leaves the reward in the vault,
payable to the Scout alone. `release` is its own instruction rather than a second signer rule
on `approve`, a technical choice: one authorisation rule per instruction keeps every negative
test a single fault.

The Scout payout account is the associated token account of the Scout wallet stored by `accept`,
for `config.usdc_mint` under the classic SPL Token program, validated by derivation, mint and
owner (SECURITY.md section 8). No instruction argument, API, database or caller selects it. The
program does not create it: `init_if_needed` is kept off money paths, a technical choice. The
client places the Associated Token program's idempotent create before the instruction, its rent
paid by that transaction's fee payer. A missing or frozen payout account makes the transaction
fail with nothing changed; the reward stays payable only to the Scout.

Supersedes D2's sentence "Only `approve` (requester) or `resolve` (arbiter) moves money", already
inaccurate since `cancel`. Replacement: USDC moves only through an instruction whose destination
and amount the program fixes from stored state; a required signer authorises that the movement
happens, never where it goes. Amends D12: "auto-releases" means permissionless `release` after
the review window. SECURITY.md section 2 is amended: the requester's `approve` is recorded, and
the relayer, instead of "may not move USDC", may submit the permissionless instructions of D92
and D95, which let it choose no account, amount, destination or timing, and may move USDC by no
other means.

Tests, at minimum: `approve` pays the Scout the entire vault balance including a donation, closes
the vault with rent to the requester, sets `Paid`, and leaves the bounty account open; `approve`
signed by a wallet other than the requester, including the Scout, fails; `approve` from
`Accepted`, `Disputed`, `Paid` and `Refunded` fails; `approve` twice fails; the payout account
replaced by the requester's, an attacker's, or the Scout's account for another mint fails;
`release` at exactly the end of the review window fails; one second later it succeeds, submitted
by an arbitrary fee payer; `release` after `approve`, `approve` after `release`, and `release`
from `Disputed` fail.

**D93 — Reject names a requirement on-chain inside the review window and enters `Disputed`.**
The requester signs; the bounty is `Submitted`; `now` is at or before `submitted_at` plus
`review_window_secs`. The argument `failed_requirement_id: [u8; 16]` is the 16 bytes of the
uuid of an evidence requirement in the committed policy (POLICY.md section 2.2). It is stored in
a new field `failed_requirement_id: Option<[u8; 16]>`, placed last per SPEC section 4.1's `Option`
ordering, raising the bounty's maximum space from 257 to 274 bytes. The state becomes
`Disputed`. No money moves and the vault is untouched. A second `reject` fails on state.

The program cannot check that the id belongs to the policy: that needs the canonical policy,
which D70 keeps off-chain. It rejects the all-zero id, which no version 4 uuid can be, as a
technical fail-closed check. Membership is checked off-chain, by the API before it builds the
transaction and by the arbiter before resolving. Storing the id fixes the requester's claim in
their own signed transaction before any arbiter reads it. The database `decisions` constraint
requiring `failed_requirement_id` for a rejection (Session 3) remains the product record.

Boundaries under D81: `reject` succeeds at the window's last second and `release` one second
later, so the two never overlap. `approve` stays available in `Submitted` after the window
closes. From `Disputed` only `resolve` exits (D74); the requester cannot withdraw a rejection by
approving.

SECURITY.md section 7's attester leak line is tightened, closing its BACKLOG item: with a leaked
attester key a colluding Scout is paid unless the requester rejects within the review window,
and after a rejection the arbiter decides.

Tests, at minimum: `reject` sets `Disputed`, stores the id byte for byte, and leaves the vault
balance unchanged; `reject` at exactly the end of the window succeeds and one second later fails;
`reject` by a wallet other than the requester fails; `reject` from `Accepted`, `Disputed` and
`Paid` fails; the all-zero id fails; `release` and `approve` after `reject` fail.

**D94 — Resolve has two whole-balance outcomes, and an arbiter who is a party to the bounty
cannot resolve it.** The signer equals `config.arbiter_authority`; the bounty is `Disputed`. One
argument selects the outcome: pay the Scout, setting `Paid`, or refund the requester, setting
`Refunded`. The vault's entire balance goes to the associated token account, for
`config.usdc_mint`, of the wallet the outcome names: the Scout payout account of D92, or the
requester's account of D95. The vault closes with its rent to the requester; the bounty account
stays open (D96). There is no partial settlement, amount argument or other destination
(SECURITY.md section 2). The arbiter has no deadline.

`resolve` also fails when the signer equals the bounty's requester or its stored Scout. D83's
distinctness covers the configured keys only; nothing stops the arbiter's wallet funding a
bounty or accepting one, and this check removes resolving a dispute in which the arbiter is a
party. It narrows the arbiter's power and adds no authority.

Stated limit, ruled R5: a dispute the arbiter never resolves leaves the reward in the vault. No
timeout defaults it to either side; `resolve` remains the only exit from `Disputed` (D74).

Tests, at minimum, D74's list plus: each outcome pays the entire vault balance to its named
account, closes the vault and sets its state; an outcome value outside the two fails; for each
outcome, the destination replaced by the other party's account or an attacker's fails; `resolve`
from `Submitted`, `Paid` and `Refunded` fails; `resolve` twice fails; an arbiter who is the
requester, and one who is the Scout, fails; the eligibility authority, the attester authority,
a fresh key, the requester and the Scout as signer each fail.

**D95 — Expiry is permissionless, refunds the requester, and is two instructions.** No signer
beyond the fee payer.

`expire_unaccepted`: the bounty is `Funded` and `now` is strictly later than
`acceptance_cutoff`. Effects follow `cancel` in D76's order: the vault's entire balance to the
requester's account; emit `BountyExpired`, carrying `BountyCancelled`'s fields with the expiry
time; close the vault; close the bounty; rent to the requester. Closing is safe because a
`Funded` bounty has no Scout and cannot hold an attestation. A direct-funded malformed bounty,
which can obtain no voucher (D84), recovers here (D77).

`expire_accepted`: the bounty is `Accepted` and `now` is strictly later than `deadline`. It covers
an abandoned mission and an attested shortfall. The vault's entire balance goes to the
requester's account; the vault closes with its rent to the requester; the state becomes
`Refunded`; the bounty account stays open (D96). No event. The bounty is not returned to the
marketplace: that would clear `scout` and `deadline`, which SPEC section 4.1 forbids. A requester
who still wants the work posts a new bounty.

Two instructions rather than one, a technical choice: one closes the bounty account and the
other keeps it, and a conditional closure inside one handler would replace Anchor's `close`
constraint with hand-written closing code on a money path.

D85's open question is answered: an attested shortfall gets no state of its own. The bounty
stays `Accepted`, the Scout may land a passing attestation until `deadline`, and after
`deadline` it expires to the requester. D68's mandatory `expire` is satisfied.

The requester's account on both paths, and on `resolve`'s refund, is the requester's associated
token account for `config.usdc_mint`, validated by derivation, mint and owner. The requester
does not sign these paths, so no caller may choose among the requester's token accounts.
`cancel`, which the requester signs, keeps its SPEC section 7.3 rule. If the requester has closed
that account, any caller may re-create it with the idempotent create first.

Boundaries under D81: `accept` succeeds at `acceptance_cutoff` and `expire_unaccepted` one second
later; `submit_attestation` succeeds at `deadline` and `expire_accepted` one second later.

Tests, at minimum: `expire_unaccepted` one second after the cutoff, by an arbitrary fee payer,
refunds the entire balance including a donation, emits `BountyExpired` with exact fields, and
closes both accounts with rent to the requester; at exactly the cutoff it fails; from `Accepted`
it fails; `expire_accepted` one second after `deadline` refunds the entire balance, closes the
vault, sets `Refunded` and leaves the bounty open; at exactly `deadline` it fails; after an
attested shortfall it succeeds once `deadline` has passed; from `Funded`, `Submitted`,
`Disputed`, `Paid` and `Refunded` it fails; twice it fails; on either path the requester's
account replaced by another account of the requester, an attacker's account, or an account for
another mint fails.

**D96 — Settled bounties keep their account in a terminal state; D86's trigger is not tripped.**
`BountyState` appends `Disputed` (3), `Paid` (4) and `Refunded` (5); existing discriminants do
not change. `Paid` and `Refunded` are terminal: no instruction accepts either as a source state.
Every settlement closes the vault with its rent to the requester. The bounty account stays open,
so the requester's rent of 2797920 lamports at 274 bytes remains locked per settled bounty.

Consequences. The address cannot be initialised again, so a settled `bounty_id` is spent for that
requester. No voucher or attestation can be replayed into a re-created bounty for work already
settled. The open account is the reconciliation source (SPEC section 8), so the four settling
instructions emit no event.

D86 assessment, owed to its revisit triggers. The only Session 9 path that closes a bounty
account is `expire_unaccepted`, from `Funded`, which cannot hold a valid attestation. The trigger
is not tripped, and D86's voucher-replay limit applies to it exactly as to `cancel`. BACKLOG's
revisit of `submit_attestation` check 2 is not reopened: no Session 9 instruction clears `scout`
or `deadline`.

No instruction closes a terminal bounty account. Reclaiming that rent needs its own D-entry.

Tests, at minimum: bounty layout at 274 bytes with `failed_requirement_id` last; discriminants 0
to 5; SECURITY.md section 8's double-release list — `approve` twice, `resolve` twice,
`expire_accepted` twice, `approve` after a refund, `expire_accepted` after a payout, `resolve`
after a terminal state; `create_and_fund` with the id of a `Paid` bounty fails with the system
program's "already in use".

**D97 — Database `bounty_state` mapping.** Resolves the enum reconciliation BACKLOG, D56 and
POLICY.md section 7.2 assign to Session 9. The database tracks confirmed chain state (D79); every
value below is written only from a confirmed transaction, never from a submission response
(SECURITY.md section 12).

- `DRAFT` — creation (POLICY.md section 8.3).
- `AVAILABLE` — confirmed `create_and_fund` with every binding agreeing (D79, D84).
- `ACCEPTED` — confirmed `accept` (D79).
- `SUBMITTED` — confirmed `submit_attestation`.
- `DISPUTED` — confirmed `reject`; the `decisions` row's `failed_requirement_id` equals the
  chain's.
- `PAID` — confirmed `approve`, `release`, or `resolve` paying the Scout.
- `REFUNDED` — confirmed `expire_accepted`, or `resolve` refunding the requester.
- `EXPIRED` — confirmed `expire_unaccepted`; the account is closed, so the transaction signature
  and `BountyExpired` event are recorded, as D76 records a funded cancellation.
- `CANCELLED` — unfunded cancellation (D56), or confirmed `cancel` of a funded bounty with its
  signature and event (D76). This settles POLICY.md section 7.2's open choice: `CANCELLED`, not
  `REFUNDED`.

Retained without a producer, never written, the enum not narrowed (D56): `FUNDED`, whose use for
a malformed funded bounty remains Session 15's (D77, D84); `IN_REVIEW`, the same chain state as
`SUBMITTED`, whose window is derived from `submitted_at` and `review_window_secs`; `APPROVED` and
`REJECTED`, each confirmed in the same transaction as `PAID` or `DISPUTED`, so no confirmed chain
state corresponds to them.

POLICY.md section 7.2 is amended to this mapping. No migration and no API code in Session 9;
Session 15's reconciliation repairs missed projections of these values.

**D98 — Session 9 scope and cut-off.** Session 9 specifies and builds `approve`, `release`,
`reject`, `resolve`, `expire_unaccepted` and `expire_accepted`, taking the program to eleven
instructions; SPEC section 1.2's "nine" is superseded by the SPEC amendment. It also amends
SECURITY.md sections 2 and 7 and POLICY.md section 7.2 as above. Out of scope unless ruled:
capture nonce issuance, any devnet deployment, key generation and dependency changes.

Cut-off: if by the end of 22 September 2026, Sydney time, a counted run (D90) on a committed
Session 9 build does not show every Session 9 SPEC test passing, Umair rules on BACKLOG's
three-instruction contingency before further build work. Nothing switches automatically.

---

## Session 9 build rulings (18 September)

**D99 — Settlement writes the terminal state before the token CPI; two SPEC wording
corrections.** SECURITY.md section 8 requires every check and transition to precede any CPI.
SPEC 7.6, 7.9 and 7.11 listed their effects as transfer, close, state, and D92's summary reads
the same way. SECURITY.md wins (D50): `approve`, `release`, `resolve` and `expire_accepted`
write `Paid` or `Refunded` first, then transfer, then close the vault. Anchor serialises the
bounty at exit in either order, so no observable result changes; what changes is what the
handler has established before it calls another program.

Closures are the exception, and stating it is the point of this entry. `cancel` and
`expire_unaccepted` close the bounty through Anchor's `close` constraint, which runs at exit,
after the handler and therefore after the token CPI. Section 8 is still met: the state check
precedes the CPI; no other instruction can observe the account mid-transaction; and the only
CPI target is the classic SPL Token program, which cannot call back into the escrow. Closing by
hand inside the handler was rejected — hand-written account closing on a money path is exactly
what D88's re-creation rules rely on Anchor to do correctly.

Two wording corrections travel with the same amendment, neither changing behaviour:

- Section 11's "State before transfer" row becomes "every check and state write precedes the
  token CPI".
- Section 11's duplicate-accounts row records that Anchor's automatic duplicate-mutable check
  covers only account types that serialise at exit (`anchor-syn` 1.1.2,
  `generate_duplicate_mutable_checks`). The `UncheckedAccount` and `Signer` fields Session 9
  adds fall outside it and are bound instead by `has_one`, address constraints and
  `ArbiterIsParty`.

Tests, at minimum: none new. Effect order inside one handler is not observable, because a failed
CPI reverts the whole transaction. The positives of tests 96, 103, 114, 115, 123 and 128 assert
the final state and balances, and section 13's review item — every Session 9 check precedes its
token CPI — now covers the state write too.

**D100 — Boxed accounts where validation overflows the SBF stack frame, and a counted-run guard
for it.** SBF gives every function a 4096-byte stack frame. Anchor's generated `try_accounts`
for `Approve`, with eight accounts and SPEC 7.6's constraints, was estimated at 4160 bytes.
`cargo build-sbf` printed an error naming the function, exited 0, and wrote `escrow.so` anyway;
every approve transaction then failed with an access violation inside validation, before any
CPI. Tests 96 to 102 and 112 all failed, and the earlier 110 still passed.

Ruling 1. An account may be held as `Box<Account<...>>` wherever validation would otherwise
exceed the frame. Boxing moves the decoded account data to the heap and leaves a pointer in the
frame. It changes no constraint, no error code, no check ordering and nothing observable on
chain, so SPEC section 7's tables are satisfied by a boxed account. `approve` boxes `bounty`,
`usdc_mint`, `bounty_vault` and `scout_payout`. `release` and `resolve` take the same shape if
their builds need it; `expire_unaccepted` and `expire_accepted` compile without it and are left
alone, because a change with nothing to fix is a change that can break something.

The alternatives were rejected. Rewriting the `ScoutMismatch` expression to save its eight bytes
leaves no margin for `resolve`, which carries more accounts. Moving that check into the handler
would contradict SPEC 7.6, which places it on the `scout` account, and would change where Anchor
reports it and what test 100's fourth case asserts.

Ruling 2. D90's counted run treats a stack-frame message from `anchor build` as a failure
whatever the exit status, because this build exited 0 while producing an unusable program. Every
commit script greps the build output for `Stack offset` and stops if it appears. This closes a
hole in the gate, not in the program.

Tests, at minimum: none new. The suite runs against the real `escrow.so`, so test 96's positive
path already fails when validation does not fit the frame, which is how this was found. SPEC
section 13 gains the review item that the build output names no function over the limit.

**D101 — A counted run must prove the program was compiled, not that a file was written.**
D100 Ruling 2 requires every commit script to grep `anchor build`'s output for `Stack offset`.
That grep is meaningless on an up-to-date tree: an incremental build recompiles nothing, the
backend emits no stack-frame diagnostic, and the guard passes having tested nothing. It is
weakest exactly when the tree looks safest.

Observed twice on 18 September. First, during the SPEC task 25 review: `anchor build` ran at
16:28, printed `Finished release profile ... in 0.21s` with no compile line for the sbpf unit,
and left both `escrow.so` artifacts at their 12:52 modification times. The grep passed.

Second, in the guard written to close that hole. It deleted `target/deploy/escrow.so`, ran
`cargo clean -p escrow` — 45,354 files, 1.7 GiB — and required the artifact to be newer than
the run. It passed. Nothing had compiled. `cargo clean -p` removes host-target output and
leaves `target/sbpf-solana-solana/release/escrow.so`, which kept its 12:52 mtime while the
release profile reported finishing in 0.23 seconds; `anchor build` then re-derived the deploy
copy from that stale object. The two files differ in both size, 565,544 against 456,736, and
hash, which is how the substitution was found.

Ruling. A counted run removes `target/sbpf-solana-solana` outright before `anchor build`, since
`cargo clean -p escrow` does not reach it. It records a start timestamp and requires
`target/sbpf-solana-solana/release/escrow.so` — the compiled object — to be newer than it.
`target/deploy/escrow.so` is a derived copy and is never the freshness subject. The build log
must also carry a compile line for the escrow crate. D100 Ruling 2's `Stack offset` grep stands,
runs after those checks, and is evidence only once they pass.

The general form, which outlives this toolchain: a timestamp on a build artifact shows that a
file was written, not that a compiler ran. Freshness is asserted against the object the
compiler emits and against the log, never against a copy of it.

This changes the gate, not the program. No source, test, error code or account layout changes.
SPEC section 13 task 19a's review item is discharged only by a run passing these checks. The
runs recorded before this entry ran cold at 68750b1 and did compile, so the item is carried
forward as unverified-since rather than treated as failed.

Tests, at minimum: none new.

**D102 — The devnet deployment's USDC mint is one BountyCam controls, not Circle's devnet USDC.**
`initialize` writes `config.usdc_mint` once and it cannot be changed afterwards (D83), so the
choice is made here rather than at the keyboard. The devnet deployment uses a mint created by
this project with 6 decimals, not Circle's canonical devnet USDC at
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Circle's testnet faucet issues 20 USDC per address and allows one request per asset per network
every two hours. Sessions 11 and 13 to 16 run the bounty lifecycle repeatedly and need a
requester and two Scouts funded to known balances on demand. Distributing one faucet grant with
`spl-token transfer` covers some of that, but a test asserting an exact balance then computes
against a shared pool, and a run that strands tokens waits two hours for more. A rate limiter
inside an automated test loop produces failures that are not about the program.

The program cannot tell the two apart. Every instruction checks `address == config.usdc_mint`
and passes the mint's own decimals to `transfer_checked`; nothing reads an issuer, a name or a
registry. At 6 decimals, matching USDC, the amounts, the serialised message bytes and every
test behave identically either way.

Scope. This is a development-cluster choice and nothing more. A production deployment sets
`config.usdc_mint` to the real USDC mint on mainnet and runs the same program with no change to
its source, its tests or its message layouts — only a different value at `initialize`. Free
tokens exist on devnet because devnet tokens are worthless; the escrow, the transfers and the
decimal arithmetic exercised here are the ones mainnet would run.

Consequence. The configuration PDA uses seeds `[b"config"]`, so there is one configuration per
program id and therefore one mint for this deployment. Changing it later needs a program
upgrade carrying a migration, or a second program id.

Tests, at minimum: none new. No source, error code or account layout changes.

**D103 — `deployment_id` allocation, and devnet is 2.** MESSAGES.md sections 3 and 4 place
`deployment_id` at offset 26 of both signed layouts, one byte, sourced from the configuration
account. No document assigned values to clusters, and `initialize` writes the field once and
immutably (D83), so the value is fixed here rather than at the keyboard.

What is already taken. `gen_vectors.py` lines 126 and 144 build the nominal vectors with 1, and
`messages.rs:135` and `test_escrow.rs:46` compile `DEPLOYMENT_ID = 1` to reproduce them byte for
byte. Vectors ATT-09 and ATT-10 pin 0 and 255 as the boundary cases. `test_escrow.rs:1321` uses
7 as a mismatch fixture.

Allocation:

| Value | Use |
|---|---|
| 0 | never deployed — what a zeroed struct yields; vector ATT-09 |
| 1 | golden vectors, litesvm suite, ordinary localnet development |
| 2 | devnet — the deployment at `6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS` |
| 7 | reserved — already a mismatch fixture |
| 10 | mainnet, when it exists |
| 255 | never deployed — vector ATT-10 |

Reasoning. The field exists so a signature issued for one deployment cannot replay against
another (D70). Reusing the vectors' own value on a live cluster spends that separation for
nothing, and 0 is the value a bug or an uninitialised field produces, so neither belongs on a
real deployment. The gap between 2 and 10 leaves room for staging and preview clusters without
renumbering anything already signed.

Binding off-chain. MESSAGES.md section 5 sources the field from config, so the verifier, the
relayer, the mobile client and the Session 17 independent verifier read it from the
configuration account and never compile it in. A hardcoded value that disagrees with the chain
makes every voucher and every attestation fail reconstruction, and because the configuration is
immutable the correction would be a program upgrade carrying a migration (D83). The litesvm
suite is the one exception, and only because it initialises its own configuration per test.

Rehearsals. A rehearsal of a cluster's `initialize` passes that cluster's `deployment_id`, not
localnet's. The point of the rehearsal is that the bytes signed in it are the bytes sent for real,
so an argument that differs makes it a resemblance rather than a proof. Session 11 rehearsed devnet
on localnet with `deployment_id` 2. Row 1 above governs ordinary localnet development, where no
devnet run is being rehearsed. Amended 19 September; no program behaviour changes.

Scope. This fixes the value for the devnet deployment named above. Another cluster takes another
value under this table. Changing this one needs an upgrade with a migration, or a new program id.

Tests, at minimum: none new. The suite keeps 1. No source, error code or account layout changes.

---

## Session 12 rulings (20 September)

**D104 — The `@noble/curves` gate is a per-package resolution check, not a workspace
version count.**

AUTH.md 3.2 required `pnpm why @noble/curves` to show exactly two versions: 2.4.0 as a
direct dependency of `apps/api`, and one 1.x instance under `@solana/wallet-standard-util`
only. Session 12 found both halves unusable.

`pnpm why` ignores the working directory. Run from `apps/api` and from `apps/mobile` it
produced byte-identical output, because it reports the whole workspace. A workspace-wide
version count cannot express a claim about what one package's imports resolve to, which is
the only claim worth making.

The second half broke for a benign reason. When `apps/mobile` gained `@solana/web3.js`
1.99.0, a second parent of the 1.x copy appeared. The count is still two; "under
wallet-standard-util only" is now false. Nothing unsafe happened — the clause described the
shape of the tree on 12 September rather than the property it was meant to protect.

Ruling. The gate becomes three checks. First, `readlink` each package's own
`node_modules/@noble/*` symlink, which is what that package's imports follow: `apps/api`
resolves `@noble/curves` to 2.4.0, `packages/shared` resolves `@noble/hashes` to 2.4.0.
Second, grep BountyCam source for `@noble` imports; the result must be exactly
`apps/api/src/auth/routes.ts`, `apps/api/test/auth.test.ts` and
`packages/shared/src/index.ts`. Third, versions elsewhere in the tree are accepted and
named: 1.9.7 and 1.8.0 inside the isolated trees of `@solana/web3.js` and
`@solana/wallet-standard-util`, neither imported by our code, neither making a verification
decision.

Evidence, 20 September: `apps/mobile` has no `@noble` link at all, so a mobile file
importing `@noble/curves` would fail to resolve at bundle time rather than silently binding
1.9.7. That is a stronger guarantee than the old gate claimed, and it closes the open item
recording that mobile pulls `@noble/hashes` 1.8.0 while `packages/shared` pins 2.4.0: the
two cannot meet.

The general form: a version count answers "what exists in the tree". The question is "what
does this package import". Only the resolution answers it.

This changes a gate, not the program. No source, error code or account layout changes.

Tests, at minimum: none new.

**D105 — A debug-build diagnostic may display a SIWS message and its signature; the
section 7 prohibition otherwise stands.**

SECURITY.md section 7 forbids logging "keys, seeds, bearer tokens, `Authorization` headers,
JWTs, authentication signatures, presigned URLs, raw evidence or full request bodies".
Session 12's on-device sign-in screen displays the returned SIWS message and its signature,
which the list forbids. The conflict is named rather than worked around, per the file's own
instruction.

The measurement required it. AUTH.md 14.2 asked whether a wallet echoes a supplied domain
and whether an MWA signature verifies over the exact challenge bytes with no prefix. Neither
question can be answered from evidence nobody can read: the first needs the decoded message
text, the second needs the signature to verify against it.

Ruling. A debug-build diagnostic screen may display a SIWS message and its signature. The
prohibition is unchanged for everything else in the list, and specifically for JWTs, MWA
authorization tokens, presigned URLs and key material.

Why this is narrow rather than a hole. A SIWS message is public by construction — it is
handed to a wallet to be shown to a user. Its signature authenticates exactly one challenge,
and that challenge's nonce is single-use, consumed atomically on first verify (section 6
step 5, D41). A displayed signature therefore authenticates nothing: replaying it returns
`NONCE_CONSUMED`. Verified on device on 20 September — both runs' nonces show `consumed_at`
set, and the second run produced an entirely different signature over a fresh nonce. The
same reasoning does not extend to a JWT, which remains valid for seven days and has no
single-use property, nor to an MWA auth token, which authorises further wallet sessions.

Scope. Display, in a debug build, on the device operator's own screen. Not persistence, not
transmission to a third party, not a release build, and not a log file. The diagnostic
screen that occasioned this is throwaway and is deleted when the real sign-in UI lands.

Tests, at minimum: none new. No source, error code or account layout changes.

**D106 — AUTH.md 14.2 resolved: Seed Vault Wallet echoes a dapp-supplied domain unchanged,
and its SIWS signature verifies over the exact returned bytes.**

Both questions were open because no source answered them. The SIWS spec says a wallet "must
determine the domain" when the dapp supplies none and is silent on native apps; the MWA spec
delegates `sign_in_payload` to SIWS and never states whether a wallet honours a
dapp-supplied `domain`. The interim behaviour was to issue the configured `SIWS_DOMAIN` and
require an exact match on verify, with the answer owed from a device.

Test design. The app identity `uri` was set to `https://bountycam.invalid` — a reserved,
permanently non-resolving domain — while the server issued `app.example.com`. The two were
made deliberately different so the returned message would name its own source. Had they
matched, a correct-looking result would not have distinguished "the wallet honoured our
payload" from "the wallet used its own identity host".

Result, 20 September, Seeker with Seed Vault Wallet, two runs. The decoded message reads
`app.example.com wants you to sign in with your Solana account:`. The wallet echoed the
supplied domain unchanged and did not substitute its identity host. No `URI:` line appeared,
so `UNEXPECTED_FIELD` was never reached. `Chain ID: devnet` passed through in the canonical
form the server issued. All eight issued fields appear in the signed message with identical
values.

The second question is answered by the verify result rather than by a separate check.
AUTH.md section 6 step 1 rejects any signature that is not exactly 64 bytes, and step 4
verifies ed25519 with `@noble/curves` 2.4.0 over the exact received bytes. Both runs
returned HTTP 200. A bare 64-byte signature therefore verified over the exact message with
no prefix and no framing, checked by the pinned library rather than by a separate script.

A third question answered unasked. The second `authorize` carried `auth_token` from the
first alongside `sign_in_payload`, and `sign_in_result` came back present. A reauthorize
honours the payload, so sign-in costs one wallet approval rather than two.

Consequence. The configured domain value is now a configuration decision rather than a
research question: the wallet will echo whatever is supplied. Moving from the placeholder to
a real host is a `SIWS_DOMAIN` change plus a smoke test. That decision is still owed, and is
the same question as the app identity `uri` and the Digital Asset Links file; it belongs
with Session 24's packaging, where the release signing certificate exists.

What this does not establish. One wallet, one device. Solflare on the second handset is
untested for `sign_in_payload`; the September spike exercised only `signMessages` there. The
`signMessages` fallback path in AUTH.md section 2 remains unimplemented and unmeasured.

Tests, at minimum: none new. No source, error code or account layout changes.

**D107 — OPEN-1 resolved: two eligibility profiles, hashed by contents, paired strictly to
the assurance level.**

D69 defined only `A4_SEEKER_V1`, and D84 requires every bounty to name a profile, so levels 0
to 3 had no admissible profile and no bounty below A4 could be created. The item has been
carried since 16 September. It blocks the voucher-issuance session, which in turn blocks
on-chain `accept`, which blocks every end-to-end run.

The registry has two entries. `BASE_V1` — the Scout's wallet is SIWS-proved and the user row
is `ACTIVE`; nothing further. `A4_SEEKER_V1` — the same, plus a server-side Seeker Genesis
Token check over that proved wallet.

`BASE_V1` deliberately requires no completion history. A minimum-completed-bounties rule is
the obvious addition and is rejected for version 1: no bounty has ever completed, so any
positive minimum makes the first bounty unacceptable by anyone, the demo included.
Reputation gating arrives as a new profile id once there is history to gate on.

A profile is three fields and no more: `domain_tag`, `profile_id`, `requires_sgt`. A rule
those cannot express is a new `domain_tag` version with its own object, never a fourth key.
Format, derivation and vectors are `packages/shared/SPEC.md` section 7; the registry itself
is `apps/api/POLICY.md`.

The hash covers the contents, not the id. Hashing the id alone would let a redefinition
change what every already-funded bounty meant with no hash changing anywhere — the failure
recorded against the A4 rung in Session 8, where the integer sat inside the hashed policy
and the meaning of the integer did not. Hashing the object makes a redefinition fail loudly
at `VerificationMessageMismatch` against bounties funded under the old definition.

Pairing is a strict bijection. A `required_assurance` of 4 admits only `A4_SEEKER_V1`; 0 to 3
admit only `BASE_V1`. Any other pair is rejected at creation with
`PROFILE_ASSURANCE_MISMATCH`.

Accepted limitation, stated rather than hidden: a requester cannot demand a Seeker for a
low-assurance job. Widening the admissible set is request validation and changes no stored
hash, so it costs nothing later, and D34's rule against unreachable cases argues against
building the wider form before a use for it exists.

Tests, at minimum: both section 7.4 vectors reproduced by `packages/shared`; the id format
accepting and rejecting the stated examples; a profile with a fourth key and one with a
missing key both rejected; both lawful pairs accepted at creation and at least two unlawful
pairs rejected.

**D108 — The policy object drops `attester_pubkey` and gains `eligibility_profile_id`; both
worked vectors are regenerated.**

D82 removed the attester from the policy in principle on 16 September and D84 added the
profile id, but neither reached POLICY.md. The field list, the hashed boundary, the request
body, the validation codes, the read-model column, the tests and the worked vectors all
still described the Session 7a object. This entry lands the change.

Why now rather than later. Both changes alter the hashed field set, so both invalidate every
existing policy hash. No bounty has ever been funded — the escrow owned no accounts on 18
September and none has been created since — so nothing is invalidated today. The first
funded bounty makes this expensive and permanent. This was the cheapest moment it will ever
be.

The object is still sixteen fields. One left, one arrived. `eligibility_profile_id` sorts
between `domain_tag` and `evidence_requirements`, so the canonical order changes in two
places, not one. The request body still carries twelve request-source fields, and
`policy_public` still discloses thirteen: the profile is not among the withheld values,
because a Scout must know which rulebook applies before accepting.

The vectors are replaced in place, not versioned. `packages/shared/SPEC.md` section 8 holds
that published vectors are immutable and a change of meaning goes through an explicit
version change. That rule is kept in force for `MESSAGES.md`, whose vectors are on the
signed path and have a second implementation verifying them. POLICY.md's V1 and V2 are
worked examples of the current policy object: nothing was ever funded against them, no
second implementation ever verified them, and keeping the old pair alongside a new pair
would leave the document showing two policy shapes, one of which can no longer be created.
They are replaced, with the superseded hashes recorded in the section so a reader who saw
them can tell what happened.

The new values, verified rather than asserted. V1 is 606 bytes hashing to
`711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b`; V2 is 549 bytes hashing
to `44b067e66ae8dc9939fcf3b2d9ff340e6b0f0d4535fd9b0a01e319c20d86fc65`. They were derived by
first reproducing the published Session 7a texts byte for byte and confirming they hash to
the published values, then applying the field change. They were then verified on 20
September against the built `packages/shared` by all three routes — the package,
`node:crypto` in-process, and `shasum -a 256` on a file in a separate process — all
agreeing. The verification also re-canonicalised each parsed object and confirmed it
reproduces the document text byte for byte, which establishes that the wrap is display-only
and the key order canonical.

The V1 freeze SHA owed by D84 is still owed. It is the SHA of the first commit in which
`packages/shared` and the API reproduce every regenerated vector. `packages/shared`
reproduces them now, but the API does not yet build the new object, so that commit does not
exist. It is owed by the session that implements the change.

`ATTESTER_PUBKEYS` is no longer read. The API neither validates nor consults it; the
variable may remain set without effect. `apps/api/src/config.ts` still requires it at
startup, which is now a discrepancy against this spec and is fixed by the implementing
session.

Tests, at minimum: tests 24 and 25 rewritten for `PROFILE_UNKNOWN` and
`PROFILE_ASSURANCE_MISMATCH`; test 71 rewritten to assert the environment variable is
ignored; tests 5 to 7 reproduce the regenerated vectors. The test count is unchanged at 76.

**D109 — The eligibility service: voucher issuance, the Seeker check, and reservation
expiry.**

D68 made a voucher a precondition of on-chain `accept`, and the escrow has enforced it since
17 September, but no session ever owned issuing one. Nothing can be accepted, so no
end-to-end run exists. `apps/api/ELIGIBILITY.md` is the specification; this entry records the
rulings inside it and serves as the SECURITY.md section 17 review for a new secret and a new
dependency on the authentication path.

The endpoint is `POST /bounties/:id/voucher`, authenticated, no request body. It returns the
signed 212-byte message, its signature, the expiry and the authority.

Message fields come from the chain, not the database. A voucher built from a stale
read-model row verifies at issuance and fails at `accept` with
`VerificationMessageMismatch` — safe and useless. One account read is cheap next to the
checks that may follow it.

The reservation is taken after qualification, not before. Reserving first would let an
ineligible Scout block an eligible one for the duration of a slow check. The cost is a
wasted check for whoever loses the race, which is the cheaper failure.

One expiry governs both. The voucher expires at the earlier of the app clock plus 300
seconds and the bounty's `acceptance_cutoff`; the reservation expires at the same instant.
Five minutes matches the SIWS challenge lifetime, giving the codebase one short-lived
duration rather than two. The cutoff clamp exists because the program checks both conditions
and a voucher outliving its window cannot work.

Reservation expiry needs two writers, which closes POLICY.md section 14 item 6. A sweeper
every 30 seconds, plus an opportunistic flip on any voucher request. Neither alone suffices:
opportunistic flipping alone deadlocks, because discovery hides a bounty with an `ACTIVE`
reservation, so no request ever arrives to trigger the flip. The lag bound is 60 seconds,
twice the interval. A stale row makes a bounty temporarily invisible, never wrongly
acceptable.

The Seeker token is transferable, and the developer documentation governs. Solana Mobile's
marketing describes it as soulbound; their developer documentation, fetched 20 September,
says it moves with a change of primary account and keeps its mint address. Anything built on
the soulbound reading is wrong. Consequences: the check records the mint address and refuses
a second claim on it, one device to one account, enforced by a primary key; and zero-balance
token accounts are skipped, because a transfer leaves the old account open forever.

An outage is never a refusal. A failed Seeker check returns 503, never "no Seeker". Three
distinct 403s separate "you hold none", "that one is claimed" and "we could not look".

New dependency and new secret, reviewed here. The documented check uses
`getTokenAccountsByOwnerV2`, a Helius extension rather than a standard RPC method, so this
adds a third-party account and an API key on the authentication path. The key lives outside
the repo, is never logged, is read once at startup, and a missing key is a startup failure
rather than a runtime 503. The check runs against mainnet while the escrow runs on devnet;
the two endpoints are never interchanged. Results are cached 24 hours per wallet against a
check costing several round trips.

Tests, at minimum: the 24 of ELIGIBILITY.md section 9, including the concurrent-reservation
case required by SECURITY.md section 10 and the zero-balance case the documentation warns
about. Migration 8 adds `assignments.expires_at` and the `seeker_devices` table.

**D110 — The profile checks split: registry membership at the profile's canonical position,
the assurance pairing after the range check.**

POLICY.md section 2.5 said the pairing check runs "in the canonical field position of
`eligibility_profile_id`, and therefore after `required_assurance` has passed its own range
rule". Those clauses contradict each other: in canonical order the profile sits before
`evidence_requirements` and well before `required_assurance`, so one check cannot be in both
places.

The contradiction has a failing test behind it. Test 23 sends `required_assurance` of -1 and
5 with a `BASE_V1` profile and expects `INVALID_ASSURANCE`. Judged at the profile's canonical
position, -1 is outside the set 0 to 3, so `PROFILE_ASSURANCE_MISMATCH` fires first and test
23 fails — the exact outcome that sentence's own reasoning warns against.

Ruling: two checks, not one. Registry membership yields `PROFILE_UNKNOWN` and is judged at
the canonical position of `eligibility_profile_id`, because it depends on no other field. The
bijection yields `PROFILE_ASSURANCE_MISMATCH` and is judged immediately after
`required_assurance` passes its range rule. Both remain inside step 5 of section 8.3.

The pairing is therefore the only field rule not evaluated at its own canonical position, and
section 2.5 now says so rather than leaving it as a reader's surprise. A rule whose operands
span two positions must be judged at the later one. The alternative — moving the
`required_assurance` range check earlier — would put a second rule out of position to keep
the first one in it.

**D111 — Migration 8 also relaxes `assignments.challenge_nonce` and `assignments.deadline`
to nullable.**

ELIGIBILITY.md section 6 reuses the Session 3 `assignments` table as a reservation, and
section 8 adds only `expires_at`. The table as built carries `challenge_nonce bytea NOT NULL
UNIQUE` and `deadline timestamptz NOT NULL`, and section 8 addresses neither. An insert
written to section 6 as specified fails on both columns.

Neither value exists at reservation time, and that is not an oversight in the endpoint. The
mission deadline is computed from the policy windows once the chain confirms `accept`. The
capture nonce belongs to an accepted assignment: Session 8's issuance is unbuilt, and handing
a nonce to a Scout who then loses the on-chain race would spend nonces on attempts that never
land.

Ruling: migration 8 drops NOT NULL from both. They are written when the on-chain acceptance
is observed. The unique constraint on `challenge_nonce` stays — Postgres admits many NULLs
under a unique index, so every real nonce is still bound.

Rejected alternative: generating a nonce at reservation. It keeps the column NOT NULL at the
cost of issuing capture nonces to Scouts who never accept, and leaves `deadline` with no
defensible value regardless.

A row's meaning now depends on which columns are populated: `ACTIVE` with a null deadline is
a reservation, `ACTIVE` with both set is an acceptance. No constraint enforces that pairing.
Adding one is a change section 8 does not ask for, and the projection that writes the
acceptance is Session 15's.

**D112 — The `BOUNTYCAM_POLICY_V1` freeze SHA is
`dbc0ec77ed55059db6d8019ea5e7631742178dc2`.**

D84 set the freeze point as the first Git commit in which the production `packages/shared`
implementation and the API both reproduce every regenerated V1 and V2 policy vector and every
profile-hash vector, with the expected test count shown (D36). A commit cannot contain its own
hash, so D84 required the SHA to be recorded afterwards in a new append-only entry rather than
by editing the held one. This is that entry. D84, D107 and D108 are left exactly as written.

Which commit, and why not an earlier one. `638f058` landed the profile-hash derivation and its
vectors in `packages/shared`, whose suite reported 72 tests across 15 suites, so the package has
reproduced them since that commit. `08ecd9a` changed three markdown files and no code, so the
API still built the pre-D108 object there; it cannot be the freeze point regardless of what was
specified in it. `dbc0ec7` is the first commit whose tree has the API building the sixteen-field
object with `attester_pubkey` out and `eligibility_profile_id` in, with its suite at the expected
count of 76. The full SHA is recorded above because a tag can be moved or deleted; an annotated
`policy-v1-freeze` tag may point at the commit, but the SHA is the reference.

What the profile-hash freeze covers, stated because D84's own text no longer describes it.
D84 froze a format of one uppercase letter then up to 63 uppercase letters, digits or
underscores, and a derivation of SHA-256 over a domain separator followed by the id's bytes.
D107 then placed format, derivation and vectors in `packages/shared/SPEC.md` section 7, and
section 7 as written and implemented differs on both: the id is 1 to 40 characters and must end
in `_V` followed by digits (section 7.2), and the hash covers the canonicalised three-field
profile object, contents rather than name (section 7.3). D107 superseded those two paragraphs
of D84 without saying so; this entry says so. What `dbc0ec7` freezes is section 7 as
implemented, reproduced by the section 7.4 vectors. D84's 65-byte rejection vector is
consequently void, replaced by the 41-character bound of section 7.2.

What is now fixed. From this commit the V1 canonical bytes, the field semantics, the
profile-hash derivation and every published V1 and V2 vector are stable. Any change affecting
them requires a new policy version and a new domain tag; the pre-freeze correction D84 permitted,
and D108 used, is spent. The scope of the freeze is the policy object and its derivations, not
the rest of POLICY.md: request validation, error codes, discovery and the read model remain
amendable, because none of them changes a hashed byte.

Citation. POLICY.md held no freeze statement at all before this commit. Section 2 gains one in
the same commit, naming this SHA, as D84 requires.

**D113 — Migration 8 also relaxes `assignments.accepted_at` to nullable.**

D111 relaxed `challenge_nonce` and `deadline` because a reservation precedes the facts they
record. It stopped one column short. `assignments.accepted_at` is `timestamptz NOT NULL` and
records the instant the chain confirmed `accept`; at reservation time that instant does not
exist either, and an insert written to ELIGIBILITY.md section 6 fails on it exactly as it
would have failed on the other two. The Session 3 table was shaped as an acceptance and every
one of its acceptance-time columns has to be found, not just the two D111 noticed.

Rejected alternative: writing the reservation instant into `accepted_at`. It keeps the column
NOT NULL at the cost of a row that has never been accepted reading as accepted — the exact
confusion D111's closing paragraph names — and it leaves no column that answers "when was
this reserved", since `expires_at` carries the end of the reservation, not its start.

Ruling: migration 8 drops NOT NULL from `accepted_at` alongside `challenge_nonce` and
`deadline`. All three are written together when the on-chain acceptance is observed. A row's
meaning is now read from three columns: `ACTIVE` with all three null is a reservation;
`ACTIVE` with all three set is an acceptance. Any other combination is invalid and, as D111
already said of two columns, unenforced by constraint until the projection that writes the
acceptance exists. The BACKLOG.md item recorded for that constraint covers the third column.

ELIGIBILITY.md section 8 is amended in the same commit, before the migration lands.

**D114 — Migration 9 adds `SUSPENDED` to `user_status`, so `ACCOUNT_NOT_ACTIVE` is
returnable.**

Migration 4 created `user_status` with the single value `ACTIVE`, deliberately: the only
status Session 6 code could produce, with later values to be added by migration when a
session introduced suspension. ELIGIBILITY.md section 5 makes a non-`ACTIVE` row return
`ACCOUNT_NOT_ACTIVE`, and its test 10 seeds one. No such row can exist: the enum admits
nothing else. Under D34 a code nothing can return is a defect, and the test that proves the
code is unwritable.

Ruling: migration 9 adds the value `SUSPENDED` to `user_status`. No application code writes
it; the only writer is test 10, by direct SQL. Suspension as a feature — who sets it, what it
means for a Scout's open assignments, whether a requester can be suspended — is not decided
here and is not implied; the value exists so that the one check the specification requires
can be exercised and the code it names can be reached.

Postgres cannot remove a value from an enum type. The migration's down is therefore a
documented no-op. The scratch test's full rollback is unaffected: migration 4's down drops
`user_status` entirely, taking the added value with it, so the tables-left-after-rollback
assertion and the type-count assertion hold as before. A partial rollback to any point at or
after migration 4 leaves `SUSPENDED` in the type, harmlessly — nothing reads the enum's value
set, only its rows.

ELIGIBILITY.md section 8 is amended in the same commit to describe migration 9.

**D115 — Migration 10 drops the `now()` default on `assignments.accepted_at`.**

Migration 1 declared `accepted_at timestamptz NOT NULL DEFAULT now()`. Migration 8 dropped
the NOT NULL (D113) and left the default. The consequence surfaced in the first test that
needed a reservation to expire: an insert that names no `accepted_at` receives `now()`, so
every reservation is written as an acceptance and the section 6.1 flip, whose predicate is
`accepted_at IS NULL`, matches nothing. ELIGIBILITY.md test 24 failed with `BOUNTY_RESERVED`
where a fresh voucher was due. Tests 1 to 23 passed because none of them needs a flip.

Ruling: migration 10 drops the default. Its down restores `DEFAULT now()`, which is valid
against any table state — a default constrains only future inserts. D113's reading of the
row stands unchanged: `ACTIVE` with `accepted_at`, `deadline` and `challenge_nonce` all null
is a reservation; all three set is an acceptance; the projection that writes the acceptance
sets all three explicitly and relies on no default. Test 4 of the eligibility suite now also
asserts a reservation's `accepted_at` is null, so the class of fault — a column default
contradicting a documented null — has a test on this table.

The general lesson is recorded in BACKLOG.md rather than as a rule: when a migration relaxes
NOT NULL to express absence, the column's default must be inspected in the same change.

ELIGIBILITY.md section 8 is amended in the same commit; migration 10 lands with the endpoint.

**D116 — Nothing is cut; the payment path is built first.**

Context, 28 September, ten days before 8 October. Everything a user does after sign-in was
unbuilt. The remaining plan held sixteen rows, and three needed items sat in none of them:
funding from a device, projecting confirmed transactions into the database, and a capture nonce
specification. The architect recommended cutting to the PRD section 83 demo path at A1, and
recorded a consequence of that cut: A4 is A3 plus the Seeker profile (D13, D69), A3 needs C2PA
and device attestation, so without them an `A4_SEEKER_V1` bounty could be accepted but never
paid — `submit_attestation` rejects an attested shortfall (D85).

Ruling, Umair: nothing is cut. Every row of the remaining plan stays in scope.

What follows from it, each a technical call:

1. **Order.** The payment path is built end to end at A1 first — fund from the device, discover
   and accept, capture nonce, live capture and submission, attestation, approval and payout.
   C2PA (A2) and device attestation (A3) are then layered onto a path that already pays, and A4
   is reached through `A4_SEEKER_V1` as registered. Items off the payment path follow. From the
   moment the path lands, a bounty can be paid on devnet; each later item raises the assurance a
   bounty can demand rather than blocking payment.
2. **No lower-assurance Seeker profile.** That question existed only if A2 and A3 were cut. With
   both in scope `A4_SEEKER_V1` can settle, and D107's pairing stands unchanged.
3. **The dApp Store dry run moves forward**, to directly after the payment path. Its lead time —
   publisher and app NFTs, the build procedure Session 12 found missing, store review — is
   unknown, and an unknown lead time cannot be discovered in the last days.
4. **No checkpoint date.** A date by which a devnet bounty must have been paid was offered (4
   October); Umair did not set one. Scope reopens only on his ruling.

The reordered plan is BACKLOG.md's Remaining plan section, replaced in the same commit.

**D117 — The on-chain `bounty_id` is the 16 bytes of `bounties.id`.**

Context, P1. `create_and_fund` takes a 16-byte `bounty_id` and seeds the bounty account
with it (escrow SPEC section 4). Nothing said where the value comes from.

Ruling, technical: it is `uuidBytes(bounties.id)` (`packages/shared/SPEC.md` section 8.3),
the conversion D93 already uses for `failed_requirement_id`. The database generates the
id; no client chooses it. The account address is then a function of the requester's
wallet and the row id, both held by the server, so the projection can find a funding
without being told about it (D118). A retried create returns the same id (POLICY.md
section 10), so a retried funding targets the same address and the program refuses the
second: a bounty cannot be funded twice.

**D118 — The funding projection reads the account, from two callers.**

Context. D79 and D97 require `AVAILABLE` to come from a confirmed `create_and_fund` with
every binding agreeing, but named no writer, and no evidence for a transaction whose
report is lost.

Ruling, technical. One function, `projectFunding` (POLICY.md section 15.3), is the only
writer. Its evidence is the bounty account read at `confirmed` at the derived address,
not a transaction signature: `create_and_fund` emits no event, and escrow SPEC section 8
already names surviving accounts as the reconciliation source. Parsing transactions would
add a second decoder for the same fact. Two callers: `POST /bounties/:id/funding`, which
the phone calls after every attempt and which carries no body (section 15.4), and a sweep
every 30 seconds over `DRAFT` rows under 24 hours old (section 15.5). A landed funding
whose report never arrives is projected by the sweep, or when its requester next opens
it.

**D119 — Projection checks every field of the account, not three.**

Context. POLICY.md section 2.6 compared only the policy hash, the profile and the
assurance level, and left the windows to the attester. A direct caller could fund one
base unit against a policy promising more; discovery would show the policy's reward and
the program would pay the account's. A window mismatch would surface only when the
attester refused it, after the Scout had worked.

Ruling, technical. The projection also compares bounty id, requester, reward, fee and
the three windows (section 2.6, amended). A mismatch keeps the bounty `DRAFT` and
undiscoverable, and raises an alarm. The voucher is unchanged: the added fields are
immutable on chain after funding. No hashed byte, program or message changes.

**D120 — Cancelling a `DRAFT` reads the chain first.**

Context. A `DRAFT` cancel racing a funding in flight could cancel a bounty whose escrow
is funded.

Ruling, technical, open to Umair's overrule because it concerns when money returns.
Section 8.7 gains step 6a (section 15.6): read the derived address; refuse on a failed
read; if an account exists, project it and refuse the cancel. What remains — a funding
confirming after the cancel commits — is logged as `FUNDED_AFTER_CANCEL`. Its escrow
returns through the program's `cancel` or `expire_unaccepted`, by CLI until O1. The
phone never offers Cancel during a funding attempt.

**D121 — The funding-path helpers live in `packages/shared`; the GPS lift is done.**

Context. D61 left the GPS lift unowned until a second producer existed. P1's create flow
is that producer, and it also needs the profile registry, the uuid conversion, the
instruction encoder, the POLICY.md section 3.5 check and the SECURITY.md section 3
allowlist.

Ruling, technical. All of them go into `packages/shared` (SPEC.md section 8): each is
pure and on the money path, and the phone has no test runner, while shared has one that
shows each negative red. `apps/api` imports the GPS rules and the registry and keeps no
copy; `gps.ts` and the API's registry map are removed in the build. The shared gate
becomes 110. PDA derivation stays in the API (`chain/pda.ts`), because the phone derives
with web3.js, which it already carries; a live vector ties the two (POLICY.md section
15.3).

**D122 — Session 17 product rulings (Umair).**

1. **Test funds.** Requester wallets get devnet test USDC from a script Umair runs on
   request, minting from the upgrade authority, which is the mint authority (D102), and
   creating the token account if needed. Devnet SOL for rent comes from an airdrop.
   Rejected: an API faucet, which would need the mint authority online.
2. **Location.** The requester pastes `lat, lon` from a map app. No current-location
   lookup and no map picker in P1.
3. **Create form.** Editable: title, category (Property, Retail, Infrastructure),
   location, reward in USDC, photo prompts. Fixed and shown: assurance A1 on `BASE_V1`,
   capture radius 150 m, windows of 24 hours, 2 hours and 1 hour. A minimal My bounties
   list with Fund, so an interrupted funding can be resumed.

`apps/mobile/FUNDING.md` records these; POLICY.md section 15 and SPEC.md section 8 carry
the technical rulings D117 to D121.

**D123 — Session 18 product rulings (Umair).**

1. **Scout location.** Device GPS through `expo-location`. One native rebuild now, which P4's
   capture needs anyway. No pasted point for the Scout.
2. **Before acceptance** the Scout sees "About X km away. Exact spot shown after you accept."
   No map and no requester identity.
3. **A reservation that lapses without an accept** shows "Your hold ended. The bounty may still
   be available." with a Try again button.
4. **Scout devnet SOL.** 0.05 SOL from the relayer, by the D122 ruling 1 script extended for a
   SOL-only transfer. Rejected: the public faucet, which refused the Seeker in Session 17.
5. **The race gate's second Scout** is a scripted client on the laptop, not a second device.
   POLICY.md section 16.12 specifies it; BACKLOG.md's gate row is amended in the records
   commit.
6. **Accepted test bounties.** Until P3 to P5 land, an accepted bounty cannot be submitted.
   After its 2-hour completion window it returns to the requester only by CLI
   `expire_accepted`. Accepted. The live run uses bounties freshly funded from the Seeker.

`apps/mobile/DISCOVERY.md` records these; POLICY.md section 16 and SPEC.md section 9 carry the
technical rulings D124 to D127.

**D124 — The acceptance projection reads the account, from three callers.**

Context. D79 and D97 require `ACCEPTED` to come from a confirmed `accept`, and D113 named the
columns it fills, but no writer existed. P1 showed that a lost report is a real case, not a
theory. The chain also stores no acceptance instant: `accept` writes `scout` and `deadline`
only.

Ruling, technical. One function, `projectAcceptance` (POLICY.md section 16.7), is the only
writer of `ACCEPTED` and of an assignment's acceptance times. Its evidence is the bounty
account read at `confirmed`, as in D118. `accepted_at` is `deadline` minus
`completion_window_secs`: exactly the chain clock at `accept` (escrow SPEC section 7.4 check
7), and the only acceptance instant the chain records. No transaction is parsed.

Three callers: the report endpoint, which the phone calls after every attempt; the voucher
endpoint, whenever it reads an `Accepted` account; and the reservation sweep, which runs the
projection before flipping an expired reservation. Without the sweep caller, a landed accept
whose report was lost would have its bounty reappear in discovery when the reservation
lapsed.

The chain wins every disagreement. The chain's clock can trail the API's, so an `accept` can
land after the API flipped its reservation and another Scout reserved. The projection then
expires the other row and records the acceptance for the chain's Scout, in one transaction.

**D125 — The capture nonce is not written at acceptance; the constraint pairs two columns.**

Context. D111 and D113 say `challenge_nonce` is written together with `accepted_at` and
`deadline` when the acceptance is observed. D73 says the capture nonce is issued at
capture-session start, not at accept, and carries its own issue time, expiry and status.
Writing it at acceptance is the design D73 rejected, and one column cannot hold a nonce that
expires and is issued again.

Ruling, technical. The projection writes `accepted_at` and `deadline` only. Migration 11 adds
the constraint `assignments_acceptance_pair`: both null or both set. `challenge_nonce` stays
nullable and unwritten; P3 specifies where the capture nonce lives, and whether this column is
renamed under D72 or dropped. D113's reading of a row is superseded: `ACTIVE` with both
columns null is a reservation, `ACTIVE` with both set is an acceptance. D113's relaxation of
`accepted_at` stands. D115's lesson applies: migration 11 lands with an inspection of every
`assignments` column default.

**D126 — The acceptance cutoff is stored when funding is projected; discovery filters on it.**

Context. POLICY.md section 14, item 7: discovery lists bounties past their acceptance cutoff.

Ruling, technical. `projectFunding` writes `bounties.acceptance_cutoff` from the account.
Discovery lists a bounty only while its cutoff is at or after the injectable clock's now: the
same comparison as voucher check 6, so the two agree to the second. Rejected: expiring the
bounty through `expire_unaccepted`, which needs a fee-paying caller, and that is O1.

Rows projected before migration 11 carry no cutoff and are not listed. No backfill is
written: the only two such rows close for acceptance on 29 September, before a backfill could
ship, and the live run uses fresh bounties (D123 ruling 6). This replaces the backfill the
architect proposed in the Session 18 memo.

**D127 — What the Scout's phone receives and checks.**

Context. `accept` needs the bounty account's address, which the public view omits. POLICY.md
section 9.4 left the assigned Scout's full policy to the acceptance flow. The phone has no
test runner.

Ruling, technical.

1. The public view gains `program_account`. The account is public on chain; the requester
   wallet inside it is never displayed by the client.
2. A third view, the assigned-Scout view: the public view plus the full policy and the
   assignment's times, served only to the Scout holding the acceptance (POLICY.md section
   16.4). Before showing the exact spot, the phone checks the policy against the policy hash
   in the voucher it accepted with. The program matched that voucher against the account, so
   the hash is chain-anchored. After an app restart the phone no longer holds the voucher and
   checks against the view's own `policy_hash`.
3. The money path for `accept` lives in `packages/shared` (SPEC.md section 9), for D121's
   reason: `acceptData`, `ed25519InstructionData`, `checkVoucher`,
   `checkAcceptInstructions` and `verifyAssignedPolicy`.
4. Distance is computed on the phone, to the snapped area centre only. The server still
   returns none (POLICY.md section 9.3).
5. `GET /me/missions`, so the phone finds an accepted mission after a restart without local
   storage.
6. The discovery query carries the Scout's position. The API's request log records paths
   without query strings (POLICY.md section 16.11). Found while specifying P2: the production
   logger records full URLs today.
7. `expo-camera` joins `expo-location` in the same native rebuild, unused until P4, to save
   one rebuild and reinstall cycle.

**D128 — The Scout's account in `accept` is writable, as the fee payer.**

Context. SPEC.md section 9.4 listed the Scout as a signer and not writable, copying the
program's account struct, where the Scout is `Signer` without `mut`. The Scout also pays the
fee, and a fee payer is writable in every Solana transaction. Before the phone code was
written, a probe built the accept transaction with web3.js, serialised it and decoded it with
`Transaction.from`, the check's own input path: the Scout came back writable, and
`checkAcceptInstructions` refused the transaction with `TX_ACCOUNTS`. Every accept the phone
built would have stopped before the wallet opened.

Ruling, technical. Row 0 of section 9.4's table is signer yes, writable yes, and
`expectedAcceptKeys` follows it. The program accepts the extra writable flag: Anchor rejects
a missing privilege, not an added one. Test 123 gains the case of a Scout that is not
writable, shown red before the gate. P1 never met this, because the requester's account is
writable in `create_and_fund` anyway.

**D129 — The acceptance tail is read by its own function; the projection checks `bounty_id`.**

Context. Found while implementing POLICY.md section 16, before any of it was committed.
Section 16.6 had `decodeBountyAccount` enforce tail rules for every state. Existing tests
decode prefix-only accounts on purpose: chain test 07 decodes a 171-byte `Funded` account,
chain test 08 decodes states 1 and 5 over a zero tail, and eligibility test 12 seeds an
`Accepted` state over a zero tail. A strict prefix decoder would break all three, and no P2
caller needs the tail of a `Funded` account.

Ruling, technical.

1. `decodeBountyAccount` is unchanged. A new function, `readAcceptance`, reads `scout` and
   `deadline` from an `Accepted` account only, and anything else is `BAD_TAIL` (POLICY.md
   section 16.6 as amended).
2. The projection also requires the account's `bounty_id` to equal the row id's 16 bytes.
   It reads the address from the row, and the check costs nothing and catches a row pointing
   at another bounty's account.
3. Section 16.10's tests 1 to 3 read the recorded account and two edits of it. Test 9 uses
   the recorded account with its state byte set to `Funded`: P1's funded fixture belongs to
   another bounty, so point 2 would make it `BINDING_MISMATCH`. Test 16 also covers step 4a.
4. Placement: `GET /me/missions` and step 4a live in `bounties/routes.ts` beside
   `/me/bounties`, whose query helper they share; the report endpoint and the projection live
   in `src/acceptance/`.
5. Fixtures. The accepted bounty's fixture is built from its database rows, as P1's
   `create_response.json` was: the phone's create response was not captured. The voucher
   response was not recorded either; no test reads it.

**D130 — The double-book gate is recorded as met by the 29 September run (Umair).**

Context. BACKLOG.md's gate asks that two devices accept within a second and exactly one wins.
In the run, the laptop Scout (`scout-race.mjs`) won the voucher at 23:33:44 UTC, accepted and
confirmed; the A30's request arrived about four seconds later, found the bounty `Accepted`,
and was refused `BOUNTY_NOT_ACCEPTABLE`. Exactly one acceptance exists on chain and in the
database, but the two voucher requests did not collide, so `BOUNTY_RESERVED` was not seen.

Ruling. Recorded as met. Reservation exclusivity rests on eligibility test 22, which races
voucher requests against the real database; the device run proves the end-to-end property
that governs money: one accept, and the loser refused before its wallet opens. Rejected: a
deterministic re-run with a `--hold` flag, about 15 to 20 minutes and one more funded bounty.
The gap is carried in BACKLOG.md's Session 18 section.

**D131 — The capture nonce lives in its own table; `assignments.challenge_nonce` is dropped.**

Context. D125 left P3 to say where the nonce lives and whether `challenge_nonce` is renamed
under D72 or dropped. A nonce has its own issue time, expiry and status and is issued again on
restart; one column holds one value and no history. `bountycam_dev` on 29 September: two
`ACTIVE` and one `EXPIRED` assignment, none with `challenge_nonce` set.

Ruling, technical. Migration 12 creates `capture_nonces` (POLICY.md section 17.2), bound to its
assignment, bounty and Scout by one composite foreign key so the three cannot disagree, and
drops `challenge_nonce` with its unique constraint. Rejected: renaming the column, which would
keep a second, unused home for the same concept.

**D132 — Nonce timing: lifetime, deadline buffer, minimum window, grace (Umair, R1 and R2).**

Context. A single "10 minutes before the deadline" rule, combined with a 20-minute nonce, could
let a Scout start with one minute of capture left.

Ruling (Umair). Three separate settings, in API configuration and never in the phone:
`nonce_lifetime` 20 minutes, `deadline_buffer` 10 minutes, `minimum_capture_window` 10 minutes.
Start is allowed while `now <= deadline - deadline_buffer - minimum_capture_window`;
`expires_at = min(now + nonce_lifetime, deadline - deadline_buffer)`. With the defaults Start
closes 20 minutes before the deadline and every nonce gives at least 10 minutes. The API exits
at startup unless `nonce_lifetime >= minimum_capture_window`. The server's clock decides every
time; responses carry `server_time` so the phone's countdown is independent of its own clock.

Addition, technical. `submission_grace`, 8 minutes: consumption succeeds until `expires_at` plus
the grace, so evidence captured inside the window can finish uploading after it closes. The API
exits at startup unless `submission_grace < deadline_buffer`, leaving at least 2 minutes before
the deadline for verification and `submit_attestation`. It is configuration; Umair may change
the value without a specification change. This settles MESSAGES.md's open
`CAPTURE_START_DEADLINE_BUFFER_SECS`: its role is the pair `deadline_buffer` and
`minimum_capture_window`.

**D133 — The start gate is uncertainty-aware; payment verification is not bound to it (Umair,
R3).**

Context. Indoors the phone's reported accuracy radius grows from 5 to 15 metres to 20 to 100 or
more, so a check on the bare point fails Scouts standing inside the store.

Ruling (Umair). The phone offers Start capture only when `effective_distance_m = max(0,
distance_m - horizontal_accuracy_m)` is at or under `capture_radius_m`, with
`horizontal_accuracy_m` at or under `max_location_accuracy_m`. The check runs once, at Start;
nothing afterwards is gated on location. `distance_m` is the haversine distance of SPEC.md
section 10.1, never a planar comparison of degrees. Initial values: 200 m, the initial
configured accuracy ceiling, not an intrinsically correct threshold; a 10-second fix timeout; a
30-second maximum fix age. Failures are distinguished: permission denied, location services off,
no fix, too imprecise, too far; the phone shows the numbers it judged.

P4 and P5 must use the reported accuracy and must never treat coordinates as exact points, but
their acceptance rule and ceiling are defined and tested when they are built and need not equal
the start gate's. The gate asks whether presence is plausible enough to start collecting
evidence; payment asks whether the evidence is strong enough to pay.

Technical. One function in `packages/shared` (section 10) serves the phone and the server. The
phone sends its fix with the request; the server re-runs the gate and stores the fix on the
nonce row, visible to no view, response or log. The fix's age is judged only on the phone,
against the clock that stamped it: comparing a phone timestamp with the server's clock would
fail honest Scouts whose phone runs a few seconds off. A failed start never reaches the server,
so its record is the phone's on-screen numbers.

**D134 — Restarting a capture session (Umair, R4).**

Ruling (Umair). Restarting is allowed, after the warning "Starting again will discard the photos
from your current capture." The server is authoritative about which nonce is current.

Technical. One transaction supersedes the current nonce and inserts exactly one new one. The
nonce row's `id` is the capture-session id: D73 rules out a separate capture-session object, and
the row already carries one value, one issue time and one expiry. The assigned-Scout view serves
the current nonce back to its holder, so the phone restores a session after an app restart, and
after a failed restart request it reloads the view before discarding anything: a request can
reach the server and lose only its response.

**D135 — The completion window has a floor of the deadline buffer plus the minimum window
(Umair, R6).**

Context. Creation accepted completion windows from 60 seconds. The deadline is the acceptance
time plus the window, so any window under 20 minutes closes Start at the moment of acceptance:
the Scout can accept and travel but never capture, and the funds stay locked until expiry.

Ruling (Umair). Creation rejects `completion_window_seconds` below `CAPTURE_DEADLINE_BUFFER_S +
CAPTURE_MIN_WINDOW_S`, 1200 by default, as `INVALID_WINDOW`. Request validation is amendable
under D112; no hash changes. The app's default, 7200, is unaffected.

**D136 — P3's live run is deferred to P4's first run (Umair, R5).**

Ruling (Umair). No bounty is funded for P3. P4's first live run carries P3's live acceptance
items, listed in POLICY.md section 17.12, so they cannot drop out of testing.

**D137 — P3 builds consumption; P4's manifest binding is fixed now.**

Ruling, technical. `consumeCaptureNonce` (POLICY.md section 17.8) is built and tested in P3, so
every D73 lifecycle test lands before evidence code exists; P4 calls it inside its submission
transaction. The manifest keys `bounty_id`, `assignment_id` and `capture_nonce`, the nonce as 64
lowercase hex characters exactly as issued, are fixed now (section 17.9), so P3's format never
changes. The nonce is 32 bytes from the D54 randomness module; `NOT_ASSIGNED` is 403 because the
caller can see the bounty but lacks the right, as `FORBIDDEN` is in section 8.7.

**D138 — Session 20 product rulings for P4 (Umair, 1 October).**

1. **No offline capture.** Start needs a connection; after Start, photos can be taken with weak
   signal and upload when it returns.
2. **Expiry during capture.** The camera locks at `expires_at`. Photos already taken upload and
   submit until the grace ends. With a required photo missing, the Scout must Start again, which
   discards the set.
3. **Submitting is final.** One submission per assignment; no retakes after it. Retakes are
   unlimited before it.
4. **Optional requirements may be skipped.** Submit needs every required photo uploaded.
5. **The requester before P6** sees "Evidence received, being checked.", the submission time and
   the photo count. No photos, no locations, never the Scout's position.
6. **Scope unchanged** (D116), after the architect flagged that P5, P6 and S0 then have roughly
   three to four days.

`apps/mobile/CAPTURE.md` section 7 and `apps/api/POLICY.md` section 18 carry them.

**D139 — The P4 spike, 1 October: what the device and the store showed.**

Run from an apply script and reverted; nothing committed. On the laptop, versitygw 1.8.0 passed
nine storage checks: correct bytes stored; length and sha256 reported by `HEAD`; wrong bytes of
the same length refused with nothing stored; a different length refused; a missing checksum
refused; anonymous `GET` refused; an expired URL refused; a presigned `GET` returned the bytes; a
same-key retry succeeded. On the A30: `expo-file-system`'s native module is present in the
installed APK, so adding the package needs no rebuild; a 3456 by 4608 photo of 1425407 bytes was
read in 57 ms, hashed with `@noble/hashes` in 4766 ms in the development build, and uploaded
through `adb reverse` in about 0.2 s with the length signed and unsigned alike; Solflare's
`signMessages` returned a valid ed25519 signature as the bare 64 bytes, not appended to the
message.

**D140 — The evidence store: versitygw in development, R2 in production, a presigner without an
SDK.**

Context. D4 fixes R2, private, presigned URLs with a 15-minute life, and SECURITY.md section 14
keeps evidence bytes out of the API process. Development needs an S3-compatible server on the
laptop.

Ruling, technical. Development runs versitygw, a single Homebrew binary storing objects in a
folder outside the repo; the phone reaches it through `adb reverse`. Production is R2 by
configuration. Upload URLs sign `content-length` and `x-amz-checksum-sha256`, so the store itself
refuses bytes other than those hashed, and the submission checks each object with `HEAD`, which
never reads a photo. Keys are content-addressed, so retries rewrite the same object. Signature
Version 4 is implemented in about sixty lines, pinned by AWS's published query-signing example
and checked against versitygw by the D139 run; an SDK would add a large dependency tree to sign
one request shape. Rejected: MinIO, whose repository is archived and whose Homebrew formula is
deprecated from February 2026; uploading through the API, which section 14 forbids.

**D141 — The manifest: a header leaf and one leaf per photo; accuracy in whole metres, rounded
up.**

Ruling, technical. The manifest is a header, carrying POLICY.md 17.9's keys with the
deployment, the policy hash and the Scout's wallet, and one item per photo. The Merkle leaves are
the header's digest followed by each item's, so the root binds the nonce and the wallet, and one
photo's record can later be disclosed with a proof, without the others. Accuracy is a whole
number of metres rounded up, because canonical JSON carries no fractions and rounding up never
understates uncertainty. The Scout signs a four-key canonical statement naming the bounty and the
root, which SECURITY.md section 5 already calls `BOUNTYCAM_EVIDENCE_V1`. Section 5's rule that
every signed object begins with its domain tag becomes "carries": canonical JSON sorts its keys,
so the tag cannot come first; it is a required key, as in the policy. Vectors V6 and V7 come
from a Python generator independent of `packages/shared`, and both implementations agreed before
the specification was committed. SPEC.md section 11.

**D142 — A submission moves no state; one per assignment; an identical resend is the same
submission.**

Ruling, technical. Under D79 `bounties.state` follows the chain, whose `Submitted` arrives with
`submit_attestation` in P5; the bounty stays `ACCEPTED` and the assignment `ACTIVE`, and the
`submissions` row is the record. A unique constraint holds one submission per assignment (D138
ruling 3). A resend whose root and signature match the stored ones answers 200 with the stored
submission, so a lost response is safe to retry. `consumeCaptureNonce` runs inside the write
transaction; an `EXPIRED` outcome is committed with its status write, and every other refusal
rolls back. Capture-nonce issuance gains a step refusing a submitted assignment. POLICY.md
section 18.6.

**D143 — Each photo passes the start gate's rule at the shutter and at submission.**

Context. D133 left the payment-side location rule to P4 and P5 and allowed it to equal the start
gate's. Submission is final (D138 ruling 3): a photo that P5 would reject, discovered after
submitting, leaves a bounty that can never pay.

Ruling, technical. The phone applies `checkCaptureStart`, with the start gate's ceiling, to each
photo's own fix at the shutter and refuses a failing photo on the spot; the submission applies
the same rule to every item, and also requires each capture time to lie within the session. P5
may tighten either for grading; it may not loosen them. SPEC.md section 10's note that P4 does
not inherit the gate's thresholds is amended accordingly.

**D144 — The phone hashes in chunks, yielding between them.**

Context. D139 measured 4766 ms to hash one photo in JavaScript; in one call the screen would
freeze that long for each photo.

Ruling, technical. `packages/shared` gains `sha256Chunked`, which feeds 64 KiB chunks and yields
to the screen between them; the Scout can frame the next shot while the previous one hashes, and
its upload starts when its hash is done. Resolution is unchanged. Rejected: a native hashing
module, which forces an APK rebuild on both phones; smaller photos, which trade evidence quality
for CPU time.

**D145 — P4's live run, 1 October, and two rulings on it (Umair).**

Record. Bounty `3591bf4c-6acc-4196-8d07-0ca4c49f8ad0`, funded from the Seeker, accepted on the
A30 at 10:50 (deadline 12:50:06), two required photo prompts, a 150 m radius. The Start at
11:09:40 stored its fix as sent (about 10 m from the spot, accuracy 34.7 m) and issued a nonce
expiring at 11:29:40; at 11:11 the countdown read 18:13. The Start at 11:18:25 superseded it
(`SUPERSEDED`, then `CONSUMED` at 11:19:39). Two photos of 1672426 and 1486270 bytes hashed in
5587 and 7186 ms in the development build, uploaded through presigned URLs, and the submission
answered 201. `submission-check` passed 10 of 10, including Solflare's signature over the
`BOUNTYCAM_EVIDENCE_V1` statement and both photos re-hashed after download. The bounty stayed
`ACCEPTED` and the assignment `ACTIVE` (D142). The Seeker showed the requester's line. Every API
log line carried the path only. POLICY.md 17.12 checks 1, 2, 3 and 5 and 18.11 items 2 to 6 are
met.

1. **Check 4 is half met, and left for now (Umair).** The phone's own refusal was seen at 11:01
   with no fix and nothing sent; the distance refusal with its numbers was not. Getting it would
   have meant accepting a second bounty and locking its funds until expiry. The distance rule is
   covered by API evidence test 16 and capture test 15 and shared test 129.
2. **Two required prompts instead of two plus one optional (technical, accepted).** The Create
   form makes every prompt required, so 18.11's optional requirement could not be created from
   the device. Skipping an optional requirement is covered by API evidence test 9 and is the
   same submit rule on the phone.

**D146 — Session 21 product rulings for P5 (Umair, 1 October).**

1. **A photo missing or altered at verification refuses the attestation.** P4 checked every
   photo at submission, so a failure now means the store lost or changed it. Nothing is signed
   and the bounty cannot pay. Rejected: grading A0, under which an A0 bounty could reach
   `Submitted` and be released by the requester's silence with a photo the requester cannot
   see. A store that cannot be reached is retried, not refused.
2. **After a refusal, a shortfall or a lapse, the USDC returns by CLI `expire_accepted`** once
   the deadline has passed, as for every stuck bounty so far (D123 ruling 6). Automating it is
   O1's.
3. **What each side sees** is `apps/mobile/CAPTURE.md` section 8: "Evidence verified. Waiting
   for the requester's review." and "Your evidence couldn't be verified, so this bounty won't
   pay." for the Scout; "Evidence verified." and "Evidence couldn't be verified. Your USDC
   returns after the deadline." for the requester. While checking, both keep P4's lines.
   Neither side is shown the assurance level.

**D147 — The verifier is a separate process in `apps/api`, holding the attester and relayer
keys.**

Context. SECURITY.md section 2 forbids the API server to manufacture an attestation, and
section 14 keeps evidence bytes out of the API process, while the verifier must re-read and
re-hash every photo and sign with the attester key.

Ruling, technical. The verifier is its own long-running process, `src/verifier/main.ts`,
started by `scripts/verifier.sh`, listening on no port. It alone loads `attester.json` and
`relayer.json`; the API's configuration loader never reads either path. It lives in the
`apps/api` package so the database, store and chain modules stay single-sourced: the
separation the invariants need is between processes, not packages. Photos reach it through a
header-signed `GET` added to `EvidenceStore`, which no API route calls. Rejected: a new
workspace package, which would duplicate or re-export those modules six days before the
deadline; signing inside the API process, which section 2 forbids. POLICY.md section 19.

**D148 — The verifier polls a job table; transient failures back off until the deadline.**

Ruling, technical. Migration 14 adds `attestations`, one row per submission, holding the job's
status, grade, stored message and signature, retry state and last transaction signature. Every
`VERIFIER_POLL_S` (5 s) the verifier inserts a row for each submission that has none, then runs
the rows that are due. A store or RPC that cannot be reached, or a send not confirmed in time,
retries after 5, 10, 20, 40, then 60 seconds; every other outcome is final. Reasons: the
submission request runs in another process, so inline triggering is impossible; polling is the
MVP's pattern (D7); the table lets a restart resume exactly where it stopped. Rejected:
`LISTEN`/`NOTIFY`, which adds a second trigger path and still needs the table for retries.

**D149 — What the verifier refuses, how it grades, and what it does with a shortfall.**

Ruling, technical. Refused, finally, with nothing signed: the account is not `Accepted`; any
D84 binding or the recomputed policy hash disagrees (D77); the chain's Scout or deadline differs
from the submission's; the stored manifest, its root, its header bindings or the statement
signature fails a re-check; a required requirement has no item; a photo is missing or differs
(D146 ruling 1). Graded A1 when the submission's nonce is `CONSUMED` and matches the manifest,
every capture time lies in the session, and every item passes D143's location rule with P4's
ceiling; otherwise A0. P5 does not tighten D143's thresholds: P4 refuses at submission what
P5 would grade down, so A0 arises only if the database later disagrees with what P4 checked.
When the grade is below the chain's `required_assurance`, the verifier signs nothing and sends
nothing, and records `SHORTFALL`: the program would reject the transaction with
`InsufficientAssurance` (D85), so sending would pay a fee for a known failure.

**D150 — `attestationMessage` joins `packages/shared`; `issued_at` is the verifier's clock,
signed once.**

Ruling, technical. The 261-byte message is built by one function beside `eligibilityMessage`,
bound by the 13 published attestation vectors and the 15 mutation vectors (D78), with the same
error codes and check order. Every state field comes from the account the verifier has just
read, so the message is the program's own reconstruction whenever the checks passed.
`issued_at` is the verifier's clock in whole seconds when it signs; the program compares it
with nothing (D82). The message and signature are stored, and every later send carries those
exact bytes, so a retry never produces a second, different attestation for one submission.

**D151 — The `submit_attestation` transaction is built by hand; no compute-budget
instructions.**

Ruling, technical. `apps/api/src/chain/tx.ts` serialises a legacy message: the relayer as fee
payer, the native ed25519 instruction at index 0 and `submit_attestation` at index 1, six
account keys in a fixed order, 728 bytes. The API has avoided `@solana/web3.js` since Session 15
because its websocket dependency trips pnpm's build-script block; three JSON-RPC methods join
the existing reader. The serialisation is pinned by a vector produced with web3.js in the
architect's sandbox, then by the live run's recorded transaction. No compute-budget
instruction: devnet needs no priority fee and the default limit covers both instructions;
priority fees are O1's.

**D152 — The verifier stops sending 30 seconds before the deadline.**

Ruling, technical. A job whose assignment deadline is less than `VERIFIER_DEADLINE_MARGIN_S`
(30) away is `LAPSED`. The margin absorbs drift between the laptop's clock and the chain's.
Startup requires the margin to be under `CAPTURE_DEADLINE_BUFFER_S - CAPTURE_SUBMISSION_GRACE_S`
(120 s by default), so a submission accepted at the very end of its grace still leaves the
verifier time to act (D132).

**D153 — The verifier projects `Submitted`; both views gain `verification`.**

Ruling, technical. After a confirmed send the verifier re-reads the account and requires
`Submitted` with the submission's root and the signed level; then one transaction sets the
bounty `SUBMITTED`, writes `achieved_assurance` and `attester_signature` on the submission, and
closes the job. After a restart, a signed job reads the chain before sending, so a transaction
that landed while the verifier was down is projected rather than resent. The assignment stays
`ACTIVE` until P6. The assigned-Scout view is served in `SUBMITTED` as in `ACCEPTED`, and the
owner and assigned-Scout views' `submission` object gains `verification`: `CHECKING`,
`VERIFIED` or `NOT_VERIFIED`, which CAPTURE.md section 8 turns into D146 ruling 3's lines.
POLICY.md sections 19.10 and 19.11.

**D154 — P5's live run, 4 October.**

Record. Bounty `d649d6f4-f2f7-4337-88f5-10809f664c7d` ("P5 live run 1", 5 USDC, two required
photo prompts, a 150 m radius, A1), created and funded from the Seeker, accepted on the A30 at
22:46:52 (deadline 00:46:52 on 5 October; NSW daylight saving began that day). At its first tick
(22:26:05) the verifier marked P4's submission on `3591bf4c` `LAPSED`, reason `DEADLINE`, with no
store read and no send. Capture started at 22:49. Both photos (1538589 and 1620005 bytes, hashed
in 5695 and 6050 ms) showed "Waiting for signal": the local evidence store was no longer
listening on 7070 (curl answered `000`, no listener). Restarted with `evidence-store.sh`, it
answered 403; both photos uploaded on the phone's retry and were submitted at 22:55:06 (201).
The verifier enqueued the submission, re-read and re-hashed both photos, graded A1, signed and
sent `submit_attestation`: 728 bytes, 10,000 lamports for two signatures, 8,626 compute units,
one send and no retry. It confirmed and projected at 22:55:11; chain `submitted_at` 22:55:07,
transaction `3pMzGVWg…CNPGdnt`, finalized. `attestation-check` passed 10 of 10. The A30 showed
"Evidence verified. Waiting for the requester's review."; the Seeker, once reloaded through
Metro, "Evidence verified." with "Submitted 15:55 · 2 photos" (its clock is UTC+4) and, for
`3591bf4c`, "Evidence couldn't be verified. Your USDC returns after the deadline." The
transaction and the `Submitted` account are POLICY.md 19.14 test 19's second vector and fixture.


**D155 — Session 22 product rulings for P6 (Umair, 5 October).**

1. **Approve asks once.** Before the wallet opens, one confirm step: "Pay N USDC to the Scout?
   This can't be undone." N is the bounty's reward.
2. **Silence releases automatically.** At the first verifier tick after the review window
   closes, the verifier sends `release` (D12, D92). The relayer pays the fee and any rent for the
   Scout's payout account; the program moves only what the bounty's state already authorises.
3. **A rejection names exactly one requirement.** The requester picks one requirement from the
   bounty's list. There is no free-text field; `decisions.reason` stays null, so nothing
   unstructured needs moderation.
4. **"Reject by HH:MM".** The requester sees the review window's end, and Reject is hidden once
   it has closed. The program refuses a late rejection whatever the screen shows (D93).
5. **Outcome lines.** Requester: "Paid N USDC to the Scout."; "Disputed: [requirement]. The
   arbiter will decide."; "Arbiter paid the Scout."; "Arbiter refunded you." Scout: "Paid N
   USDC." for approval, silence and an arbiter payment alike; "The requester disputed
   '[requirement]'. The arbiter will decide."; "The arbiter refunded the requester." The Scout's
   line does not say whether approval or silence paid.
6. **Explorer links on both sides.** Every final payout or refund transaction is shown to the
   requester and the Scout as `https://explorer.solana.com/tx/<signature>?cluster=devnet`.
7. **Fixtures and cleanup.** Bounty `d649d6f4` is released by the relayer, recorded as the first
   fixture and the first payout confirmed on the explorer. Bounties `3591bf4c`, `17e419ff` and
   `802997ff` are expired by `expire_accepted`, returning 25 test USDC to the Seeker.
8. **The arbiter is a person.** At A1, Umair resolves disputes by CLI. Product and demo text
   calls it "BountyCam's arbiter" and never implies that arbitration is decentralised or
   automatic.
9. **Two live runs.** First the approve path to payout; then a second A30 cycle rejected from the
   Seeker inside the review window, naming one requirement, and resolved by the arbiter CLI.


**D156 — The requester reads photos through short-lived presigned `GET` URLs.**

Ruling, technical. A new owner-only route, `GET /bounties/:id/evidence`, returns one SigV4
query-presigned `GET` URL per evidence item, valid for `EVIDENCE_READ_URL_TTL_S` (default 300,
at most 900). Reasons: SECURITY.md section 14 keeps evidence bytes out of the API process, and
the phone loads the images at once, so a short lifetime limits a leaked URL at no cost. URLs are
served only once the submission's attestation is `SUBMITTED`, because nothing can be approved or
rejected before chain `Submitted`. They are never logged, stored or returned by another route
(SECURITY.md section 7). The Scout and the public get no photo route. POLICY.md section 20.9.


**D157 — One settlement projection, from the account, with the signature found by the server.**

Ruling, technical. `projectSettlement(bountyId)` is the only writer of `DISPUTED`, `PAID`,
`REFUNDED` from `expire_accepted`, `settlements` rows and P6's `decisions` rows. Its evidence is
the account (D79, SECURITY.md section 12). The settling transaction's signature is needed for the
explorer link but the account does not hold it, so the server finds it itself: the account's
recent signatures at `confirmed`, each successful transaction read until one carries a top-level
escrow instruction on this account whose discriminator matches the chain state. It never takes a
signature from a phone. Callers: `POST /bounties/:id/settlement`, the verifier's settlement pass
and `settle.mjs`. Reasons: the funding and acceptance projections set the pattern (D118, D124),
and a phone-supplied signature would be a claim to check, where a chain read is evidence.
POLICY.md section 20.4.


**D158 — Migration 15: `settlements`, the rejection's signature, the review window's end.**

Ruling, technical. A `settlements` table, one row per settled bounty, holds the kind, the
signature and the block time. `decisions` gains `tx_signature` and a unique key on
`submission_id`: one decision per submission, `APPROVE` or `REJECT`. `submissions` gains
`review_ends_at`, the chain's `submitted_at` plus `review_window_secs`, so views never read the
chain. Reasons: a settlement is a fact about the bounty, not a requester's decision (a release
has no decider, a resolution is the arbiter's), and D97's `decisions` row for a rejection stays
the product record. POLICY.md section 20.2.


**D159 — The verifier sends `release`; repeated sends are harmless and checked first.**

Ruling, technical, carrying D155 ruling 2. Each verifier tick runs a settlement pass over
`SUBMITTED` and `DISPUTED` bounties. For one whose projection finds chain `Submitted` and whose
`review_ends_at` plus `VERIFIER_RELEASE_MARGIN_S` (10) has passed on the verifier's clock, it
sends `release` with the relayer as fee payer. Idempotency: the projection reads the account
before every send, so a settled bounty is projected rather than resent; the send uses preflight at
`confirmed`, so a second `release` against a `Paid` account fails simulation with
`BountyNotReleasable` and costs nothing; after any failure the account is read again. The margin
absorbs drift between the verifier's clock and the cluster's, as D152's does. Retry state is held
in memory, because the chain is the record and a restart simply reads it again. POLICY.md
section 20.6.


**D160 — The phone builds `approve` and `reject`; the Scout comes from the chain.**

Ruling, technical. As for funding and acceptance (SECURITY.md section 3), the requester's phone
builds both transactions with typed builders, checks them with new `packages/shared` functions
and passes them to MWA. `approve` carries the Associated Token program's idempotent create for the
Scout's payout account first, its rent paid by the requester as fee payer (D92). The Scout's
wallet is read from the bounty account on chain, not from the API: the owner view never carries
Scout detail (D138 ruling 5), and the program checks the Scout regardless (`ScoutMismatch`). The
requirement id comes from the owner view's policy after its hash is checked. `packages/shared`
SPEC.md section 13; `apps/mobile/REVIEW.md`.


**D161 — A rejection naming a requirement outside the policy is projected and flagged.**

Ruling, technical. D93 leaves membership to the API and the arbiter. The only client checks it
before signing, so a foreign id means a transaction built elsewhere. The chain is `Disputed`
either way and the database follows the chain: the bounty becomes `DISPUTED` with no `decisions`
row, the foreign key permitting none, and one error-level line `FOREIGN_REQUIREMENT` is logged.
The arbiter CLI prints that the requirement is not in the policy. D97's sentence on the
`decisions` row holds for every rejection the product can produce.


**D162 — `settle.mjs`: release, expire, resolve and project by hand.**

Ruling, technical. One laptop script in `apps/api/scripts`, outside the gate:
`release <bounty_id>` and `expire <bounty_id>` sign with the relayer; `resolve <bounty_id>
pay|refund` signs with the arbiter, the relayer paying the fee; `project <bounty_id>` sends
nothing. Each prints the chain state, asks once before sending, sends, then runs
`projectSettlement` and prints its outcome and the explorer link. `resolve` first prints the
named requirement's prompt and downloads the photos, each checked against its stored sha256, to a
folder in `~/Downloads`, so the arbiter decides on the evidence. The transaction builders are in
`src/chain/tx.ts` and tested; the script only wires them. POLICY.md section 20.10.


**D163 — Fixtures are recorded before the build, by a one-off script.**

Ruling, technical. The projection's tests need a real `Paid` account, a real `Refunded` account
and real `getTransaction` and `getSignaturesForAddress` responses. D155 ruling 7's four sends
produce them: a one-off script outside the repo signs `release` for `d649d6f4` and
`expire_accepted` for the three stale bounties with the relayer, and saves every raw response.
The rows of those bounties stay as they are until the build lands, then `settle.mjs project`
projects them. `approve`, `reject` and `resolve` cannot be recorded before the live runs: their
tests start from the recorded transactions with the instruction data changed, stated in each test
as harness setup, and the records commit adds the real ones.


**D164 — P6's live runs, 5 and 6 October.**

Record. Sydney times (AEDT, UTC+11); the Seeker's clock is UTC+4.

- **The D163 sends, 5 October, 12:37 onward.** The relayer released bounty `d649d6f4` (5 USDC to
  the A30, `4BusUw3c…`) and expired `3591bf4c`, `17e419ff` and `802997ff` (25 test USDC back to
  the Seeker, `5WTgMzcF…`, `4wfMwWBN…`, `35E6UBhg…`). All four were simulated first and
  confirmed. After build 1 and migration 15, the restarted verifier projected `d649d6f4` to `PAID
  RELEASED` on its first ticks, and `settle.mjs project` projected the three expiries to
  `REFUNDED EXPIRED_REFUNDED`.
- **Run A, approve, 6 October.** Bounty `2c92c434-0db1-4b5c-9b01-8422c1160cb7` ("BountyTest", 5
  USDC, two photo prompts, A1), funded from the Seeker at 09:06:52, accepted on the A30 at
  09:13:39, submitted and attested at 09:17:08 (grade 1, `2LfBL7rz…`, `attestation-check` 10 of
  10; `submission-check` 9 of 10, its C7 predating the verifier). On the Seeker the bounty screen
  showed both photos through presigned `GET` URLs and "Reject by 03:17". Approve, the confirm
  step and Seed Vault sent `approve` at 09:20:44 (`ZNAq2ECe…`, 22,886 compute units). The
  Seeker showed "Paid 5 USDC to the Scout." with the explorer link; the database `PAID APPROVED`
  with an `APPROVE` decision; the A30 "Paid 5 USDC." with the link.
- **Run B, reject and resolve, 6 October.** Bounty `70af9c0f-3a6c-48f5-963e-b479a5e28304`
  ("RejectTest"), funded at 09:28:16, accepted at 09:30:53, attested at 09:32:01. The Seeker
  rejected naming "PhotoMouse" at 09:35:40 (`ugAuKoxb…`), inside the window: `DISPUTED` with a
  `REJECT` decision naming requirement `3090641a…`. `settle.mjs resolve … pay` printed the
  requirement, downloaded both photos with their hashes checked, and the arbiter (`6YPX1o…`)
  signed `resolve` paying the Scout at 09:39:47 (`f9QZhRY1…`, the relayer paying the fee). The
  database showed `PAID RESOLVED_PAID`; the Seeker "Arbiter paid the Scout."; the A30 "Paid 5
  USDC."; both with the explorer link.

The approve, reject and resolve transactions, both settled accounts and both bounties' rows are
the settlement suite's fixtures from the records commit (POLICY.md 20.15, A9).


**D165 — S0: dApp Store publishing and a public backend (Umair, 6 October).**

1. **Order after P6:** S0, then S3; A2 and A3 deferred.
2. **Publisher:** an individual, Umair Akram, verified through the portal's identity check.
   Publisher wallet: a dedicated Phantom account, `FsrzwgGWQJYtdEmPhcLQw5qAoS5cSZDBe5pPvxYfU7DC`,
   separate from the Seeker wallet and every devnet key, its recovery phrase on paper.
3. **The backend is hosted publicly,** so the store build works on any phone: an OVHcloud
   VPS-1 in Sydney, monthly with no commitment, Ubuntu 24.04, `51.161.153.97`.
4. **Domain:** `bountycam.app` at Cloudflare; `api.` and `store.` point at the VPS, DNS only;
   the landing page on Cloudflare Pages.
5. **App identity:** Android package `app.bountycam`; the name under the icon **BountyCam**.

Technical calls, the architect's: host networking for every container, so the code is
unchanged and only Caddy listens publicly; a fresh database on the server; secrets copied by
`scp` at mode 600, never in an image; the arbiter key stays on the laptop; the release build's
API address through `EXPO_PUBLIC_API_BASE_URL`. `ops/DEPLOY.md`.

The repository is private. HANDOFF.md's header called it public; corrected in this commit.


**D166 — S0's record: the public backend, the release build and the store submission, 6 October.**

Record. Sydney times (AEDT).

- **Server.** OVHcloud VPS-1, Sydney, Ubuntu 24.04.4 (kernel 6.8.0-146), `51.161.153.97`: key
  login only, root and password logins off, ufw allowing 22, 80 and 443, Docker 29.8.2 with
  Compose 5.6.0. `ops/deploy/deploy.sh` deployed `bab9a39`: the five containers up, 15
  migrations on an empty database, `/health` and the store's 403 from inside; from outside,
  HTTPS on both names with Let's Encrypt certificates and ports 3000, 5432 and 7070 closed.
- **Release APK.** Built and signed as `ops/DEPLOY.md` section 10; installed beside the dev
  client on both phones.
- **End to end on the server, no cable.** Bounty "Test1" (`a06d54b6…`) created and funded on the
  Seeker, accepted and captured on the A30 with its photos uploaded to `store.bountycam.app`,
  attested by the server's verifier, approved on the Seeker: `PAID`, "Paid 5 USDC to the Scout."
  and "Paid 5 USDC." with explorer links on both phones. A second run ("BusStop") likewise.
- **Website and mail.** `bountycam.app` serves `ops/site/` (home, `/terms`, `/privacy`);
  `support@bountycam.app` forwards to Umair's mail, tested.
- **Store.** Listing as `ops/LISTING.md`; app collection minted (about 0.0176 SOL from the
  publisher wallet); v1.0.0 submitted and in review. The APK went to the portal's storage; no
  further SOL was spent.
