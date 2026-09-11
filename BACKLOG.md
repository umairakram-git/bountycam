# BountyCam — Backlog

**As at:** 11 September 2026 · 27 days to deadline

---

## Blocking

**Second Android device.** Needed by Session 11 at the latest (assignment
race gate requires two physical devices). Verify the second device's wallet
before then. The demo is a two-party
transaction between two phones and there is currently one. The requester side
is light — wallet, funding transaction, review screen. No camera, GPS or
attestation. Options:

1. Any second physical Android at API 28+ — cleanest, a cheap handset suffices
2. Emulator for the requester only — viable since no sensors are needed, but
   wallet apps in emulators are historically unreliable. Test early.
3. Web requester via wallet adapter — removes the problem entirely, but weakens
   the two-phone story

Recommendation: 1 if obtainable, 3 if not. Option 2 is the one that quietly
consumes a session in week three.

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

**`apps/api` test script uses an unquoted glob** — `node --test test/*.test.ts`.
Verify in Session 6, from raw output, what it does when zero files match, before
trusting any pass from it (see D36 for the false-pass class this guards against).

**`typescript` and `@types/node` use caret ranges** in `packages/shared`
devDependencies. Exact-pin them — the D19 pattern: caret semantics silently
resolved `anchor-lang` to a version the CLI did not match.

---

## Outstanding from Session 5 part 1

- ~~Implement the three functions to SPEC.md; the five vectors are the test
  suite, and the spec wins over any implementation on disagreement.~~
  Done 11 September (Session 5 part 2) — 66 conformance tests passing.
- ~~Stub JSDoc in `packages/shared/src/index.ts` claims all numbers serialise
  as strings — contradicts SPEC.md §1.3. Fix during implementation.~~
  Done 11 September (Session 5 part 2).
- The GPS 7-decimal-place profile is normative for producers but unenforced
  by `canonicalise`. Decide where the check lives when policy creation is
  built (Session 7).
- Any Rust implementation (Session 17 standalone verifier) must sort keys
  by UTF-16 code units, not bytes. Flagged in SPEC.md; easy to miss.
- Canonical-file drift: HANDOFF/DECISIONS/BACKLOG exist both in the repo
  and in Claude project knowledge. The repo is the single source; project
  knowledge is uploaded from the repo at session close, never the reverse.

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

---

## Remaining plan

Revised from the original four-week plan after the D10 positioning change.
Sessions 1–5 complete.

### Week 1 remainder

| # | Scope |
|---|---|
| 5 | Part 1 (SPEC.md, five vectors) **done 10 Sep**. Part 2: implement to spec **done 11 Sep** |
| 6 | API — SIWS challenge/verify, JWT, user records |
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
