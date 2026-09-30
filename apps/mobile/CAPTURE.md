# `apps/mobile` — Start a Capture Session

**Status:** normative for Session 19 (P3), and from section 7 for Session 20 (P4). Each part
written before its implementation.
**Scope:** the Mission screen's Start capture button: the location gate, the capture nonce
request, the countdown, and restarting (sections 2 to 6); the camera, evidence upload and the
signed submission (section 7).
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.

The server side is `apps/api/POLICY.md` section 17. The location helpers both sides share are
`packages/shared/SPEC.md` section 10. SECURITY.md wins over this document everywhere, and those
documents win over it in their own scope. Screen text records Umair's rulings (D132 to D134);
the steps behind it are technical and normative.

---

## 1. Out of scope

For sections 2 to 6: the camera, photos, evidence storage and upload, the manifest and
submission, which are section 7's; offline capture; any local storage on the phone. No native
module changes: `expo-location` is already installed (DISCOVERY.md section 2), so no rebuild is
needed.

---

## 2. What the Mission screen reads

The Mission screen already loads the assigned-Scout view (DISCOVERY.md). From it the phone takes
`policy.lat`, `policy.lon` and `policy.capture_radius_m`, `assignment.deadline`, and the
`capture` object (POLICY.md section 17.7). Every limit comes from `capture`; the phone holds no
copy of any of them.

**Server time.** On every response carrying `capture`, the phone records `offset =
server_time - phone clock at receipt`. Its estimate of the server's clock is then the phone
clock plus `offset`. Countdowns and the Start cut-off use that estimate, so a phone clock that
runs fast or slow cannot shorten or stretch them (D132).

---

## 3. The Start capture button

Shown while the server-time estimate is at or before `capture.start_closes_at`. After that the
screen reads "It's too late to start capture on this mission." and shows no button.

Pressing it runs these steps in order; the first failure stops and shows its message with the
button named in brackets:

1. **Permission.** Foreground location permission; if refused: "BountyCam needs your location
   to start capture. Open Settings to allow it." [Open Settings]
2. **Location services.** If location services are off: "Location is turned off. Turn it on in
   Settings to start capture." [Open Settings]
3. **Fix.** One fix at high accuracy, waiting at most `capture.location_fix_timeout_s`. No fix
   in time, no accuracy value in the fix, or a fix whose own timestamp is more than
   `capture.max_location_age_s` older than the phone clock: "Couldn't get your location. Move
   near a window or outside, then try again." [Try again]. The age is judged on the phone
   only, against the clock that stamped the fix (D133).
4. **Gate.** `checkCaptureStart` (SPEC.md section 10.3) with the fix, the policy's strings, the
   policy's radius and `capture.max_location_accuracy_m`.
   - `IMPRECISE`: "Your location isn't precise enough yet. Move near a window or outside, then
     try again." [Try again]
   - `TOO_FAR`: "You're about N m from the mission spot. Move closer, then try again."
     [Try again]. N is `distanceM` rounded to whole metres.
5. **Restart warning.** Only when `capture.capture_nonce` is not null: "Starting again will
   discard the photos from your current capture." [Start again] [Cancel]. Cancel keeps the
   current session untouched.
6. **Request.** `POST /bounties/:id/capture-nonce` with `lat` and `lon` from `formatCoordinate`
   (SPEC.md section 8.1), `horizontal_accuracy_m` from the fix, and `fixed_at`, the fix's
   timestamp as an ISO 8601 UTC string.

Under every failure message of steps 3 and 4 the screen shows the numbers it judged, in small
text: "Accuracy about A m · N m from the spot · fix S s old", with whichever of them it has.
They go nowhere else; a screenshot is the support record (D133).

---

## 4. Responses

- **201.** Take `capture` from the body. The session is `capture.capture_nonce`; its `id` is the
  session id. The screen reads "Capture started. Take your photos before the timer ends." with a
  countdown in minutes and seconds to `expires_at`. In P3 there is no camera.
- **`LOCATION_TOO_IMPRECISE`, `LOCATION_TOO_FAR`.** The step 4 messages. They are rare: the
  server runs the same function on the same fix.
- **`CAPTURE_WINDOW_CLOSED`.** "It's too late to start capture on this mission."
- **`BOUNTY_NOT_CAPTURABLE`, `NOT_ASSIGNED`, `NOT_FOUND`.** "This mission can no longer be
  captured." [Back to My missions]
- **No response, or any other code.** "Couldn't reach BountyCam. Check your connection and try
  again." [Try again]. Then recovery, below.

**Recovery (D134).** After any failed request the phone reloads the assigned-Scout view before
anything else and renders from its `capture`. A restart request can reach the server and lose
only its response; the view then shows the new session, and the phone adopts it. The previous
session is discarded only once a response or the view shows a different `capture_nonce.id`.

---

## 5. The countdown and expiry

