import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { SignJWT } from "jose";
import { eligibilityProfileHash } from "@hackathon/shared";
import { buildApp } from "../src/app.ts";
import { ELIGIBILITY_PROFILES } from "../src/bounties/policy.ts";
import { BOUNTY_DISCRIMINATOR, BOUNTY_MAX_LENGTH } from "../src/chain/bounty.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import type { Deployment } from "../src/chain/deployment.ts";
import { ChainError } from "../src/chain/rpc.ts";
import type { AccountInfo, ChainReader, FetchLike } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import type { SeekerCheck } from "../src/eligibility/deps.ts";
import { heliusSeekerCheck, SEEKER_CACHE_MS } from "../src/eligibility/seeker.ts";
import type { Randomness } from "../src/randomness.ts";

// ELIGIBILITY.md section 9. Expected count: 24. The controlled clock reaches
// every window boundary; nothing sleeps. The chain and the deployment are
// doubles. The Seeker check is a double in tests 5 and 16 to 19, and the real
// check over recorded mainnet responses in 20 and 21. The signer is the real
// one over the published test seed (MESSAGES.md section 8).

// --- scratch database, the bounties.test.ts pattern ---

const dbName = `bountycam_eligibility_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

// --- controlled clock ---

const BASE = new Date("2026-09-21T00:00:00.000Z");
const BASE_SECONDS = BigInt(BASE.getTime() / 1000);
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

// --- configuration through the production parser ---

const ZERO32 = "11111111111111111111111111111111";
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";

const secretDir = mkdtempSync(join(tmpdir(), "bountycam-eligibility-test-"));
const secretPath = join(secretDir, "jwt-secret.hex");
writeFileSync(secretPath, Buffer.from(randomBytes(32)).toString("hex"));
const config = loadConfig({ JWT_SECRET_PATH: secretPath, SETTLEMENT_MINT: ZERO32 });

// --- the published test key: seed and public key from packages/shared ---

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
  configAccount: ZERO32,
  keySeed: SEED,
  keyPubkey: PUBKEY,
};
const deployment: Deployment = {
  deploymentId: 2,
  usdcMint: new Uint8Array(32),
  eligibilityAuthority: PUBKEY,
};
const signer = eligibilitySigner(SEED);

// --- doubles: chain reader and Seeker check ---

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

let seekerBehaviour: () => Promise<string | null> = async () => null;
const seeker: SeekerCheck = { findSeekerMint: () => seekerBehaviour() };

const randomness: Randomness = {
  randomBytes: (length) => Uint8Array.from(randomBytes(length)),
  randomUUID: () => randomUUID(),
};

// --- app under test ---

const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const app = buildApp({
  config,
  pool,
  clock,
  randomness,
  eligibility: { config: eligibilityConfig, deployment, chain, signer, seeker },
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
  chainDown = false;
  chainLog.length = 0;
  seekerBehaviour = async () => null;
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

async function seedUser(): Promise<User> {
  const wallet = base58.encode(randomBytes(32));
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
    [wallet],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("users insert returned no row");
  return { id: row.id, wallet, token: await signToken(row.id, wallet) };
}

type ProfileId = "BASE_V1" | "A4_SEEKER_V1";

function createBody(profile: ProfileId): Record<string, unknown> {
  return {
    title: "Photograph the storefront",
    category: "verification",
    idempotency_key: randomUUID(),
    policy: {
      acceptance_window_seconds: 86400,
      capture_radius_m: 50,
      challenge_window_seconds: 3600,
      cluster: "devnet",
      completion_window_seconds: 7200,
      eligibility_profile_id: profile,
      evidence_requirements: [
        { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
      ],
      lat: "40.4405556",
      lon: "-79.9961111",
      required_assurance: profile === "A4_SEEKER_V1" ? 4 : 3,
      reward_amount: "5000000",
      settlement_mint: ZERO32,
    },
  };
}

function profileHash(profile: ProfileId): Uint8Array {
  const entry = ELIGIBILITY_PROFILES.get(profile);
  if (entry === undefined) throw new Error("profile not in registry: " + profile);
  return eligibilityProfileHash(entry);
}

interface SeedOptions {
  profile?: ProfileId;
  cutoff?: bigint;
  state?: number;
  chainPolicyHash?: Uint8Array;
  chainProfileHash?: Uint8Array;
  chainAssurance?: number;
}

interface Seeded {
  id: string;
  requester: User;
  address: string;
  bountyId: Uint8Array;
  policyHash: Uint8Array;
  profileHash: Uint8Array;
  requiredAssurance: number;
  cutoff: bigint;
}

// A funded bounty as the marketplace would hold it: created through the API,
// projected to AVAILABLE with a program_account by SQL (POLICY.md 12), and a
// Funded account for that address in the chain double built from the same
// policy row — unless an option deliberately makes the chain disagree.
async function seedFunded(opts: SeedOptions = {}): Promise<Seeded> {
  const profile = opts.profile ?? "BASE_V1";
  const requester = await seedUser();
  const created = await app.inject({
    method: "POST",
    url: "/bounties",
    headers: { authorization: `Bearer ${requester.token}` },
    payload: createBody(profile),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id: string = created.json().id;
  const policyRow = await pool.query<{ policy_hash: Buffer; required_assurance: number }>(
    `SELECT p.policy_hash, p.required_assurance
     FROM bounties b JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
    [id],
  );
  const policy = policyRow.rows[0];
  if (policy === undefined) throw new Error("seeded bounty has no policy row");
  const address = base58.encode(randomBytes(32));
  await pool.query(
    "UPDATE bounties SET state = 'AVAILABLE', program_account = $2 WHERE id = $1",
    [id, address],
  );

  const bountyId = Uint8Array.from(randomBytes(16));
  const policyHash = opts.chainPolicyHash ?? Uint8Array.from(policy.policy_hash);
  const chainProfile = opts.chainProfileHash ?? profileHash(profile);
  const requiredAssurance = opts.chainAssurance ?? policy.required_assurance;
  const cutoff = opts.cutoff ?? BASE_SECONDS + 86400n;

  const d = new Uint8Array(BOUNTY_MAX_LENGTH);
  const v = new DataView(d.buffer);
  d.set(BOUNTY_DISCRIMINATOR, 0);
  d.set(bountyId, 8);
  d.set(base58.decode(requester.wallet), 24);
  v.setBigUint64(56, 5_000_000n, true);
  v.setBigUint64(64, 0n, true);
  d.set(policyHash, 72);
  d.set(chainProfile, 104);
  v.setUint8(136, requiredAssurance);
  v.setBigInt64(137, 86400n, true);
  v.setBigInt64(145, 7200n, true);
  v.setBigInt64(153, 3600n, true);
  v.setBigInt64(161, cutoff, true);
  v.setUint8(169, opts.state ?? 0);
  v.setUint8(170, 255);
  chainAccounts.set(address, { owner: PROGRAM, data: d });

  return {
    id,
    requester,
    address,
    bountyId,
    policyHash,
    profileHash: chainProfile,
    requiredAssurance,
    cutoff,
  };
}

