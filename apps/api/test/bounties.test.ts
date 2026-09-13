import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { canonicalise, sha256 } from "@hackathon/shared";
import type { FastifyRequest } from "fastify";
import { base58 } from "@scure/base";
import { SignJWT } from "jose";
import { buildApp } from "../src/app.ts";
import { authUser } from "../src/auth/middleware.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { Randomness } from "../src/randomness.ts";
import { isValidLat, isValidLon } from "../src/bounties/gps.ts";
import { snapLat, snapLon } from "../src/bounties/snap.ts";

// --- scratch database, same pattern as auth.test.ts ---

const dbName = `bountycam_bounties_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

// --- controlled clock: no test sleeps to reach a window boundary ---

const BASE = new Date("2026-09-12T00:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

// --- configuration through the production parser (tests 70 to 72) ---
//
// The secret is generated per run and written to a file so loadConfig reads
// it the way startup does. ZERO32 is the base58 string of 32 zero bytes —
// the section 13 vector key for both the mint and the attester allowlist.
// SOLANA_CLUSTER is deliberately absent from this env: test 72 asserts the
// devnet default flows from here into a created policy.

const ZERO32 = "11111111111111111111111111111111";

const secretDir = mkdtempSync(join(tmpdir(), "bountycam-bounties-test-"));
const secretPath = join(secretDir, "jwt-secret.hex");
writeFileSync(secretPath, Buffer.from(randomBytes(32)).toString("hex"));

const configEnv: Record<string, string> = {
  JWT_SECRET_PATH: secretPath,
  SETTLEMENT_MINT: ZERO32,
  ATTESTER_PUBKEYS: ZERO32,
};
const config = loadConfig(configEnv);

// --- randomness double (POLICY.md section 2.1, D54) ---
//
// The salt is fixed at V1's 32 bytes 00 to 1f — a plain Uint8Array, not a
// Buffer, so bytesToHex is exercised over the interface type. Its hex is the
// constant that tests 5 and 10 scan for. Requirement uuids come from a
// counter that never resets: evidence_requirements.id is a primary key, so a
// repeated uuid across tests would collide. uuidQueue lets a test inject
// exact ids (test 5 pushes V1's requirement uuid); the queue shifts first.

const V1_SALT_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const V1_SALT = Uint8Array.from({ length: 32 }, (_, i) => i);

let uuidCounter = 0;
const uuidQueue: string[] = [];
const randomness: Randomness = {
  randomBytes: () => Uint8Array.from(V1_SALT),
  randomUUID: () => {
    const queued = uuidQueue.shift();
    if (queued !== undefined) return queued;
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  },
};

// --- app under test ---

const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const app = buildApp({ config, pool, clock, randomness });

before(async () => {
  psql("postgres", `CREATE DATABASE ${dbName}`);
  execFileSync(
    "pnpm",
    ["exec", "node-pg-migrate", "--migrations-dir", "migrations", "up"],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
  psql("postgres", `DROP DATABASE IF EXISTS ${dbName}`);
  rmSync(secretDir, { recursive: true, force: true });
});

beforeEach(() => {
  nowMs = BASE.getTime();
  uuidQueue.length = 0;
});

// --- helpers ---

interface Requester {
  id: string;
  wallet: string;
  token: string;
}

async function signToken(
  sub: string,
  wallet: string,
  expMs = BASE.getTime() + 3_600_000,
): Promise<string> {
  return new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 1000))
    .setExpirationTime(new Date(expMs))
    .sign(config.jwtSecret);
}

async function seedRequester(): Promise<Requester> {
  const wallet = base58.encode(randomBytes(32));
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
    [wallet],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("users insert returned no row");
  return { id: row.id, wallet, token: await signToken(row.id, wallet) };
}

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("query returned no rows");
  return row;
}

interface CreateBody {
  title: string;
  category: string;
  idempotency_key: string;
  policy: Record<string, unknown>;
}

// V2's request body (section 13.2) with a fresh idempotency key. The key
// comes from node:crypto directly, not the randomness double: idempotency
// keys are client-generated, and the double models only server randomness.
function validBody(): CreateBody {
  return {
    title: "Photograph the storefront",
    category: "verification",
    idempotency_key: randomUUID(),
    policy: {
      acceptance_window_seconds: 86_400,
      attester_pubkey: ZERO32,
      capture_radius_m: 50,
      challenge_window_seconds: 3600,
      cluster: "devnet",
      completion_window_seconds: 7200,
      evidence_requirements: [
        {
          prompt: "Storefront with signage visible",
          required: true,
          type: "PHOTO",
        },
      ],
      lat: "40.4405556",
      lon: "-79.9961111",
      required_assurance: 3,
      reward_amount: "5000000",
      settlement_mint: ZERO32,
    },
  };
}

async function createBounty(token: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${token}` },
    payload: body as object,
  });
}

// --- middleware (POLICY.md section 12, tests 1 to 3) ---
//
// Token verification reads no database (the token carries sub and wallet),
// so these need no seeded user.

const NIL_SUB = "00000000-0000-0000-0000-000000000000";

test("01 POST /bounties without an Authorization header is TOKEN_MISSING", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/bounties",
    payload: validBody(),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_MISSING");
});

