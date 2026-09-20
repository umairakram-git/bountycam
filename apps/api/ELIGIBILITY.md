# `apps/api` — Eligibility Service Specification

**Path:** `apps/api/ELIGIBILITY.md`
**Status:** normative. Written before implementation.
**Scope:** voucher issuance for on-chain `accept` — the endpoint, the reservation, the
Seeker Genesis Token check, reservation expiry, and the one migration they require.
**Style:** per D31 — escape sequences described in words; no line over 100 characters.

On conflict: `SECURITY.md` wins (D50), then `programs/escrow/SPEC.md` for what the
program accepts, then `packages/shared/MESSAGES.md` for the byte layout, then this
document, then any implementation of it.

---

## 1. What this service is for

`accept` will not run without a voucher. The escrow verifies a designated ed25519
instruction against `config.eligibility_authority` and reconstructs the expected
message from its own state (SPEC.md sections 6 and 7.4). No voucher, no acceptance,
no end-to-end run. The program is deployed and its configuration is immutable, so
this is not negotiable.

A voucher asserts one thing: that the named Scout satisfied the bounty's committed
eligibility profile at the moment of issuance, and may accept that one bounty until
the stated expiry. It asserts nothing about the work, the evidence or the payout, and
it moves no funds (D68).

The service holds the eligibility key. That key is one of the four written immutably
into the configuration account on 19 September; it can authorise who may accept, and
nothing else. A compromise re-opens the claim griefing D68 closed and cannot move
USDC (SECURITY.md section 7).

---

## 2. The shape of the flow

1. A Scout, authenticated by SIWS (AUTH.md), requests a voucher for a bounty.
2. The service checks the bounty is acceptable and the Scout qualifies for its
   profile.
3. The service reserves the bounty for that Scout in the database.
4. The service builds the 212-byte `BOUNTYCAM_ELIGIBILITY_V1` message and signs it.
5. The Scout's client builds the ed25519 instruction and the `accept` instruction and
   submits both in one transaction, signed by the Scout's own wallet.
6. The chain decides. The database reservation decides who is issued a voucher; only
   the first confirmed `accept` wins (D68, D79).

Step 6 is the rule that makes step 3 safe to get wrong. A reservation is an
optimisation for Scout experience, never an authorisation.

---

## 3. `POST /bounties/:id/voucher`

Requires `Authorization: Bearer <JWT>` (AUTH.md section 9). No request body: the
bounty is the path parameter and the Scout is the authenticated wallet. A body is
ignored, not rejected — nothing in it could be trusted.

Success `200`:

| Field | Type | Meaning |
|---|---|---|
| `message` | string | base64 of the 212 signed bytes |
| `signature` | string | base64, exactly 64 bytes |
| `expires_at` | integer | the signed expiry, as a Unix second count |
| `authority` | string | base58 of the eligibility public key |

The client passes `expires_at` to `accept` as its argument and builds the ed25519
instruction from `message`, `signature` and `authority` in the canonical shape of
SPEC.md section 6.1. `authority` is returned so a client can check it against the
configuration account before signing; the program checks it regardless.

### 3.1 Where each field comes from

The message is built per MESSAGES.md sections 4 and 5. Sourcing is not a detail: a
field taken from the wrong place produces a message the program will not reconstruct,
and the failure surfaces on chain rather than here.

| Field | Source |
|---|---|
| `domain_tag`, `schema_version`, `program_id` | compiled constants |
| `deployment_id` | the configuration account, read once at startup |
| `bounty_id`, `requester`, `policy_hash` | the on-chain bounty account |
| `eligibility_profile_hash`, `required_assurance` | the on-chain bounty account |
| `scout` | the authenticated wallet of the requesting Scout |
| `expires_at` | computed by this service (section 4) |

**State comes from the chain, not the database.** The bounty account is the authority
for every state field the program reconstructs from. A voucher built from a stale
read-model row would verify here and fail at `accept` with
`VerificationMessageMismatch`, which is safe and useless. One account read at
`confirmed` costs far less than the section 6 check that may follow it.

The database projection must agree with what was read. A disagreement on any binding
register row (POLICY.md section 2.6) returns `BINDING_MISMATCH` and is a reconciler
alarm: a bounty whose policy and chain state disagree is not acceptable by anyone.

---

## 4. Check order

Normative. The first failing check reports its error and nothing is written. Cheap
checks precede expensive ones, and the reservation is taken only once the Scout is
known to qualify.

