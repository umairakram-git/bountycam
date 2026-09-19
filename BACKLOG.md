# BountyCam — Backlog

**As at:** 19 September 2026 · 19 days to deadline

---

## Second device — resolved 12 September

Samsung A30, API 30; devnet wallet funded and verified from the chain. Nothing
blocking remains for the Session 11 two-device race gate.

Worth not rediscovering: **Solflare is the working wallet on that handset.**
Phantom's devnet balance display is unreliable there — use Solflare for the
requester side.

---

## Open findings from completed sessions

~~**D13's A4 names a device.** "A3 + Verified Seeker + wallet signature"
(DECISIONS.md:96) makes the top assurance rung unreachable without a Seeker.
It is carried into policy v1 as `required_assurance` bounded 0 to 4
(POLICY.md:92, 112, 189), into the escrow as a `u8`, and gated on-chain per
D17. The integer is inside the hashed policy; the meaning of the integer is
not, so redefining A4 changes what already-committed policy hashes meant with
no hash changing. Contradicts PRD section 8 (Seeker is the initial
distribution layer, not the boundary) and section 52. Options: leave it;
redefine as a minimum trust level with SGT as one qualifying route; or version
the ladder so A4's meaning is pinned per policy version. Owed before Session
14 grades against the ladder. Found Session 8 part 1.~~
Decided 14 September (D69): the qualifying rule set is a committed eligibility
profile. Profile-id format and hash derivation fixed 16 September (D84);
profiles below A4 are OPEN-1 in the spec session step 3 section below.

~~**`Cancelled` enum variant is unreachable.** `cancel` closes the account rather
than setting state, so the variant can never be observed. Either drop it, or
set state before closing so an indexer can see the terminal state.
Recommendation: drop. Dead state variants in an escrow mislead whoever adds
`dispute` later.~~ Decided 14 September (D76): the variant is removed;
cancellation is an event plus a database record. Code change done 16 September:
ed529c0 removes the variant; 396013d emits `BountyCancelled`.

~~**`UnauthorizedRequester` is overloaded.** It fires both for "you are not the
requester" and for "this token account is not yours". A client cannot
distinguish them. Add a distinct error for token-account ownership — error
codes are the API surface the mobile app reads.~~ Decided 14 September (D75):
`TokenAccountOwnerMismatch` is appended; error variants are append-only. Code
change done 16 September (e1680ff).

~~**`SPEC.md` for the escrow was written after implementation.** It documents
what was built rather than constraining it, and recorded the invented fee
constant as though intended. Reconcile against the original Session 4 prompt.~~
Ruled 14 September (D80): replaced wholesale, not reconciled. Done 16 September
(dfd821b): `programs/escrow/SPEC.md` replaced wholesale, stating its supersession
and authority order. Its section 13 lists the implementation tasks.

**`anchor deploy` is deprecated** in favour of `anchor program deploy`. Switch
before it is removed.

**`apps/mobile/.claude/settings.json`** arrived from the Expo template. Review
it — template-supplied agent settings can carry permissions that were not chosen.

~~**`apps/api` test script uses an unquoted glob** — `node --test test/*.test.ts`.
Verify in Session 6, from raw output, what it does when zero files match, before
trusting any pass from it (see D36 for the false-pass class this guards against).~~
Done 12 September (Session 6b): verified the zero-match false pass from raw
output; the script now names both test files explicitly.

**`typescript` and `@types/node` use caret ranges** in `packages/shared`
devDependencies. Exact-pin them — the D19 pattern: caret semantics silently
resolved `anchor-lang` to a version the CLI did not match.

~~**`bounties.reward_amount` is `numeric` with no scale.** Decide precision
and scale (USDC base units per D26 vs decimal column) when bounty creation
is built (Session 7).~~ Decided 12 September (Session 7a): `numeric(20, 0)`
with a CHECK for the u64 bounds; base-unit integer string on the wire
(POLICY.md section 6, D57). Migration lands in Session 7b.

~~**DB `bounty_state` vs program state enums to reconcile.** The database
enum and the on-chain state machine must not drift; reconcile when the
escrow state instructions land (Session 9).~~ Closed 655262b: D97's mapping
in POLICY.md section 7.2.

**`apps/mobile/.claude` expo plugin decision.** Decide whether the
template-supplied plugin configuration stays (Session 10).

