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