async function voucher(token: string | null, id: string, payload?: unknown) {
  return app.inject({
    method: "POST",
    url: `/bounties/${id}/voucher`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

interface VoucherBody {
  message: string;
  signature: string;
  expires_at: number;
  authority: string;
}

interface ActiveRow {
  scout_id: string;
  expires_at: Date;
}

async function activeRows(bountyId: string): Promise<ActiveRow[]> {
  const result = await pool.query<ActiveRow>(
    `SELECT scout_id, expires_at FROM assignments
     WHERE bounty_id = $1 AND status = 'ACTIVE'`,
    [bountyId],
  );
  return result.rows;
}

// --- issuance ---

test("01 BASE_V1 success: 212 bytes, every field from the chain, signature verifies", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
  const body: VoucherBody = res.json();
  const message = Uint8Array.from(Buffer.from(body.message, "base64"));
  const signature = Uint8Array.from(Buffer.from(body.signature, "base64"));
  assert.equal(message.length, 212);
  assert.equal(signature.length, 64);
  const dv = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const tag = Buffer.from(message.subarray(0, 24)).toString("ascii");
  assert.equal(tag, "BOUNTYCAM_ELIGIBILITY_V1");
  assert.equal(dv.getUint16(24, true), 1);
  assert.equal(dv.getUint8(26), 2);
  assert.deepEqual(message.subarray(27, 59), base58.decode(PROGRAM));
  assert.deepEqual(message.subarray(59, 75), seeded.bountyId);
  assert.deepEqual(message.subarray(75, 107), base58.decode(seeded.requester.wallet));
  assert.deepEqual(message.subarray(107, 139), base58.decode(scout.wallet));
  assert.deepEqual(message.subarray(139, 171), seeded.policyHash);
  assert.deepEqual(message.subarray(171, 203), seeded.profileHash);
  assert.equal(dv.getUint8(203), seeded.requiredAssurance);
  assert.equal(dv.getBigInt64(204, true), BigInt(body.expires_at));
  assert.ok(ed25519.verify(signature, message, PUBKEY));
  assert.equal(body.authority, base58.encode(PUBKEY));
});

test("02 expires_at is the clock plus 300 when the cutoff is later", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().expires_at, Number(BASE_SECONDS + 300n));
});

