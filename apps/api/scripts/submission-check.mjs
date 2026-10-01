// POLICY.md section 18.10: checks one bounty's submission from the stored rows and the
// evidence store, for the live run. Run by hand from apps/api; not in the gate. Reads
// ~/bountycam-env/api.env itself. Prints no URL, key or coordinate.
//
//   node scripts/submission-check.mjs <bounty_id>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalise, evidenceRoot, evidenceStatement } from "@hackathon/shared";
import { loadEvidenceConfig } from "../src/config.ts";
import { objectPath, presignQuery } from "../src/evidence/sigv4.ts";
import { signingKey } from "../src/evidence/store.ts";

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const bountyId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bountyId ?? "")) {
  console.log("usage: node scripts/submission-check.mjs <bounty_id>");
  process.exit(2);
}
const env = readEnvFile(join(homedir(), "bountycam-env", "api.env"));
const evidence = loadEvidenceConfig(env);
if (evidence.store === null) {
  console.log("FAIL the evidence store is not configured in ~/bountycam-env/api.env");
  process.exit(1);
}
const cfg = evidence.store;
const key = signingKey(cfg);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
};

try {
  const r = await pool.query(
    `SELECT s.*, u.wallet_address, b.state AS bounty_state, a.status AS assignment_status,
            n.status AS nonce_status, n.value AS nonce_value
     FROM submissions s
     JOIN users u ON u.id = s.scout_id
     JOIN bounties b ON b.id = s.bounty_id
     JOIN assignments a ON a.id = s.assignment_id
     JOIN capture_nonces n ON n.id = s.capture_nonce_id
     WHERE s.bounty_id = $1`,
    [bountyId],
  );
  const sub = r.rows[0];
  check("C1 one submission for the bounty", r.rows.length === 1, `${r.rows.length} found`);
  if (sub === undefined) process.exit(1);
  const manifest = JSON.parse(sub.manifest);
  check("C2 the stored manifest is canonical", canonicalise(manifest) === sub.manifest);
  const root = evidenceRoot(manifest);
  check("C3 the root recomputes from the manifest",
    Buffer.from(root).equals(sub.evidence_root), Buffer.from(root).toString("hex"));
  check("C4 the header names the bounty, assignment, nonce and Scout",
    manifest.header.bounty_id === bountyId && manifest.header.assignment_id === sub.assignment_id &&
    manifest.header.capture_nonce === sub.nonce_value.toString("hex") &&
    manifest.header.scout === sub.wallet_address);
  const statement = evidenceStatement(bountyId, root);
  check("C5 the Scout's signature verifies over the statement",
    ed25519.verify(sub.statement_signature, statement, base58.decode(sub.wallet_address)));
  check("C6 the nonce is CONSUMED", sub.nonce_status === "CONSUMED", sub.nonce_status);
  check("C7 the bounty is still ACCEPTED and the assignment ACTIVE",
    sub.bounty_state === "ACCEPTED" && sub.assignment_status === "ACTIVE",
    `${sub.bounty_state}, ${sub.assignment_status}`);
  const items = (await pool.query(
    "SELECT storage_key, hash, byte_length FROM evidence_items WHERE submission_id = $1",
    [sub.id],
  )).rows;
  check("C8 one evidence row per manifest item", items.length === manifest.items.length,
    `${items.length} rows, ${manifest.items.length} items`);
  for (const [i, item] of items.entries()) {
    const path = objectPath(cfg.bucket, item.storage_key);
    const query = presignQuery({
      method: "GET", host: cfg.host, path, headers: {}, expiresS: 60, now: new Date(), key,
    });
    const res = await fetch(cfg.endpoint + path + "?" + query);
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest();
    check(`C9.${i + 1} photo ${i + 1} downloads with its recorded sha256 and length`,
      res.status === 200 && digest.equals(item.hash) && bytes.length === Number(item.byte_length),
      `status ${res.status}, ${bytes.length} bytes`);
  }
} finally {
  await pool.end();
}
const passed = results.filter(Boolean).length;
console.log(`SUBMISSION CHECK: ${passed} of ${results.length} passed`);
process.exitCode = passed === results.length ? 0 : 1;
