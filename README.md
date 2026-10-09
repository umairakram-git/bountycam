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
| APK | [v1.0.2 release](https://github.com/umairakram-git/bountycam/releases/tag/v1.0.2) (`bountycam-1.0.2.apk`, package `app.bountycam`) |
| dApp Store | v1.0.2 submitted, in review |
| Demo video | https://youtu.be/aFJEaaxlAPQ (2:58, two real phones) |
| Escrow program (devnet) | [`6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS`](https://explorer.solana.com/address/6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS?cluster=devnet) |
| Test USDC mint (devnet) | [`ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR`](https://explorer.solana.com/address/ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR?cluster=devnet) |
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

## Verify the demo on chain

The bounty in the demo video, recorded on devnet on 8 October 2026 (Sydney time).

- Requester wallet (Seeker): [`9BZ1…9qP3`](https://explorer.solana.com/address/9BZ17sUdF2matCurxmdmUpD3BNabBTFmsmAVu5oY9qP3?cluster=devnet)
- Scout wallet (Samsung A30): [`7oSU…T7vW`](https://explorer.solana.com/address/7oSUM9a2PgNbFwYhFFXU5p1mrZr1hTykFWVqosNmT7vW?cluster=devnet)
- Bounty account: [`CZzs…KF12`](https://explorer.solana.com/address/CZzs6RKtkdc6fvSGxWmSqvAE2PGV4t4shm1JSdB2KF12?cluster=devnet); its vault is the test-USDC
  token account that the bounty account owns.

| Time | Step | Transaction | Test USDC |
|---|---|---|---|
| 09:14:12 | Requester creates the bounty and funds the escrow | [`3QgyAw…8KNB`](https://explorer.solana.com/tx/3QgyAwcD9rgtfSim8DGLZgmR8F9groYiVAd22RNE44ovuern96MwT1LMr4shHchvnnafD7JtrsfC6Gftt37F8KNB?cluster=devnet) | requester −5, vault +5 |
| 09:18:35 | Scout accepts (eligibility voucher checked on chain) | [`3rV4zk…cW58`](https://explorer.solana.com/tx/3rV4zkSBKTnyouHuBeJYC9QUKiYFr8yEvBTYKYzWYryALBmjCQ6p3kaHYxqiJxh4ngNxrkaFJjJ72MAFUVyacW58?cluster=devnet) | — |
| 09:43:13 | Verifier attests the evidence's Merkle root | [`2V65Ap…HSpv`](https://explorer.solana.com/tx/2V65ApZvEK9gJNC7TQokaDvBq3nyb4Ti6Sp9LgtKiLaTDYHWTC2hynaYG3BFnn6EaJ4H6qc73Chf1zKmMZKpHSpv?cluster=devnet) | — |
| 09:48:20 | Requester approves; the vault pays the Scout | [`3zoGDd…uxaj`](https://explorer.solana.com/tx/3zoGDd6vEsSgcGK9LJYUudwD6EobDS11zQSA5FGu8Z7kCJUviFf1iJMKLHLxFBzkJh7UUUKGwRZHNQ5PB7dRuxaj?cluster=devnet) | vault −5, Scout +5 |

The other ways a bounty ends, from the same deployment:

| Path | Bounty account | Transactions |
|---|---|---|
| Rejected, then resolved by the arbiter (paid to the Scout) | [`2fQF…hEgx`](https://explorer.solana.com/address/2fQFuuCbdxgLrCsPoWsFa3XBEJid2U87F1tP3rbLhEgx?cluster=devnet) | reject [`ugAuKo…LXi9`](https://explorer.solana.com/tx/ugAuKoxbsd5t8DaFYnbstDUo9PQgqFcNat6MqWkcQ2AcVAHKyKZaFqmCqXLeYyVFSq4F8tJQix7abwd9YzsLXi9?cluster=devnet), resolve [`f9QZhR…4oYv`](https://explorer.solana.com/tx/f9QZhRY1VKiUL2mYAcm7wx8eq3fVVsmH5p9Bv4NMvMsG6NFpq8jmiYPt5sqjGb3Cd39MZNSv1py7xKm8g1j4oYv?cluster=devnet) |
| Requester silent: released after the review window | [`6oHb…8exs`](https://explorer.solana.com/address/6oHbEFdoimdkF3sv2r18AnyYyD3SYxoNqAFR2WWj8exs?cluster=devnet) | release [`4BusUw…xQsZ`](https://explorer.solana.com/tx/4BusUw3cctZ7coCvMN2L7dnAQEbqohXQGrAcQX6Bxq4ZL1VfmgVjEvA9zn7wizbQ9s9QftH4jXsGYm9gt6hZxQsZ?cluster=devnet) |
| Accepted but no evidence in time: refunded to the requester | [`AfZg…4FkT`](https://explorer.solana.com/address/AfZgWdPwrhf8brJBiRKrse4kB1qaKow33hEkzXxA4FkT?cluster=devnet) | expire [`5WTgMz…iHmm`](https://explorer.solana.com/tx/5WTgMzcFcKTVi1gcThqmKiYJSp6q45qfiUa94p1rBhzEAwhipkapXsGgcbDDbwiZmzosNEQ6wF1UWHsVbMCwiHmm?cluster=devnet) |

`python3 ops/tools/txproof.py` lists every escrow transaction since a date, grouped by bounty,
from public devnet data (no keys); it writes the same tables with Explorer links.

## Who decides what

- **On chain (the escrow program):** the reward is in the vault before the bounty is listed;
  the attestation binds the accepted Scout, the evidence's Merkle root and the deadline, and
  must be signed by the configured attester (Ed25519, checked through the instructions sysvar)
  before the submission deadline; approval pays only the accepted Scout; silence releases after
  the review window; a rejection names the failed requirement and leaves the money locked until
  the arbiter resolves it to the Scout or back to the requester; an unaccepted or abandoned
  bounty refunds the requester.
- **The arbiter** is one program-level key set at initialisation (D74); nobody can name their
  own. On devnet BountyCam holds it; before mainnet it moves to a hardware wallet or multisig
  (`SECURITY-PRODUCTION.md`). It can act only on a disputed bounty, and only send the locked
  reward to the Scout or back to the requester.
- **Server checks before attesting:** the photos came from the in-app camera inside a one-time
  capture session for this bounty, within its time window and capture radius; the uploaded
  bytes match the hashes the Scout's wallet signed.
- **Not yet proven:** that the phone's reported location is true or that the photo shows
  reality. Hardware-backed device attestation and content credentials are the next step;
  until then a modified phone could fake those inputs.

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

**Building the Android app** (`ops/DEPLOY.md` section 10 has the full release procedure):

```
cd apps/mobile && npx expo prebuild --platform android --clean
cd android && EXPO_PUBLIC_API_BASE_URL=https://api.bountycam.app ./gradlew assembleRelease
```

The unsigned APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`; sign it
with your own key to install it. The published APK is signed by certificate SHA-256
`cb6d8678d485c9d1a812fa138cf39109033a4f85c4684f8bd8463d4b6f04fa38`.

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
