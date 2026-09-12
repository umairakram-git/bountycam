# BountyCam — Handoff

**Date:** 12 September 2026
**Sessions complete:** 1–5, 6a, and 6b part 1
**Next session:** 6b part 2 — auth implementation
**Deadline:** 8 October 2026 (26 days remaining)
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
│   ├── api/          Fastify + TS, node-pg-migrate, 2 migrations
│   └── mobile/       Expo + TS skeleton, android/ kept, ios/ deleted
├── packages/
│   └── shared/       SPEC.md (normative) + stubs — implementation pending
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

## Next: Session 6b (part 2) — auth implementation

Implement per AUTH.md (normative — if implementation and spec disagree, stop
and report): challenge and verify endpoints, JWT issuance, `GET /auth/me`,
the injectable clock, and the test list; first amend AUTH.md section 13 to
add test 38 (two concurrent verifies with one nonce: exactly one succeeds,
per SECURITY.md section 4) so the D36 count gate is exactly 38. The JWT
secret exists at `~/bountycam-keys/jwt-secret.hex` (64 hex characters plus
a trailing newline, mode 600). The loader strips whitespace before decoding
to 32 bytes (AUTH.md section 9).

The zero-match glob check was done: `node --test test/*.test.ts` with no
matching file reports tests 0 and exits 0 (the D36 class). Fix in part 2:
the test script names each test file explicitly (AUTH.md section 13).

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
