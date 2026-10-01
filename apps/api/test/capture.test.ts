import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { SignJWT } from "jose";
import { buildApp } from "../src/app.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import type { AccountInfo, ChainReader } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { SeekerCheck } from "../src/eligibility/deps.ts";
import { systemRandomness, type Randomness } from "../src/randomness.ts";
import { consumeCaptureNonce, type ConsumeInput } from "../src/capture/nonce.ts";
import { distanceM, formatCoordinate } from "@hackathon/shared";

// POLICY.md section 17.11. The seeds are the recorded Session 18 accept, as in
// acceptance.test.ts: the bounty is re-created through the API under a
// randomness double that replays the recorded salt and requirement ids, then
// the recorded account is projected through section 16.7, giving an ACCEPTED
// bounty and its Scout's acceptance. Clock and randomness are injected.

// --- fixtures ---

const FIXTURES = join(process.cwd(), "test", "fixtures", "devnet");

interface CreateFixture {
  id: string;
  title: string;
  category: string;
  policy_hash: string;
  policy: Record<string, unknown> & {
    salt: string;
    evidence_requirements: { id: string; prompt: string; required: boolean; type: string }[];
    settlement_mint: string;
    lat: string;
    lon: string;
  };
  requester_wallet: string;
  program_account: string;
  acceptance_cutoff: string;
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, "accept_create_response.json"), "utf8")) as
  CreateFixture;
const accountResponse = JSON.parse(readFileSync(join(FIXTURES, "accepted_account.json"), "utf8")) as
  { result: { value: { owner: string; data: [string, string] } } };
const recordedAccount: AccountInfo = {
  owner: accountResponse.result.value.owner,
  data: Uint8Array.from(Buffer.from(accountResponse.result.value.data[0], "base64")),
};
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";
const SCOUT_WALLET = base58.encode(recordedAccount.data.slice(172, 204));
const RECORDED_DEADLINE = new DataView(
  recordedAccount.data.buffer,
  recordedAccount.data.byteOffset,
  recordedAccount.data.byteLength,
).getBigInt64(205, true);
const DEADLINE = new Date(Number(RECORDED_DEADLINE) * 1000);

// --- scratch database ---

