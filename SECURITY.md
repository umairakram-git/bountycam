# BountyCam — Security, Scalability and Speed Invariants

**Status:** binding on every session. Read before touching the escrow program, auth,
the verifier, canonical serialisation, evidence storage, or any key.
**Companion:** `SECURITY-PRODUCTION.md` holds the gates that must be met before any
mainnet plan. It is read before mainnet planning, not before every session.
**Change control:** adding, weakening or removing a rule here is a decision. Record it
in DECISIONS.md with the reason. Never edit a rule in place without a D-entry.
**Style:** per D31 — no line over 100 characters; escape sequences described in words.

These are invariants, not suggestions. If a requested feature conflicts with one, stop
and name the conflict. Do not weaken the invariant, add a bypass, or rely on a higher
layer to hide an unsafe lower-layer capability.

Assume an attacker can call the program directly, build their own transaction, modify
API requests, replay old messages, supply arbitrary account addresses, and read all
public code.

---

## 0. Principles

**Fail closed.** An unexpected state, account, mint, signer, program, token account,
policy version, attestation format, or authentication input is rejected. Never
"continue with a default" for security-sensitive data.

**Lowest layer enforces.** A property is enforced at the lowest layer able to enforce it.
Never rely on: the UI hiding a button; the API refusing a request; the database holding
the expected value; the relayer behaving; the user running the official client;
simulation succeeding; an RPC response; or a coding agent saying something is secure.

**Least authority.** Compromise of any single component must not move money:
attester alone, relayer alone, API alone, database alone.

**No hidden trust.** Every trusted party and every key that can affect money, evidence,
authentication or deployed code is documented in section 2 and section 7.

**Chain-enforced financial truth.** The program is the source of truth for escrow
balance, financial state, payout identities, terminal state, and every condition that
authorises moving escrowed funds. A database row never constitutes proof that an
on-chain transition occurred. The database is authoritative only for product data that
does not independently authorise moving money.

---

## 1. Resolved contradiction — acceptance and cancellation (D49)

D1 kept acceptance off-chain. The trust model says the requester cannot cancel after
acceptance. Both could not hold: if acceptance exists only in the database, the program
cannot know a Scout accepted, and a requester who calls `cancel` directly strands the
Scout mid-mission.

Resolved by D49, which supersedes the second half of D1: acceptance moves on-chain.
Session 8 adds an `accept` instruction that moves zero USDC and records the Scout;
`cancel` is rejected from ACCEPTED onward. D68 and D79 supersede the race rule: a
database reservation decides which Scout is issued an eligibility voucher, but the chain
is final — only the first confirmed on-chain `accept` succeeds, and a database winner
never overrides a different on-chain winner.

---

## 2. Trust model — who is trusted for exactly what

**Requester** — wallet signature.
May: fund; approve a submitted bounty; reject a submitted bounty within its review window,
naming the failing requirement, which moves it to `DISPUTED` for the arbiter (D93); cancel
only in states where the program permits it.
May not: choose a payout destination; change the Scout after assignment; redirect escrow
to a third party; bypass terminal states.

**Scout** — wallet signature.
May: accept per the assignment rules; submit evidence; sign the evidence commitment.
May not: change the requester; substitute a payout wallet after assignment; claim funds
because the database says the task is done or because an attestation exists.

**Attester** — dedicated key held in the program configuration account, never named in
the policy, never per-bounty and never caller-supplied (D82, D83, amending D11). Bounties
do not snapshot it; the currently configured key governs at submission.
May: attest that a specific policy was met at a specific level for a specific bounty.
May not: choose the recipient; change the reward or the bounty; refund; release escrow.
An attestation is evidence for a payout decision, not authority to move funds.

**Eligibility service** — dedicated key, program-level (D68).
May: attest that a named Scout satisfies a bounty's precommitted off-chain
eligibility requirements, for one bounty, until a stated expiry.
May not: move funds; change the reward, requester, Scout after assignment, evidence
policy or assurance level; set or alter the committed policy; accept on a Scout's
behalf; act as attester, relayer or arbiter.

**Capture nonce service** — trusted for freshness issuance (D73).
May: issue short-lived unpredictable capture nonces to the currently assigned Scout.
May not: move funds; change bounty policy; determine assurance; sign the evidence
attestation. If compromised or colluding with a Scout it can weaken freshness by
issuing earlier than represented, so A1 freshness can no longer be trusted; the
attester and the on-chain settlement rules retain their separate authorities.
It also receives the Scout's start fix with each request (`apps/api/POLICY.md` section
17.5) and stores it on the nonce row, where no view, response or log reads it (D133).