**TypeScript 5.9 vs 6.0 split.** `packages/shared` and `apps/api` pin
5.9.3; the Expo template pulls its own TypeScript for `apps/mobile`.
Decide alignment or an accepted split before Session 10.

**pnpm is not pinned.** Consider `packageManager` in the root
`package.json` so pnpm 11.22.0 is enforced per checkout.

**`DATABASE_URL` is not checked at startup** in `apps/api/src/index.ts`; a
missing value surfaces as a 500 on first query. Add a startup check like
the JWT secret's (Session 7).

**`apps/api` lint covers `src` only.** `test/*.test.ts` is not type-checked;
a type error in a test surfaces only at run time. Decide whether to add a
test tsconfig (Session 7).
First known instance (Session 7b, commit 4a): `auth.test.ts`'s `Config`
literal is missing `cluster`, `settlementMint` and `attesterPubkeys` —
invalid against the interface, invisible because tsconfig includes `src`
only, passing at runtime because the auth flow reads none of them. Expect
it in the commit 7 before-count; left unfixed deliberately so that count
stays an unmanipulated measurement. Also recorded: the suite passed 38/38
with a config object that cannot satisfy its own declared type — the suite
would keep passing if `loadConfig` returned something the routes could not
use. Session 8's attester work reads `attesterPubkeys` for real; the gap
stops being theoretical there.
Subject changed 16 September (D82): `ATTESTER_PUBKEYS` and the policy's
`attester_pubkey` are removed, and the attester is read from the on-chain
configuration account. This instance becomes moot when that removal lands; the
class of error — untyped test config — is unchanged.

Second known instance (Session 7b, commit 4c): `auth.test.ts` builds
`AppDeps` by hand and omits the now-required `randomness` field. At runtime
`registerBountyRoutes` closes over `undefined`; the only dereference is
POST /bounties step 7, which the auth suite never issues — verified still
38/38 after the change, from raw output. Same class, same treatment:
recorded for the commit 7 before-count, not silently fixed.

Third known instance (Session 7b, commit 4c): the chunk 2 run of
`bounties.test.ts` failed tests 5 and 7 with ReferenceError —
`canonicalise` and `sha256` were used but never imported. tsc does not see
`test/`, so the missing import was invisible until runtime. Unlike the
first two instances, this one broke rather than silently passing; the
strongest argument yet for the commit 7 decision.

**`uuid@7.0.3` is a deprecated transitive dependency.** `pnpm why uuid` to
find the parent; decide whether it matters (Session 7).

---

## Outstanding from Session 5 part 1

- ~~Implement the three functions to SPEC.md; the five vectors are the test
  suite, and the spec wins over any implementation on disagreement.~~
  Done 11 September (Session 5 part 2) — 66 conformance tests passing.
- ~~Stub JSDoc in `packages/shared/src/index.ts` claims all numbers serialise
  as strings — contradicts SPEC.md §1.3. Fix during implementation.~~
  Done 11 September (Session 5 part 2).
- ~~The GPS 7-decimal-place profile is normative for producers but unenforced
  by `canonicalise`. Decide where the check lives when policy creation is
  built (Session 7).~~ Decided 12 September (Session 7a): the check is request
  validation in `apps/api`, the only producer (POLICY.md section 5, D61). The
  lift into `packages/shared` when a second producer exists has no owner —
  see the Session 7a open items below.
- Any Rust implementation (Session 17 standalone verifier) must sort keys
  by UTF-16 code units, not bytes. Flagged in SPEC.md; easy to miss.
- Canonical files: HANDOFF, DECISIONS and BACKLOG live in the repo and are
  maintained there by Claude Code during each session. Project knowledge is
  not kept in sync mid-session. At the start of a new chat session, Umair
  uploads the current files from the repo as that session's snapshot. The
  repo is always the source; project knowledge is never edited and never
  uploaded back.

---

## Open items from Session 7a (POLICY.md section 14)

- **The GPS profile lift has no owner.** The section 5 form rules lift into
  `packages/shared` when a second producer of policy objects exists. No planned
  session builds a mobile bounty-create flow — Session 11 is discovery, detail
  and accept, all consumers — so the session that first gives a client a create
  flow inherits the lift. Name it in POLICY.md sections 5 and 14 and in D61 when
  it exists.
- **Idempotency-key retention.** Consumed keys accumulate without bound; accepted
  for the MVP. Production needs a retention decision under SECURITY-PRODUCTION.md
  section 5 — when a key row may be pruned and what a replay after pruning
  returns. Owed before any mainnet deployment, not before the hackathon.
