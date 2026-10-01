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
import { canonicalise, sha256 } from "@hackathon/shared";
import { buildApp } from "../src/app.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import { ChainError } from "../src/chain/rpc.ts";
import type { AccountInfo, ChainReader } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { SeekerCheck } from "../src/eligibility/deps.ts";
import { readAcceptance } from "../src/chain/bounty.ts";
import type { Randomness } from "../src/randomness.ts";

// POLICY.md section 16.10 as amended by D129. Expected count: 16. The fixtures
// are the first real accept on devnet (Session 18, 28 September 2026): the
// getAccountInfo response for the accepted bounty's account, and the bounty
// built from its database rows. The bounty is re-created through the API under
// a randomness double that replays the recorded salt and requirement ids, so
// the canonical text, the hash and the rows are the recorded ones by
// construction; the row id is then set to the recorded id.

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
const CANONICAL = canonicalise(fixture.policy);
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";

// --- scratch database, the eligibility.test.ts pattern ---

const dbName = `bountycam_acceptance_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

const BASE = new Date("2026-09-28T12:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const secretDir = mkdtempSync(join(tmpdir(), "bountycam-acceptance-test-"));
const secretPath = join(secretDir, "jwt-secret.hex");
writeFileSync(secretPath, Buffer.from(randomBytes(32)).toString("hex"));
const config = loadConfig({
  JWT_SECRET_PATH: secretPath,
  SETTLEMENT_MINT: fixture.policy.settlement_mint,
});

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

// --- doubles: chain reader, randomness replay, log capture ---

const chainAccounts = new Map<string, AccountInfo>();
const chainLog: string[] = [];
let chainDown = false;
const chain: ChainReader = {
  async getAccount(address) {
    chainLog.push(address);
    if (chainDown) throw new ChainError("RPC_UNREACHABLE", "double: down");
    return chainAccounts.get(address) ?? null;
  },
};

const saltQueue: Uint8Array[] = [];
const uuidQueue: string[] = [];
const randomness: Randomness = {
  randomBytes: (length) => saltQueue.shift() ?? Uint8Array.from(randomBytes(length)),
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

const alarmCount = (outcome: string): number =>
  (captured.match(new RegExp('"outcome":"' + outcome + '"', "g")) ?? []).length;

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
  chainDown = false;
  chainLog.length = 0;
  chainAccounts.clear();
  saltQueue.length = 0;
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
    .setExpirationTime(new Date(BASE.getTime() + 3_600_000))
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

// The recorded request, rebuilt from the fixture policy's request-source fields.
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
      lat: p["lat"],
      lon: p["lon"],
      required_assurance: p["required_assurance"],
      reward_amount: p["reward_amount"],
      settlement_mint: p.settlement_mint,
    },
  };
}

// The Scout the recorded account names, bytes 172 to 203.
const SCOUT_WALLET = base58.encode(recordedAccount.data.slice(172, 204));
const RECORDED_DEADLINE = new DataView(
  recordedAccount.data.buffer,
  recordedAccount.data.byteOffset,
  recordedAccount.data.byteLength,
).getBigInt64(205, true);
const COMPLETION = BigInt(fixture.policy["completion_window_seconds"] as number);
const DEADLINE = new Date(Number(RECORDED_DEADLINE) * 1000);
const ACCEPTED_AT = new Date(Number(RECORDED_DEADLINE - COMPLETION) * 1000);

/**
 * The recorded bounty as the marketplace held it before the accept: created
 * through the API, then projected to AVAILABLE with its account and cutoff by
 * SQL (POLICY.md 12), and the recorded account in the chain double.
 */
async function seedRecorded(account: AccountInfo = recordedAccount): Promise<User> {
  const requester = await seedUser(fixture.requester_wallet);
  await pool.query("DELETE FROM assignments WHERE bounty_id = $1", [fixture.id]);
  await pool.query("DELETE FROM bounties WHERE id = $1", [fixture.id]);
  await pool.query("DELETE FROM evidence_requirements WHERE id = ANY($1::uuid[])", [
    fixture.policy.evidence_requirements.map((r) => r.id),
  ]);
  await pool.query("DELETE FROM policies WHERE policy_hash = decode($1, 'hex')", [
    fixture.policy_hash,
  ]);
  saltQueue.push(Uint8Array.from(Buffer.from(fixture.policy.salt, "hex")));
  uuidQueue.push(...fixture.policy.evidence_requirements.map((r) => r.id));
  const res = await app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${requester.token}` },
    payload: recordedBody(),
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  const stored = await pool.query<{ canonical_json: string; policy_hash: Buffer }>(
    `SELECT p.canonical_json, p.policy_hash FROM bounties b
     JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
    [id],
  );
  assert.equal(stored.rows[0]?.canonical_json, CANONICAL);
  assert.equal(stored.rows[0]?.policy_hash.toString("hex"), fixture.policy_hash);
  await pool.query(
    `UPDATE bounties SET id = $1, state = 'AVAILABLE', program_account = $3,
            acceptance_cutoff = $4 WHERE id = $2`,
    [fixture.id, id, fixture.program_account, new Date(fixture.acceptance_cutoff)],
  );
  chainAccounts.set(fixture.program_account, account);
  return requester;
}

async function reserveFor(user: User, expiresAt: Date = new Date(BASE.getTime() + 300_000)) {
  await pool.query(
    "INSERT INTO assignments (bounty_id, scout_id, status, expires_at) " +
      "VALUES ($1, $2, 'ACTIVE', $3)",
    [fixture.id, user.id, expiresAt],
  );
}

function edited(edit: (d: Uint8Array) => void): AccountInfo {
  const d = Uint8Array.from(recordedAccount.data);
  edit(d);
  return { owner: recordedAccount.owner, data: d };
}

async function report(token: string) {
  return app.inject({
    method: "POST",
    url: `/bounties/${fixture.id}/acceptance`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function bountyState(): Promise<string | undefined> {
  const r = await pool.query<{ state: string }>("SELECT state FROM bounties WHERE id = $1", [
    fixture.id,
  ]);
  return r.rows[0]?.state;
}

interface AssignmentRow {
  scout_id: string;
  status: string;
  accepted_at: Date | null;
  deadline: Date | null;
  expires_at: Date;
}

async function assignments(): Promise<AssignmentRow[]> {
  const r = await pool.query<AssignmentRow>(
    `SELECT scout_id, status, accepted_at, deadline, expires_at FROM assignments
     WHERE bounty_id = $1 ORDER BY status, scout_id`,
    [fixture.id],
  );
  return r.rows;
}

const alarmLogged = (outcome: string): boolean =>
  captured.includes('"outcome":"' + outcome + '"');

const PUBLIC_KEYS = [
  "category",
  "created_at",
  "id",
  "location_public",
  "policy_hash",
  "policy_public",
  "program_account",
  "state",
  "title",
];

// --- 16.6: reading the acceptance fields ---

test("01 the recorded account reads: Accepted, the recorded Scout and deadline", () => {
  const prefix = recordedAccount.data[169];
  assert.equal(prefix, 1);
  const r = readAcceptance(recordedAccount);
  assert.ok(r.ok);
  assert.equal(base58.encode(r.scout), SCOUT_WALLET);
  assert.equal(SCOUT_WALLET, "7oSUM9a2PgNbFwYhFFXU5p1mrZr1hTykFWVqosNmT7vW");
  assert.equal(r.deadline, 1_790_603_991n);
});

test("02 the scout tag at byte 171 set to 0 is BAD_TAIL", () => {
  const r = readAcceptance(edited((d) => { d[171] = 0; }));
  assert.deepEqual(r, { ok: false, error: "BAD_TAIL" });
});

test("03 the deadline tag at byte 204 set to 0, or a 212-byte account, is BAD_TAIL", () => {
  assert.deepEqual(readAcceptance(edited((d) => { d[204] = 0; })), {
    ok: false,
    error: "BAD_TAIL",
  });
  const short = { owner: recordedAccount.owner, data: recordedAccount.data.slice(0, 212) };
  assert.deepEqual(readAcceptance(short), { ok: false, error: "BAD_TAIL" });
});

// --- 16.7 and 16.8: the projection through the report endpoint ---

test("04 report with the chain's Scout holding the reservation: projected", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const res = await report(scout.token);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await bountyState(), "ACCEPTED");
  const rows = await assignments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "ACTIVE");
  assert.equal(rows[0]!.deadline?.getTime(), DEADLINE.getTime());
  assert.equal(rows[0]!.accepted_at?.getTime(), ACCEPTED_AT.getTime());
  assert.equal(ACCEPTED_AT.getTime() / 1000, 1_790_596_791);
});

test("05 the assigned-Scout view: public keys plus policy and assignment", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const view = (await report(scout.token)).json() as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(view).sort(),
    [...PUBLIC_KEYS, "assignment", "capture", "policy", "submission"].sort(),
  );
  const policy = view["policy"] as Record<string, unknown>;
  const hash = Buffer.from(sha256(new TextEncoder().encode(canonicalise(policy)))).toString("hex");
  assert.equal(hash, view["policy_hash"]);
  assert.equal(policy["lat"], fixture.policy["lat"]);
  const held = await pool.query<{ id: string }>(
    "SELECT id FROM assignments WHERE bounty_id = $1 AND status = 'ACTIVE'",
    [fixture.id],
  );
  assert.deepEqual(view["assignment"], {
    id: held.rows[0]?.id,
    accepted_at: ACCEPTED_AT.toISOString(),
    deadline: DEADLINE.toISOString(),
  });
});

test("06 a repeated report: 200, no second row, values unchanged", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const first = await report(scout.token);
  const before = await assignments();
  const second = await report(scout.token);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body, first.body);
  assert.deepEqual(await assignments(), before);
});

test("07 report by another Scout after the projection: ACCEPTED_BY_OTHER", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  await report(scout.token);
  const other = await seedUser();
  const res = await report(other.token);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "ACCEPTED_BY_OTHER" });
});

test("08 report by the requester: 200, owner view, ACCEPTED", async () => {
  const requester = await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const res = await report(requester.token);
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json() as Record<string, unknown>;
  assert.equal(view["state"], "ACCEPTED");
  assert.ok("policy" in view);
  assert.ok(!("assignment" in view));
});

test("09 state byte Funded: NOT_ACCEPTED; a foreign bounty_id: BINDING_MISMATCH", async () => {
  await seedRecorded(edited((d) => { d[169] = 0; }));
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const before = await assignments();
  const res = await report(scout.token);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "NOT_ACCEPTED" });
  assert.equal(await bountyState(), "AVAILABLE");
  assert.deepEqual(await assignments(), before);
  // D129 point 2: an Accepted account whose bounty_id is not this row's.
  chainAccounts.set(fixture.program_account, edited((d) => { d[8] = d[8]! ^ 0x01; }));
  const foreign = await report(scout.token);
  assert.equal(foreign.statusCode, 409);
  assert.deepEqual(foreign.json(), { error: "BINDING_MISMATCH" });
  assert.equal(await bountyState(), "AVAILABLE");
  assert.deepEqual(await assignments(), before);
});

test("10 the reader throws: 503 CHAIN_UNAVAILABLE, nothing written", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const before = await assignments();
  chainDown = true;
  const res = await report(scout.token);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "CHAIN_UNAVAILABLE" });
  assert.equal(await bountyState(), "AVAILABLE");
  assert.deepEqual(await assignments(), before);
});

test("11 no account: NOT_ACCEPTED", async () => {
  await seedRecorded();
  chainAccounts.clear();
  const scout = await seedUser(SCOUT_WALLET);
  const res = await report(scout.token);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "NOT_ACCEPTED" });
  assert.equal(await bountyState(), "AVAILABLE");
});

test("12 another Scout's reservation expires; a new row records the chain's Scout", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  const other = await seedUser();
  await reserveFor(other);
  const res = await report(scout.token);
  assert.equal(res.statusCode, 200, res.body);
  const rows = await assignments();
  const mine = rows.find((r) => r.scout_id === scout.id);
  const theirs = rows.find((r) => r.scout_id === other.id);
  assert.equal(theirs?.status, "EXPIRED");
  assert.equal(mine?.status, "ACTIVE");
  assert.equal(mine?.accepted_at?.getTime(), ACCEPTED_AT.getTime());
  assert.equal(mine?.deadline?.getTime(), DEADLINE.getTime());
  assert.equal(mine?.expires_at.getTime(), ACCEPTED_AT.getTime());
  assert.equal(await bountyState(), "ACCEPTED");
});

test("13 the chain's Scout has no users row: ACCEPTED_BY_OTHER, UNKNOWN_SCOUT logged", async () => {
  await seedRecorded();
  await pool.query("DELETE FROM users WHERE wallet_address = $1", [SCOUT_WALLET]);
  const caller = await seedUser();
  const res = await report(caller.token);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "ACCEPTED_BY_OTHER" });
  assert.equal(await bountyState(), "AVAILABLE");
  assert.ok(alarmLogged("UNKNOWN_SCOUT"));
});

test("14 state byte Refunded: BOUNTY_NOT_ACCEPTABLE, UNPROJECTED_STATE logged", async () => {
  await seedRecorded(edited((d) => { d[169] = 5; }));
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  const before = await assignments();
  const res = await report(scout.token);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "BOUNTY_NOT_ACCEPTABLE" });
  assert.equal(await bountyState(), "AVAILABLE");
  assert.deepEqual(await assignments(), before);
  assert.ok(alarmLogged("UNPROJECTED_STATE"));
});

test("15 accepted_at set with deadline null fails assignments_acceptance_pair", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await assert.rejects(
    pool.query(
      "INSERT INTO assignments (bounty_id, scout_id, status, expires_at, accepted_at) " +
        "VALUES ($1, $2, 'ACTIVE', $3, $3)",
      [fixture.id, scout.id, BASE],
    ),
    (error: { constraint?: string }) => error.constraint === "assignments_acceptance_pair",
  );
});

test("16 GET /me/missions and GET /bounties/:id after the projection", async () => {
  await seedRecorded();
  const scout = await seedUser(SCOUT_WALLET);
  await reserveFor(scout);
  await report(scout.token);
  const mine = await app.inject({
    method: "GET",
    url: "/me/missions",
    headers: { authorization: `Bearer ${scout.token}` },
  });
  assert.equal(mine.statusCode, 200);
  const missions = (mine.json() as { missions: Record<string, unknown>[] }).missions;
  assert.equal(missions.length, 1);
  assert.equal(missions[0]!["id"], fixture.id);
  assert.equal(missions[0]!["deadline"], DEADLINE.toISOString());
  const other = await seedUser();
  const theirs = await app.inject({
    method: "GET",
    url: "/me/missions",
    headers: { authorization: `Bearer ${other.token}` },
  });
  assert.deepEqual(theirs.json(), { missions: [] });
  // Step 4a: the Scout gets the assigned view; anyone else the public view.
  const asScout = await app.inject({
    method: "GET",
    url: `/bounties/${fixture.id}`,
    headers: { authorization: `Bearer ${scout.token}` },
  });
  assert.ok("policy" in (asScout.json() as Record<string, unknown>));
  const asOther = await app.inject({
    method: "GET",
    url: `/bounties/${fixture.id}`,
    headers: { authorization: `Bearer ${other.token}` },
  });
  assert.deepEqual(Object.keys(asOther.json() as Record<string, unknown>).sort(), PUBLIC_KEYS);
});
