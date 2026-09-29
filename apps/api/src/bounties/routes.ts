// POLICY.md section 8.3 (POST /bounties, ten steps) and section 8.4
// (GET /bounties, six steps): check orders numbered inline. The first
// failing step wins; no later step runs.
import type { FastifyInstance, FastifyReply } from "fastify";
import { SpecError, canonicalise, isValidLat, isValidLon, sha256 } from "@hackathon/shared";
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Randomness } from "../randomness.ts";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import {
  UUID_FORM,
  extractCreateBody,
  type ExtractedCreateBody,
} from "./extract.ts";
import {
  buildPolicy,
  bytesToHex,
  validatePolicyFields,
  validateRequirements,
  type PolicyLimits,
} from "./policy.ts";
import { snapLat, snapLon } from "./snap.ts";
import { assignedView, listItem, ownerView, publicView } from "./views.ts";
import { captureObject, liveNonce } from "../capture/nonce.ts";
import type { EligibilityDeps } from "../eligibility/deps.ts";
import { projectFunding, type ProjectionDeps } from "../funding/project.ts";

export interface BountyDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  randomness: Randomness;
  // POLICY.md 15.6: cancel reads the chain before cancelling a DRAFT when the
  // chain dependencies exist. Test builds without them keep section 8.7 as
  // written; every production start provides them (index.ts).
  eligibility?: EligibilityDeps;
}

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

// Section 10.2: the digest covers the canonical form of the entire four-key
// body. Rebuilt from extracted values — step 2 proved the key sets equal, so
// this equals the received body canonically while the raw object still never
// flows past extraction. The optional policy keys keep their presence: a
// body that omitted cluster must not digest as if it sent one.
function digestBody(body: ExtractedCreateBody): Record<string, unknown> {
  const policy: Record<string, unknown> = {
    acceptance_window_seconds: body.policy.acceptanceWindowSeconds,
    capture_radius_m: body.policy.captureRadiusM,
    challenge_window_seconds: body.policy.challengeWindowSeconds,
    completion_window_seconds: body.policy.completionWindowSeconds,
    eligibility_profile_id: body.policy.eligibilityProfileId,
    evidence_requirements: body.policy.evidenceRequirements.map((item) => ({
      prompt: item.prompt,
      required: item.required,
      type: item.type,
    })),
    lat: body.policy.lat,
    lon: body.policy.lon,
    required_assurance: body.policy.requiredAssurance,
    reward_amount: body.policy.rewardAmount,
  };
  if (body.policy.cluster !== undefined) {
    policy["cluster"] = body.policy.cluster;
  }
  if (body.policy.settlementMint !== undefined) {
    policy["settlement_mint"] = body.policy.settlementMint;
  }
  return {
    category: body.category,
    idempotency_key: body.idempotencyKey,
    policy,
    title: body.title,
  };
}

interface StoredBountyRow {
  id: string;
  title: string;
  category: string;
  state: string;
  program_account: string | null;
  created_at: Date;
  request_digest: Buffer;
  canonical_json: string;
  policy_hash: Buffer;
}

async function readStored(
  pool: Pool,
  requesterId: string,
  idempotencyKey: string,
): Promise<StoredBountyRow | undefined> {
  const found = await pool.query<StoredBountyRow>(
    `SELECT b.id, b.title, b.category, b.state, b.program_account,
            b.created_at, b.request_digest, p.canonical_json, p.policy_hash
     FROM bounties b
     JOIN policies p ON p.id = b.policy_id
     WHERE b.requester_id = $1 AND b.idempotency_key = $2`,
    [requesterId, idempotencyKey],
  );
  return found.rows[0];
}

// Section 10.3's two stored-row outcomes, shared by step 8 and the step 9
// collision path. Equal digest: 201 replay, the stored bounty as it now is,
// view parsed from stored canonical_json — the fresh build is discarded.
// Different digest: 409, nothing written.
function respondReplayOrConflict(
  reply: FastifyReply,
  stored: StoredBountyRow,
  requestDigest: Uint8Array,
): FastifyReply {
  if (!stored.request_digest.equals(requestDigest)) {
    return fail(reply, 409, "IDEMPOTENCY_KEY_REUSED");
  }
  return reply.status(201).send(
    ownerView({
      id: stored.id,
      title: stored.title,
      category: stored.category,
      state: stored.state,
      programAccount: stored.program_account,
      createdAt: stored.created_at,
      policyHashHex: bytesToHex(stored.policy_hash),
      canonicalJson: stored.canonical_json,
    }),
  );
}