- **Program id deliberately not in the policy.** Binding is structural (the
  funding transaction writes the hash into a program-owned account). Revisit if a
  second deployment coexists with the first or a consumer must verify with no
  chain access — either is a new policy version, never a seventeenth v1 field.
- **Category taxonomy.** `category` is free text, 1 to 50 code units. Enum or
  not is owed by the first session that builds category browsing UI (Session 11
  per the current plan); tightening it later affects no hash.
- **Provisional product bounds.** Windows, requirement count and prompt length,
  capture radius, title and category lengths, query radius and pagination.
  Amendable without touching any hash; review by Session 20's two-device runs.

---

## Open items from spec session step 3 (16 September)

- **OPEN-1 — eligibility profiles below A4.** D69 defines only `A4_SEEKER_V1`,
  and every bounty must name a profile (D84), so levels 0 to 3 need ids and the
  API needs a rule rejecting an incompatible level-and-profile pair. Proposal:
  `BASE_V1` for levels 0 to 3, `A4_SEEKER_V1` for level 4 only. Owed by the
  session that edits POLICY.md for D82 and D84, which reads the Session 8
  memo's m5 ruling first. Blocks that POLICY.md edit only.
- **POLICY.md amendments owed (D79, D82, D84).** Sections 2.1 and 2.4: remove
  `attester_pubkey`, add `eligibility_profile_id`. New sections: the binding
  register, and the profile registry referencing the shared derivation rule.
  Section 7.1: the `attester_pubkey` read-model column, with its migration.
  Section 7.2: projection to `AVAILABLE` requires every binding to agree.
  Sections 8.1, 8.3 and 8.8: `ATTESTER_PUBKEYS`, the request field and
  `ATTESTER_NOT_ALLOWED`. Section 12: tests 24, 25 and 71 rewritten,
  binding-register tests added. Section 13: vectors V1 and V2 regenerated by
  script, with the supersession statement. `packages/shared/SPEC.md` gains the
  profile-id format and hash derivation, with generated vectors.
- **V1 freeze SHA owed (D84).** Record the full SHA of the first commit in
  which `packages/shared` and the API reproduce every regenerated vector, in a
  new DECISIONS.md entry, then cite it in POLICY.md.
- **D86 revisit triggers.** Voucher replay across cancel and re-creation is a
  stated limit until any of: a supported client path reuses bounty ids;
  voucher validity becomes long-lived; a Session 9 path closes an account that
  can hold a valid attestation. Any one requires a program-bound bounty
  incarnation identifier. Session 9 assessment (D96): the third trigger is not
  tripped; only `expire_unaccepted` closes a bounty, from `Funded`.
- ~~**Rehearse `initialize` on localnet (D83).** The eligibility and arbiter keys
  were generated 18 September under `~/bountycam-keys/`, mode 600: eligibility
  `Bg6SsTTH6EX5AaeQQ9i4yhDTwsSjxnHx9AV8cqa97xmp`, arbiter
  `6YPX1obwh62N2DDyxtNa2RwkriWUUWLzjAvEWJFbvK1K`. The rehearsal with the exact
  devnet public keys is still owed before `initialize` runs on devnet: the
  configuration is immutable, so a mistake costs an upgrade with a migration.~~
  Done 19 September: rehearsed on localnet with the same program id, ProgramData
  address, mint address, upgrade authority and script file, only `--url` differing,
  then run on devnet. SPEC section 13's three operational steps are now all
  discharged.
- ~~**Escrow test dev-dependencies are caret ranges.** `litesvm`,
  `solana-message`, `solana-transaction`, `solana-signer` and `solana-keypair`
  in `programs/escrow/programs/escrow/Cargo.toml` violate SECURITY.md section
  10's exact pins. Confirm locked versions with `cargo tree`, then pin. D83's
  harness note relies on litesvm 0.10.0's `add_program` behaviour.~~ Done 16
  September (e6a5da4): exact-pinned to the locked versions; `serde_json` =1.0.151
  added for SPEC test 23.
- ~~**Devnet bounty accounts do not survive the layout change.** D74 and D81 to
  D84 change the bounty account, so accounts created under the Session 4
  program become unreadable after the redeploy. List program-owned accounts on
  devnet before redeploying and cancel any holding test USDC while the old
  program can still read them.~~ Closed 18 September: `getProgramAccounts` for
  the program on devnet returned an empty result before the upgrade. It owned no
  accounts, so none held test USDC and none needed cancelling.
