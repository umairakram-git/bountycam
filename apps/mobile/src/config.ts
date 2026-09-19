// Device-side configuration for the Session 12 SIWS sign-in run.

// The handset reaches the laptop's API through `adb reverse tcp:3000 tcp:3000`,
// which maps the device's own loopback to the host's. So 127.0.0.1 here is
// correct on device — not a LAN address, not a tunnel.
export const API_BASE_URL = 'http://127.0.0.1:3000';

// AUTH.md 14.2 is an OPEN item: the SIWS spec says the wallet "must determine
// the domain" when the dapp supplies none, and says nothing about a native app;
// the MWA spec delegates `sign_in_payload` to SIWS and never states whether a
// wallet honours a dapp-supplied `domain` or substitutes its own identity host.
//
// So this `uri` is chosen to make the answer unambiguous when we read the
// message back off the device:
//
//   - `bountycam.invalid` is a reserved, permanently non-resolving domain
//     (RFC 6761), so nothing here can accidentally succeed against a real host;
//   - it is deliberately DIFFERENT from the server's configured SIWS_DOMAIN.
//
// The returned message must therefore name its own source. If the `Domain:`
// line carries SIWS_DOMAIN, the wallet honoured the supplied payload. If it
// carries this identity host — or if a `URI:` line appears at all — the wallet
// substituted its identity, and verify answers with DOMAIN_MISMATCH or
// UNEXPECTED_FIELD (AUTH.md 7). Either outcome is the measurement this session
// exists to take. A 401 here is data, not a defect.
export const APP_IDENTITY = { name: 'BountyCam', uri: 'https://bountycam.invalid' };

// There are TWO chain values in this flow and they are deliberately different.
// They must never be unified into one constant:
//
//   chain:   'solana:devnet'  — this value. The MWA cluster selector passed to
//                               authorize(). Its type is `Chain =
//                               IdentifierString | Cluster`, and
//                               IdentifierString is `${string}:${string}`, so
//                               the colon form is required here.
//
//   chainId: 'devnet'         — NOT this value. A field of the SIWS message,
//                               issued by the server, in the canonical form of
//                               AUTH.md section 4. It arrives inside the
//                               challenge `input` and is passed through to the
//                               wallet untouched; this file never supplies it.
//
// For the same reason the challenge request sends no `chain` field at all —
// see apps/mobile/src/auth/signIn.ts.
export const MWA_CHAIN = 'solana:devnet';
