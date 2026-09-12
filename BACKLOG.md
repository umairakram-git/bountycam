# BountyCam — Backlog

**As at:** 12 September 2026 · 26 days to deadline

---

## Second device — resolved 12 September

Samsung A30, API 30; devnet wallet funded and verified from the chain. Nothing
blocking remains for the Session 11 two-device race gate.

Worth not rediscovering: **Solflare is the working wallet on that handset.**
Phantom's devnet balance display is unreliable there — use Solflare for the
requester side.

---

## Open findings from completed sessions

**`Cancelled` enum variant is unreachable.** `cancel` closes the account rather
than setting state, so the variant can never be observed. Either drop it, or
set state before closing so an indexer can see the terminal state.
Recommendation: drop. Dead state variants in an escrow mislead whoever adds
`dispute` later.

**`UnauthorizedRequester` is overloaded.** It fires both for "you are not the
requester" and for "this token account is not yours". A client cannot
distinguish them. Add a distinct error for token-account ownership — error
codes are the API surface the mobile app reads.

**`SPEC.md` for the escrow was written after implementation.** It documents
what was built rather than constraining it, and recorded the invented fee
constant as though intended. Reconcile against the original Session 4 prompt.

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

**DB `bounty_state` vs program state enums to reconcile.** The database
enum and the on-chain state machine must not drift; reconcile when the
escrow state instructions land (Session 9).

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
- Canonical-file drift: HANDOFF/DECISIONS/BACKLOG exist both in the repo
  and in Claude project knowledge. The repo is the single source; project
  knowledge is uploaded from the repo at session close, never the reverse.

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
  in 6m30s via local Gradle; no question ever ran on a device.

---

## Remaining plan

Revised from the original four-week plan after the D10 positioning change.
Sessions 1–5 complete.

### Week 1 remainder

| # | Scope |
|---|---|
| 5 | Part 1 (SPEC.md, five vectors) **done 10 Sep**. Part 2: implement to spec **done 11 Sep** |
| 6 | API — SIWS challenge/verify, JWT, user records **done 12 Sep** |
| 7 | API — policy creation, canonical JSON, policy hash, bounty CRUD |

### Week 2 — Mission engine

| # | Scope |
|---|---|
| 8 | Escrow — `accept`, `submit_attestation`, challenge nonce issuance |
| 9 | Escrow — `approve`, `reject`, `resolve`, `expire`, challenge window |
| 10 | Mobile — MWA sign-in, SIWS on device, SGT verification |
| 11 | Mobile — discovery, bounty detail, accept, assignment race test |
| 12 | Mobile — guided capture via c2pa-android |
| 13 | Mobile + API — Android key attestation, presigned upload, server-side hash verification |

### Week 3 — Settlement

| # | Scope |
|---|---|
| 14 | Verifier service — policy evaluation, assurance grading, signed attestation |
| 15 | Relayer, transaction reconciliation from confirmations |
| 16 | Requester review, challenge window, dispute with named requirement |
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

**If Session 8 or 9 slips past day 14** — drop to a three-instruction escrow
(fund / release / refund) and move dispute entirely off-chain.

**If MWA misbehaves in Session 10** — stop everything. It blocks the whole
mobile path.

**If c2pa-android proves unworkable in Session 12** — fall back to A0–A1 plus
device attestation only, and reframe C2PA as designed-not-demonstrated. Weaker,
but the assurance ladder still holds.

---

## Verification gates

Four things where a false pass is not discovered until week four.

| Gate | Session | How to check |
|---|---|---|
| Escrow cannot be drained | 9 | Negative tests: wrong signer approves, wrong scout claims, double-approve |
| Assignment cannot double-book | 11 | Two physical devices accept within a second; exactly one wins |
| Hash is reproducible | 17 | A standalone script reproduces the Merkle root byte-for-byte |
| Payout actually landed | 16 | Solana explorer, not the app UI |

---

## Naming

"ProofPay" sits next to ProPay, a payment processor founded in 1997, and a
"Proof & Pay" Shopify app. Not blocking for a hackathon submission, but a
trademark collision in the payments category worth resolving before it goes on
a slide. Repo is currently `bountycam`.