const dbName = `bountycam_capture_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

const BASE = new Date("2026-09-28T12:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const secretDir = mkdtempSync(join(tmpdir(), "bountycam-capture-test-"));
const secretPath = join(secretDir, "jwt-secret.hex");
writeFileSync(secretPath, Buffer.from(randomBytes(32)).toString("hex"));
const configEnv = { JWT_SECRET_PATH: secretPath, SETTLEMENT_MINT: fixture.policy.settlement_mint };
const config = loadConfig(configEnv);

const vectors = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "packages", "shared", "vectors", "vectors.json"),
    "utf8",
  ),
) as { authorities: { eligibility_seed_ascii: string; eligibility_pubkey_hex: string } };
const SEED = Uint8Array.from(Buffer.from(vectors.authorities.eligibility_seed_ascii, "ascii"));
const PUBKEY = Uint8Array.from(Buffer.from(vectors.authorities.eligibility_pubkey_hex, "hex"));

const eligibilityConfig: EligibilityConfig = {
  rpcUrl: "https://rpc.example.test/",
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  configAccount: CONFIG_ACCOUNT,
  keySeed: SEED,
  keyPubkey: PUBKEY,
};
const deployment: Deployment = {
  deploymentId: 2,
  usdcMint: base58.decode(fixture.policy.settlement_mint),
  eligibilityAuthority: PUBKEY,
};
const signer = eligibilitySigner(SEED);
const seeker: SeekerCheck = { findSeekerMint: async () => null };

// --- doubles ---

const chainAccounts = new Map<string, AccountInfo>();
const chain: ChainReader = {
  async getAccount(address) {
    return chainAccounts.get(address) ?? null;
  },
};

const bytesQueue: Uint8Array[] = [];
const uuidQueue: string[] = [];
const randomness: Randomness = {
  // Unqueued calls reach the production module itself (test 06).
  randomBytes: (length) => bytesQueue.shift() ?? systemRandomness.randomBytes(length),
  randomUUID: () => uuidQueue.shift() ?? randomUUID(),
};

let captured = "";
const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const app = buildApp({
  config,
  pool,
  clock,
  randomness,
  eligibility: { config: eligibilityConfig, deployment, chain, signer, seeker },
  logger: {
    level: "info",
    stream: {
      write: (msg: string) => {
        captured += msg;
      },
    },
  },
});

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
  chainAccounts.clear();
  bytesQueue.length = 0;
  uuidQueue.length = 0;
  captured = "";
});

// --- helpers ---

interface User {
  id: string;
  wallet: string;
  token: string;
}

async function signToken(sub: string, wallet: string): Promise<string> {
  return new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 1000))
    .setExpirationTime(new Date(DEADLINE.getTime() + 3_600_000))
    .sign(config.jwtSecret);
}

async function seedUser(wallet: string = base58.encode(randomBytes(32))): Promise<User> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [wallet],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("users insert returned no row");
  return { id: row.id, wallet, token: await signToken(row.id, wallet) };
}

function recordedBody(): Record<string, unknown> {
  const p = fixture.policy;
  return {
    idempotency_key: randomUUID(),
    title: fixture.title,
    category: fixture.category,
    policy: {
      acceptance_window_seconds: p["acceptance_window_seconds"],
      capture_radius_m: p["capture_radius_m"],
      challenge_window_seconds: p["challenge_window_seconds"],
      cluster: p["cluster"],
      completion_window_seconds: p["completion_window_seconds"],
      eligibility_profile_id: p["eligibility_profile_id"],
      evidence_requirements: p.evidence_requirements.map((r) => ({
        prompt: r.prompt,
        required: r.required,
        type: r.type,
      })),
      lat: p.lat,
      lon: p.lon,
      required_assurance: p["required_assurance"],
      reward_amount: p["reward_amount"],
      settlement_mint: p.settlement_mint,
    },
  };
}

interface Accepted {
  requester: User;
  scout: User;
  assignmentId: string;
}

/**
 * The recorded bounty, created through the API, projected to AVAILABLE by SQL,
 * reserved for the recorded Scout and then projected to ACCEPTED through the
 * section 16.8 report over the recorded account.
 */
async function seedAccepted(): Promise<Accepted> {
  const requester = await seedUser(fixture.requester_wallet);
  await pool.query(
    "DELETE FROM capture_nonces WHERE bounty_id = $1",
    [fixture.id],
  );
  await pool.query("DELETE FROM assignments WHERE bounty_id = $1", [fixture.id]);
  await pool.query("DELETE FROM bounties WHERE id = $1", [fixture.id]);
  await pool.query("DELETE FROM evidence_requirements WHERE id = ANY($1::uuid[])", [
    fixture.policy.evidence_requirements.map((r) => r.id),
  ]);
  await pool.query("DELETE FROM policies WHERE policy_hash = decode($1, 'hex')", [
    fixture.policy_hash,
  ]);
  bytesQueue.push(Uint8Array.from(Buffer.from(fixture.policy.salt, "hex")));
  uuidQueue.push(...fixture.policy.evidence_requirements.map((r) => r.id));
  const created = await app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${requester.token}` },
    payload: recordedBody(),
  });
  assert.equal(created.statusCode, 201, created.body);
  await pool.query(
    `UPDATE bounties SET id = $1, state = 'AVAILABLE', program_account = $3,
            acceptance_cutoff = $4 WHERE id = $2`,
    [fixture.id, created.json().id, fixture.program_account, new Date(fixture.acceptance_cutoff)],
  );
  chainAccounts.set(fixture.program_account, recordedAccount);
  const scout = await seedUser(SCOUT_WALLET);
  await pool.query(
    "INSERT INTO assignments (bounty_id, scout_id, status, expires_at) VALUES ($1, $2, 'ACTIVE', $3)",
    [fixture.id, scout.id, new Date(BASE.getTime() + 300_000)],
  );
  const reported = await app.inject({
    method: "POST",
    url: `/bounties/${fixture.id}/acceptance`,
    headers: { authorization: `Bearer ${scout.token}` },
  });
  assert.equal(reported.statusCode, 200, reported.body);
  const row = await pool.query<{ id: string }>(
    "SELECT id FROM assignments WHERE bounty_id = $1 AND scout_id = $2 AND status = 'ACTIVE'",
    [fixture.id, scout.id],
  );
  const assignmentId = row.rows[0]?.id;
  if (assignmentId === undefined) throw new Error("no accepted assignment");
  return { requester, scout, assignmentId };
}

