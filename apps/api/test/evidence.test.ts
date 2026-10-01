import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SignJWT } from "jose";
import {
  canonicalise,
  distanceM,
  evidenceRoot,
  evidenceStatement,
  formatCoordinate,
} from "@hackathon/shared";
import { buildApp } from "../src/app.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import type { ChainReader } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig, loadEvidenceConfig } from "../src/config.ts";
import type { SeekerCheck } from "../src/eligibility/deps.ts";
import { systemRandomness } from "../src/randomness.ts";
import { presignQuery } from "../src/evidence/sigv4.ts";
import {
  objectKey,
  s3EvidenceStore,
  type EvidenceStore,
  type StoredObject,
} from "../src/evidence/store.ts";

// POLICY.md section 18.10. The bounty is created through the API from the recorded Session 18
// create body, with its requirement list set per test; the acceptance is seeded by SQL for a
// Scout whose wallet is SPEC.md section 11.8's test key, because the signature tests need a
// key the suite holds. Clock and store are injected; the store double answers in the shape
// src/evidence/store.ts parses from versitygw's HEAD.

// --- fixtures ---

const FIXTURES = join(process.cwd(), "test", "fixtures", "devnet");
const fixture = JSON.parse(readFileSync(join(FIXTURES, "accept_create_response.json"), "utf8")) as {
  title: string;
  category: string;
  policy: Record<string, unknown> & { lat: string; lon: string; settlement_mint: string };
};
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";

const SHARED_VECTORS = join(process.cwd(), "..", "..", "packages", "shared", "vectors");
const evidenceVectors = JSON.parse(
  readFileSync(join(SHARED_VECTORS, "evidence_vectors.json"), "utf8"),
) as { scout_seed_ascii: string; scout_base58: string };
const SCOUT_SEED = Uint8Array.from(Buffer.from(evidenceVectors.scout_seed_ascii, "ascii"));
const SCOUT_WALLET = base58.encode(ed25519.getPublicKey(SCOUT_SEED));
const messageVectors = JSON.parse(readFileSync(join(SHARED_VECTORS, "vectors.json"), "utf8")) as {
  authorities: { eligibility_seed_ascii: string; eligibility_pubkey_hex: string };
};
const ELIG_SEED = Uint8Array.from(
  Buffer.from(messageVectors.authorities.eligibility_seed_ascii, "ascii"),
);
const ELIG_PUBKEY = Uint8Array.from(
  Buffer.from(messageVectors.authorities.eligibility_pubkey_hex, "hex"),
);

// --- scratch database, clock, configuration ---

const dbName = `bountycam_evidence_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

const BASE = new Date("2026-10-01T00:00:00.000Z");
const DEADLINE = new Date(BASE.getTime() + 7_200_000);
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const dir = mkdtempSync(join(tmpdir(), "bountycam-evidence-test-"));
const jwtPath = join(dir, "jwt-secret.hex");
writeFileSync(jwtPath, randomBytes(32).toString("hex"));
const secretPath = join(dir, "store-secret");
writeFileSync(secretPath, "test-secret-key-0123456789\n");
const emptyPath = join(dir, "empty-secret");
writeFileSync(emptyPath, "\n");

const STORE_ENV = {
  EVIDENCE_STORE_ENDPOINT: "http://127.0.0.1:7070",
  EVIDENCE_STORE_BUCKET: "bountycam-evidence",
  EVIDENCE_STORE_ACCESS_KEY_ID: "test-access-key",
  EVIDENCE_STORE_SECRET_PATH: secretPath,
};
const config = loadConfig({
  JWT_SECRET_PATH: jwtPath,
  SETTLEMENT_MINT: fixture.policy.settlement_mint,
  ...STORE_ENV,
});
const MAX_BYTES = 10485760;

// --- doubles ---

const stored = new Map<string, StoredObject>();
const presigned: { key: string; sha256: string; byteLength: number }[] = [];
let storeDown = false;
const store: EvidenceStore = {
  presignPut(key, sha256, byteLength, now) {
    const checksum = Buffer.from(sha256).toString("base64");
    presigned.push({ key, sha256: Buffer.from(sha256).toString("hex"), byteLength });
    return {
      url: `http://127.0.0.1:7070/bountycam-evidence/${key}?X-Amz-Signature=${"5e".repeat(32)}`,
      headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": checksum },
      expiresAt: new Date(now.getTime() + 900_000),
    };
  },
  async head(key) {
    if (storeDown) throw new Error("store unreachable");
    return stored.get(key) ?? null;
  },
};

