import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { SignJWT } from "jose";
import { buildApp } from "../src/app.ts";
import type { ChainWriter, SignatureStatus } from "../src/chain/rpc.ts";
import type { Clock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { loadFaucetConfig, mintAuthority, type FaucetConfig } from "../src/faucet/config.ts";
import {
  ATA_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  recipientTokenAccount,
} from "../src/faucet/tx.ts";
import type { Randomness } from "../src/randomness.ts";

// D167: the devnet faucet. Expected count: 13.

const MINT = "ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR";
const dbName = `bountycam_faucet_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

const BASE = new Date("2026-10-12T00:00:00.000Z");
let nowMs = BASE.getTime();
const clock: Clock = { now: () => new Date(nowMs) };

const dir = mkdtempSync(join(tmpdir(), "bountycam-faucet-test-"));
const secretPath = join(dir, "jwt-secret.hex");
writeFileSync(secretPath, Buffer.from(randomBytes(32)).toString("hex"));

function keyFile(name: string): { path: string; seed: Uint8Array; pubkey: Uint8Array } {
  const seed = Uint8Array.from(randomBytes(32));
  const pubkey = ed25519.getPublicKey(seed);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify([...seed, ...pubkey]));
  return { path, seed, pubkey };
}
const faucetKey = keyFile("faucet.json");
const relayerKey = keyFile("relayer.json");

const baseEnv = {
  FAUCET_KEY_PATH: faucetKey.path,
  RELAYER_KEY_PATH: relayerKey.path,
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  SETTLEMENT_MINT: MINT,
  FAUCET_DAILY_CAP: "3",
};
const config = loadConfig({ JWT_SECRET_PATH: secretPath, SETTLEMENT_MINT: MINT });
const faucet = loadFaucetConfig(baseEnv) as FaucetConfig;

// --- a writer double: records each wire, answers statuses from a script ---

const sent: Uint8Array[] = [];
let sendFails = false;
let statusScript: (SignatureStatus | null)[] = [];
const writer: ChainWriter = {
  async getLatestBlockhash() {
    return new Uint8Array(32).fill(9);
  },
  async sendTransaction(wire) {
    if (sendFails) throw new Error("double: send refused");
    sent.push(wire);
    return "ignored";
  },
  async getSignatureStatuses(signatures) {
    const next = statusScript.length > 1 ? statusScript.shift() : statusScript[0];
    return signatures.map(() => next ?? null);
  },
};
const CONFIRMED: SignatureStatus = { confirmationStatus: "confirmed", failed: false };

const randomness: Randomness = {
  randomBytes: (n) => Uint8Array.from(randomBytes(n)),
  randomUUID: () => crypto.randomUUID(),
};
const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });
const app = buildApp({
  config,
  pool,
  clock,
  randomness,
  faucet: {
    faucet,
    writer,
    // Each poll advances the clock one second, so the confirm bound is reachable.
    sleep: async (ms) => {
      nowMs += ms;
    },
  },
});
const plain = buildApp({ config, pool, clock, randomness });

before(async () => {
  psql("postgres", `CREATE DATABASE ${dbName}`);
  execFileSync(
    "pnpm",
    ["exec", "node-pg-migrate", "--migrations-dir", "migrations", "up"],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  await app.ready();
  await plain.ready();
});

after(async () => {
  await app.close();
  await plain.close();
  await pool.end();
  psql("postgres", `DROP DATABASE IF EXISTS ${dbName}`);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  nowMs = BASE.getTime();
  sent.length = 0;
  sendFails = false;
  statusScript = [CONFIRMED];
  await pool.query("DELETE FROM faucet_grants");
});

// --- helpers ---

async function seedUser(): Promise<{ id: string; wallet: string; token: string }> {
  const wallet = base58.encode(ed25519.getPublicKey(Uint8Array.from(randomBytes(32))));
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
    [wallet],
  );
  const id = result.rows[0]!.id;
  const token = await new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(new Date(BASE.getTime() - 1000))
    .setExpirationTime(new Date(BASE.getTime() + 30 * 86_400_000))
    .sign(config.jwtSecret);
  return { id, wallet, token };
}

function post(token?: string) {
  return app.inject({
    method: "POST",
    url: "/faucet",
    headers: token === undefined ? {} : { authorization: "Bearer " + token },
  });
}

function compact(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, i];
    shift += 7;
  }
}

interface Parsed {
  signatures: Uint8Array[];
  message: Uint8Array;
  header: number[];
  keys: Uint8Array[];
  instructions: { program: Uint8Array; accounts: Uint8Array[]; data: Uint8Array }[];
}

function parse(wire: Uint8Array): Parsed {
  let [n, at] = compact(wire, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++, at += 64) signatures.push(wire.slice(at, at + 64));
  const message = wire.slice(at);
  const header = [message[0]!, message[1]!, message[2]!];
  let p = 3;
  let k: number;
  [k, p] = compact(message, p);
  const keys: Uint8Array[] = [];
  for (let i = 0; i < k; i++, p += 32) keys.push(message.slice(p, p + 32));
  p += 32; // blockhash
  let ni: number;
  [ni, p] = compact(message, p);
  const instructions = [];
  for (let i = 0; i < ni; i++) {
    const program = keys[message[p++]!]!;
    let na: number;
    [na, p] = compact(message, p);
    const accounts = [...message.slice(p, p + na)].map((idx) => keys[idx]!);
    p += na;
    let nd: number;
    [nd, p] = compact(message, p);
    const data = message.slice(p, p + nd);
    p += nd;
    instructions.push({ program, accounts, data });
  }
  return { signatures, message, header, keys, instructions };
}

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const u64 = (data: Uint8Array, at: number) => Buffer.from(data).readBigUInt64LE(at);

// --- tests ---

test("1. without a token the faucet answers 401", async () => {
  const res = await post();
  assert.equal(res.statusCode, 401);
});

test("2. without FAUCET_KEY_PATH the route does not exist", async () => {
  const user = await seedUser();
  const res = await plain.inject({
    method: "POST",
    url: "/faucet",
    headers: { authorization: "Bearer " + user.token },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(loadFaucetConfig({ ...baseEnv, FAUCET_KEY_PATH: "" }), null);
});

test("3. a grant sends one transaction: SOL, the token account, then test USDC", async () => {
  const user = await seedUser();
  const res = await post(user.token);
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body["usdc"], "20");
  assert.equal(body["sol"], "0.02");
  assert.equal(body["confirmed"], true);
  assert.equal(sent.length, 1);

  const tx = parse(sent[0]!);
  assert.deepEqual(tx.header.slice(0, 2), [2, 1], "two signers, the faucet read-only");
  assert.ok(eq(tx.keys[0]!, faucet.relayerPubkey), "the relayer pays");
  assert.ok(eq(tx.keys[1]!, faucet.faucetPubkey));
  assert.ok(ed25519.verify(tx.signatures[0]!, tx.message, faucet.relayerPubkey));
  assert.ok(ed25519.verify(tx.signatures[1]!, tx.message, faucet.faucetPubkey));
  assert.equal(body["signature"], base58.encode(tx.signatures[0]!));

  const recipient = base58.decode(user.wallet);
  const ata = recipientTokenAccount(recipient, faucet.mint);
  const [transfer, create, mintTo] = tx.instructions;
  assert.ok(eq(transfer!.program, SYSTEM_PROGRAM));
  assert.equal(Buffer.from(transfer!.data).readUInt32LE(0), 2);
  assert.equal(u64(transfer!.data, 4), 20_000_000n);
  assert.ok(eq(transfer!.accounts[1]!, recipient));
  assert.ok(eq(create!.program, ATA_PROGRAM));
  assert.ok(eq(create!.accounts[1]!, ata));
  assert.ok(eq(create!.accounts[2]!, recipient));
  assert.ok(eq(mintTo!.program, TOKEN_PROGRAM));
  assert.equal(mintTo!.data[0], 7);
  assert.equal(u64(mintTo!.data, 1), 20_000_000n);
  assert.ok(eq(mintTo!.accounts[0]!, faucet.mint));
  assert.ok(eq(mintTo!.accounts[1]!, ata));
  assert.ok(eq(mintTo!.accounts[2]!, faucet.faucetPubkey));

  const rows = await pool.query("SELECT status, tx_signature FROM faucet_grants");
  assert.equal(rows.rows[0].status, "SENT");
  assert.equal(rows.rows[0].tx_signature, body["signature"]);
});

test("4. a second request inside the cooldown is refused with the wait", async () => {
  const user = await seedUser();
  assert.equal((await post(user.token)).statusCode, 200);
  nowMs += 3600_000;
  const res = await post(user.token);
  assert.equal(res.statusCode, 429);
  const body = res.json() as { error: string; retry_after_s: number };
  assert.equal(body.error, "FAUCET_COOLDOWN");
  assert.ok(body.retry_after_s > 82_000 && body.retry_after_s <= 82_800);
  assert.equal(sent.length, 1);
});

test("5. after the cooldown the same wallet may claim again", async () => {
  const user = await seedUser();
  assert.equal((await post(user.token)).statusCode, 200);
  nowMs += 86_400_000 + 1000;
  assert.equal((await post(user.token)).statusCode, 200);
  assert.equal(sent.length, 2);
});

test("6. two simultaneous requests send once", async () => {
  const user = await seedUser();
  const [a, b] = await Promise.all([post(user.token), post(user.token)]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 429]);
  assert.equal(sent.length, 1);
});

test("7. the daily cap across all wallets answers 503", async () => {
  for (let i = 0; i < 3; i++) {
    const user = await seedUser();
    assert.equal((await post(user.token)).statusCode, 200);
  }
  const last = await seedUser();
  const res = await post(last.token);
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { error: string }).error, "FAUCET_EXHAUSTED");
  assert.equal(sent.length, 3);
});

test("8. a send failure answers 502 and frees the cooldown", async () => {
  const user = await seedUser();
  sendFails = true;
  const res = await post(user.token);
  assert.equal(res.statusCode, 502);
  assert.equal((res.json() as { error: string }).error, "FAUCET_SEND_FAILED");
  sendFails = false;
  assert.equal((await post(user.token)).statusCode, 200);
});

test("9. a transaction that fails on chain answers 502 and frees the cooldown", async () => {
  const user = await seedUser();
  statusScript = [{ confirmationStatus: null, failed: true }];
  assert.equal((await post(user.token)).statusCode, 502);
  const rows = await pool.query("SELECT status FROM faucet_grants");
  assert.equal(rows.rows[0].status, "FAILED");
  statusScript = [CONFIRMED];
  assert.equal((await post(user.token)).statusCode, 200);
});

test("10. an unconfirmed transaction answers 202 and keeps the cooldown", async () => {
  const user = await seedUser();
  statusScript = [null];
  const res = await post(user.token);
  assert.equal(res.statusCode, 202);
  assert.equal((res.json() as { confirmed: boolean }).confirmed, false);
  statusScript = [CONFIRMED];
  assert.equal((await post(user.token)).statusCode, 429);
});

test("11. the loader refuses another cluster, a mainnet URL and a shared key", () => {
  assert.throws(() => loadFaucetConfig({ ...baseEnv, SOLANA_CLUSTER: "mainnet-beta" }), /devnet/);
  assert.throws(
    () => loadFaucetConfig({ ...baseEnv, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" }),
    /mainnet/,
  );
  assert.throws(
    () => loadFaucetConfig({ ...baseEnv, RELAYER_KEY_PATH: faucetKey.path }),
    /differ/,
  );
  assert.throws(() => loadFaucetConfig({ ...baseEnv, FAUCET_LAMPORTS: "0" }), /positive/);
});

test("12. the loader's defaults: 20 USDC, 0.02 SOL, a day, 200 a day", () => {
  const c = loadFaucetConfig({ ...baseEnv, FAUCET_DAILY_CAP: "" }) as FaucetConfig;
  assert.equal(c.usdcAmount, 20_000_000n);
  assert.equal(c.lamports, 20_000_000n);
  assert.equal(c.cooldownS, 86_400);
  assert.equal(c.dailyCap, 200);
});

test("13. mintAuthority reads the COption at offset 0", () => {
  const data = new Uint8Array(82);
  assert.equal(mintAuthority(data), null);
  data.set([1, 0, 0, 0], 0);
  data.set(faucet.faucetPubkey, 4);
  assert.ok(eq(mintAuthority(data) as Uint8Array, faucet.faucetPubkey));
  assert.equal(mintAuthority(new Uint8Array(10)), null);
});