/** A row by SQL, for the constraint tests; `over` replaces any column. */
async function insertNonce(a: Accepted, over: Partial<Record<string, unknown>> = {}) {
  const row: Record<string, unknown> = {
    assignment_id: a.assignmentId,
    bounty_id: fixture.id,
    scout_id: a.scout.id,
    deployment_id: 2,
    value: randomBytes(32),
    status: "ACTIVE",
    issued_at: BASE,
    expires_at: new Date(BASE.getTime() + 1_200_000),
    consumed_at: null,
    start_lat: fixture.policy.lat,
    start_lon: fixture.policy.lon,
    start_accuracy_m: 12,
    start_fixed_at: BASE,
    ...over,
  };
  const keys = Object.keys(row);
  await pool.query(
    `INSERT INTO capture_nonces (${keys.join(", ")})
     VALUES (${keys.map((_, i) => "$" + String(i + 1)).join(", ")})`,
    keys.map((k) => row[k]),
  );
}

async function violates(promise: Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { constraint?: string }).constraint, constraint);
    return true;
  });
}

// --- issuance (tests 01 to 07) ---

const POLICY_LAT = fixture.policy.lat;
const POLICY_LON = fixture.policy.lon;
const RADIUS = fixture.policy["capture_radius_m"] as number;

function fixBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lat: POLICY_LAT,
    lon: POLICY_LON,
    horizontal_accuracy_m: 12,
    fixed_at: new Date(nowMs - 2000).toISOString(),
    ...over,
  };
}

// A default parameter would replace an explicit undefined, so "no body" is a marker.
const NO_BODY = Symbol("no body");

async function start(token: string, payload: unknown = fixBody()) {
  return app.inject({
    method: "POST",
    url: `/bounties/${fixture.id}/capture-nonce`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === NO_BODY ? {} : { payload: payload as Record<string, unknown> }),
  });
}

interface StoredNonce {
  id: string;
  assignment_id: string;
  bounty_id: string;
  scout_id: string;
  deployment_id: number;
  value: Buffer;
  status: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  start_lat: string;
  start_lon: string;
  start_accuracy_m: number;
  start_fixed_at: Date;
}

async function nonces(): Promise<StoredNonce[]> {
  const r = await pool.query<StoredNonce>(
    "SELECT * FROM capture_nonces WHERE bounty_id = $1 ORDER BY issued_at, status",
    [fixture.id],
  );
  return r.rows;
}

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const CAPTURE_KEYS = [
  "capture_nonce",
  "location_fix_timeout_s",
  "max_location_accuracy_m",
  "max_location_age_s",
  "server_time",
  "start_closes_at",
];