const eligibilityConfig: EligibilityConfig = {
  rpcUrl: "https://rpc.example.test/",
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  configAccount: CONFIG_ACCOUNT,
  keySeed: ELIG_SEED,
  keyPubkey: ELIG_PUBKEY,
};
const deployment: Deployment = {
  deploymentId: 2,
  usdcMint: base58.decode(fixture.policy.settlement_mint),
  eligibilityAuthority: ELIG_PUBKEY,
};
const chain: ChainReader = { getAccount: async () => null };
const seeker: SeekerCheck = { findSeekerMint: async () => null };

let captured = "";
const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const app = buildApp({
  config,
  pool,
  clock,
  randomness: systemRandomness,
  eligibility: {
    config: eligibilityConfig,
    deployment,
    chain,
    signer: eligibilitySigner(ELIG_SEED),
    seeker,
  },
  evidenceStore: store,
  logger: { level: "info", stream: { write: (msg: string) => void (captured += msg) } },
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
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  nowMs = BASE.getTime();
  captured = "";
  storeDown = false;
  presigned.length = 0;
});

// --- helpers ---

interface User {
  id: string;
  wallet: string;
  token: string;
}

async function seedUser(wallet: string = base58.encode(randomBytes(32))): Promise<User> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [wallet],
  );
  const id = r.rows[0]!.id;
  const token = await new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 1000))
    .setExpirationTime(new Date(DEADLINE.getTime() + 3_600_000))
    .sign(config.jwtSecret);
  return { id, wallet, token };
}

interface Requirement {
  id: string;
  prompt: string;
  required: boolean;
}

interface Mission {
  id: string;
  requester: User;
  scout: User;
  assignmentId: string;
  policyHash: string;
  requirements: Requirement[];
}

const TWO_REQUIRED = [
  { prompt: "One", required: true },
  { prompt: "Two", required: true },
];