**Relayer** — trusted for liveness only (D2).
May: pay fees; submit already-authorised transactions; submit the permissionless `release`,
`expire_unaccepted` and `expire_accepted` instructions (D92, D95).
May not: act as any other authority; choose accounts; alter instruction data; move USDC
other than through those instructions, which fix every account, amount, destination and
timing from stored state.
Any other fee payer may submit the same three instructions under the same limits; doing so
requires no trust. Every money-moving instruction must remain safe if the relayer, or any
fee payer, is malicious.

**Arbiter** — dedicated protocol-level administrative key, held as program or config
state, never per-bounty and never caller-supplied (D9, D74).
May: resolve a bounty only while it is on-chain `DISPUTED`, and only when the arbiter is
neither its requester nor its Scout, choosing one of two outcomes: the vault's entire
balance to the stored Scout's payout account, or to the requester's associated token
account (D94).
May not: create recipients; change amounts; create, fund, accept or submit evidence;
alter bounty policy; act outside the dispute state. Materially more privileged than
the eligibility service and separately keyed for that reason: eligibility authorises
who may accept work, the arbiter releases locked funds to one side of a dispute.

**API server** — server secret.
May: issue sessions after wallet authentication; store SIWS challenges (D72); gate
evidence access; hold workflow metadata.
May not: hold user keys; sign requester or Scout transactions; hold token spending
authority; manufacture an attestation; determine an on-chain payout destination.

**Database** — constraints, not convention.
May enforce: nonce uniqueness; single active assignment; structured rejection; evidence
authorisation relationships; retention state.
May not be trusted as proof that USDC was funded, released or refunded, that a state
transition happened, or that a wallet signed anything. For those, verify the chain or
the signature.

---

## 3. Wallet-drain prevention — highest-priority client invariant

The most dangerous moment in the app is when it asks a user to sign.

- Never request general spending authority: no SPL token delegation, no `Approve`, no
  `SetAuthority`, no mint, freeze, owner or permanent-delegate authority, no custody.
  Funding transfers exactly the bounty amount into the program-controlled escrow.
- Never pass an opaque serialised transaction from the API, a database row, a URL, a QR
  code, a third-party SDK, bounty content or evidence metadata to the wallet. Money
  transactions come only from BountyCam's own typed builders.
- Before requesting a signature, validate the complete transaction against an
  allowlist: BountyCam program instructions, required Compute Budget instructions,
  required Associated Token Program operations, expected SPL Token operations. Anything
  else fails closed. Address Lookup Tables are unsupported until a reviewed design needs
  them; if introduced, resolve every address before inspection.
- Reject any wallet transaction containing `Approve`, `ApproveChecked`, `SetAuthority`,
  `Burn`, `BurnChecked`, unrelated `CloseAccount`, minting, or delegate changes. A
  funding transaction never contains unrelated SOL or token transfers.
- Show a human-readable summary derived from the exact transaction (bounty id, amount,
  destination, "no spending permission granted"). The summary is not a security
  boundary; it helps users spot substitution.
- After validation, no untrusted component may add, remove or replace instructions.
  If the relayer adds fee data, the final transaction is validated again.
- Simulation is not authorisation and is not proof a transaction is safe.

---

## 4. Wallet authentication is separate from transaction authorisation

Authentication signatures and transaction signatures are different security domains.
Never reuse one for the other.

Login uses Sign In With Solana. The normative format, check order, error codes and test
list are in `apps/api/AUTH.md` (D37–D48). The message carries: domain, wallet address,
a human-readable statement, version, cluster, random nonce, issued-at, expiry. The
statement tells the user what the signature does and does not authorise.

The server verifies the exact bytes signed, the signature, the wallet, the domain, the
cluster, the nonce (single-use, consumed atomically in the database), and the time
window. Two concurrent verifies with the same nonce yield exactly one success.

A signature captured for authentication must never verify as an attestation, an
acceptance, an evidence submission, a payout approval, or an on-chain authorisation.

---

## 5. Signed-object domain separation

