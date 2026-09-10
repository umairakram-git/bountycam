# BountyCam — Handoff

**Date:** 10 September 2026
**Sessions complete:** 1–4
**Next session:** 5 — shared package specification
**Deadline:** 8 October 2026 (28 days remaining)
**Repo:** https://github.com/umairakram-git/bountycam (public)
**Local path:** `/Users/umairakram/developer/hackathon202609`

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
│   └── shared/       canonicalise / sha256 / merkleRoot — STUBS ONLY
└── programs/
    └── escrow/       Anchor 1.1.2, SPEC.md, 10 passing tests
```

Six commits on `main`, all pushed. Working tree clean.

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

## Next: Session 5 — shared package specification

Write `packages/shared/SPEC.md` first. No implementation.

Three functions get computed independently by the phone, the server, and a
standalone verifier. If any two disagree by a single byte, payment fails on
valid evidence and the failure presents as a bug in whichever component is
being debugged at the time.

The spec must define:

- `canonicalise` — key ordering and collation, number representation as
  strings, string escaping, unicode normalisation, treatment of null and
  empty containers, what is rejected outright
- `sha256` — input encoding, BOM handling, hex convention
- `merkleRoot` — leaf hashing, domain separation, concatenation order, odd-node
  handling, empty and single-element roots

Reference RFC 8785 and state explicitly where it deviates and why.

**Five worked test vectors are the deliverable that matters.** They are what
lets a Rust verifier and a TypeScript client prove agreement.

---

## Working rules

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