- ~~**SECURITY.md section 7's attester leak line overstates.** It says a colluding
  Scout is paid without real work; D12's review window still lets the requester
  dispute before release. Tighten when Session 9 fixes the release and dispute
  rules.~~ Closed eecf47c (D93).
- **`MESSAGES.md` never states `schema_version`'s value in prose.** Sections 3
  and 4 give it only as a `u16` constant; the value exists only in the published
  vectors. The escrow spec (section 9) defers to the vectors. Add the value to the
  prose at the next `MESSAGES.md` edit; no vector changes.
- **`MESSAGES.md` section 7's `submit_attestation` row omits the index field.**
  Its 60 bytes reproduce only without the two-byte
  `verification_instruction_index`; with it the row is 62. Harmless, because the
  total is a declared upper bound that still counts a second signature. The real
  counts are in `programs/escrow/SPEC.md` section 14: 780 bytes for
  `submit_attestation`, 795 for `accept`. Correct the row at the next
  `MESSAGES.md` edit.
- ~~**The remaining plan still uses D72 non-terms.** Its rows for Sessions 8 and 9
  say "challenge nonce" and "challenge window", and Session 16's says "challenge
  window". Replace with capture nonce and review window in a wording-only edit.~~
  Closed in this edit.

---

## Open items from Session 8 build part 1 (16 September)

- ~~**Legacy `cancel_when_accepted_fails` still plants `Accepted`.** It rewrites the
  bounty account, which SPEC section 12's harness rules forbid, and is kept only so
  D49's cancel-after-accept rejection stays covered. Part 2 replaces it with SPEC
  test 31 through a real `accept` (task 14) and removes it in the same commit.~~
  Closed 97f0732: test 31 reaches `Accepted` through a real `accept`; the legacy test is
  removed in that commit.
- ~~**Test 91 has two of its three cases.** Part 2 adds the `accept` Scout case and
  raises the asserted case count to 3.~~ Closed 97f0732: the `accept` Scout case is the
  third, with a valid voucher so the missing signature is its only fault.
- ~~**`VaultBalanceBelowReward` has no failing run.** SPEC section 7.3 makes it
  unreachable by construction. Review item: confirm by reading that only the bounty
  PDA can move vault tokens and that the check precedes the transfer.~~ Closed 3bb66ac:
  HANDOFF records the review; `cancel.rs` line 49 precedes the transfer at line 67 and the
  vault's authority is the bounty PDA, which only the program can sign for.
- ~~**SPEC task 18 review items are owed.** Every check precedes the token CPI; no
  instruction reads remaining accounts; no dependence on recursion. Part 2 records
  each against the final source.~~ Closed 3bb66ac: recorded in HANDOFF against 0297dce with
  grep evidence, plus the builder call sites and the untested checks listed below.
- ~~**SPEC section 16's reconciliation row stops at D86.** Add D87 (sections 10, 11
  and 12) and D88 (test 40) at the next SPEC edit; wording only.~~ Closed c2f74c9: the row
  runs through D89. D90 and D91 are owed below.
- **Claude Code's project memory index names a missing file.** `MEMORY.md` lists
  `feedback_spec_editing.md`, which does not exist. Restore the file or remove the
  line, at the next D32 inspection.

---

## Open items from Session 8 build part 2 (17 September)

- ~~**Two checks are implemented with no test.** `accept` check 7 (`TimestampOverflow`)
  needs a funding clock within 30 days of `i64::MAX`, which no real chain reaches, and a
  test would change the 95-test gate. `submit_attestation` check 2
  (`StateInvariantViolated`) is unreachable without planting: only `accept` writes `scout`
  and `deadline`, always together, and only `accept` sets `Accepted`. Both are task 18
  review items in HANDOFF; revisit only if a Session 9 instruction can clear either field.~~
  Closed e5bab87: no Session 9 instruction clears either field (D96); both stay review items.
- ~~**SPEC wording, owed at the next SPEC edit.** Section 4.1's sentence "An instruction
  finding the invariant broken fails with `StateInvariantViolated`" reads as binding on
  every instruction, but section 7.4 gives `accept` no such check and the build followed
  7.4; tighten 4.1 to name `submit_attestation`. Section 16's reconciliation row stops at
  D89; extend it to D90 and D91; the exact wording is settled at that edit. Wording only,
  no behaviour change.~~ Closed e5bab87: section 4.1 names the instructions that check the
  invariant; section 16 runs through D98.