Every non-transaction signature identifies what it authorises. Never sign ambiguous
JSON. Every signed object carries a versioned domain tag: a binary layout at offset 0, a
canonical JSON object as its required `domain_tag` key (D141). `BOUNTYCAM_EVIDENCE_V1`
is canonical JSON, signed off-chain (`packages/shared/SPEC.md` section 11.6);
`BOUNTYCAM_ATTESTATION_V1` and
`BOUNTYCAM_ELIGIBILITY_V1` are fixed binary layouts verified on-chain (D70).
`BOUNTYCAM_ACCEPTANCE_V1` is retired: D49's acceptance-signature concept is
superseded by D68's eligibility voucher, which the Scout's own transaction
signature accompanies.
Authentication is exempt: SIWS carries its own separation (domain line plus statement).

A signature for one domain fails verification in every other domain.

Canonical JSON has a single implementation, in `packages/shared` (SPEC.md), and is
used off-chain only. No route, client, test helper or attester service keeps an
alternative implementation. On-chain signed security messages use separately
specified fixed binary layouts with their own domain tags and schema versions
(D70); the program neither serialises nor parses canonical JSON. Golden vectors
verify every producer against every verifier, for both forms.

Independent verification tooling is intentionally exempt from the
implementation-sharing rule (D78). A standalone verifier may implement the
normative serialisation and Merkle specifications independently, in a different
language where practical, for the purpose of demonstrating reproducibility and
detecting specification-implementation divergence. It must never sign, attest,
authorise, settle, feed values back into the program, or form part of the mobile
app's normal operation — a verifier that becomes a runtime dependency is a second
production implementation on the money path. Both implementations are bound by the
same immutable vectors. The normative specification, not either implementation, is
authoritative, and neither is authoritative merely because it existed first. A
disagreement the specification does not resolve is a specification gap: clarify the
rule, add a vector, update whichever implementations fail it.

---

## 6. Attestation binds everything that matters

An attestation must not merely say "policy X passed at level N". It commits to:
domain and version; deployment identifier, in place of a cluster string (D70); program
ID; bounty id; requester wallet; assigned Scout wallet; evidence bundle commitment;
policy hash, whose preimage carries the policy version; eligibility profile hash;
required assurance level; submission deadline; review window; achieved assurance level;
issuance time (D77, D81). The exact layout is `packages/shared/MESSAGES.md`.
There is no expiry field: validity is bounded by bounty state, the deadline and the
currently configured attester (D82). The attester key id is the verifying public key in
the ed25519 instruction, recorded permanently with the transaction; the signed bytes do
not repeat it because settlement verifies only against the configured key (D82).

The program never accepts `attestation_valid = true` from the API. If an attestation
affects an on-chain decision, its verification is enforced on-chain. The program
compares the bounty's `required_assurance` against the level in the verified
attestation (D17). The database can never replace the Scout wallet at payout time.

---

## 7. Keys — development inventory

All under `~/bountycam-keys/`, mode 600, outside the repo. Production custody rules
are in `SECURITY-PRODUCTION.md` section 1.

- **upgrade-authority** — deploy and upgrade. Leak: attacker replaces the program.
- **attester** — sign attestations. Leak: any evidence passes; a submitted bounty pays
  its assigned Scout unless the requester rejects within the review window, so a Scout
  colluding with the key holder is paid without real work whenever the requester stays
  silent (D85, D92, D93). After a rejection the arbiter decides.
- **eligibility** — sign acceptance vouchers (D68); not yet generated, owed before
  `initialize` (D83). Leak: any wallet can be authorised to accept, re-opening the
  claim griefing D68 closed and bypassing eligibility profiles; USDC cannot move.
- **arbiter** — resolve disputes (D74); not yet generated, owed before `initialize`
  (D83). Leak: any open dispute can be resolved to either side within the outcomes
  `resolve` permits.
- Configuration is immutable (D83): replacing a leaked attester, eligibility or arbiter
  key requires a program upgrade carrying a configuration migration.
- **relayer** — pay gas. Leak: SOL burned; USDC cannot move.
- **escrow-keypair** — program identity. Needed for redeploy only.
- **JWT secret** — sessions. Leak: anyone is anyone for up to 7 days (D46).
- **Evidence store secret** — private evidence (D140). Leak: every stored photo can be read,
  overwritten or deleted; no money moves. Lives in `~/bountycam-env`, mode 600.

Rules:

- Never commit a key, seed, token or credential. `.gitignore` is a backup control, not
  the primary one. Inspect `git diff --cached` before key-adjacent commits; verify with
  `git ls-files` that no key is tracked.
