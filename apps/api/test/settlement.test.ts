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
import { buildApp } from "../src/app.ts";
import { readTail } from "../src/chain/bounty.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import { associatedTokenAddress } from "../src/chain/pda.ts";
import {
  jsonRpcChainReader,
  jsonRpcSettlementReader,
  type ChainWriter,
  type FetchLike,
} from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import {
  expireMessage,
  REJECT_DISCRIMINATOR,
  releaseMessage,
  RESOLVE_DISCRIMINATOR,
  resolveMessage,
} from "../src/chain/tx.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { objectPath, presignQuery } from "../src/evidence/sigv4.ts";
import { s3EvidenceStore, signingKey } from "../src/evidence/store.ts";
import { systemRandomness } from "../src/randomness.ts";
import { projectSettlement, type SettlementDeps } from "../src/settlement/project.ts";
import { settlementKeys, settlementPass, type ReleaseDeps } from "../src/settlement/release.ts";

// POLICY.md section 20.13. The rows are the recorded bountycam_dev rows of bounty d649d6f4
// (settlement/d649d6f4_rows.json) and 3591bf4c (verifier_rows.json), seeded by SQL before
// each test. The accounts, transactions and signature lists are the D163 records, served
// through the production JSON-RPC parsers by a fetch double. Where a test needs a state no
// record holds (approve, reject, resolve), it changes a recorded account's state byte and
// tail or a recorded transaction's instruction data, and says so: harness setup, not data.

// --- fixtures ---

const FIXTURES = join(process.cwd(), "test", "fixtures");
const json = (p: string) => JSON.parse(readFileSync(join(FIXTURES, p), "utf8"));
const S = "devnet/settlement/";
const d649 = json(S + "d649d6f4_rows.json");
const r3591 = json("devnet/verifier_rows.json");
const recorded = json(S + "recorded_messages.json");
const resolveVector = json("vectors/resolve_web3.json");
// The Session 22 live runs: 2c92c434 approved from the Seeker; 70af9c0f rejected from the
// Seeker naming one requirement, then resolved by the arbiter paying the Scout.
const runA = json(S + "2c92c434_rows.json");
const runB = json(S + "70af9c0f_rows.json");
const BA = runA.bounty.id as string;
const AA = runA.bounty.program_account as string;
const BB = runB.bounty.id as string;
const AB = runB.bounty.program_account as string;
const APPROVE_SIG = json(S + "2c92c434_signatures.json").result[0].signature as string;
const RESOLVE_SIG = json(S + "70af9c0f_signatures.json").result[0].signature as string;
const REJECT_SIG = json(S + "70af9c0f_signatures.json").result[1].signature as string;
const ARBITER_LIVE = "6YPX1obwh62N2DDyxtNa2RwkriWUUWLzjAvEWJFbvK1K";

const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";
const MINT = "ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR";
const RELAYER_LIVE = "6Wv1pzq7nizyvrkXuGc91PFK9mbskLRULiwWEpaSaGED";
const SCOUT_WALLET = "7oSUM9a2PgNbFwYhFFXU5p1mrZr1hTykFWVqosNmT7vW";
const REQUESTER_WALLET = "9BZ17sUdF2matCurxmdmUpD3BNabBTFmsmAVu5oY9qP3";
const B649 = d649.bounty.id as string;
const A649 = d649.bounty.program_account as string;
const B3591 = r3591.bounty.id as string;
const A3591 = r3591.bounty.program_account as string;
const RELEASE_SIG = json(S + "d649d6f4_signatures.json").result[0].signature as string;
const EXPIRE_SIG = json(S + "3591bf4c_signatures.json").result[0].signature as string;
const RELAYER_SEED = Uint8Array.from(Buffer.from(resolveVector.relayer_seed_ascii, "ascii"));
const ARBITER_SEED = Uint8Array.from(Buffer.from(resolveVector.arbiter_seed_ascii, "ascii"));
const messageVectors = JSON.parse(readFileSync(
  join(process.cwd(), "..", "..", "packages", "shared", "vectors", "vectors.json"), "utf8"));
const ELIG_SEED = Uint8Array.from(
  Buffer.from(messageVectors.authorities.eligibility_seed_ascii, "ascii"));