- **RUSTSEC acceptances need an allowlist entry, not silent removal.** `ed25519-dalek`
  1.0.1 (RUSTSEC-2022-0093) and `curve25519-dalek` 3.2.0 (RUSTSEC-2024-0344) are accepted
  for tests only (D89): they enter through the two dev-dependency edges and never the
  program build. When the CI dependency review of SECURITY-PRODUCTION.md section 7 exists,
  its allowlist carries both ids citing D89, so a future audit run fails loudly on any
  third advisory rather than on these two.

---

## Open items from Session 9 specification (17 September)

- **Funded `CANCELLED` projection is unscheduled.** POLICY.md section 7.2 (D97) maps a
  confirmed funded `cancel` to `CANCELLED`, but no session is named to build that path.
  Assign it when Sessions 15 and 16 are planned in detail.
- **Clients must create destination token accounts.** The program never creates the Scout
  payout or requester refund account (D92, D95). Every client or relayer path that submits
  `approve`, `release`, `resolve` or either expiry places the Associated Token program's
  idempotent create first. Owed by Sessions 15 and 16.
- **Nothing settles on its own.** `release` after the review window and both expiries are
  permissionless, but the chain acts only when someone submits them (D92, D95). The Session 15
  relayer needs a job that finds due bounties and submits them; until then funds wait in the
  vault.
- **Arbiter liveness.** A dispute has no timeout (D94). Before mainnet, decide an operational
  response time or rule on a timeout; SECURITY-PRODUCTION.md section 11's arbiter item does not
  cover it.
- **Vault pre-creation blocks funding.** Pre-existing since Session 8, found while reading
  Anchor's source. `create_and_fund` initialises the vault with `init`, which calls the
  Associated Token program's non-idempotent `create`, so anyone who first creates the associated
  token account at a bounty's vault address makes funding fail for that requester and
  `bounty_id`. No funds are at risk. Exposure depends on whether a `bounty_id` is visible to
  anyone but its requester before funding, and on same-id re-creation, which D86 already treats
  as unsupported. Needs a ruling before the funding path ships.
- **Tokens sent to a settled bounty's vault are unrecoverable.** Stated limit in SPEC section 15
  (D96). Revisit only if a client ever shows vault addresses, or if a recovery instruction is
  wanted, which needs its own D-entry.
- **Rent in settled bounty accounts.** 2797920 lamports per `Paid` or `Refunded` bounty stay
  locked (D96). Reclaiming them needs its own D-entry and must not reopen D86's replay trigger.

## Open items from Session 9 build (18 September)

- ~~**SPEC task 25's review items are not done.** The build stopped at the gate. Task 25 covers
  section 11's rows marked "review item" and the check-1 state invariants, read against the final
  source. Owed before any devnet deploy.~~ Done 18 September against the source at fe70f34: no
  findings against the eleven instructions. `cancel` was reviewed alongside the Session 9 set.
  Two record corrections came out of it, D101 and the SPEC 7.7 wording.
- ~~**The escrow has never been deployed to devnet.** Eleven instructions, 140 tests, no deploy.
  Whoever schedules it re-reads SECURITY.md section 16 and D90's deploy rules first.~~ Deployed
  18 September. ProgramData extended from 218736 to 488736 bytes for 1.37 SOL, then upgraded.
  Verified from the chain rather than from the tool: the first 456736 bytes of
  `solana program dump` hash to 04dd0c29, equal to the local `target/deploy/escrow.so`, and the
  remaining 32000 bytes are zero. No buffer was stranded.
- **`approve` and `release` share one commit.** 4b5eef2 carries both, after a mis-run commit
  script produced an uncompilable 9044791 that was amended away. No single commit holds
  `approve` alone, and build commit 5's own counted run is in the architect chat only.
- **Anchor's stack frame is close to full on the payout instructions.** D100 boxed four accounts
  in `approve`; `release` and `resolve` were written boxed. Any account added to a settlement
  instruction risks the 4096-byte limit again, and the build reports it while still exiting 0.

## Open items from Session 10 (18 September)

