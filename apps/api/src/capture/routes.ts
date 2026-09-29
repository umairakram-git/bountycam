// POLICY.md section 17.6: POST /bounties/:id/capture-nonce, the twelve-step
// check order. Every success issues a new nonce and supersedes the current one
// in one transaction (D134). The start fix is stored and never echoed or
// logged (section 17.5). Registered only when the chain dependencies exist,
// because deployment_id comes from them; nothing here reads the chain.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { checkCaptureStart, isValidLat, isValidLon } from "@hackathon/shared";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Randomness } from "../randomness.ts";
import { captureObject, type NonceRow } from "./nonce.ts";

export interface CaptureRouteDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  randomness: Randomness;
  deploymentId: number;
}

interface StartBody {
  lat: string;
  lon: string;
  accuracyM: number;
  fixedAt: Date;
}

const BODY_KEYS = ["fixed_at", "horizontal_accuracy_m", "lat", "lon"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

// Step 2: exactly four keys, each of its type; accuracy finite and 0 or more.
function extractBody(body: unknown): StartBody | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(",") !== BODY_KEYS.join(",")) return null;
  const { lat, lon, horizontal_accuracy_m: accuracy, fixed_at: fixedAt } = b;
  if (typeof lat !== "string" || typeof lon !== "string") return null;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return null;
  if (typeof fixedAt !== "string" || !ISO_UTC.test(fixedAt)) return null;
  const parsed = new Date(fixedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return { lat, lon, accuracyM: accuracy, fixedAt: parsed };
}

export function registerCaptureRoutes(app: FastifyInstance, deps: CaptureRouteDeps): void {
  const { pool, config, clock, randomness, deploymentId } = deps;
  const capture = config.capture;
  const requireAuth = makeRequireAuth(config, clock);

  app.post<{ Params: { id: string } }>(
    "/bounties/:id/capture-nonce",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      // Step 2.
      const body = extractBody(request.body);
      if (body === null) return fail(reply, 400, "INVALID_REQUEST");
      // Step 3.
      if (!isValidLat(body.lat) || !isValidLon(body.lon)) {
        return fail(reply, 400, "INVALID_GPS");
      }
      // Step 4.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      const loaded = await pool.query<{
        state: string;
        requester_id: string;
        canonical_json: string;
      }>(
        `SELECT b.state, b.requester_id, p.canonical_json FROM bounties b
         JOIN policies p ON p.id = b.policy_id WHERE b.id = $1`,
        [id],
      );
      const row = loaded.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      // Step 6.
      const isRequester = row.requester_id === caller.id;
      if (!isRequester && (row.state === "DRAFT" || row.state === "CANCELLED")) {
        return fail(reply, 404, "NOT_FOUND");
      }
      // Step 7.
      if (row.state !== "ACCEPTED") return fail(reply, 409, "BOUNTY_NOT_CAPTURABLE");
      // Step 8.
      const held = await pool.query<{ id: string; deadline: Date }>(
        `SELECT id, deadline FROM assignments WHERE bounty_id = $1 AND scout_id = $2
         AND status = 'ACTIVE' AND accepted_at IS NOT NULL`,
        [id, caller.id],
      );
      const assignment = held.rows[0];
      if (assignment === undefined) return fail(reply, 403, "NOT_ASSIGNED");
      // Step 9. Start is allowed at equality.
      const now = clock.now();
      const deadlineMs = assignment.deadline.getTime();
      const closesMs = deadlineMs - (capture.deadlineBufferS + capture.minWindowS) * 1000;
      if (now.getTime() > closesMs) return fail(reply, 409, "CAPTURE_WINDOW_CLOSED");
      // Step 10.
      const policy = JSON.parse(row.canonical_json) as {
        lat: string;
        lon: string;
        capture_radius_m: number;
      };
      const gate = checkCaptureStart(
        { lat: Number(body.lat), lon: Number(body.lon), accuracyM: body.accuracyM },
        { lat: policy.lat, lon: policy.lon },
        policy.capture_radius_m,
        capture.maxLocationAccuracyM,
      );
      if (gate.decision === "IMPRECISE") return fail(reply, 400, "LOCATION_TOO_IMPRECISE");
      if (gate.decision === "TOO_FAR") return fail(reply, 400, "LOCATION_TOO_FAR");

      // Step 11.
      const value = randomness.randomBytes(32);
      if (value.length !== 32) throw new Error("randomness returned the wrong length");
      const expiresMs = Math.min(
        now.getTime() + capture.nonceLifetimeS * 1000,
        deadlineMs - capture.deadlineBufferS * 1000,
      );
      const client = await pool.connect();
      let inserted: NonceRow;
      try {
        await client.query("BEGIN");
        // 11.1: the projection's lock order, then re-check steps 7 and 8.
        const state = await client.query<{ state: string }>(
          "SELECT state FROM bounties WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (state.rows[0]?.state !== "ACCEPTED") {
          await client.query("ROLLBACK");
          return fail(reply, 409, "BOUNTY_NOT_CAPTURABLE");
        }
        // Step 8 bound the assignment to the caller; the composite foreign key
        // (section 17.2) refuses any row whose Scout is not the assignment's.
        const still = await client.query(
          `SELECT id FROM assignments WHERE id = $1 AND status = 'ACTIVE'
           AND accepted_at IS NOT NULL FOR UPDATE`,
          [assignment.id],
        );
        if (still.rowCount !== 1) {
          await client.query("ROLLBACK");
          return fail(reply, 403, "NOT_ASSIGNED");
        }
        // 11.2: reissue always supersedes.
        await client.query(
          `UPDATE capture_nonces SET status = 'SUPERSEDED'
           WHERE assignment_id = $1 AND status = 'ACTIVE'`,
          [assignment.id],
        );
        // 11.3.
        const result = await client.query<NonceRow>(
          `INSERT INTO capture_nonces (assignment_id, bounty_id, scout_id, deployment_id, value,
             status, issued_at, expires_at, start_lat, start_lon, start_accuracy_m,
             start_fixed_at)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9, $10, $11)
           RETURNING id, value, issued_at, expires_at`,
          [
            assignment.id,
            id,
            caller.id,
            deploymentId,
            Buffer.from(value),
            now,
            new Date(expiresMs),
            body.lat,
            body.lon,
            body.accuracyM,
            body.fixedAt,
          ],
        );
        await client.query("COMMIT");
        const created = result.rows[0];
        if (created === undefined) throw new Error("capture_nonces insert returned no row");
        inserted = created;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      // Step 12.
      return reply.status(201).send({
        capture: captureObject(capture, assignment.deadline, now, inserted),
      });
    },
  );
}
