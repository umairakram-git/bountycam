# Session 8, part 1 — conflicts and open questions for ruling

Date: 14 September 2026. HEAD at time of writing: `ed66fd4` ("docs: handoff for
session 8; SECURITY.md section 1 resolved by D49").

[VERIFIED]
```
$ git log --oneline -1
ed66fd4 docs: handoff for session 8; SECURITY.md section 1 resolved by D49
```

This memo resolves nothing. Every "Recommendation" line is a recommendation only,
awaiting your ruling. Labels: [VERIFIED] = command and raw output included in this
memo or reproduced from files read in full this session; [UNVERIFIED] = stated
without direct evidence.

---

## 0. Files missing or differing from expectation

1. **`programs/escrow/src/` does not exist at the path named in the instruction.**
   The source lives one level deeper, at `programs/escrow/programs/escrow/src/`
   (Anchor workspace layout). [VERIFIED]
   ```
   $ ls -la /Users/umairakram/Developer/hackathon202609/programs/escrow/src/
   ls: /Users/umairakram/Developer/hackathon202609/programs/escrow/src/: No such directory
   $ ls /Users/umairakram/Developer/hackathon202609/programs/escrow/
   Anchor.toml  Cargo.lock  Cargo.toml  SPEC.md  app  programs  rust-toolchain.toml  target
   ```
   Seven source files, read in full: constants.rs (12 lines), error.rs (21),
   instructions.rs (5), lib.rs (44), state.rs (38), instructions/cancel.rs (76),
   instructions/create_and_fund.rs (107). [VERIFIED via `wc -l`, output on file]

2. **`programs/escrow/SPEC.md` differs from the code it claims to describe** —
   the fee row (item 1 below). This divergence was expected from the BACKLOG
   finding ("recorded the invented fee constant as though intended") but the
   direction matters: the code is compliant, the spec is not.

3. All other named files present and as expected: SECURITY.md; DECISIONS.md
   D1, D11, D12, D13, D17, D24, D49; BACKLOG.md open findings; POLICY.md
   section 7.2 (lines 522–575); packages/shared/SPEC.md sections 1–3
   (lines 21–337). All read in full this session. [VERIFIED]

---

## 1. Platform fee

**Raw grep output** [VERIFIED]:
```
$ grep -rn "PLATFORM_FEE\|platform_fee" programs/escrow/programs/escrow/src/
constants.rs:8:pub const PLATFORM_FEE_BPS: u64 = 0;
instructions/create_and_fund.rs:64:    let platform_fee = reward_amount
instructions/create_and_fund.rs:65:        .checked_mul(PLATFORM_FEE_BPS)
instructions/create_and_fund.rs:69:        .checked_add(platform_fee)
instructions/create_and_fund.rs:78:        platform_fee,
state.rs:26:    pub platform_fee: u64,
```

**History** [VERIFIED]: the constant has been `0` in every committed version.
```
$ git log --oneline --follow -- programs/escrow/programs/escrow/src/constants.rs
81f1869 Add escrow account structure with create_and_fund and cancel
a3d224b Add Anchor escrow workspace pinned to anchor-lang 1.1.2
$ git show 81f1869:programs/escrow/programs/escrow/src/constants.rs | grep PLATFORM
pub const PLATFORM_FEE_BPS: u64 = 0;
```
The 250 bps value never existed in committed code. It exists only in
`programs/escrow/SPEC.md` (written after implementation, per the BACKLOG finding).

**The conflict.** Three-way:

- `programs/escrow/SPEC.md:20` (fee row of the Bounty table): "computed:
  `reward_amount * PLATFORM_FEE_BPS / 10_000`, `PLATFORM_FEE_BPS = 250` (not an
  instruction argument)". [VERIFIED — file read in full]
- `DECISIONS.md:149–150` (D24): "**Platform fee is 0.** A 2.5% constant was
  invented during Session 4 and was not in the specification." [VERIFIED]
- `SECURITY.md:238–241` (section 8, Fee bullet): "**Fee.** Exactly 0 (D24). A
  non-zero fee needs a spec, a D-entry, a destination, an authorisation model,
  arithmetic and overflow tests, and UI disclosure. No dormant 'future fee
  wallet' authority in the program." [VERIFIED]
- Code: `constants.rs:8` = 0. Complies with D24 and SECURITY.md.

So the spec contradicts D24, SECURITY.md section 8, and the code. Additionally,
dormant fee *machinery* exists in code even though the value is 0: the constant,
the `platform_fee: u64` field (`state.rs:26`), and the mul/div arithmetic
(`create_and_fund.rs:64–70`). SECURITY.md forbids a dormant fee-wallet
*authority*; a stored field and arithmetic are not an authority, but they are the
scaffolding that makes silent enablement a one-character diff.

**Where the fee goes at payout, and what closes the vault** [VERIFIED from source]:
- The vault holds `total = reward_amount + platform_fee` (`create_and_fund.rs:68–70,
  102`). With BPS = 0, total = reward_amount exactly.
- There is no payout instruction yet — `lib.rs` exposes only `create_and_fund`
  and `cancel`. No fee destination exists anywhere in the program.
- `cancel` transfers `bounty_vault.amount` (the entire balance, whatever it is)
  to the requester's ATA, then closes the vault via `token::close_account` with
  the bounty PDA as authority, rent to the requester (`cancel.rs:48–71`). The
  Bounty PDA itself is closed by the `close = requester` constraint
  (`cancel.rs:12`).
- Consequence: if BPS were ever non-zero, `cancel` would correctly return
  reward + fee (it drains the vault), but a future `approve`/payout path would
  have no defined fee destination — the spec's 250 bps describes money with
  nowhere to go.

**Options.**

- (a) Correct SPEC.md to 0; keep field and arithmetic as-is.
  Consequence: no layout change, no redeploy; dead arithmetic remains; a future
  fee is a one-constant edit, which is exactly what SECURITY.md's process gate
  is designed to make loud, not quiet.
- (b) Remove `PLATFORM_FEE_BPS`, the `platform_fee` field, and the arithmetic.
  Consequence: cleanest — no dormant machinery, `AmountOverflow` on the fee path
  becomes dead; but it changes the account layout (redeploy; devnet-only, cheap,
  and Session 8 likely changes the layout anyway for `accept`), and it
  contradicts D8's "‘platform_fee’ field exists, set to 0" — needs a D-entry
  recording the reversal.
- (c) Keep the `platform_fee` field (honours D8), hardcode it to 0 at
  `set_inner`, delete the constant and the mul/div.
  Consequence: layout unchanged, machinery gone, D8 intact; a future fee still
  requires real work (a destination, arithmetic, tests) — matching SECURITY.md's
  intent.

**Recommendation (recommendation only):** (c), executed in Session 8 part 2's
spec rewrite before any Rust: SPEC.md is being rewritten anyway (BACKLOG:
"Reconcile against the original Session 4 prompt"), and (c) removes the silent-
enablement path without a D8 reversal. If you prefer (b), it should ride the
same redeploy as `accept` and carry its own D-entry.

---

## 2. The accept race

**The two texts.**

- `DECISIONS.md:315–320` (D49): "Session 8 adds an `accept` instruction that
  moves zero USDC and records the Scout; `cancel` is rejected from ACCEPTED
  onward. The database row lock remains as the race arbiter for who gets to
  accept first; the chain records the outcome." [VERIFIED]
- `SECURITY.md:15–17`: "Assume an attacker can call the program directly, build
  their own transaction, modify API requests, replay old messages, supply
  arbitrary account addresses..." [VERIFIED]
- `SECURITY.md:39–43` (section 0): "**Chain-enforced financial truth.** The
  program is the source of truth for escrow balance, financial state, payout
  identities... A database row never constitutes proof that an on-chain
  transition occurred." [VERIFIED]
- `SECURITY.md:151–153` (section 5) already names `BOUNTYCAM_ACCEPTANCE_V1` as a
  canonical signed-object domain tag — evidence the design anticipated a signed
  acceptance object, though nothing defines who signs it or who verifies it.
  [VERIFIED]

**What stops a Scout calling `accept` directly against the deployed program?**
As designed by D49's words: **nothing**. The program is public; if `accept` is
permissionless (Scout signs, program checks only `state == Funded`), any wallet
that can see the chain can accept any funded bounty without touching the API.
The database row lock arbitrates only among clients that go through the API; a
direct caller bypasses the arbiter entirely and the chain — not the row lock —
decides the winner. D49's sentence "the database row lock remains as the race
arbiter... the chain records the outcome" is internally inconsistent for direct
callers: the chain cannot merely *record* an outcome it is actually *deciding*.

**When chain and `assignments` disagree** (chain says Scout X, table says Scout Y
or has no ACTIVE row): SECURITY.md section 0 makes the chain authoritative for
payout identity — the payout goes to X regardless of the table. Today nothing
reconciles the two; reconciliation from confirmations is Session 15 (BACKLOG
remaining plan, row 15). Between Sessions 8 and 15 a divergence would sit
undetected: Y walks the mission believing they hold the assignment, X holds it
on-chain, and only X can be paid. That is exactly the stranded-Scout harm D49
exists to prevent, reintroduced one layer down.

**Griefing analysis (amendment, 14 September, ordered before ruling).**
"Fairness issue" understated the permissionless case. If `accept` is
permissionless:

- Any wallet can accept **every** funded bounty, intending no work. Bounty
  PDAs are public and enumerable (`getProgramAccounts`); the attacker needs no
  API session and no knowledge of the location — they are not going anyway.
- D49 then works for the attacker: `cancel` is rejected from ACCEPTED onward,
  so the requester cannot pull the USDC back, and the single-Scout assignment
  means no honest Scout can take the job.
- **Cost to the attacker:** one base signature fee per accept — 5,000 lamports.
  [VERIFIED — fetched 14 Sep 2026, https://solana.com/docs/core/fees: "Base
  fee per signature | 5,000 lamports".] The cost is flat regardless of bounty
  size: locking a 500 USDC bounty and a 5 USDC bounty each cost 5,000 lamports.
  On devnet the fee is faucet money — effectively zero.
- **Duration of the lockup:** until the deadline. The policy windows that
  derive the deadline are bounded at 30 days for acceptance and completion
  (POLICY.md:131 [VERIFIED — read this session]), so each griefed bounty is
  dead capital for up to its full deadline horizon. Sequencing hazard, worse:
  `expire` belongs to Session 9 (BACKLOG:244). If Session 8 ships `accept`
  and Session 9 slips, an accepted-and-abandoned bounty has **no exit
  instruction at all** — not `cancel` (blocked by D49), not `expire` (does
  not exist) — funds locked until a program upgrade, against the BACKLOG
  contingency line that already contemplates Session 8/9 slippage.
- **Can the marketplace be starved continuously? Yes.** After each
  expiry/refund the requester re-posts; the attacker watches the chain and
  re-accepts in the next slot. Blocking a wallet is useless — keypairs are
  free, so the attack is sybil-costless. Sustained cost: 5,000 lamports per
  bounty per lock cycle, indefinitely, against the entire discoverable
  market.

**Sponsored fees (amendment, same ruling).** `accept` is sponsored by
default: D2 (DECISIONS.md:14–17): "a backend relayer pays; the Scout signs
messages only. The Scout never needs SOL." [VERIFIED — read this session.]
Unless Session 8 rules otherwise, on the app path the 5,000 lamports falls on
the **relayer**; only a direct caller pays their own fee.

- **Who pays, by path:** app path — the relayer; direct call — the attacker.
  So the attacker's cheapest path is the sponsored one: an authenticated
  account griefing through the app pays **zero**, and the defence pays for
  the attack. Sponsorship inverts the economics of every fee-based cost
  argument above.
- **What sustained griefing does to the relayer:** the relayer is trusted for
  liveness (SECURITY.md:80–83) and holds 5 SOL on devnet (HANDOFF.md:52) —
  5×10^9 lamports, one million sponsored transactions at the 5,000-lamport
  base fee. Sustained accept-griefing through the sponsored path burns that
  balance; when it empties, **every** sponsored flow stalls — submissions
  included — so the griefer converts fee sponsorship into a liveness attack
  on the whole product, not merely on the bounties it locked.
- **The relayer as a refusal point — a ruling, not an assumption.**
  SECURITY.md trusts the relayer "for liveness only" (line 78) and says it
  "may not: act as any other authority" (line 80). [VERIFIED — read this
  session.] That a malicious relayer can stall is a *tolerated threat*, not
  permission to design refusal in as a control. Adopting relayer refusal as
  an anti-griefing control gives the relayer a new authority — deciding who
  may accept — and requires a section 2 amendment plus a D-entry. Flagged
  for your ruling; not assumed anywhere below.
  The claim also splits by option. Under (i), permissionless accept, a
  direct caller never touches the relayer: refusal only stops BountyCam
  funding the attack — a spend control, not an access control — and the
  attack proceeds at the attacker's own 5,000 lamports per accept. Only
  under m3 does "two independent server-side gates" hold: the API can refuse
  the voucher, the relayer can refuse the fee, and a direct caller who pays
  their own fee still fails without the voucher.

**Mitigations, as options.**

- (m1) **Bond at accept.** Not foreign to the product. PRD sections 34–35
  (project knowledge, supplied by Umair; the PRD predates the D10 positioning
  change and DECISIONS.md wins wherever they differ) already define a Scout
  Bond: "A Scout may voluntarily place SKR into a BountyCam trust bond" —
  tiered as no bond for basic bounties, 500 SKR plus reputation for
  higher-value, a higher bond plus completion history for premium — and MVP
  scope includes "demonstrate an optional refundable SKR Scout Bond",
  described as a BountyCam bond, not SKR staking. BACKLOG row 19 schedules
  the SKR work (Session 19) [VERIFIED — BACKLOG remaining plan, read this
  session]. But the PRD's bond is **voluntary and reputation-gating** — a
  trust signal — not an anti-griefing deposit; using it against griefing
  means making it mandatory at accept and slashable on no-show, a **change
  of purpose** rather than a new mechanism, and that repurposing is itself a
  ruling. The conflicts identified stand: D49's "an `accept` instruction
  that moves zero USDC" (DECISIONS.md:317–318) — with one nuance: an SKR
  bond moves SKR, not USDC, so D49's letter survives while its spirit
  (nothing of value moves at accept) is what your ruling decides — and D2's
  product stance ("The Scout never needs SOL"; a mandatory bond means
  capital before earning, excluding exactly the users the product courts).
  Spec surface remains: bond sizing (too low, cheap grief; too high,
  honest-Scout exclusion), slash trigger, slash destination, and a new pot
  of value with its own section 8 attack checklist. Consequence: the only
  economic answer that is sybil-resistant — it prices the attack
  per-assignment rather than per-wallet, so fresh keypairs buy nothing. The
  non-economic alternative is a minimum trust level (m5, not yet written),
  sybil-resistant only to the extent of whatever its cheapest qualifying
  route costs.
- (m2) **Per-wallet concurrent-assignment cap.** On-chain this needs a
  per-Scout counter account; a fresh keypair is free, so the cap is defeated
  at zero cost. As an API-side rule it does not bind direct callers at all.
  Consequence: complexity without security against this attacker; at most an
  app-side hygiene rule, never a defence.
- (m3) **Option (iii), the acceptance voucher.** Direct `accept` becomes
  impossible: the instruction verifies an API-signed `BOUNTYCAM_ACCEPTANCE_V1`
  voucher, so griefing requires authenticated API accounts (SIWS), which the
  server can observe and gate — noting honestly that D47 says no rate
  limiting exists today, a stated limit. Consequence: the griefing surface
  moves from "any free keypair" to "any authenticated account", a far higher
  and fully observable bar; costs as given under (iii) above.
- (m4) **Time-boxed no-show reclaim.** `accept` starts a short submission
  window; when it lapses with no submission, the bounty resets to `Funded`
  (or refunds). Shortens each lockup from deadline-length to window-length
  but does nothing about instant re-acceptance, so starvation persists; and
  it pulls Session 9 scope (an expire-class transition) into Session 8.

**Options.**

- (i) **Permissionless `accept`; chain is the arbiter; D49's wording amended.**
  The DB row lock becomes an optimistic reservation for API-mediated flow only;
  Session 15 reconciliation overwrites `assignments` from chain state, and the
  API treats a lost race as "bounty no longer available".
  Consequence: no new trust, no new signer, simplest instruction; cost is
  accepting that a chain-watching Scout can front-run app users (a fairness
  issue, not a fund-safety issue — accept moves no USDC), and a D-entry
  amending D49's arbiter sentence.
- (ii) **Server co-signature on `accept`** (instruction requires an API-held
  authority as second signer).
  Consequence: direct calls impossible; but it creates a new money-adjacent
  authority the trust model must carry (SECURITY.md section 2 update, D-entry),
  and API compromise + Scout key now controls assignment — against least
  authority. Also a liveness coupling: API down means nobody can accept.
- (iii) **API-issued acceptance voucher verified on-chain** — the API signs a
  `BOUNTYCAM_ACCEPTANCE_V1` object naming (bounty, scout, expiry); `accept`
  verifies it via the ed25519 mechanism (item 4).
  Consequence: uses the domain tag section 5 already reserves; the row lock
  genuinely is the arbiter (the API only vouchers the row-lock winner); but it
  imports the full ed25519 introspection machinery into `accept` (item 4's cost
  and risk surface) and the serialisation question of item 3 applies to the
  voucher too; the API signing key becomes a new key in the section 7 inventory.

**Recommendation (recommendation only):** (i) for the MVP, with an explicit
D-entry amending D49 ("the chain is the arbiter; the row lock is an optimistic
reservation for the API path"), and the accept-vs-assignments divergence named
as a stated limit until Session 15's reconciler exists. (iii) is the honest
production answer if front-running matters; it should not be built in the same
session that first introduces ed25519 verification for attestations.

---

## 3. Attestation serialisation

**The two texts.**

- `SECURITY.md:156–158` (section 5): "Canonical serialisation lives only in
  `packages/shared` (SPEC.md). No route, client, test helper, attester service
  or program keeps an alternative implementation." [VERIFIED]
- `SECURITY.md:170–174` (section 6): "The program never accepts
  `attestation_valid = true` from the API. If an attestation affects an on-chain
  decision, its verification is enforced on-chain. The program compares the
  bounty's `required_assurance` against the level in the verified attestation
  (D17)." [VERIFIED]
- `DECISIONS.md:72–79` (D11): "an off-chain verifier issues a signed
  attestation; the program checks the attester signature and the assurance
  level." [VERIFIED]

**The conflict.** To verify a signature on-chain the program must possess the
exact signed bytes. If the attestation is canonical JSON per `packages/shared`,
the program must either rebuild those bytes (a second canonical serialiser, in
Rust, inside the program — forbidden by section 5, and the exact divergence
hazard `packages/shared/SPEC.md:74–79` warns about: UTF-16 code-unit key order
is not UTF-8 byte order) or receive them as instruction data and parse JSON
on-chain (compute-expensive, and parsing is half a serialiser). Section 5 and
section 6 cannot both hold if the signed attestation object is canonical JSON.

**Options.**

- (1) **The on-chain attestation message is not JSON.** The attester signs a
  domain-tagged, fixed-layout byte string (e.g. `BOUNTYCAM_ATTESTATION_V1` tag
  ‖ cluster ‖ program id ‖ bounty PDA ‖ requester ‖ scout ‖ merkle root ‖
  policy hash ‖ level ‖ issued-at ‖ expiry — exact layout to be specified in
  part 2). The program checks fields by offset; no serialiser exists on-chain.
  Any richer JSON attestation remains an off-chain artifact (and can embed the
  same fields; the verifier can publish both).
  Consequence: section 5 preserved (no alternative canonical-JSON
  implementation anywhere); section 6's binding list is satisfied field by
  field; cost is one new normative layout spec with golden vectors, and two
  representations of "the attestation" that must be kept consistent by the
  verifier service.
- (2) **Pass exact canonical JSON bytes as instruction data; program does byte
  and substring comparisons.** Consequence: no full serialiser but ad-hoc JSON
  awareness on-chain; fragile offsets, high compute, large transactions;
  worst of both.
- (3) **Amend section 5 by D-entry to permit a second, vector-locked Rust
  implementation.** Consequence: the divergence risk section 5 exists to
  prevent, plus canonicalisation compute inside the program; effectively
  betting the escrow on cross-language JSON agreement.

**Recommendation (recommendation only):** (1). It is also the pattern D11
implies ("checks the attester signature and the assurance level" — field
checks, not document verification). The fixed layout must be specified in the
part 2 spec with test vectors before any Rust, and SECURITY.md section 6's
"commits to" list is the field checklist.

---

## 4. Ed25519 verification mechanism

Fetched this session (14 September 2026) — cited, not recalled:

- Solana docs, Precompiled Programs: https://solana.com/docs/core/programs/precompiles
- Anza, Instruction Introspection proposal:
  https://docs.anza.xyz/implemented-proposals/instruction_introspection
- Anza runtime/programs page (https://docs.anza.xyz/runtime/programs): fetched;
  now a redirect stub with no content — noted so nobody cites it later.
- Anchor account-constraints reference:
  https://www.anchor-lang.com/docs/references/account-constraints
- RareSkills, "Ed25519 Signature Verification in Solana" (third-party guide):
  https://rareskills.io/post/solana-signature-verification
- Wormhole post-mortem (third-party, surfaced by search):
  https://nomoslabs.io/blog/wormhole-bridge-hack-complete-post-mortem-analysis

**The mechanism.** A Solana program cannot CPI into the Ed25519 precompile
(signature verification runs outside the SVM; the precompile's cost model
depends on it being a top-level instruction). The pattern is therefore
[VERIFIED against the fetched Solana docs and RareSkills guide]:

1. The transaction carries an instruction for the native Ed25519 program,
   program id `Ed25519SigVerify111111111111111111111111111`. Its data is:
   one byte `num_signatures`, one padding byte, then per signature an
   `Ed25519SignatureOffsets` struct — exact fields per the fetched Solana docs:
   `signature_offset: u16`, `signature_instruction_index: u16`,
   `public_key_offset: u16`, `public_key_instruction_index: u16`,
   `message_data_offset: u16`, `message_data_size: u16`,
   `message_instruction_index: u16` — followed by the pubkey, signature and
   message bytes. The runtime rejects the whole transaction if any referenced
   signature does not verify. An `instruction_index` of `u16::MAX` means "this
   instruction's own data".
2. Our instruction (`submit_attestation`) receives the Instructions sysvar
   (`Sysvar1nstructions1111111111111111111111111`) and uses
   `load_current_index_checked` / `load_instruction_at_checked` (per the fetched
   Anza proposal) to read the Ed25519 instruction from the same transaction and
   prove the precompile verified *the bytes we care about*.

**Every check the program must perform, and what omitting each one costs.**
Sources: the RareSkills guide's checklist, the Anza proposal, the Anchor
constraints reference; the Wormhole item from the cited post-mortem.

1. **Sysvar identity**: the passed sysvar account is exactly
   `Sysvar1nstructions1111111111111111111111111` — in Anchor,
   `#[account(address = ...)]` ("Checks the account key matches the pubkey",
   per the fetched Anchor reference), or `load_instruction_at_checked`, which
   performs the owner check the deprecated `load_instruction_at` lacked.
   *Omitted:* the attacker supplies a fake account containing a forged
   "Ed25519 instruction" that was never executed — the Wormhole class
   (≈$326M, per the cited post-mortem: the missing check was exactly
   `account.key == &Sysvar1nstructions::id()`).
2. **Program id of the loaded instruction** equals
   `Ed25519SigVerify111111111111111111111111111`.
   *Omitted:* any instruction (a memo, a no-op to an attacker program) passes
   as "the verification".
3. **Bind to a specific instruction index** (load by explicit index and check
   it, rather than scanning for any matching instruction).
   *Omitted:* ambiguity about which instruction was checked; combined with
   partial checks below, an attacker satisfies each predicate with a different
   instruction.
4. **`num_signatures == 1`** (first data byte) and padding as expected.
   *Omitted:* extra offset entries ride along; the program reads entry 0 while
   the attacker's payload semantics live in entry 1.
5. **All three `*_instruction_index` fields equal the expected value**
   (`u16::MAX`, i.e. self-contained).
   *Omitted:* the offsets point into a *different* instruction's data — the
   precompile verified bytes located elsewhere in the transaction, while the
   program reads the pubkey/message bytes embedded in the Ed25519 instruction
   itself. Signature-of-one-thing, acceptance-of-another.
6. **Offset and size sanity**: offsets and `message_data_size` describe exactly
   the fixed expected layout (for one signature: 2-byte header + 14-byte
   offsets struct, then pubkey at a known offset, signature, message), with no
   overlap and no out-of-bounds reach.
   *Omitted:* overlap/aliasing games — e.g. a message window that overlaps the
   pubkey or signature bytes, or a truncated message.
7. **Public key equality**: the 32 pubkey bytes equal
   `bounty.attester_authority` (stored at creation, D11).
   *Omitted:* any key's valid signature over the right message shape passes —
   the attester binding disappears entirely and every bounty is drainable by
   anyone (SECURITY.md section 7's attester-leak scenario, without the leak).
8. **Message equality, full length**: the message bytes equal, byte for byte
   and length for length, the attestation the program independently expects
   (per item 3, a fixed layout the program can rebuild from the Bounty account
   plus instruction arguments) — including the domain tag, cluster, program id,
   bounty identity, scout, merkle root, policy hash, and level (SECURITY.md
   section 6's binding list).
   *Omitted, any field:* a valid attestation for bounty A replays against
   bounty B; or for scout X pays scout Y; or level 1 satisfies required 4; or
   a devnet attestation replays on another cluster. Whatever field is not
   compared is a field the attacker chooses.

Note on composition: hardcoding "the immediately preceding instruction"
(`current_index - 1`) is the common pattern but is a known composability trap
(surfaced in the search results as an audit finding —
https://github.com/Frankcastleauditor/Solana-Audit-Arena/issues/257); whatever
part 2 specifies must state the index rule exactly and test the
wrong-index case. [UNVERIFIED beyond the issue title — I did not fetch the
issue body.]

Caveat, stated plainly: the per-check attack enumeration above leans on the
RareSkills guide (third-party); the official Solana page documents the
structure and sentinel but does not enumerate attacks. The 16-byte header
arithmetic (2 + 14) is consistent between both sources.

---

## 5. The three meanings of "challenge"

Full occurrence listing: 124 lines. [VERIFIED]
```
$ grep -rni "challenge" --include="*.md" --include="*.rs" --include="*.ts" \
    --include="*.sql" SECURITY.md SECURITY-PRODUCTION.md HANDOFF.md DECISIONS.md \
    BACKLOG.md apps/api/AUTH.md apps/api/POLICY.md apps/api/src apps/api/test \
    programs packages | grep -v node_modules | grep -v /target/ | wc -l
     124
```
The full 124-line listing (each line truncated at 160 chars for display) is in
the appendix at the end of this memo. Classification, with representative
file:line for each meaning (every listed line verified against the appendix):

**Meaning A — SIWS login challenge** (a server-issued nonce+fields row a wallet
signs to authenticate). Occurrences: AUTH.md throughout (4, 40–41, 135, 156,
169, 179, 233, 248, 255, 268, 284–291, 310–316, 361–383, 485–507);
apps/api/src/auth/routes.ts (16, 26, 72, 92, 96, 178–219);
apps/api/test/auth.test.ts (~50 occurrences, lines 123–580); DECISIONS.md 257,
270, 275, 305 (D40/D41/D46 context); SECURITY.md:89 ("store challenges");
SECURITY-PRODUCTION.md:87 ("rate limiting on: challenge creation");
HANDOFF.md:187, 204; BACKLOG.md:236.

**Meaning B — capture liveness challenge** (a nonce issued after posting/accept,
bound into the evidence so capture provably postdates it). Occurrences:
HANDOFF.md:5, 19 ("bound to a challenge issued after the job was posted"), 354;
BACKLOG.md:243 (Session 8 row); POLICY.md:549 (informative table);
DECISIONS.md:93 (D13's ladder: "A1 | Live challenge + evidence").

**Meaning C — challenge window** (the post-policy-pass period in which the
requester may dispute before auto-release). Occurrences: DECISIONS.md:81 (D12);
BACKLOG.md:244, 256; POLICY.md:84, 128, 130–133, 676, 1265, 1285, 1315
(`challenge_window_seconds`, policy v1 field); apps/api/src/bounties/extract.ts
48, 93, 103, 150; policy.ts 34, 95–96, 211; routes.ts:48; views.ts 79, 110;
test/bounties.test.ts 171, 290, 692–693, 1396. On-chain counterpart:
`review_window_secs` (`state.rs:32`) — a fourth name for meaning C.

**Proposed distinct names (proposal only):**

- Meaning A → **"SIWS challenge"** in prose; endpoint `/auth/siws/challenge` and
  table `auth_challenges` are shipped and stay.
- Meaning B → **"capture nonce"** — your own term from item 6; it never collides
  with A because "nonce" alone is ambiguous (the SIWS row also has a nonce), so
  always the two-word form. Session 8 part 2 defines it normatively.
- Meaning C → **"review window"** in all prose, matching the on-chain field
  `review_window_secs`. The JSON field `challenge_window_seconds` is inside
  hashed policy v1 (POLICY.md section 4 immutability) — renaming it is a policy
  version bump, not worth it. Two sub-options for the residual split:
  (i) accept "wire name `challenge_window_seconds`, prose name review window,
  on-chain `review_window_secs`" with a mapping note in both specs; or
  (ii) rename the *on-chain* field to `challenge_window_secs` while the layout
  is still cheap to change (devnet, Session 8 redeploys anyway), making wire
  and chain agree and leaving prose to disambiguate.
  Consequence of (i): three names, one concept, documented. Consequence of
  (ii): two names; but "challenge" then survives on-chain next to the capture
  nonce work, re-importing the collision this item exists to remove.

**Recommendation (recommendation only):** A = "SIWS challenge", B = "capture
nonce", C = "review window" with sub-option (i) — keep both existing field
names, fix the prose, and record the three-way mapping in the Session 8 spec
and a D-entry.

---

## 6. Capture nonce origin

**Today there is no normative definition anywhere.** [VERIFIED]
```
$ grep -rni "nonce" apps/api/POLICY.md
apps/api/POLICY.md:549:| `ACCEPTED` | Session 8 — accept, challenge nonce issuance |
```
That single line is inside a table 7.2 marks "informative expectation only".
The only other prose is HANDOFF.md:19: "bound to a challenge issued after the
job was posted" — a positioning sentence, not a definition. Everything below is
therefore a question set for your ruling, not a reading of existing text.

**Who issues it.** The API server is the only candidate that exists (the
verifier service arrives Session 14; the program should not hold it — it would
be public on-chain the moment it was stored, defeating unpredictability).
Precedents in the codebase: the SIWS nonce is 128-bit random, single-use,
DB-enforced (D41); randomness flows through the injectable module (D54, Session
7b) and is source-tested. The natural shape is: issued by the API from the
randomness module, stored server-side, single-use.

**When.** Two candidate moments, materially different:
- At **accept** — simple, one nonce per assignment; but a Scout may accept
  hours before arriving, giving a fraudster a long pre-staging window between
  nonce receipt and capture.
- At **capture-session start** (Scout on site, about to shoot) — narrows the
  staging window to minutes; needs a TTL and a re-issue path.
This is a ruling: it defines what "live" means in D13's "A1 | Live challenge +
evidence".

**What makes it unpredictable.** Server-side CSPRNG (the D54 module wraps
`node:crypto` `randomBytes`); at least 128 bits (SIWS precedent D41; 256 bits
costs nothing); issued only after the bounty exists and (per the ruling above)
after accept or at capture start — so no evidence captured before issuance can
contain it. It must be bound into the evidence bundle (a leaf under the merkle
root, so it is inside the commitment the attestation signs — SECURITY.md
section 6) — otherwise it proves nothing.

**What an attacker gains if the issuer is compromised.** An attacker who
controls the API can mint nonces at will and backdate nothing — but they can
hand a nonce to a colluding Scout *before* staging a scene, or issue a nonce
and let the Scout capture at leisure. That defeats the liveness property: A1+
evidence becomes A0-equivalent while still grading as A1+. It does **not**
alone move money — the attester still independently evaluates and signs, and
the program still gates on the attester signature (least authority,
SECURITY.md section 0/2, holds). The harm is honest requesters paying A1+
prices for A0 assurance, silently — an integrity failure of the product's
core claim rather than a theft. Worth stating in SECURITY.md's trust model
when the definition lands: "API server... may not: manufacture an
attestation" is already there; "may weaken liveness if compromised" is not.

**Recommendation (recommendation only):** Session 8 part 2 gives the capture
nonce a normative section (in POLICY.md or the new escrow spec): issued by the
API via the D54 randomness module, 32 bytes lowercase hex, issued at
capture-session start (post-accept), single-use, TTL'd, stored with the
assignment, and REQUIRED to appear as a defined leaf of the evidence bundle.
The chain never sees it directly; it reaches the chain only inside the merkle
root the attestation commits to.

---

## Flagged for your ruling (not in your list of six)

1. **Session 17 standalone verifier vs SECURITY.md section 5.**
   `SECURITY.md:156–158`: canonical serialisation "lives only in
   `packages/shared`... No route, client, test helper, attester service or
   program keeps an alternative implementation." But
   `packages/shared/SPEC.md:9–11` says the functions "are computed
   independently by the mobile app, the API server, and a standalone verifier",
   SPEC.md:74–79 gives Rust implementers normative sorting guidance, and
   BACKLOG:122–123 says "Any Rust implementation (Session 17 standalone
   verifier) must sort keys by UTF-16 code units". The BACKLOG verification
   gate ("a standalone script reproduces the Merkle root byte-for-byte") is
   only meaningful if Session 17 is a genuinely independent implementation.
   Section 5's list does not literally name a standalone verifier, but the
   spirit ("no alternative implementation") and the gate ("independent
   reproduction") pull in opposite directions. Needs a ruling before Session
   17 — and before item 3's option (3) is ever entertained. [VERIFIED quotes]

2. **On-chain fields are not validated against `policy_hash`.**
   `create_and_fund` takes `required_assurance`, `deadline`,
   `review_window_secs` as instruction arguments and stores `policy_hash` as
   an opaque 32 bytes (create_and_fund.rs:44–90). Nothing on-chain or in any
   spec states who guarantees the arguments agree with the hashed policy's
   `required_assurance` / `challenge_window_seconds` / windows. A direct
   caller can fund a bounty whose on-chain gate (say assurance 0) contradicts
   its committed policy (assurance 4). For API-created bounties the API builds
   both; for direct callers nobody does. Probably acceptable (such bounties
   are never discoverable — POLICY.md 7.3 — so no app Scout works them), but
   "probably acceptable" is a ruling, and Session 15's reconciler and the
   Session 14 verifier both need to know which side wins on divergence.
   [VERIFIED source reading; the gap itself is the absence of text]

3. **`Cancelled` unreachable variant (BACKLOG open finding).** Session 8 is
   the cheapest moment to act: `accept` changes program logic and redeploys
   anyway, and item 1 option (b)/(c) may already touch the layout. Ruling:
   drop it in Session 8, or leave for Session 9's enum reconciliation as
   BACKLOG currently assigns. [VERIFIED: state.rs:15 carries `Cancelled`;
   cancel.rs closes the account without ever writing it]

4. **`UnauthorizedRequester` overload (BACKLOG open finding).**
   cancel.rs:30 and create_and_fund.rs:33 both use it for "this token account
   is not yours" as well as the true "you are not the requester" (cancel.rs:13).
   Session 8 adds new error codes regardless; bundling a distinct
   `TokenAccountOwnerMismatch` costs one enum entry now and a client-visible
   error-code change later if deferred. [VERIFIED source reading]

5. **`arbiter_authority` is an unchecked, caller-chosen account**
   (create_and_fund.rs:36–37). Any direct caller names any arbiter, including
   themselves. Harmless today (no `resolve` instruction); becomes load-bearing
   in Session 9 when `resolve` trusts that field. D9 calls the arbiter "a
   dedicated administrative authority" — singular and protocol-level — which
   the program does not enforce. Ruling owed by Session 9 at the latest;
   flagged now because Session 8's spec will describe the account it inherits.
   [VERIFIED source reading]

6. **POLICY.md 7.2 scope question for Session 8's API side.** The 7.2 table
   expects Session 8 to produce DB `ACCEPTED`, but `AVAILABLE` (its only
   plausible predecessor) is producible by nothing until Session 15 — only
   tests seed it by SQL (7.2's Session 11 note). If Session 8 implements an
   accept endpoint, its tests must seed `AVAILABLE` the same way, and the
   normative DB transition (`AVAILABLE → ACCEPTED`? others?) must be specified
   in part 2 — POLICY.md currently defines no transition into `ACCEPTED`.
   [VERIFIED: POLICY.md:540–559]

7. **Escrow SPEC.md is stale beyond the fee row** and is scheduled for full
   replacement (BACKLOG: "Reconcile against the original Session 4 prompt").
   Part 2's spec work should supersede it wholesale rather than patch the fee
   row alone — patching one row would launder the rest of a post-hoc document
   into apparent authority. [VERIFIED that the finding stands in BACKLOG:31–35;
   the "should" is a recommendation]

---

## Which of the six I could not investigate

None — all six were investigated. Two caveats on depth, stated plainly:

- **Item 4**: the official Solana docs page documents the mechanism and struct
  but not the attack-per-omitted-check enumeration; that enumeration rests on
  the cited RareSkills guide (third-party) and the cited Wormhole post-mortem
  (third-party). The Anza `runtime/programs` page is now an empty redirect
  stub. The Solana-Audit-Arena issue on index hardcoding is cited by title
  only; I did not fetch its body.
- **Item 6**: nothing to read — the finding is precisely that no normative
  text exists; the analysis is construction from precedents (D41, D54), not
  from a document.

---

## Appendix — full "challenge" occurrence listing (124 lines)

Command:
```
grep -rni "challenge" --include="*.md" --include="*.rs" --include="*.ts" \
  --include="*.sql" SECURITY.md SECURITY-PRODUCTION.md HANDOFF.md DECISIONS.md \
  BACKLOG.md apps/api/AUTH.md apps/api/POLICY.md apps/api/src apps/api/test \
  programs packages | grep -v node_modules | grep -v /target/ | cut -c1-160
```
Note: display truncated at 160 characters per line by the `cut`; file and line
numbers are exact.

```
DECISIONS.md:81:**D12 — Release: policy pass opens a challenge window, then auto-releases.
DECISIONS.md:93:| A1 | Live challenge + evidence |
DECISIONS.md:257:parses those bytes and checks fields against the stored challenge. Never rebuild the message
DECISIONS.md:270:**D41 — `auth_challenges` table; single-use enforced by the database.** 128-bit random nonce
DECISIONS.md:275:deliberately: any failed attempt invalidates the challenge.
DECISIONS.md:305:single-use and challenges expire in 5 minutes, which bounds replay but not brute-force
SECURITY-PRODUCTION.md:87:- Rate limiting on: challenge creation; verification; evidence upload; presigned URL
HANDOFF.md:5:**Next session:** 8 — Escrow: `accept`, `submit_attestation`, challenge nonce issuance (BACKLOG)
HANDOFF.md:19:live capture only, signed on-device, bound to a challenge issued after the
HANDOFF.md:187:Normative: SIWS challenge/verify flow, exact-bytes verification (never rebuild
HANDOFF.md:204:- Migrations 3 (`auth_challenges`) and 4 (`users.status` to `user_status`
HANDOFF.md:354:challenge nonce issuance. D49 fixes `accept`'s shape: it moves zero USDC,
SECURITY.md:89:May: issue sessions after wallet authentication; store challenges; gate evidence access;
BACKLOG.md:236:| 6 | API — SIWS challenge/verify, JWT, user records **done 12 Sep** |
BACKLOG.md:243:| 8 | Escrow — `accept`, `submit_attestation`, challenge nonce issuance |
BACKLOG.md:244:| 9 | Escrow — `approve`, `reject`, `resolve`, `expire`, challenge window |
BACKLOG.md:256:| 16 | Requester review, challenge window, dispute with named requirement |
apps/api/AUTH.md:4:**Scope:** challenge issuance, SIWS verification, JWT issuance and verification, user
apps/api/AUTH.md:40:1. App calls `POST /auth/siws/challenge` with the wallet address. Server stores a
apps/api/AUTH.md:41:   challenge row and returns the SIWS input fields.
apps/api/AUTH.md:135:  field-equality checks against the stored challenge (section 6).
apps/api/AUTH.md:156:Challenges always issue the canonical form in `chainId` (currently `devnet`).
apps/api/AUTH.md:169:### 5.1 `POST /auth/siws/challenge`
apps/api/AUTH.md:179:encoded), stores the challenge row (section 11.1), then responds `200`:
apps/api/AUTH.md:233:the stored challenge. The numbered order is normative; each step names the error it
apps/api/AUTH.md:248:   update `auth_challenges` setting `consumed_at` to the app clock passed as a bind
apps/api/AUTH.md:255:6. **Field checks** against the returned challenge row, in order, each an exact string
apps/api/AUTH.md:268:   challenge and the client must request a new one. This is deliberate.
apps/api/AUTH.md:284:| `INVALID_ADDRESS` | 400 | challenge | address not base58 or not 32 bytes |
apps/api/AUTH.md:285:| `CHAIN_NOT_ALLOWED` | 400 | challenge | request chain form not in section 4 table |
apps/api/AUTH.md:289:| `NONCE_UNKNOWN` | 401 | verify | no challenge with the parsed nonce |
apps/api/AUTH.md:290:| `NONCE_CONSUMED` | 401 | verify | challenge already consumed |
apps/api/AUTH.md:291:| `NONCE_EXPIRED` | 401 | verify | challenge past expiry |
apps/api/AUTH.md:310:- The challenge expiry predicate compares `expires_at` to the **app clock passed as a
apps/api/AUTH.md:314:  (jose clock tolerance option). Challenge times need no skew allowance: the same server
apps/api/AUTH.md:316:  10 minutes of its own clock; the 300-second challenge lifetime sits well inside that.
apps/api/AUTH.md:361:### 11.1 Migration 3 — create `auth_challenges`
apps/api/AUTH.md:369:| `address` | text | not null — base58 wallet address the challenge was issued to |
apps/api/AUTH.md:383:Down: drop table `auth_challenges`.
apps/api/AUTH.md:485:Challenge endpoint:
apps/api/AUTH.md:489:2. Two challenges return distinct nonces.
apps/api/AUTH.md:499:8. Second verify for the same wallet with a new challenge — same user id, no second row.
apps/api/AUTH.md:507:13. Address mismatch: challenge issued to A; message carries B's address, signed by B,
apps/api/POLICY.md:84:| `challenge_window_seconds` | request | integer | 60 to 86400 inclusive |
apps/api/POLICY.md:128:  deadline; `challenge_window_seconds` — from policy pass to auto-release, within which
apps/api/POLICY.md:130:  (section 2.4). The minimum of 60 seconds admits the D12 demo challenge window; the
apps/api/POLICY.md:131:  maxima — 30 days for acceptance and completion, 24 hours for challenge — bound
apps/api/POLICY.md:132:  derived deadlines to sane timestamps. The challenge maximum is deliberately the
apps/api/POLICY.md:133:  shortest: the challenge window holds a Scout's already-earned payment awaiting
apps/api/POLICY.md:549:| `ACCEPTED` | Session 8 — accept, challenge nonce issuance |
apps/api/POLICY.md:676:`challenge_window_seconds`, `completion_window_seconds`, `evidence_requirements`,
apps/api/POLICY.md:1265:| `challenge_window_seconds` | 3600 |
apps/api/POLICY.md:1285:"capture_radius_m":50,"chain":"solana","challenge_window_seconds":3600,"cluster":"devnet
apps/api/POLICY.md:1315:111","capture_radius_m":50,"challenge_window_seconds":3600,"cluster":"devnet","completio
apps/api/src/auth/routes.ts:16:const CHALLENGE_LIFETIME_MS = 300_000;
apps/api/src/auth/routes.ts:26:interface ChallengeRow {
apps/api/src/auth/routes.ts:72:  app.post("/auth/siws/challenge", async (request, reply) => {
apps/api/src/auth/routes.ts:92:    const expires = new Date(issued.getTime() + CHALLENGE_LIFETIME_MS);
apps/api/src/auth/routes.ts:96:      `INSERT INTO auth_challenges
apps/api/src/auth/routes.ts:178:    const consumed = await pool.query<ChallengeRow>(
apps/api/src/auth/routes.ts:179:      `UPDATE auth_challenges SET consumed_at = $2
apps/api/src/auth/routes.ts:186:        "SELECT consumed_at FROM auth_challenges WHERE nonce = $1",
apps/api/src/auth/routes.ts:195:    const challenge = consumed.rows[0]!;
apps/api/src/auth/routes.ts:198:    //    deliberate: any failed attempt burns the challenge.
apps/api/src/auth/routes.ts:199:    if (parsed.domain !== challenge.domain) {
apps/api/src/auth/routes.ts:202:    if (parsed.address !== challenge.address) {
apps/api/src/auth/routes.ts:205:    if (parsed.statement !== challenge.statement) {
apps/api/src/auth/routes.ts:213:    if (messageChain === undefined || messageChain !== challenge.chain) {
apps/api/src/auth/routes.ts:216:    if (parsed.issuedAt !== challenge.issued_at_value) {
apps/api/src/auth/routes.ts:219:    if (parsed.expirationTime !== challenge.expiration_time_value) {
apps/api/src/bounties/extract.ts:48:  "challenge_window_seconds",
apps/api/src/bounties/extract.ts:93:  const challengeWindowSeconds = policy["challenge_window_seconds"];
apps/api/src/bounties/extract.ts:103:  if (!isSafeInteger(challengeWindowSeconds)) return null;
apps/api/src/bounties/extract.ts:150:      challengeWindowSeconds,
apps/api/src/bounties/policy.ts:34:  challengeWindowSeconds: number;
apps/api/src/bounties/policy.ts:95:    input.challengeWindowSeconds < 60 ||
apps/api/src/bounties/policy.ts:96:    input.challengeWindowSeconds > 86_400
apps/api/src/bounties/policy.ts:211:    challenge_window_seconds: input.challengeWindowSeconds,
apps/api/test/auth.test.ts:123:async function requestChallenge(address: string, chain?: string) {
apps/api/test/auth.test.ts:126:    url: "/auth/siws/challenge",
apps/api/test/auth.test.ts:131:async function challengeInput(address: string): Promise<Record<string, string>> {
apps/api/test/auth.test.ts:132:  const res = await requestChallenge(address);
apps/api/test/auth.test.ts:181:// --- challenge endpoint ---
apps/api/test/auth.test.ts:183:test("01 challenge success: fields, nonce form, expiry, stored row", async () => {
apps/api/test/auth.test.ts:184:  const res = await requestChallenge(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:209:    "SELECT * FROM auth_challenges WHERE nonce = $1",
apps/api/test/auth.test.ts:222:test("02 two challenges return distinct nonces", async () => {
apps/api/test/auth.test.ts:223:  const first = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:224:  const second = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:231:    url: "/auth/siws/challenge",
apps/api/test/auth.test.ts:239:  const res = await requestChallenge("not-valid-base58-!!!");
apps/api/test/auth.test.ts:245:  const res = await requestChallenge(VECTOR_ADDRESS, "mainnet");
apps/api/test/auth.test.ts:251:  const res = await requestChallenge(VECTOR_ADDRESS, "solana:devnet");
apps/api/test/auth.test.ts:259:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:283:  const first = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
apps/api/test/auth.test.ts:285:  const second = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
apps/api/test/auth.test.ts:310:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:322:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:333:test("13 message address differs from challenge address: ADDRESS_MISMATCH", async () => {
apps/api/test/auth.test.ts:334:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:341:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:348:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:357:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:368:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:401:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:408:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:415:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:424:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:433:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:442:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:451:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:463:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:474:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/test/auth.test.ts:496:  const verified = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
apps/api/test/auth.test.ts:559:  const verified = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
apps/api/test/auth.test.ts:580:  const input = await challengeInput(VECTOR_ADDRESS);
apps/api/src/bounties/routes.ts:48:    challenge_window_seconds: body.policy.challengeWindowSeconds,
apps/api/src/bounties/views.ts:79:  challenge_window_seconds: number;
apps/api/src/bounties/views.ts:110:      challenge_window_seconds: policy.challenge_window_seconds,
apps/api/test/bounties.test.ts:171:      challenge_window_seconds: 3600,
apps/api/test/bounties.test.ts:290:    "challenge_window_seconds",
apps/api/test/bounties.test.ts:692:    ["challenge_window_seconds", 59],
apps/api/test/bounties.test.ts:693:    ["challenge_window_seconds", 86_401],
apps/api/test/bounties.test.ts:1396:    "challenge_window_seconds",
```