test("03 expires_at is acceptance_cutoff when the cutoff is sooner", async () => {
  const seeded = await seedFunded({ cutoff: BASE_SECONDS + 100n });
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().expires_at, Number(BASE_SECONDS + 100n));
});

test("04 the reservation's expires_at equals the voucher's", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
  const rows = await activeRows(seeded.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.scout_id, scout.id);
  assert.equal(rows[0]!.expires_at.getTime() / 1000, res.json().expires_at);
  // D115: a reservation carries no accepted_at. Without this assertion the
  // migration 1 default would set it silently and only test 24 would notice.
  const acceptedAt = await pool.query<{ accepted_at: Date | null }>(
    "SELECT accepted_at FROM assignments WHERE bounty_id = $1",
    [seeded.id],
  );
  assert.equal(acceptedAt.rows[0]?.accepted_at, null);
});

test("05 A4_SEEKER_V1 success with the Seeker double returning a mint", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();
  const mint = base58.encode(randomBytes(32));
  seekerBehaviour = async () => mint;
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
  const claim = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM seeker_devices WHERE sgt_mint = $1",
    [mint],
  );
  assert.equal(claim.rows[0]?.user_id, scout.id);
});

test("06 no body required: an arbitrary JSON body still succeeds", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id, { anything: [1, 2, 3] });
  assert.equal(res.statusCode, 200, res.body);
});

// --- check order, one per code ---

test("07 no token is 401 TOKEN_MISSING", async () => {
  const seeded = await seedFunded();
  const res = await voucher(null, seeded.id);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "TOKEN_MISSING" });
});

test("08 unknown and malformed ids are NOT_FOUND", async () => {
  const scout = await seedUser();
  const absent = await voucher(scout.token, randomUUID());
  assert.equal(absent.statusCode, 404);
  assert.deepEqual(absent.json(), { error: "NOT_FOUND" });
  const malformed = await voucher(scout.token, "not-a-uuid");
  assert.equal(malformed.statusCode, 404);
  assert.deepEqual(malformed.json(), absent.json());
});

test("09 the requester on their own bounty: SCOUT_IS_REQUESTER, no chain read", async () => {
  const seeded = await seedFunded();
  const res = await voucher(seeded.requester.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "SCOUT_IS_REQUESTER" });
  assert.deepEqual(chainLog, []);
});

test("10 a SUSPENDED users row is ACCOUNT_NOT_ACTIVE", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [scout.id]);
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "ACCOUNT_NOT_ACTIVE" });
});

test("11 a failed chain read is CHAIN_UNAVAILABLE", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  chainDown = true;
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "CHAIN_UNAVAILABLE" });
});

test("12 on-chain state Accepted is BOUNTY_NOT_ACCEPTABLE", async () => {
  const seeded = await seedFunded({ state: 1 });
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "BOUNTY_NOT_ACCEPTABLE" });
});

test("13 clock past acceptance_cutoff is ACCEPTANCE_WINDOW_CLOSED", async () => {
  const seeded = await seedFunded({ cutoff: BASE_SECONDS - 1n });
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "ACCEPTANCE_WINDOW_CLOSED" });
});

test("14 a chain profile hash naming a different registry id: BINDING_MISMATCH", async () => {
  const seeded = await seedFunded({ chainProfileHash: profileHash("A4_SEEKER_V1") });
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "BINDING_MISMATCH" });
});

test("15 a chain profile hash matching no registry entry: PROFILE_UNKNOWN", async () => {
  const seeded = await seedFunded({ chainProfileHash: Uint8Array.from(randomBytes(32)) });
  const scout = await seedUser();
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: "PROFILE_UNKNOWN" });
});

// --- Seeker, through the double ---

test("16 check completes with no qualifying mint: SEEKER_NOT_HELD", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();
  seekerBehaviour = async () => null;
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "SEEKER_NOT_HELD" });
});

test("17 check throws: SEEKER_CHECK_UNAVAILABLE and no reservation written", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();
  seekerBehaviour = async () => {
    throw new Error("double: provider down");
  };
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "SEEKER_CHECK_UNAVAILABLE" });
  assert.equal((await activeRows(seeded.id)).length, 0);
});

