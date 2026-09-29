import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import { SignJWT, jwtVerify, base64url } from "jose";
import { buildApp } from "../src/app.ts";
import { loadCaptureConfig, type Config } from "../src/config.ts";
import type { Clock } from "../src/clock.ts";

// --- scratch database, same pattern as migrations.test.ts ---

const dbName = `bountycam_auth_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

// --- controlled clock (AUTH.md section 8): no test sleeps to reach expiry ---

const BASE = new Date("2026-09-12T00:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

// --- test configuration; secret generated per run (SECURITY.md section 7) ---

const jwtSecret = Uint8Array.from(randomBytes(32));
const config: Config = {
  siwsDomain: "app.example.com",
  allowedChains: new Set(["devnet"]),
  jwtSecret,
  jwtIssuer: "bountycam-api",
  jwtAudience: "bountycam-app",
  capture: loadCaptureConfig({}),
};

// --- keys: the AUTH.md section 12 vector key (TEST KEY ONLY), plus one
//     per-run key where the spec's own tests require a second signer ---

const VECTOR_SEED = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "hex",
);
const VECTOR_ADDRESS = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const STATEMENT =
  "Sign in to BountyCam. This proves you control this wallet and moves no funds.";

const VECTOR_INPUT = {
  domain: "app.example.com",
  address: VECTOR_ADDRESS,
  statement: STATEMENT,
  version: "1",
  chainId: "devnet",
  nonce: "00112233445566778899aabbccddeeff",
  issuedAt: "2026-09-12T00:00:00.000Z",
  expirationTime: "2026-09-12T00:05:00.000Z",
};

const VECTOR_MESSAGE_TEXT = [
  "app.example.com wants you to sign in with your Solana account:",
  VECTOR_ADDRESS,
  "",
  STATEMENT,
  "",
  "Version: 1",
  "Chain ID: devnet",
  "Nonce: 00112233445566778899aabbccddeeff",
  "Issued At: 2026-09-12T00:00:00.000Z",
  "Expiration Time: 2026-09-12T00:05:00.000Z",
].join("\n");

const VECTOR_MESSAGE_BASE64 =
  "YXBwLmV4YW1wbGUuY29tIHdhbnRzIHlvdSB0byBzaWduIGluIHdpdGggeW91ciBTb2xhbmEgYWNj" +
  "b3VudDoKRlZlbjNYNjY5eEx6c2k2TjJWOTFEb2l5ekh6ZzF1QWdxaVQ4alo5blM5NloKClNpZ24g" +
  "aW4gdG8gQm91bnR5Q2FtLiBUaGlzIHByb3ZlcyB5b3UgY29udHJvbCB0aGlzIHdhbGxldCBhbmQg" +
  "bW92ZXMgbm8gZnVuZHMuCgpWZXJzaW9uOiAxCkNoYWluIElEOiBkZXZuZXQKTm9uY2U6IDAwMTEy" +
  "MjMzNDQ1NTY2Nzc4ODk5YWFiYmNjZGRlZWZmCklzc3VlZCBBdDogMjAyNi0wOS0xMlQwMDowMDow" +
  "MC4wMDBaCkV4cGlyYXRpb24gVGltZTogMjAyNi0wOS0xMlQwMDowNTowMC4wMDBa";

const VECTOR_SIGNATURE_HEX =
  "4460a95adf3394e0da7b738f0dca6a0eac57607cb4d88dc9ce4348d10cee24fd" +
  "e4d333ccb5bf192280d0aa57e88e5405b4ed20a5dec3eb122e6ad22efae26c09";

const otherSeed = randomBytes(32);
const otherAddress = base58.encode(ed25519.getPublicKey(otherSeed));

// --- app under test ---

const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const app = buildApp({ config, pool, clock });

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
});

beforeEach(() => {
  nowMs = BASE.getTime();
});

// --- helpers ---

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function requestChallenge(address: string, chain?: string) {
  return app.inject({
    method: "POST",
    url: "/auth/siws/challenge",
    payload: chain === undefined ? { address } : { address, chain },
  });
}

async function challengeInput(address: string): Promise<Record<string, string>> {
  const res = await requestChallenge(address);
  assert.equal(res.statusCode, 200);
  return res.json().input;
}

function signMessage(input: object, seed: Uint8Array) {
  const text = createSignInMessageText(input as never);
  const message = new TextEncoder().encode(text);
  const signature = ed25519.sign(message, seed);
  return { message, signature };
}

async function injectVerify(payload: unknown) {
  return app.inject({ method: "POST", url: "/auth/siws/verify", payload: payload as object });
}

async function verifySigned(
  input: Record<string, string>,
  seed: Uint8Array,
  overrides: Record<string, string> = {},
) {
  const { message, signature } = signMessage({ ...input, ...overrides }, seed);
  return injectVerify({ signed_message: b64(message), signature: b64(signature) });
}

async function injectMe(token?: string) {
  return app.inject({
    method: "GET",
    url: "/auth/me",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function issueTestToken(claims: {
  alg?: "HS256" | "HS512";
  iss?: string;
  aud?: string;
  expMs?: number;
}): Promise<string> {
  return new SignJWT({ wallet: VECTOR_ADDRESS })
    .setProtectedHeader({ alg: claims.alg ?? "HS256" })
    .setSubject("00000000-0000-0000-0000-000000000000")
    .setIssuer(claims.iss ?? config.jwtIssuer)
    .setAudience(claims.aud ?? config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 1000))
    .setExpirationTime(new Date(claims.expMs ?? BASE.getTime() + 3_600_000))
    .sign(jwtSecret);
}

// --- challenge endpoint ---

test("01 challenge success: fields, nonce form, expiry, stored row", async () => {
  const res = await requestChallenge(VECTOR_ADDRESS);
  assert.equal(res.statusCode, 200);
  const input = res.json().input;
  assert.deepEqual(Object.keys(input).sort(), [
    "address",
    "chainId",
    "domain",
    "expirationTime",
    "issuedAt",
    "nonce",
    "statement",
    "version",
  ]);
  assert.equal(input.domain, "app.example.com");
  assert.equal(input.address, VECTOR_ADDRESS);
  assert.equal(input.statement, STATEMENT);
  assert.equal(input.version, "1");
  assert.equal(input.chainId, "devnet");
  assert.match(input.nonce, /^[0-9a-f]{32}$/);
  assert.equal(input.issuedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(
    Date.parse(input.expirationTime) - Date.parse(input.issuedAt),
    300_000,
  );
  const row = await pool.query(
    "SELECT * FROM auth_challenges WHERE nonce = $1",
    [input.nonce],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].address, VECTOR_ADDRESS);
  assert.equal(row.rows[0].domain, "app.example.com");
  assert.equal(row.rows[0].chain, "devnet");
  assert.equal(row.rows[0].statement, STATEMENT);
  assert.equal(row.rows[0].issued_at_value, input.issuedAt);
  assert.equal(row.rows[0].expiration_time_value, input.expirationTime);
  assert.equal(row.rows[0].consumed_at, null);
});

test("02 two challenges return distinct nonces", async () => {
  const first = await challengeInput(VECTOR_ADDRESS);
  const second = await challengeInput(VECTOR_ADDRESS);
  assert.notEqual(first["nonce"], second["nonce"]);
});

test("03 missing address is INVALID_REQUEST", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/auth/siws/challenge",
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "INVALID_REQUEST");
});

test("04 non-base58 address is INVALID_ADDRESS", async () => {
  const res = await requestChallenge("not-valid-base58-!!!");
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "INVALID_ADDRESS");
});

test("05 chain mainnet is CHAIN_NOT_ALLOWED", async () => {
  const res = await requestChallenge(VECTOR_ADDRESS, "mainnet");
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "CHAIN_NOT_ALLOWED");
});

test("06 chain solana:devnet accepted, issued chainId is canonical devnet", async () => {
  const res = await requestChallenge(VECTOR_ADDRESS, "solana:devnet");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().input.chainId, "devnet");
});

// --- verify endpoint ---

test("07 round trip: built message, vector key, token verifies, user ACTIVE", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.wallet_address, VECTOR_ADDRESS);
  assert.equal(body.user.status, "ACTIVE");
  const { payload } = await jwtVerify(body.token, jwtSecret, {
    algorithms: ["HS256"],
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    currentDate: clock.now(),
  });
  assert.equal(payload.sub, body.user.id);
  assert.equal(payload["wallet"], VECTOR_ADDRESS);
  const row = await pool.query(
    "SELECT id, status FROM users WHERE wallet_address = $1",
    [VECTOR_ADDRESS],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].id, body.user.id);
  assert.equal(row.rows[0].status, "ACTIVE");
});

test("08 second verify for the same wallet: same user id, no second row", async () => {
  const first = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
  assert.equal(first.statusCode, 200);
  const second = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().user.id, second.json().user.id);
  const count = await pool.query(
    "SELECT count(*) AS n FROM users WHERE wallet_address = $1",
    [VECTOR_ADDRESS],
  );
  assert.equal(count.rows[0].n, "1");
});

test("09 vector reproduction: noble signature equals the section 12 signature", async () => {
  const message = new TextEncoder().encode(VECTOR_MESSAGE_TEXT);
  const signature = ed25519.sign(message, VECTOR_SEED);
  assert.equal(Buffer.from(signature).toString("hex"), VECTOR_SIGNATURE_HEX);
});

test("10 builder equivalence: pinned builder yields the 333 vector bytes", async () => {
  const text = createSignInMessageText(VECTOR_INPUT as never);
  assert.equal(text, VECTOR_MESSAGE_TEXT);
  const bytes = new TextEncoder().encode(text);
  assert.equal(bytes.length, 333);
  assert.equal(Buffer.from(bytes).toString("base64"), VECTOR_MESSAGE_BASE64);
});

test("11 tampered message byte is SIGNATURE_INVALID", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message, signature } = signMessage(input, VECTOR_SEED);
  message[0] ^= 0x01;
  const res = await injectVerify({
    signed_message: b64(message),
    signature: b64(signature),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "SIGNATURE_INVALID");
});

test("12 signature from a different key is SIGNATURE_INVALID", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message } = signMessage(input, VECTOR_SEED);
  const signature = ed25519.sign(message, otherSeed);
  const res = await injectVerify({
    signed_message: b64(message),
    signature: b64(signature),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "SIGNATURE_INVALID");
});

test("13 message address differs from challenge address: ADDRESS_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, otherSeed, { address: otherAddress });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "ADDRESS_MISMATCH");
});

test("14 wrong domain in message is DOMAIN_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, { domain: "evil.example.com" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "DOMAIN_MISMATCH");
});

test("15 wrong statement in message is STATEMENT_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, {
    statement: "Sign in to BountyCam.",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "STATEMENT_MISMATCH");
});

test("16 reused nonce: second identical submission is NONCE_CONSUMED", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message, signature } = signMessage(input, VECTOR_SEED);
  const payload = { signed_message: b64(message), signature: b64(signature) };
  const first = await injectVerify(payload);
  assert.equal(first.statusCode, 200);
  const second = await injectVerify(payload);
  assert.equal(second.statusCode, 401);
  assert.equal(second.json().error, "NONCE_CONSUMED");
});

test("17 clock advanced past expiry is NONCE_EXPIRED", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  nowMs = BASE.getTime() + 301_000;
  const res = await verifySigned(input, VECTOR_SEED);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "NONCE_EXPIRED");
});

test("18 never-issued nonce is NONCE_UNKNOWN", async () => {
  const input = {
    domain: "app.example.com",
    address: VECTOR_ADDRESS,
    statement: STATEMENT,
    version: "1",
    chainId: "devnet",
    nonce: "ffffffffffffffffffffffffffffffff",
    issuedAt: "2026-09-12T00:00:00.000Z",
    expirationTime: "2026-09-12T00:05:00.000Z",
  };
  const res = await verifySigned(input, VECTOR_SEED);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "NONCE_UNKNOWN");
});

test("19 bytes that do not parse are MALFORMED_MESSAGE", async () => {
  const res = await injectVerify({
    signed_message: b64(Buffer.from("this is not a sign-in message")),
    signature: b64(randomBytes(64)),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "MALFORMED_MESSAGE");
});

test("20 version 2 in message is VERSION_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, { version: "2" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "VERSION_MISMATCH");
});

test("21 Chain ID mainnet in message is CHAIN_NOT_ALLOWED", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, { chainId: "mainnet" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "CHAIN_NOT_ALLOWED");
});

test("22 URI line present is UNEXPECTED_FIELD", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, {
    uri: "https://app.example.com/",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "UNEXPECTED_FIELD");
});

test("23 altered issuedAt is ISSUED_AT_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, {
    issuedAt: "2026-09-12T00:00:01.000Z",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "ISSUED_AT_MISMATCH");
});

test("24 altered expirationTime is EXPIRATION_TIME_MISMATCH", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const res = await verifySigned(input, VECTOR_SEED, {
    expirationTime: "2026-09-12T00:06:00.000Z",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "EXPIRATION_TIME_MISMATCH");
});

test("25 failed field check burns the nonce: retry is NONCE_CONSUMED", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const bad = await verifySigned(input, VECTOR_SEED, { domain: "evil.example.com" });
  assert.equal(bad.json().error, "DOMAIN_MISMATCH");
  const good = await verifySigned(input, VECTOR_SEED);
  assert.equal(good.statusCode, 401);
  assert.equal(good.json().error, "NONCE_CONSUMED");
});

test("26 signature_type secp256k1 is UNSUPPORTED_SIGNATURE_TYPE", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message, signature } = signMessage(input, VECTOR_SEED);
  const res = await injectVerify({
    signed_message: b64(message),
    signature: b64(signature),
    signature_type: "secp256k1",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "UNSUPPORTED_SIGNATURE_TYPE");
});

test("27 signature_type ed25519 explicitly present is accepted", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message, signature } = signMessage(input, VECTOR_SEED);
  const res = await injectVerify({
    signed_message: b64(message),
    signature: b64(signature),
    signature_type: "ed25519",
  });
  assert.equal(res.statusCode, 200);
});

test("28 63-byte signature is INVALID_REQUEST", async () => {
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message } = signMessage(input, VECTOR_SEED);
  const res = await injectVerify({
    signed_message: b64(message),
    signature: b64(randomBytes(63)),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "INVALID_REQUEST");
});

test("29 signed_message not valid base64 is INVALID_REQUEST", async () => {
  const res = await injectVerify({
    signed_message: "%%%not-base64%%%",
    signature: b64(randomBytes(64)),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "INVALID_REQUEST");
});

// --- token and GET /auth/me ---

test("30 valid token: 200 with id and wallet_address", async () => {
  const verified = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
  assert.equal(verified.statusCode, 200);
  const { token, user } = verified.json();
  const res = await injectMe(token);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, user.id);
  assert.equal(body.wallet_address, VECTOR_ADDRESS);
  assert.equal(body.status, "ACTIVE");
});

test("31 no Authorization header is TOKEN_MISSING", async () => {
  const res = await injectMe();
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_MISSING");
});

test("32 algorithm none is TOKEN_INVALID", async () => {
  const header = base64url.encode(JSON.stringify({ alg: "none" }));
  const payload = base64url.encode(
    JSON.stringify({
      sub: "00000000-0000-0000-0000-000000000000",
      wallet: VECTOR_ADDRESS,
      iss: config.jwtIssuer,
      aud: config.jwtAudience,
      iat: Math.floor(BASE.getTime() / 1000),
      exp: Math.floor(BASE.getTime() / 1000) + 3600,
    }),
  );
  const res = await injectMe(`${header}.${payload}.`);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

test("33 HS512 with the correct secret is TOKEN_INVALID", async () => {
  const token = await issueTestToken({ alg: "HS512" });
  const res = await injectMe(token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

test("34 expired beyond the 60-second tolerance is TOKEN_EXPIRED", async () => {
  const token = await issueTestToken({ expMs: BASE.getTime() - 120_000 });
  const res = await injectMe(token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_EXPIRED");
});

test("35 wrong audience is TOKEN_INVALID", async () => {
  const token = await issueTestToken({ aud: "some-other-app" });
  const res = await injectMe(token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

test("36 wrong issuer is TOKEN_INVALID", async () => {
  const token = await issueTestToken({ iss: "some-other-issuer" });
  const res = await injectMe(token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

test("37 tampered payload is TOKEN_INVALID", async () => {
  const verified = await verifySigned(await challengeInput(VECTOR_ADDRESS), VECTOR_SEED);
  assert.equal(verified.statusCode, 200);
  const token: string = verified.json().token;
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(
    new TextDecoder().decode(base64url.decode(payload!)),
  );
  claims.wallet = otherAddress;
  const tampered = `${header}.${base64url.encode(JSON.stringify(claims))}.${signature}`;
  const res = await injectMe(tampered);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "TOKEN_INVALID");
});

// --- concurrency (SECURITY.md section 4) ---

test("38 two concurrent verifies with one nonce: exactly one succeeds", async () => {
  assert.ok(
    pool.options.max >= 2,
    "pool must allow at least 2 connections for a real race",
  );
  const input = await challengeInput(VECTOR_ADDRESS);
  const { message, signature } = signMessage(input, VECTOR_SEED);
  const payload = { signed_message: b64(message), signature: b64(signature) };
  const [first, second] = await Promise.all([
    injectVerify(payload),
    injectVerify(payload),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 401]);
  const loser = first.statusCode === 401 ? first : second;
  assert.equal(loser.json().error, "NONCE_CONSUMED");
});
