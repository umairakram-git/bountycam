# The dApp Store listing — S0

**Status:** record of what was submitted on 6 October 2026 (D166).
**Style:** per D31 — no line exceeds 100 characters.

## Identity

| Field | Value |
|---|---|
| App name | BountyCam |
| Package | `app.bountycam` (permanent) |
| Publisher | individual; wallet `FsrzwgGWQJYtdEmPhcLQw5qAoS5cSZDBe5pPvxYfU7DC` (Phantom) |
| App collection | `7crpBZ2b…jZviA9i5` (minted 6 October, about 0.0176 SOL) |
| Release v1.0.0 (1) | mint `F12A21WK…x4YwtnkB`, submitted 6 October, in review |

## Text

**Subtitle** (47 of 50): Ask the real world. Someone nearby verifies it.

**Description:**

> Need something checked somewhere else? Post a Bounty: a paid question about a real place. A
> Scout nearby goes there, captures the photos you asked for inside the app, and submits them.
> The reward is locked in a Solana escrow from the moment you post, so Scouts know the job is
> funded. You review the photos and approve to pay the Scout, or reject by naming the
> requirement that was not met. Each submission is anchored on chain with a cryptographic
> receipt, while the photos themselves stay private. This release runs on Solana devnet with
> test USDC: no real money moves.

**What's new in 1.0.0:**

> First release of BountyCam.
> • Post a Bounty: a paid question about a real place, with the photos you need.
> • Rewards locked in a Solana escrow when you post.
> • Scouts find nearby bounties, accept, and capture live photos in the app.
> • Approve to pay the Scout, or reject by naming the requirement not met; an arbiter decides
>   disputes.
> • Each submission anchored on chain; photos stay private.
> Runs on Solana devnet with test USDC: no real money moves.

## Links

| Field | Value |
|---|---|
| App website | `https://bountycam.app` |
| Support email | `support@bountycam.app` (Cloudflare Email Routing, forwarded) |
| Terms of Use | `https://bountycam.app/terms` |
| Privacy Policy | `https://bountycam.app/privacy` |

The site's source is `ops/site/`, served by a Cloudflare static-assets Worker
(`weathered-brook-6939`) with `bountycam.app` as its custom domain, uploaded from the dashboard.
The Terms and the Privacy Policy name the operator as "a solo developer in Australia" (Umair's
ruling); they are not legal advice.

## Media

- Icon: `ops/listing/icon-512.png` (512 × 512, opaque). Banner: `ops/listing/banner-1200x600.png`.
- Screenshots, five, 1503 × 2672 (9:16), in order: Find (A30), bounty detail (A30), Create
  (Seeker), a paid bounty with its photos (Seeker), My bounties (Seeker). Captured with
  `adb exec-out screencap` and padded to 9:16 with `sips`; kept outside the repo. The demo
  bounty sits at a public place, not at the test location, and no screenshot shows the test
  location or a photo taken from it.
