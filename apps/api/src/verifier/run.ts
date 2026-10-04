// POLICY.md sections 19.5 to 19.12 (D148 to D153): the verifier's loop. One tick
// enqueues new submissions and runs every due job. A PENDING job is checked, graded
// and signed, then sent; a SIGNED job reads the chain and sends its stored bytes again.
// Photos are read back here, never in the API process (D147).
import type { Pool } from "pg";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  attestationMessage,
  canonicalise,
  checkCaptureStart,
  checkEvidenceManifest,
  evidenceRoot,
  evidenceStatement,
  sha256,
} from "@hackathon/shared";
import {
  decodeBountyAccount,
  readAcceptance,
  readSubmission,
  type DecodedBounty,
} from "../chain/bounty.ts";
import { bytesEqual } from "../chain/config.ts";
import type { ChainReader, ChainWriter } from "../chain/rpc.ts";
import { attestationTransaction } from "../chain/tx.ts";
import type { Clock } from "../clock.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import { bindingsAgree } from "../funding/project.ts";

export type RefusalCode =
  | "CHAIN_STATE"
  | "BINDING_MISMATCH"
  | "PARTY_MISMATCH"
  | "SUBMISSION_INVALID"
  | "REQUIREMENTS_INCOMPLETE"
  | "EVIDENCE_MISSING";

const ERROR_LEVEL: ReadonlySet<string> = new Set([
  "CHAIN_STATE",
  "BINDING_MISMATCH",
  "PARTY_MISMATCH",
  "SUBMISSION_INVALID",
  "EVIDENCE_MISSING",
]);

export interface VerifierDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly chain: ChainReader;
  readonly writer: ChainWriter;
  readonly store: Pick<EvidenceStore, "get">;
  readonly programId: string;
  readonly programIdBytes: Uint8Array;
  readonly configAccount: string;
  readonly deploymentId: number;
  readonly attesterSeed: Uint8Array;
  readonly attesterPubkey: Uint8Array;
  readonly relayerSeed: Uint8Array;
  readonly maxBytes: number;
  readonly maxAccuracyM: number;
  readonly deadlineMarginS: number;
  readonly confirmS: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (level: "info" | "error", fields: Record<string, unknown>) => void;
}

/** Section 19.5's backoff, by consecutive transient failures. */
const BACKOFF_S = [5, 10, 20, 40, 60];
const STATUS_POLL_MS = 2000;

interface JobRow {
  submission_id: string;
  status: "PENDING" | "SIGNED";
  achieved_assurance: number | null;
  message: Buffer | null;
  signature: Buffer | null;
  tries: number;
}

interface Context {
  submissionId: string;
  bountyId: string;
  assignmentId: string;
  captureNonceId: string;
  manifest: string;
  evidenceRoot: Buffer;
  statementSignature: Buffer;
  deadline: Date;
  programAccount: string | null;
  canonicalJson: string;
  policyHash: Buffer;
  requesterWallet: string;
  scoutWallet: string;
  scoutId: string;
}

interface ItemRow {
  requirement_id: string;
  storage_key: string;
  hash: Buffer;
  captured_at: Date;
  byte_length: string | number;
  lat: string;
  lon: string;
  horizontal_accuracy_m: number;
  fixed_at: Date;
}

interface NonceRow {
  id: string;
  assignment_id: string;
  bounty_id: string;
  scout_id: string;
  deployment_id: number;
  value: Buffer;
  status: string;
  issued_at: Date;
  expires_at: Date;
}

class Retry extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
class Refuse extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.code = code;
  }
}
class Lapse extends Error {}

// --- writes, one per outcome ---

async function writeOutcome(
  deps: VerifierDeps,
  id: string,
  sql: string,
  params: unknown[],
  line: Record<string, unknown>,
): Promise<void> {
  await deps.pool.query(sql, [id, deps.clock.now(), ...params]);
  const level = typeof line["reason"] === "string" && ERROR_LEVEL.has(line["reason"])
    ? "error"
    : "info";
  deps.log(level, { submission: id, ...line });
}

const refuse = (deps: VerifierDeps, id: string, code: RefusalCode) =>
  writeOutcome(deps, id,
    `UPDATE attestations SET status = 'REFUSED', reason = $3, updated_at = $2
     WHERE submission_id = $1`, [code], { status: "REFUSED", reason: code });

