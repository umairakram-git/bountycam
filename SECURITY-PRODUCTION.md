# BountyCam — Production and Mainnet Gates

**Status:** read before any mainnet, production or fiat planning. Not required reading
for devnet sessions; `SECURITY.md` is.
**Change control:** same as `SECURITY.md` — every change needs a D-entry.
**Style:** per D31 — no line over 100 characters.

Nothing in this file is a roadmap item. Each section describes what must be true
before the corresponding production capability is safe. Absence of any item is a
blocker for that capability, not a known limitation to disclose.

---

## 1. Key custody

Development keys may be plaintext files under `~/bountycam-keys/` (SECURITY.md
section 7). Production authority keys may not.

Program upgrade authority — upgrades the escrow. Compromise: total escrow loss.
Production: hardware wallet or multisig; never a hot server key; never held by CI.

Attester key — signs attestations. Compromise: false evidence certified.
Production: HSM or equivalent; rotation and revocation implemented; key id in every
attestation so a rotated key can be retired without invalidating history.

Arbiter authority — resolves disputes. Compromise: disputed funds redirected within
protocol limits. Production: hardware wallet or multisig for any material value.

Relayer key — pays fees. Compromise: SOL burned. Production: hot key allowed with a
minimal balance and a spend alert.

Program-ID keypair — program identity. Production: offline archive; never a runtime key.

JWT signing secret — sessions. Compromise: impersonation until expiry.
Production: managed secret store; rotation; revocation list (section 4).

Database credentials — workflow and privacy data. Production: managed secret; least
privilege; separate read and write roles.

Evidence storage credentials — private evidence. Production: scoped service identity
per environment; no long-lived static keys.

CI and deployment credentials — release path. Production: protected environments;
least privilege; no unilateral upgrade authority.

DNS and registrar accounts — application origin. Compromise: phishing or replaced
client. Production: hardware-backed MFA; registrar lock.

Rules: secret scanning runs in CI; a key-compromise response procedure exists and has
been rehearsed; relayer wallets hold only operational SOL.

---

## 2. Program upgrades

The upgrade authority can replace the financial rules of the protocol.

- A developer laptop key is unacceptable for production.
- CI never holds unilateral upgrade authority.
- Every production deployment is tied to a reviewed commit and requires explicit
  approval.
- A verifiable build is produced and matched against the deployed binary (Anchor
  supports verifiable builds).
- Monitoring alerts on any upgrade and on any change of upgrade authority.
- Removing the upgrade authority makes the program immutable. It is a one-way decision
  and is taken deliberately, with a D-entry, never as a side effect.

---

## 3. Independent audit

Before mainnet:

- An independent security audit of the escrow program against SECURITY.md section 8.
- Every critical and high finding remediated, or explicitly accepted with written
  rationale in DECISIONS.md.
- The full adversarial test suite (section 8 below) passes with the expected count.
- A second audit after any change to PDA seeds, account constraints, state transitions
  or token handling.

---

## 4. Sessions and rate limits

- JWT revocation implemented; session lifetime shortened; rotation of the signing
  secret without logging users out.
- Rate limiting on: challenge creation; verification; evidence upload; presigned URL
  creation; bounty creation; rejection; attestation endpoints; relayer submission.
  Tighter limits on expensive or abuse-prone operations.
- Alerts on repeated failed authentication, repeated nonce reuse, and evidence-access
  spikes.

---

## 5. Evidence lifecycle

- Retention deletion jobs implemented and monitored, per evidence class: period,
  trigger, exceptions, job, failure alert.
- Face and plate redaction implemented before requester access wherever the product
  promises it.
- Evidence served from an isolated origin, never as executable same-origin content.
  Safe MIME handling; `X-Content-Type-Options: nosniff`. HTML and SVG uploads cannot
  execute script in the application origin.
- Data-residency rules met per storage region before operating in a jurisdiction that
  requires them.

---

## 6. Web frontend — applies when a browser client exists

The MVP is a native Android app. These rules bind the moment any web surface can ask
a wallet to sign.

- No advertising scripts, tag managers or unnecessary third-party JavaScript on any
  signing surface. Prefer locally bundled dependencies.
