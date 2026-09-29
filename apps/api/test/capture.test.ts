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
import type { Randomness } from "../src/randomness.ts";

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
  randomBytes: (length) => bytesQueue.shift() ?? Uint8Array.from(randomBytes(length)),
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

interface NonceRow {
  assignment_id: string;
  bounty_id: string;
  scout_id: string;
  value: Buffer;
  status: string;
  consumed_at: Date | null;
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