1. **Auth.** The middleware. 401 per AUTH.md section 7.
2. **Bounty exists** and is visible to this caller. Else `NOT_FOUND` (404).
3. **Scout is not the requester.** Else `SCOUT_IS_REQUESTER` (403). The program
   checks this too (SPEC.md 7.4 check 3); checking here turns an on-chain failure
   into a readable one.
4. **Read the bounty account** from the chain at `confirmed`. Unreachable:
   `CHAIN_UNAVAILABLE` (503).
5. **On-chain state is `Funded`.** Else `BOUNTY_NOT_ACCEPTABLE` (409).
6. **Acceptance window is open** — the app clock is at or before
   `acceptance_cutoff`. Else `ACCEPTANCE_WINDOW_CLOSED` (409).
7. **Bindings agree** (POLICY.md section 2.6). Else `BINDING_MISMATCH` (409).
8. **Profile qualification** (section 5). Failures carry their own codes.
9. **Reservation** (section 6). Lost race: `BOUNTY_RESERVED` (409).
10. **Sign and respond** 200.

Check 3 before check 4 is deliberate: a requester asking for a voucher on their own
bounty is a client bug, and it should not cost an RPC round trip to say so.

### 4.1 The expiry

`expires_at` is the earlier of two instants:

- the app clock plus **300 seconds**;
- the bounty's on-chain `acceptance_cutoff`.

Five minutes is the SIWS challenge lifetime (AUTH.md section 8). One short-lived
duration in the codebase rather than two is worth more than tuning each separately,
and the figure is right for the same reason: long enough to sign and submit on a poor
connection, short enough that an abandoned attempt frees the bounty quickly.

The cutoff clamp matters because the program checks both. `accept` rejects a voucher
past `expires_at` with `VoucherExpired` and rejects a late acceptance with
`AcceptanceWindowClosed` (SPEC.md 7.4 checks 2 and 6). Issuing a voucher outliving
the window would hand a Scout something that cannot work, and the clamp makes the
voucher's own expiry the single thing a client must watch.

The reservation (section 6) expires at the same instant. A reservation outliving its
voucher holds a bounty nobody can accept; a voucher outliving its reservation lets
two Scouts hold live vouchers at once, which the chain resolves but the marketplace
should not create.

All timestamps come from the one injectable clock (AUTH.md section 8). No check in
this document compares against the database's own current time.

---

## 5. Profile qualification

The bounty's `eligibility_profile_id` names a registry entry (POLICY.md section 2.5).
Both entries require the same base, and one requires more.

**Base, both profiles.** The caller's wallet is SIWS-proved — which the bearer token
already establishes, since a token is issued only on a verified signature — and the
`users` row for that wallet has status `ACTIVE`. A non-`ACTIVE` row returns
`ACCOUNT_NOT_ACTIVE` (403).

That is the whole of `BASE_V1`. No completion history is required, and D107 gives the
reason: no bounty has ever completed, so any positive minimum makes the first bounty
unacceptable by anyone.

**`A4_SEEKER_V1` adds the Seeker check** of section 5.1.

The profile is read from the chain — the bounty account carries
`eligibility_profile_hash`, and the service maps it back to an id through the
registry. A hash matching no registry entry returns `PROFILE_UNKNOWN` (409): a bounty
was funded naming a profile this service does not implement, which is a deployment
mismatch, not a Scout's problem.

### 5.1 The Seeker Genesis Token check

Sourced from Solana Mobile's developer documentation, fetched 20 September, not from
memory. Their marketing pages describe the token as soulbound and non-transferable;
the developer documentation says it moves when a user changes their primary account
in the Seed Vault Wallet, and that its mint address is unchanged by the move. **The
developer documentation governs.** Anything built on the soulbound reading is wrong.

Key addresses, from that documentation:

| Value | Address |
|---|---|
| mint authority | `GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4` |
| metadata address | `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` |
| group address | `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` |

The metadata and group addresses are deliberately the same value.

A wallet holds a Seeker Genesis Token when it holds a Token-2022 mint whose mint
authority is the address above, whose metadata pointer names both that authority and
the metadata address, and whose token group member names the group address. All three
must hold. The check returns the **mint address**, not a boolean, because section 5.2
needs it.

