# `apps/mobile` — Start a Capture Session

**Status:** normative for Session 19 (P3). Written before implementation. P4 extends it with
the camera, evidence and submission.
**Scope:** the Mission screen's Start capture button: the location gate, the capture nonce
request, the countdown, and restarting.
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.

The server side is `apps/api/POLICY.md` section 17. The location helpers both sides share are
`packages/shared/SPEC.md` section 10. SECURITY.md wins over this document everywhere, and those
documents win over it in their own scope. Screen text records Umair's rulings (D132 to D134);
the steps behind it are technical and normative.

---

## 1. Out of scope

The camera, photos, evidence storage and upload, the manifest and submission (P4); offline
capture; any local storage on the phone. No native module changes: `expo-location` is already
installed (DISCOVERY.md section 2), so no rebuild is needed.

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
offline start. P4 decides whether to offer offline capture, and must say before capture begins
that such evidence cannot reach A1 (D73).
