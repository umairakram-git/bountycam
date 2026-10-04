import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SignJWT } from "jose";
import {
  attestationMessage,
  canonicalise,
  distanceM,
  evidenceRoot,
  evidenceStatement,
  formatCoordinate,
  sha256,
} from "@hackathon/shared";
import { buildApp } from "../src/app.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import { jsonRpcChainWriter, type ChainReader, type ChainWriter } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import { attestationTransaction, ATTESTATION_TX_LENGTH } from "../src/chain/tx.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { systemRandomness } from "../src/randomness.ts";
import { objectKey, s3EvidenceStore, type EvidenceStore } from "../src/evidence/store.ts";
import { checkConfigAccount, loadVerifierConfig } from "../src/verifier/config.ts";
import { checkSubmission, tick, type VerifierDeps } from "../src/verifier/run.ts";

// POLICY.md section 19.14. The bounty, policy, assignment and capture nonces are the
// recorded Session 20 rows of bounty 3591bf4c, re-seeded by SQL before each test, with the
// Scout's wallet replaced by SPEC.md section 11.8's test key. Each test builds its own
// manifest over generated photo bytes and signs it with that key. The account is the
// recorded Accepted account of 3591bf4c with its scout overwritten at offset 172 (section
// 16.6) to the test key; tests that need another policy also overwrite policy_hash (72)
// and required_assurance (136), and tests that need a landed attestation write the
// Submitted tail (section 19.10's offsets). That is harness setup, not data. Clock, store,
// chain reader and sender are injected; the attester is the published vector key.

// --- fixtures ---

const FIXTURES = join(process.cwd(), "test", "fixtures");
const json = (p: string) => JSON.parse(readFileSync(join(FIXTURES, p), "utf8"));
const rows = json("devnet/verifier_rows.json");
const accountFixture = json("devnet/verifier_bounty_account.json");
const configFixture = json("devnet/config_account.json");
const txVector = json("vectors/attestation_tx.json");

const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";
const SETTLEMENT_MINT = "ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR";
const SHARED_VECTORS = join(process.cwd(), "..", "..", "packages", "shared", "vectors");
const evidenceVectors = JSON.parse(
  readFileSync(join(SHARED_VECTORS, "evidence_vectors.json"), "utf8"),
) as { scout_seed_ascii: string };
const messageVectors = JSON.parse(readFileSync(join(SHARED_VECTORS, "vectors.json"), "utf8"));
const SCOUT_SEED = Uint8Array.from(Buffer.from(evidenceVectors.scout_seed_ascii, "ascii"));
const SCOUT_WALLET = base58.encode(ed25519.getPublicKey(SCOUT_SEED));
const ATTESTER_SEED = Uint8Array.from(
  Buffer.from(messageVectors.authorities.attester_seed_ascii, "ascii"),
);
const ATTESTER_PUBKEY = ed25519.getPublicKey(ATTESTER_SEED);
const ELIG_SEED = Uint8Array.from(
  Buffer.from(messageVectors.authorities.eligibility_seed_ascii, "ascii"),
);
const RELAYER_SEED = Uint8Array.from(Buffer.from(txVector.relayer_seed_ascii, "ascii"));

/** psql's "2026-10-01 11:18:25.456+10" as a Date. */
const ts = (s: string): Date => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
const hexOf = (s: string): Buffer => Buffer.from(s.replace(/^\\x/, ""), "hex");

const POLICY = rows.policy as Record<string, string>;
const BOUNTY = rows.bounty as Record<string, string>;
const ASSIGNMENT = rows.assignment as Record<string, string>;
const NONCES = rows.capture_nonces as Record<string, string>[];
const CONSUMED = NONCES.find((n) => n["status"] === "CONSUMED")!;
const RECORDED_ITEMS = rows.evidence_items as Record<string, string>[];
const REQUESTER_WALLET = (rows.users as Record<string, string>[])
  .find((u) => u["id"] === BOUNTY["requester_id"])!["wallet_address"]!;
const BOUNTY_ID = BOUNTY["id"]!;
const DEADLINE = ts(ASSIGNMENT["deadline"]!);
const BASE = new Date("2026-10-01T01:30:00.000Z");

// --- scratch database, clock, doubles ---

