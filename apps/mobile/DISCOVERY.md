# `apps/mobile` — Find, Read and Accept a Bounty

**Status:** normative for Session 18 (P2). Written before implementation.
**Scope:** the Scout's path on Android, from the home screen to an accepted mission whose exact
location the phone has verified.
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.

The server side is `apps/api/POLICY.md` section 16 and `apps/api/ELIGIBILITY.md`. The helpers
both sides share are `packages/shared/SPEC.md` section 9. SECURITY.md wins over this document
everywhere, and those documents win over it in their own scope. Screen content records
Umair's rulings (D123); the steps behind it are technical and normative.

---

## 1. Out of scope

Capture and the capture nonce (P3, P4); a map; notifications; filters beyond distance; any
local storage on the phone; fee sponsorship (O1).

---

## 2. Native modules

`expo-location` and `expo-camera` are added with `npx expo install`, which picks the versions
matching the Expo SDK. `app.json` gains both config plugins with their permission text. Then
`expo prebuild`, a dev-client rebuild, and installation on the A30 and the Seeker. The camera
is not used before P4 (D127 point 7).

Permission text. Location: "BountyCam uses your location to find bounties near you and to
confirm you are at a mission." Camera: "BountyCam uses the camera to capture mission
evidence."

---

## 3. Screens

Home gains two buttons, Find bounties and My missions. Five screens follow: Find, Detail,
Accepting, Mission and My missions. No navigation library, as in FUNDING.md.

### 3.1 Find

1. **Permission.** Request foreground location permission. Refused: "BountyCam needs your
   location to find bounties near you. Open Settings to allow it." with an Open Settings
   button.
2. **Position.** One fix at balanced accuracy, with a 15-second timeout. No fix: "Couldn't
   find your location. Try again." with a Try again button.
3. **Query.** Format both coordinates with `formatCoordinate` (SPEC.md section 8.1) and call
   `GET /bounties` with `radius_m` 50000 and `limit` 20. The radius is provisional, like the
   server's bounds.
4. **List.** For each item: title, category, the reward in USDC (6 decimals), and "About X km
   away" (section 4). Empty list: "No bounties near you right now."

The position is held in memory only and is sent nowhere else.

### 3.2 Detail

`GET /bounties/:id`, public view. Shown: title, category, reward, each evidence prompt in
order, "Complete within N hours of accepting" from `completion_window_seconds`, and "About X
km away. Exact spot shown after you accept." Never shown: the requester's wallet,
`program_account`, or any other identifier of the requester.

One button: "Accept — earn <reward> USDC".

### 3.3 Accepting

In order. A failure at steps 1 to 6 stops before the wallet opens, with the message given.

1. **Wallet.** `getAddress()` must equal the session's wallet. Else: "Accept from the wallet
   you signed in with." The voucher names the signed-in wallet.
2. **Balance**, over the client RPC: at least 20000 lamports. Else: "This wallet needs a
   little devnet SOL." A courtesy check (SECURITY.md section 12).
3. **Voucher.** `POST /bounties/:id/voucher`. Errors map to:

| Answer | The phone shows |
|---|---|
| `BOUNTY_RESERVED` | "Another Scout is accepting this bounty. Try again in a few minutes." |
| `BOUNTY_NOT_ACCEPTABLE` | "This bounty is no longer available." |
| `ACCEPTANCE_WINDOW_CLOSED` | "This bounty has closed." |
| `SCOUT_IS_REQUESTER` | "You posted this bounty." |
| `SEEKER_NOT_HELD` | "This bounty needs a Seeker in this wallet." |
| `SEEKER_ALREADY_CLAIMED` | "This Seeker is linked to another BountyCam account." |
| `ACCOUNT_NOT_ACTIVE` | "Your account can't accept bounties right now." |
| 503, or no answer | "Couldn't reach BountyCam. Try again." |
| anything else | "This bounty can't be accepted right now." |

