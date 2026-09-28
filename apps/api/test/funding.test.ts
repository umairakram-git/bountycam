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
import { canonicalise, sha256, uuidBytes } from "@hackathon/shared";
import { buildApp } from "../src/app.ts";
import { bountyAddress, findProgramAddress } from "../src/chain/pda.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import { ChainError } from "../src/chain/rpc.ts";
import type { AccountInfo, ChainReader } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { SeekerCheck } from "../src/eligibility/deps.ts";
import type { ProjectionDeps } from "../src/funding/project.ts";
import { sweepFunding } from "../src/funding/sweeper.ts";
import type { Randomness } from "../src/randomness.ts";

// POLICY.md section 15.8. Expected count: 24. The fixtures are the first real
// funding on devnet (Session 17, 28 September 2026): the getAccountInfo
// response for the bounty account and the created bounty's owner-view data.
// The bounty is re-created through the API under a randomness double that
// replays the recorded salt and requirement ids, so the canonical text, the
// hash and the rows are the recorded ones by construction; the row id is
// then set to the recorded id so the account's bounty_id matches.

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
  bounty_address: string;
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, "create_response.json"), "utf8")) as
  CreateFixture;
const accountResponse = JSON.parse(readFileSync(join(FIXTURES, "bounty_account.json"), "utf8")) as
  { result: { value: { owner: string; data: [string, string] } } };
const recordedAccount: AccountInfo = {
  owner: accountResponse.result.value.owner,
  data: Uint8Array.from(Buffer.from(accountResponse.result.value.data[0], "base64")),
};
const CANONICAL = canonicalise(fixture.policy);
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";

// --- scratch database, the eligibility.test.ts pattern ---

const dbName = `bountycam_funding_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

const BASE = new Date("2026-09-28T00:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const secretDir = mkdtempSync(join(tmpdir(), "bountycam-funding-test-"));
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

const projection: ProjectionDeps = {
  pool,
  chain,
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  alarm: (outcome, bountyId) => {
    captured += JSON.stringify({ outcome, bountyId }) + "\n";
  },
};

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

async function create(user: User, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${user.token}` },
    payload: body,
  });
  if (res.statusCode !== 201) {
    // The API's own error line, so a failing seed says why.
    const errors = captured.split("\n").filter((l) => l.includes('"level":50'));
    assert.fail(res.body + " :: " + (errors.at(-1) ?? "(no error logged)"));
  }
  return res.json().id as string;
}

