# BountyCam

**Ask the real world. Someone nearby verifies it.**

BountyCam is an Android app for Solana Mobile. A requester posts a **Bounty**: a paid question
about a real place ("Is this EV charger working?"), with the photos they need. The reward is locked
in an on-chain escrow. A **Scout** nearby accepts, goes there, captures live photos inside the
app and submits them. A verifier attests the evidence on chain; the requester approves (the Scout
is paid), rejects naming the requirement that was not met (BountyCam's arbiter decides), or says
nothing and the reward is released when the review window closes.

Built for **CLOCK IN, the Solana Mobile hackathon**. Runs on **Solana devnet with test USDC: no
real money moves.**

| | |
|---|---|
| Website | https://bountycam.app |
| API | https://api.bountycam.app (live, devnet) |
| APK | GitHub Releases on this repository (`bountycam-1.0.0.apk`, package `app.bountycam`) |
| dApp Store | v1.0.0 submitted, in review |
| Escrow program (devnet) | `6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS` |
| Support | support@bountycam.app |

## Try it on a phone

1. Install the APK from Releases on an Android phone (Seeker or any Android 7+), allowing
   installs from your browser.
2. Have a Solana wallet app that supports **Mobile Wallet Adapter** (Seed Vault Wallet on Seeker,
   Phantom or Solflare), set to **devnet**, with a little devnet SOL from
   https://faucet.solana.com.
3. Open BountyCam and **Sign in with wallet** (Sign-In With Solana through MWA).
4. **As a Scout:** *Find bounties* lists funded bounties within 50 km of you. Accept one (your
   wallet signs), go within the capture radius, capture the requested photos and submit. You
   need only devnet SOL.
5. **As a requester:** *Create a bounty* and *Fund* it. Funding needs BountyCam's **test USDC**
   (mint `ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR`), which we mint on request: email
   support@bountycam.app with your devnet wallet address.

The full loop needs two wallets, ideally on two phones: one requests, one scouts. The demo video
shows it end to end on a Seeker (requester) and a Samsung A30 (Scout).

## How it works

```
Android app (Expo / React Native, MWA)
   │  HTTPS                                  devnet
   ▼
API (Node 22, Fastify) ── Postgres 16 + PostGIS        Escrow program (Anchor, Rust)
   │                    └─ evidence store (S3 API)        ▲
   └─ verifier (re-hashes evidence, attests, releases) ───┘
```

- **Escrow** (`programs/escrow`): create and fund, accept with an eligibility voucher, submit an
  attestation, approve, reject with a named requirement, release after silence, arbiter resolve,
  expire. USDC sits in a program-derived vault until a settling instruction moves it.
- **Evidence**: photos go straight from the phone to private storage through presigned URLs and
  never pass through the API. The phone signs a manifest of their hashes; the verifier
  re-downloads, re-hashes and attests the Merkle root on chain. Only the root is public.
- **Wallet**: sign-in, funding, acceptance, approval and rejection are signed on the phone through
  Mobile Wallet Adapter; the server never holds a user's key. The phone checks every transaction
  against `packages/shared` before the wallet sees it.
- **Seeker**: the Seeker Genesis Token can be verified at sign-in (eligibility profiles).

## Repository

| Path | What |
|---|---|
| `apps/mobile` | The Android app (Expo 57, React Native) |
| `apps/api` | API, verifier, settlement projection, migrations, test suites |
| `packages/shared` | Canonical policy, messages, transaction checks shared by phone and server |
| `programs/escrow` | The Solana escrow program (Anchor) and its specification |
| `ops/` | Deployment (`DEPLOY.md`, Docker Compose, Caddy), store listing, website |
| `HANDOFF.md`, `DECISIONS.md`, `BACKLOG.md` | Build log, decision record (D1 to D166), plan |
| `SECURITY.md` | Trust boundaries and key custody |

## Run the code

Prerequisites: Node 22, pnpm 11.22.0, Postgres 16 with PostGIS; for the app, the Android SDK and
JDK; for the program, Rust and Anchor.

```
pnpm install --frozen-lockfile
pnpm --filter @hackathon/shared test        # shared helpers (150 tests)
cd apps/api && pnpm test                    # API suites; needs a local Postgres with PostGIS
cd programs/escrow && anchor build --ignore-keys && cargo test --locked   # program tests
cd apps/mobile && npx tsc --noEmit          # app type check
```

The API suites create and drop their own scratch databases; `USER`/`PGUSER` must name a Postgres
role that can create databases.

**Running your own backend** against devnet is possible but needs your own deployment: the
escrow program's configuration names the eligibility and attester authorities, so a server can
only work with a program instance whose keys it holds. Deploy `programs/escrow`, initialise it,
then follow `ops/DEPLOY.md` (Compose, environment, `ops/deploy/deploy.sh`). The variables the API
reads are listed in `.env.example`. The phone takes its API address from
`EXPO_PUBLIC_API_BASE_URL` at build time (`ops/DEPLOY.md` section 10 has the release build).

## Notes

- Devnet only. Rewards are test USDC with no value.
- Test fixtures under `apps/api/test/fixtures/devnet/` are recorded real devnet responses and
  database rows from live runs.
- Terms: https://bountycam.app/terms · Privacy: https://bountycam.app/privacy
