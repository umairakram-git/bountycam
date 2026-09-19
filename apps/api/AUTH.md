# `apps/api` — Authentication Specification (SIWS)

**Status:** normative for Session 6b. Written before implementation (Session 6a).
**Scope:** challenge issuance, SIWS verification, JWT issuance and verification, user
creation, the two migrations these require.
**Style:** per D31 — escape sequences are described in words, never written literally;
no line exceeds 100 characters.

Where this spec and the implementation disagree, the spec wins and the implementation is
buggy.

---

## 1. Sources

Every format and constant below is taken from a fetched source, not from memory.

- SIWS ABNF grammar and input fields (section 3): `phantom/sign-in-with-solana`
  README.md, commit `6f085ace640e58e64e729ac4e8452abb7d3833bb`.
- The only message parser and builder (section 3.2): `@solana/wallet-standard-util`,
  exact version `1.1.2` (npm).
- Source of the published 1.1.2 (verified below): `anza-xyz/wallet-standard`,
  `packages/core/util/src/signIn.ts`, commit
  `dbb6a9821c3d79affc05b2340310941e85d306cd`.
- MWA `sign_in_payload` and `sign_in_result` encodings, and the fallback:
  `solana-mobile/mobile-wallet-adapter`, `spec/spec.md`, commit
  `0e6d7e75626b33190f62b7675f3a1594a0c7d479`.
- Worked-vector key (section 12): RFC 8032, section 7.1, TEST 1 (rfc-editor.org).

Version-to-commit evidence for `1.1.2`: `packages/core/util/package.json` at commit
`dbb6a98` declares version 1.1.2; the npm tarball for 1.1.2 (shasum
`1e281178c04b52923ea530799c589ed64e5526bc`, verified locally) contains a `src/signIn.ts`
byte-identical to the file at that commit (empty diff). The registry entry carries no
`gitHead`, so the diff is the evidence.

---

## 2. Flow

1. App calls `POST /auth/siws/challenge` with the wallet address. Server stores a
   challenge row and returns the SIWS input fields.
