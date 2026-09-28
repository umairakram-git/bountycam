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

// --- Session 17, P1: funding (FUNDING.md section 4) ---

// The client RPC. Used only for the recent blockhash and the courtesy balance
// checks of FUNDING.md 2.3 step 3: chain data for UX, never for authorisation
// (SECURITY.md 12). The program and the API's projection are the checks.
export const SOLANA_RPC_URL = 'https://api.devnet.solana.com';

// The devnet deployment (HANDOFF.md Environment). The config account is the
// program-derived address of the seed `config`; fund.ts re-derives it and
// refuses to run if the derivation disagrees with this value.
export const ESCROW_PROGRAM_ID = '6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS';
export const ESCROW_CONFIG_ACCOUNT = 'DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb';
export const SETTLEMENT_MINT = 'ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR';

// The policy's cluster value (POLICY.md 2.1) — the canonical form, not the MWA
// selector above. Sent explicitly so a wrong environment fails at creation.
export const POLICY_CLUSTER = 'devnet';

// Display only (SECURITY.md 14): the mint has 6 decimals.
export const USDC_DECIMALS = 6;

// FUNDING.md 2.3 step 3: rent for the bounty and its vault plus the fee.
export const MIN_LAMPORTS_FOR_FUNDING = 6_000_000;

// --- Session 18, P2: discovery and accept (DISCOVERY.md section 5) ---

// The eligibility authority checkVoucher compares against (SPEC.md 9.3), and
// the deployment id of the configuration account (HANDOFF.md Environment).
// The ed25519 program and Instructions sysvar ids are packages/shared's
// ED25519_PROGRAM_ID and INSTRUCTIONS_SYSVAR_ID, one definition for both sides.
export const ELIGIBILITY_AUTHORITY = 'Bg6SsTTH6EX5AaeQQ9i4yhDTwsSjxnHx9AV8cqa97xmp';
export const DEPLOYMENT_ID = 2;

// DISCOVERY.md 3.1: provisional, like the server's bounds.
export const DISCOVERY_RADIUS_M = 50_000;
export const DISCOVERY_LIMIT = 20;

// DISCOVERY.md 3.3 step 2: two signatures' fees with headroom.
export const MIN_LAMPORTS_FOR_ACCEPT = 20_000;
