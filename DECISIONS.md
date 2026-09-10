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