- Never log keys, seeds, bearer tokens, `Authorization` headers, JWTs, authentication
  signatures, presigned URLs, raw evidence or full request bodies. Public transaction
  signatures may be logged. One exception (D105): a debug-build diagnostic screen may
  display a SIWS message and its signature, because a SIWS message is public by
  construction and its signature authenticates a single-use nonce that is consumed on
  first verify. Display only — not persistence, not transmission, not a release build,
  not a log file. The exception does not extend to JWTs, MWA authorization tokens,
  presigned URLs or key material.
- Test keys are published RFC vectors or generated per run. A test key never signs
  anything on devnet or beyond.
- Devnet uses disposable development keys, never production keys.

---

## 8. On-chain invariants — escrow program

Each invariant needs a code-level mechanism, a positive test, at least one exploit
test, and a specific error code. Reference `coral-xyz/sealevel-attacks` on GitHub and
current Anchor documentation; fetch them, do not recall them. `sealevel-attacks` is
teaching material, not a complete audit checklist.

- **Authority validation.** The requester is a `Signer` bound by `has_one` to the key
  in the bounty account. At `accept` the Scout is a `Signer` bound to the Scout wallet
  in the verified voucher (D68) and is then stored; any later Scout-signed action is
  bound by `has_one` to that stored key. `submit_attestation` takes no Scout signature
  (D85). The arbiter is a `Signer` bound to the key in the configuration account (D74,
  D83). The eligibility and attester authorities are never transaction signers: each is
  established by the designated ed25519 verification, checked per D71 against the key
  in the configuration account. `initialize` binds its signer to the upgrade authority
  recorded in ProgramData (D83). Tests: wrong requester, wrong Scout, wrong arbiter,
  non-signer substituted, `accept` signed by a wallet other than the voucher's Scout,
  voucher or attestation signed by a non-configured key, `initialize` by a signer other
  than the upgrade authority.
- **Account ownership and type.** Typed Anchor accounts; validate owner, discriminator,
  relationship to the bounty, seeds. Test: same-layout account owned by another program.
- **PDA validation.** Re-derive from seeds and program ID with the canonical bump. An
  attacker-supplied bump never selects the trusted PDA. Tests: wrong bounty seed, wrong
  requester seed, wrong program ID, non-canonical derivation.
- **Exact USDC mint.** One mint per deployment, held in the configuration account (D83),
  checked by address, plus the exact token program. Never identify by symbol, name,
  decimals or metadata. Token-2022 is unsupported until a reviewed design needs it.
- **Escrow token account.** Deterministically derived from the bounty PDA authority;
  validate mint, authority, token program, derivation. Never caller-supplied.
- **Scout payout account.** Derived from the cryptographically bound Scout wallet;
  validate mint and owner. Never selected by requester, Scout, API, database, relayer
  or instruction parameter.
- **Checked transfers.** Use `TransferChecked` so mint and decimals are verified.
- **Arbitrary CPI.** CPI targets are exact programs via typed interfaces, never
  caller-selected `AccountInfo`.
- **State before transfer.** Every check and transition precedes any CPI. No transfer
  until authorisation, state, destination, mint, attestation and amount all pass.
- **Recursion.** Do not state that reentrancy is impossible. Solana blocks indirect
  re-entry (A to B to A) but permits direct self-recursion within limits. Never depend
  on recursion behaviour; keep transitions explicit and validate state before CPIs.
- **Double release.** Terminal states are final. Tests: approve twice, resolve twice,
  refund twice, approve after refund, refund after payout, resolve after terminal.
- **Amount integrity.** Amounts come from immutable bounty state, never from the
  client. Checked arithmetic; `overflow-checks = true` in the release profile. Tests:
  values near `u64::MAX`, zero where disallowed, all fee arithmetic.
- **Fee.** Exactly 0 (D24). A non-zero fee needs a spec, a D-entry, a destination, an
  authorisation model, arithmetic and overflow tests, and UI disclosure. No dormant
  "future fee wallet" authority in the program.
- **Account closure.** Explicit state and recipient rules. No revival: a closed account is
  never used again with its prior data, lamports or tokens, and nothing keeps it funded after
  closure. Re-creation at the same address, including in the same transaction, happens only
  through `init` and must be indistinguishable from a first creation (D88). Test
  close-then-reinit.
- **Duplicate accounts.** Reject aliasing where two roles must be distinct accounts.
- **Remaining accounts.** Never consumed for financial logic. If introduced, every
  account has documented type, owner and relationship validation.