**Zero-balance accounts do not count.** Transferring the token out leaves the old
token account open at a balance of zero, so a wallet that once held one keeps
returning that account forever. Only a non-zero balance is current ownership. The
documentation calls this out, and a check that misses it admits every wallet that
ever held a Seeker.

### 5.2 One device, one account

Because the token moves, holding one proves a Seeker exists — not that this Scout has
their own. Without a further rule, one phone qualifies unlimited wallets in turn.
Solana Mobile's documentation names this and gives the mechanism: record the mint
address and refuse a second claim on it.

A `seeker_devices` table (section 8) maps the mint address to the first `users.id`
that claimed it. The claim is taken inside the section 6 transaction:

- no row for that mint: insert it against this user;
- a row against this user: proceed;
- a row against a different user: `SEEKER_ALREADY_CLAIMED` (403).

The unique constraint on the mint is what enforces it. Two concurrent requests
claiming the same token resolve to exactly one insert and one code, in the database,
never in application logic (SECURITY.md section 10).

**There is no release.** A device claimed by one account stays claimed. Releasing it
would restore exactly the multi-account path the rule exists to close, and a support
process for genuine resale is a product decision, not a runtime one. Stated as a
limit rather than hidden: a second-hand Seeker whose previous owner used BountyCam
cannot qualify its new owner. Revisit only with a D-entry.

### 5.3 Failure, caching and the third-party dependency

**An outage is never a refusal.** If the Seeker check cannot complete — the RPC is
unreachable, the request times out, the response does not parse — the endpoint
returns `SEEKER_CHECK_UNAVAILABLE` (503) and writes nothing. It never returns "no
Seeker". Telling a Seeker owner they do not own a Seeker because a third party is
down is the worst failure available here, and the documentation says so too.

A wallet that completes the check and holds nothing qualifying gets
`SEEKER_NOT_HELD` (403). That is a different situation from the paragraph above and
carries a different code, because a Scout who is told "you don't have one" when the
truth is "we couldn't look" has been told something false.

**Results are cached for 24 hours** per wallet, storing the verified mint address and
the time of the check. The check is several round trips — a paginated walk of every
Token-2022 account the wallet holds, then a batched fetch of each mint — and it sits
on a path where Scouts are racing each other. A cache hit skips the RPC entirely; the
section 5.2 claim still runs on every request, from the database.

**The dependency is Helius.** The documented method, `getTokenAccountsByOwnerV2`, is
a Helius extension rather than a standard Solana RPC call, so this introduces a
third-party account and an API key on the authentication path. The key lives in the
environment file outside the repo, is never logged, and is read once at startup. A
missing key is a startup failure, not a runtime 503: a service that cannot perform a
check it advertises should not accept traffic.

Tokens live on mainnet while the escrow is on devnet. Two RPC endpoints, two
purposes, and the Seeker endpoint is never used for chain state.

---

## 6. The reservation

A reservation is an `assignments` row with status `ACTIVE`. Session 3's unique
partial index already enforces at most one per bounty, and that index is the
mechanism: two Scouts requesting a voucher within the same millisecond resolve to one
insert and one `BOUNTY_RESERVED` (409), decided by the database (SECURITY.md section
10, D79).

Taken after qualification, not before. Reserving first would let an ineligible Scout
hold a bounty while their Seeker check runs, blocking an eligible one for seconds.
The cost is that a Scout who loses the race has paid for a check they did not need.
That is the right side to lose on: a wasted check costs one caller some latency, a
wrongly held reservation costs the marketplace a bounty.

One transaction covers the reservation, the section 5.2 device claim and nothing
else. Signing happens outside it — a signature is not a database concern, and holding
a transaction open across it would hold row locks for no reason.

An existing `ACTIVE` reservation held by **this** Scout is not a failure. The
endpoint is idempotent within the reservation's life: it returns a fresh voucher
against the same reservation, with a fresh expiry, and does not extend the
reservation. A Scout who lost their first response to a dropped connection asks
again and gets one.

### 6.1 Expiry mechanics

POLICY.md section 7.3 defines a reservation as expired when its row no longer holds
`ACTIVE`, and leaves three things undecided: the clock the flip reads, what performs
it, and the lag bound. All three are settled here.

**The clock** is the one injectable clock (AUTH.md section 8), the same one issuance
reads. A reservation's `expires_at` is written at insert, equal to the voucher's
expiry (section 4.1). Nothing compares against the database's own current time.

