// POLICY.md section 20.10 (D162): release, expire, resolve and project by hand.
// Run from apps/api:
//   node scripts/settle.mjs release <bounty_id>
//   node scripts/settle.mjs expire <bounty_id>
//   node scripts/settle.mjs resolve <bounty_id> pay|refund
//   node scripts/settle.mjs project <bounty_id>
// Reads ~/bountycam-env/api.env. The relayer signs and pays; resolve adds the arbiter's
// signature (ARBITER_KEY_PATH, default ~/bountycam-keys/arbiter.json, mode 600). Prints no
// URL, store key, coordinate or key material. Asks once before sending.
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@hackathon/shared";
import { decodeBountyAccount, readTail } from "../src/chain/bounty.ts";
import { associatedTokenAddress } from "../src/chain/pda.ts";
import {
  jsonRpcChainReader,
  jsonRpcChainWriter,
  jsonRpcSettlementReader,
} from "../src/chain/rpc.ts";
import { expireMessage, releaseMessage, resolveMessage, signedWire } from "../src/chain/tx.ts";
import { loadEvidenceConfig } from "../src/config.ts";
import { s3EvidenceStore } from "../src/evidence/store.ts";
import { projectSettlement } from "../src/settlement/project.ts";
import { settlementKeys } from "../src/settlement/release.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [command, bountyId, side] = process.argv.slice(2);
const usage = () => {
  console.log("usage: node scripts/settle.mjs release|expire|project <bounty_id>");
  console.log("       node scripts/settle.mjs resolve <bounty_id> pay|refund");
  process.exit(2);
};
if (!["release", "expire", "resolve", "project"].includes(command) || !UUID.test(bountyId ?? "")) {
  usage();
}
if (command === "resolve" && side !== "pay" && side !== "refund") usage();

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