const lapse = (deps: VerifierDeps, id: string) =>
  writeOutcome(deps, id,
    `UPDATE attestations SET status = 'LAPSED', reason = 'DEADLINE', updated_at = $2
     WHERE submission_id = $1`, [], { status: "LAPSED", reason: "DEADLINE" });

async function retry(deps: VerifierDeps, row: JobRow, reason: string): Promise<void> {
  const tries = row.tries + 1;
  const delayS = BACKOFF_S[Math.min(tries, BACKOFF_S.length) - 1] as number;
  const next = new Date(deps.clock.now().getTime() + delayS * 1000);
  await writeOutcome(deps, row.submission_id,
    `UPDATE attestations SET tries = $3, next_attempt_at = $4, updated_at = $2
     WHERE submission_id = $1`, [tries, next], { status: row.status, retry: reason });
}

// --- loading ---

async function loadContext(pool: Pool, submissionId: string): Promise<Context> {
  const r = await pool.query(
    `SELECT s.id, s.bounty_id, s.assignment_id, s.capture_nonce_id, s.manifest,
            s.evidence_root, s.statement_signature, s.scout_id, a.deadline,
            b.program_account, p.canonical_json, p.policy_hash,
            ru.wallet_address AS requester_wallet, su.wallet_address AS scout_wallet
     FROM submissions s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN bounties b ON b.id = s.bounty_id
     JOIN policies p ON p.id = b.policy_id
     JOIN users ru ON ru.id = b.requester_id
     JOIN users su ON su.id = s.scout_id
     WHERE s.id = $1`,
    [submissionId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("submission row missing for an attestation job");
  return {
    submissionId: row.id,
    bountyId: row.bounty_id,
    assignmentId: row.assignment_id,
    captureNonceId: row.capture_nonce_id,
    manifest: row.manifest,
    evidenceRoot: row.evidence_root,
    statementSignature: row.statement_signature,
    deadline: row.deadline,
    programAccount: row.program_account,
    canonicalJson: row.canonical_json,
    policyHash: row.policy_hash,
    requesterWallet: row.requester_wallet,
    scoutWallet: row.scout_wallet,
    scoutId: row.scout_id,
  };
}

// --- section 19.6 steps 2 and 3 ---

function pastMargin(deps: VerifierDeps, ctx: Context): boolean {
  return deps.clock.now().getTime() > ctx.deadline.getTime() - deps.deadlineMarginS * 1000;
}

type ChainRead =
  | { kind: "ACCEPTED"; bounty: DecodedBounty; scout: Uint8Array; deadline: bigint }
  | { kind: "SUBMITTED"; root: Uint8Array; achieved: number }
  | { kind: "OTHER" };

async function readChain(deps: VerifierDeps, ctx: Context): Promise<ChainRead> {
  if (ctx.programAccount === null) return { kind: "OTHER" };
  let info;
  try {
    info = await deps.chain.getAccount(ctx.programAccount);
  } catch {
    throw new Retry("RPC");
  }
  if (info === null) return { kind: "OTHER" };
  const decoded = decodeBountyAccount(info, deps.programId);
  if (!decoded.ok) return { kind: "OTHER" };
  if (decoded.bounty.state === "Accepted") {
    const a = readAcceptance(info);
    if (!a.ok) return { kind: "OTHER" };
    return { kind: "ACCEPTED", bounty: decoded.bounty, scout: a.scout, deadline: a.deadline };
  }
  if (decoded.bounty.state === "Submitted") {
    const s = readSubmission(info);
    if (!s.ok) return { kind: "OTHER" };
    return { kind: "SUBMITTED", root: s.evidenceRoot, achieved: s.achievedAssurance };
  }
  return { kind: "OTHER" };
}

// --- section 19.6 steps 4 to 8 and 19.7, for a PENDING job ---

/** Step 6, exported for test 2: the stored submission re-checked against its rows. */
export function checkSubmission(
  ctx: Pick<Context, "bountyId" | "assignmentId" | "manifest" | "evidenceRoot" |
    "statementSignature" | "scoutWallet" | "policyHash">,
  deploymentId: number,
  items: readonly ItemRow[],
): boolean {
  try {
    const checked = checkEvidenceManifest(JSON.parse(ctx.manifest));
    if (canonicalise(checked) !== ctx.manifest) return false;
    const root = evidenceRoot(checked);
    if (!bytesEqual(root, ctx.evidenceRoot)) return false;
    const h = checked.header;
    if (h.bounty_id !== ctx.bountyId || h.assignment_id !== ctx.assignmentId ||
      h.scout !== ctx.scoutWallet || h.policy_hash !== ctx.policyHash.toString("hex") ||
      h.deployment_id !== deploymentId) {
      return false;
    }
    const statement = evidenceStatement(ctx.bountyId, root);
    if (!ed25519.verify(ctx.statementSignature, statement, base58.decode(ctx.scoutWallet))) {
      return false;
    }
    if (items.length !== checked.items.length) return false;
    const byId = new Map(items.map((r) => [r.requirement_id, r]));
    return checked.items.every((it) => {
      const r = byId.get(it.requirement_id);
      return r !== undefined &&
        r.hash.toString("hex") === it.photo_sha256 &&
        Number(r.byte_length) === it.byte_length &&
        r.captured_at.toISOString() === it.captured_at &&
        r.lat === it.lat && r.lon === it.lon &&
        Number(r.horizontal_accuracy_m) === it.horizontal_accuracy_m &&
        r.fixed_at.toISOString() === it.fixed_at;
    });
  } catch {
    return false;
  }
}

interface StoredPolicy {
  lat: string;
  lon: string;
  capture_radius_m: number;
  evidence_requirements: { id: string; required: boolean }[];
}

async function evaluate(
  deps: VerifierDeps,
  ctx: Context,
  chain: Extract<ChainRead, { kind: "ACCEPTED" }>,
): Promise<number> {
  // Step 4.
  let policy: StoredPolicy;
  try {
    policy = JSON.parse(ctx.canonicalJson) as StoredPolicy;
    const hashOk = bytesEqual(sha256(new TextEncoder().encode(ctx.canonicalJson)), ctx.policyHash);
    const agree = bindingsAgree({
      id: ctx.bountyId,
      state: "ACCEPTED",
      program_account: ctx.programAccount,
      wallet_address: ctx.requesterWallet,
      canonical_json: ctx.canonicalJson,
      policy_hash: ctx.policyHash,
    }, chain.bounty);
    if (!hashOk || !agree) throw new Refuse("BINDING_MISMATCH");
  } catch (error) {
    if (error instanceof Refuse) throw error;
    throw new Refuse("BINDING_MISMATCH");
  }
  // Step 5.
  if (!bytesEqual(chain.scout, base58.decode(ctx.scoutWallet)) ||
    chain.deadline !== BigInt(Math.floor(ctx.deadline.getTime() / 1000))) {
    throw new Refuse("PARTY_MISMATCH");
  }
  // Step 6.
  const items = (await deps.pool.query<ItemRow>(
    `SELECT requirement_id, storage_key, hash, captured_at, byte_length, lat, lon,
            horizontal_accuracy_m, fixed_at
     FROM evidence_items WHERE submission_id = $1`,
    [ctx.submissionId],
  )).rows;
  if (!checkSubmission(ctx, deps.deploymentId, items)) throw new Refuse("SUBMISSION_INVALID");
  const manifest = checkEvidenceManifest(JSON.parse(ctx.manifest));
  // Step 7.
  const requirements = policy.evidence_requirements;
  const position = new Map(requirements.map((r, i) => [r.id, i]));
  const order = manifest.items.map((it) => position.get(it.requirement_id));
  const present = new Set(manifest.items.map((it) => it.requirement_id));
  if (order.some((p, i) => p === undefined || (i > 0 && p <= (order[i - 1] as number))) ||
    requirements.some((r) => r.required && !present.has(r.id))) {
    throw new Refuse("REQUIREMENTS_INCOMPLETE");
  }
  // Step 8.
  const byId = new Map(items.map((r) => [r.requirement_id, r]));
  for (const it of manifest.items) {
    const r = byId.get(it.requirement_id) as ItemRow;
    let bytes: Uint8Array | null;
    try {
      bytes = await deps.store.get(r.storage_key, deps.maxBytes);
    } catch {
      throw new Retry("STORE");
    }
    if (bytes === null || bytes.length !== it.byte_length ||
      Buffer.from(sha256(bytes)).toString("hex") !== it.photo_sha256) {
      throw new Refuse("EVIDENCE_MISSING");
    }
  }
  // Section 19.7.
  const n = (await deps.pool.query<NonceRow>(
    "SELECT * FROM capture_nonces WHERE id = $1",
    [ctx.captureNonceId],
  )).rows[0];
  const nonceOk = n !== undefined && n.status === "CONSUMED" &&
    n.value.toString("hex") === manifest.header.capture_nonce &&
    n.assignment_id === ctx.assignmentId && n.bounty_id === ctx.bountyId &&
    n.scout_id === ctx.scoutId && n.deployment_id === deps.deploymentId;
  const inSession = n !== undefined && manifest.items.every((it) => {
    const t = Date.parse(it.captured_at);
    return t >= n.issued_at.getTime() && t < n.expires_at.getTime();
  });
  const placed = manifest.items.every((it) =>
    checkCaptureStart(
      { lat: Number(it.lat), lon: Number(it.lon), accuracyM: it.horizontal_accuracy_m },
      { lat: policy.lat, lon: policy.lon },
      policy.capture_radius_m,
      deps.maxAccuracyM,
    ).decision === "PASS");
  return nonceOk && inSession && placed ? 1 : 0;
}

// --- section 19.8 ---

async function sign(
  deps: VerifierDeps,
  ctx: Context,
  chain: Extract<ChainRead, { kind: "ACCEPTED" }>,
  grade: number,
): Promise<JobRow> {
  const now = deps.clock.now();
  const message = attestationMessage({
    deploymentId: deps.deploymentId,
    programId: deps.programIdBytes,
    bountyId: chain.bounty.bountyId,
    requester: chain.bounty.requester,
    scout: chain.scout,
    policyHash: chain.bounty.policyHash,
    eligibilityProfileHash: chain.bounty.eligibilityProfileHash,
    requiredAssurance: chain.bounty.requiredAssurance,
    deadline: chain.deadline,
    reviewWindowSecs: chain.bounty.reviewWindowSecs,
    evidenceRoot: Uint8Array.from(ctx.evidenceRoot),
    achievedAssurance: grade,
    issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
  });
  const signature = ed25519.sign(message, deps.attesterSeed);
  if (!ed25519.verify(signature, message, deps.attesterPubkey)) {
    throw new Error("the attester signature does not verify under the attester key");
  }
  await writeOutcome(deps, ctx.submissionId,
    `UPDATE attestations SET status = 'SIGNED', achieved_assurance = $3, message = $4,
       signature = $5, tries = 0, next_attempt_at = $2, updated_at = $2
     WHERE submission_id = $1`,
    [grade, Buffer.from(message), Buffer.from(signature)],
    { status: "SIGNED", achieved: grade });
  return {
    submission_id: ctx.submissionId,
    status: "SIGNED",
    achieved_assurance: grade,
    message: Buffer.from(message),
    signature: Buffer.from(signature),
    tries: 0,
  };
}

// --- section 19.10 ---

async function project(
  deps: VerifierDeps,
  row: JobRow,
  ctx: Context,
  chain: ChainRead,
): Promise<void> {
  const ours = chain.kind === "SUBMITTED" && bytesEqual(chain.root, ctx.evidenceRoot);
  if (!ours) {
    if (chain.kind === "ACCEPTED") throw new Retry("NOT_YET_SUBMITTED");
    throw new Refuse("CHAIN_STATE");
  }
  if (chain.achieved !== row.achieved_assurance) throw new Retry("GRADE_DIFFERS");
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const b = await client.query<{ state: string }>(
      "SELECT state FROM bounties WHERE id = $1 FOR UPDATE",
      [ctx.bountyId],
    );
    const state = b.rows[0]?.state;
    if (state === "ACCEPTED") {
      await client.query("UPDATE bounties SET state = 'SUBMITTED' WHERE id = $1", [ctx.bountyId]);
    } else if (state !== "SUBMITTED") {
      await client.query("ROLLBACK");
      throw new Refuse("CHAIN_STATE");
    }
    await client.query(
      "UPDATE submissions SET achieved_assurance = $2, attester_signature = $3 WHERE id = $1",
      [ctx.submissionId, row.achieved_assurance, row.signature],
    );
    await client.query(
      `UPDATE attestations SET status = 'SUBMITTED', tries = 0, updated_at = $2
       WHERE submission_id = $1`,
      [ctx.submissionId, deps.clock.now()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const tx = await deps.pool.query<{ tx_signature: string }>(
    "SELECT tx_signature FROM attestations WHERE submission_id = $1",
    [ctx.submissionId],
  );
  deps.log("info", { submission: ctx.submissionId, status: "SUBMITTED",
    tx: tx.rows[0]?.tx_signature });
}

// --- section 19.9 ---

async function send(deps: VerifierDeps, row: JobRow, ctx: Context): Promise<void> {
  if (pastMargin(deps, ctx)) throw new Lapse();
  let confirmed = false;
  try {
    const blockhash = await deps.writer.getLatestBlockhash();
    const tx = attestationTransaction({
      relayerSeed: deps.relayerSeed,
      bountyAccount: base58.decode(ctx.programAccount as string),
      configAccount: base58.decode(deps.configAccount),
      programId: deps.programIdBytes,
      attesterPubkey: deps.attesterPubkey,
      message: Uint8Array.from(row.message as Buffer),
      signature: Uint8Array.from(row.signature as Buffer),
      blockhash,
    });
    await deps.pool.query(
      `UPDATE attestations SET sends = sends + 1, tx_signature = $2, updated_at = $3
       WHERE submission_id = $1`,
      [ctx.submissionId, tx.signature, deps.clock.now()],
    );
    await deps.writer.sendTransaction(tx.wire);
    const until = deps.clock.now().getTime() + deps.confirmS * 1000;
    while (deps.clock.now().getTime() < until) {
      const [status] = await deps.writer.getSignatureStatuses([tx.signature]);
      if (status !== null && status !== undefined) {
        if (status.failed) break;
        if (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized") {
          confirmed = true;
          break;
        }
      }
      await deps.sleep(STATUS_POLL_MS);
    }
  } catch {
    confirmed = false;
  }
  const chain = await readChain(deps, ctx);
  if (!confirmed && chain.kind === "ACCEPTED") throw new Retry("NOT_CONFIRMED");
  await project(deps, row, ctx, chain);
}

// --- one job, one tick ---

async function runJob(deps: VerifierDeps, job: JobRow): Promise<void> {
  const ctx = await loadContext(deps.pool, job.submission_id);
  try {
    if (pastMargin(deps, ctx)) throw new Lapse(); // step 2
    const chain = await readChain(deps, ctx); // step 3
    if (job.status === "SIGNED") {
      if (chain.kind === "SUBMITTED") return await project(deps, job, ctx, chain);
      if (chain.kind !== "ACCEPTED") throw new Refuse("CHAIN_STATE");
      return await send(deps, job, ctx);
    }
    if (chain.kind !== "ACCEPTED") throw new Refuse("CHAIN_STATE");
    const grade = await evaluate(deps, ctx, chain);
    if (grade < chain.bounty.requiredAssurance) {
      await writeOutcome(deps, ctx.submissionId,
        `UPDATE attestations SET status = 'SHORTFALL', achieved_assurance = $3,
           updated_at = $2 WHERE submission_id = $1`,
        [grade], { status: "SHORTFALL", achieved: grade });
      return;
    }
    const signed = await sign(deps, ctx, chain, grade);
    await send(deps, signed, ctx);
  } catch (error) {
    // A retry after signing carries the signed row's state, not the PENDING one read.
    const current = (await deps.pool.query<JobRow>(
      `SELECT submission_id, status, achieved_assurance, message, signature, tries
       FROM attestations WHERE submission_id = $1`,
      [job.submission_id],
    )).rows[0] as JobRow;
    if (error instanceof Lapse) return lapse(deps, job.submission_id);
    if (error instanceof Refuse) return refuse(deps, job.submission_id, error.code);
    if (error instanceof Retry) return retry(deps, current, error.reason);
    throw error;
  }
}

/** Section 19.5: enqueue, select, run. */
export async function tick(deps: VerifierDeps): Promise<void> {
  const now = deps.clock.now();
  await deps.pool.query(
    `INSERT INTO attestations
       (submission_id, status, tries, sends, next_attempt_at, created_at, updated_at)
     SELECT s.id, 'PENDING', 0, 0, $1, $1, $1 FROM submissions s
     WHERE NOT EXISTS (SELECT 1 FROM attestations a WHERE a.submission_id = s.id)
     ON CONFLICT (submission_id) DO NOTHING`,
    [now],
  );
  const due = await deps.pool.query<JobRow>(
    `SELECT submission_id, status, achieved_assurance, message, signature, tries
     FROM attestations
     WHERE status IN ('PENDING', 'SIGNED') AND next_attempt_at <= $1
     ORDER BY created_at, submission_id`,
    [now],
  );
  for (const job of due.rows) await runJob(deps, job);
}