/** The recorded create body with `reqs`, created, then ACCEPTED for the test Scout by SQL. */
async function seedMission(
  reqs: { prompt: string; required: boolean }[] = TWO_REQUIRED,
): Promise<Mission> {
  const requester = await seedUser();
  const p = fixture.policy;
  const created = await app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${requester.token}` },
    payload: {
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
        evidence_requirements: reqs.map((r) => ({ ...r, type: "PHOTO" })),
        lat: p.lat,
        lon: p.lon,
        required_assurance: p["required_assurance"],
        reward_amount: p["reward_amount"],
        settlement_mint: p.settlement_mint,
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const view = created.json() as {
    id: string;
    policy_hash: string;
    policy: { evidence_requirements: Requirement[] };
  };
  await pool.query("UPDATE bounties SET state = 'ACCEPTED' WHERE id = $1", [view.id]);
  const scout = await seedUser(SCOUT_WALLET);
  const accepted = new Date(BASE.getTime() - 60_000);
  const a = await pool.query<{ id: string }>(
    `INSERT INTO assignments (bounty_id, scout_id, status, accepted_at, deadline, expires_at)
     VALUES ($1, $2, 'ACTIVE', $3, $4, $3) RETURNING id`,
    [view.id, scout.id, accepted, DEADLINE],
  );
  return {
    id: view.id,
    requester,
    scout,
    assignmentId: a.rows[0]!.id,
    policyHash: view.policy_hash,
    requirements: view.policy.evidence_requirements,
  };
}

interface Session {
  id: string;
  value: string;
  issuedAt: number;
  expiresAt: number;
}

async function startSession(m: Mission): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: `/bounties/${m.id}/capture-nonce`,
    headers: { authorization: `Bearer ${m.scout.token}` },
    payload: {
      lat: fixture.policy.lat,
      lon: fixture.policy.lon,
      horizontal_accuracy_m: 12,
      fixed_at: new Date(nowMs - 2000).toISOString(),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const n = res.json().capture.capture_nonce as Record<string, string>;
  return {
    id: n["id"]!,
    value: n["value"]!,
    issuedAt: Date.parse(n["issued_at"]!),
    expiresAt: Date.parse(n["expires_at"]!),
  };
}

type Item = Record<string, unknown> & { requirement_id: string; photo_sha256: string };
interface Manifest {
  header: Record<string, unknown>;
  items: Item[];
}

function item(requirementId: string, index: number, s: Session): Item {
  return {
    byte_length: 1000 + index,
    captured_at: new Date(s.issuedAt + 60_000 + index * 1000).toISOString(),
    fixed_at: new Date(s.issuedAt + 59_000 + index * 1000).toISOString(),
    horizontal_accuracy_m: 12,
    lat: fixture.policy.lat,
    lon: fixture.policy.lon,
    photo_sha256: randomBytes(32).toString("hex"),
    requirement_id: requirementId,
  };
}

/** A manifest with one item for each requirement named, in the order given. */
function manifestFor(m: Mission, s: Session, ids = m.requirements.filter((r) => r.required)
  .map((r) => r.id)): Manifest {
  return {
    header: {
      assignment_id: m.assignmentId,
      bounty_id: m.id,
      capture_nonce: s.value,
      deployment_id: 2,
      manifest_version: 1,
      policy_hash: m.policyHash,
      scout: SCOUT_WALLET,
    },
    items: ids.map((id, i) => item(id, i, s)),
  };
}

function upload(m: Mission, s: Session, manifest: Manifest): void {
  for (const it of manifest.items) {
    stored.set(objectKey(m.id, s.id, it.requirement_id, it.photo_sha256), {
      byteLength: it["byte_length"] as number,
      sha256Base64: Buffer.from(it.photo_sha256, "hex").toString("base64"),
    });
  }
}

function sign(bountyId: string, manifest: Manifest, seed: Uint8Array = SCOUT_SEED): string {
  const statement = evidenceStatement(bountyId, evidenceRoot(manifest));
  return Buffer.from(ed25519.sign(statement, seed)).toString("hex");
}

function rootHex(manifest: Manifest): string {
  return Buffer.from(evidenceRoot(manifest)).toString("hex");
}

// A default parameter would replace an explicit undefined, so "no body" is a marker.
const NO_BODY = Symbol("no body");

async function post(path: string, token: string | null, payload: unknown) {
  return app.inject({
    method: "POST",
    url: path,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(payload === NO_BODY ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function submit(m: Mission, payload: unknown, token = m.scout.token) {
  return post(`/bounties/${m.id}/submission`, token, payload);
}

async function uploadUrl(m: Mission, payload: unknown, token = m.scout.token) {
  return post(`/bounties/${m.id}/evidence/upload-url`, token, payload);
}

function uploadBody(s: Session, requirementId: string, over: Record<string, unknown> = {}) {
  return {
    capture_session_id: s.id,
    requirement_id: requirementId,
    photo_sha256: "9e".repeat(32),
    byte_length: 1425407,
    ...over,
  };
}

/** A mission with a live session and a valid, uploaded, signed two-item manifest. */
async function ready(reqs = TWO_REQUIRED) {
  const m = await seedMission(reqs);
  const s = await startSession(m);
  const manifest = manifestFor(m, s);
  upload(m, s, manifest);
  return { m, s, manifest, body: { manifest, signature: sign(m.id, manifest) } };
}

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: string }).error;
}

async function nonceRow(value: string) {
  const r = await pool.query<{ status: string; consumed_at: Date | null; deployment_id: number }>(
    "SELECT status, consumed_at, deployment_id FROM capture_nonces WHERE value = $1",
    [Buffer.from(value, "hex")],
  );
  return r.rows[0]!;
}

async function submissionCount(m: Mission): Promise<number> {
  const r = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM submissions WHERE bounty_id = $1",
    [m.id],
  );
  return r.rows[0]!.n;
}

// --- the upload URL (tests 01 to 06) ---

test("01 the holder, live session: 200, the upload object, the recorded key", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const req = m.requirements[0]!.id;
  const res = await uploadUrl(m, uploadBody(s, req));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(Object.keys(res.json() as object), ["upload"]);
  const upload = res.json().upload as Record<string, unknown>;
  assert.deepEqual(Object.keys(upload).sort(), ["expires_at", "headers", "method", "url"]);
  assert.equal(upload["method"], "PUT");
  assert.deepEqual(upload["headers"], {
    "content-type": "image/jpeg",
    "x-amz-checksum-sha256": Buffer.from("9e".repeat(32), "hex").toString("base64"),
  });
  assert.equal(upload["expires_at"], new Date(BASE.getTime() + 900_000).toISOString());
  assert.deepEqual(presigned, [
    { key: objectKey(m.id, s.id, req, "9e".repeat(32)), sha256: "9e".repeat(32), byteLength: 1425407 },
  ]);
});

test("02 CAPTURE_SESSION_NOT_LIVE, and the last live millisecond", async () => {
  const m = await seedMission();
  const other = await seedMission();
  const s = await startSession(m);
  const otherSession = await startSession(other);
  const req = m.requirements[0]!.id;
  nowMs = s.expiresAt + 479_999;
  assert.equal((await uploadUrl(m, uploadBody(s, req))).statusCode, 200);
  nowMs = s.expiresAt + 480_000;
  assert.equal(code(await uploadUrl(m, uploadBody(s, req))), "CAPTURE_SESSION_NOT_LIVE");
  nowMs = BASE.getTime() + 1000;
  const newer = await startSession(m);
  assert.notEqual(newer.id, s.id);
  assert.equal(code(await uploadUrl(m, uploadBody(s, req))), "CAPTURE_SESSION_NOT_LIVE");
  assert.equal(code(await uploadUrl(m, uploadBody(otherSession, req))), "CAPTURE_SESSION_NOT_LIVE");
  const never = { ...s, id: randomUUID() };
  assert.equal(code(await uploadUrl(m, uploadBody(never, req))), "CAPTURE_SESSION_NOT_LIVE");
});

test("03 EVIDENCE_TOO_LARGE one above the maximum; the maximum itself is 200", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const req = m.requirements[0]!.id;
  const over = await uploadUrl(m, uploadBody(s, req, { byte_length: MAX_BYTES + 1 }));
  assert.equal(code(over), "EVIDENCE_TOO_LARGE");
  assert.equal((await uploadUrl(m, uploadBody(s, req, { byte_length: MAX_BYTES }))).statusCode, 200);
});

test("04 UNKNOWN_REQUIREMENT for a requirement outside the policy", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  assert.equal(code(await uploadUrl(m, uploadBody(s, randomUUID()))), "UNKNOWN_REQUIREMENT");
});

test("05 INVALID_REQUEST for the body shape", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const req = m.requirements[0]!.id;
  const bodies: unknown[] = [
    NO_BODY,
    { ...uploadBody(s, req), extra: 1 },
    uploadBody(s, req, { photo_sha256: "9E".repeat(32) }),
    uploadBody(s, req, { byte_length: 0 }),
    uploadBody(s, req, { byte_length: 1.5 }),
    uploadBody(s, req, { capture_session_id: "not-a-uuid" }),
  ];
  for (const body of bodies) assert.equal(code(await uploadUrl(m, body)), "INVALID_REQUEST");
});

test("06 who may ask: NOT_ASSIGNED, BOUNTY_NOT_CAPTURABLE, TOKEN_MISSING, NOT_FOUND", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const body = uploadBody(s, m.requirements[0]!.id);
  assert.equal(code(await uploadUrl(m, body, m.requester.token)), "NOT_ASSIGNED");
  assert.equal(code(await uploadUrl(m, body, (await seedUser()).token)), "NOT_ASSIGNED");
  const available = await seedMission();
  await pool.query("UPDATE bounties SET state = 'AVAILABLE' WHERE id = $1", [available.id]);
  assert.equal(code(await uploadUrl(available, body)), "BOUNTY_NOT_CAPTURABLE");
  const noToken = await post(`/bounties/${m.id}/evidence/upload-url`, null, body);
  assert.equal(code(noToken), "TOKEN_MISSING");
  const unknown = await post(`/bounties/${randomUUID()}/evidence/upload-url`, m.scout.token, body);
  assert.equal(code(unknown), "NOT_FOUND");
});

// --- the submission (tests 07 to 22) ---

test("07 the valid submission: 201, the rows, the nonce consumed, no state moved", async () => {
  const { m, s, manifest, body } = await ready();
  nowMs = BASE.getTime() + 300_000;
  const res = await submit(m, body);
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(Object.keys(res.json() as object), ["submission"]);
  const sub = res.json().submission as Record<string, unknown>;
  assert.deepEqual(Object.keys(sub).sort(), ["evidence_root", "id", "item_count", "submitted_at"]);
  assert.equal(sub["evidence_root"], rootHex(manifest));
  assert.equal(sub["item_count"], 2);
  assert.equal(sub["submitted_at"], new Date(nowMs).toISOString());
  const row = (await pool.query(
    "SELECT * FROM submissions WHERE id = $1",
    [sub["id"]],
  )).rows[0] as Record<string, any>;
  assert.equal(row["manifest"], canonicalise(manifest));
  assert.equal(row["evidence_root"].toString("hex"), rootHex(manifest));
  assert.equal(row["statement_signature"].toString("hex"), body.signature);
  assert.equal(row["capture_nonce_id"], s.id);
  assert.equal(row["assignment_id"], m.assignmentId);
  assert.equal(row["scout_id"], m.scout.id);
  assert.equal(row["achieved_assurance"], null);
  assert.equal(row["attester_signature"], null);
  assert.equal(row["submitted_at"].toISOString(), new Date(nowMs).toISOString());
  const items = (await pool.query(
    "SELECT * FROM evidence_items WHERE submission_id = $1 ORDER BY captured_at",
    [sub["id"]],
  )).rows as Record<string, any>[];
  assert.equal(items.length, 2);
  for (const [i, it] of items.entries()) {
    const want = manifest.items[i]!;
    assert.equal(it["requirement_id"], want.requirement_id);
    assert.equal(it["storage_key"], objectKey(m.id, s.id, want.requirement_id, want.photo_sha256));
    assert.equal(it["hash"].toString("hex"), want.photo_sha256);
    assert.equal(it["c2pa_present"], false);
    assert.equal(it["captured_at"].toISOString(), want["captured_at"]);
    assert.equal(Number(it["byte_length"]), want["byte_length"]);
    assert.equal(it["lat"], want["lat"]);
    assert.equal(it["lon"], want["lon"]);
    assert.equal(it["horizontal_accuracy_m"], 12);
    assert.equal(it["fixed_at"].toISOString(), want["fixed_at"]);
  }
  const n = await nonceRow(s.value);
  assert.equal(n.status, "CONSUMED");
  assert.equal(n.consumed_at?.toISOString(), new Date(nowMs).toISOString());
  const b = await pool.query<{ state: string }>("SELECT state FROM bounties WHERE id = $1", [m.id]);
  assert.equal(b.rows[0]!.state, "ACCEPTED");
  const a = await pool.query<{ status: string }>("SELECT status FROM assignments WHERE id = $1",
    [m.assignmentId]);
  assert.equal(a.rows[0]!.status, "ACTIVE");
});

test("08 a resend is the same submission; anything else after it is ALREADY_SUBMITTED", async () => {
  const { m, s, body } = await ready();
  const first = await submit(m, body);
  assert.equal(first.statusCode, 201, first.body);
  const again = await submit(m, body);
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json(), first.json());
  assert.equal(await submissionCount(m), 1);
  const other = manifestFor(m, s);
  upload(m, s, other);
  assert.equal(code(await submit(m, { manifest: other, signature: sign(m.id, other) })),
    "ALREADY_SUBMITTED");
  assert.equal(code(await uploadUrl(m, uploadBody(s, m.requirements[0]!.id))), "ALREADY_SUBMITTED");
});

test("09 an optional requirement may be skipped; a required one may not", async () => {
  const withOptional = [...TWO_REQUIRED, { prompt: "Three", required: false }];
  const { m, body } = await ready(withOptional);
  assert.equal(m.requirements.length, 3);
  assert.equal((await submit(m, body)).statusCode, 201);
  const m2 = await seedMission();
  const s2 = await startSession(m2);
  const short = manifestFor(m2, s2, [m2.requirements[0]!.id]);
  upload(m2, s2, short);
  assert.equal(code(await submit(m2, { manifest: short, signature: sign(m2.id, short) })),
    "REQUIREMENTS_INCOMPLETE");
});

test("10 item order and membership: MANIFEST_MISMATCH, UNKNOWN_REQUIREMENT", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const swapped = manifestFor(m, s, [m.requirements[1]!.id, m.requirements[0]!.id]);
  upload(m, s, swapped);
  assert.equal(code(await submit(m, { manifest: swapped, signature: sign(m.id, swapped) })),
    "MANIFEST_MISMATCH");
  const stranger = manifestFor(m, s, [m.requirements[0]!.id, randomUUID()]);
  upload(m, s, stranger);
  assert.equal(code(await submit(m, { manifest: stranger, signature: sign(m.id, stranger) })),
    "UNKNOWN_REQUIREMENT");
});

test("11 MANIFEST_MISMATCH for each header binding, each re-signed", async () => {
  const { m, manifest } = await ready();
  const changes: Record<string, unknown>[] = [
    { bounty_id: randomUUID() },
    { assignment_id: randomUUID() },
    { scout: base58.encode(randomBytes(32)) },
    { policy_hash: "ab".repeat(32) },
    { deployment_id: 3 },
  ];
  for (const change of changes) {
    const bent: Manifest = { header: { ...manifest.header, ...change }, items: manifest.items };
    const res = await submit(m, { manifest: bent, signature: sign(m.id, bent) });
    assert.equal(code(res), "MANIFEST_MISMATCH", JSON.stringify(change));
  }
});

test("12 INVALID_REQUEST for the body, INVALID_MANIFEST for the manifest", async () => {
  const { m, manifest, body } = await ready();
  assert.equal(code(await submit(m, NO_BODY)), "INVALID_REQUEST");
  assert.equal(code(await submit(m, { manifest })), "INVALID_REQUEST");
  assert.equal(code(await submit(m, { ...body, signature: body.signature.slice(1) })),
    "INVALID_REQUEST");
  const upper = { header: { ...manifest.header, capture_nonce:
    "A" + (manifest.header["capture_nonce"] as string).slice(1) }, items: manifest.items };
  assert.equal(code(await submit(m, { manifest: upper, signature: body.signature })),
    "INVALID_MANIFEST");
});

test("13 SUBMISSION_SIGNATURE_INVALID", async () => {
  const { m, manifest, body } = await ready();
  const flipped = Buffer.from(body.signature, "hex");
  flipped[0]! ^= 1;
  assert.equal(code(await submit(m, { manifest, signature: flipped.toString("hex") })),
    "SUBMISSION_SIGNATURE_INVALID");
  assert.equal(code(await submit(m, { manifest, signature: sign(m.id, manifest, randomBytes(32)) })),
    "SUBMISSION_SIGNATURE_INVALID");
  const otherRoot = evidenceStatement(m.id, randomBytes(32));
  const wrongRoot = Buffer.from(ed25519.sign(otherRoot, SCOUT_SEED)).toString("hex");
  assert.equal(code(await submit(m, { manifest, signature: wrongRoot })),
    "SUBMISSION_SIGNATURE_INVALID");
});

test("14 CAPTURE_NONCE_INVALID for a nonce never issued and for another assignment's", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  const other = await seedMission();
  const otherSession = await startSession(other);
  for (const value of [randomBytes(32).toString("hex"), otherSession.value]) {
    const manifest = manifestFor(m, { ...s, value });
    upload(m, s, manifest);
    assert.equal(code(await submit(m, { manifest, signature: sign(m.id, manifest) })),
      "CAPTURE_NONCE_INVALID");
  }
});

test("15 CAPTURED_OUTSIDE_SESSION at both edges; the last millisecond inside passes", async () => {
  const m = await seedMission();
  const s = await startSession(m);
  for (const at of [s.issuedAt - 1, s.expiresAt]) {
    const manifest = manifestFor(m, s);
    manifest.items[0]!["captured_at"] = new Date(at).toISOString();
    upload(m, s, manifest);
    assert.equal(code(await submit(m, { manifest, signature: sign(m.id, manifest) })),
      "CAPTURED_OUTSIDE_SESSION");
  }
  const fresh = await seedMission();
  const fs = await startSession(fresh);
  const inside = manifestFor(fresh, fs);
  inside.items[0]!["captured_at"] = new Date(fs.expiresAt - 1).toISOString();
  upload(fresh, fs, inside);
  assert.equal((await submit(fresh, { manifest: inside, signature: sign(fresh.id, inside) }))
    .statusCode, 201);
});

test("16 each photo's place: LOCATION_TOO_IMPRECISE, LOCATION_TOO_FAR, and a pass", async () => {
  const north = formatCoordinate(Number(fixture.policy.lat) + 0.002, "lat");
  const distance = distanceM(Number(north), Number(fixture.policy.lon),
    Number(fixture.policy.lat), Number(fixture.policy.lon));
  const cases: [Record<string, unknown>, string | number][] = [
    [{ horizontal_accuracy_m: 201 }, "LOCATION_TOO_IMPRECISE"],
    [{ lat: north, horizontal_accuracy_m: Math.floor(distance - 151) }, "LOCATION_TOO_FAR"],
    [{ lat: north, horizontal_accuracy_m: Math.ceil(distance - 149) }, 201],
  ];
  for (const [change, want] of cases) {
    const m = await seedMission();
    const s = await startSession(m);
    const manifest = manifestFor(m, s);
    Object.assign(manifest.items[0]!, change);
    upload(m, s, manifest);
    const res = await submit(m, { manifest, signature: sign(m.id, manifest) });
    if (typeof want === "number") assert.equal(res.statusCode, want, res.body);
    else assert.equal(code(res), want);
  }
});

test("17 EVIDENCE_NOT_UPLOADED and STORAGE_UNAVAILABLE consume nothing", async () => {
  const { m, s, manifest, body } = await ready();
  const first = manifest.items[0]!;
  const key = objectKey(m.id, s.id, first.requirement_id, first.photo_sha256);
  const kept = stored.get(key)!;
  stored.delete(key);
  assert.equal(code(await submit(m, body)), "EVIDENCE_NOT_UPLOADED");
  stored.set(key, { ...kept, byteLength: kept.byteLength + 1 });
  assert.equal(code(await submit(m, body)), "EVIDENCE_NOT_UPLOADED");
  stored.set(key, kept);
  storeDown = true;
  const down = await submit(m, body);
  assert.equal(down.statusCode, 503);
  assert.equal(code(down), "STORAGE_UNAVAILABLE");
  assert.equal((await nonceRow(s.value)).status, "ACTIVE");
  assert.equal(await submissionCount(m), 0);
});

test("18 after the grace: CAPTURE_SESSION_EXPIRED, the row EXPIRED, nothing submitted", async () => {
  const { m, s, body } = await ready();
  nowMs = s.expiresAt + 480_000;
  assert.equal(code(await submit(m, body)), "CAPTURE_SESSION_EXPIRED");
  assert.equal((await nonceRow(s.value)).status, "EXPIRED");
  assert.equal(await submissionCount(m), 0);
});

test("19 a second Start after the uploads: CAPTURE_SESSION_SUPERSEDED", async () => {
  const { m, s, body } = await ready();
  nowMs = BASE.getTime() + 1000;
  await startSession(m);
  assert.equal(code(await submit(m, body)), "CAPTURE_SESSION_SUPERSEDED");
  assert.equal((await nonceRow(s.value)).status, "SUPERSEDED");
  assert.equal(await submissionCount(m), 0);
});

test("20 a nonce consumed without a submission: CAPTURE_SESSION_USED", async () => {
  const { m, s, body } = await ready();
  await pool.query(
    "UPDATE capture_nonces SET status = 'CONSUMED', consumed_at = $2 WHERE id = $1",
    [s.id, BASE],
  );
  assert.equal(code(await submit(m, body)), "CAPTURE_SESSION_USED");
  assert.equal(await submissionCount(m), 0);
});

test("21 the nonce row's deployment differs: CAPTURE_NONCE_INVALID, the row unchanged", async () => {
  const { m, s, body } = await ready();
  await pool.query("UPDATE capture_nonces SET deployment_id = 3 WHERE id = $1", [s.id]);
  assert.equal(code(await submit(m, body)), "CAPTURE_NONCE_INVALID");
  const row = await nonceRow(s.value);
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.deployment_id, 3);
});

test("22 the same body twice at once: one 201, one 200, one row", async () => {
  const { m, body } = await ready();
  const results = await Promise.all([submit(m, body), submit(m, body)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(await submissionCount(m), 1);
});

// --- views and privacy (tests 23 and 24) ---

async function view(m: Mission, token: string) {
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${m.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Record<string, any>;
}

test("23 views: the Scout's submission, submit_by, the owner's two keys, a closed Start", async () => {
  const { m, s, body } = await ready();
  const before = await view(m, m.scout.token);
  assert.equal(before["submission"], null);
  assert.equal(before["capture"]["capture_nonce"]["submit_by"],
    new Date(s.expiresAt + 480_000).toISOString());
  const ownerBefore = await view(m, m.requester.token);
  assert.equal(ownerBefore["submission"], null);
  const res = await submit(m, body);
  assert.equal(res.statusCode, 201, res.body);
  const after = await view(m, m.scout.token);
  assert.deepEqual(after["submission"], res.json().submission);
  assert.equal(after["capture"]["capture_nonce"], null);
  const owner = await view(m, m.requester.token);
  assert.deepEqual(Object.keys(owner["submission"]).sort(), ["item_count", "submitted_at"]);
  assert.equal(owner["submission"]["item_count"], 2);
  const stranger = await view(m, (await seedUser()).token);
  assert.equal("submission" in stranger, false);
  const restart = await app.inject({
    method: "POST",
    url: `/bounties/${m.id}/capture-nonce`,
    headers: { authorization: `Bearer ${m.scout.token}` },
    payload: {
      lat: fixture.policy.lat,
      lon: fixture.policy.lon,
      horizontal_accuracy_m: 12,
      fixed_at: new Date(nowMs - 2000).toISOString(),
    },
  });
  assert.equal(code(restart), "ALREADY_SUBMITTED");
});

test("24 no upload URL, signature or coordinate reaches the log", async () => {
  const north = formatCoordinate(Number(fixture.policy.lat) + 0.0003, "lat");
  const m = await seedMission();
  const s = await startSession(m);
  const manifest = manifestFor(m, s);
  for (const it of manifest.items) it["lat"] = north;
  upload(m, s, manifest);
  const body = { manifest, signature: sign(m.id, manifest) };
  captured = "";
  const url = (await uploadUrl(m, uploadBody(s, m.requirements[0]!.id))).json().upload.url;
  assert.equal((await submit(m, body)).statusCode, 201);
  for (const secret of [url, "5e".repeat(32), body.signature, north]) {
    assert.ok(!captured.includes(secret), "found " + secret.slice(0, 20));
  }
  assert.ok(captured.includes(`"url":"/bounties/${m.id}/evidence/upload-url"`));
  assert.ok(captured.includes(`"url":"/bounties/${m.id}/submission"`));
});

// --- the presigner and configuration (tests 25 and 26) ---

test("25 SigV4: AWS's published query example, and a PUT's signed headers", () => {
  // AWS, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)",
  // the example GET of test.txt in examplebucket on 24 May 2013.
  const query = presignQuery({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: {},
    expiresS: 86400,
    now: new Date("2013-05-24T00:00:00.000Z"),
    key: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
  });
  assert.match(
    query,
    /&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
  );
  const evidence = loadEvidenceConfig(STORE_ENV);
  assert.ok(evidence.store !== null);
  const s3 = s3EvidenceStore(evidence.store, evidence.uploadUrlTtlS, fetch);
  const key = objectKey(
    "17e419ff-59a6-4e14-93b4-7a6550d46bd5",
    "96135a13-e126-4213-bc31-58184a6f1e08",
    "11111111-1111-4111-8111-111111111111",
    "9e".repeat(32),
  );
  const put = s3.presignPut(key, new Uint8Array(32).fill(7), 1425407,
    new Date("2026-10-01T00:00:00.000Z"));
  const url = new URL(put.url);
  assert.equal(url.origin, "http://127.0.0.1:7070");
  assert.equal(url.pathname, "/bountycam-evidence/" + key);
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "content-length;host;x-amz-checksum-sha256",
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.deepEqual(put.headers, {
    "content-type": "image/jpeg",
    "x-amz-checksum-sha256": Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
  });
  assert.equal(put.expiresAt.toISOString(), "2026-10-01T00:15:00.000Z");
});

test("26 loadEvidenceConfig: grouping, defaults and limits", () => {
  const none = loadEvidenceConfig({});
  assert.deepEqual(none, { store: null, maxBytes: 10485760, uploadUrlTtlS: 900 });
  const all = loadEvidenceConfig(STORE_ENV);
  assert.deepEqual(all, {
    store: {
      endpoint: "http://127.0.0.1:7070",
      host: "127.0.0.1:7070",
      bucket: "bountycam-evidence",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key-0123456789",
      region: "us-east-1",
    },
    maxBytes: 10485760,
    uploadUrlTtlS: 900,
  });
  assert.throws(() =>
    loadEvidenceConfig({
      EVIDENCE_STORE_ENDPOINT: STORE_ENV.EVIDENCE_STORE_ENDPOINT,
      EVIDENCE_STORE_BUCKET: STORE_ENV.EVIDENCE_STORE_BUCKET,
    }),
  );
  assert.throws(() => loadEvidenceConfig({ ...STORE_ENV, EVIDENCE_UPLOAD_URL_TTL_S: "901" }));
  assert.throws(() => loadEvidenceConfig({ ...STORE_ENV, EVIDENCE_STORE_SECRET_PATH: emptyPath }));
});