test("02 tampered token signature is TOKEN_INVALID", async () => {
  const token = await signToken(NIL_SUB, ZERO32);
  const parts = token.split(".");
  const sig = parts[2];
  if (sig === undefined) throw new Error("test token is not three segments");
  // The first base64url character holds the signature's top six bits, so
  // changing it always changes byte 0. The last character partly encodes
  // padding bits, where a flip can decode to the same bytes.
  const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  const res = await createBounty(
    `${parts[0]}.${parts[1]}.${flipped}`,
    validBody(),
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

test("03 token expired beyond the 60-second tolerance is TOKEN_EXPIRED", async () => {
  const token = await signToken(NIL_SUB, ZERO32, BASE.getTime() - 120_000);
  const res = await createBounty(token, validBody());
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_EXPIRED");
});

// --- create: success and invariants (POLICY.md section 12, tests 5 to 11) ---

const V1_HASH =
  "60b987301f7731a32c6de0ec871fae6e2e6f30dc99e2d1b202ca267d408591ea";
const V1_REQ_UUID = "11111111-1111-4111-8111-111111111111";
const UUID_V4_LOWER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("05 valid create: owner view, sixteen fields, vector V1 hash end to end", async () => {
  const requester = await seedRequester();
  // V1's fixed requirement id; the salt double already returns V1's bytes.
  uuidQueue.push(V1_REQ_UUID);
  const body = validBody();
  body.idempotency_key = "22222222-2222-4222-8222-222222222222";
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  const view = res.json();
  assert.deepEqual(Object.keys(view).sort(), [
    "category",
    "created_at",
    "id",
    "policy",
    "policy_hash",
    "program_account",
    "state",
    "title",
  ]);
  // Unsorted deliberately: JSON.parse preserves the stored text's key order,
  // so this also asserts the sixteen fields sit in canonical order.
  assert.deepEqual(Object.keys(view.policy), [
    "acceptance_window_seconds",
    "attester_pubkey",
    "capture_radius_m",
    "chain",
    "challenge_window_seconds",
    "cluster",
    "completion_window_seconds",
    "domain_tag",
    "evidence_requirements",
    "fee_amount",
    "lat",
    "lon",
    "required_assurance",
    "reward_amount",
    "salt",
    "settlement_mint",
  ]);
  // (a) The vector: the route's own build, through the HTTP path, against
  // the hash Session 7a computed by three independent routes (section 13.1).
  assert.equal(view.policy_hash, V1_HASH);
  // (b) The section 3.5 client check, after (a) deliberately: alone, this
  // recomputation proves only that the parse round-trip is stable — a bug
  // in canonicalise would sit on both sides of the equality. With (a)
  // having pinned policy_hash to the literal, (b) is the real client
  // verification path. Deleting (a) as "redundant" would silently make (b)
  // circular.
  const recomputed = sha256(
    new TextEncoder().encode(canonicalise(view.policy)),
  );
  assert.equal(Buffer.from(recomputed).toString("hex"), view.policy_hash);
});

test("06 stored canonical_json hashes to policy_hash: section 3.4 first invariant", async () => {
  const requester = await seedRequester();
  const res = await createBounty(requester.token, validBody());
  assert.equal(res.statusCode, 201);
  const stored = firstRow(
    (
      await pool.query<{ canonical_json: string; policy_hash: Buffer }>(
        `SELECT p.canonical_json, p.policy_hash
         FROM bounties b JOIN policies p ON p.id = b.policy_id
         WHERE b.id = $1`,
        [res.json().id],
      )
    ).rows,
  );
  // Independent hash route: node:crypto over the stored column's bytes, not
  // packages/shared — the two implementations must agree on the same text.
  const digest = createHash("sha256")
    .update(Buffer.from(stored.canonical_json, "utf8"))
    .digest("hex");
  assert.equal(digest, stored.policy_hash.toString("hex"));
});

test("07 canonical_json parses and re-canonicalises byte-identically: second invariant", async () => {
  const requester = await seedRequester();
  const res = await createBounty(requester.token, validBody());
  assert.equal(res.statusCode, 201);
  const stored = firstRow(
    (
      await pool.query<{ canonical_json: string }>(
        `SELECT p.canonical_json
         FROM bounties b JOIN policies p ON p.id = b.policy_id
         WHERE b.id = $1`,
        [res.json().id],
      )
    ).rows,
  );
  // Canonical text is printable ASCII (section 13), so string equality is
  // byte equality.
  assert.equal(
    canonicalise(JSON.parse(stored.canonical_json)),
    stored.canonical_json,
  );
});

test("08 stored rows per section 7.1: sequence, DRAFT, program_account, reward column", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
    { prompt: "Street number visible", required: false, type: "PHOTO" },
  ];
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  const view = res.json();
  const bounty = firstRow(
    (
      await pool.query<{
        state: string;
        program_account: string | null;
        reward_amount: string;
        policy_id: string;
      }>(
        `SELECT state, program_account, reward_amount, policy_id
         FROM bounties WHERE id = $1`,
        [view.id],
      )
    ).rows,
  );
  assert.equal(bounty.state, "DRAFT");
  assert.equal(bounty.program_account, null);
  assert.equal(String(bounty.reward_amount), "5000000");
  const requirements = await pool.query<{
    prompt: string;
    sequence: number;
    required: boolean;
  }>(
    `SELECT prompt, sequence, required FROM evidence_requirements
     WHERE policy_id = $1 ORDER BY sequence`,
    [bounty.policy_id],
  );
  assert.deepEqual(
    requirements.rows.map((row) => ({
      prompt: row.prompt,
      sequence: row.sequence,
      required: row.required,
    })),
    [
      { prompt: "Storefront with signage visible", sequence: 1, required: true },
      { prompt: "Street number visible", sequence: 2, required: false },
    ],
  );
});

test("09 location is the exact point, location_public its section 9.1 snap", async () => {
  const requester = await seedRequester();
  const res = await createBounty(requester.token, validBody());
  assert.equal(res.statusCode, 201);
  const lat = "40.4405556";
  const lon = "-79.9961111";
  // Both comparisons run inside the database: the expected points are built
  // in SQL from the same strings the request carried, so no stored
  // coordinate is ever rendered back out (section 9.1 entry rule, D64).
  const row = firstRow(
    (
      await pool.query<{ loc_ok: boolean; pub_ok: boolean }>(
        `SELECT
           ST_Equals(location::geometry,
                     ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)) AS loc_ok,
           ST_Equals(location_public::geometry,
                     ST_SetSRID(ST_MakePoint($3::float8, $4::float8), 4326)) AS pub_ok
         FROM bounties WHERE id = $5`,
        [lon, lat, snapLon(lon), snapLat(lat), res.json().id],
      )
    ).rows,
  );
  assert.equal(row.loc_ok, true);
  assert.equal(row.pub_ok, true);
});

test("10 salt source test; one-key error body; salt never in captured logs", async () => {
  const requester = await seedRequester();
  // A second app over the same deps, logging into a stream this test owns.
  let captured = "";
  const logging = buildApp({
    config,
    pool,
    clock,
    randomness,
    logger: {
      level: "info",
      stream: {
        write: (msg: string) => {
          captured += msg;
        },
      },
    },
  });
  try {
    const ok = await logging.inject({
      method: "POST",
      url: "/bounties",
      headers: { authorization: `Bearer ${requester.token}` },
      payload: validBody(),
    });
    assert.equal(ok.statusCode, 201);
    const salt = ok.json().policy.salt;
    assert.match(salt, /^[0-9a-f]{64}$/);
    // Source test (section 2.1): the double's bytes, hex-encoded.
    assert.equal(salt, V1_SALT_HEX);

    const invalid = validBody();
    invalid.title = "";
    const failed = await logging.inject({
      method: "POST",
      url: "/bounties",
      headers: { authorization: `Bearer ${requester.token}` },
      payload: invalid,
    });
    assert.equal(failed.statusCode, 400);
    // Exactly the one-key error object — deepEqual, not a field read.
    assert.deepEqual(failed.json(), { error: "INVALID_TITLE" });

    // Presence before absence: the capture must show both requests
    // completing, or an empty capture would pass the salt scan vacuously.
    const completions = captured.match(/request completed/g) ?? [];
    assert.equal(completions.length >= 2, true, "capture saw both requests");
    assert.equal(captured.includes(V1_SALT_HEX), false);
  } finally {
    await logging.close();
  }
});

test("11 requirement ids: lowercase v4, equal to the injected double's output", async () => {
  const requester = await seedRequester();
  const injected = [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  uuidQueue.push(...injected);
  const body = validBody();
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
    { prompt: "Street number visible", required: false, type: "PHOTO" },
  ];
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  const items: Array<{ id: string }> = res.json().policy.evidence_requirements;
  assert.deepEqual(
    items.map((item) => item.id),
    injected,
  );
  for (const item of items) {
    assert.match(item.id, UUID_V4_LOWER);
  }
});

test("12 cluster and settlement_mint absent: configured values appear", async () => {
  const requester = await seedRequester();
  const body = validBody();
  delete body.policy["cluster"];
  delete body.policy["settlement_mint"];
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().policy.cluster, "devnet");
  assert.equal(res.json().policy.settlement_mint, ZERO32);
});