test("18 a mint claimed by another user: SEEKER_ALREADY_CLAIMED, nothing written", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const other = await seedUser();
  const scout = await seedUser();
  const mint = base58.encode(randomBytes(32));
  await pool.query(
    "INSERT INTO seeker_devices (sgt_mint, user_id, claimed_at) VALUES ($1, $2, $3)",
    [mint, other.id, BASE],
  );
  seekerBehaviour = async () => mint;
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "SEEKER_ALREADY_CLAIMED" });
  assert.equal((await activeRows(seeded.id)).length, 0);
});

test("19 a mint already claimed by this same user: success", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();
  const mint = base58.encode(randomBytes(32));
  await pool.query(
    "INSERT INTO seeker_devices (sgt_mint, user_id, claimed_at) VALUES ($1, $2, $3)",
    [mint, scout.id, BASE],
  );
  seekerBehaviour = async () => mint;
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 200, res.body);
});

// --- Seeker, through the real check over recorded mainnet responses ---
//
// test/fixtures/helius holds two raw responses captured from mainnet on 28
// September 2026 for the one real user's wallet: getTokenAccountsByOwnerV2 and
// getMultipleAccounts for its Seeker Genesis Token. Each test first runs the
// unedited bytes as a control that must find the mint, so the NOT_HELD after
// it cannot come from a check that finds nothing at all; then it edits exactly
// one field and goes through the endpoint.

const FIXTURES = join(process.cwd(), "test", "fixtures", "helius");
const OWNER_FIXTURE = readFileSync(join(FIXTURES, "owner_accounts.json"), "utf8");
const MINT_FIXTURE = readFileSync(join(FIXTURES, "sgt_mint.json"), "utf8");
const FIXTURE_WALLET = "9BZ17sUdF2matCurxmdmUpD3BNabBTFmsmAVu5oY9qP3";
const FIXTURE_MINT = "9cDPQW5FuAj2tb2UREgTvzsAeTteXJ4FFgHcfq2ZHbMo";
const HELIUS_URL = "https://mainnet.example.test/";

interface RpcCall {
  method: string;
  params: unknown[];
}

// Serves token-account pages in order, with the recorded wallet rewritten to
// the one requested, and the mint response for every getMultipleAccounts.
function heliusDouble(pages: string[], mintBody: string): { fetch: FetchLike; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let next = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const call = JSON.parse(init.body) as RpcCall;
    calls.push(call);
    let body: string;
    if (call.method === "getTokenAccountsByOwnerV2") {
      const page = pages[next++];
      if (page === undefined) throw new Error("double: no page left");
      body = page.split(FIXTURE_WALLET).join(String(call.params[0]));
    } else if (call.method === "getMultipleAccounts") {
      body = mintBody;
    } else {
      throw new Error("double: unexpected method " + call.method);
    }
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch: fetchImpl, calls };
}

function editOnce(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, "edit anchor must occur exactly once: " + from);
  return text.replace(from, to);
}

test("20 a zero-balance qualifying account is ignored: SEEKER_NOT_HELD", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();

  // Control, and the section 5.3 cache: found, then served without a request
  // until 24 hours have passed, then walked again.
  const control = heliusDouble([OWNER_FIXTURE, OWNER_FIXTURE], MINT_FIXTURE);
  const check = heliusSeekerCheck(HELIUS_URL, control.fetch, clock);
  assert.equal(await check.findSeekerMint(scout.wallet), FIXTURE_MINT);
  assert.deepEqual(
    control.calls.map((c) => c.method),
    ["getTokenAccountsByOwnerV2", "getMultipleAccounts"],
  );
  nowMs = BASE.getTime() + SEEKER_CACHE_MS - 1;
  assert.equal(await check.findSeekerMint(scout.wallet), FIXTURE_MINT);
  assert.equal(control.calls.length, 2);
  nowMs = BASE.getTime() + SEEKER_CACHE_MS;
  assert.equal(await check.findSeekerMint(scout.wallet), FIXTURE_MINT);
  assert.equal(control.calls.length, 4);
  nowMs = BASE.getTime();

  // The edit: balance 1 to 0. The account stays frozen, as recorded.
  const zeroed = editOnce(OWNER_FIXTURE, '"amount":"1"', '"amount":"0"');
  assert.ok(zeroed.includes('"state":"frozen"'));
  const edited = heliusSeekerCheck(HELIUS_URL, heliusDouble([zeroed], MINT_FIXTURE).fetch, clock);
  seekerBehaviour = () => edited.findSeekerMint(scout.wallet);
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "SEEKER_NOT_HELD" });
});