const dbName = `bountycam_verifier_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;
const psql = (database: string, sql: string): string =>
  execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], { encoding: "utf8" }).trim();

let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

let account: Uint8Array | null = null;
let chainDown = false;
const chain: ChainReader = {
  async getAccount(address) {
    if (chainDown) throw new Error("unreachable");
    if (address !== BOUNTY["program_account"] || account === null) return null;
    return { owner: PROGRAM, data: Uint8Array.from(account) };
  },
};

const objects = new Map<string, Uint8Array>();
const gets: string[] = [];
let storeDown = false;
const store: Pick<EvidenceStore, "get"> = {
  async get(key) {
    gets.push(key);
    if (storeDown) throw new Error("store unreachable");
    return objects.get(key) ?? null;
  },
};

/** What the sender double does with a transaction: land it, land it silently, or fail. */
let sendMode: "LAND" | "LAND_SILENT" | "FAIL" | "NEVER" = "LAND";
const wires: Uint8Array[] = [];
const BLOCKHASH = base58.decode(txVector.blockhash);
const writer: ChainWriter = {
  async getLatestBlockhash() {
    return BLOCKHASH;
  },
  async sendTransaction(wire) {
    wires.push(Uint8Array.from(wire));
    if (sendMode === "FAIL") throw new Error("RPC_ERROR");
    if (sendMode === "LAND" || sendMode === "LAND_SILENT") {
      const msg = wire.slice(298 + 112, 298 + 112 + 261);
      landed(msg.slice(220, 252), msg[252] as number);
    }
    return base58.encode(wire.slice(1, 65));
  },
  async getSignatureStatuses(signatures) {
    return signatures.map(() =>
      sendMode === "LAND" ? { confirmationStatus: "confirmed", failed: false } : null);
  },
};

const lines: string[] = [];
const deps: VerifierDeps = {
  pool: undefined as unknown as pg.Pool,
  clock,
  chain,
  writer,
  store,
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  configAccount: CONFIG_ACCOUNT,
  deploymentId: 2,
  attesterSeed: ATTESTER_SEED,
  attesterPubkey: ATTESTER_PUBKEY,
  relayerSeed: RELAYER_SEED,
  maxBytes: 10485760,
  maxAccuracyM: 200,
  deadlineMarginS: 30,
  confirmS: 60,
  sleep: async (ms) => {
    nowMs += ms;
  },
  log: (level, fields) => void lines.push(JSON.stringify({ level, ...fields })),
};

const dir = mkdtempSync(join(tmpdir(), "bountycam-verifier-test-"));
const jwtPath = join(dir, "jwt-secret.hex");
writeFileSync(jwtPath, randomBytes(32).toString("hex"));
const config = loadConfig({ JWT_SECRET_PATH: jwtPath, SETTLEMENT_MINT });
const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
(deps as { pool: pg.Pool }).pool = pool;
const eligibilityConfig: EligibilityConfig = {
  rpcUrl: "https://rpc.example.test/",
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  configAccount: CONFIG_ACCOUNT,
  keySeed: ELIG_SEED,
  keyPubkey: ed25519.getPublicKey(ELIG_SEED),
};
const deployment: Deployment = {
  deploymentId: 2,
  usdcMint: base58.decode(SETTLEMENT_MINT),
  eligibilityAuthority: ed25519.getPublicKey(ELIG_SEED),
};
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
    seeker: { findSeekerMint: async () => null },
  },
  logger: false,
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
  chainDown = false;
  storeDown = false;
  sendMode = "LAND";
  wires.length = 0;
  gets.length = 0;
  lines.length = 0;
  objects.clear();
});

// --- the account ---

function baseAccount(): Uint8Array {
  const d = Uint8Array.from(Buffer.from(accountFixture.result.value.data[0], "base64"));
  d.set(base58.decode(SCOUT_WALLET), 172);
  return d;
}

function landed(root: Uint8Array, achieved: number): void {
  const d = Uint8Array.from(account!);
  const v = new DataView(d.buffer);
  d[169] = 2;
  d[213] = 1;
  v.setBigInt64(214, BigInt(Math.floor(nowMs / 1000)), true);
  d[222] = 1;
  d.set(root, 223);
  d[255] = 1;
  d[256] = achieved;
  account = d;
}

// --- seeding ---

interface Seed {
  requiredAssurance?: number;
  deploymentId?: number;
  items?: number; // how many of the two requirements get an item
  itemOver?: (item: Record<string, unknown>, i: number) => void;
}

interface Seeded {
  submissionId: string;
  manifest: { header: Record<string, unknown>; items: Record<string, unknown>[] };
  root: Uint8Array;
  keys: string[];
  photos: Uint8Array[];
  requesterToken: string;
  scoutToken: string;
}

async function token(id: string, wallet: string): Promise<string> {
  return new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 3_600_000))
    .setExpirationTime(new Date(DEADLINE.getTime() + 3_600_000))
    .sign(config.jwtSecret);
}

/** Truncate, then seed the recorded rows and one submission of the test's own. */
async function seed(opts: Seed = {}): Promise<Seeded> {
  await pool.query(`TRUNCATE attestations, evidence_items, submissions, capture_nonces,
    assignments, evidence_requirements, bounties, policies, users CASCADE`);
  let canonical = POLICY["canonical_json"]!;
  if (opts.requiredAssurance !== undefined) {
    const p = JSON.parse(canonical);
    p.required_assurance = opts.requiredAssurance;
    canonical = canonicalise(p);
  }
  const policyHash = Buffer.from(sha256(new TextEncoder().encode(canonical)));
  const policy = JSON.parse(canonical);
  account = baseAccount();
  account.set(policyHash, 72);
  account[136] = policy.required_assurance;

  const requester = (await pool.query<{ id: string }>(
    "INSERT INTO users (id, wallet_address) VALUES ($1, $2) RETURNING id",
    [BOUNTY["requester_id"], REQUESTER_WALLET],
  )).rows[0]!.id;
  const scout = (await pool.query<{ id: string }>(
    "INSERT INTO users (id, wallet_address) VALUES ($1, $2) RETURNING id",
    [ASSIGNMENT["scout_id"], SCOUT_WALLET],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO policies (id, requester_id, canonical_json, policy_hash, required_assurance,
       created_at, eligibility_profile_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [POLICY["id"], requester, canonical, policyHash, policy.required_assurance,
      ts(POLICY["created_at"]!), POLICY["eligibility_profile_id"]],
  );
  for (const [i, r] of (policy.evidence_requirements as Record<string, unknown>[]).entries()) {
    await pool.query(
      `INSERT INTO evidence_requirements (id, policy_id, type, prompt, sequence, required)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r["id"], POLICY["id"], r["type"], r["prompt"], i, r["required"]],
    );
  }
  await pool.query(
    `INSERT INTO bounties (id, requester_id, policy_id, title, category, capture_radius_m,
       reward_amount, state, program_account, created_at, location, location_public,
       idempotency_key, request_digest, acceptance_cutoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACCEPTED', $8, $9, $10, $11, $12, $13, $14)`,
    [BOUNTY_ID, requester, POLICY["id"], BOUNTY["title"], BOUNTY["category"],
      BOUNTY["capture_radius_m"], BOUNTY["reward_amount"], BOUNTY["program_account"],
      ts(BOUNTY["created_at"]!), BOUNTY["location"], BOUNTY["location_public"],
      BOUNTY["idempotency_key"], hexOf(BOUNTY["request_digest"]!),
      ts(BOUNTY["acceptance_cutoff"]!)],
  );
  await pool.query(
    `INSERT INTO assignments (id, bounty_id, scout_id, accepted_at, deadline, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
    [ASSIGNMENT["id"], BOUNTY_ID, scout, ts(ASSIGNMENT["accepted_at"]!), DEADLINE,
      ts(ASSIGNMENT["expires_at"]!)],
  );
  for (const n of NONCES) {
    await pool.query(
      `INSERT INTO capture_nonces (id, assignment_id, bounty_id, scout_id, deployment_id, value,
         status, issued_at, expires_at, consumed_at, start_lat, start_lon, start_accuracy_m,
         start_fixed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [n["id"], ASSIGNMENT["id"], BOUNTY_ID, scout, Number(n["deployment_id"]), hexOf(n["value"]!),
        n["status"], ts(n["issued_at"]!), ts(n["expires_at"]!),
        n["consumed_at"] ? ts(n["consumed_at"]) : null, n["start_lat"], n["start_lon"],
        Number(n["start_accuracy_m"]), ts(n["start_fixed_at"]!)],
    );
  }

  const count = opts.items ?? 2;
  const photos: Uint8Array[] = [];
  const items = RECORDED_ITEMS.slice(0, count).map((r, i) => {
    const photo = Uint8Array.from(randomBytes(1000 + i));
    photos.push(photo);
    const it: Record<string, unknown> = {
      byte_length: photo.length,
      captured_at: ts(r["captured_at"]!).toISOString(),
      fixed_at: ts(r["fixed_at"]!).toISOString(),
      horizontal_accuracy_m: Number(r["horizontal_accuracy_m"]),
      lat: r["lat"],
      lon: r["lon"],
      photo_sha256: Buffer.from(sha256(photo)).toString("hex"),
      requirement_id: r["requirement_id"],
    };
    opts.itemOver?.(it, i);
    return it;
  });
  const manifest = {
    header: {
      assignment_id: ASSIGNMENT["id"],
      bounty_id: BOUNTY_ID,
      capture_nonce: hexOf(CONSUMED["value"]!).toString("hex"),
      deployment_id: opts.deploymentId ?? 2,
      manifest_version: 1,
      policy_hash: policyHash.toString("hex"),
      scout: SCOUT_WALLET,
    },
    items,
  };
  const root = evidenceRoot(manifest);
  const signature = ed25519.sign(evidenceStatement(BOUNTY_ID, root), SCOUT_SEED);
  const submissionId = (await pool.query<{ id: string }>(
    `INSERT INTO submissions (assignment_id, bounty_id, scout_id, capture_nonce_id, manifest,
       evidence_root, statement_signature, achieved_assurance, attester_signature, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8) RETURNING id`,
    [ASSIGNMENT["id"], BOUNTY_ID, scout, CONSUMED["id"], canonicalise(manifest),
      Buffer.from(root), Buffer.from(signature), ts(CONSUMED["consumed_at"]!)],
  )).rows[0]!.id;
  const keys: string[] = [];
  for (const [i, it] of items.entries()) {
    const key = objectKey(BOUNTY_ID, CONSUMED["id"]!, it["requirement_id"] as string,
      it["photo_sha256"] as string);
    keys.push(key);
    objects.set(key, photos[i]!);
    await pool.query(
      `INSERT INTO evidence_items (submission_id, requirement_id, storage_key, hash,
         c2pa_present, captured_at, byte_length, lat, lon, horizontal_accuracy_m, fixed_at)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, $9, $10)`,
      [submissionId, it["requirement_id"], key, Buffer.from(it["photo_sha256"] as string, "hex"),
        new Date(it["captured_at"] as string), it["byte_length"], it["lat"], it["lon"],
        it["horizontal_accuracy_m"], new Date(it["fixed_at"] as string)],
    );
  }
  return {
    submissionId,
    manifest,
    root,
    keys,
    photos,
    requesterToken: await token(requester, REQUESTER_WALLET),
    scoutToken: await token(scout, SCOUT_WALLET),
  };
}