test("13 cluster and settlement_mint present and equal to configured: 201", async () => {
  const requester = await seedRequester();
  // validBody carries both, equal to the configured values.
  const res = await createBounty(requester.token, validBody());
  assert.equal(res.statusCode, 201);
});

// --- create: body shape and field rules (tests 14 to 45) ---

// A second syntactically valid 32-byte key that is on no allowlist.
const ONES32 = base58.encode(new Uint8Array(32).fill(1));

// Every failure body is asserted as exactly the one-key error object.
async function rejects(
  token: string,
  body: unknown,
  code: string,
): Promise<void> {
  const res = await createBounty(token, body);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: code });
}

test("14 body not a JSON object is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  for (const raw of ["null", "[1,2,3]"]) {
    const res = await app.inject({
      method: "POST",
      url: "/bounties",
      headers: {
        authorization: `Bearer ${requester.token}`,
        "content-type": "application/json",
      },
      payload: raw,
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "INVALID_REQUEST" });
  }
});

test("15 a missing top-level key is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body: Partial<CreateBody> = validBody();
  delete body.title;
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("16 an unknown top-level key is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body = validBody() as CreateBody & { note?: string };
  body.note = "extra";
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("17 idempotency_key not in uuid form is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.idempotency_key = "not-a-uuid";
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("18 policy missing a required field is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body = validBody();
  delete body.policy["lat"];
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("19 policy with an unknown field is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["note"] = "extra";
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("20 a constant or assigned field in the request is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const withFee = validBody();
  withFee.policy["fee_amount"] = "0";
  await rejects(requester.token, withFee, "INVALID_REQUEST");
  const withSalt = validBody();
  withSalt.policy["salt"] = V1_SALT_HEX;
  await rejects(requester.token, withSalt, "INVALID_REQUEST");
  const withId = validBody();
  withId.policy["evidence_requirements"] = [
    {
      id: V1_REQ_UUID,
      prompt: "Storefront with signage visible",
      required: true,
      type: "PHOTO",
    },
  ];
  await rejects(requester.token, withId, "INVALID_REQUEST");
});

test("21 an integer field mistyped is INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const asString = validBody();
  asString.policy["acceptance_window_seconds"] = "86400";
  await rejects(requester.token, asString, "INVALID_REQUEST");
  const asFraction = validBody();
  asFraction.policy["acceptance_window_seconds"] = 86400.5;
  await rejects(requester.token, asFraction, "INVALID_REQUEST");
});

test("22 a lone surrogate in a prompt surfaces as INVALID_REQUEST", async () => {
  const requester = await seedRequester();
  const body = validBody();
  // A lone high surrogate: valid JSON, no UTF-8 encoding — canonicalise
  // throws SpecError at step 7, which the route maps to INVALID_REQUEST.
  body.policy["evidence_requirements"] = [
    { prompt: "broken \ud800 surrogate", required: true, type: "PHOTO" },
  ];
  await rejects(requester.token, body, "INVALID_REQUEST");
});

test("23 required_assurance -1 and 5 are INVALID_ASSURANCE", async () => {
  const requester = await seedRequester();
  for (const value of [-1, 5]) {
    const body = validBody();
    body.policy["required_assurance"] = value;
    await rejects(requester.token, body, "INVALID_ASSURANCE");
  }
});

test("24 attester_pubkey not base58 for 32 bytes is ATTESTER_NOT_ALLOWED", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["attester_pubkey"] = "not-base58-!!!";
  await rejects(requester.token, body, "ATTESTER_NOT_ALLOWED");
});

test("25 attester_pubkey valid base58 but not allowlisted is ATTESTER_NOT_ALLOWED", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["attester_pubkey"] = ONES32;
  await rejects(requester.token, body, "ATTESTER_NOT_ALLOWED");
});

test("26 cluster not the configured value is CLUSTER_NOT_ALLOWED", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["cluster"] = "mainnet";
  await rejects(requester.token, body, "CLUSTER_NOT_ALLOWED");
});

test("27 settlement_mint not the configured value is MINT_NOT_ALLOWED", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["settlement_mint"] = ONES32;
  await rejects(requester.token, body, "MINT_NOT_ALLOWED");
});

test("28 capture_radius_m 9 and 10001 are INVALID_CAPTURE_RADIUS", async () => {
  const requester = await seedRequester();
  for (const value of [9, 10_001]) {
    const body = validBody();
    body.policy["capture_radius_m"] = value;
    await rejects(requester.token, body, "INVALID_CAPTURE_RADIUS");
  }
});

test("29 each window below minimum and above maximum is INVALID_WINDOW", async () => {
  const requester = await seedRequester();
  const cases: Array<[string, number]> = [
    ["acceptance_window_seconds", 59],
    ["acceptance_window_seconds", 2_592_001],
    ["challenge_window_seconds", 59],
    ["challenge_window_seconds", 86_401],
    ["completion_window_seconds", 59],
    ["completion_window_seconds", 2_592_001],
  ];
  for (const [field, value] of cases) {
    const body = validBody();
    body.policy[field] = value;
    await rejects(requester.token, body, "INVALID_WINDOW");
  }
});

test("30 reward_amount the string 0 is INVALID_REWARD_AMOUNT", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["reward_amount"] = "0";
  await rejects(requester.token, body, "INVALID_REWARD_AMOUNT");
});