// Section 8.3 step 9: only a unique violation on this exact index is a
// concurrent duplicate. The name is load-bearing (the migration says so):
// code and constraint are both matched exactly, so a 23505 from any other
// constraint rethrows to the 500 handler instead of masquerading as replay.
function isIdempotencyCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as {
    code?: unknown;
    constraint?: unknown;
  };
  return (
    code === "23505" && constraint === "bounties_requester_idempotency_uidx"
  );
}

// Section 8.4 step 2 (D63): integer form is a string check run before any
// numeric parse — ASCII digits only, no sign, no leading zeros (the single
// digit 0 is allowed), at most nine digits. The length bound keeps every
// accepted numeral inside safe integer range.
const INTEGER_FORM = /^(?:0|[1-9][0-9]{0,8})$/;

const DISCOVERY_KEYS: readonly string[] = [
  "lat",
  "lon",
  "radius_m",
  "limit",
  "offset",
];

interface DiscoveryQuery {
  lat: string;
  lon: string;
  radiusM: number;
  limit: number;
  offset: number;
}

// Section 8.4 step 2: unknown parameters, missing required parameters,
// integer form, and limit/offset bounds — every failure here maps to one
// INVALID_REQUEST. Coordinate rules (step 3) and radius bounds (step 4)
// carry their own codes and run in the handler. Number() runs only on
// strings the form check has already accepted.
function extractDiscoveryQuery(query: unknown): DiscoveryQuery | null {
  if (typeof query !== "object" || query === null) return null;
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DISCOVERY_KEYS.includes(key)) return null;
  }

  const lat = record["lat"];
  const lon = record["lon"];
  const radius = record["radius_m"];
  if (typeof lat !== "string") return null;
  if (typeof lon !== "string") return null;
  if (typeof radius !== "string" || !INTEGER_FORM.test(radius)) return null;

  let limit = 20;
  if ("limit" in record) {
    const value = record["limit"];
    if (typeof value !== "string" || !INTEGER_FORM.test(value)) return null;
    limit = Number(value);
    if (limit < 1 || limit > 100) return null;
  }

  let offset = 0;
  if ("offset" in record) {
    const value = record["offset"];
    if (typeof value !== "string" || !INTEGER_FORM.test(value)) return null;
    // The form check already enforces 0 or more; no upper bound beyond it.
    offset = Number(value);
  }

  return { lat, lon, radiusM: Number(radius), limit, offset };
}

const ME_KEYS: readonly string[] = ["limit", "offset"];

interface MeQuery {
  limit: number;
  offset: number;
}

// Section 8.6 step 2: limit and offset as in section 8.4 — same integer
// form, bounds and defaults — and nothing else. lat, lon and radius_m are
// unknown parameters here; every failure maps to one INVALID_REQUEST.
function extractMeQuery(query: unknown): MeQuery | null {
  if (typeof query !== "object" || query === null) return null;
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ME_KEYS.includes(key)) return null;
  }

  let limit = 20;
  if ("limit" in record) {
    const value = record["limit"];
    if (typeof value !== "string" || !INTEGER_FORM.test(value)) return null;
    limit = Number(value);
    if (limit < 1 || limit > 100) return null;
  }

  let offset = 0;
  if ("offset" in record) {
    const value = record["offset"];
    if (typeof value !== "string" || !INTEGER_FORM.test(value)) return null;
    offset = Number(value);
  }

  return { limit, offset };
}

interface DetailRow {
  id: string;
  title: string;
  category: string;
  state: string;
  program_account: string | null;
  created_at: Date;
  requester_id: string;
  policy_hash: Buffer;
  canonical_json: string;
}