The countdown runs against the server-time estimate. At zero the screen reads "Capture time has
ended. Start again to capture a new set." and shows the Start capture button again if
`start_closes_at` has not passed. A nonce is never extended; starting again always issues a new
one.

After an app restart, the Mission screen's load of the assigned-Scout view restores a live
session from `capture.capture_nonce` without calling the endpoint.

---

## 6. Connectivity

A1 needs the server to issue the nonce, so Start capture needs a connection. P3 offers no
offline start. P4 offers no offline capture either, and says so before capture begins (section
7.2, D138 ruling 1).

---

## 7. Evidence capture and submission (P4)

Session 20. Normative; written before implementation. The server side is POLICY.md section 18;
the manifest, the root and the signed statement are SPEC.md section 11. Screen text records
Umair's rulings (D138); the steps behind it are technical.

### 7.1 What P4 adds

The camera, one checklist row per requirement, hashing, upload, the signed submission, and the
submitted state. One JavaScript dependency joins: `expo-file-system` `~57.0.6`, whose native
module already ships in the installed APK (D139). No native rebuild. Section 1's "no local
storage" still holds: photos sit in the app's cache folder for the session only, and their
records in memory.

### 7.2 The checklist

While the view's `capture.capture_nonce` is live and `submission` is null, the Mission screen
shows, under the countdown, one row per entry of `policy.evidence_requirements`, in that order:
the prompt, "Required" or "Optional", and a status.

| Status | Meaning |
|---|---|
| Not taken | no photo yet; the row offers [Take photo] |
| Checking photo… | hashing (section 7.3 step 7) |
| Uploading… | the upload is running |
| Uploaded | the store accepted the photo |
| Waiting for signal | an upload failed and will retry (section 7.4) |
| Can't be used | the store or the server refused it; the reason follows, and [Take again] |

A row with a photo shows its thumbnail and [Retake]. [Take photo] and [Retake] open the back
camera full width with [Capture] and [Cancel].

Under the Start capture button, before any session exists, one line reads: "Start needs a
connection. After you start, photos can be taken with weak signal; they upload when it returns,
until the upload deadline." This is 17.9's statement before capture begins; P4 offers no offline
capture (D138 ruling 1).

While the checklist shows, the phone watches location at high accuracy, one update a second; the
watch stops when the session ends or the screen closes.

### 7.3 At the shutter

In order; a failure ends the step with its message and [Take again], and the photo's file is
deleted:

1. **Time.** If the server-time estimate is at or after `expires_at`, no photo is taken and
   section 7.6 applies.
2. **Photo.** `takePictureAsync` with quality 0.8 and no EXIF. The file stays in the cache
   folder.
3. **Fix.** The watch's latest fix. None, no accuracy, or a timestamp more than
   `capture.max_location_age_s` older than the phone clock: "Couldn't get your location for
   this photo. Move near a window or outside, then take it again."
4. **Place.** `checkCaptureStart` with the fix, the policy's `lat`, `lon` and
   `capture_radius_m`, and `capture.max_location_accuracy_m` (D143). `IMPRECISE`: "Your location
   isn't precise enough for this photo. Move near a window or outside, then take it again."
   `TOO_FAR`: "This photo was taken about N m from the mission spot. Move closer, then take it
   again." Under either, section 3's small line of judged numbers.
5. **Record.** `captured_at` is the server-time estimate at step 2, `toISOString`; `fixed_at`
   the fix's timestamp, `toISOString`; `lat` and `lon` through `formatCoordinate`;
   `horizontal_accuracy_m` through `manifestAccuracy`; `requirement_id` the row's.
6. **Read.** The file's bytes; `byte_length` is their count.
7. **Hash.** `sha256Chunked` with 65536-byte chunks and a zero-delay timer between them (D144).
   The row reads "Checking photo…"; the screen stays usable, so the next photo can be framed.
8. **Upload**, section 7.4.

The Metro log records each photo's byte length and hash time in milliseconds, for the live run.

A retake replaces the row's photo and record. The old file is deleted and its upload, if still
running, is abandoned. An object it already stored stays unused in the store (POLICY.md section
18.4).

### 7.4 Upload