test("31 reward_amount with a leading zero is INVALID_REWARD_AMOUNT", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["reward_amount"] = "05000000";
  await rejects(requester.token, body, "INVALID_REWARD_AMOUNT");
});

test("32 reward_amount sign, full stop, exponent, non-digit are INVALID_REWARD_AMOUNT", async () => {
  const requester = await seedRequester();
  for (const value of ["+5000000", "5.0", "5e6", "5000000a"]) {
    const body = validBody();
    body.policy["reward_amount"] = value;
    await rejects(requester.token, body, "INVALID_REWARD_AMOUNT");
  }
});

test("33 reward_amount at the u64 maximum stores exactly; one above is rejected", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["reward_amount"] = "18446744073709551615";
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  const row = firstRow(
    (
      await pool.query<{ reward_amount: string }>(
        "SELECT reward_amount FROM bounties WHERE id = $1",
        [res.json().id],
      )
    ).rows,
  );
  // numeric(20,0) returns a string: exact at the value where a double-based
  // comparison could not tell the pair apart.
  assert.equal(String(row.reward_amount), "18446744073709551615");
  const over = validBody();
  over.policy["reward_amount"] = "18446744073709551616";
  await rejects(requester.token, over, "INVALID_REWARD_AMOUNT");
});

test("34 GPS alphabet violations are INVALID_GPS", async () => {
  const requester = await seedRequester();
  // A non-ASCII digit (Arabic-Indic four), a plus sign, whitespace.
  for (const value of ["4٤0.4405556", "+40.4405556", " 40.4405556"]) {
    const body = validBody();
    body.policy["lat"] = value;
    await rejects(requester.token, body, "INVALID_GPS");
  }
});

test("35 negative zero and a misplaced sign are INVALID_GPS", async () => {
  const requester = await seedRequester();
  for (const value of ["-0.0000000", "4-0.4405556"]) {
    const body = validBody();
    body.policy["lat"] = value;
    await rejects(requester.token, body, "INVALID_GPS");
  }
});

test("36 a leading zero in the integer part is INVALID_GPS", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["lat"] = "040.4405556";
  await rejects(requester.token, body, "INVALID_GPS");
});

test("37 six and eight fraction digits are INVALID_GPS", async () => {
  const requester = await seedRequester();
  for (const value of ["40.440555", "40.44055560"]) {
    const body = validBody();
    body.policy["lat"] = value;
    await rejects(requester.token, body, "INVALID_GPS");
  }
});

test("38 a missing and a doubled full stop are INVALID_GPS", async () => {
  const requester = await seedRequester();
  for (const value of ["404405556", "40..4405556"]) {
    const body = validBody();
    body.policy["lat"] = value;
    await rejects(requester.token, body, "INVALID_GPS");
  }
});

test("39 beyond-range magnitudes rejected; all four rule 7 extremes create", async () => {
  const requester = await seedRequester();
  const beyondLat = validBody();
  beyondLat.policy["lat"] = "90.0000001";
  await rejects(requester.token, beyondLat, "INVALID_GPS");
  const beyondLon = validBody();
  beyondLon.policy["lon"] = "180.0000001";
  await rejects(requester.token, beyondLon, "INVALID_GPS");
  const extremes: Array<[string, string]> = [
    ["lat", "90.0000000"],
    ["lat", "-90.0000000"],
    ["lon", "180.0000000"],
    ["lon", "-180.0000000"],
  ];
  for (const [field, value] of extremes) {
    const body = validBody();
    body.policy[field] = value;
    const res = await createBounty(requester.token, body);
    assert.equal(res.statusCode, 201, `${field} ${value}`);
  }
});

test("40 requirements empty and at 21 items are INVALID_REQUIREMENTS", async () => {
  const requester = await seedRequester();
  const empty = validBody();
  empty.policy["evidence_requirements"] = [];
  await rejects(requester.token, empty, "INVALID_REQUIREMENTS");
  const twentyOne = validBody();
  twentyOne.policy["evidence_requirements"] = Array.from(
    { length: 21 },
    (_, i) => ({ prompt: `Item ${i + 1}`, required: true, type: "PHOTO" }),
  );
  await rejects(requester.token, twentyOne, "INVALID_REQUIREMENTS");
  // D63: the list bound is checked at evidence_requirements' canonical
  // position, before lat — an empty list beside a malformed lat must
  // report the list, not the coordinate.
  const ordering = validBody();
  ordering.policy["evidence_requirements"] = [];
  ordering.policy["lat"] = "not-a-coordinate";
  await rejects(requester.token, ordering, "INVALID_REQUIREMENTS");
});

test("41 no requirement with required true is INVALID_REQUIREMENTS", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: false, type: "PHOTO" },
    { prompt: "Street number visible", required: false, type: "PHOTO" },
  ];
  await rejects(requester.token, body, "INVALID_REQUIREMENTS");
});

test("42 a requirement type other than PHOTO is REQUIREMENT_TYPE_NOT_ALLOWED", async () => {
  const requester = await seedRequester();
  const body = validBody();
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: true, type: "VIDEO" },
  ];
  await rejects(requester.token, body, "REQUIREMENT_TYPE_NOT_ALLOWED");
});

test("43 a prompt empty and at 501 code units is INVALID_REQUIREMENT_PROMPT", async () => {
  const requester = await seedRequester();
  for (const prompt of ["", "x".repeat(501)]) {
    const body = validBody();
    body.policy["evidence_requirements"] = [
      { prompt, required: true, type: "PHOTO" },
    ];
    await rejects(requester.token, body, "INVALID_REQUIREMENT_PROMPT");
  }
});

test("44 title empty and at 121 code units is INVALID_TITLE", async () => {
  const requester = await seedRequester();
  for (const title of ["", "x".repeat(121)]) {
    const body = validBody();
    body.title = title;
    await rejects(requester.token, body, "INVALID_TITLE");
  }
});

test("45 category empty and at 51 code units is INVALID_CATEGORY", async () => {
  const requester = await seedRequester();
  for (const category of ["", "x".repeat(51)]) {
    const body = validBody();
    body.category = category;
    await rejects(requester.token, body, "INVALID_CATEGORY");
  }
});

// --- idempotency (POLICY.md section 12, tests 46 to 50) ---