- ~~**`initialize` has not run on devnet.** The program is deployed with no configuration account,
  so every instruction fails on the config PDA.~~ Done 19 September. Configuration account
  `DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb`, bump 255, 138 bytes, signature
  `s2ebAtTqPC7jPcujaf1ciCAWEEc6rk35RVDmpzVMSV1V8Z7G2Rpdu22FBTke5SSpf5aYGQLZ95HrQ4gNezmCkhD`,
  finalized slot 500795088. It is immutable.
- **The devnet IDL is still the Session 4 one.** The upgrade landed; the IDL metadata write did
  not. Clients build from the local IDL file, so nothing is blocked.
- **MESSAGES.md section 7 says `submit_attestation` does not exist.** It does. The owed check is
  its real account list against the eighteen-account ceiling. Session 13.
- **MESSAGES.md section 10 lists seven implementation discrepancies as open.** All seven have
  since landed. The section is stale rather than wrong; it needs a wording pass.

---

## Open items from Session 11 (19 September)

- **The eligibility service has no owning session.** Voucher issuance (D68) is a hard dependency
  of on-chain `accept`: without it no bounty can be accepted at all. It also owns SGT verification,
  which must run server-side over the SIWS-proved wallet — a client asserting Seeker ownership
  proves nothing — and it must rule OPEN-1 first, because every bounty names an eligibility
  profile and only `A4_SEEKER_V1` is defined. Specification before code, as always. Assign a
  session before Session 12 specifies the accept flow.
- **Seeker gating is out of the demo until that session lands.** The second handset is a Samsung
  A30, so a Seeker-only profile would also block the two-device race gate.
- **Session numbering drifted after Session 10.** The remaining-plan rows and the verification-gate
  table were written before the shift. The race gate is Session 12, not 11.
- **Mobile pre-decisions, owed before the mobile build opens.** pnpm 11's build-approval gate fires
  when web3.js lands in `apps/mobile` (`allowBuilds: false` for `bufferutil` and `utf-8-validate`);
  the `@noble/hashes` 1.8.0 against 2.4.0 split; the TypeScript 5.9 against Expo's own;
  `apps/mobile/.claude/settings.json` from the template; and the app identity `uri`, which is the
  same question as AUTH.md section 14.2's domain value.
- **The rehearsal client is not in the repo.** `bc-initialize.mjs`, sha
  `0c6ee7549b8ee57ba9144f3537f211a2ea5b64cc7b37206c830db8dc2c930f0e`, and
  `bc-initialize-negatives.mjs`, sha
  `c3b04c139fac65378fa3236d161c222af34d2b4f9077b0411130f8595e0d2ba1`, ran from `/tmp/bc-init`.
  Decide whether operational scripts belong under version control before the next one is written.

---

## Notes owed to `solana-dev-notes`

- Unknown keys in `Anchor.toml` are silently ignored, not rejected.
  `skip_deploy` appeared to work and did not.
- `anchor test` deploys before running scripts. Set
  `[provider] cluster = "localnet"` so the default is safe.
- The BPF loader requires a minimum 10240-byte program extension.
  `anchor-cli` 1.1.2's auto-extend requests only what is needed and fails.
  Fix: `solana program extend <program-id> 10240 --url devnet` first.
- Failed deploys strand buffer accounts holding real rent. One cost 1.06 SOL.
  Check `solana program show --buffers` after every failure.
- `cargo clean -p escrow` does not reach `target/sbpf-solana-solana`. A
  following `anchor build` re-derives `target/deploy/escrow.so` from the stale
  object and reports the release profile finished in 0.2 seconds. Delete the
  target triple directory to force a real compile (D101).
- `solana program extend` needs the real deficit, not the 10240 minimum. Two
  instructions grew to eleven and the account was 238000 bytes short.
- `anchor deploy` 1.1.2 writes the IDL to a metadata account in a second
  transaction after the upgrade. The upgrade succeeded and that write failed
  with "Failed to initialize IDL" at 2.44 SOL available, so it is not funding.
- `node --test <directory>` on Node 22 runs no files and reports a pass
  (tests 1, pass 1, fail 0). Name test files explicitly and check that the
  summary shows the expected test count.
- pnpm 11 hard-errors (`ERR_PNPM_IGNORED_BUILDS`) on unapproved dependency build
  scripts, and its pre-run deps check blocks every `pnpm run`, not just install.
  `@solana/web3.js` pulls `rpc-websockets@9.3.9`, which declares `bufferutil`
  and `utf-8-validate` as real optionalDependencies. Main is unaffected today
  only because those packages appear as optional-peer metadata under `ws` with
  no lockfile entries. Session 10 inherits the failure the moment web3.js lands
  in `apps/mobile` for real; `allowBuilds: false` for both is the correct
  deliberate answer then — optional C accelerators for ws with a pure-JS
  fallback, nothing needs them compiled.