- All bounty titles, descriptions, Scout input, evidence metadata, filenames and
  API-returned strings are attacker-controlled. Escape by default. No raw HTML. If
  Markdown is rendered, use a strict sanitiser with HTML disabled.
- A restrictive Content Security Policy: no `unsafe-inline` or `unsafe-eval`;
  `script-src`, `connect-src`, `frame-src`, `object-src`, `base-uri` and `form-action`
  restricted to required destinations, including wallet, RPC and API hosts.
- Protected production branches; reviewed deployment; no direct deployment from
  developer branches.

---

## 7. Supply chain

- Lockfiles committed; CI installs with a frozen lockfile; exact direct pins; transitive
  resolution inspected with `pnpm why` and `cargo tree`.
- Install and postinstall scripts reviewed on every dependency change.
- An explicit allowlist of approved package names and namespaces for the Solana and
  Anchor stack. A package is never installed because its name resembles one on the list.
- Dependency review blocks known-vulnerable packages on every pull request.
- Third-party GitHub Actions pinned to full commit SHAs in any workflow that can reach
  a secret or deploy.
- CI permissions minimal: no write, package, deployment or secret access for jobs that
  only read.
- Release freeze near a deadline: dependency upgrades need deliberate review; security
  patches are evaluated separately and are not blocked.

---

## 8. Adversarial test suite

A security control without an exploit test is incomplete. For every money-moving
instruction, hostile tests for: wrong, missing or substituted signer; wrong bounty,
Scout or requester; wrong PDA or non-canonical derivation; wrong mint, fake USDC, wrong
token program; attacker payout or escrow account; duplicate account aliasing; modified
attestation; attestation for another bounty, Scout or evidence hash; insufficient
assurance level; expired or replayed attestation; amount modification; double payout,
double refund, payout after refund, refund after payout; wrong state; arithmetic
boundaries; unexpected CPI or program account; close-then-reinitialise.

Client tests verify the signing layer refuses forbidden instructions (SECURITY.md
section 3). Authentication tests follow `apps/api/AUTH.md` section 13 plus the
concurrent-nonce race.

Each test demonstrates the attempted exploit, not the happy path.

---

## 9. Logging and monitoring

Log: request id; wallet public key where operationally required; bounty id; action;
result or error code; public transaction signature; security-relevant transitions.
Never log anything listed in SECURITY.md section 7.

Alert on: repeated failed authentication; nonce reuse; abnormal relayer spend;
repeated failed payouts; any program upgrade or authority change; attester key change;
large dispute resolutions; evidence-access spikes.

---

## 10. Product and legal gates

- Prohibited-task moderation in the creation workflow, with rules held as data per
  jurisdiction.
- A high-value bounty policy: assurance level, second attester (A5), and approval
  controls above a defined threshold.
- Fiat rails only through regulated providers, per country, behind the settlement
  interface (SECURITY.md section 14).
- Any non-USDC settlement asset, including Bitcoin paths and privacy coins, requires
  legal review of AML, licensing and listing consequences in each operating
  jurisdiction, recorded as a D-entry before any code is written.

---

## 11. Mainnet checklist

Mainnet is unsafe until every item is demonstrable, not asserted:

1. The D1 acceptance and cancellation contradiction is resolved at the protocol level.
2. Independent escrow audit completed; critical and high findings closed or accepted
   in writing.
3. Upgrade authority on hardware or multisig; verifiable build matched to the deployed
   binary.
4. Attester key in an HSM or equivalent, with rotation and revocation.
5. Arbiter authority on production-grade signing controls.
6. JWT revocation and rate limiting implemented.
7. Retention deletion jobs running and monitored.
8. Face and plate redaction live where promised.
9. High-value bounty policy defined.
10. Prohibited-task moderation live.
11. Secret scanning, dependency review, minimal CI permissions and SHA-pinned actions
    in place.
12. Domain and registrar protected with hardware MFA.
13. Key-compromise response procedure documented and rehearsed.
14. Monitoring live for upgrades, authority changes, relayer spend and abnormal payouts.
15. Full adversarial suite passing with the expected test count.
16. If any web client exists: section 6 satisfied.

Not evidence for mainnet readiness: the demo works; the contract has tests; the wallet
shows the right amount.