2. App passes the input verbatim to the wallet: wallet-standard `signIn`, or MWA
   `authorize` with `sign_in_payload`. **Fallback** (wallet lacks sign-in support): the
   app builds the message bytes itself with `createSignInMessageText(input)` and requests
   a plain message signature. The MWA spec states this fallback explicitly ("dapp
   endpoints can manually construct the sign in message and use the sign_messages
   request", spec.md at commit `0e6d7e75`, authorize description).
3. App calls `POST /auth/siws/verify` with the signed bytes and signature exactly as the
   wallet returned them. The server verifies and parses per section 6 — identically for
   both paths, because it only ever inspects the exact signed bytes.
4. First successful verification for an address creates the user row. The server returns
   a JWT.

---

## 3. Message format

### 3.1 Grammar (quoted)

Quoted from `phantom/sign-in-with-solana` README.md, commit `6f085ac`, section "ABNF
Message Format". The `message-chain-id` rule is a single line in the source; it is
wrapped here only to keep this file within the 100-character rule.

```
sign-in-with-solana =
  message-domain %s" wants you to sign in with your Solana account:" LF
  message-address
  [ LF LF message-statement ]
  [ LF advanced-fields ]

advanced-fields =
  [ LF %s"URI: " message-uri ]
  [ LF %s"Version: " message-version ]
  [ LF %s"Chain ID: " message-chain-id ]
  [ LF %s"Nonce: " message-nonce ]
  [ LF %s"Issued At: " message-issued-at ]
  [ LF %s"Expiration Time: " message-expiration-time ]
  [ LF %s"Not Before: " message-not-before ]
  [ LF %s"Request ID: " message-request-id ]
  [ LF %s"Resources:" message-resources ]

message-domain          = authority
message-address         = 32*44( %x31-39 / %x41-48 / %x4A-4E / %x50-5A / %x61-6B / %x6D-7A )
message-statement       = 1*( reserved / unreserved / " " )
message-uri             = URI
message-version         = "1"
message-chain-id        = %s"mainnet" / %s"testnet" / %s"devnet" / %s"localnet" /
                          %s"solana:mainnet" / %s"solana:testnet" / %s"solana:devnet"
message-nonce           = 8*( ALPHA / DIGIT )
message-issued-at       = date-time
message-expiration-time = date-time
message-not-before      = date-time
message-request-id      = *pchar
message-resources       = *( LF "- " URI )
```

Fields this server issues (and therefore the only fields a valid message contains):
`domain`, `address`, `statement`, `version`, `chainId`, `nonce`, `issuedAt`,
`expirationTime`. `uri`, `notBefore`, `requestId` and `resources` are never issued; their
presence in a message is an error (section 6, `UNEXPECTED_FIELD`).

The nonce constraint `8*( ALPHA / DIGIT )` forces an alphanumeric encoding: the 128-bit
nonce travels as **32 lowercase hex characters** (16 random bytes; lowercase hex per the
shared-package convention, `packages/shared/SPEC.md` section 2).

### 3.2 Parser and builder — pinned package

`@solana/wallet-standard-util`, **exact-pinned `1.1.2`**, is the only message parser and
the only message builder anywhere in this project:

- Server: `parseSignInMessageText` parses the received bytes (decoded as UTF-8).
- Mobile fallback and tests: `createSignInMessageText` builds the message.
- **`verifySignIn` is never called.** It re-derives the message from the input fields,
  which is the template-rebuild this spec forbids (section 6), and its signature path
  runs on the package's own older crypto dependency.

Signature verification is done directly with `@noble/curves`, **exact-pinned `2.4.0`**.
Its sole dependency is `@noble/hashes` pinned exactly `2.4.0` — identical to the D33 pin.

Dependency note: `@solana/wallet-standard-util` 1.1.2 depends on `@noble/curves` with a
caret 1.8.0 range, which does not admit 2.4.0. Two instances therefore coexist in
`node_modules`. Accepted: only 2.4.0 makes verification decisions; the 1.x copy is loaded
transitively by the parser package and is otherwise unused.

Gate (amended by D104, 20 September; the original workspace version count is superseded).
`pnpm why` reports the whole workspace regardless of the directory it runs in, so it cannot
express what one package's imports resolve to. The gate is instead three checks. First, each
package's own symlink, which is what its imports follow:
`apps/api/node_modules/@noble/curves` resolves to 2.4.0, and
`packages/shared/node_modules/@noble/hashes` resolves to 2.4.0. Second, the only BountyCam
source files importing `@noble` are `apps/api/src/auth/routes.ts`,
`apps/api/test/auth.test.ts` and `packages/shared/src/index.ts`. Third, other versions in
the tree are accepted and named: `@noble/curves` 1.9.7 and `@noble/hashes` 1.8.0, inside the
isolated trees of `@solana/wallet-standard-util` and `@solana/web3.js`, neither imported by
BountyCam code and neither making a verification decision.

Parser behaviour notes (from the pinned source, commit `dbb6a98`):

- The parse pattern anchors the end of the message with "any number of trailing line
  feeds". A message with trailing line feeds parses to the same fields. Harmless here:
  the signature is verified over the exact bytes received, and the nonce is single-use,
  so no two distinct byte strings can both authenticate.
- Where the ABNF and the pinned parser disagree (the parser is more permissive inside
  fields), the parser governs what the server accepts; exactness is restored by the
  field-equality checks against the stored challenge (section 6).

---

## 4. Chain forms

The chain allowlist is configuration (`SIWS_ALLOWED_CHAINS`, default `devnet`). Accepted
forms and their canonical chain:

| Form (request `chain` or message `Chain ID`) | Canonical chain |
|---|---|
| `devnet` | `devnet` |
| `solana:devnet` | `devnet` |

Any other string — including `mainnet`, `testnet`, `localnet` and their `solana:`
prefixed forms from the grammar — is rejected with `CHAIN_NOT_ALLOWED`. Mainnet later is
a configuration change: add the canonical chain to the allowlist and its two forms to
this table. There is deliberately no `CHAIN_MISMATCH` code: while the allowlist has one
entry, a form that passes the table always maps to the stored chain, so a mismatch code
could never be returned (the D34 rule against unreachable codes).

Challenges always issue the canonical form in `chainId` (currently `devnet`).

---

## 5. Endpoints

Encodings used below:

- **base64**: RFC 4648 section 4 standard alphabet, with padding.
- **base58**: Bitcoin alphabet. A wallet address must decode to exactly 32 bytes.
- **hex**: lowercase, no prefix (shared-package convention).
- JSON request and response bodies; `Content-Type: application/json`.

### 5.1 `POST /auth/siws/challenge`

Request body:

| Field | Type | Rule |
|---|---|---|
| `address` | string | base58, decodes to exactly 32 bytes |
| `chain` | string, optional | a form from the section 4 table; default `devnet` |

The server generates the nonce (16 bytes from a cryptographically secure RNG, hex
encoded), stores the challenge row (section 11.1), then responds `200`:

| Field of `input` | Value |
|---|---|
| `domain` | configured `SIWS_DOMAIN` (open item, section 14.2) |
| `address` | echoed request address |
| `statement` | `Sign in to BountyCam. This proves you control this wallet and moves no funds.` |
| `version` | the string `1` |
| `chainId` | canonical chain (currently always `devnet`) |
| `nonce` | 32 lowercase hex characters |
| `issuedAt` | server time, ISO 8601 UTC with milliseconds (`toISOString` form) |
| `expirationTime` | `issuedAt` plus exactly 300 seconds, same form |

Response shape: `{ "input": { ... } }`. The app passes `input` unmodified to the wallet
or to `createSignInMessageText`.

Errors (all `400`): `INVALID_REQUEST`, `INVALID_ADDRESS`, `CHAIN_NOT_ALLOWED` (section 7).

### 5.2 `POST /auth/siws/verify`

Request body — field names and encodings match the MWA `sign_in_result` (spec.md at
commit `0e6d7e75`, authorize result), so the app forwards the wallet's result without
re-encoding. There is **no address field**: the address is taken only from the parsed
message.

| Field | Type | Rule |
|---|---|---|
| `signed_message` | string | base64; the exact bytes the wallet signed; max 4096 bytes decoded |
| `signature` | string | base64; decodes to exactly 64 bytes |
| `signature_type` | string, optional | if present, must equal `ed25519` |

Success `200`:

```
{ "token": "<JWT>", "user": { "id": "<uuid>", "wallet_address": "<base58>",
  "status": "ACTIVE" } }
```

(Shown wrapped; the response is one JSON object.) Errors: section 7.

### 5.3 `GET /auth/me`

Requires header `Authorization: Bearer <JWT>`. Verifies the token (section 9) and
responds `200` with `{ "id", "wallet_address", "status" }` for the token's subject.
This endpoint exists so 6b exercises token verification end to end; it becomes the auth
middleware for Session 7's protected routes. Errors: `TOKEN_MISSING`, `TOKEN_INVALID`,
`TOKEN_EXPIRED` (all `401`).

---

## 6. Verify — normative check order

The server never rebuilds the message from a template. It verifies the signature over
the exact bytes received, then parses those bytes, then checks the parsed fields against
the stored challenge. The numbered order is normative; each step names the error it
raises. **Signature verification (step 4) precedes nonce consumption (step 5).**

1. **Body shape.** All required fields present with correct JSON types; base64 decodes;
   `signed_message` at most 4096 bytes decoded; `signature` exactly 64 bytes. Failure:
   `INVALID_REQUEST` (400).
2. **Signature type.** If `signature_type` is present it must equal `ed25519`. Failure:
   `UNSUPPORTED_SIGNATURE_TYPE` (400).
3. **Parse.** Decode `signed_message` as UTF-8 and parse with `parseSignInMessageText`.
   The parsed `address` must decode from base58 to exactly 32 bytes. Failure of either:
   `MALFORMED_MESSAGE` (401).
4. **Signature.** Verify ed25519 (`@noble/curves` 2.4.0) with the parsed address's
   32 key bytes over the **exact received bytes** of `signed_message` — not a re-encoded
   or re-built form. Failure: `SIGNATURE_INVALID` (401).
5. **Nonce consumption — atomic, single-use, enforced by the database.** One statement:
   update `auth_challenges` setting `consumed_at` to the app clock passed as a bind
   parameter — never the database's own current time — where `nonce` equals the parsed
   nonce and `consumed_at` is null and `expires_at` is later than that same app-clock
   parameter, returning the full row. If no row returns,
   classify with one follow-up read of the nonce: no such row — `NONCE_UNKNOWN`;
   `consumed_at` set — `NONCE_CONSUMED`; otherwise — `NONCE_EXPIRED` (all 401). The
   consumption itself is decided solely by the atomic update.
6. **Field checks** against the returned challenge row, in order, each an exact string
   comparison unless stated:
   1. `domain` equals stored `domain` — else `DOMAIN_MISMATCH`
   2. `address` equals stored `address` — else `ADDRESS_MISMATCH`
   3. `statement` equals stored `statement` — else `STATEMENT_MISMATCH`
   4. `version` equals the string `1` — else `VERSION_MISMATCH`
   5. `Chain ID` form is in the section 4 table and maps to the stored `chain` — else
      `CHAIN_NOT_ALLOWED`
   6. `issuedAt` equals stored `issued_at_value` — else `ISSUED_AT_MISMATCH`
   7. `expirationTime` equals stored `expiration_time_value` — else
      `EXPIRATION_TIME_MISMATCH`
   8. `uri`, `notBefore`, `requestId`, `resources` all absent — else `UNEXPECTED_FIELD`
   All 401. A failed field check leaves the nonce consumed: any failed attempt burns the
   challenge and the client must request a new one. This is deliberate.
7. **User.** Upsert on the unique `wallet_address` (insert, on conflict update the
   address to itself, returning `id`, `wallet_address`, `status`) so a row is returned
   whether or not it existed. First verification creates the user; `status` is `ACTIVE`.
8. **Token.** Issue the JWT (section 9) and respond 200.

---

## 7. Error codes

One code per distinct failure; every code is returnable and has at least one 6b test.
Error responses are `{ "error": "<CODE>" }` with the HTTP status shown.

| Code | Status | Endpoint | Failure |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | both POST | body shape, undecodable base64, wrong lengths |
| `INVALID_ADDRESS` | 400 | challenge | address not base58 or not 32 bytes |
| `CHAIN_NOT_ALLOWED` | 400 | challenge | request chain form not in section 4 table |
| `UNSUPPORTED_SIGNATURE_TYPE` | 400 | verify | `signature_type` present, not `ed25519` |
| `MALFORMED_MESSAGE` | 401 | verify | bytes do not parse; or message address invalid |
| `SIGNATURE_INVALID` | 401 | verify | ed25519 verification failed |
| `NONCE_UNKNOWN` | 401 | verify | no challenge with the parsed nonce |
| `NONCE_CONSUMED` | 401 | verify | challenge already consumed |
| `NONCE_EXPIRED` | 401 | verify | challenge past expiry |
| `DOMAIN_MISMATCH` | 401 | verify | parsed domain differs from stored |
| `ADDRESS_MISMATCH` | 401 | verify | parsed address differs from stored |
| `STATEMENT_MISMATCH` | 401 | verify | parsed statement differs from stored |
| `VERSION_MISMATCH` | 401 | verify | parsed version is not the string `1` |
| `CHAIN_NOT_ALLOWED` | 401 | verify | message chain form not in table or wrong chain |
| `ISSUED_AT_MISMATCH` | 401 | verify | parsed issuedAt differs from stored |
| `EXPIRATION_TIME_MISMATCH` | 401 | verify | parsed expirationTime differs from stored |
| `UNEXPECTED_FIELD` | 401 | verify | uri, notBefore, requestId or resources present |
| `TOKEN_MISSING` | 401 | me | no bearer token |
| `TOKEN_INVALID` | 401 | me | bad signature, wrong alg (incl. none), iss or aud |
| `TOKEN_EXPIRED` | 401 | me | token past exp beyond tolerance |

---

## 8. Clock and skew

- The API has **one injectable clock**. Production injects the system clock; 6b tests
  inject a controlled clock (no sleeping in expiry tests).
- The challenge expiry predicate compares `expires_at` to the **app clock passed as a
  bind parameter** in the atomic update — never the database's own current time — so
  issuance and expiry read the same clock and tests control both.
- **Clock-skew tolerance: 60 seconds**, applied only to JWT time claims on verify
  (jose clock tolerance option). Challenge times need no skew allowance: the same server
  issues and checks them. Informative: Phantom checks `issuedAt` within plus or minus
  10 minutes of its own clock; the 300-second challenge lifetime sits well inside that.

---

## 9. JWT

- Library: `jose`, **exact-pinned `6.2.12`** (published 2026-09-05; its major 6.0.0 is
  from 2025-02-22, so this is a mature major, not a fresh one).
- Algorithm: **HS256**. On verify the accepted-algorithms list is exactly `HS256`; any
  other algorithm, including `none`, is rejected (`TOKEN_INVALID`).
- Secret: 256 random bits as 64 lowercase hex characters (plus optional trailing line
  feed) in a file under `~/bountycam-keys/`, mode 600, path from env `JWT_SECRET_PATH`.
  The HMAC key is the **32 bytes decoded from the hex**, not the hex text itself.
  Generated in 6b (`openssl rand -hex 32`), never committed, never logged.
- Claims:

| Claim | Value |
|---|---|
| `sub` | `users.id` (uuid) |
| `wallet` | base58 wallet address |
| `iss` | env `JWT_ISSUER`, default `bountycam-api` |
| `aud` | env `JWT_AUDIENCE`, default `bountycam-app` |
| `iat` | issue time |
| `exp` | `iat` plus 7 days (604800 seconds), per D6 |

- Verify checks: signature, algorithm, `exp` (60-second tolerance), `iss`, `aud`.
- **No revocation** (section 14.1).

Configuration summary (all read at startup): `SIWS_DOMAIN`, `SIWS_ALLOWED_CHAINS`,
`JWT_SECRET_PATH`, `JWT_ISSUER`, `JWT_AUDIENCE`.

---

## 10. User records

- Identity key: the unique `wallet_address` (D37). `users.id` (uuid) remains the primary
  key and is the JWT `sub`.
- Created lazily on first successful verify (section 6 step 7). No registration
  endpoint.
- `status` is the enum `user_status` (section 11.2), value `ACTIVE`.

---

## 11. Migrations (prose schema — 6b writes the code)

### 11.1 Migration 3 — create `auth_challenges`

Up — one table:

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | primary key, default `gen_random_uuid()` |
| `nonce` | text | not null, **unique** — 32 lowercase hex characters |
| `address` | text | not null — base58 wallet address the challenge was issued to |
| `domain` | text | not null — exact domain string issued |
| `chain` | text | not null — canonical chain (currently `devnet`) |
| `statement` | text | not null — exact statement string issued |
| `issued_at_value` | text | not null — exact `issuedAt` string issued |
| `expiration_time_value` | text | not null — exact `expirationTime` string issued |
| `expires_at` | timestamptz | not null — same instant as `expiration_time_value` |
| `consumed_at` | timestamptz | null — set once by the atomic consume update |
| `created_at` | timestamptz | not null, default `now()` |

The `_value` columns store the exact strings issued so verification is string equality
against what was signed, never a re-rendering of a timestamp. The unique constraint on
`nonce` provides the lookup index.

Down: drop table `auth_challenges`.

### 11.2 Migration 4 — `users.status` to uppercase enum (D20)

Up:

1. Create type `user_status` as enum with the **single value `ACTIVE`** — the only value
   Session 6 code can produce. No unreachable variants (D34 and the `Cancelled`
   finding); later sessions that introduce suspension add values by migration.
2. On `users.status`: drop the default; alter the column type to `user_status` using
   upper of the existing value cast to the enum; set default `ACTIVE`.

Down: drop the default; alter the column type back to text using lower of the value;
set default `active`; drop type `user_status`. (Same pattern as migration 2's enum
conversions.)

---

## 12. Worked vector

Computed 2026-09-12 with `apps/api/scripts/siws-vector.mjs` (a reproduction script,
test key only, not used by the app), oracle `node:crypto` on Node 22.22.2. The values
in this section are the record, reproduced from the script's output at write time.
The script asserts the derived public key and the
empty-message signature against RFC 8032 section 7.1 TEST 1 as fetched from
rfc-editor.org, and exits non-zero on any mismatch. Both assertions passed:

```
RFC 8032 TEST 1 public key:  MATCH
RFC 8032 TEST 1 signature:   MATCH
```

**TEST KEY ONLY.** The seed is published in RFC 8032; it must never sign anything real.

| Item | Value |
|---|---|
| seed (hex) | `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60` |
| public key (hex) | `d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a` |
| address (base58) | `FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z` |

Input fields: `domain` `app.example.com` (placeholder — section 14.2), `statement`
`Sign in to BountyCam. This proves you control this wallet and moves no funds.`,
`version` `1`, `chainId` `devnet`, `nonce`
`00112233445566778899aabbccddeeff`, `issuedAt` `2026-09-12T00:00:00.000Z`,
`expirationTime` `2026-09-12T00:05:00.000Z`.

Message text (line breaks are single line feeds; no trailing line feed):

```
app.example.com wants you to sign in with your Solana account:
FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z

Sign in to BountyCam. This proves you control this wallet and moves no funds.

Version: 1
Chain ID: devnet
Nonce: 00112233445566778899aabbccddeeff
Issued At: 2026-09-12T00:00:00.000Z
Expiration Time: 2026-09-12T00:05:00.000Z
```

Message length: **333 bytes** as UTF-8.

Message (base64, wrapped at 76 characters — join the lines with nothing between):

```
YXBwLmV4YW1wbGUuY29tIHdhbnRzIHlvdSB0byBzaWduIGluIHdpdGggeW91ciBTb2xhbmEgYWNj
b3VudDoKRlZlbjNYNjY5eEx6c2k2TjJWOTFEb2l5ekh6ZzF1QWdxaVQ4alo5blM5NloKClNpZ24g
aW4gdG8gQm91bnR5Q2FtLiBUaGlzIHByb3ZlcyB5b3UgY29udHJvbCB0aGlzIHdhbGxldCBhbmQg
bW92ZXMgbm8gZnVuZHMuCgpWZXJzaW9uOiAxCkNoYWluIElEOiBkZXZuZXQKTm9uY2U6IDAwMTEy
MjMzNDQ1NTY2Nzc4ODk5YWFiYmNjZGRlZWZmCklzc3VlZCBBdDogMjAyNi0wOS0xMlQwMDowMDow
MC4wMDBaCkV4cGlyYXRpb24gVGltZTogMjAyNi0wOS0xMlQwMDowNTowMC4wMDBa
```

Signature (hex, wrapped at 64 characters — join with nothing between):

```
4460a95adf3394e0da7b738f0dca6a0eac57607cb4d88dc9ce4348d10cee24fd
e4d333ccb5bf192280d0aa57e88e5405b4ed20a5dec3eb122e6ad22efae26c09
```

Signature (base64, one line):

```
RGCpWt8zlODae3OPDcpqDqxXYHy02I3JzkNI0QzuJP3k0zPMtb8ZIoDQqlfojlQFtO0gpd7D6xIuatIu+uJsCQ==
```

Self-verify (sign then verify with the oracle): `true`.

ed25519 is deterministic, so 6b must reproduce the signature **byte-for-byte** with
`@noble/curves` 2.4.0 from the same seed and message — a cross-library check against the
`node:crypto` oracle. 6b must also reproduce the message bytes with the pinned builder
(test 10 below).

---

## 13. Session 6b test list

**Expected count: 38.** Per D36, a run is evidence only if the summary reports exactly
38 tests; the test script names its files explicitly. Tests inject the controlled clock
(section 8); no test sleeps to reach expiry. The vector key signs in tests only.

Challenge endpoint:

1. Success: 200; all 8 input fields; nonce is 32 lowercase hex; `expirationTime` is
   `issuedAt` plus 300 seconds; `chainId` is `devnet`; row stored.
2. Two challenges return distinct nonces.
3. Missing `address` — 400 `INVALID_REQUEST`.
4. `address` not valid base58 for 32 bytes — 400 `INVALID_ADDRESS`.
5. `chain` of `mainnet` — 400 `CHAIN_NOT_ALLOWED` (disallowed chain).
6. `chain` of `solana:devnet` accepted; issued `chainId` is canonical `devnet`.

Verify endpoint:

7. Round trip: message built with `createSignInMessageText` from an issued input, signed
   with the vector key — 200; token verifies; user row exists with status `ACTIVE`.
8. Second verify for the same wallet with a new challenge — same user id, no second row.
9. Vector reproduction: `@noble/curves` 2.4.0 signature over the section 12 message
   equals the vector signature exactly.
10. Builder equivalence: `createSignInMessageText` with the vector's inputs yields the
    vector's 333 message bytes exactly.
11. One tampered byte in `signed_message` (signature unchanged) — 401
    `SIGNATURE_INVALID`.
12. Signature from a different key over the same message — 401 `SIGNATURE_INVALID`.
13. Address mismatch: challenge issued to A; message carries B's address, signed by B,
    same nonce — 401 `ADDRESS_MISMATCH`.
14. Wrong domain in message — 401 `DOMAIN_MISMATCH`.
15. Wrong statement in message — 401 `STATEMENT_MISMATCH`.
16. Reused nonce: same valid message and signature submitted twice — second is 401
    `NONCE_CONSUMED`.
17. Expired nonce: clock advanced past `expires_at` — 401 `NONCE_EXPIRED`.
18. Nonce that was never issued — 401 `NONCE_UNKNOWN`.
19. Bytes that do not parse as a sign-in message — 401 `MALFORMED_MESSAGE`.
20. Version line of `2` — 401 `VERSION_MISMATCH`.
21. Chain ID line of `mainnet` in the message — 401 `CHAIN_NOT_ALLOWED`.
22. A URI line present (never issued) — 401 `UNEXPECTED_FIELD`.
23. `issuedAt` altered from the issued string — 401 `ISSUED_AT_MISMATCH`.
24. `expirationTime` altered from the issued string — 401 `EXPIRATION_TIME_MISMATCH`.
25. Failed field check burns the nonce: after test 14's failure, submitting the correct
    message for that nonce — 401 `NONCE_CONSUMED`.
26. `signature_type` of `secp256k1` — 400 `UNSUPPORTED_SIGNATURE_TYPE`.
27. `signature_type` of `ed25519` explicitly present — accepted (200).
28. `signature` decoding to 63 bytes — 400 `INVALID_REQUEST`.
29. `signed_message` not valid base64 — 400 `INVALID_REQUEST`.

Token and `GET /auth/me`:

30. Valid token — 200 with the user's `id` and `wallet_address`.
31. No Authorization header — 401 `TOKEN_MISSING`.
32. Token with algorithm `none` — 401 `TOKEN_INVALID` (JWT alg none).
33. Token signed HS512 with the correct secret — 401 `TOKEN_INVALID` (JWT wrong alg).
34. Token past `exp` beyond the 60-second tolerance — 401 `TOKEN_EXPIRED` (expired JWT).
35. Token with wrong `aud` — 401 `TOKEN_INVALID` (wrong aud).
36. Token with wrong `iss` — 401 `TOKEN_INVALID`.
37. Token with a tampered payload — 401 `TOKEN_INVALID`.

Concurrency:

38. Two concurrent verifies with the same valid nonce, submitted with `Promise.all`:
    exactly one responds 200; the other responds 401 `NONCE_CONSUMED`. Required by
    SECURITY.md section 4 — two concurrent verifies with the same nonce yield exactly
    one success; the section 6 step 5 atomic update is the mechanism under test.

Non-test gates for 6b (verified from raw output, not part of the count): migrations up,
down, up cleanly against a scratch database; `pnpm why @noble/curves` shows exactly the
two expected versions (section 3.2).

---

## 14. Accepted limits and open items

### 14.1 Accepted limits (stated, not hidden)

- **No revocation.** A 7-day token stays valid until expiry. Accepted for devnet (D8);
  revisit before any mainnet plan.
- **No rate limiting** on auth endpoints. Accepted for devnet.
- **Trusted relayer for liveness** (D2): the relayer can stall but cannot move funds.
- **Devnet only.** Mainnet is a configuration change (section 4), not a code change.
- **Seeker SGT verification deferred to the eligibility-service session.** Sign-in proves key
  possession only. Session 11 ruled it out of the mobile scope: it has no specification, and the
  check belongs server-side at voucher issuance over the SIWS-proved wallet, not on the device.

### 14.2 OPEN — `domain` value for a native Android app

Item e is **not settled by the sources**. The SIWS spec says the wallet "must determine
the domain" when the dapp does not provide one, with no rule for native apps. The MWA
spec (commit `0e6d7e75`) delegates `sign_in_payload` fields to the SIWS spec and ties
app identity to a web domain via Digital Asset Links, but never states what a wallet
places in — or whether it honours — a dapp-supplied `domain` for a native app.

Interim behaviour: the server issues the configured `SIWS_DOMAIN` (placeholder
`app.example.com`) and requires exact match on verify. **Validate on device in Session
10**: confirm the Seeker wallet echoes the supplied domain unchanged; if it substitutes
its own value, record what it sends and revisit the configured value. Do not guess.

Also OPEN — the fallback signing path. On device in Session 10, confirm that a signature
obtained via MWA `sign_messages` verifies over the exact message bytes with **no prefix**:
some signing paths prepend their own framing, which would break step 4 of section 6.
Record the result either way.
