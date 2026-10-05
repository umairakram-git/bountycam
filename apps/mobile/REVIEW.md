# `apps/mobile` — Review, Approve, Reject and the Outcome

**Status:** normative for Session 22 (P6). Written before implementation.
**Scope:** the requester's review of a submitted bounty, `approve` and `reject` from the Seeker,
and the lines and explorer links both sides see after settlement.
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.

The server side is `apps/api/POLICY.md` section 20. The transaction checks are
`packages/shared/SPEC.md` section 13. SECURITY.md wins over this document everywhere. Screen text
records Umair's rulings (D155); the steps behind it are technical and normative.

---

## 1. Out of scope

Photo zoom, a dispute screen beyond its line, the arbiter's side (`settle.mjs`, POLICY.md section
20.10), and reputation (O4). Error, empty and loading polish stays O8's.

## 2. The requester's bounty screen

For a bounty in `SUBMITTED` whose `submission.verification` is `VERIFIED` (CAPTURE.md section 8.2
keeps its lines above this section):

1. **Photos.** On load the phone calls `GET /bounties/:id/evidence` and shows each item's photo
   under its requirement's prompt, taken from the owner view's policy by `requirement_id`, in
   policy order. The URLs are never logged or stored. When `expires_at` has passed, the next view
   of a photo reloads the list first. A failed load shows "Couldn't load the photos." with a Try
   again button.
2. **Deadline line.** When `submission.review_ends_at` is set: "Reject by HH:MM", in the phone's
   local time.
3. **Approve** (section 3), always offered in `SUBMITTED`.
4. **Reject** (section 4), offered only while the phone's clock is more than 30 seconds before
   `review_ends_at`. The margin covers drift between the phone and the cluster; the program
   decides in the end (D155 ruling 4).

While a sequence is running, both buttons are disabled.

## 3. Approve

1. **Confirm.** "Pay N USDC to the Scout? This can't be undone." with Pay and Cancel. N is
   `formatUsdc` of the policy's reward.
2. **Wallet.** The wallet is the session's wallet, as FUNDING.md section 2.3 step 1.
3. **Policy.** `verifyAssignedPolicy` (shared SPEC.md section 9.5) of the owner view against its
   own `policy_hash`: the requester's phone checks the hash of what it is shown.
4. **Addresses.** The bounty address derived from the requester and the bounty id equals the
   view's `program_account`; config, mint and vault derive as in funding.
5. **Scout.** Read the bounty account at `confirmed`. Its owner is the escrow program and
   `submittedScout` (shared SPEC.md section 13.4) returns the Scout; the payout account is the
   Scout's associated token account for the mint.
6. **Build** the two instructions with the requester as fee payer, and run
   `checkApproveInstructions`. Any failure stops here: "Something went wrong preparing this
   transaction. Nothing was sent."
7. **Sign and send** through MWA `signAndSendTransactions`.
8. **Report.** Whatever step 7 returned, call `POST /bounties/:id/settlement` every 2 seconds, up
   to 45 times, until the state leaves `SUBMITTED`. Then show the view.

Failures before step 7 send nothing and say so. A wallet refusal shows "Payment cancelled.
Nothing was sent." after step 8 confirms the state is still `SUBMITTED`.

## 4. Reject

1. **Choose.** The policy's requirements as a list; exactly one can be selected. No text field.
   Reject stays disabled until one is selected (D155 ruling 3).
2. **Confirm.** "Reject '[prompt]'? The arbiter will decide who is paid." with Reject and Cancel.
3. As section 3 steps 2 to 4.
4. **Build** one instruction with `rejectData(uuidBytes(id))`, the requester as fee payer, and
   run `checkRejectInstructions`.
5. As section 3 steps 7 and 8, until the state leaves `SUBMITTED`.

## 5. Outcome lines

The bounty's `settlement` and `dispute` (POLICY.md section 20.8) choose the line; N is the reward.
`[requirement]` is the prompt of `dispute.failed_requirement_id` in the view's policy, or "a
requirement not in this bounty" when the id is null.

- `DISPUTED`. Requester: "Disputed: [requirement]. The arbiter will decide." Scout: "The
  requester disputed '[requirement]'. The arbiter will decide."
- `PAID`, `APPROVED` or `RELEASED`. Requester: "Paid N USDC to the Scout." Scout: "Paid N USDC."
- `PAID`, `RESOLVED_PAID`. Requester: "Arbiter paid the Scout." Scout: "Paid N USDC."
- `REFUNDED`, `RESOLVED_REFUNDED`. Requester: "Arbiter refunded you." Scout: "The arbiter
  refunded the requester."
- `REFUNDED`, `EXPIRED_REFUNDED`. Requester: "Your USDC was returned after the deadline." Scout:
  "This mission ended without payment."

The last item covers D155 ruling 7's three bounties and every later expiry. Its lines are the
architect's, keeping CAPTURE.md section 8's wording; Umair may replace them.

## 6. Explorer link

Under every line of a `PAID` or `REFUNDED` bounty, on both sides: "View on Solana Explorer",
opening `https://explorer.solana.com/tx/<settlement.tx_signature>?cluster=devnet` in the browser.
The cluster parameter comes from configuration, never from the response.

## 7. The Scout's side

- The Mission screen is served for `DISPUTED`, `PAID` and `REFUNDED` and shows section 5's line and
  section 6's link instead of the capture controls.
- My missions lists settled missions with their state, as `GET /me/missions` now returns them.
- A Mission screen in `SUBMITTED` calls `POST /bounties/:id/settlement` once on load, so a payout
  the Scout's phone has not seen is projected when they look.

## 8. Refresh

The requester's screen calls `POST /bounties/:id/settlement` once on load in `SUBMITTED` and
`DISPUTED`, so a silent release or a resolution shows without waiting for the verifier's pass. No
new background polling.

## 9. Gate

Mobile `tsc` and a Metro Android bundle. No native module is added, so no rebuild: the explorer
link opens through React Native's `Linking`. The device evidence is POLICY.md section 20.14.