- Workaround without touching workspace config: call binaries directly
  (`./node_modules/.bin/tsc`, `./node_modules/.bin/expo`) — pnpm's runner, and
  with it the build-approval gate, never engages.
- The two `minimumReleaseAgeExclude` entries in `pnpm-workspace.yaml` were
  written by pnpm, not chosen. Confirm later whether that was deliberate — a
  release-age guard that packages can edit themselves is not much of a guard.
  Note only; nothing acted on.
- The MWA spike harness (authorize / signMessages / signAndSendTransactions
  with raw-vs-decoded address logging) lives unmerged on branch `spike/mwa`;
  the matching ed25519 verifier is `apps/mobile/verify_mwa.mjs` on the same
  branch (noble 2.4.0, self-tested). Type-checks clean; dev-client APK builds
  in 6m30s via local Gradle; run on device 12 September — results below.
- MWA spike results (12 September): all three questions pass on Seeker with
  Seed Vault Wallet — Q1 authorize, Q2 signMessage verified independently
  against `@noble/curves` 2.4.0, Q3 signAndSendTransactions confirmed
  Finalized on devnet. Q1 and Q3 pass on Samsung A30 (SM_A305F, API 30) with
  Solflare; Q2 was not run on the A30 — the requester path needs authorize and
  transaction signing only.
- `authorize(chain)` does not set the wallet's active network. Seed Vault
  Wallet enforces its own network setting at transaction time and refuses with
  a "Network mismatch" dialog when the wallet is on mainnet and the transaction
  is devnet. Session 10 must detect the mismatch and say so plainly; a Scout
  hitting this in the field sees a refusal followed by an opaque app-side
  error.
- The MWA response can be lost while the wallet dialog is open. Reproduced on
  both wallets with different errors — TimeoutException on Seed Vault Wallet,
  CancellationException on Solflare. In both cases the wallet submitted
  successfully and the chain finalised the transaction while the app reported
  failure. No double submission occurred in either case: the abandoned
  attempts never reached the chain. This is the concrete case Session 15's
  reconciliation exists for — state must come from confirmations, never from
  the client result.
- Both wallets return addresses base64-encoded, decoding correctly to the
  expected base58 (checked against the wallet's own displayed address on the
  A30). `wallet_uri` is undefined on both. signMessages on Seed Vault Wallet
  returns a bare 64-byte signature, no payload wrapper.
- An app identity with no `uri` triggers an unrecognised-domain warning and a
  "trust this site" toggle in Seed Vault Wallet. Session 10 should supply a
  real identity — the same question as AUTH.md section 14.2's domain value.
- Mobile pulls `@noble/hashes` 1.8.0 while `apps/api` and `packages/shared`
  pin 2.4.0. Not a spike problem, but `packages/shared` is the only place
  hashing logic may live and mobile depends on it. Reconcile in Session 10.
- `anchor build` prints `Finished` yet leaves the IDL stale when the test crate
  fails to compile, because IDL generation compiles it. It leaves the program `.so`
  untouched when only tests change. Show both timestamps in any counted run.
- Anchor 1.1.2 validates accounts as `init` fields, then the duplicate-mutable-account
  check, then per-field constraints in declaration order. A test expecting a
  per-field error on an aliased mutable account gets
  `ConstraintDuplicateMutableAccount` instead (D87).
- Anchor's explicit-bump `seeds` check uses the stored bump with
  `create_program_address`; it does not re-derive the canonical bump. Store a bump
  only from `init`.
- litesvm 0.10.0 `add_program` records no upgrade authority. To test an
  upgrade-authority gate, overwrite ProgramData: the `Option` tag at offset 12, the
  key at 13 to 44.
- litesvm 0.10.0 runs precompiles only with its `precompiles` feature; without it the
  ed25519 program account is never loaded and no signature is ever checked.
- A precompile failure reaches litesvm as `InstructionError(index, Custom(n))`, n being
  the `PrecompileError` variant index: `InvalidSignature` 2, `InvalidInstructionDataSize` 4.
