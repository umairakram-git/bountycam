// POLICY.md sections 20.5 and 20.9 (D156, D157): the settlement report and the
// requester's photo read. The report takes no body: the server reads the chain. The
// photo route signs short-lived GET URLs and never reads a photo; no URL is logged.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import { bytesToHex } from "../bounties/policy.ts";
import { assignedView, ownerView, publicView } from "../bounties/views.ts";
import { captureObject, liveNonce } from "../capture/nonce.ts";
import { ownerSubmission, scoutSubmission } from "../evidence/routes.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import type { ChainReader, SettlementReader } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { projectSettlement, type SettlementDeps } from "./project.ts";
import { SETTLED_VIEW_STATES, settledFields } from "./views.ts";

export interface SettlementRouteDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  chain: ChainReader;
  settlement: SettlementReader;
  programId: string;
  /** Section 20.9: the photo route registers only with a store. */
  store?: Pick<EvidenceStore, "presignGet">;
  readUrlTtlS: number;
}

interface Row {
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

const LOAD = `SELECT b.id, b.title, b.category, b.state, b.program_account, b.created_at,
                     b.requester_id, p.policy_hash, p.canonical_json
              FROM bounties b
              JOIN policies p ON p.id = b.policy_id
              WHERE b.id = $1`;

const SUBMISSION_STATES: ReadonlySet<string> =
  new Set(["ACCEPTED", "SUBMITTED", "DISPUTED", "PAID", "REFUNDED"]);
const EVIDENCE_STATES: ReadonlySet<string> =
  new Set(["SUBMITTED", "DISPUTED", "PAID", "REFUNDED"]);

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

async function heldAssignment(pool: Pool, bountyId: string, scoutId: string) {
  const r = await pool.query<{ id: string; accepted_at: Date; deadline: Date }>(
    `SELECT id, accepted_at, deadline FROM assignments
     WHERE bounty_id = $1 AND scout_id = $2 AND accepted_at IS NOT NULL
       AND status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')
     ORDER BY accepted_at DESC LIMIT 1`,
    [bountyId, scoutId],
  );
  return r.rows[0];
}

export function registerSettlementRoutes(app: FastifyInstance, deps: SettlementRouteDeps): void {
  const { pool, config, clock } = deps;
  const requireAuth = makeRequireAuth(config, clock);

  // --- section 20.5 ---
  app.post<{ Params: { id: string } }>(
    "/bounties/:id/settlement",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      // Step 2.
      if (request.body !== undefined && request.body !== null) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      // Step 3.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 4.
      const row = (await pool.query<Row>(LOAD, [id])).rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      const isRequester = row.requester_id === caller.id;
      const held = isRequester ? undefined : await heldAssignment(pool, id, caller.id);
      if (!isRequester && held === undefined) {
        return row.state === "DRAFT" || row.state === "CANCELLED"
          ? fail(reply, 404, "NOT_FOUND")
          : fail(reply, 403, "FORBIDDEN");
      }
      // Step 6.
      const projection: SettlementDeps = {
        pool,
        clock,
        chain: deps.chain,
        settlement: deps.settlement,
        programId: deps.programId,
        alarm: (outcome, bountyId) => request.log.error({ outcome, bountyId }, "settlement alarm"),
      };
      const result = await projectSettlement(projection, id);
      if (result.outcome === "CHAIN_UNAVAILABLE") return fail(reply, 503, "CHAIN_UNAVAILABLE");
      if (result.outcome === "BINDING_MISMATCH" || result.outcome === "PARTY_MISMATCH" ||
        result.outcome === "UNPROJECTED_STATE") {
        return fail(reply, 409, "BINDING_MISMATCH");
      }
      // Step 7: the caller's view as the row now stands.
      const fresh = (await pool.query<Row>(LOAD, [id])).rows[0] ?? row;
      const fields = {
        id: fresh.id,
        title: fresh.title,
        category: fresh.category,
        state: fresh.state,
        programAccount: fresh.program_account,
        createdAt: fresh.created_at,
        policyHashHex: bytesToHex(fresh.policy_hash),
        canonicalJson: fresh.canonical_json,
      };
      const settled = await settledFields(pool, id, fresh.state);
      if (isRequester) {
        return reply.status(200).send(ownerView({
          ...fields,
          ...(SUBMISSION_STATES.has(fresh.state)
            ? { submission: await ownerSubmission(pool, id) }
            : {}),
          ...settled,
        }));
      }
      const acceptance = held as NonNullable<typeof held>;
      const scoutViewState = SETTLED_VIEW_STATES.has(fresh.state) ||
        fresh.state === "ACCEPTED" || fresh.state === "SUBMITTED";
      if (!scoutViewState) return reply.status(200).send(publicView(fields));
      const now = clock.now();
      return reply.status(200).send(assignedView({
        ...fields,
        assignmentId: acceptance.id,
        acceptedAt: acceptance.accepted_at,
        deadline: acceptance.deadline,
        capture: captureObject(config.capture, acceptance.deadline, now,
          await liveNonce(pool, acceptance.id, now)),
        submission: await scoutSubmission(pool, acceptance.id),
        ...settled,
      }));
    },
  );

  // --- section 20.9 ---
  const store = deps.store;
  if (store === undefined) return;
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/bounties/:id/evidence",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      // Step 2.
      const query = request.query;
      if (query !== undefined && query !== null && Object.keys(query).length > 0) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      // Step 3.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 4.
      const row = (await pool.query<Row>(LOAD, [id])).rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      if (row.requester_id !== caller.id) {
        return row.state === "DRAFT" || row.state === "CANCELLED"
          ? fail(reply, 404, "NOT_FOUND")
          : fail(reply, 403, "FORBIDDEN");
      }
      // Step 6.
      if (!EVIDENCE_STATES.has(row.state)) return fail(reply, 409, "NO_EVIDENCE");
      const items = await pool.query<{
        requirement_id: string;
        captured_at: Date;
        storage_key: string;
      }>(
        `SELECT e.requirement_id, e.captured_at, e.storage_key
         FROM submissions s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN attestations t ON t.submission_id = s.id AND t.status = 'SUBMITTED'
         JOIN evidence_items e ON e.submission_id = s.id
         WHERE s.bounty_id = $1 AND a.accepted_at IS NOT NULL`,
        [id],
      );
      if (items.rows.length === 0) return fail(reply, 409, "NO_EVIDENCE");
      // Step 7: policy order; one expiry for every URL.
      const policy = JSON.parse(row.canonical_json) as { evidence_requirements: { id: string }[] };
      const position = new Map(policy.evidence_requirements.map((r, i) => [r.id, i]));
      const sorted = [...items.rows].sort((a, b) =>
        (position.get(a.requirement_id) ?? 0) - (position.get(b.requirement_id) ?? 0));
      const now = clock.now();
      return reply.status(200).send({
        evidence: {
          expires_at: new Date(now.getTime() + deps.readUrlTtlS * 1000).toISOString(),
          items: sorted.map((it) => ({
            requirement_id: it.requirement_id,
            captured_at: it.captured_at.toISOString(),
            url: store.presignGet(it.storage_key, deps.readUrlTtlS, now),
          })),
        },
      });
    },
  );
}
