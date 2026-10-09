# Response to the Radiants advisory security audit

**Audit:** Radiants security module for CLOCK IN, run 9 October 2026 on commit `6a57130`.
**Its own summary:** "Nothing was confirmed as a defect in the code that was reviewed." The
102 code items are pattern matches marked *needs review*, mostly *low confidence*; the package
items are known advisories in dependencies.

This file answers each finding class with the code that settles it. Numbers (#n) are the
report's own. Paths are under `programs/escrow/programs/escrow/src/` unless written in full.

## Escrow program

| Report items | Finding | Answer |
|---|---|---|
| #8, #72 | Arbitrary CPI and missing owner check in `cpi_caller` | `programs/escrow/programs/cpi_caller` is a test-only program used to prove that `accept` and `submit_attestation` refuse CPI (SPEC tests 55, 69). It is excluded from the Anchor workspace (`programs/escrow/Anchor.toml`), never deployed, and its single target is pinned: `#[account(address = ESCROW_PROGRAM_ID, executable)]`. |
| #75–#80, #84, #86, #89, #94, #95, #97, #98 | CpiContext target unresolved | Every token CPI goes to `token_program: Program<'info, Token>`; Anchor checks that account's address is the SPL Token program before the handler runs. |
| #10, #13, #14 | Anyone can call `expire_accepted`, `expire_unaccepted`, `release`, which close the vault | Permissionless by design, so funds never depend on one party staying online. Each requires its state (`Accepted`, `Funded`, `Submitted`) and its deadline (`now > deadline`, `now > review_window_end`). The handler transfers the vault's **whole** balance (`bounty_vault.amount`) and writes the terminal state before closing it. The mint is pinned to the configured test USDC (`address = config.usdc_mint`), never wrapped SOL. The caller chooses nothing: destinations are fixed (next row). |
| #11, #12, #15, #81, #83, #85, #87, #92, #96, #99, #100 | Writable `requester` without a signer or constraints; missing signer check | `requester` is bound by `has_one = requester` on the bounty account in every one of these instructions, so it can only be the bounty's own requester. It is writable only to receive the vault's rent lamports on close. Instructions where the requester acts (`create_and_fund`, `cancel`, `approve`, `reject`) take `requester: Signer`. `resolve` requires `arbiter: Signer` with `address = config.arbiter_authority`. |
| #9, #16 | `scout` not validated | `constraint = bounty.scout == Some(scout.key()) @ EscrowError::ScoutMismatch` in `approve.rs` and `release.rs`; the payout account is then derived with `associated_token::authority = scout` and the configured mint. |
| #22–#27 | Two writable token accounts not constrained to be distinct | They cannot coincide. The vault is the associated token account whose authority is the bounty PDA. The payout or refund account is the associated token account of the Scout or the requester, both of whom signed a transaction earlier (`accept`, `create_and_fund`), so neither can be the off-curve bounty PDA. In `resolve`, `destination.owner` must equal the Scout or the requester and its address must equal that wallet's associated token account (`resolve.rs`, checks 3 to 5). |
| #28–#67 | Unchecked arithmetic | `overflow-checks = true` under `[profile.release]` in `programs/escrow/Cargo.toml`: an overflow aborts the transaction rather than wrapping. Most of these items are in `#[test]` code. |
| #17, #18 | Account data matching; random authority generation | Both are in `programs/escrow/programs/escrow/tests/test_escrow.rs`, the test suite, where generated keys are the point. |
| #73, #74, #82, #88, #90, #91, #93, #101 | Missing owner check | Every account the program reads is `Account<T>` (Anchor checks the owner) or a PDA with `seeds`/`bump`. The remaining `UncheckedAccount`s are never read: `requester` (above), `scout` (above) and the instructions sysvar, which `verify_ed25519_instruction` reads by the sysvar's fixed address. |
| #102 | Reinitialisation of `config` | `initialize` uses Anchor `init` on the single `[CONFIG_SEED]` PDA, which fails if the account exists, and it requires the program's upgrade authority as signer (`initialize.rs`). |

## API and tooling

| Report items | Finding | Answer |
|---|---|---|
| #1–#7 | SQL assembled by concatenation | Constant string literals split over lines with `+` (for example `apps/api/src/acceptance/project.ts`). Every value is a bound parameter (`$1`, `$2`, …); no request data enters SQL text. |
| #19 | Server fetches a URL from request data (`apps/api/scripts/settle.mjs:163`) | `settle.mjs` is the arbiter's command-line tool run on the operator's laptop, not a server endpoint. It reads evidence from the configured store, by keys from the database, and checks each file's SHA-256 against the recorded hash. |
| #68–#71 | `@solana/web3.js` v1 | Known. The app's wallet layer, `@solana-mobile/mobile-wallet-adapter-protocol-web3js`, is built on v1; the API does not import it. Moving to `@solana/kit` is pre-mainnet work (below). |
| #20, #21, packages #12–#13 | Base image by tag; container runs as root | Known and stated in `ops/DEPLOY.md` section 9. The fix (digest-pinned `node` image, non-root `USER`) is a redeploy of the live devnet backend and is scheduled after judging rather than during it. |

## Packages

| Package | Comes in through | Exposure | Action |
|---|---|---|---|
| stream-json 1.9.1, uuid 8.3.2 | `jayson` ← `@solana/web3.js` v1, used by the Android app for Mobile Wallet Adapter transactions | The app loads only `jayson/lib/client/browser`, which uses `uuid.v4()`; the advisory concerns v3/v5/v6 with a caller-supplied buffer. stream-json is used by jayson's server-side stream parser, which the app never loads. The API reads the chain with plain JSON-RPC over `fetch` (`apps/api/src/chain/rpc.ts`), not web3.js. | Goes with the web3.js v1 replacement. |
| uuid 7.0.3 | `xcode` ← Expo build tooling | Build time only, on the developer's machine; not in the APK or the server. | None needed. |
| ed25519-dalek 1.0.1, curve25519-dalek 3.2.0, libsecp256k1 0.6.0, rand 0.7.3 | `solana-keypair`, `agave-precompiles` (the `litesvm` test harness) | Test-time only. The on-chain program verifies Ed25519 signatures through Solana's native Ed25519 program and the instructions sysvar, not through these crates. | None needed for the program. |
| bincode 1.3.3, ansi_term 0.12.1, derivative 2.2.0, paste 1.0.15 | `anchor-lang`, `litesvm`, `ark-*` (Solana SDK) | "Unmaintained" notices, not vulnerabilities. | Follows Anchor and Solana SDK upgrades. |

## Before mainnet

The real items, none of which changes the devnet build the demo runs on:

1. A digest-pinned, non-root server image (already a stated limit in `ops/DEPLOY.md` section 9).
2. The arbiter key on a hardware wallet or multisig, with a rotation mechanism
   (`SECURITY-PRODUCTION.md`).
3. Replacing `@solana/web3.js` v1 in the app's wallet layer, which also removes the jayson,
   stream-json and uuid 8 advisories.