test("46 same key, same body, sequential: 201 replay, exactly one row", async () => {
  const requester = await seedRequester();
  const body = validBody();
  const first = await createBounty(requester.token, body);
  assert.equal(first.statusCode, 201);
  const second = await createBounty(requester.token, body);
  assert.equal(second.statusCode, 201);
  const a = first.json();
  const b = second.json();
  assert.equal(b.id, a.id);
  assert.deepEqual(b.policy, a.policy);
  assert.equal(b.policy_hash, a.policy_hash);
  // A rebuild would insert with a fresh now(); a replay returns the stored
  // row's timestamp.
  assert.equal(b.created_at, a.created_at);
  // The identical policy and hash above cannot distinguish replay from
  // rebuild on their own: the randomness double returns one fixed salt for
  // every call, so a second create that wrongly rebuilt would still hash
  // identically. The row count is the real check.
  const count = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM bounties
     WHERE requester_id = $1 AND idempotency_key = $2`,
    [requester.id, body.idempotency_key],
  );
  assert.equal(firstRow(count.rows).n, "1");
});

test("47 same key, different body: 409, nothing written", async () => {
  const requester = await seedRequester();
  const body = validBody();
  const first = await createBounty(requester.token, body);
  assert.equal(first.statusCode, 201);
  const changed = validBody();
  changed.idempotency_key = body.idempotency_key;
  changed.title = "A different title";
  const res = await createBounty(requester.token, changed);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "IDEMPOTENCY_KEY_REUSED" });
  // Nothing written: the requester is fresh in this test, so one bounty
  // row and one policy row are the first create's alone.
  const bounties = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM bounties WHERE requester_id = $1",
    [requester.id],
  );
  assert.equal(firstRow(bounties.rows).n, "1");
  const policies = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM policies WHERE requester_id = $1",
    [requester.id],
  );
  assert.equal(firstRow(policies.rows).n, "1");

  // The subtle instance of "different body": a retry that omits an optional
  // key the original sent. The built policy would be identical — the
  // configured cluster fills the omission, and the salt double is fixed —
  // but section 10.2 preserves optional-key presence in the digest, so this
  // is a different body and must 409, not replay.
  const omitted = validBody();
  omitted.idempotency_key = body.idempotency_key;
  delete omitted.policy["cluster"];
  const presence = await createBounty(requester.token, omitted);
  assert.equal(presence.statusCode, 409);
  assert.deepEqual(presence.json(), { error: "IDEMPOTENCY_KEY_REUSED" });
});

test("48 two concurrent creates with one key: both 201, same id, one row", async () => {
  assert.ok(
    pool.options.max >= 2,
    "pool must allow at least 2 connections for a real race",
  );
  const requester = await seedRequester();
  const body = validBody();
  const [first, second] = await Promise.all([
    createBounty(requester.token, body),
    createBounty(requester.token, body),
  ]);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(first.json().id, second.json().id);
  const count = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM bounties
     WHERE requester_id = $1 AND idempotency_key = $2`,
    [requester.id, body.idempotency_key],
  );
  assert.equal(firstRow(count.rows).n, "1");
});

test("49 a failed validation does not consume the key", async () => {
  const requester = await seedRequester();
  const key = randomUUID();
  const bad = validBody();
  bad.idempotency_key = key;
  bad.title = "";
  const failed = await createBounty(requester.token, bad);
  assert.equal(failed.statusCode, 400);
  assert.deepEqual(failed.json(), { error: "INVALID_TITLE" });
  const good = validBody();
  good.idempotency_key = key;
  const res = await createBounty(requester.token, good);
  assert.equal(res.statusCode, 201);
});

test("50 same body re-serialised with different key order: 201 replay", async () => {
  const requester = await seedRequester();
  const body = validBody();
  const first = await createBounty(requester.token, body);
  assert.equal(first.statusCode, 201);
  // Reverse the policy's key order and the top-level order; inject
  // serialises objects in insertion order, so the wire bytes differ while
  // the canonical form — and so the digest (section 10.2) — is unchanged.
  const reorderedPolicy: Record<string, unknown> = {};
  for (const key of Object.keys(body.policy).reverse()) {
    reorderedPolicy[key] = body.policy[key];
  }
  const reordered = {
    title: body.title,
    policy: reorderedPolicy,
    idempotency_key: body.idempotency_key,
    category: body.category,
  };
  const second = await createBounty(requester.token, reordered);
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().id, first.json().id);
});

// --- discovery (POLICY.md section 12, tests 51 to 56) ---
//
// Each test queries its own patch of the globe, so one test's seeded rows
// can never sit inside another's radius: 51 at (60, 30), 52 at (25, 25),
// 53 at (30, 30), 54 at (10, 10), 56 at (45, 45); 55 seeds nothing.

test("51 AVAILABLE within radius returned; two rows in distance-ascending order", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const make = async (lat: string, lon: string): Promise<string> => {
    const body = validBody();
    body.policy["lat"] = lat;
    body.policy["lon"] = lon;
    const res = await createBounty(requester.token, body);
    assert.equal(res.statusCode, 201);
    const id: string = res.json().id;
    await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
      id,
    ]);
    return id;
  };
  // Different bearings from the query point (60, 30), chosen so a planar
  // degree-space ordering flips the pair: at latitude 60 a longitude
  // degree is about half a latitude degree in metres. Snapped centres:
  // east row 0.0851 deg away but ~4.8 km; north row 0.0552 deg away but
  // ~6.1 km. Degree distance puts north first; metres put east first.
  const eastId = await make("60.0000000", "30.0800000");
  const northId = await make("60.0500000", "30.0000000");
  const res = await app.inject({
    method: "GET",
    url: "/bounties?lat=60.0000000&lon=30.0000000&radius_m=10000",
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(res.statusCode, 200);
  const items: Array<Record<string, unknown>> = res.json().bounties;
  assert.deepEqual(
    items.map((entry) => entry["id"]),
    [eastId, northId],
  );
});

test("52 DRAFT and CANCELLED rows within the radius are absent", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const at = (): CreateBody => {
    const body = validBody();
    body.policy["lat"] = "25.0000000";
    body.policy["lon"] = "25.0000000";
    return body;
  };
  const draft = await createBounty(requester.token, at());
  assert.equal(draft.statusCode, 201);
  const toCancel = await createBounty(requester.token, at());
  assert.equal(toCancel.statusCode, 201);
  // CANCELLED through the API that produces it (8.7) — no SQL seed needed.
  const cancelled = await app.inject({
    method: "POST",
    url: `/bounties/${toCancel.json().id}/cancel`,
    headers: { authorization: `Bearer ${requester.token}` },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().state, "CANCELLED");
  // Control row: AVAILABLE at the same point. Its presence proves the
  // query sees this area, so the two absences below are state-driven,
  // not a wrong-radius vacuity.
  const control = await createBounty(requester.token, at());
  assert.equal(control.statusCode, 201);
  const controlId: string = control.json().id;
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    controlId,
  ]);
  const res = await app.inject({
    method: "GET",
    url: "/bounties?lat=25.0000000&lon=25.0000000&radius_m=10000",
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(res.statusCode, 200);
  const ids = (res.json().bounties as Array<Record<string, unknown>>).map(
    (entry) => entry["id"],
  );
  assert.equal(ids.includes(controlId), true);
  assert.equal(ids.includes(draft.json().id), false);
  assert.equal(ids.includes(toCancel.json().id), false);
});