const ts = (s: string): Date => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
const hexOf = (s: string): Buffer => Buffer.from(s.replace(/^\\x/, ""), "hex");
const dataOf = (f: string): Uint8Array =>
  Uint8Array.from(Buffer.from(json(S + f).result.value.data[0], "base64"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const REQ_IDS = (JSON.parse(d649.policy.canonical_json).evidence_requirements as
  { id: string }[]).map((r) => r.id);
const uuidBytes = (u: string) => Uint8Array.from(Buffer.from(u.replace(/-/g, ""), "hex"));

// --- chain double: the production parsers over recorded responses ---

const accounts = new Map<string, Uint8Array | null>();
const signatureLists = new Map<string, unknown[]>();
const transactions = new Map<string, unknown>();
let chainDown = false;
const rpcCalls: string[] = [];
const fetchDouble: FetchLike = async (_url, init) => {
  const body = JSON.parse(init.body) as { method: string; params: unknown[] };
  rpcCalls.push(body.method);
  if (chainDown) throw new Error("unreachable");
  let result: unknown;
  if (body.method === "getAccountInfo") {
    const data = accounts.get(body.params[0] as string) ?? null;
    result = { context: { slot: 1 }, value: data === null ? null : {
      owner: PROGRAM, data: [Buffer.from(data).toString("base64"), "base64"],
      lamports: 1, executable: false, rentEpoch: 0 } };
  } else if (body.method === "getSignaturesForAddress") {
    result = signatureLists.get(body.params[0] as string) ?? [];
  } else if (body.method === "getTransaction") {
    result = transactions.get(body.params[0] as string) ?? null;
  } else {
    throw new Error("unexpected method " + body.method);
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) };
};
const chain = jsonRpcChainReader("https://rpc.example.test/", fetchDouble);
const settlement = jsonRpcSettlementReader("https://rpc.example.test/", fetchDouble);

function loadRecorded(): void {
  accounts.clear();
  signatureLists.clear();
  transactions.clear();
  accounts.set(A649, dataOf("d649d6f4_paid_account.json"));
  accounts.set(A3591, dataOf("3591bf4c_refunded_account.json"));
  signatureLists.set(A649, json(S + "d649d6f4_signatures.json").result);
  signatureLists.set(A3591, json(S + "3591bf4c_signatures.json").result);
  transactions.set(RELEASE_SIG, json(S + "d649d6f4_release_tx.json").result);
  transactions.set(EXPIRE_SIG, json(S + "3591bf4c_expire_tx.json").result);
  accounts.set(AA, dataOf("2c92c434_paid_account.json"));
  accounts.set(AB, dataOf("70af9c0f_paid_account.json"));
  signatureLists.set(AA, json(S + "2c92c434_signatures.json").result);
  signatureLists.set(AB, json(S + "70af9c0f_signatures.json").result);
  transactions.set(APPROVE_SIG, json(S + "2c92c434_approve_tx.json").result);
  transactions.set(REJECT_SIG, json(S + "70af9c0f_reject_tx.json").result);
  transactions.set(RESOLVE_SIG, json(S + "70af9c0f_resolve_tx.json").result);
}

/** Harness setup: Run B's recorded Paid account with another state byte. The Disputed
 * state it held between reject and resolve cannot be read back from the chain. */
function runBAccount(state: number): Uint8Array {
  const d = dataOf("70af9c0f_paid_account.json");
  d[169] = state;
  return d;
}

/** Harness setup: Run B's recorded resolve with its outcome byte replaced. */
function runBResolve(outcome: number): unknown {
  const tx = clone(json(S + "70af9c0f_resolve_tx.json").result);
  const keys = tx.transaction.message.accountKeys as string[];
  const ix = (tx.transaction.message.instructions as { programIdIndex: number;
    data: string }[]).find((i) => keys[i.programIdIndex] === PROGRAM)!;
  const data = base58.decode(ix.data);
  data[8] = outcome;
  ix.data = base58.encode(data);
  return tx;
}

/** Harness setup: the recorded release transaction with its escrow instruction replaced. */
function harnessTx(data: Uint8Array, accountsAt: (orig: number[]) => number[]): unknown {
  const tx = clone(json(S + "d649d6f4_release_tx.json").result);
  const keys = tx.transaction.message.accountKeys as string[];
  const ix = (tx.transaction.message.instructions as { programIdIndex: number;
    accounts: number[]; data: string }[]).find((i) => keys[i.programIdIndex] === PROGRAM)!;
  ix.data = base58.encode(data);
  ix.accounts = accountsAt(ix.accounts);
  return tx;
}
const cat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
/** Harness setup: the recorded Submitted account with another state and a failed id. */
function harnessAccount(state: number, failed: string | null): Uint8Array {
  const d = dataOf("d649d6f4_submitted_account.json");
  d[169] = state;
  if (failed !== null) {
    d[257] = 1;
    d.set(uuidBytes(failed), 258);
  }
  return d;
}

// --- scratch database, clock, app ---

const dbName = `bountycam_settlement_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;
const psql = (database: string, sql: string): string =>
  execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], { encoding: "utf8" }).trim();

const AFTER_WINDOW = new Date("2026-10-05T01:00:00.000Z");
let nowMs = AFTER_WINDOW.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const dir = mkdtempSync(join(tmpdir(), "bountycam-settlement-test-"));
const jwtPath = join(dir, "jwt-secret.hex");
writeFileSync(jwtPath, randomBytes(32).toString("hex"));
const secretPath = join(dir, "store-secret");
writeFileSync(secretPath, "test-secret-key\n");
const STORE_ENV = {
  EVIDENCE_STORE_ENDPOINT: "http://127.0.0.1:7070",
  EVIDENCE_STORE_BUCKET: "bountycam-evidence",
  EVIDENCE_STORE_ACCESS_KEY_ID: "test-access-key",
  EVIDENCE_STORE_SECRET_PATH: secretPath,
};
const config = loadConfig({ JWT_SECRET_PATH: jwtPath, SETTLEMENT_MINT: MINT, ...STORE_ENV });
const storeConfig = config.evidence!.store!;
const evidenceStore = s3EvidenceStore(storeConfig, 900, fetch);
const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });

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
  usdcMint: base58.decode(MINT),
  eligibilityAuthority: ed25519.getPublicKey(ELIG_SEED),
};
let captured = "";
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
  evidenceStore,
  settlementChain: settlement,
  logger: { level: "info", stream: { write: (msg: string) => void (captured += msg) } },
});

const alarms: string[] = [];
const deps: SettlementDeps = {
  pool,
  clock,
  chain,
  settlement,
  programId: PROGRAM,
  alarm: (outcome, bountyId) => void alarms.push(JSON.stringify({ outcome, bountyId })),
};

before(async () => {
  psql("postgres", `CREATE DATABASE ${dbName}`);
  execFileSync("pnpm", ["exec", "node-pg-migrate", "--migrations-dir", "migrations", "up"],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: dbUrl } });
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
  psql("postgres", `DROP DATABASE IF EXISTS ${dbName}`);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  nowMs = AFTER_WINDOW.getTime();
  chainDown = false;
  alarms.length = 0;
  rpcCalls.length = 0;
  captured = "";
  loadRecorded();
});

// --- seeding: the recorded rows ---

async function token(id: string, wallet: string): Promise<string> {
  return new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(AFTER_WINDOW.getTime() - 3_600_000))
    .setExpirationTime(new Date(AFTER_WINDOW.getTime() + 86_400_000))
    .sign(config.jwtSecret);
}

async function seedUsers(): Promise<void> {
  await pool.query(`TRUNCATE settlements, decisions, attestations, evidence_items, submissions,
    capture_nonces, assignments, evidence_requirements, bounties, policies, users CASCADE`);
  for (const u of d649.users as Record<string, string>[]) {
    await pool.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2)",
      [u["id"], u["wallet_address"]]);
  }
}

async function seedBounty(rows: Record<string, any>, state: string): Promise<void> {
  const p = rows.policy as Record<string, string>;
  const b = rows.bounty as Record<string, string>;
  const a = rows.assignment as Record<string, string>;
  const policy = JSON.parse(p["canonical_json"]!);
  await pool.query(
    `INSERT INTO policies (id, requester_id, canonical_json, policy_hash, required_assurance,
       created_at, eligibility_profile_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p["id"], p["requester_id"], p["canonical_json"], hexOf(p["policy_hash"]!),
      policy.required_assurance, ts(p["created_at"]!), p["eligibility_profile_id"]],
  );
  for (const [i, r] of (policy.evidence_requirements as Record<string, unknown>[]).entries()) {
    await pool.query(
      `INSERT INTO evidence_requirements (id, policy_id, type, prompt, sequence, required)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r["id"], p["id"], r["type"], r["prompt"], i, r["required"]],
    );
  }
  await pool.query(
    `INSERT INTO bounties (id, requester_id, policy_id, title, category, capture_radius_m,
       reward_amount, state, program_account, created_at, location, location_public,
       idempotency_key, request_digest, acceptance_cutoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [b["id"], b["requester_id"], p["id"], b["title"], b["category"], b["capture_radius_m"],
      b["reward_amount"], state, b["program_account"], ts(b["created_at"]!), b["location"],
      b["location_public"], b["idempotency_key"], hexOf(b["request_digest"]!),
      ts(b["acceptance_cutoff"]!)],
  );
  await pool.query(
    `INSERT INTO assignments (id, bounty_id, scout_id, accepted_at, deadline, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)`,
    [a["id"], b["id"], a["scout_id"], ts(a["accepted_at"]!), ts(a["deadline"]!),
      ts(a["expires_at"]!)],
  );
}

/** d649d6f4 in `state`, with its recorded submission and SUBMITTED attestation. */
async function seed649(state = "SUBMITTED", attestation = "SUBMITTED"): Promise<void> {
  await seedRun(d649, state, attestation);
}

/** A recorded run's rows, the bounty in `state`; no decision or settlement row. */
async function seedRun(
  rows: Record<string, any>,
  state: string,
  attestation = "SUBMITTED",
): Promise<void> {
  await seedUsers();
  await seedBounty(rows, state);
  for (const n of rows.capture_nonces as Record<string, string>[]) {
    await pool.query(
      `INSERT INTO capture_nonces (id, assignment_id, bounty_id, scout_id, deployment_id, value,
         status, issued_at, expires_at, consumed_at, start_lat, start_lon, start_accuracy_m,
         start_fixed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [n["id"], n["assignment_id"], n["bounty_id"], n["scout_id"], Number(n["deployment_id"]),
        hexOf(n["value"]!), n["status"], ts(n["issued_at"]!), ts(n["expires_at"]!),
        n["consumed_at"] ? ts(n["consumed_at"]) : null, n["start_lat"], n["start_lon"],
        Number(n["start_accuracy_m"]), ts(n["start_fixed_at"]!)],
    );
  }
  const s = rows.submission as Record<string, string>;
  await pool.query(
    `INSERT INTO submissions (id, assignment_id, bounty_id, scout_id, capture_nonce_id, manifest,
       evidence_root, statement_signature, achieved_assurance, attester_signature, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [s["id"], s["assignment_id"], s["bounty_id"], s["scout_id"], s["capture_nonce_id"],
      s["manifest"], hexOf(s["evidence_root"]!), hexOf(s["statement_signature"]!),
      Number(s["achieved_assurance"]), hexOf(s["attester_signature"]!), ts(s["submitted_at"]!)],
  );
  for (const e of rows.evidence_items as Record<string, string>[]) {
    await pool.query(
      `INSERT INTO evidence_items (id, submission_id, requirement_id, storage_key, hash,
         c2pa_present, captured_at, byte_length, lat, lon, horizontal_accuracy_m, fixed_at)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11)`,
      [e["id"], e["submission_id"], e["requirement_id"], e["storage_key"], hexOf(e["hash"]!),
        ts(e["captured_at"]!), Number(e["byte_length"]), e["lat"], e["lon"],
        Number(e["horizontal_accuracy_m"]), ts(e["fixed_at"]!)],
    );
  }
  const t = rows.attestation as Record<string, string>;
  await pool.query(
    `INSERT INTO attestations (submission_id, status, achieved_assurance, message, signature,
       reason, tries, sends, next_attempt_at, tx_signature, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 1, $7, $8, $9, $9)`,
    [s["id"], attestation, Number(t["achieved_assurance"]), hexOf(t["message"]!),
      hexOf(t["signature"]!), attestation === "REFUSED" ? "EVIDENCE_MISSING" : null,
      ts(t["next_attempt_at"]!), t["tx_signature"], ts(t["created_at"]!)],
  );
}

async function seed3591(): Promise<void> {
  await seedUsers();
  await seedBounty(r3591, "ACCEPTED");
}

const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];
const stateOf = async (id: string) =>
  (await one("SELECT state FROM bounties WHERE id = $1", [id]))?.state as string;
const settlementOf = (id: string) => one("SELECT * FROM settlements WHERE bounty_id = $1", [id]);
const decisionsOf = async () => (await pool.query("SELECT * FROM decisions")).rows;
const assignmentStatus = async (id: string) =>
  (await one("SELECT status FROM assignments WHERE bounty_id = $1", [id]))?.status as string;
const reviewEnds = async () =>
  (await one("SELECT review_ends_at FROM submissions WHERE bounty_id = $1", [B649]))
    ?.review_ends_at as Date | null;
const REVIEW_END = new Date((1791114907 + 3600) * 1000);
const RELEASE_TIME = new Date(json(S + "d649d6f4_release_tx.json").result.blockTime * 1000);

const ids = () => ({
  requester: d649.bounty.requester_id as string,
  scout: d649.assignment.scout_id as string,
});

// --- tests ---

test("01 tail: recorded Accepted, Submitted, Paid and Refunded accounts; BAD_TAIL", () => {
  const read = (f: string) => {
    const r = readTail({ owner: PROGRAM, data: dataOf(f) });
    assert.ok(r.ok);
    return r.tail;
  };
  const acc = read("3591bf4c_accepted_account.json");
  assert.equal(base58.encode(acc.scout!), SCOUT_WALLET);
  assert.equal(acc.deadline, 1790823006n);
  assert.equal(acc.submittedAt, null);
  const sub = read("d649d6f4_submitted_account.json");
  assert.equal(sub.submittedAt, 1791114907n);
  assert.equal(Buffer.from(sub.evidenceRoot!).toString("hex"),
    hexOf(d649.submission.evidence_root).toString("hex"));
  assert.equal(sub.achievedAssurance, 1);
  assert.equal(sub.failedRequirementId, null);
  assert.deepEqual(read("d649d6f4_paid_account.json"), sub);
  const ref = read("3591bf4c_refunded_account.json");
  assert.deepEqual(ref, acc);
  const bad = dataOf("d649d6f4_submitted_account.json");
  bad[213] = 2;
  assert.deepEqual(readTail({ owner: PROGRAM, data: bad }), { ok: false, error: "BAD_TAIL" });
  const cut = dataOf("d649d6f4_submitted_account.json").slice(0, 240);
  assert.deepEqual(readTail({ owner: PROGRAM, data: cut }), { ok: false, error: "BAD_TAIL" });
});

function keysFor(account: string, file: string, mint = base58.decode(MINT)) {
  const data = dataOf(file);
  return settlementKeys(base58.decode(PROGRAM), CONFIG_ACCOUNT, base58.decode(account),
    data.slice(24, 56), mint);
}
const ataOf = (owner: Uint8Array, k: ReturnType<typeof keysFor>) =>
  associatedTokenAddress(owner, k.mint, k.tokenProgram, k.associatedTokenProgram);

test("02 release transaction: tx.ts reproduces the recorded message", () => {
  const k = keysFor(A649, "d649d6f4_submitted_account.json");
  const scout = base58.decode(SCOUT_WALLET);
  const msg = releaseMessage(k, base58.decode(RELAYER_LIVE), scout, ataOf(scout, k),
    base58.decode(recorded.blockhashes.d649d6f4));
  assert.equal(Buffer.from(msg).toString("hex"), recorded.messages.d649d6f4);
  // The landed transaction, as the RPC returned it: one signature, then the same message.
  assert.equal(Buffer.from(landedMessage("d649d6f4_release_tx_base64.json")).toString("hex"),
    Buffer.from(msg).toString("hex"));
});

function landedMessage(file: string): Uint8Array {
  const wire = Buffer.from(json(S + file).result.transaction[0], "base64");
  assert.equal(wire[0], 1);
  return Uint8Array.from(wire.subarray(65));
}

/** Decode a legacy message into web3.js's instruction form, for comparison. */
function decodeMessage(msg: Uint8Array) {
  const [nSig, nRoSig, nRo] = [msg[0]!, msg[1]!, msg[2]!];
  let at = 3;
  const n = msg[at++]!;
  const keys = Array.from({ length: n }, (_, i) => base58.encode(msg.slice(at + 32 * i, at + 32 * i + 32)));
  at += 32 * n + 32;
  const writable = (i: number) =>
    i < nSig ? i < nSig - nRoSig : i < n - nRo;
  const count = msg[at++]!;
  const out = [];
  for (let c = 0; c < count; c++) {
    const program = keys[msg[at++]!]!;
    const m = msg[at++]!;
    const idx = Array.from(msg.slice(at, at + m));
    at += m;
    const len = msg[at++]!;
    const data = Buffer.from(msg.slice(at, at + len)).toString("hex");
    at += len;
    out.push({ program, keys: idx.map((i) => ({ pubkey: keys[i]!, signer: i < nSig,
      writable: writable(i) })), data_hex: data });
  }
  return out;
}

test("03 expire and resolve: recorded messages and the web3.js vectors", () => {
  const k = keysFor(A3591, "3591bf4c_accepted_account.json");
  const msg = expireMessage(k, base58.decode(RELAYER_LIVE), ataOf(k.requester, k),
    base58.decode(recorded.blockhashes["3591bf4c"]));
  assert.equal(Buffer.from(msg).toString("hex"), recorded.messages["3591bf4c"]);
  assert.equal(Buffer.from(landedMessage("3591bf4c_expire_tx_base64.json")).toString("hex"),
    recorded.messages["3591bf4c"]);
  const kr = keysFor(A649, "d649d6f4_submitted_account.json");
  for (const c of resolveVector.cases as { outcome: 0 | 1; destination_owner: string;
    instructions: unknown }[]) {
    const owner = base58.decode(c.destination_owner);
    const m = resolveMessage(kr, ed25519.getPublicKey(RELAYER_SEED),
      ed25519.getPublicKey(ARBITER_SEED), c.outcome, owner, ataOf(owner, kr),
      base58.decode(resolveVector.blockhash));
    assert.deepEqual(decodeMessage(m), c.instructions, `outcome ${c.outcome}`);
  }
  // Run B's landed resolve, signed by the live relayer and arbiter: tx.ts rebuilds its
  // message byte for byte from the account and the blockhash it carries.
  const landed = Buffer.from(json(S + "70af9c0f_resolve_tx_base64.json").result.transaction[0],
    "base64");
  assert.equal(landed[0], 2);
  const message = Uint8Array.from(landed.subarray(1 + 64 * 2));
  const nKeys = message[3]!;
  const blockhash = message.slice(4 + 32 * nKeys, 4 + 32 * nKeys + 32);
  const kb = settlementKeys(base58.decode(PROGRAM), CONFIG_ACCOUNT, base58.decode(AB),
    dataOf("70af9c0f_paid_account.json").slice(24, 56), base58.decode(MINT));
  const scout = base58.decode(SCOUT_WALLET);
  const rebuilt = resolveMessage(kb, base58.decode(RELAYER_LIVE), base58.decode(ARBITER_LIVE), 0,
    scout, ataOf(scout, kb), blockhash);
  assert.equal(Buffer.from(rebuilt).toString("hex"), Buffer.from(message).toString("hex"));
});

test("04 released: the recorded Paid account and release transaction", async () => {
  await seed649();
  const r = await projectSettlement(deps, B649);
  assert.equal(r.outcome, "PROJECTED");
  assert.equal(await stateOf(B649), "PAID");
  assert.equal(await assignmentStatus(B649), "COMPLETED");
  const s = await settlementOf(B649);
  assert.equal(s.kind, "RELEASED");
  assert.equal(s.tx_signature, RELEASE_SIG);
  assert.equal(s.settled_at.getTime(), RELEASE_TIME.getTime());
  assert.equal((await reviewEnds())?.getTime(), REVIEW_END.getTime());
  assert.equal((await decisionsOf()).length, 0);
});

test("05 approved: Run A's recorded approve", async () => {
  await seedRun(runA, "SUBMITTED");
  assert.equal((await projectSettlement(deps, BA)).outcome, "PROJECTED");
  assert.equal(await stateOf(BA), "PAID");
  assert.equal(await assignmentStatus(BA), "COMPLETED");
  const st = await settlementOf(BA);
  assert.equal(st.kind, "APPROVED");
  assert.equal(st.tx_signature, APPROVE_SIG);
  assert.equal(st.tx_signature, runA.settlements[0].tx_signature);
  assert.equal(st.settled_at.getTime(), ts(runA.settlements[0].settled_at).getTime());
  const [d] = await decisionsOf();
  assert.equal(d.outcome, "APPROVE");
  assert.equal(d.decided_by, runA.decisions[0].decided_by);
  assert.equal(d.tx_signature, APPROVE_SIG);
  assert.equal(d.failed_requirement_id, null);
});

const rejectTx = (id: string) =>
  harnessTx(cat(REJECT_DISCRIMINATOR, uuidBytes(id)), (a) => [a[0]!, a[2]!]);

test("06 disputed: Run B's recorded reject, the account's Disputed byte set (harness)", async () => {
  await seedRun(runB, "SUBMITTED");
  accounts.set(AB, runBAccount(3));
  assert.equal((await projectSettlement(deps, BB)).outcome, "PROJECTED");
  assert.equal(await stateOf(BB), "DISPUTED");
  assert.equal(await assignmentStatus(BB), "ACTIVE");
  const [d] = await decisionsOf();
  const recorded = runB.decisions[0] as Record<string, string>;
  assert.equal(d.outcome, "REJECT");
  assert.equal(d.failed_requirement_id, recorded["failed_requirement_id"]);
  assert.equal(d.tx_signature, REJECT_SIG);
  assert.equal(d.tx_signature, recorded["tx_signature"]);
  assert.equal(d.reason, null);
  assert.equal(await settlementOf(BB), undefined);
});

test("07 foreign requirement: DISPUTED, no decision, one alarm", async () => {
  await seed649();
  const foreign = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  accounts.set(A649, harnessAccount(3, foreign));
  transactions.set(RELEASE_SIG, rejectTx(foreign));
  assert.equal((await projectSettlement(deps, B649)).outcome, "FOREIGN_REQUIREMENT");
  assert.equal(await stateOf(B649), "DISPUTED");
  assert.equal((await decisionsOf()).length, 0);
  assert.deepEqual(alarms, [JSON.stringify({ outcome: "FOREIGN_REQUIREMENT", bountyId: B649 })]);
});

const resolveTx = (outcome: number) =>
  harnessTx(cat(RESOLVE_DISCRIMINATOR, Uint8Array.from([outcome])),
    (a) => [a[5]!, a[1]!, a[0]!, a[2]!, a[3]!, a[4]!, a[6]!, a[7]!]);

test("08 resolved: Run B's recorded resolve; a refund and a disagreeing byte (harness)", async () => {
  await seedRun(runB, "DISPUTED");
  assert.equal((await projectSettlement(deps, BB)).outcome, "PROJECTED");
  assert.equal(await stateOf(BB), "PAID");
  const paid = await settlementOf(BB);
  assert.equal(paid.kind, "RESOLVED_PAID");
  assert.equal(paid.tx_signature, RESOLVE_SIG);
  assert.equal(paid.tx_signature, runB.settlements[0].tx_signature);
  assert.equal(await assignmentStatus(BB), "COMPLETED");
  await seedRun(runB, "DISPUTED");
  accounts.set(AB, runBAccount(5));
  transactions.set(RESOLVE_SIG, runBResolve(1));
  assert.equal((await projectSettlement(deps, BB)).outcome, "PROJECTED");
  assert.equal(await stateOf(BB), "REFUNDED");
  assert.equal((await settlementOf(BB)).kind, "RESOLVED_REFUNDED");
  await seedRun(runB, "DISPUTED");
  accounts.set(AB, dataOf("70af9c0f_paid_account.json"));
  transactions.set(RESOLVE_SIG, runBResolve(1));
  assert.equal((await projectSettlement(deps, BB)).outcome, "BINDING_MISMATCH");
  assert.equal(await stateOf(BB), "DISPUTED");
});

test("09 expired: the recorded Refunded account and expire transaction of 3591bf4c", async () => {
  await seed3591();
  assert.equal((await projectSettlement(deps, B3591)).outcome, "PROJECTED");
  assert.equal(await stateOf(B3591), "REFUNDED");
  assert.equal(await assignmentStatus(B3591), "EXPIRED");
  const s = await settlementOf(B3591);
  assert.equal(s.kind, "EXPIRED_REFUNDED");
  assert.equal(s.tx_signature, EXPIRE_SIG);
});

test("10 not settled: Submitted sets review_ends_at only; Accepted writes nothing", async () => {
  await seed649();
  accounts.set(A649, dataOf("d649d6f4_submitted_account.json"));
  const r = await projectSettlement(deps, B649);
  assert.equal(r.outcome, "NOT_SETTLED");
  assert.equal(r.chainState, "Submitted");
  assert.equal((await reviewEnds())?.getTime(), REVIEW_END.getTime());
  assert.equal(await stateOf(B649), "SUBMITTED");
  assert.equal(await settlementOf(B649), undefined);
  await seed3591();
  accounts.set(A3591, dataOf("3591bf4c_accepted_account.json"));
  assert.equal((await projectSettlement(deps, B3591)).outcome, "NOT_SETTLED");
  assert.equal(await stateOf(B3591), "ACCEPTED");
  assert.equal(await assignmentStatus(B3591), "ACTIVE");
});

test("11 idempotent: a second call writes nothing; a settled row reads nothing", async () => {
  await seed649();
  await projectSettlement(deps, B649);
  const first = await settlementOf(B649);
  nowMs += 60_000;
  rpcCalls.length = 0;
  assert.equal((await projectSettlement(deps, B649)).outcome, "PROJECTED");
  assert.deepEqual(await settlementOf(B649), first);
  assert.deepEqual(rpcCalls, []);
});

test("12 lookup: skips errored and other transactions; no match and a throw", async () => {
  await seed649();
  const list = json(S + "d649d6f4_signatures.json").result as Record<string, unknown>[];
  const errored = { ...clone(list[0]!), signature: "erroredSig1111111111111111111111", err: { x: 1 } };
  // The recorded expire of 3591bf4c: an escrow transaction of another kind, another account.
  const other = { ...clone(json(S + "3591bf4c_signatures.json").result[0]) };
  signatureLists.set(A649, [errored, other, ...list]);
  // The errored entry names a settling transaction: only its error excludes it.
  transactions.set(errored["signature"] as string, json(S + "d649d6f4_release_tx.json").result);
  assert.equal((await projectSettlement(deps, B649)).outcome, "PROJECTED");
  assert.equal((await settlementOf(B649)).tx_signature, RELEASE_SIG);
  await seed649();
  signatureLists.set(A649, [other]);
  assert.equal((await projectSettlement(deps, B649)).outcome, "CHAIN_UNAVAILABLE");
  assert.equal(await stateOf(B649), "SUBMITTED");
  await seed649();
  const ataOnly = harnessTx(Uint8Array.from([1]), (a) => a);
  const k = (ataOnly as any).transaction.message.accountKeys as string[];
  (ataOnly as any).transaction.message.instructions =
    (ataOnly as any).transaction.message.instructions.filter(
      (i: { programIdIndex: number }) => k[i.programIdIndex] !== PROGRAM);
  transactions.set(RELEASE_SIG, ataOnly);
  signatureLists.set(A649, list);
  assert.equal((await projectSettlement(deps, B649)).outcome, "CHAIN_UNAVAILABLE");
  chainDown = true;
  assert.equal((await projectSettlement(deps, B649)).outcome, "CHAIN_UNAVAILABLE");
  assert.equal(await settlementOf(B649), undefined);
});

test("13 alarms: no account, another bounty_id, another Scout, Funded under ACCEPTED", async () => {
  const expectAlarm = async (id: string, outcome: string) => {
    alarms.length = 0;
    assert.equal((await projectSettlement(deps, id)).outcome, outcome);
    assert.deepEqual(alarms, [JSON.stringify({ outcome, bountyId: id })]);
  };
  await seed649();
  accounts.set(A649, null);
  await expectAlarm(B649, "BINDING_MISMATCH");
  await seed649();
  const other = dataOf("d649d6f4_paid_account.json");
  other[8] ^= 0xff;
  accounts.set(A649, other);
  await expectAlarm(B649, "BINDING_MISMATCH");
  await seed649();
  const scout = dataOf("d649d6f4_paid_account.json");
  scout[172] ^= 0xff;
  accounts.set(A649, scout);
  await expectAlarm(B649, "PARTY_MISMATCH");
  await seed3591();
  const funded = dataOf("3591bf4c_accepted_account.json");
  funded[169] = 0;
  accounts.set(A3591, funded);
  await expectAlarm(B3591, "UNPROJECTED_STATE");
  assert.equal(await stateOf(B3591), "ACCEPTED");
});

async function call(method: "POST" | "GET", path: string, tok: string, payload?: unknown) {
  return app.inject({ method, url: path, headers: { authorization: `Bearer ${tok}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

test("14 settlement route: requester, Scout, stranger, DRAFT, body, chain down", async () => {
  await seed649();
  const { requester, scout } = ids();
  const res = await call("POST", `/bounties/${B649}/settlement`, await token(requester, REQUESTER_WALLET));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, "PAID");
  assert.equal(res.json().settlement.kind, "RELEASED");
  assert.equal("assignment" in res.json(), false);
  const s = await call("POST", `/bounties/${B649}/settlement`, await token(scout, SCOUT_WALLET));
  assert.equal(s.statusCode, 200);
  assert.equal(s.json().assignment.id, d649.assignment.id);
  const strangerId = (await one(
    "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
    [base58.encode(randomBytes(32))])).id;
  const stranger = await token(strangerId, "x");
  assert.equal((await call("POST", `/bounties/${B649}/settlement`, stranger)).statusCode, 403);
  await pool.query("UPDATE bounties SET state = 'DRAFT' WHERE id = $1", [B649]);
  assert.equal((await call("POST", `/bounties/${B649}/settlement`, stranger)).statusCode, 404);
  await seed649();
  const rt = await token(requester, REQUESTER_WALLET);
  assert.equal((await call("POST", `/bounties/${B649}/settlement`, rt, { a: 1 })).statusCode, 400);
  chainDown = true;
  const down = await call("POST", `/bounties/${B649}/settlement`, rt);
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().error, "CHAIN_UNAVAILABLE");
});

test("15 evidence route: owner URLs in policy order; others refused; nothing logged", async () => {
  await seed649();
  const { requester, scout } = ids();
  const rt = await token(requester, REQUESTER_WALLET);
  const res = await call("GET", `/bounties/${B649}/evidence`, rt);
  assert.equal(res.statusCode, 200, res.body);
  const ev = res.json().evidence;
  assert.deepEqual(Object.keys(res.json()), ["evidence"]);
  assert.equal(ev.expires_at, new Date(nowMs + 300_000).toISOString());
  assert.deepEqual(ev.items.map((i: { requirement_id: string }) => i.requirement_id), REQ_IDS);
  for (const it of ev.items) {
    assert.deepEqual(Object.keys(it).sort(), ["captured_at", "requirement_id", "url"]);
    const row = (d649.evidence_items as Record<string, string>[])
      .find((e) => e["requirement_id"] === it.requirement_id)!;
    assert.equal(it.url, evidenceStore.presignGet(row["storage_key"]!, 300, new Date(nowMs)));
    assert.match(it.url, /X-Amz-Expires=300&X-Amz-SignedHeaders=host&/);
  }
  const st = await call("GET", `/bounties/${B649}/evidence`, await token(scout, SCOUT_WALLET));
  assert.equal(st.statusCode, 403);
  await pool.query("UPDATE bounties SET state = 'ACCEPTED' WHERE id = $1", [B649]);
  assert.equal((await call("GET", `/bounties/${B649}/evidence`, rt)).json().error, "NO_EVIDENCE");
  await seed649("SUBMITTED", "REFUSED");
  const refused = await call("GET", `/bounties/${B649}/evidence`, rt);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "NO_EVIDENCE");
  assert.equal(captured.includes("X-Amz"), false);
  assert.equal(captured.includes("evidence/"), false);
});

test("16 presignGet: the query presign of section 18.4 over the item's path (A3)", () => {
  const key = (d649.evidence_items as Record<string, string>[])[0]!["storage_key"]!;
  const now = new Date("2026-10-05T01:00:00Z");
  const path = objectPath(storeConfig.bucket, key);
  assert.equal(evidenceStore.presignGet(key, 300, now),
    storeConfig.endpoint + path + "?" + presignQuery({ method: "GET", host: storeConfig.host,
      path, headers: {}, expiresS: 300, now, key: signingKey(storeConfig) }));
});

test("17 views: settled keys; the Scout's view served; missions list settled", async () => {
  const OWNER_KEYS = ["category", "created_at", "dispute", "id", "policy", "policy_hash",
    "program_account", "settlement", "state", "submission", "title"];
  const { requester, scout } = ids();
  for (const [state, account, tx] of [
    ["DISPUTED", harnessAccount(3, REQ_IDS[0]!), rejectTx(REQ_IDS[0]!)],
    ["PAID", null, null],
    ["REFUNDED", harnessAccount(5, REQ_IDS[0]!), resolveTx(1)],
  ] as const) {
    loadRecorded();
    await seed649(state === "REFUNDED" ? "DISPUTED" : "SUBMITTED");
    if (account !== null) accounts.set(A649, account);
    if (tx !== null) transactions.set(RELEASE_SIG, tx);
    await projectSettlement(deps, B649);
    const owner = (await call("GET", `/bounties/${B649}`, await token(requester, REQUESTER_WALLET))).json();
    assert.equal(owner.state, state);
    assert.deepEqual(Object.keys(owner).sort(), OWNER_KEYS);
    assert.deepEqual(Object.keys(owner.submission).sort(),
      ["item_count", "review_ends_at", "submitted_at", "verification"]);
    const sv = (await call("GET", `/bounties/${B649}`, await token(scout, SCOUT_WALLET))).json();
    assert.equal(sv.assignment.id, d649.assignment.id);
    assert.ok("dispute" in sv && "settlement" in sv);
    if (state === "DISPUTED") assert.deepEqual(owner.dispute, { failed_requirement_id: REQ_IDS[0] });
    else assert.deepEqual(Object.keys(owner.settlement).sort(),
      ["amount", "kind", "settled_at", "tx_signature"]);
  }
  loadRecorded();
  await seed649();
  await projectSettlement(deps, B649);
  const st = await token(scout, SCOUT_WALLET);
  const m = (await call("GET", "/me/missions", st)).json().missions;
  assert.deepEqual(m.map((x: { id: string; state: string }) => [x.id, x.state]), [[B649, "PAID"]]);
  await seed3591();
  await projectSettlement(deps, B3591);
  const m2 = (await call("GET", "/me/missions", st)).json().missions;
  assert.deepEqual(m2.map((x: { id: string; state: string }) => [x.id, x.state]),
    [[B3591, "REFUNDED"]]);
});

// --- section 20.6: the release pass ---

const sent: Uint8Array[] = [];
let sendMode: "LAND" | "FAIL_PAID" | "FAIL" = "LAND";
const BLOCKHASH = base58.decode(recorded.blockhashes.d649d6f4);
const writer: ChainWriter = {
  async getLatestBlockhash() {
    return BLOCKHASH;
  },
  async sendTransaction(wire) {
    sent.push(Uint8Array.from(wire));
    if (sendMode === "FAIL") throw new Error("RPC_ERROR");
    accounts.set(A649, dataOf("d649d6f4_paid_account.json"));
    if (sendMode === "FAIL_PAID") throw new Error("RPC_ERROR");
    return base58.encode(wire.slice(1, 65));
  },
  async getSignatureStatuses(signatures) {
    return signatures.map(() => ({ confirmationStatus: "confirmed", failed: false }));
  },
};
const lines: string[] = [];
const releaseDeps = (): ReleaseDeps => ({
  pool, clock, chain, writer, settlement,
  programId: PROGRAM,
  programIdBytes: base58.decode(PROGRAM),
  configAccount: CONFIG_ACCOUNT,
  usdcMint: base58.decode(MINT),
  relayerSeed: RELAYER_SEED,
  releaseMarginS: 10,
  confirmS: 60,
  sleep: async (ms) => {
    nowMs += ms;
  },
  log: (level, fields) => void lines.push(JSON.stringify({ level, ...fields })),
  retries: new Map(),
});

test("18 release pass: margin, one send, preflight failure, retry, disputed", async () => {
  const submitted = () => accounts.set(A649, dataOf("d649d6f4_submitted_account.json"));
  // Inside the margin: nothing is sent.
  await seed649();
  submitted();
  sent.length = 0;
  sendMode = "LAND";
  nowMs = REVIEW_END.getTime() + 5_000;
  let d = releaseDeps();
  await settlementPass(d);
  assert.equal(sent.length, 0);
  assert.equal(await stateOf(B649), "SUBMITTED");
  // Past it: one send of tx.ts's bytes, then PAID by the recorded release.
  nowMs = REVIEW_END.getTime() + 11_000;
  await settlementPass(d);
  assert.equal(sent.length, 1);
  const k = keysFor(A649, "d649d6f4_submitted_account.json");
  const scout = base58.decode(SCOUT_WALLET);
  const msg = releaseMessage(k, ed25519.getPublicKey(RELAYER_SEED), scout, ataOf(scout, k), BLOCKHASH);
  assert.equal(Buffer.from(sent[0]!.slice(65)).toString("hex"), Buffer.from(msg).toString("hex"));
  assert.equal(await stateOf(B649), "PAID");
  assert.equal((await settlementOf(B649)).kind, "RELEASED");
  // A failed send whose transaction landed anyway: projected, not resent.
  await seed649();
  submitted();
  sent.length = 0;
  sendMode = "FAIL_PAID";
  d = releaseDeps();
  await settlementPass(d);
  await settlementPass(d);
  assert.equal(sent.length, 1);
  assert.equal(await stateOf(B649), "PAID");
  // A failed send with the account still Submitted: the next waits 5 s.
  await seed649();
  submitted();
  sent.length = 0;
  sendMode = "FAIL";
  d = releaseDeps();
  await settlementPass(d);
  await settlementPass(d);
  assert.equal(sent.length, 1);
  nowMs += 5_001;
  await settlementPass(d);
  assert.equal(sent.length, 2);
  assert.equal(await stateOf(B649), "SUBMITTED");
  // DISPUTED: projected, never sent.
  await seed649("DISPUTED");
  accounts.set(A649, harnessAccount(3, REQ_IDS[0]!));
  sent.length = 0;
  sendMode = "LAND";
  await settlementPass(releaseDeps());
  assert.equal(sent.length, 0);
  assert.equal(await stateOf(B649), "DISPUTED");
});
