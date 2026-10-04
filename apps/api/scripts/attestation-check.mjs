// POLICY.md section 19.14: checks one bounty's attestation from the stored row and the
// chain, for the live run. Run by hand from apps/api; not in the gate. Reads
// ~/bountycam-env/api.env itself. Prints no URL, key or coordinate.
//
//   node scripts/attestation-check.mjs <bounty_id>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { attestationMessage } from "@hackathon/shared";
import { decodeBountyAccount, readSubmission } from "../src/chain/bounty.ts";
import { jsonRpcChainReader, jsonRpcChainWriter } from "../src/chain/rpc.ts";

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
  console.log("usage: node scripts/attestation-check.mjs <bounty_id>");
  process.exit(2);
}
const env = readEnvFile(join(homedir(), "bountycam-env", "api.env"));
const reader = jsonRpcChainReader(env.SOLANA_RPC_URL, fetch);
const writer = jsonRpcChainWriter(env.SOLANA_RPC_URL, fetch);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
};
const hex = (b) => Buffer.from(b).toString("hex");

try {
  const r = await pool.query(
    `SELECT a.*, s.evidence_root, s.achieved_assurance AS projected_assurance,
            s.attester_signature, b.program_account, b.state AS bounty_state
     FROM attestations a
     JOIN submissions s ON s.id = a.submission_id
     JOIN bounties b ON b.id = s.bounty_id
     WHERE s.bounty_id = $1`,
    [bountyId],
  );
  const row = r.rows[0];
  check("attestation row", row !== undefined);
  if (row === undefined) process.exit(1);
  console.log(`     status ${row.status}, grade ${row.achieved_assurance}, sends ${row.sends}` +
    `, tx ${row.tx_signature ?? "none"}`);
  check("row SUBMITTED", row.status === "SUBMITTED", row.status);
  check("bounty SUBMITTED", row.bounty_state === "SUBMITTED", row.bounty_state);

  const configInfo = await reader.getAccount(env.ESCROW_CONFIG_ACCOUNT);
  const attester = configInfo.data.slice(73, 105);
  const deploymentId = configInfo.data[8];
  console.log(`     attester ${base58.encode(attester)}, deployment ${deploymentId}`);

  const info = await reader.getAccount(row.program_account);
  const decoded = info === null ? null : decodeBountyAccount(info, env.ESCROW_PROGRAM_ID);
  const sub = info === null ? null : readSubmission(info);
  check("account Submitted", decoded?.ok === true && decoded.bounty.state === "Submitted",
    decoded?.ok ? decoded.bounty.state : "unreadable");
  if (decoded?.ok && sub?.ok) {
    check("chain root is the submission's", hex(sub.evidenceRoot) === hex(row.evidence_root));
    check("chain grade is the row's", sub.achievedAssurance === row.achieved_assurance,
      String(sub.achievedAssurance));
    const stored = Uint8Array.from(row.message);
    const rebuilt = attestationMessage({
      deploymentId,
      programId: base58.decode(env.ESCROW_PROGRAM_ID),
      bountyId: decoded.bounty.bountyId,
      requester: decoded.bounty.requester,
      scout: sub.scout,
      policyHash: decoded.bounty.policyHash,
      eligibilityProfileHash: decoded.bounty.eligibilityProfileHash,
      requiredAssurance: decoded.bounty.requiredAssurance,
      deadline: sub.deadline,
      reviewWindowSecs: decoded.bounty.reviewWindowSecs,
      evidenceRoot: Uint8Array.from(row.evidence_root),
      achievedAssurance: row.achieved_assurance,
      issuedAt: new DataView(stored.buffer, stored.byteOffset).getBigInt64(253, true),
    });
    check("message rebuilt from the account equals the stored one", hex(rebuilt) === hex(stored));
    check("signature verifies under the configuration's attester",
      ed25519.verify(Uint8Array.from(row.signature), stored, attester));
    check("submission carries the grade and the signature",
      row.projected_assurance === row.achieved_assurance &&
        hex(row.attester_signature ?? []) === hex(row.signature));
  }
  if (row.tx_signature) {
    const [status] = await writer.getSignatureStatuses([row.tx_signature]);
    check("transaction confirmed", status !== null && !status.failed &&
      (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"),
      status === null ? "unknown" : String(status.confirmationStatus));
  } else {
    check("transaction confirmed", false, "no transaction recorded");
  }
} finally {
  await pool.end();
}
const passed = results.filter(Boolean).length;
console.log(`${passed} of ${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