test("21 a mint with the right authority but the wrong group: SEEKER_NOT_HELD", async () => {
  const seeded = await seedFunded({ profile: "A4_SEEKER_V1" });
  const scout = await seedUser();

  // Control, which also walks two pages: an empty first page carrying a
  // pagination key, then the recording. The second request must carry the key.
  const accounts = OWNER_FIXTURE.slice(
    OWNER_FIXTURE.indexOf('"accounts":['),
    OWNER_FIXTURE.indexOf(',"paginationKey":null,"count":1'),
  );
  const emptyPage = editOnce(
    editOnce(OWNER_FIXTURE, accounts, '"accounts":[]'),
    '"paginationKey":null,"count":1',
    '"paginationKey":"page-2","count":0',
  );
  const control = heliusDouble([emptyPage, OWNER_FIXTURE], MINT_FIXTURE);
  const check = heliusSeekerCheck(HELIUS_URL, control.fetch, clock);
  assert.equal(await check.findSeekerMint(scout.wallet), FIXTURE_MINT);
  assert.deepEqual(
    control.calls.map((c) => c.method),
    ["getTokenAccountsByOwnerV2", "getTokenAccountsByOwnerV2", "getMultipleAccounts"],
  );
  const keyOf = (call: RpcCall | undefined): unknown =>
    (call?.params[2] as { paginationKey?: unknown } | undefined)?.paginationKey;
  assert.equal(keyOf(control.calls[0]), undefined);
  assert.equal(keyOf(control.calls[1]), "page-2");

  // The edit: the group address only. The mint authority and the metadata
  // pointer stay exactly as recorded.
  const wrongGroup = editOnce(
    MINT_FIXTURE,
    '"group":"GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te"',
    '"group":"11111111111111111111111111111111"',
  );
  assert.ok(wrongGroup.includes('"mintAuthority":"GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4"'));
  const double = heliusDouble([OWNER_FIXTURE], wrongGroup);
  const edited = heliusSeekerCheck(HELIUS_URL, double.fetch, clock);
  seekerBehaviour = () => edited.findSeekerMint(scout.wallet);
  const res = await voucher(scout.token, seeded.id);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "SEEKER_NOT_HELD" });
});

// --- reservation ---

test("22 two concurrent Scouts: one 200, one BOUNTY_RESERVED, one ACTIVE row", async () => {
  const seeded = await seedFunded();
  const a = await seedUser();
  const b = await seedUser();
  const [ra, rb] = await Promise.all([
    voucher(a.token, seeded.id),
    voucher(b.token, seeded.id),
  ]);
  assert.deepEqual([ra.statusCode, rb.statusCode].sort(), [200, 409]);
  const loser = ra.statusCode === 409 ? ra : rb;
  assert.deepEqual(loser.json(), { error: "BOUNTY_RESERVED" });
  assert.equal((await activeRows(seeded.id)).length, 1);
});

test("23 the holder asks again: fresh voucher, later expiry, reservation unchanged", async () => {
  const seeded = await seedFunded();
  const scout = await seedUser();
  const first = await voucher(scout.token, seeded.id);
  assert.equal(first.statusCode, 200, first.body);
  const before = await activeRows(seeded.id);
  nowMs += 10_000;
  const second = await voucher(scout.token, seeded.id);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().expires_at, first.json().expires_at + 10);
  assert.notEqual(second.json().message, first.json().message);
  const afterRows = await activeRows(seeded.id);
  assert.equal(afterRows.length, 1);
  assert.equal(afterRows[0]!.expires_at.getTime(), before[0]!.expires_at.getTime());
});

test("24 past a reservation's expiry another Scout succeeds; the stale row flips", async () => {
  const seeded = await seedFunded();
  const a = await seedUser();
  const b = await seedUser();
  const first = await voucher(a.token, seeded.id);
  assert.equal(first.statusCode, 200, first.body);
  nowMs = (first.json().expires_at as number) * 1000;
  const second = await voucher(b.token, seeded.id);
  assert.equal(second.statusCode, 200, second.body);
  const statuses = await pool.query<{ scout_id: string; status: string }>(
    "SELECT scout_id, status FROM assignments WHERE bounty_id = $1",
    [seeded.id],
  );
  assert.deepEqual(
    statuses.rows.map((r) => [r.scout_id, r.status]).sort(),
    [[a.id, "EXPIRED"], [b.id, "ACTIVE"]].sort(),
  );
});