async function job(id: string): Promise<Record<string, any>> {
  return (await pool.query("SELECT * FROM attestations WHERE submission_id = $1", [id])).rows[0]!;
}

async function bountyState(): Promise<string> {
  return (await pool.query<{ state: string }>("SELECT state FROM bounties WHERE id = $1",
    [BOUNTY_ID])).rows[0]!.state;
}

const ED_DATA = [298, 298 + 373] as const; // the ed25519 instruction's data in the wire

async function view(tok: string): Promise<Record<string, any>> {
  const res = await app.inject({
    method: "GET",
    url: `/bounties/${BOUNTY_ID}`,
    headers: { authorization: `Bearer ${tok}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

// --- tests ---

test("01 the valid job: A1, signed, sent, confirmed and projected", async () => {
  const s = await seed();
  await tick(deps);
  const row = await job(s.submissionId);
  const d = new DataView(account!.buffer);
  const expected = attestationMessage({
    deploymentId: 2,
    programId: base58.decode(PROGRAM),
    bountyId: account!.slice(8, 24),
    requester: account!.slice(24, 56),
    scout: base58.decode(SCOUT_WALLET),
    policyHash: account!.slice(72, 104),
    eligibilityProfileHash: account!.slice(104, 136),
    requiredAssurance: 1,
    deadline: d.getBigInt64(205, true),
    reviewWindowSecs: d.getBigInt64(153, true),
    evidenceRoot: s.root,
    achievedAssurance: 1,
    issuedAt: BigInt(Math.floor(BASE.getTime() / 1000)),
  });
  assert.equal(Buffer.from(row["message"]).toString("hex"), Buffer.from(expected).toString("hex"));
  assert.ok(ed25519.verify(row["signature"], expected, ATTESTER_PUBKEY));
  assert.equal(wires.length, 1);
  const want = attestationTransaction({
    relayerSeed: RELAYER_SEED,
    bountyAccount: base58.decode(BOUNTY["program_account"]!),
    configAccount: base58.decode(CONFIG_ACCOUNT),
    programId: base58.decode(PROGRAM),
    attesterPubkey: ATTESTER_PUBKEY,
    message: expected,
    signature: Uint8Array.from(row["signature"]),
    blockhash: BLOCKHASH,
  });
  assert.deepEqual(wires[0], want.wire);
  assert.equal(row["status"], "SUBMITTED");
  assert.equal(row["achieved_assurance"], 1);
  assert.equal(row["tx_signature"], want.signature);
  assert.equal(row["sends"], 1);
  assert.equal(await bountyState(), "SUBMITTED");
  const sub = (await pool.query("SELECT * FROM submissions WHERE id = $1", [s.submissionId]))
    .rows[0]!;
  assert.equal(sub["achieved_assurance"], 1);
  assert.deepEqual(sub["attester_signature"], row["signature"]);
  const a = await pool.query("SELECT status FROM assignments WHERE id = $1", [ASSIGNMENT["id"]]);
  assert.equal(a.rows[0]!.status, "ACTIVE");
});

test("02 recorded data: the 3591bf4c manifest, root and signature pass step 6", () => {
  const sub = rows.submission as Record<string, string>;
  const items = RECORDED_ITEMS.map((r) => ({
    requirement_id: r["requirement_id"]!,
    storage_key: r["storage_key"]!,
    hash: hexOf(r["hash"]!),
    captured_at: ts(r["captured_at"]!),
    byte_length: r["byte_length"]!,
    lat: r["lat"]!,
    lon: r["lon"]!,
    horizontal_accuracy_m: Number(r["horizontal_accuracy_m"]),
    fixed_at: ts(r["fixed_at"]!),
  }));
  const scoutWallet = (rows.users as Record<string, string>[])
    .find((u) => u["id"] === sub["scout_id"])!["wallet_address"]!;
  const ctx = {
    bountyId: BOUNTY_ID,
    assignmentId: sub["assignment_id"]!,
    manifest: sub["manifest"]!,
    evidenceRoot: hexOf(sub["evidence_root"]!),
    statementSignature: hexOf(sub["statement_signature"]!),
    scoutWallet,
    policyHash: hexOf(POLICY["policy_hash"]!),
  };
  assert.equal(checkSubmission(ctx, 2, items), true);
  assert.equal(checkSubmission({ ...ctx, scoutWallet: SCOUT_WALLET }, 2, items), false);
});

test("03 enqueue: one PENDING row per submission, once", async () => {
  const s = await seed();
  account![169] = 5; // Refunded, so the job ends at step 3 without sending
  nowMs = BASE.getTime();
  await tick(deps);
  const n = await pool.query("SELECT count(*)::int AS n FROM attestations");
  assert.equal(n.rows[0]!.n, 1);
  await tick(deps);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM attestations")).rows[0]!.n, 1);
  const row = await job(s.submissionId);
  assert.equal(row["created_at"].toISOString(), BASE.toISOString());
});

test("04 deadline: 30 s before proceeds; one second later LAPSED, no read, no send", async () => {
  let s = await seed();
  nowMs = DEADLINE.getTime() - 30_000;
  await tick(deps);
  assert.equal((await job(s.submissionId))["status"], "SUBMITTED");
  s = await seed();
  nowMs = DEADLINE.getTime() - 29_000;
  await tick(deps);
  const row = await job(s.submissionId);
  assert.equal(row["status"], "LAPSED");
  assert.equal(row["reason"], "DEADLINE");
  assert.equal(gets.length, 2); // only the first job's two photos
  assert.equal(wires.length, 1);
});

test("05 retry: status kept, backoff 5, 10, 20, 40, 60, 60 seconds", async () => {
  const s = await seed();
  chainDown = true;
  const delays = [5, 10, 20, 40, 60, 60];
  for (const [i, delay] of delays.entries()) {
    const before = nowMs;
    await tick(deps);
    const row = await job(s.submissionId);
    assert.equal(row["status"], "PENDING");
    assert.equal(row["tries"], i + 1);
    assert.equal(row["next_attempt_at"].getTime(), before + delay * 1000);
    nowMs = row["next_attempt_at"].getTime();
  }
});

test("06 chain state: no account, Funded, Refunded, and Submitted for PENDING", async () => {
  for (const set of [
    () => { account = null; },
    () => { account![169] = 0; },
    () => { account![169] = 5; },
    () => { landed(randomBytes(32), 1); },
  ]) {
    const s = await seed();
    set();
    await tick(deps);
    const row = await job(s.submissionId);
    assert.equal(row["status"], "REFUSED");
    assert.equal(row["reason"], "CHAIN_STATE");
  }
  assert.equal(wires.length, 0);
});

test("07 bindings: each binding and the canonical text, BINDING_MISMATCH", async () => {
  const offsets = [56, 104, 136, 137, 145, 153, 72]; // reward, profile, required, windows, hash
  for (const off of offsets) {
    const s = await seed();
    account![off] = (account![off]! + 1) & 0xff;
    await tick(deps);
    assert.equal((await job(s.submissionId))["reason"], "BINDING_MISMATCH", "offset " + off);
  }
  const s = await seed();
  await pool.query(
    "UPDATE policies SET canonical_json = replace(canonical_json, '\"salt\":\"a', '\"salt\":\"b')",
  );
  await tick(deps);
  assert.equal((await job(s.submissionId))["reason"], "BINDING_MISMATCH");
  assert.equal(wires.length, 0);
});

test("08 parties: another Scout, another deadline, PARTY_MISMATCH", async () => {
  let s = await seed();
  account!.set(randomBytes(32), 172);
  await tick(deps);
  assert.equal((await job(s.submissionId))["reason"], "PARTY_MISMATCH");
  s = await seed();
  account![205] = (account![205]! + 1) & 0xff;
  await tick(deps);
  assert.equal((await job(s.submissionId))["reason"], "PARTY_MISMATCH");
});

test("09 submission: text, root, signature, item digest, header; SUBMISSION_INVALID", async () => {
  const mutations = [
    "UPDATE submissions SET manifest = manifest || ' '",
    "UPDATE submissions SET evidence_root = decode(repeat('ab', 32), 'hex')",
    "UPDATE submissions SET statement_signature = set_byte(statement_signature, 0, " +
      "get_byte(statement_signature, 0) # 1)",
    "UPDATE evidence_items SET hash = decode(repeat('cd', 32), 'hex') WHERE requirement_id = " +
      `'${RECORDED_ITEMS[0]!["requirement_id"]}'`,
  ];
  for (const sql of mutations) {
    const s = await seed();
    await pool.query(sql);
    await tick(deps);
    assert.equal((await job(s.submissionId))["reason"], "SUBMISSION_INVALID", sql);
  }
  const s = await seed({ deploymentId: 3 });
  await tick(deps);
  assert.equal((await job(s.submissionId))["reason"], "SUBMISSION_INVALID");
});

test("10 requirements: a required requirement without an item", async () => {
  const s = await seed({ items: 1 });
  await tick(deps);
  assert.equal((await job(s.submissionId))["reason"], "REQUIREMENTS_INCOMPLETE");
});

test("11 photos: missing, longer, other bytes refuse; unreachable retries; GET signed",
  async () => {
  for (const change of [
    (s: Seeded) => objects.delete(s.keys[0]!),
    (s: Seeded) => objects.set(s.keys[0]!, Uint8Array.from([...s.photos[0]!, 0])),
    (s: Seeded) => {
      const other = Uint8Array.from(s.photos[1]!);
      other[0] = other[0]! ^ 1;
      objects.set(s.keys[1]!, other);
    },
  ]) {
    const s = await seed();
    change(s);
    await tick(deps);
    assert.equal((await job(s.submissionId))["reason"], "EVIDENCE_MISSING");
  }
  const s = await seed();
  storeDown = true;
  gets.length = 0;
  await tick(deps);
  const row = await job(s.submissionId);
  assert.equal(row["status"], "PENDING");
  assert.equal(row["tries"], 1);
  assert.deepEqual(gets, [s.keys[0]]);
  // The S3 implementation: a header-signed GET, read to at most maxBytes + 1 bytes.
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const s3 = s3EvidenceStore(
    { endpoint: "http://127.0.0.1:7070", host: "127.0.0.1:7070", bucket: "bountycam-evidence",
      accessKeyId: "test-access-key", secretAccessKey: "test-secret", region: "us-east-1" },
    900,
    (async (url: string, init: { method: string; headers: Record<string, string> }) => {
      seen.push({ url, ...init });
      return new Response(new Uint8Array(50), { status: 200 });
    }) as unknown as typeof fetch,
    () => BASE,
  );
  const got = await s3.get(s.keys[0]!, 9);
  assert.equal(got!.length, 10);
  assert.equal(seen[0]!.method, "GET");
  assert.equal(seen[0]!.url, "http://127.0.0.1:7070/bountycam-evidence/" + s.keys[0]);
  assert.match(seen[0]!.headers["authorization"]!,
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
});

test("12 A0: nonce SUPERSEDED, a capture at expires_at, an item too far; each signed at 0",
  async () => {
    const expires = ts(CONSUMED["expires_at"]!).toISOString();
    const lat = formatCoordinate(Number(JSON.parse(POLICY["canonical_json"]!).lat) + 0.002, "lat");
    const policy = JSON.parse(POLICY["canonical_json"]!);
    const far = distanceM(Number(lat), Number(policy.lon), Number(policy.lat), Number(policy.lon));
    const cases: Seed[] = [
      { requiredAssurance: 0 },
      { requiredAssurance: 0, itemOver: (it, i) => { if (i === 0) it["captured_at"] = expires; } },
      { requiredAssurance: 0, itemOver: (it, i) => {
        if (i === 0) {
          it["lat"] = lat;
          it["lon"] = policy.lon;
          it["horizontal_accuracy_m"] = Math.floor(far - 151);
        }
      } },
    ];
    for (const [i, c] of cases.entries()) {
      const s = await seed(c);
      if (i === 0) {
        await pool.query(
          "UPDATE capture_nonces SET status = 'SUPERSEDED', consumed_at = NULL WHERE id = $1",
          [CONSUMED["id"]],
        );
      }
      sendMode = "NEVER";
      await tick(deps);
      const row = await job(s.submissionId);
      assert.equal(row["status"], "SIGNED", "case " + i);
      assert.equal(row["achieved_assurance"], 0);
      assert.equal(row["message"][252], 0);
    }
  });

test("13 shortfall: A0 evidence on a bounty requiring 1, nothing signed or sent", async () => {
  const s = await seed();
  await pool.query(
    "UPDATE capture_nonces SET status = 'SUPERSEDED', consumed_at = NULL WHERE id = $1",
    [CONSUMED["id"]],
  );
  await tick(deps);
  const row = await job(s.submissionId);
  assert.equal(row["status"], "SHORTFALL");
  assert.equal(row["achieved_assurance"], 0);
  assert.equal(row["message"], null);
  assert.equal(wires.length, 0);
});

test("14 a failed send: SIGNED, sends 1, tries 1; the resend carries identical bytes",
  async () => {
    const s = await seed();
    sendMode = "FAIL";
    await tick(deps);
    let row = await job(s.submissionId);
    assert.equal(row["status"], "SIGNED");
    assert.equal(row["sends"], 1);
    assert.equal(row["tries"], 1);
    nowMs = row["next_attempt_at"].getTime();
    await tick(deps);
    row = await job(s.submissionId);
    assert.equal(row["sends"], 2);
    assert.equal(wires.length, 2);
    assert.deepEqual(wires[1]!.slice(...ED_DATA), wires[0]!.slice(...ED_DATA));
    assert.deepEqual(wires[1]!.slice(ED_DATA[0] + 112, ED_DATA[1]),
      Uint8Array.from(row["message"]));
  });

test("15 unconfirmed in the window, then found Submitted with this root: projected",
  async () => {
    const s = await seed();
    sendMode = "LAND_SILENT";
    const start = nowMs;
    await tick(deps);
    assert.ok(nowMs - start >= 60_000);
    assert.equal((await job(s.submissionId))["status"], "SUBMITTED");
    assert.equal(await bountyState(), "SUBMITTED");
  });

test("16 restart: a SIGNED row already Submitted is projected unsent; another root refused",
  async () => {
    let s = await seed();
    sendMode = "FAIL";
    await tick(deps);
    landed(s.root, 1);
    nowMs = (await job(s.submissionId))["next_attempt_at"].getTime();
    await tick(deps);
    assert.equal((await job(s.submissionId))["status"], "SUBMITTED");
    assert.equal(wires.length, 1);
    s = await seed();
    sendMode = "FAIL";
    await tick(deps);
    landed(randomBytes(32), 1);
    nowMs = (await job(s.submissionId))["next_attempt_at"].getTime();
    await tick(deps);
    const row = await job(s.submissionId);
    assert.equal(row["status"], "REFUSED");
    assert.equal(row["reason"], "CHAIN_STATE");
    assert.notEqual(row["message"], null); // amendment A1: the signed bytes stay
  });

test("17 projection: another grade retries; a bounty already SUBMITTED changes nothing else",
  async () => {
    let s = await seed();
    sendMode = "FAIL";
    await tick(deps);
    landed(s.root, 0);
    nowMs = (await job(s.submissionId))["next_attempt_at"].getTime();
    await tick(deps);
    let row = await job(s.submissionId);
    assert.equal(row["status"], "SIGNED");
    assert.equal(row["tries"], 2); // one failed send, then the grade mismatch
    assert.equal(await bountyState(), "ACCEPTED");
    s = await seed();
    sendMode = "LAND";
    await pool.query("UPDATE bounties SET state = 'SUBMITTED' WHERE id = $1", [BOUNTY_ID]);
    await tick(deps);
    row = await job(s.submissionId);
    assert.equal(row["status"], "SUBMITTED");
    assert.equal(await bountyState(), "SUBMITTED");
    const a = await pool.query("SELECT status FROM assignments WHERE id = $1",
      [ASSIGNMENT["id"]]);
    assert.equal(a.rows[0]!.status, "ACTIVE");
  });

test("18 views: CHECKING, VERIFIED, NOT_VERIFIED; SUBMITTED serves both views", async () => {
  const s = await seed();
  assert.equal((await view(s.scoutToken))["submission"]["verification"], "CHECKING");
  assert.equal((await view(s.requesterToken))["submission"]["verification"], "CHECKING");
  await tick(deps);
  const scout = await view(s.scoutToken);
  const owner = await view(s.requesterToken);
  assert.equal(scout["state"], "SUBMITTED");
  assert.equal(scout["submission"]["verification"], "VERIFIED");
  assert.equal(scout["assignment"]["id"], ASSIGNMENT["id"]); // the assigned-Scout view
  assert.deepEqual(Object.keys(owner["submission"]).sort(),
    ["item_count", "submitted_at", "verification"]);
  assert.equal(owner["submission"]["verification"], "VERIFIED");
  for (const [status, reason, achieved] of [
    ["REFUSED", "EVIDENCE_MISSING", null],
    ["SHORTFALL", null, 0],
    ["LAPSED", "DEADLINE", null],
  ] as const) {
    const t = await seed();
    await pool.query(
      `INSERT INTO attestations (submission_id, status, reason, achieved_assurance, tries, sends,
         next_attempt_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, 0, $5, $5, $5)`,
      [t.submissionId, status, reason, achieved, BASE],
    );
    assert.equal((await view(t.scoutToken))["submission"]["verification"], "NOT_VERIFIED");
    assert.equal((await view(t.requesterToken))["submission"]["verification"], "NOT_VERIFIED");
  }
});

test("19 the transaction: the web3.js vector, 728 bytes, the discriminator; RPC replies",
  async () => {
    const att = messageVectors.vectors.find((v: { name: string }) => v.name === "ATT-01");
    const tx = attestationTransaction({
      relayerSeed: RELAYER_SEED,
      bountyAccount: base58.decode(txVector.bounty_account),
      configAccount: base58.decode(txVector.config_account),
      programId: base58.decode(txVector.program_id),
      attesterPubkey: ATTESTER_PUBKEY,
      message: Buffer.from(att.message_hex, "hex"),
      signature: Buffer.from(att.signature_hex, "hex"),
      blockhash: BLOCKHASH,
    });
    assert.equal(Buffer.from(tx.wire).toString("hex"), txVector.wire_hex);
    assert.equal(tx.signature, txVector.signature);
    assert.equal(tx.wire.length, ATTESTATION_TX_LENGTH);
    assert.equal(tx.wire.length, 728);
    const ix1 = 298 + 373 + 1 + 1 + 3 + 1;
    assert.equal(Buffer.from(tx.wire.slice(ix1, ix1 + 8)).toString("hex"), "eedcff69b7d32853");
    // The JSON-RPC writer over recorded devnet replies.
    const reply = (file: string) => (async () => ({
      ok: true,
      status: 200,
      text: async () => readFileSync(join(FIXTURES, "devnet", file), "utf8"),
    }));
    const hash = await jsonRpcChainWriter("https://x.test/", reply("latest_blockhash.json"))
      .getLatestBlockhash();
    assert.equal(base58.encode(hash), "3QdTJ5s3UZHk31NCrP2CuKFg3z6bNaWZLRwFLTMUfobH");
    const statuses = await jsonRpcChainWriter("https://x.test/", reply("signature_statuses.json"))
      .getSignatureStatuses(["a", "b", "c"]);
    assert.deepEqual(statuses, [
      { confirmationStatus: "finalized", failed: false },
      { confirmationStatus: "finalized", failed: false },
      null,
    ]);
    await assert.rejects(
      jsonRpcChainWriter("https://x.test/", reply("send_malformed.json"))
        .sendTransaction(new Uint8Array(3)),
      (e: unknown) => (e as { code?: string }).code === "RPC_ERROR",
    );
  });

test("20 configuration and logs", async () => {
  const keyFile = (seed: Uint8Array, pub = ed25519.getPublicKey(seed)) => {
    const p = join(dir, randomBytes(4).toString("hex") + ".json");
    writeFileSync(p, JSON.stringify([...seed, ...pub]));
    return p;
  };
  const secret = join(dir, "store-secret");
  writeFileSync(secret, "test-secret-key-0123456789\n");
  const env = {
    DATABASE_URL: dbUrl,
    SOLANA_RPC_URL: "https://rpc.example.test/",
    ESCROW_PROGRAM_ID: PROGRAM,
    ESCROW_CONFIG_ACCOUNT: CONFIG_ACCOUNT,
    EVIDENCE_STORE_ENDPOINT: "http://127.0.0.1:7070",
    EVIDENCE_STORE_BUCKET: "bountycam-evidence",
    EVIDENCE_STORE_ACCESS_KEY_ID: "test-access-key",
    EVIDENCE_STORE_SECRET_PATH: secret,
    ATTESTER_KEY_PATH: keyFile(ATTESTER_SEED),
    RELAYER_KEY_PATH: keyFile(RELAYER_SEED),
  };
  assert.equal(loadVerifierConfig(env).deadlineMarginS, 30);
  assert.throws(() => loadVerifierConfig({ ...env, ATTESTER_KEY_PATH: "" }), /not set/);
  assert.throws(() => loadVerifierConfig({
    ...env, ATTESTER_KEY_PATH: keyFile(ATTESTER_SEED, ed25519.getPublicKey(RELAYER_SEED)),
  }), /does not match/);
  assert.throws(() => loadVerifierConfig({ ...env, RELAYER_KEY_PATH: env.ATTESTER_KEY_PATH }),
    /must differ/);
  const configInfo = {
    owner: configFixture.result.value.owner as string,
    data: Uint8Array.from(Buffer.from(configFixture.result.value.data[0], "base64")),
  };
  assert.throws(() => checkConfigAccount(configInfo,
    { programId: PROGRAM, attesterPubkey: ATTESTER_PUBKEY }), /attester_authority/);
  assert.equal(checkConfigAccount(configInfo, {
    programId: PROGRAM,
    attesterPubkey: base58.decode("2KAuf8WWHGDm4rA1MCCQ9UciEAiqyTHaKeyBHZFF3wZ5"),
  }), 2);
  assert.throws(() => loadVerifierConfig({ ...env, VERIFIER_DEADLINE_MARGIN_S: "120" }), /D152/);
  assert.doesNotThrow(() => loadConfig({ JWT_SECRET_PATH: jwtPath, SETTLEMENT_MINT }));
  // Logs from a valid job and a refused one.
  let s = await seed();
  await tick(deps);
  const signed = await job(s.submissionId);
  const forbidden = [...s.keys, ...s.manifest.items.flatMap((it) => [it["lat"], it["lon"]]),
    Buffer.from(signed["message"]).toString("hex"),
    Buffer.from(signed["signature"]).toString("hex")];
  s = await seed();
  objects.delete(s.keys[0]!);
  await tick(deps);
  const text = lines.join("\n");
  assert.ok(text.includes('"status":"SUBMITTED"') && text.includes('"reason":"EVIDENCE_MISSING"'));
  assert.ok(lines.some((l) => l.includes('"level":"error"') && l.includes("EVIDENCE_MISSING")));
  for (const f of [...forbidden, ...s.keys]) {
    assert.ok(!text.includes(String(f)), "found " + String(f).slice(0, 24));
  }
});
