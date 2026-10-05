// POLICY.md sections 18.5 and 18.6 (D138 to D143): the upload URL and the submission.
// Registered only when the chain dependencies exist, for deployment_id, and the evidence
// store is configured. Neither route logs its body: the submission carries every photo's
// coordinates, and an upload URL is a bearer credential for one object (SECURITY.md 3).
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SpecError,
  canonicalise,
  checkCaptureStart,
  checkEvidenceManifest,
  evidenceRoot,
  evidenceStatement,
  type EvidenceManifest,
} from "@hackathon/shared";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import type { Clock } from "../clock.ts";
import type { Config, EvidenceConfig } from "../config.ts";
import { consumeCaptureNonce } from "../capture/nonce.ts";
import { objectKey, type EvidenceStore } from "./store.ts";

export interface EvidenceRouteDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  deploymentId: number;
  store: EvidenceStore;
}

interface PolicyRequirement {
  id: string;
  required: boolean;
}

interface LoadedPolicy {
  lat: string;
  lon: string;
  capture_radius_m: number;
  evidence_requirements: PolicyRequirement[];
}

interface Loaded {
  state: string;
  requesterId: string;
  policy: LoadedPolicy;
  policyHashHex: string;
}

interface Holder {
  id: string;
}

interface SubmissionRow {
  id: string;
  submitted_at: Date;
  evidence_root: Buffer;
  statement_signature: Buffer;
  item_count: number;
  /** POLICY.md 19.11: CHECKING, VERIFIED or NOT_VERIFIED. */
  verification: string;
  /** POLICY.md 20.2: set by the settlement projection. */
  review_ends_at: Date | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function loadBounty(pool: Pool, id: string): Promise<Loaded | null> {
  const r = await pool.query<{
    state: string;
    requester_id: string;
    canonical_json: string;
    policy_hash: Buffer;
  }>(
    `SELECT b.state, b.requester_id, p.canonical_json, p.policy_hash FROM bounties b
     JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    state: row.state,
    requesterId: row.requester_id,
    policy: JSON.parse(row.canonical_json) as LoadedPolicy,
    policyHashHex: row.policy_hash.toString("hex"),
  };
}

/** Section 17.6 step 8's holder: an ACTIVE, accepted assignment of the caller's. */
async function loadHolder(
  db: Pool | PoolClient,
  bountyId: string,
  callerId: string,
  lock = false,
): Promise<Holder | null> {
  const r = await db.query<Holder>(
    `SELECT id FROM assignments WHERE bounty_id = $1 AND scout_id = $2
     AND status = 'ACTIVE' AND accepted_at IS NOT NULL${lock ? " FOR UPDATE" : ""}`,
    [bountyId, callerId],
  );
  return r.rows[0] ?? null;
}

async function loadSubmission(
  db: Pool | PoolClient,
  assignmentId: string,
): Promise<SubmissionRow | null> {
  const r = await db.query<SubmissionRow>(
    `SELECT s.id, s.submitted_at, s.evidence_root, s.statement_signature, s.review_ends_at,
            (SELECT count(*)::int FROM evidence_items e WHERE e.submission_id = s.id)
              AS item_count,
            CASE
              WHEN a.status = 'SUBMITTED' OR b.state IN
                ('SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'DISPUTED', 'PAID')
                THEN 'VERIFIED'
              WHEN a.status IN ('REFUSED', 'SHORTFALL', 'LAPSED') THEN 'NOT_VERIFIED'
              ELSE 'CHECKING'
            END AS verification
     FROM submissions s
     JOIN bounties b ON b.id = s.bounty_id
     LEFT JOIN attestations a ON a.submission_id = s.id
     WHERE s.assignment_id = $1`,
    [assignmentId],
  );
  return r.rows[0] ?? null;
}

/** Section 18.6 step 17's body. */
function submissionBody(row: SubmissionRow): Record<string, unknown> {
  return {
    submission: {
      id: row.id,
      submitted_at: row.submitted_at.toISOString(),
      evidence_root: row.evidence_root.toString("hex"),
      item_count: row.item_count,
      verification: row.verification,
    },
  };
}

function sameSubmission(row: SubmissionRow, root: Uint8Array, signature: Buffer): boolean {
  return row.evidence_root.equals(Buffer.from(root)) && row.statement_signature.equals(signature);
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: EvidenceRouteDeps): void {
  const { pool, config, clock, deploymentId, store } = deps;
  const evidence = config.evidence as EvidenceConfig;
  const capture = config.capture;
  const requireAuth = makeRequireAuth(config, clock);

  // --- section 18.5 ---
  app.post<{ Params: { id: string } }>(
    "/bounties/:id/evidence/upload-url",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      // Step 2.
      const body = request.body;
      if (!isPlainObject(body) ||
        !exactKeys(body, ["byte_length", "capture_session_id", "photo_sha256", "requirement_id"])) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      const sessionId = body["capture_session_id"];
      const requirementId = body["requirement_id"];
      const digest = body["photo_sha256"];
      const byteLength = body["byte_length"];
      if (typeof sessionId !== "string" || !LOWER_UUID.test(sessionId) ||
        typeof requirementId !== "string" || !LOWER_UUID.test(requirementId) ||
        typeof digest !== "string" || !HEX64.test(digest) ||
        typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      // Step 3.
      if (byteLength > evidence.maxBytes) return fail(reply, 400, "EVIDENCE_TOO_LARGE");
      // Step 4.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      const bounty = await loadBounty(pool, id);
      if (bounty === null) return fail(reply, 404, "NOT_FOUND");
      // Step 6.
      if (bounty.requesterId !== caller.id &&
        (bounty.state === "DRAFT" || bounty.state === "CANCELLED")) {
        return fail(reply, 404, "NOT_FOUND");
      }
      // Step 7.
      if (bounty.state !== "ACCEPTED") return fail(reply, 409, "BOUNTY_NOT_CAPTURABLE");
      // Step 8.
      const holder = await loadHolder(pool, id, caller.id);
      if (holder === null) return fail(reply, 403, "NOT_ASSIGNED");
      // Step 9.
      if ((await loadSubmission(pool, holder.id)) !== null) {
        return fail(reply, 409, "ALREADY_SUBMITTED");
      }
      // Step 10.
      if (!bounty.policy.evidence_requirements.some((r) => r.id === requirementId)) {
        return fail(reply, 400, "UNKNOWN_REQUIREMENT");
      }
      // Step 11.
      const now = clock.now();
      const session = await pool.query<{ expires_at: Date }>(
        `SELECT expires_at FROM capture_nonces
         WHERE id = $1 AND assignment_id = $2 AND status = 'ACTIVE'`,
        [sessionId, holder.id],
      );
      const live = session.rows[0];
      if (live === undefined ||
        now.getTime() >= live.expires_at.getTime() + capture.submissionGraceS * 1000) {
        return fail(reply, 409, "CAPTURE_SESSION_NOT_LIVE");
      }
      // Step 12.
      const put = store.presignPut(
        objectKey(id, sessionId, requirementId, digest),
        Buffer.from(digest, "hex"),
        byteLength,
        now,
      );
      return reply.status(200).send({
        upload: {
          method: "PUT",
          url: put.url,
          headers: put.headers,
          expires_at: put.expiresAt.toISOString(),
        },
      });
    },
  );

  // --- section 18.6 ---
  app.post<{ Params: { id: string } }>(
    "/bounties/:id/submission",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      // Step 2.
      const body = request.body;
      if (!isPlainObject(body) || !exactKeys(body, ["manifest", "signature"]) ||
        !isPlainObject(body["manifest"]) ||
        typeof body["signature"] !== "string" || !HEX128.test(body["signature"])) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      const signature = Buffer.from(body["signature"], "hex");
      // Step 3.
      let manifest: EvidenceManifest;
      let root: Uint8Array;
      try {
        manifest = checkEvidenceManifest(body["manifest"]);
        root = evidenceRoot(manifest);
      } catch (error) {
        if (error instanceof SpecError) return fail(reply, 400, "INVALID_MANIFEST");
        throw error;
      }
      // Step 4.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      const bounty = await loadBounty(pool, id);
      if (bounty === null) return fail(reply, 404, "NOT_FOUND");
      // Step 6.
      if (bounty.requesterId !== caller.id &&
        (bounty.state === "DRAFT" || bounty.state === "CANCELLED")) {
        return fail(reply, 404, "NOT_FOUND");
      }
      // Step 7.
      if (bounty.state !== "ACCEPTED") return fail(reply, 409, "BOUNTY_NOT_CAPTURABLE");
      // Step 8.
      const holder = await loadHolder(pool, id, caller.id);
      if (holder === null) return fail(reply, 403, "NOT_ASSIGNED");
      // Step 9: an identical resend is the same submission (D142).
      const existing = await loadSubmission(pool, holder.id);
      if (existing !== null) {
        if (sameSubmission(existing, root, signature)) {
          return reply.status(200).send(submissionBody(existing));
        }
        return fail(reply, 409, "ALREADY_SUBMITTED");
      }
      // Step 10.
      const header = manifest.header;
      if (header.bounty_id !== id || header.assignment_id !== holder.id ||
        header.scout !== caller.wallet || header.policy_hash !== bounty.policyHashHex ||
        header.deployment_id !== deploymentId) {
        return fail(reply, 400, "MANIFEST_MISMATCH");
      }
      // Step 11.
      const requirements = bounty.policy.evidence_requirements;
      const position = new Map(requirements.map((r, i) => [r.id, i]));
      if (manifest.items.some((item) => !position.has(item.requirement_id))) {
        return fail(reply, 400, "UNKNOWN_REQUIREMENT");
      }
      const order = manifest.items.map((item) => position.get(item.requirement_id) as number);
      if (order.some((p, i) => i > 0 && p <= (order[i - 1] as number))) {
        return fail(reply, 400, "MANIFEST_MISMATCH");
      }
      const present = new Set(manifest.items.map((item) => item.requirement_id));
      if (requirements.some((r) => r.required && !present.has(r.id))) {
        return fail(reply, 400, "REQUIREMENTS_INCOMPLETE");
      }
      if (manifest.items.some((item) => item.byte_length > evidence.maxBytes)) {
        return fail(reply, 400, "EVIDENCE_TOO_LARGE");
      }
      // Step 12.
      const statement = evidenceStatement(id, root);
      if (!ed25519.verify(signature, statement, base58.decode(caller.wallet))) {
        return fail(reply, 400, "SUBMISSION_SIGNATURE_INVALID");
      }
      // Step 13.
      const nonceValue = Buffer.from(header.capture_nonce, "hex");
      const nonce = await pool.query<{ id: string; issued_at: Date; expires_at: Date }>(
        `SELECT id, issued_at, expires_at FROM capture_nonces
         WHERE value = $1 AND assignment_id = $2`,
        [nonceValue, holder.id],
      );
      const session = nonce.rows[0];
      if (session === undefined) return fail(reply, 409, "CAPTURE_NONCE_INVALID");
      // Step 14.
      const issuedMs = session.issued_at.getTime();
      const expiresMs = session.expires_at.getTime();
      for (const item of manifest.items) {
        const at = Date.parse(item.captured_at);
        if (at < issuedMs || at >= expiresMs) return fail(reply, 400, "CAPTURED_OUTSIDE_SESSION");
      }
      for (const item of manifest.items) {
        const gate = checkCaptureStart(
          { lat: Number(item.lat), lon: Number(item.lon), accuracyM: item.horizontal_accuracy_m },
          { lat: bounty.policy.lat, lon: bounty.policy.lon },
          bounty.policy.capture_radius_m,
          capture.maxLocationAccuracyM,
        );
        if (gate.decision === "IMPRECISE") return fail(reply, 400, "LOCATION_TOO_IMPRECISE");
        if (gate.decision === "TOO_FAR") return fail(reply, 400, "LOCATION_TOO_FAR");
      }
      // Step 15.
      const keys = manifest.items.map((item) =>
        objectKey(id, session.id, item.requirement_id, item.photo_sha256));
      for (const [i, item] of manifest.items.entries()) {
        let stored;
        try {
          stored = await store.head(keys[i] as string);
        } catch {
          return fail(reply, 503, "STORAGE_UNAVAILABLE");
        }
        if (stored === null || stored.byteLength !== item.byte_length ||
          stored.sha256Base64 !== Buffer.from(item.photo_sha256, "hex").toString("base64")) {
          return fail(reply, 409, "EVIDENCE_NOT_UPLOADED");
        }
      }
      // Step 16.
      const now = clock.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // 16.1: the projection's lock order, then re-check steps 7, 8 and 9.
        const state = await client.query<{ state: string }>(
          "SELECT state FROM bounties WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (state.rows[0]?.state !== "ACCEPTED") {
          await client.query("ROLLBACK");
          return fail(reply, 409, "BOUNTY_NOT_CAPTURABLE");
        }
        if ((await loadHolder(client, id, caller.id, true))?.id !== holder.id) {
          await client.query("ROLLBACK");
          return fail(reply, 403, "NOT_ASSIGNED");
        }
        const raced = await loadSubmission(client, holder.id);
        if (raced !== null) {
          await client.query("ROLLBACK");
          if (sameSubmission(raced, root, signature)) {
            return reply.status(200).send(submissionBody(raced));
          }
          return fail(reply, 409, "ALREADY_SUBMITTED");
        }
        // 16.2.
        const outcome = await consumeCaptureNonce(
          client,
          {
            value: nonceValue,
            bountyId: id,
            assignmentId: holder.id,
            scoutId: caller.id,
            deploymentId,
          },
          now,
          capture.submissionGraceS,
        );
        if (outcome === "EXPIRED") {
          await client.query("COMMIT");
          return fail(reply, 409, "CAPTURE_SESSION_EXPIRED");
        }
        if (outcome !== "CONSUMED") {
          await client.query("ROLLBACK");
          if (outcome === "SUPERSEDED") return fail(reply, 409, "CAPTURE_SESSION_SUPERSEDED");
          if (outcome === "ALREADY_CONSUMED") return fail(reply, 409, "CAPTURE_SESSION_USED");
          return fail(reply, 409, "CAPTURE_NONCE_INVALID");
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO submissions (assignment_id, bounty_id, scout_id, capture_nonce_id,
             manifest, evidence_root, statement_signature, achieved_assurance,
             attester_signature, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8) RETURNING id`,
          [holder.id, id, caller.id, session.id, canonicalise(manifest), Buffer.from(root),
            signature, now],
        );
        const submissionId = inserted.rows[0]?.id;
        if (submissionId === undefined) throw new Error("submissions insert returned no row");
        for (const [i, item] of manifest.items.entries()) {
          await client.query(
            `INSERT INTO evidence_items (submission_id, requirement_id, storage_key, hash,
               c2pa_present, captured_at, byte_length, lat, lon, horizontal_accuracy_m, fixed_at)
             VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, $9, $10)`,
            [submissionId, item.requirement_id, keys[i], Buffer.from(item.photo_sha256, "hex"),
              new Date(item.captured_at), item.byte_length, item.lat, item.lon,
              item.horizontal_accuracy_m, new Date(item.fixed_at)],
          );
        }
        await client.query("COMMIT");
        // Step 17.
        return reply.status(201).send(submissionBody({
          verification: "CHECKING",
          review_ends_at: null,
          id: submissionId,
          submitted_at: now,
          evidence_root: Buffer.from(root),
          statement_signature: signature,
          item_count: manifest.items.length,
        }));
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );
}

/** Section 18.7: the assigned-Scout view's `submission`. */
export async function scoutSubmission(
  pool: Pool,
  assignmentId: string,
): Promise<Record<string, unknown> | null> {
  const row = await loadSubmission(pool, assignmentId);
  return row === null ? null : (submissionBody(row)["submission"] as Record<string, unknown>);
}

/** Sections 18.7 and 19.11: the owner view's `submission`; three keys only. */
export async function ownerSubmission(
  pool: Pool,
  bountyId: string,
): Promise<Record<string, unknown> | null> {
  // POLICY.md 20.8: the accepted assignment whatever its status, so a settled bounty keeps
  // its submission.
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM assignments WHERE bounty_id = $1 AND accepted_at IS NOT NULL
       AND status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')
     ORDER BY accepted_at DESC LIMIT 1`,
    [bountyId],
  );
  const assignment = r.rows[0];
  if (assignment === undefined) return null;
  const row = await loadSubmission(pool, assignment.id);
  return row === null
    ? null
    : {
        submitted_at: row.submitted_at.toISOString(),
        item_count: row.item_count,
        verification: row.verification,
        // POLICY.md 20.8: the review window's end, null until projected.
        review_ends_at: row.review_ends_at === null ? null : row.review_ends_at.toISOString(),
      };
}