**Two writers, both required.** A sweeper flips expired rows out of `ACTIVE` every
**30 seconds**. Any voucher request for a bounty also flips that bounty's expired
reservation before attempting its own insert.

Neither alone is enough, and the reason is worth stating because it is not obvious.
Opportunistic flipping alone deadlocks: discovery hides a bounty whose reservation is
`ACTIVE` (POLICY.md section 7.3), so no Scout sees it, so no request arrives to
trigger the flip, so the bounty is invisible until its acceptance window closes. A
sweeper alone is correct but leaves a bounty invisible for up to the sweep interval
after it is genuinely free.

**The lag bound is 60 seconds** — twice the interval, so one missed run does not
breach it. Exceeding it is an operational alarm, not a correctness failure: a stale
`ACTIVE` row makes a bounty temporarily invisible, never wrongly acceptable. The
chain decides acceptance and does not read this table.

The sweep is idempotent and its interval carries no correctness weight. Changing it
is configuration.

---

## 7. Error codes

One code per distinct failure; every code is returnable and has at least one test
(D34). Responses are `{ "error": "<CODE>" }`.

| Code | Status | Failure |
|---|---|---|
| `NOT_FOUND` | 404 | no bounty visible to the caller at that id |
| `SCOUT_IS_REQUESTER` | 403 | the caller is the bounty's requester |
| `ACCOUNT_NOT_ACTIVE` | 403 | the caller's `users` row is not `ACTIVE` |
| `SEEKER_NOT_HELD` | 403 | the check completed; the wallet holds no qualifying token |
| `SEEKER_ALREADY_CLAIMED` | 403 | that token is claimed by a different account |
| `BOUNTY_NOT_ACCEPTABLE` | 409 | on-chain state is not `Funded` |
| `ACCEPTANCE_WINDOW_CLOSED` | 409 | the app clock is past `acceptance_cutoff` |
| `BINDING_MISMATCH` | 409 | policy and chain disagree (POLICY.md section 2.6) |
| `PROFILE_UNKNOWN` | 409 | the bounty's profile hash matches no registry entry |
| `BOUNTY_RESERVED` | 409 | another Scout holds a live reservation |
| `SEEKER_CHECK_UNAVAILABLE` | 503 | the Seeker check could not be performed |
| `CHAIN_UNAVAILABLE` | 503 | the bounty account could not be read |

The three 403s about Seekers are deliberately distinct. "You do not hold one", "that
one belongs to another account" and "we could not look" are three different
situations, and a Scout can act on each differently.

`PROFILE_UNKNOWN` is reused from POLICY.md section 2.3 with the same meaning — an id
outside the registry — reached by a different route: there at creation from the
request, here at issuance from the chain.

---

## 8. Migration 8 — reservations and device claims

Up, two changes.

On `assignments`, add `expires_at timestamptz NOT NULL`. Every reservation carries
the instant it stops being `ACTIVE` (section 6.1). The existing unique partial index
on `ACTIVE` rows is unchanged and remains the race mechanism.

Also on `assignments`, drop NOT NULL from `challenge_nonce` and `deadline` (D111) and
from `accepted_at` (D113). Session 3 shaped that table as an acceptance, and all three
columns are acceptance-time facts: the mission deadline is computed from the policy
windows once the chain confirms `accept`, the capture nonce belongs to an accepted
assignment, and `accepted_at` is the instant of that confirmation. A reservation
precedes all three, so none of the values exists when the row is inserted; all three
are written together when the on-chain acceptance is observed. The unique constraint
on `challenge_nonce` is unchanged — Postgres admits many NULLs under it, so every real
nonce is still bound.

Create `seeker_devices`:

| Column | Type | Constraint |
|---|---|---|
| `sgt_mint` | text | primary key — the token's mint address, base58 |
| `user_id` | uuid | not null, references `users(id)` |
| `claimed_at` | timestamptz | not null |

The primary key is the whole rule of section 5.2. One row per device, first claim
wins, enforced by the database rather than by application logic.

Down: drop `seeker_devices`; drop `assignments.expires_at`; restore NOT NULL on
`challenge_nonce`, `deadline` and `accepted_at`. Subject to POLICY.md section 11.4 —
re-adding a NOT NULL column without a default fails once a row exists, and so does
restoring a NOT NULL constraint over a column holding NULLs, so the rollback is valid
only against empty tables.