test("53 an AVAILABLE row outside the radius is absent", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const body = validBody();
  // ~22 km north of the query point — outside 10 km, inside 50 km.
  body.policy["lat"] = "30.2000000";
  body.policy["lon"] = "30.0000000";
  const created = await createBounty(requester.token, body);
  assert.equal(created.statusCode, 201);
  const id: string = created.json().id;
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    id,
  ]);
  const near = await app.inject({
    method: "GET",
    url: "/bounties?lat=30.0000000&lon=30.0000000&radius_m=10000",
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(near.statusCode, 200);
  const nearIds = (near.json().bounties as Array<Record<string, unknown>>).map(
    (entry) => entry["id"],
  );
  assert.equal(nearIds.includes(id), false);
  // Control: the same row is returned at 50 km, so the absence above is
  // the radius filter at work, not an invisible or misplaced row.
  const far = await app.inject({
    method: "GET",
    url: "/bounties?lat=30.0000000&lon=30.0000000&radius_m=50000",
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(far.statusCode, 200);
  const farIds = (far.json().bounties as Array<Record<string, unknown>>).map(
    (entry) => entry["id"],
  );
  assert.equal(farIds.includes(id), true);
});

test("54 list item keys exact; salt and requirement uuids absent from body", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const injected = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  uuidQueue.push(...injected);
  const exactLat = "10.0000000";
  const exactLon = "10.0000000";
  const body = validBody();
  body.policy["lat"] = exactLat;
  body.policy["lon"] = exactLon;
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
    { prompt: "Street number visible", required: false, type: "PHOTO" },
  ];
  const created = await createBounty(requester.token, body);
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  // Unfunded is never discoverable (7.3) and no Session 7 API funds, so
  // the state is seeded by SQL (section 12 preamble).
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    id,
  ]);

  // The scanned-for values must be real before absence means anything — a
  // scan for undefined or "" passes vacuously.
  assert.match(V1_SALT_HEX, /^[0-9a-f]{64}$/);
  for (const uuid of injected) {
    assert.match(uuid, UUID_V4_LOWER);
  }
  assert.equal(isValidLat(exactLat), true);
  assert.equal(isValidLon(exactLon), true);

  const res = await app.inject({
    method: "GET",
    url: "/bounties?lat=10.0000000&lon=10.0000000&radius_m=1000",
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(res.statusCode, 200);
  const items: Array<Record<string, unknown>> = res.json().bounties;
  const item = items.find((entry) => entry["id"] === id);
  if (item === undefined) throw new Error("created bounty not in the slice");
  // Exact key equality against the 8.2 list-item table: an extra field
  // beside the expected eight fails, not only a missing one.
  assert.deepEqual(Object.keys(item).sort(), [
    "category",
    "created_at",
    "id",
    "location_public",
    "required_assurance",
    "reward_amount",
    "state",
    "title",
  ]);
  // The whole-body property (D63): the raw serialised response — any key,
  // any depth — carries neither the salt nor a requirement uuid.
  assert.equal(res.body.includes(V1_SALT_HEX), false);
  for (const uuid of injected) {
    assert.equal(res.body.includes(uuid), false);
  }
  // Exact coordinates: not substrings of their snaps ("10.0050000"), so
  // the scan is meaningful.
  assert.equal(res.body.includes(exactLat), false);
  assert.equal(res.body.includes(exactLon), false);
});

test("55 discovery parameter failures pin their codes", async () => {
  const viewer = await seedRequester();
  // Each assert pins the code, not just the 400: the check order is the
  // property under test, and a wrong code is a wrong order.
  const queryRejects = async (query: string, code: string): Promise<void> => {
    const res = await app.inject({
      method: "GET",
      url: `/bounties?${query}`,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { error: code }, query);
  };
  // Missing lat.
  await queryRejects("lon=10.0000000&radius_m=1000", "INVALID_REQUEST");
  // Malformed lon (five fraction digits fails the section 5 profile).
  await queryRejects(
    "lat=10.0000000&lon=10.44055&radius_m=1000",
    "INVALID_GPS",
  );
  // radius_m one below and one above the 100 to 50000 bounds.
  await queryRejects(
    "lat=10.0000000&lon=10.0000000&radius_m=99",
    "INVALID_QUERY_RADIUS",
  );
  await queryRejects(
    "lat=10.0000000&lon=10.0000000&radius_m=50001",
    "INVALID_QUERY_RADIUS",
  );
  // limit one below and one above the 1 to 100 bounds.
  await queryRejects(
    "lat=10.0000000&lon=10.0000000&radius_m=1000&limit=0",
    "INVALID_REQUEST",
  );
  await queryRejects(
    "lat=10.0000000&lon=10.0000000&radius_m=1000&limit=101",
    "INVALID_REQUEST",
  );
});

test("56 limit and offset produce a deterministic slice of the 8.4 ordering", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const seeded: string[] = [];
  // Five rows east of (45, 45) at strictly increasing distances — the
  // snapped centres sit 0.015 to 0.095 lon degrees away, all inside
  // 10 km — so the full 8.4 ordering is exactly the seeding order and
  // every page boundary is unambiguous.
  const lons = [
    "45.0100000",
    "45.0300000",
    "45.0500000",
    "45.0700000",
    "45.0900000",
  ];
  for (const lon of lons) {
    const body = validBody();
    body.policy["lat"] = "45.0000000";
    body.policy["lon"] = lon;
    const res = await createBounty(requester.token, body);
    assert.equal(res.statusCode, 201);
    const id: string = res.json().id;
    await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
      id,
    ]);
    seeded.push(id);
  }
  const page = async (query: string): Promise<unknown[]> => {
    const res = await app.inject({
      method: "GET",
      url: `/bounties?lat=45.0000000&lon=45.0000000&radius_m=10000&${query}`,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(res.statusCode, 200, query);
    return (res.json().bounties as Array<Record<string, unknown>>).map(
      (entry) => entry["id"],
    );
  };
  const full = await page("limit=100&offset=0");
  assert.deepEqual(full, seeded);
  // The slices partition the full ordering: concatenated pages reproduce
  // it exactly — order, membership and boundaries, not lengths.
  const slices = [
    ...(await page("limit=2&offset=0")),
    ...(await page("limit=2&offset=2")),
    ...(await page("limit=2&offset=4")),
  ];
  assert.deepEqual(slices, seeded);
});