test("01 the holder starts: 201, the injected value, expiry after 1200 s, the row", async () => {
  const a = await seedAccepted();
  bytesQueue.push(bytes(0xab));
  const body = fixBody();
  const res = await start(a.scout.token, body);
  assert.equal(res.statusCode, 201, res.body);
  const cap = res.json().capture as Record<string, unknown>;
  assert.deepEqual(Object.keys(res.json() as object), ["capture"]);
  assert.deepEqual(Object.keys(cap).sort(), CAPTURE_KEYS);
  const n = cap["capture_nonce"] as Record<string, string>;
  assert.deepEqual(Object.keys(n).sort(), ["expires_at", "id", "issued_at", "submit_by", "value"]);
  assert.equal(n["value"], "ab".repeat(32));
  assert.equal(n["issued_at"], BASE.toISOString());
  assert.equal(n["expires_at"], new Date(BASE.getTime() + 1_200_000).toISOString());
  // POLICY.md section 18.7: submit_by is expires_at plus the 480 s grace.
  assert.equal(n["submit_by"], new Date(BASE.getTime() + 1_680_000).toISOString());
  const rows = await nonces();
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.id, n["id"]);
  assert.equal(r.status, "ACTIVE");
  assert.equal(r.assignment_id, a.assignmentId);
  assert.equal(r.bounty_id, fixture.id);
  assert.equal(r.scout_id, a.scout.id);
  assert.equal(r.deployment_id, 2);
  assert.equal(r.value.toString("hex"), "ab".repeat(32));
  assert.equal(r.start_lat, body["lat"]);
  assert.equal(r.start_lon, body["lon"]);
  assert.equal(r.start_accuracy_m, 12);
  assert.equal(r.start_fixed_at.toISOString(), body["fixed_at"]);
});

test("02 25 minutes before the deadline: expiry is the deadline minus 600 s", async () => {
  const a = await seedAccepted();
  nowMs = DEADLINE.getTime() - 25 * 60_000;
  const res = await start(a.scout.token);
  assert.equal(res.statusCode, 201, res.body);
  const n = res.json().capture.capture_nonce as Record<string, string>;
  assert.equal(n["expires_at"], new Date(DEADLINE.getTime() - 600_000).toISOString());
});

test("03 the latest start gives exactly 600 s; one millisecond later is closed", async () => {
  const a = await seedAccepted();
  nowMs = DEADLINE.getTime() - 1_200_000;
  const res = await start(a.scout.token);
  assert.equal(res.statusCode, 201, res.body);
  const n = res.json().capture.capture_nonce as Record<string, string>;
  assert.equal(Date.parse(n["expires_at"]!) - Date.parse(n["issued_at"]!), 600_000);
  nowMs += 1;
  const late = await start(a.scout.token);
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, "CAPTURE_WINDOW_CLOSED");
  assert.equal((await nonces()).length, 1);
});

test("04 a second start before expiry supersedes the first", async () => {
  const a = await seedAccepted();
  bytesQueue.push(bytes(1), bytes(2));
  assert.equal((await start(a.scout.token)).statusCode, 201);
  nowMs += 60_000;
  assert.equal((await start(a.scout.token)).statusCode, 201);
  const rows = await nonces();
  assert.deepEqual(rows.map((r) => r.status), ["SUPERSEDED", "ACTIVE"]);
  assert.notEqual(rows[0]!.value.toString("hex"), rows[1]!.value.toString("hex"));
});

test("05 a second start after the first expired: the first is SUPERSEDED", async () => {
  const a = await seedAccepted();
  assert.equal((await start(a.scout.token)).statusCode, 201);
  nowMs += 1_201_000;
  assert.equal((await start(a.scout.token)).statusCode, 201);
  assert.deepEqual((await nonces()).map((r) => r.status), ["SUPERSEDED", "ACTIVE"]);
});