function readKeypair(path, name) {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${name} must be mode 600`);
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  const seed = bytes.slice(0, 32);
  if (bytes.length !== 64 ||
    Buffer.compare(Buffer.from(ed25519.getPublicKey(seed)), Buffer.from(bytes.slice(32))) !== 0) {
    throw new Error(`${name} is not a keypair whose public half matches its seed`);
  }
  return { seed, pubkey: bytes.slice(32) };
}

const env = readEnvFile(join(homedir(), "bountycam-env", "api.env"));
const chain = jsonRpcChainReader(env.SOLANA_RPC_URL, fetch);
const writer = jsonRpcChainWriter(env.SOLANA_RPC_URL, fetch);
const settlement = jsonRpcSettlementReader(env.SOLANA_RPC_URL, fetch);
const programId = env.ESCROW_PROGRAM_ID;
const configAccount = env.ESCROW_CONFIG_ACCOUNT;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const STATE_BYTES = ["Funded", "Accepted", "Submitted", "Disputed", "Paid", "Refunded"];

async function project() {
  const result = await projectSettlement({
    pool,
    clock: { now: () => new Date() },
    chain,
    settlement,
    programId,
    alarm: (outcome, id) => console.log(`ALARM ${outcome} ${id}`),
  }, bountyId);
  console.log(`projection: ${result.outcome}`);
  const s = await pool.query(
    "SELECT b.state, t.kind, t.tx_signature FROM bounties b " +
      "LEFT JOIN settlements t ON t.bounty_id = b.id WHERE b.id = $1",
    [bountyId],
  );
  const row = s.rows[0];
  if (row !== undefined) {
    console.log(`database: ${row.state}${row.kind ? " " + row.kind : ""}`);
    if (row.tx_signature) console.log(`explorer: ${explorer(row.tx_signature)}`);
  }
}

async function main() {
  const loaded = await pool.query(
    `SELECT b.id, b.state, b.program_account, p.canonical_json
     FROM bounties b JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
    [bountyId],
  );
  const row = loaded.rows[0];
  if (row === undefined || row.program_account === null) throw new Error("no such funded bounty");
  console.log(`bounty ${bountyId}: database ${row.state}`);
  if (command === "project") return project();

  const info = await chain.getAccount(row.program_account);
  if (info === null) throw new Error("no account on chain");
  const decoded = decodeBountyAccount(info, programId);
  const tailRead = readTail(info);
  if (!decoded.ok || !tailRead.ok) throw new Error("not a bounty account");
  const tail = tailRead.tail;
  console.log(`chain: ${decoded.bounty.state} (state byte ${STATE_BYTES.indexOf(decoded.bounty.state)})`);

  const configInfo = await chain.getAccount(configAccount);
  if (configInfo === null) throw new Error("no configuration account");
  const mint = configInfo.data.slice(9, 41);
  const relayer = readKeypair(env.RELAYER_KEY_PATH, "RELAYER_KEY_PATH");
  const keys = settlementKeys(base58.decode(programId), configAccount,
    base58.decode(row.program_account), decoded.bounty.requester, mint);
  const ata = (owner) =>
    associatedTokenAddress(owner, mint, keys.tokenProgram, keys.associatedTokenProgram);
  const reward = Number(decoded.bounty.rewardAmount) / 1e6;
  let build;
  let seeds = [relayer.seed];
  let plan;

  if (command === "release") {
    if (decoded.bounty.state !== "Submitted") throw new Error("release needs a Submitted account");
    build = (bh) => releaseMessage(keys, relayer.pubkey, tail.scout, ata(tail.scout), bh);
    plan = `release ${reward} USDC to the Scout ${base58.encode(tail.scout)}`;
  } else if (command === "expire") {
    if (decoded.bounty.state !== "Accepted") throw new Error("expire needs an Accepted account");
    build = (bh) => expireMessage(keys, relayer.pubkey, ata(decoded.bounty.requester), bh);
    plan = `expire_accepted: ${reward} USDC back to the requester ` +
      base58.encode(decoded.bounty.requester);
  } else {
    if (decoded.bounty.state !== "Disputed") throw new Error("resolve needs a Disputed account");
    const arbiter = readKeypair(
      env.ARBITER_KEY_PATH || join(homedir(), "bountycam-keys", "arbiter.json"),
      "ARBITER_KEY_PATH",
    );
    seeds = [relayer.seed, arbiter.seed];
    // The named requirement, then the photos, checked against their stored hashes.
    const policy = JSON.parse(row.canonical_json);
    const failed = tail.failedRequirementId === null ? null
      : [...Buffer.from(tail.failedRequirementId).toString("hex")]
          .reduce((s, c, i) => s + ([8, 12, 16, 20].includes(i) ? "-" : "") + c, "");
    const named = policy.evidence_requirements.find((r) => r.id === failed);
    console.log(named ? `disputed requirement: "${named.prompt}"`
      : "disputed requirement: not in the policy (D161)");
    const evidence = loadEvidenceConfig(env);
    if (evidence.store === null) throw new Error("the evidence store keys are not set");
    const store = s3EvidenceStore(evidence.store, 900, fetch);
    const items = await pool.query(
      `SELECT e.requirement_id, e.storage_key, e.hash FROM evidence_items e
       JOIN submissions s ON s.id = e.submission_id WHERE s.bounty_id = $1`,
      [bountyId],
    );
    const dir = join(homedir(), "Downloads", `bountycam-dispute-${bountyId}`);
    mkdirSync(dir, { recursive: true });
    for (const it of items.rows) {
      const bytes = await store.get(it.storage_key, evidence.maxBytes);
      const ok = bytes !== null && Buffer.from(sha256(bytes)).equals(it.hash);
      const prompt = policy.evidence_requirements.find((r) => r.id === it.requirement_id)?.prompt;
      if (ok) writeFileSync(join(dir, `${it.requirement_id}.jpg`), bytes);
      console.log(`${ok ? "photo saved" : "PHOTO MISSING OR CHANGED"}: ${prompt ?? it.requirement_id}`);
    }
    console.log(`photos in ${dir}`);
    const outcome = side === "pay" ? 0 : 1;
    const owner = outcome === 0 ? tail.scout : decoded.bounty.requester;
    build = (bh) => resolveMessage(keys, relayer.pubkey, arbiter.pubkey, outcome, owner,
      ata(owner), bh);
    plan = outcome === 0
      ? `resolve: pay ${reward} USDC to the Scout ${base58.encode(owner)}`
      : `resolve: refund ${reward} USDC to the requester ${base58.encode(owner)}`;
  }

  console.log(`plan: ${plan}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Type SEND to send: ")).trim();
  rl.close();
  if (answer !== "SEND") {
    console.log("Nothing sent.");
    return;
  }
  const tx = signedWire(build(await writer.getLatestBlockhash()), seeds);
  await writer.sendTransaction(tx.wire);
  console.log(`sent ${tx.signature}`);
  for (let i = 0; i < 30; i++) {
    const [status] = await writer.getSignatureStatuses([tx.signature]);
    if (status?.failed) throw new Error("the transaction failed on chain");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      console.log("confirmed");
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`explorer: ${explorer(tx.signature)}`);
  // The signature list can lag the account by a moment; project, then once more if needed.
  await new Promise((r) => setTimeout(r, 3000));
  await project();
}

try {
  await main();
} catch (error) {
  console.log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