// --- detail (POLICY.md section 12, tests 57 to 61) ---

test("57 owner reads own DRAFT: 200 owner view, salt and requirement ids", async () => {
  const requester = await seedRequester();
  const injected = "77777777-7777-4777-8777-777777777777";
  uuidQueue.push(injected);
  const created = await createBounty(requester.token, validBody());
  assert.equal(created.statusCode, 201);
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${created.json().id}`,
    headers: { authorization: `Bearer ${requester.token}` },
  });
  assert.equal(res.statusCode, 200);
  const view = res.json();
  assert.deepEqual(Object.keys(view).sort(), [
    "category",
    "created_at",
    "id",
    "policy",
    "policy_hash",
    "program_account",
    "state",
    "title",
  ]);
  assert.equal(view.state, "DRAFT");
  // Present, and equal to the injected doubles' values — presence alone
  // would pass on any 64-hex string.
  assert.equal(view.policy.salt, V1_SALT_HEX);
  const items: Array<{ id: string }> = view.policy.evidence_requirements;
  assert.deepEqual(
    items.map((item) => item.id),
    [injected],
  );
});

test("58 a non-requester reads a DRAFT: 404 NOT_FOUND", async () => {
  const requester = await seedRequester();
  const other = await seedRequester();
  const created = await createBounty(requester.token, validBody());
  assert.equal(created.statusCode, 201);
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${created.json().id}`,
    headers: { authorization: `Bearer ${other.token}` },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "NOT_FOUND" });
});