---

## 9. Financial state machine

One documented state machine. Every instruction states: allowed source states,
resulting state, required signer, whether money moves, exact allowed destination. No
undocumented transition. No enum variant exists unless an instruction can enter it, its
exits are defined, and tests cover entry and exit (D34, the `Cancelled` finding).
Terminal states have no outgoing financial transitions. Error codes are part of the
public protocol: one meaningful code per distinct failure.

---

## 10. Off-chain API invariants

- Verify signatures over the exact bytes received. Never rebuild "what we think the user
  signed" from database fields (D39).
- Single-use is enforced by database constraints, never by application logic: nonces,
  active assignments, structured rejections.
- JWT verification pins the algorithm, issuer, audience and expiry; rejects `none`,
  unexpected algorithms, missing claims, expired tokens (D42). A JWT is authorisation
  input, not proof of on-chain state.
- Every endpoint verifies authenticated wallet, requested bounty, requested resource,
  allowed action. Knowing an evidence id or storage URL never grants access.
- No revocation and no rate limiting exist (D46, D47). Both are stated limits; neither
  may be described as present.
- Every dependency is exact-pinned; verify resolution with `pnpm why` and `cargo tree`,
  not by reading manifests (D19). Never install a package because its name resembles a
  known Solana or Anchor package: verify publisher and repository. No new major version
  of any dependency within 30 days of a deadline; security patches are reviewed
  separately and are not blocked.

---

## 11. Evidence and privacy invariants

- Evidence is private data behind short-lived presigned URLs (D4). Never public, never
  on-chain. A presigned URL grants one object and one action, is never logged, and is
  never treated as identity.
- On-chain: commitments, wallets, amounts, state, policy ids, attestations. Never raw
  images, names, home addresses, GPS trails, EXIF, or notes. A hash of guessable
  personal data (a name, an address, coordinates) is not anonymous; commit to the
  canonical evidence bundle, never to individual human-readable sensitive values.
- Location: approximate before acceptance, exact only to authorised parties at the stage
  that needs it. Exact home addresses never appear in discovery. The Scout's live
  location is never shown to the requester.
- The requester's identity is not shown to the Scout. The Scout's personal identity is
  not exposed because their wallet did work.
- Until automated face and plate redaction exists, raw evidence access is limited to
  the requester, the Scout and the arbiter for that bounty, checked on every retrieval.
- Retention is an enforced lifecycle: period, trigger, exceptions, deletion job,
  monitoring. "Will delete later" is not a policy.

---

## 12. RPC and chain-data distrust

RPC providers are infrastructure, not financial authorities. Client RPC data serves UX
and transaction preparation; the program enforces every property it can. After a
financial transaction: obtain the signature, confirm at the required commitment, fetch
resulting state, reconcile the database against the chain. Never mark a payout complete
because the submitting API call returned success.

---

## 13. Honesty — what the system proves

Can show: a wallet authorised a defined action; a commitment to an evidence bundle
existed at a point in time; the policy's named attester signed a canonical attestation;
the program moved a specific amount by its encoded rules.

Cannot show: that an image depicts reality; that GPS could not be spoofed; that the
Scout photographed the intended object or interpreted the scene correctly; that capture
was lawful; that a wallet belongs to a particular person.

Assurance measures the controls around capture and verification. It does not turn
evidence into truth. A perfect capture of the wrong object still passes policy. This
wording stays consistent across pitch, README, architecture, both UIs and docs. Never
market stronger guarantees than the implementation provides.

---

## 14. Scalability — extension points kept open, not built

The MVP is Seeker-native, devnet, USDC on Solana (D8, D10). Nothing here changes that.
These rules keep later expansion cheap without building any of it now.

**More users.**
- The API is stateless; concurrency control lives in database constraints, not in
  process memory or application locks.
- Discovery uses the PostGIS index (D21) with bounded, paginated queries.
- Endpoints that create or transition state are idempotent on a client-supplied key,
  so retries never duplicate a bounty, an assignment or a submission.
- Evidence bytes never pass through the API process; clients upload directly to object
  storage via presigned URLs.
- Polling is the MVP (D7); moving to push must not change any state rule.

**More chains.**
- `users.id` (uuid) is the identity key; wallets are attributes (D37). Adding a chain
  means a `user_wallets` (chain, address) table, not a rewrite of every foreign key.