// One row shape for both list endpoints — the 8.2 list item is "one shape",
// and both queries select exactly the columns listItem consumes.
interface ListItemRow {
  id: string;
  title: string;
  category: string;
  state: string;
  created_at: Date;
  reward_amount: string;
  required_assurance: number;
  canonical_json: string;
}

export function registerBountyRoutes(
  app: FastifyInstance,
  deps: BountyDeps,
): void {
  const { pool, config, clock, randomness } = deps;
  const requireAuth = makeRequireAuth(config, clock);
  const limits: PolicyLimits = {
    cluster: config.cluster,
    settlementMint: config.settlementMint,
    minCompletionWindowSeconds: config.capture.deadlineBufferS + config.capture.minWindowS,
  };

  app.post("/bounties", { preHandler: requireAuth }, async (request, reply) => {
    // Step 1 ran as the preHandler; the accessor is the only identity read.
    const caller = authUser(request);

    // Step 2: body shape — INVALID_REQUEST.
    const body = extractCreateBody(request.body);
    if (body === null) return fail(reply, 400, "INVALID_REQUEST");

    // Step 3: title bounds — INVALID_TITLE. UTF-16 code units: .length.
    if (body.title.length < 1 || body.title.length > 120) {
      return fail(reply, 400, "INVALID_TITLE");
    }

    // Step 4: category bounds — INVALID_CATEGORY.
    if (body.category.length < 1 || body.category.length > 50) {
      return fail(reply, 400, "INVALID_CATEGORY");
    }

    // Step 5: field rules in canonical order — each failure its own code.
    const fieldError = validatePolicyFields(body.policy, limits);
    if (fieldError !== null) return fail(reply, 400, fieldError);

    // Step 6: requirement item rules, then at-least-one-required.
    const requirementError = validateRequirements(
      body.policy.evidenceRequirements,
    );
    if (requirementError !== null) return fail(reply, 400, requirementError);

    // Step 7: build and hash. A SpecError from either canonicalisation is
    // INVALID_REQUEST; anything else is a bug and goes to the 500 handler.
    let built: ReturnType<typeof buildPolicy>;
    let requestDigest: Uint8Array;
    try {
      built = buildPolicy(body.policy, limits, randomness);
      requestDigest = sha256(
        new TextEncoder().encode(canonicalise(digestBody(body))),
      );
    } catch (error) {
      if (error instanceof SpecError) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      throw error;
    }

    // Step 8: idempotency read, via the pool — no transaction yet.
    const existing = await readStored(pool, caller.id, body.idempotencyKey);
    if (existing !== undefined) {
      return respondReplayOrConflict(reply, existing, requestDigest);
    }

    // Step 9: one transaction, three inserts. The client is released in
    // finally alone, so every path — commit, replay, 409, rethrow — returns
    // it to the pool.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const policyResult = await client.query<{ id: string }>(
        `INSERT INTO policies
           (requester_id, canonical_json, policy_hash, required_assurance,
            eligibility_profile_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          caller.id,
          built.canonicalJson,
          Buffer.from(built.policyHashBytes),
          body.policy.requiredAssurance,
          body.policy.eligibilityProfileId,
        ],
      );
      const policyRow = policyResult.rows[0];
      if (policyRow === undefined) {
        throw new Error("policies insert returned no row");
      }

      // Section 7.1: id is the assigned uuid inside the hash, sequence the
      // 1-based array position as a derived copy.
      for (const [index, item] of built.requirements.entries()) {
        await client.query(
          `INSERT INTO evidence_requirements
             (id, policy_id, type, prompt, sequence, required)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            item.id,
            policyRow.id,
            item.type,
            item.prompt,
            index + 1,
            item.required,
          ],
        );
      }

      // state is omitted: section 7.1 names DRAFT, and the column default
      // (init-schema) supplies it — a literal here would be a drift surface.
      // location is the exact point, location_public the snapped one; the
      // only production snap call site (D34/D58). The float8 casts are the
      // section 9.1 entry rule (D64): geography stores float8 pairs, entry
      // is exact for profile strings (ten significant digits inside float8's
      // fifteen), and no code path may ever render coordinates back out.
      const bountyResult = await client.query<{
        id: string;
        state: string;
        program_account: string | null;
        created_at: Date;
      }>(
        `INSERT INTO bounties
           (requester_id, policy_id, title, category, capture_radius_m,
            reward_amount, location, location_public, idempotency_key,
            request_digest)
         VALUES ($1, $2, $3, $4, $5, $6,
                 ST_SetSRID(ST_MakePoint($7::float8, $8::float8), 4326)::geography,
                 ST_SetSRID(ST_MakePoint($9::float8, $10::float8), 4326)::geography,
                 $11, $12)
         RETURNING id, state, program_account, created_at`,
        [
          caller.id,
          policyRow.id,
          body.title,
          body.category,
          body.policy.captureRadiusM,
          body.policy.rewardAmount,
          body.policy.lon,
          body.policy.lat,
          snapLon(body.policy.lon),
          snapLat(body.policy.lat),
          body.idempotencyKey,
          Buffer.from(requestDigest),
        ],
      );
      const bountyRow = bountyResult.rows[0];
      if (bountyRow === undefined) {
        throw new Error("bounties insert returned no row");
      }

      await client.query("COMMIT");

      // Step 10: 201, owner view over the canonical text just stored.
      return reply.status(201).send(
        ownerView({
          id: bountyRow.id,
          title: body.title,
          category: body.category,
          state: bountyRow.state,
          programAccount: bountyRow.program_account,
          createdAt: bountyRow.created_at,
          policyHashHex: built.policyHashHex,
          canonicalJson: built.canonicalJson,
        }),
      );
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A dead connection must not mask the original error.
      }
      if (isIdempotencyCollision(error)) {
        // Concurrent duplicate: re-read the winner via the pool, not this
        // client — after a swallowed ROLLBACK failure the client may be
        // dead, and the winner's committed row is invisible from inside an
        // aborted transaction anyway.
        const winner = await readStored(pool, caller.id, body.idempotencyKey);
        if (winner !== undefined) {
          return respondReplayOrConflict(reply, winner, requestDigest);
        }
      }
      throw error;
    } finally {
      client.release();
    }
  });

  // POLICY.md section 8.4: GET /bounties, the six-step check order.
  app.get("/bounties", { preHandler: requireAuth }, async (request, reply) => {
    // Step 1 ran as the preHandler; the accessor asserts the wiring.
    authUser(request);

    // Step 2: parameter shape — INVALID_REQUEST.
    const query = extractDiscoveryQuery(request.query);
    if (query === null) return fail(reply, 400, "INVALID_REQUEST");

    // Step 3: coordinates against the section 5 rules — INVALID_GPS.
    if (!isValidLat(query.lat) || !isValidLon(query.lon)) {
      return fail(reply, 400, "INVALID_GPS");
    }

    // Step 4: radius bounds — INVALID_QUERY_RADIUS.
    if (query.radiusM < 100 || query.radiusM > 50000) {
      return fail(reply, 400, "INVALID_QUERY_RADIUS");
    }

    // Step 5: the discoverable set is exactly AVAILABLE with no ACTIVE
    // reservation (7.3, D79) — the status flip, never a timestamp, decides
    // expiry, so this predicate and the unique partial index agree —
    // measured against location_public only (9.1). Both ST_DWithin
    // operands are geography —
    // no ::geometry anywhere — so the radius is metres on the spheroid; on
    // geometry the same literal would mean degrees and match the planet.
    // ST_MakePoint is (x, y) = (lon, lat), as in the insert above. Distance
    // exists only in ORDER BY and is discarded (9.3); the id ASC tie-break
    // makes the order total for offset pagination (D63). The query point is
    // the caller's own and is not snapped. canonical_json is selected
    // because listItem snaps the policy lat/lon strings — location_public
    // is never rendered back out of the geography column (D64).
    const result = await pool.query<ListItemRow>(
      `SELECT b.id, b.title, b.category, b.state, b.created_at,
              b.reward_amount, p.required_assurance, p.canonical_json
       FROM bounties b
       JOIN policies p ON p.id = b.policy_id
       WHERE b.state = 'AVAILABLE'
         AND b.acceptance_cutoff >= $6
         AND NOT EXISTS (
           SELECT 1 FROM assignments a
           WHERE a.bounty_id = b.id AND a.status = 'ACTIVE')
         AND ST_DWithin(
               b.location_public,
               ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)
                 ::geography,
               $3::float8)
       ORDER BY
         ST_Distance(
           b.location_public,
           ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)
             ::geography) ASC,
         b.created_at DESC,
         b.id ASC
       LIMIT $4 OFFSET $5`,
      // $6: POLICY.md 16.3 (D126), the voucher check 6 comparison.
      [query.lon, query.lat, query.radiusM, query.limit, query.offset, clock.now()],
    );

    // Step 6: 200, an object whose single key is bounties.
    return reply.status(200).send({
      bounties: result.rows.map((row) =>
        listItem({
          id: row.id,
          title: row.title,
          category: row.category,
          state: row.state,
          createdAt: row.created_at,
          rewardAmount: row.reward_amount,
          requiredAssurance: row.required_assurance,
          canonicalJson: row.canonical_json,
        }),
      ),
    });
  });

  // POLICY.md section 8.5: GET /bounties/:id, the five-step check order.
  // Steps 2 and 3 use the same fail() call with the same code, so a
  // malformed id and an absent row return byte-identical bodies (test 60):
  // an id leak must not become an existence oracle (7.3). UUID_FORM is the
  // exported section 10.1 regex from extract.ts — one copy, one form.
  app.get<{ Params: { id: string } }>(
    "/bounties/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler; the accessor is the identity read.
      const caller = authUser(request);

      // Step 2: id form — NOT_FOUND.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");

      // Step 3: load by id alone. Ownership is compared in the handler,
      // not the WHERE clause: a non-owner is still owed the public view
      // in visible states, so the row loads regardless of who asks and
      // zero rows means exactly one thing — absence.
      const result = await pool.query<DetailRow>(
        `SELECT b.id, b.title, b.category, b.state, b.program_account,
                b.created_at, b.requester_id, p.policy_hash,
                p.canonical_json
         FROM bounties b
         JOIN policies p ON p.id = b.policy_id
         WHERE b.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");

      // Step 4: the owner gets the owner view in every state.
      if (row.requester_id === caller.id) {
        return reply.status(200).send(
          ownerView({
            id: row.id,
            title: row.title,
            category: row.category,
            state: row.state,
            programAccount: row.program_account,
            createdAt: row.created_at,
            policyHashHex: bytesToHex(row.policy_hash),
            canonicalJson: row.canonical_json,
          }),
        );
      }

      // Step 4a (POLICY.md 16.4, D127): the Scout holding the acceptance gets
      // the assigned-Scout view, with the exact location inside the policy.
      if (row.state === "ACCEPTED") {
        const held = await pool.query<{ id: string; accepted_at: Date; deadline: Date }>(
          "SELECT id, accepted_at, deadline FROM assignments WHERE bounty_id = $1 " +
            "AND scout_id = $2 AND status = 'ACTIVE' AND accepted_at IS NOT NULL",
          [row.id, caller.id],
        );
        const acceptance = held.rows[0];
        if (acceptance !== undefined) {
          // Section 17.7: the live capture session, if any, from the server's clock.
          const now = clock.now();
          const capture = captureObject(
            config.capture,
            acceptance.deadline,
            now,
            await liveNonce(pool, acceptance.id, now),
          );
          return reply.status(200).send(
            assignedView({
              id: row.id,
              title: row.title,
              category: row.category,
              state: row.state,
              programAccount: row.program_account,
              createdAt: row.created_at,
              policyHashHex: bytesToHex(row.policy_hash),
              canonicalJson: row.canonical_json,
              assignmentId: acceptance.id,
              acceptedAt: acceptance.accepted_at,
              deadline: acceptance.deadline,
              capture,
            }),
          );
        }
      }

      // Step 5: DRAFT and CANCELLED are hidden from anyone else (7.3);
      // any other state gets the public view.
      if (row.state === "DRAFT" || row.state === "CANCELLED") {
        return fail(reply, 404, "NOT_FOUND");
      }
      return reply.status(200).send(
        publicView({
          id: row.id,
          title: row.title,
          category: row.category,
          state: row.state,
          programAccount: row.program_account,
          createdAt: row.created_at,
          policyHashHex: bytesToHex(row.policy_hash),
          canonicalJson: row.canonical_json,
        }),
      );
    },
  );

  // POLICY.md section 8.6: GET /me/bounties, the three-step check order.
  // The path is /me/bounties, not /bounties/mine — mine would be captured
  // by section 8.5's :id segment, and a route whose reachability depends
  // on registration order is a bug waiting for a refactor.
  app.get(
    "/me/bounties",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler; the accessor is the identity read.
      const caller = authUser(request);

      // Step 2: limit and offset only — INVALID_REQUEST.
      const query = extractMeQuery(request.query);
      if (query === null) return fail(reply, 400, "INVALID_REQUEST");

      // Step 3: the caller as requester, all states — deliberately no
      // state filter (8.6: "The caller's own bounties, all states").
      // created_at DESC then id ASC is the section 8.4 tie-break that
      // keeps offset pagination total (D63, 8.6 as amended).
      // canonical_json feeds listItem's snap of the policy lat and lon;
      // location_public is never read back from the column (D64).
      const result = await pool.query<ListItemRow>(
        `SELECT b.id, b.title, b.category, b.state, b.created_at,
                b.reward_amount, p.required_assurance, p.canonical_json
         FROM bounties b
         JOIN policies p ON p.id = b.policy_id
         WHERE b.requester_id = $1
         ORDER BY b.created_at DESC, b.id ASC
         LIMIT $2 OFFSET $3`,
        [caller.id, query.limit, query.offset],
      );

      // 200, an object whose single key is bounties.
      return reply.status(200).send({
        bounties: result.rows.map((row) =>
          listItem({
            id: row.id,
            title: row.title,
            category: row.category,
            state: row.state,
            createdAt: row.created_at,
            rewardAmount: row.reward_amount,
            requiredAssurance: row.required_assurance,
            canonicalJson: row.canonical_json,
          }),
        ),
      });
    },
  );

  // POLICY.md section 16.5: GET /me/missions, the caller's acceptances. The
  // phone has no local storage; this is how it finds a mission after a
  // restart. Registered beside /me/bounties for section 8.6's reason.
  app.get(
    "/me/missions",
    { preHandler: requireAuth },
    async (request, reply) => {
      const caller = authUser(request);
      const query = extractMeQuery(request.query);
      if (query === null) return fail(reply, 400, "INVALID_REQUEST");
      const result = await pool.query<ListItemRow & { deadline: Date }>(
        `SELECT b.id, b.title, b.category, b.state, b.created_at,
                b.reward_amount, p.required_assurance, p.canonical_json, a.deadline
         FROM assignments a
         JOIN bounties b ON b.id = a.bounty_id
         JOIN policies p ON p.id = b.policy_id
         WHERE a.scout_id = $1 AND a.status = 'ACTIVE' AND a.accepted_at IS NOT NULL
         ORDER BY a.accepted_at DESC, b.id ASC
         LIMIT $2 OFFSET $3`,
        [caller.id, query.limit, query.offset],
      );
      return reply.status(200).send({
        missions: result.rows.map((row) => ({
          ...listItem({
            id: row.id,
            title: row.title,
            category: row.category,
            state: row.state,
            createdAt: row.created_at,
            rewardAmount: row.reward_amount,
            requiredAssurance: row.required_assurance,
            canonicalJson: row.canonical_json,
          }),
          deadline: row.deadline.toISOString(),
        })),
      });
    },
  );

  // POLICY.md section 8.7: POST /bounties/:id/cancel, the eight-step check
  // order as amended (D66). Step 2 runs before the id form. The step 7
  // reload happens exactly once: a second zero-row result would falsify
  // the 7.2 state machine — no transition re-enters DRAFT — so it throws
  // to the 500 handler rather than retrying.
  app.post<{ Params: { id: string } }>(
    "/bounties/:id/cancel",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler; the accessor is the identity read.
      const caller = authUser(request);

      // Step 2: any present body — an empty JSON object included — is
      // INVALID_REQUEST. Presence on the wire, not object contents (D66).
      if (request.body !== undefined && request.body !== null) {
        return fail(reply, 400, "INVALID_REQUEST");
      }

      // Step 3: id form — NOT_FOUND, byte-identical with step 4 absence.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");

      // Step 4: load, by id alone; DetailRow is the section 8.5 shape.
      // policy_hash and canonical_json ride along here — immutable after
      // creation (section 4) — so both owner-view arms are served from
      // this load, never from the UPDATE's RETURNING.
      const result = await pool.query<DetailRow>(
        `SELECT b.id, b.title, b.category, b.state, b.program_account,
                b.created_at, b.requester_id, p.policy_hash,
                p.canonical_json
         FROM bounties b
         JOIN policies p ON p.id = b.policy_id
         WHERE b.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");

      // Step 5: not the requester — hidden states are 404 (7.3), so a
      // cancel probe is no existence oracle; visible states are 403.
      if (row.requester_id !== caller.id) {
        if (row.state === "DRAFT" || row.state === "CANCELLED") {
          return fail(reply, 404, "NOT_FOUND");
        }
        return fail(reply, 403, "FORBIDDEN");
      }

      const ownerBody = (state: string): Record<string, unknown> =>
        ownerView({
          id: row.id,
          title: row.title,
          category: row.category,
          state,
          programAccount: row.program_account,
          createdAt: row.created_at,
          policyHashHex: bytesToHex(row.policy_hash),
          canonicalJson: row.canonical_json,
        });

      // Step 6: already cancelled — a retry is a success, not a conflict.
      if (row.state === "CANCELLED") {
        return reply.status(200).send(ownerBody("CANCELLED"));
      }

      // Step 6a (POLICY.md 15.6, D120): with the chain available, a DRAFT
      // whose account already exists is projected instead of cancelled, and
      // a failed read refuses the cancel rather than risk cancelling a funded
      // bounty. No account: fall through to step 7.
      if (row.state === "DRAFT" && deps.eligibility !== undefined) {
        const projection: ProjectionDeps = {
          pool,
          chain: deps.eligibility.chain,
          programId: deps.eligibility.config.programId,
          programIdBytes: deps.eligibility.config.programIdBytes,
          alarm: (outcome, bountyId) =>
            request.log.error({ outcome, bountyId }, "funding alarm"),
        };
        const projected = await projectFunding(projection, row.id);
        if (projected.outcome === "CHAIN_UNAVAILABLE") {
          return fail(reply, 503, "CHAIN_UNAVAILABLE");
        }
        if (projected.outcome !== "NOT_FUNDED") {
          return fail(reply, 409, "BOUNTY_NOT_CANCELLABLE");
        }
      }

      // Step 7: the one conditional update — id, requester and DRAFT all
      // match, or zero rows return.
      if (row.state === "DRAFT") {
        const updated = await pool.query<{ state: string }>(
          `UPDATE bounties
           SET state = 'CANCELLED'
           WHERE id = $1 AND requester_id = $2 AND state = 'DRAFT'
           RETURNING state`,
          [row.id, caller.id],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow !== undefined) {
          return reply.status(200).send(ownerBody(updatedRow.state));
        }

        // Zero rows: a concurrent transition won. Reload once and
        // re-apply steps 6 and 8. DRAFT again is impossible (7.2, D66):
        // it throws instead of retrying.
        const reread = await pool.query<{ state: string }>(
          `SELECT state FROM bounties WHERE id = $1`,
          [row.id],
        );
        const rerow = reread.rows[0];
        if (rerow === undefined) {
          throw new Error("cancel reload: row vanished after zero-row update");
        }
        if (rerow.state === "CANCELLED") {
          return reply.status(200).send(ownerBody("CANCELLED"));
        }
        if (rerow.state === "DRAFT") {
          throw new Error("cancel reload: DRAFT after zero-row update");
        }
        return fail(reply, 409, "BOUNTY_NOT_CANCELLABLE");
      }

      // Step 8: anything else admits no cancellation in Session 7.
      return fail(reply, 409, "BOUNTY_NOT_CANCELLABLE");
    },
  );
}