- Anchor CLI 1.1.2's program-ID check is a warning that reports only the first mismatch
  and continues building; one permanent mismatch can hide another.
- `[workspace] exclude` in Anchor.toml keeps a test program out of Anchor's build and key
  check; build it with `cargo build-sbf`, which writes to the same `target/deploy`.

---

## Remaining plan

Revised from the original four-week plan after the D10 positioning change.
Sessions 1 to 6, 7a and 7b complete; Session 8's escrow build complete, its capture nonce
issuance not built; Session 9 complete, specification and build. Session 10 discharged SPEC task
25 and deployed the escrow to devnet. Session 11 rehearsed and ran `initialize`, then took the
mobile sign-in scope Session 10 had planned; SGT verification left it for the eligibility-service
session. Every row from 10 onward therefore shifts by one against the numbering below.

### Week 1 remainder

| # | Scope |
|---|---|
| 5 | Part 1 (SPEC.md, five vectors) **done 10 Sep**. Part 2: implement to spec **done 11 Sep** |
| 6 | API — SIWS challenge/verify, JWT, user records **done 12 Sep** |
| 7 | API — policy creation, canonical JSON, policy hash, bounty CRUD |

### Week 2 — Mission engine

| # | Scope |
|---|---|
| 8 | Escrow — `accept`, `submit_attestation` **done 17 Sep**; capture nonce issuance open |
| 9 | Escrow — spec **done 17 Sep** (D92 to D98); build **done 18 Sep**, gate 140 at 68750b1 |
| 10 | Mobile — MWA sign-in, SIWS on device, SGT verification |
| 11 | Mobile — discovery, bounty detail, accept, assignment race test |
| 12 | Mobile — guided capture via c2pa-android |
| 13 | Mobile + API — Android key attestation, presigned upload, server-side hash verification |

### Week 3 — Settlement

| # | Scope |
|---|---|
| 14 | Verifier service — policy evaluation, assurance grading, signed attestation |
| 15 | Relayer, transaction reconciliation from confirmations |
| 16 | Requester review, review window, dispute with named requirement |
| 17 | Standalone independent verification script |
| 18 | Reputation counters, both-sided profiles |
| 19 | SKR — balance display, Seeker gating |

### Week 4 — Harden and ship

| # | Scope |
|---|---|
| 20 | Two-device end-to-end runs, bug triage |
| 21 | Error, empty and loading states, haptics, Reduce Motion |
| 22 | Safety — prohibited tasks, trespass notice, retention policy |
| 23 | Anti-fraud v0 — perceptual-hash duplicates, geo and time plausibility |
| 24 | dApp Store packaging — signed APK, publisher/app/release NFTs |
| 25 | Landing page, demo script, seeded demo bounties, pitch video |
| 26 | Freeze, security review, submit |

---

## Contingencies

~~**If Session 8 or 9 slips past day 14** — drop to a three-instruction escrow
(fund / release / refund) and move dispute entirely off-chain.~~ Replaced for Session 9 by
D98: if no committed build shows every Session 9 SPEC test passing by the end of 22 September,
Sydney time, Umair rules on this contingency before further build work. **Not triggered:**
68750b1 on 18 September shows `test_escrow` 139, escrow unit 2 and `cpi_caller` 1.

~~**If MWA misbehaves in Session 10** — stop everything. It blocks the whole
mobile path.~~ Answered 12 September (MWA spike): all three MWA questions pass
on device — see the spike results in the `solana-dev-notes` section above.

**If c2pa-android proves unworkable in Session 12** — fall back to A0–A1 plus
device attestation only, and reframe C2PA as designed-not-demonstrated. Weaker,
but the assurance ladder still holds.

---

## Verification gates

Four things where a false pass is not discovered until week four.

| Gate | Session | How to check |
|---|---|---|
| Escrow cannot be drained | 9 | **Passed 18 Sep**, 68750b1: tests 98, 100, 117, 121, 134 |
| Assignment cannot double-book | 12 | Two physical devices accept within a second; exactly one wins |
| Hash is reproducible | 17 | A standalone script reproduces the Merkle root byte-for-byte |
| Payout actually landed | 16 | Solana explorer, not the app UI |

---

## Naming

"ProofPay" sits next to ProPay, a payment processor founded in 1997, and a
"Proof & Pay" Shopify app. Not blocking for a hackathon submission, but a
trademark collision in the payments category worth resolving before it goes on
a slide. Repo is currently `bountycam`.