test("06 the production randomness module gives two different values", async () => {
  const a = await seedAccepted();
  assert.equal(bytesQueue.length, 0);
  const first = (await start(a.scout.token)).json().capture.capture_nonce.value as string;
  const second = (await start(a.scout.token)).json().capture.capture_nonce.value as string;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("07 two starts sent together: both 201, one SUPERSEDED and one ACTIVE", async () => {
  const a = await seedAccepted();
  const [x, y] = await Promise.all([start(a.scout.token), start(a.scout.token)]);
  assert.equal(x.statusCode, 201, x.body);
  assert.equal(y.statusCode, 201, y.body);
  assert.deepEqual((await nonces()).map((r) => r.status).sort(), ["ACTIVE", "SUPERSEDED"]);
});

// --- refusals (tests 08 to 16) ---

async function refused(res: { statusCode: number; json(): unknown }, status: number, code: string) {
  assert.equal(res.statusCode, status);
  assert.equal((res.json() as { error: string }).error, code);
}

test("08 a user with no assignment, and the requester: NOT_ASSIGNED", async () => {
  const a = await seedAccepted();
  const other = await seedUser();
  await refused(await start(other.token), 403, "NOT_ASSIGNED");
  await refused(await start(a.requester.token), 403, "NOT_ASSIGNED");
  assert.equal((await nonces()).length, 0);
});

test("09 a reservation only: BOUNTY_NOT_CAPTURABLE", async () => {
  const a = await seedAccepted();
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [fixture.id]);
  await pool.query(
    "UPDATE assignments SET accepted_at = NULL, deadline = NULL WHERE id = $1",
    [a.assignmentId],
  );
  await refused(await start(a.scout.token), 409, "BOUNTY_NOT_CAPTURABLE");
});

test("10 EXPIRED, SUBMITTED, PAID: BOUNTY_NOT_CAPTURABLE; CANCELLED: NOT_FOUND", async () => {
  const a = await seedAccepted();
  for (const state of ["EXPIRED", "SUBMITTED", "PAID"]) {
    await pool.query("UPDATE bounties SET state = $2 WHERE id = $1", [fixture.id, state]);
    await refused(await start(a.scout.token), 409, "BOUNTY_NOT_CAPTURABLE");
  }
  await pool.query("UPDATE bounties SET state = 'CANCELLED' WHERE id = $1", [fixture.id]);
  await refused(await start(a.scout.token), 404, "NOT_FOUND");
  assert.equal((await nonces()).length, 0);
});

test("11 an earlier assignment, another Scout holding the acceptance: NOT_ASSIGNED", async () => {
  const a = await seedAccepted();
  const other = await seedUser();
  await pool.query("UPDATE assignments SET status = 'EXPIRED' WHERE id = $1", [a.assignmentId]);
  await pool.query(
    `INSERT INTO assignments (bounty_id, scout_id, status, expires_at, accepted_at, deadline)
     VALUES ($1, $2, 'ACTIVE', $3, $3, $4)`,
    [fixture.id, other.id, BASE, DEADLINE],
  );
  await refused(await start(a.scout.token), 403, "NOT_ASSIGNED");
});

test("12 malformed bodies: INVALID_REQUEST", async () => {
  const a = await seedAccepted();
  const cases: unknown[] = [
    NO_BODY,
    {},
    fixBody({ extra: 1 }),
    fixBody({ horizontal_accuracy_m: "12" }),
    fixBody({ horizontal_accuracy_m: -1 }),
    fixBody({ fixed_at: "2026-09-28T11:59:58.000" }),
  ];
  for (const payload of cases) {
    await refused(await start(a.scout.token, payload), 400, "INVALID_REQUEST");
  }
  assert.equal((await nonces()).length, 0);
});

test("13 a latitude with six fraction digits: INVALID_GPS", async () => {
  const a = await seedAccepted();
  await refused(await start(a.scout.token, fixBody({ lat: "-33.711618" })), 400, "INVALID_GPS");
});

test("14 accuracy 200.5: LOCATION_TOO_IMPRECISE; accuracy 200: 201", async () => {
  const a = await seedAccepted();
  await refused(
    await start(a.scout.token, fixBody({ horizontal_accuracy_m: 200.5 })),
    400,
    "LOCATION_TOO_IMPRECISE",
  );
  assert.equal((await start(a.scout.token, fixBody({ horizontal_accuracy_m: 200 }))).statusCode, 201);
});

test("15 north by 0.002: accuracy distance - 151 too far, distance - 149 passes", async () => {
  const a = await seedAccepted();
  const lat = formatCoordinate(Number(POLICY_LAT) + 0.002, "lat");
  const d = distanceM(Number(lat), Number(POLICY_LON), Number(POLICY_LAT), Number(POLICY_LON));
  assert.ok(d > 200 && d < 250);
  await refused(
    await start(a.scout.token, fixBody({ lat, horizontal_accuracy_m: d - RADIUS - 1 })),
    400,
    "LOCATION_TOO_FAR",
  );
  assert.equal((await nonces()).length, 0);
  const ok = await start(a.scout.token, fixBody({ lat, horizontal_accuracy_m: d - RADIUS + 1 }));
  assert.equal(ok.statusCode, 201, ok.body);
});

test("16 no token: TOKEN_MISSING; a malformed id and an unknown id: NOT_FOUND", async () => {
  const a = await seedAccepted();
  const bare = await app.inject({
    method: "POST",
    url: `/bounties/${fixture.id}/capture-nonce`,
    payload: fixBody(),
  });
  await refused(bare, 401, "TOKEN_MISSING");
  for (const id of ["not-a-uuid", randomUUID()]) {
    const res = await app.inject({
      method: "POST",
      url: `/bounties/${id}/capture-nonce`,
      headers: { authorization: `Bearer ${a.scout.token}` },
      payload: fixBody(),
    });
    await refused(res, 404, "NOT_FOUND");
  }
});

// --- views and privacy (tests 17 and 18) ---

async function view(token: string) {
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${fixture.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res;
}

test("17 the assigned-Scout view's capture key follows the session", async () => {
  const a = await seedAccepted();
  const before = (await view(a.scout.token)).json() as Record<string, any>;
  assert.deepEqual(Object.keys(before["capture"]).sort(), CAPTURE_KEYS);
  assert.equal(before["capture"]["capture_nonce"], null);
  assert.equal(before["capture"]["server_time"], BASE.toISOString());
  assert.equal(
    before["capture"]["start_closes_at"],
    new Date(DEADLINE.getTime() - 1_200_000).toISOString(),
  );
  assert.equal(before["assignment"]["id"], a.assignmentId);
  const issued = (await start(a.scout.token)).json().capture.capture_nonce;
  const during = (await view(a.scout.token)).json() as Record<string, any>;
  assert.deepEqual(during["capture"]["capture_nonce"], issued);
  assert.equal(
    during["capture"]["capture_nonce"]["submit_by"],
    new Date(Date.parse(issued.expires_at as string) + 480_000).toISOString(),
  );
  nowMs = Date.parse(issued.expires_at as string);
  const after = (await view(a.scout.token)).json() as Record<string, any>;
  assert.equal(after["capture"]["capture_nonce"], null);
});

test("18 the start fix appears in no response and no log line", async () => {
  const a = await seedAccepted();
  const lat = formatCoordinate(Number(POLICY_LAT) + 0.0001, "lat");
  const lon = formatCoordinate(Number(POLICY_LON) + 0.0001, "lon");
  const fixedAt = "2026-09-28T11:59:57.321Z";
  const payload = fixBody({ lat, lon, horizontal_accuracy_m: 17.25, fixed_at: fixedAt });
  const bodies = [(await start(a.scout.token, payload)).body];
  bodies.push((await view(a.scout.token)).body);
  bodies.push((await view(a.requester.token)).body);
  bodies.push((await view((await seedUser()).token)).body);
  const stored = (await nonces())[0]!;
  assert.equal(stored.start_lat, lat);
  for (const text of [...bodies, captured]) {
    for (const secret of [lat, lon, "17.25", fixedAt]) {
      assert.ok(!text.includes(secret), "found " + secret);
    }
  }
});

// --- consumption (tests 19 to 23) ---

async function consume(a: Accepted, valueHex: string, over: Partial<ConsumeInput> = {}) {
  const client = await pool.connect();
  try {
    return await consumeCaptureNonce(
      client,
      {
        value: Uint8Array.from(Buffer.from(valueHex, "hex")),
        bountyId: fixture.id,
        assignmentId: a.assignmentId,
        scoutId: a.scout.id,
        deploymentId: 2,
        ...over,
      },
      clock.now(),
      config.capture.submissionGraceS,
    );
  } finally {
    client.release();
  }
}

async function issue(a: Accepted): Promise<{ value: string; expires_at: string }> {
  const res = await start(a.scout.token);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().capture.capture_nonce as { value: string; expires_at: string };
}

test("19 a fresh nonce is CONSUMED once; again it is ALREADY_CONSUMED", async () => {
  const a = await seedAccepted();
  const n = await issue(a);
  nowMs += 300_000;
  assert.equal(await consume(a, n.value), "CONSUMED");
  const row = (await nonces())[0]!;
  assert.equal(row.status, "CONSUMED");
  assert.equal(row.consumed_at?.getTime(), nowMs);
  assert.equal(await consume(a, n.value), "ALREADY_CONSUMED");
});

test("20 the grace: one millisecond inside is CONSUMED; at its end, EXPIRED", async () => {
  const a = await seedAccepted();
  const first = await issue(a);
  nowMs = Date.parse(first.expires_at) + 480_000 - 1;
  assert.equal(await consume(a, first.value), "CONSUMED");
  nowMs = BASE.getTime();
  const second = await issue(a);
  nowMs = Date.parse(second.expires_at) + 480_000;
  assert.equal(await consume(a, second.value), "EXPIRED");
  const rows = await pool.query<{ status: string }>(
    "SELECT status FROM capture_nonces WHERE value = decode($1, 'hex')",
    [second.value],
  );
  assert.equal(rows.rows[0]?.status, "EXPIRED");
});

test("21 a superseded value: SUPERSEDED", async () => {
  const a = await seedAccepted();
  const first = await issue(a);
  await issue(a);
  assert.equal(await consume(a, first.value), "SUPERSEDED");
});

test("22 another bounty, Scout, assignment or deployment: BINDING_MISMATCH", async () => {
  const a = await seedAccepted();
  const n = await issue(a);
  for (const over of [
    { bountyId: randomUUID() },
    { scoutId: randomUUID() },
    { assignmentId: randomUUID() },
    { deploymentId: 3 },
  ]) {
    assert.equal(await consume(a, n.value, over), "BINDING_MISMATCH");
  }
  assert.equal((await nonces())[0]?.status, "ACTIVE");
});

test("23 a value never issued: UNKNOWN", async () => {
  const a = await seedAccepted();
  assert.equal(await consume(a, "cd".repeat(32)), "UNKNOWN");
});

// --- constraints and configuration (tests 24 and 25) ---

test("24 capture_nonces constraints: one ACTIVE, 32 bytes, consumed pair, binding", async () => {
  const a = await seedAccepted();
  await insertNonce(a);
  await violates(insertNonce(a), "capture_nonces_one_active_idx");
  await violates(
    insertNonce(a, { status: "SUPERSEDED", value: randomBytes(31) }),
    "capture_nonces_value_length",
  );
  await violates(
    insertNonce(a, { status: "CONSUMED", consumed_at: null }),
    "capture_nonces_consumed_pair",
  );
  const other = await seedUser();
  await violates(
    insertNonce(a, { status: "SUPERSEDED", scout_id: other.id }),
    "capture_nonces_assignment_fkey",
  );
});

test("25 loadConfig: section 17.3 defaults and the two invariants", () => {
  assert.deepEqual(config.capture, {
    nonceLifetimeS: 1200,
    deadlineBufferS: 600,
    minWindowS: 600,
    submissionGraceS: 480,
    maxLocationAccuracyM: 200,
    locationFixTimeoutS: 10,
    maxLocationAgeS: 30,
  });
  assert.throws(() => loadConfig({ ...configEnv, CAPTURE_NONCE_LIFETIME_S: "599" }),
    /CAPTURE_NONCE_LIFETIME_S/);
  assert.throws(() => loadConfig({ ...configEnv, CAPTURE_SUBMISSION_GRACE_S: "600" }),
    /CAPTURE_SUBMISSION_GRACE_S/);
  // A key no invariant reads, so only the integer rule can reject the value.
  assert.throws(() => loadConfig({ ...configEnv, LOCATION_FIX_TIMEOUT_S: "1.5" }),
    /LOCATION_FIX_TIMEOUT_S/);
});