1. `POST /bounties/:id/evidence/upload-url` with `capture_session_id` (the nonce's `id`),
   `requirement_id`, `photo_sha256` and `byte_length`.
2. `PUT` the file to `upload.url` with exactly `upload.headers`, as the file's raw bytes
   (`File.upload`, binary content).
3. HTTP 200 from the store: Uploaded.

No response, a 5xx or a failed PUT: the row reads "Waiting for signal" and the whole of steps 1
to 3 repeats after 2, 4, 8 and 16 seconds, then every 30 seconds, until the server-time estimate
reaches `capture_nonce.submit_by`. A fresh URL is requested each time, so an expired URL never
blocks a retry.

Refusals: `EVIDENCE_TOO_LARGE` makes the row "Can't be used: this photo is too large to upload.";
`CAPTURE_SESSION_NOT_LIVE` and `ALREADY_SUBMITTED` reload the assigned-Scout view and render from
it.

After an app restart, the session is restored from the view (section 5) but the photos are not:
the rows start as Not taken and the Scout retakes them within the same session.

### 7.5 Submit

[Submit evidence] is enabled when every required row is Uploaded, every row with a photo is
Uploaded, and the estimate is before `submit_by`. An optional row may have no photo (D138 ruling
4).

1. **Confirm.** "Submitting is final. You won't be able to retake photos after this." [Submit]
   [Cancel] (D138 ruling 3).
2. **Build.** The header from the view: `bounty_id`, `assignment.id`, `capture_nonce.value`,
   `deployment_id` from the app's configuration, `policy_hash`, `manifest_version` 1, and
   `scout`, the signed-in wallet's base58. The items: the rows with photos, in policy order.
   `evidenceRoot`, then `evidenceStatement`.
3. **Sign.** `WalletProvider.signMessage` (section 7.8) over the statement. A refusal or failure:
   "Your wallet didn't sign. Nothing was submitted." [Try again].
4. **Send.** `POST /bounties/:id/submission` with `manifest` and `signature` as hex.

Responses:

- **201 or 200.** Section 7.7's screen.
- **`EVIDENCE_NOT_UPLOADED`.** "Some photos didn't finish uploading. Uploading them again…" Every
  row runs section 7.4 again; [Submit evidence] returns when all are Uploaded, and the same
  signature is sent again, since the manifest has not changed.
- **`CAPTURE_SESSION_EXPIRED`.** Section 7.6's ended state.
- **`CAPTURE_SESSION_SUPERSEDED`, `CAPTURE_SESSION_USED`, `CAPTURE_NONCE_INVALID`,
  `ALREADY_SUBMITTED`, `BOUNTY_NOT_CAPTURABLE`, `NOT_ASSIGNED`, `NOT_FOUND`.** Reload the view and
  render from it.
- **`LOCATION_TOO_IMPRECISE`, `LOCATION_TOO_FAR`, `CAPTURED_OUTSIDE_SESSION`,
  `REQUIREMENTS_INCOMPLETE`, `UNKNOWN_REQUIREMENT`, `MANIFEST_MISMATCH`, `INVALID_MANIFEST`,
  `SUBMISSION_SIGNATURE_INVALID`, `EVIDENCE_TOO_LARGE`.** "BountyCam couldn't accept this
  submission (CODE). Your photos are still here." [Try again]. The phone checked each of these
  before sending, so seeing one means the phone and the server disagree; the code is the support
  record.
- **No response, or any other code.** Reload the view first (D134's pattern): if it shows a
  submission, section 7.7; otherwise "Couldn't reach BountyCam. Check your connection and try
  again." [Try again], which resends the same manifest and signature. The server treats an
  identical resend as the same submission (POLICY.md section 18.6 step 9).

### 7.6 Expiry and restart

When the estimate reaches `expires_at`, the camera closes and [Take photo] and [Retake] are
disabled. If every required row has a photo: "Capture time has ended. Upload and submit before
HH:MM." with `submit_by` in local time; uploads and [Submit evidence] continue until then.
Otherwise: "Capture time has ended and some required photos are missing. Start again to capture
a new set." with the Start capture button if `start_closes_at` has not passed (D138 ruling 2).

When the phone adopts a session with a different `id` (section 4's recovery), every photo of the
previous session is deleted from the cache and the checklist resets (D134).

### 7.7 After submission

When the view's `submission` is not null, the Mission screen shows "Evidence submitted at HH:MM ·
N photos. The requester's review comes next." and neither the checklist nor Start capture.

### 7.8 `WalletProvider.signMessage`

`signMessage(message: Uint8Array): Promise<WalletSignMessageResult>`, where success is `{ ok:
true, signature }` with a 64-byte `signature`, and failure is a `WalletFailure`. The MWA adapter
authorises with the cached token, refuses if the wallet's account is not the signed-in one (as
`signAndSendTransaction` does), and calls `signMessages` with that one message. A result of 64
bytes is the signature (Solflare on the A30, D139). A result of the message followed by 64 bytes
is taken as that signature. No result is `NO_SIGNATURE`; any other length is a new kind,
`SIGNATURE_SHAPE`, with the returned length as its detail; a throw is `WALLET_ERROR`.

### 7.9 The requester's side

On the requester's bounty screen, an `ACCEPTED` bounty whose owner view carries `submission`
shows "Evidence received, being checked." and "Submitted HH:MM · N photos." Nothing else about
the evidence reaches the requester before P6 (D138 ruling 5).

### 7.10 Gate

Mobile `tsc` and a Metro Android bundle, as in P3. The device evidence is POLICY.md section
18.11's live run.
