// POLICY.md section 8.3: POST /bounties, the ten-step check order, numbered
// inline. The first failing step wins; no later step runs.
import type { FastifyInstance, FastifyReply } from "fastify";
import { SpecError, canonicalise, sha256 } from "@hackathon/shared";
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Randomness } from "../randomness.ts";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { extractCreateBody, type ExtractedCreateBody } from "./extract.ts";
import {
  buildPolicy,
  bytesToHex,
  validatePolicyFields,
  validateRequirements,
  type PolicyLimits,
} from "./policy.ts";
import { snapLat, snapLon } from "./snap.ts";
import { ownerView } from "./views.ts";

export interface BountyDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  randomness: Randomness;
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
    attester_pubkey: body.policy.attesterPubkey,
    capture_radius_m: body.policy.captureRadiusM,
    challenge_window_seconds: body.policy.challengeWindowSeconds,
    completion_window_seconds: body.policy.completionWindowSeconds,
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

export function registerBountyRoutes(
  app: FastifyInstance,
  deps: BountyDeps,
): void {
  const { pool, config, clock, randomness } = deps;
  const requireAuth = makeRequireAuth(config, clock);
  const limits: PolicyLimits = {
    cluster: config.cluster,
    settlementMint: config.settlementMint,
    attesterPubkeys: config.attesterPubkeys,
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
            attester_pubkey)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          caller.id,
          built.canonicalJson,
          Buffer.from(built.policyHashBytes),
          body.policy.requiredAssurance,
          body.policy.attesterPubkey,
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
}