- All wallet interaction sits behind the `WalletProvider` interface (PRD section 52).
  Chain-specific encoding (ed25519, base58, SIWS) stays inside adapters; shared logic
  never assumes a curve, an address format or a message standard.
- Every signed object carries the chain identifier in its domain-separated body.
- Each chain gets its own authentication verifier and its own escrow, each with its own
  security review under section 8. A second escrow is a second audit, never a port.
- Amounts are base-unit integer strings with an explicit asset identifier (D26). Nothing
  assumes six decimals or the USDC mint outside the Solana adapter.

**More countries.**
- Display currency is separate from settlement asset. Prices shown in local currency
  never change what the escrow holds.
- All times are UTC ISO 8601 with milliseconds; conversion happens only at display.
- Prohibited-task rules and legal notices are data keyed by jurisdiction, not code.
- Identity verification (KYC) is a trust level (PRD section 38), not an architecture
  change. Fiat rails are added per country through regulated providers behind the
  settlement interface below.
- Evidence storage region is a per-bounty attribute so data-residency rules can be met
  without moving the platform.

**More funding mechanisms.**
- Every settlement path implements one interface: fund, release, refund, query state,
  with the section 9 state machine. The rule "funds are locked before a bounty is
  discoverable" holds for every path or the path is not shipped.
- Bitcoin has no programmable escrow comparable to a Solana program. Any BTC path is a
  separate design (hash-time-locked contracts, 2-of-3 multisig with the arbiter, or
  Lightning hold invoices), each with its own trust model and audit. Custodial pooling
  is never a shortcut unless chosen by an explicit D-entry with its legal implications
  recorded.
- Privacy coins change what can be anchored and observed, and carry AML and exchange-
  listing consequences in most jurisdictions. Support is a legal and product decision
  recorded as a D-entry after legal review, never a feature toggle.
- No settlement path may weaken sections 2, 3, 6 or 9. A path that needs an exception
  to any of them is not a settlement path for this product.

---

## 15. Speed — what must be fast, what may be slow

**Must be fast.**
- Discovery and screen transitions: target under one second for the API, immediate for
  navigation (PRD section 78).
- Evidence capture never blocks on the network. Requirements are downloaded before the
  mission; captures are stored locally and uploaded with retry (PRD section 79).
- Signature and token verification are cheap and are never skipped for latency.

**May be slow, and must be asynchronous.**
- Chain confirmation. The client never waits synchronously on finality; a background
  reconciler confirms and updates state (section 12).
- Attestation. The verifier runs after upload; the Scout sees "submitted", not "paid",
  until the chain says otherwise.
- Evidence processing (hashing, future redaction) runs off the request path.

**Rules.**
- Optimistic UI is for display only. No state rule, authorisation or money movement is
  ever decided optimistically.
- Cache public bounty data freely. Never cache authorisation decisions beyond the
  token lifetime, and never cache presigned URLs or attestations.
- Never trade a security check for speed. If a check is too slow, redesign the check,
  do not remove it.

---

## 16. Verification discipline

- A pass counts only when the summary shows the expected test count (D36). Exit 0 with
  zero tests is a failure.
- For money: app UI, database row, API response and "transaction submitted" are not
  evidence. A confirmed transaction plus the expected on-chain state is evidence.
- A coding agent's statement is not evidence; raw output is. Inspect the actual diff
  before merging security-sensitive changes. Never let an agent disable a test, loosen
  an assertion or swallow an error to turn a run green.
- The spec is written first, in its own session, and committed before implementation.
- Memory files under `~/.claude/` can change without approval (D32). Inspect them at
  the start of each session.
- At the start of every security-sensitive session: read this file; inspect git
  status; inspect agent memory files; fetch current Solana and Anchor security docs and
  the relevant `sealevel-attacks` examples; state which invariants the change touches;
  write the negative tests before declaring the change complete.

---

## 17. Review triggers

Always require deliberate review: a new wallet-signing request; a new instruction, CPI
or token operation; a new signer, authority or admin capability; a program upgrade; a
change to PDA seeds, account constraints or state transitions; a change to canonical
serialisation, attestation format or hashing; a change to authentication; a new
dependency or major-version change; a new evidence access path, storage bucket or
origin; a new secret. "No functional change intended" does not exempt a change.

---

## 18. The test for every feature

If the client, the API, the database or the relayer were malicious, what could they
make a user's wallet sign, or make the escrow program do? Remove authority until the
answer is: nothing beyond the exact action the user intentionally authorised and the
exact transitions the protocol permits.