4. **Check the voucher.** Decode `message` and `signature` from base64 and `authority` from
   base58, and run `checkVoucher` (SPEC.md section 9.3). `expected`: the compiled program id
   and deployment id 2; `uuidBytes(id)`; the session's wallet; `policy_hash` from the view;
   the registry hash for `policy_public.eligibility_profile_id`;
   `policy_public.required_assurance`; the compiled eligibility authority
   `Bg6SsTTH6EX5AaeQQ9i4yhDTwsSjxnHx9AV8cqa97xmp`. Failure: "Something went wrong preparing
   this transaction. Nothing was sent."
5. **Build.** Two instructions: the ed25519 instruction with data `ed25519InstructionData`
   and no keys, then `accept` with SPEC.md section 9.4's four keys and data
   `acceptData(expiresAt, 0)`. The bounty key is the view's `program_account`; the config key
   is derived and checked as FUNDING.md section 2.3 step 2 does. Fee payer the Scout; recent
   blockhash from `getLatestBlockhash` at `confirmed`. Serialise unsigned to wire bytes.
6. **Check.** Deserialise the wire bytes with `Transaction.from`, run
   `checkAcceptInstructions`, and require the fee payer to be the Scout. Failure: the step 4
   message.
7. **Sign and send**: `signAndSendTransaction(wireBytes)` (FUNDING.md section 3). A failure
   does not end the flow.
8. **Report.** `POST /bounties/:id/acceptance` every 2 seconds. Stop at the first 200 or
   409 other than `NOT_ACCEPTED`, or once the device clock passes the voucher's `expiresAt`
   plus 60 seconds.

| Answer | The phone shows |
|---|---|
| 200 | the Mission screen, after section 3.4's check |
| `ACCEPTED_BY_OTHER` | "Another Scout accepted this bounty first." |
| `BOUNTY_NOT_ACCEPTABLE` | "This bounty is no longer available." |
| `NOT_ACCEPTED` at the end | see below |
| 503 | nothing new; keep polling within the budget |

`NOT_ACCEPTED` at the end. If step 7 returned a signature: "Not confirmed yet. It will show
in My missions once it lands." If step 7 failed: "Your hold ended. The bounty may still be
available." with a Try again button (D123 ruling 3), which restarts at step 1.

If step 7 fails while the voucher is still valid, Accept is offered again at once. The
voucher endpoint reissues on the same reservation (ELIGIBILITY.md section 6), and the program
lets only one `accept` succeed.

### 3.4 Mission

Before anything is shown, `verifyAssignedPolicy` (SPEC.md section 9.5) runs on the 200 body.
The expected hash is the policy hash in the voucher just used; from My missions it is the
view's own `policy_hash` (D127). Failure: "This mission's details don't match what was
accepted. Contact support." and nothing else is shown.

Shown: "Accepted." with the title, the reward, the deadline in local time, the exact
coordinates as text, and each evidence prompt in order. Capture is P4; until then the screen
says "Capture opens in a later version."

### 3.5 My missions

`GET /me/missions`. Each item: title, reward and deadline. Tapping one calls
`GET /bounties/:id` and opens Mission through section 3.4's check. Empty: "No missions yet."

---

## 4. Distance

Great-circle distance, on the phone, from the Scout's position to `location_public`, the
snapped area centre. The server returns no distance (POLICY.md section 9.3). The snapped
centre can sit up to about 800 metres from the true point, so the figure is rounded to whole
kilometres, with a minimum of 1: "About 1 km away".

---

## 5. Configuration

`src/config.ts` gains compiled constants: the eligibility authority, deployment id 2, the
ed25519 program id and the Instructions sysvar id. The discovery radius and limit are
constants in the Find screen.

---

## 6. Verification

`apps/mobile` has no test runner. Every check on the money path is in `packages/shared`, with
tests (SPEC.md section 9.6). The device run is the test for assembly: the first accept is made
from the A30 in Session 18, and the result is read from the explorer and the database, never
from the phone's own screen (SECURITY.md section 12).