/** The recorded bounty, as the API created it, under the recorded id. DRAFT. */
async function seedRecorded(): Promise<User> {
  const requester = await seedUser(fixture.requester_wallet);
  // The recorded requirement ids are primary keys, so the previous copy of
  // the recorded bounty, its requirement rows and its policy go first.
  await pool.query("DELETE FROM bounties WHERE id = $1", [fixture.id]);
  await pool.query("DELETE FROM evidence_requirements WHERE id = ANY($1::uuid[])", [
    fixture.policy.evidence_requirements.map((r) => r.id),
  ]);
  await pool.query("DELETE FROM policies WHERE policy_hash = decode($1, 'hex')", [
    fixture.policy_hash,
  ]);
  saltQueue.push(Uint8Array.from(Buffer.from(fixture.policy.salt, "hex")));
  uuidQueue.push(...fixture.policy.evidence_requirements.map((r) => r.id));
  const id = await create(requester, recordedBody());
  const stored = await pool.query<{ canonical_json: string; policy_hash: Buffer }>(
    `SELECT p.canonical_json, p.policy_hash FROM bounties b
     JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
    [id],
  );
  const row = stored.rows[0];
  if (row === undefined) throw new Error("recorded bounty has no policy row");
  assert.equal(row.canonical_json, CANONICAL);
  assert.equal(row.policy_hash.toString("hex"), fixture.policy_hash);
  await pool.query("UPDATE bounties SET id = $1 WHERE id = $2", [fixture.id, id]);
  return requester;
}

function edited(edit: (d: Uint8Array, v: DataView) => void): AccountInfo {
  const d = Uint8Array.from(recordedAccount.data);
  edit(d, new DataView(d.buffer));
  return { owner: recordedAccount.owner, data: d };
}

async function report(token: string, id: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/bounties/${id}/funding`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function cancel(token: string, id: string) {
  return app.inject({
    method: "POST",
    url: `/bounties/${id}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function rowState(id: string): Promise<{ state: string; program_account: string | null }> {
  const r = await pool.query<{ state: string; program_account: string | null }>(
    "SELECT state, program_account FROM bounties WHERE id = $1",
    [id],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("no row " + id);
  return row;
}

// --- derivation ---

test("01 findProgramAddress reproduces the live config account, bump 255", () => {
  const r = findProgramAddress([new TextEncoder().encode("config")], base58.decode(PROGRAM));
  assert.equal(base58.encode(r.address), CONFIG_ACCOUNT);
  assert.equal(r.bump, 255);
});

test("02 bountyAddress reproduces the recorded bounty account", () => {
  const r = bountyAddress(
    base58.decode(fixture.requester_wallet),
    uuidBytes(fixture.id),
    base58.decode(PROGRAM),
  );
  assert.equal(base58.encode(r.address), fixture.bounty_address);
  // The fixture agrees with itself: the stored text hashes to the hash.
  assert.equal(Buffer.from(sha256(new TextEncoder().encode(CANONICAL))).toString("hex"),
    fixture.policy_hash);
  assert.equal(recordedAccount.owner, PROGRAM);
});

// --- report ---

test("03 DRAFT and the recorded account: 200, AVAILABLE with the address (control)", async () => {
  const requester = await seedRecorded();
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const res = await report(requester.token, fixture.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.state, "AVAILABLE");
  assert.equal(body.program_account, fixture.bounty_address);
  assert.equal(body.policy_hash, fixture.policy_hash);
  assert.deepEqual(await rowState(fixture.id), {
    state: "AVAILABLE",
    program_account: fixture.bounty_address,
  });
  assert.equal(alarmCount("BINDING_MISMATCH"), 0);
  // POLICY.md 16.3: the cutoff is the account's, offset 161.
  const cutoff = await pool.query<{ s: string }>(
    "SELECT extract(epoch FROM acceptance_cutoff)::bigint::text AS s " +
      "FROM bounties WHERE id = $1",
    [fixture.id],
  );
  const d = recordedAccount.data;
  const want = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(161, true);
  assert.equal(cutoff.rows[0]?.s, want.toString());
});

test("04 a repeated report: 200, the same view, no second chain read needed", async () => {
  const requester = await seedRecorded();
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const first = await report(requester.token, fixture.id);
  assert.equal(first.statusCode, 200);
  const reads = chainLog.length;
  const second = await report(requester.token, fixture.id);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal(chainLog.length, reads);
});

test("05 no account: 409 NOT_FUNDED, the row untouched", async () => {
  const requester = await seedRecorded();
  const res = await report(requester.token, fixture.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "NOT_FUNDED" });
  assert.deepEqual(await rowState(fixture.id), { state: "DRAFT", program_account: null });
  assert.deepEqual(chainLog, [fixture.bounty_address]);
});

test("06 the reader throws: 503 CHAIN_UNAVAILABLE, the row untouched", async () => {
  const requester = await seedRecorded();
  chainDown = true;
  const res = await report(requester.token, fixture.id);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "CHAIN_UNAVAILABLE" });
  assert.deepEqual(await rowState(fixture.id), { state: "DRAFT", program_account: null });
});

const mismatches: [string, (d: Uint8Array, v: DataView) => void][] = [
  ["07 bounty_id", (d) => { d[8] = d[8]! ^ 0x01; }],
  ["08 requester", (d) => { d[24] = d[24]! ^ 0x01; }],
  ["09 reward_amount", (_d, v) => { v.setBigUint64(56, 1n, true); }],
  ["10 platform_fee", (_d, v) => { v.setBigUint64(64, 1n, true); }],
  ["11 policy_hash", (d) => { d[72] = d[72]! ^ 0x01; }],
  ["12 eligibility_profile_hash", (d) => { d[104] = d[104]! ^ 0x01; }],
  ["13 required_assurance", (_d, v) => { v.setUint8(136, 4); }],
  ["14 acceptance_window_secs", (_d, v) => { v.setBigInt64(137, 3600n, true); }],
  ["15 completion_window_secs", (_d, v) => { v.setBigInt64(145, 60n, true); }],
  ["16 review_window_secs", (_d, v) => { v.setBigInt64(153, 60n, true); }],
  ["17 state Accepted", (_d, v) => { v.setUint8(169, 1); }],
];

for (const [name, edit] of mismatches) {
  test(`${name} edited: 409 BINDING_MISMATCH, row untouched, one alarm`, async () => {
    const requester = await seedRecorded();
    chainAccounts.set(fixture.bounty_address, edited(edit));
    const res = await report(requester.token, fixture.id);
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), { error: "BINDING_MISMATCH" });
    assert.deepEqual(await rowState(fixture.id), { state: "DRAFT", program_account: null });
    assert.equal(alarmCount("BINDING_MISMATCH"), 1);
  });
}

test("18 a request body: 400 INVALID_REQUEST", async () => {
  const requester = await seedRecorded();
  const res = await report(requester.token, fixture.id, {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "INVALID_REQUEST" });
});

test("19 another user on a DRAFT: 404 NOT_FOUND", async () => {
  await seedRecorded();
  const other = await seedUser();
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const res = await report(other.token, fixture.id);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "NOT_FOUND" });
  assert.deepEqual(await rowState(fixture.id), { state: "DRAFT", program_account: null });
});

test("20 CANCELLED with the recorded account: 409 BOUNTY_NOT_FUNDABLE and one alarm", async () => {
  const requester = await seedRecorded();
  await pool.query("UPDATE bounties SET state = 'CANCELLED' WHERE id = $1", [fixture.id]);
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const res = await report(requester.token, fixture.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "BOUNTY_NOT_FUNDABLE" });
  assert.deepEqual(await rowState(fixture.id), { state: "CANCELLED", program_account: null });
  assert.equal(alarmCount("FUNDED_AFTER_CANCEL"), 1);
});

// --- sweep ---

test("21 sweep: the recorded row projects, the unfunded stays, the old one is never read", async () => {
  const requester = await seedRecorded();
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const unfunded = await create(requester, recordedBody());
  const old = await create(requester, recordedBody());
  await pool.query(
    "UPDATE bounties SET created_at = now() - interval '25 hours' WHERE id = $1",
    [old],
  );
  nowMs = Date.now();
  const projected = await sweepFunding(projection, clock.now());
  assert.equal(projected, 1);
  assert.equal((await rowState(fixture.id)).state, "AVAILABLE");
  assert.equal((await rowState(unfunded)).state, "DRAFT");
  assert.equal((await rowState(old)).state, "DRAFT");
  const oldAddress = base58.encode(
    bountyAddress(base58.decode(requester.wallet), uuidBytes(old), base58.decode(PROGRAM)).address,
  );
  assert.equal(chainLog.includes(fixture.bounty_address), true);
  assert.equal(chainLog.includes(oldAddress), false);
});

// --- cancel, POLICY.md 15.6 ---

test("22 cancel a DRAFT whose account exists: 409, the row is AVAILABLE", async () => {
  const requester = await seedRecorded();
  chainAccounts.set(fixture.bounty_address, recordedAccount);
  const res = await cancel(requester.token, fixture.id);
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), { error: "BOUNTY_NOT_CANCELLABLE" });
  assert.deepEqual(await rowState(fixture.id), {
    state: "AVAILABLE",
    program_account: fixture.bounty_address,
  });
});

test("23 cancel with the reader down: 503, the row stays DRAFT", async () => {
  const requester = await seedRecorded();
  chainDown = true;
  const res = await cancel(requester.token, fixture.id);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "CHAIN_UNAVAILABLE" });
  assert.deepEqual(await rowState(fixture.id), { state: "DRAFT", program_account: null });
});

test("24 cancel with no account: 200 CANCELLED", async () => {
  const requester = await seedRecorded();
  const res = await cancel(requester.token, fixture.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, "CANCELLED");
  assert.deepEqual(chainLog, [fixture.bounty_address]);
});