test("59 non-requester reads AVAILABLE: public view, thirteen fields, no leaks", async () => {
  const requester = await seedRequester();
  const viewer = await seedRequester();
  const injected = [
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
  ];
  uuidQueue.push(...injected);
  const exactLat = "15.0000000";
  const exactLon = "15.0000000";
  const body = validBody();
  body.policy["lat"] = exactLat;
  body.policy["lon"] = exactLon;
  body.policy["evidence_requirements"] = [
    { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
    { prompt: "Street number visible", required: false, type: "PHOTO" },
  ];
  const created = await createBounty(requester.token, body);
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    id,
  ]);

  // Vacuity guard: every scanned-for value is a real string of the
  // expected form before its absence is asserted.
  assert.match(V1_SALT_HEX, /^[0-9a-f]{64}$/);
  for (const uuid of injected) {
    assert.match(uuid, UUID_V4_LOWER);
  }
  assert.equal(isValidLat(exactLat), true);
  assert.equal(isValidLon(exactLon), true);

  const res = await app.inject({
    method: "GET",
    url: `/bounties/${id}`,
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  assert.equal(res.statusCode, 200);
  const view = res.json();
  // Exact key equality against the 8.2 public-view table.
  assert.deepEqual(Object.keys(view).sort(), [
    "category",
    "created_at",
    "id",
    "location_public",
    "policy_hash",
    "policy_public",
    "state",
    "title",
  ]);
  // Exactly thirteen top-level fields: the sixteen minus lat, lon, salt.
  assert.deepEqual(Object.keys(view.policy_public).sort(), [
    "acceptance_window_seconds",
    "attester_pubkey",
    "capture_radius_m",
    "chain",
    "challenge_window_seconds",
    "cluster",
    "completion_window_seconds",
    "domain_tag",
    "evidence_requirements",
    "fee_amount",
    "required_assurance",
    "reward_amount",
    "settlement_mint",
  ]);
  // Requirement items carry prompt, required, type and nothing else (8.2).
  for (const item of view.policy_public.evidence_requirements) {
    assert.deepEqual(Object.keys(item).sort(), ["prompt", "required", "type"]);
  }
  // Whole-body scan, as test 54: the raw serialised response carries no
  // salt, no requirement uuid, and no exact coordinate (the exact strings
  // are not substrings of their snaps, "15.0050000").
  assert.equal(res.body.includes(V1_SALT_HEX), false);
  for (const uuid of injected) {
    assert.equal(res.body.includes(uuid), false);
  }
  assert.equal(res.body.includes(exactLat), false);
  assert.equal(res.body.includes(exactLon), false);
});

test("60 a malformed id and an absent uuid: both 404 with identical bodies", async () => {
  const viewer = await seedRequester();
  const get = (id: string) =>
    app.inject({
      method: "GET",
      url: `/bounties/${id}`,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
  const malformed = await get("not-a-uuid");
  const absent = await get("ffffffff-ffff-4fff-8fff-ffffffffffff");
  assert.equal(malformed.statusCode, 404);
  assert.equal(absent.statusCode, 404);
  assert.deepEqual(malformed.json(), { error: "NOT_FOUND" });
  // Identical to each other, byte for byte — a malformed id must be
  // indistinguishable from absence (7.3), not merely the same code.
  assert.equal(malformed.body, absent.body);
});

test("61 owner reads own CANCELLED: 200; a non-requester: 404", async () => {
  const requester = await seedRequester();
  const other = await seedRequester();
  const created = await createBounty(requester.token, validBody());
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  const cancelled = await app.inject({
    method: "POST",
    url: `/bounties/${id}/cancel`,
    headers: { authorization: `Bearer ${requester.token}` },
  });
  assert.equal(cancelled.statusCode, 200);
  const owner = await app.inject({
    method: "GET",
    url: `/bounties/${id}`,
    headers: { authorization: `Bearer ${requester.token}` },
  });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.json().state, "CANCELLED");
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${id}`,
    headers: { authorization: `Bearer ${other.token}` },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "NOT_FOUND" });
});

// --- GET /me/bounties (POLICY.md section 12, tests 62 and 63) ---

test("62 only the caller's bounties, every state, newest first", async () => {
  const caller = await seedRequester();
  const other = await seedRequester();
  // The other requester's row is seeded AVAILABLE — a publicly visible
  // state — so its absence below is requester scoping, not visibility.
  const otherCreated = await createBounty(other.token, validBody());
  assert.equal(otherCreated.statusCode, 201);
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    otherCreated.json().id,
  ]);
  // Three rows for the caller: DRAFT, CANCELLED (through the API) and
  // AVAILABLE (seeded). created_at is the column default now(), outside
  // the injectable clock, so the test seeds distinct timestamps by SQL —
  // deliberately out of insertion order, or an ordering by insertion or
  // by id could pass by accident.
  const a = await createBounty(caller.token, validBody());
  assert.equal(a.statusCode, 201);
  const b = await createBounty(caller.token, validBody());
  assert.equal(b.statusCode, 201);
  const cancelled = await app.inject({
    method: "POST",
    url: `/bounties/${b.json().id}/cancel`,
    headers: { authorization: `Bearer ${caller.token}` },
  });
  assert.equal(cancelled.statusCode, 200);
  const c = await createBounty(caller.token, validBody());
  assert.equal(c.statusCode, 201);
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [
    c.json().id,
  ]);
  const stamps: Array<[string, Date]> = [
    [a.json().id, new Date(BASE.getTime())],
    [b.json().id, new Date(BASE.getTime() + 120_000)],
    [c.json().id, new Date(BASE.getTime() + 60_000)],
  ];
  for (const [id, at] of stamps) {
    await pool.query("UPDATE bounties SET created_at = $2 WHERE id = $1", [
      id,
      at,
    ]);
  }
  const res = await app.inject({
    method: "GET",
    url: "/me/bounties",
    headers: { authorization: `Bearer ${caller.token}` },
  });
  assert.equal(res.statusCode, 200);
  const items: Array<Record<string, unknown>> = res.json().bounties;
  // Exact sequence, not membership: newest first by created_at, all
  // three states, and nothing of the other requester's — including
  // their AVAILABLE row.
  assert.deepEqual(
    items.map((entry) => entry["id"]),
    [b.json().id, c.json().id, a.json().id],
  );
  assert.deepEqual(
    items.map((entry) => entry["state"]),
    ["CANCELLED", "AVAILABLE", "DRAFT"],
  );
});

test("63 /me/bounties unknown query parameters are INVALID_REQUEST", async () => {
  const caller = await seedRequester();
  const rejectsQuery = async (query: string): Promise<void> => {
    const res = await app.inject({
      method: "GET",
      url: `/me/bounties?${query}`,
      headers: { authorization: `Bearer ${caller.token}` },
    });
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { error: "INVALID_REQUEST" }, query);
  };
  await rejectsQuery("foo=bar");
  // 8.6 accepts limit and offset only: the discovery parameters are
  // unknown here — exactly the case a reused discovery extractor would
  // wrongly pass.
  await rejectsQuery("lat=10.0000000");
  await rejectsQuery("lon=10.0000000");
  await rejectsQuery("radius_m=1000");
  // A lawful pair beside an unknown parameter still fails.
  await rejectsQuery("limit=5&offset=0&lat=10.0000000");
});

// --- configuration tests (POLICY.md section 12, tests 70 to 72) ---

// 70 and 71 spawn the real entrypoint: section 8.1 requires a non-zero exit
// before listening, which only the process boundary can show. The stderr
// match pins the failure to the field under test — without it, a missing
// JWT_SECRET_PATH would exit non-zero too and the test would pass vacuously.

const INDEX_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("70 missing SETTLEMENT_MINT: startup exits non-zero before listening", () => {
  const env = { ...process.env, JWT_SECRET_PATH: secretPath };
  delete env["SETTLEMENT_MINT"];
  delete env["SOLANA_CLUSTER"];
  env["ATTESTER_PUBKEYS"] = ZERO32;
  const result = spawnSync("node", [INDEX_PATH], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SETTLEMENT_MINT/);
});

test("71 malformed ATTESTER_PUBKEYS: startup exits non-zero before listening", () => {
  const env = { ...process.env, JWT_SECRET_PATH: secretPath };
  delete env["SOLANA_CLUSTER"];
  env["SETTLEMENT_MINT"] = ZERO32;
  env["ATTESTER_PUBKEYS"] = "not-base58-!!!";
  const result = spawnSync("node", [INDEX_PATH], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ATTESTER_PUBKEYS/);
});

test("72 SOLANA_CLUSTER absent: created policy carries devnet", async () => {
  // The app's config came from loadConfig over configEnv, which has no
  // SOLANA_CLUSTER key — the default is the production parser's, not a test
  // literal's.
  assert.equal("SOLANA_CLUSTER" in configEnv, false);
  assert.equal(config.cluster, "devnet");
  const requester = await seedRequester();
  const body = validBody();
  delete body.policy["cluster"];
  const res = await createBounty(requester.token, body);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().policy.cluster, "devnet");
});

// --- snap unit tests (POLICY.md section 12, tests 73 to 75; vector V3) ---

test("73 section 9.1 worked examples and V3 rows reproduce", () => {
  // The two positive extremes are the only clamped rows: cell 9000 clamps to
  // 8999, cell 18000 to 17999.
  assert.equal(snapLat("90.0000000"), "89.9950000");
  assert.equal(snapLon("180.0000000"), "179.9950000");
  // Exact, not clamped: -1800000000n / 100000n is -18000n with zero
  // remainder, already the lowest longitude cell.
  assert.equal(snapLon("-180.0000000"), "-179.9950000");
  // V1's coordinates (V3 rows 4 and 5).
  assert.equal(snapLat("40.4405556"), "40.4450000");
  assert.equal(snapLon("-79.9961111"), "-79.9950000");
});

test("74 -0.0000001 snaps to -0.0050000: floor division, not truncation", () => {
  // Truncation toward zero would put scaled -1 in cell 0 (centre 0.0050000);
  // floor puts it in cell -1.
  assert.equal(snapLat("-0.0000001"), "-0.0050000");
});

test("75 snap output passes the section 5 form rules; snap is deterministic", () => {
  const lats = ["90.0000000", "-0.0000001", "40.4405556"];
  const lons = ["180.0000000", "-180.0000000", "-79.9961111"];
  // Section 11 closure: a snapped coordinate must still be a valid
  // coordinate, or location_public holds something the producer boundary
  // would reject.
  for (const lat of lats) {
    const snapped = snapLat(lat);
    assert.equal(isValidLat(snapped), true, `snapLat(${lat}) form`);
    assert.equal(snapLat(lat), snapped, `snapLat(${lat}) determinism`);
  }
  for (const lon of lons) {
    const snapped = snapLon(lon);
    assert.equal(isValidLon(snapped), true, `snapLon(${lon}) form`);
    assert.equal(snapLon(lon), snapped, `snapLon(${lon}) determinism`);
  }
});

// --- middleware unit test (POLICY.md section 12, test 76) ---

test("76 authUser() on a request that did not pass requireAuth throws", () => {
  // The accessor reads a single property; a bare object stands in for a
  // request on a route that was registered without the preHandler.
  const request = {} as FastifyRequest;
  assert.throws(() => authUser(request), /without requireAuth/);
});