The Seeker result cache (section 5.3) is not a migration. It is process-local with a
24-hour entry life, lost on restart, and a cold cache costs one extra RPC walk. A
shared cache is a scaling decision, not a correctness one.

---

## 9. Tests

**Expected count: 24.** Per D36 a run is evidence only if the summary reports exactly
24. Tests inject the controlled clock; none sleeps to reach an expiry. The Seeker RPC
is a double in every test — no test calls a third party.

Issuance:

1. Success on `BASE_V1`: 200; the message decodes to 212 bytes; every field matches
   the bounty account read; the signature verifies under the configured eligibility
   key with `@noble/curves` 2.4.0.
2. The returned `expires_at` equals the app clock plus 300 when the cutoff is later.
3. The returned `expires_at` equals `acceptance_cutoff` when the cutoff is sooner.
4. The reservation's `expires_at` equals the voucher's.
5. Success on `A4_SEEKER_V1` with the Seeker double returning a mint.
6. No body required: a request with an arbitrary JSON body still succeeds.

Check order, one per code:

7. No token — 401 per AUTH.md.
8. Unknown bounty id — `NOT_FOUND`.
9. Requester requesting their own bounty — `SCOUT_IS_REQUESTER`, with no chain read
   performed.
10. `users` row not `ACTIVE` — `ACCOUNT_NOT_ACTIVE`.
11. Chain read fails — `CHAIN_UNAVAILABLE`.
12. On-chain state `Accepted` — `BOUNTY_NOT_ACCEPTABLE`.
13. Clock past `acceptance_cutoff` — `ACCEPTANCE_WINDOW_CLOSED`.
14. Profile hash on chain differs from the projection — `BINDING_MISMATCH`.
15. Profile hash matching no registry entry — `PROFILE_UNKNOWN`.

Seeker:

16. Check completes, no qualifying mint — `SEEKER_NOT_HELD`.
17. Check throws — `SEEKER_CHECK_UNAVAILABLE`, and no reservation is written.
18. A mint held by another user — `SEEKER_ALREADY_CLAIMED`.
19. A mint already claimed by this same user — success.
20. A token account at zero balance is ignored: a wallet holding only a zero-balance
    qualifying mint gets `SEEKER_NOT_HELD`.
21. A mint with the right authority but the wrong group — `SEEKER_NOT_HELD`.

Reservation:

22. Two concurrent requests from different Scouts, issued with `Promise.all`:
    exactly one 200 and one `BOUNTY_RESERVED`; exactly one `ACTIVE` row. Required by
    SECURITY.md section 10 — the unique partial index is the mechanism under test.
23. A second request from the Scout holding the reservation returns a fresh voucher
    with a later expiry, and the reservation's own `expires_at` is unchanged.
24. Clock advanced past a reservation's `expires_at`: a different Scout's request
    succeeds, flipping the stale row out of `ACTIVE` before inserting its own.

Non-test gates, verified from raw output and not part of the count: migration 8 up,
down and up against a scratch database; the section 5.1 addresses byte-compared
against the fetched documentation, not retyped.

---

## 10. Accepted limits

Stated, not hidden. Each is a deliberate MVP position.

**No rate limiting.** A caller can request vouchers as fast as they like. The
reservation bounds the damage to one bounty at a time, and the Seeker cache bounds
the third-party cost. Accepted for devnet, on the same footing as AUTH.md's D47.

**A claimed Seeker is claimed forever** (section 5.2). A resold device cannot qualify
its new owner. Releasing it would reopen the multi-account path the rule closes.

**The cache can serve a stale yes.** A Scout who sells their Seeker keeps qualifying
for up to 24 hours. The device claim still holds, so the buyer cannot qualify in that
window either; the exposure is one stale acceptance by the seller, which the evidence
policy and the assurance ladder still govern.

**The service is a trusted party and is listed as one.** It can authorise who may
accept, for one bounty, until an expiry. It cannot move funds, change a reward, set a
policy, accept on a Scout's behalf, or act as attester, relayer or arbiter
(SECURITY.md section 2). A compromise reopens claim griefing and costs no USDC.

**Mainnet is a configuration change, not a code change**, for the escrow side. The
Seeker check is already on mainnet and does not move.

**The voucher is not an assignment.** It authorises an attempt. The chain decides,
and a Scout holding a valid voucher whose bounty was accepted by someone else sees
`BountyNotAcceptable` from the program. The client must say so plainly rather than
reporting a failure the Scout cannot act on.
