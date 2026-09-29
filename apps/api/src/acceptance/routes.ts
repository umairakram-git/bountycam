// POLICY.md section 16.8: POST /bounties/:id/acceptance, the seven-step check
// order. No body: the server reads the chain, so the request asserts nothing.
// The phone calls it after every accept attempt. Registered only when the
// chain dependencies exist, as section 15.4's is.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import { bytesToHex } from "../bounties/policy.ts";
import { assignedView, ownerView } from "../bounties/views.ts";
import { captureObject, liveNonce } from "../capture/nonce.ts";
import type { ChainReader } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { projectAcceptance, type AcceptanceDeps, type AcceptanceOutcome } from "./project.ts";

export interface AcceptanceRouteDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  chain: ChainReader;
  programId: string;
}

interface AcceptanceRow {
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

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

export function registerAcceptanceRoutes(app: FastifyInstance, deps: AcceptanceRouteDeps): void {
  const { pool, config, clock } = deps;
  const requireAuth = makeRequireAuth(config, clock);

  app.post<{ Params: { id: string } }>(
    "/bounties/:id/acceptance",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      const projection: AcceptanceDeps = {
        pool,
        chain: deps.chain,
        programId: deps.programId,
        alarm: (outcome, bountyId) =>
          request.log.error({ outcome, bountyId }, "acceptance alarm"),
      };

      // Step 2: any present body, section 8.7's rule.
      if (request.body !== undefined && request.body !== null) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      // Step 3.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 4.
      const loaded = await pool.query<AcceptanceRow>(LOAD, [id]);
      const row = loaded.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      const isRequester = row.requester_id === caller.id;
      if (!isRequester && (row.state === "DRAFT" || row.state === "CANCELLED")) {
        return fail(reply, 404, "NOT_FOUND");
      }
      // Step 6.
      let outcome: AcceptanceOutcome | undefined;
      if (row.state !== "ACCEPTED") outcome = await projectAcceptance(projection, id);

      // Step 7: from the row as it now stands.
      const fresh = (await pool.query<AcceptanceRow>(LOAD, [id])).rows[0] ?? row;
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
      if (fresh.state === "ACCEPTED") {
        const held = await pool.query<{ id: string; accepted_at: Date; deadline: Date }>(
          "SELECT id, accepted_at, deadline FROM assignments WHERE bounty_id = $1 " +
            "AND scout_id = $2 AND status = 'ACTIVE' AND accepted_at IS NOT NULL",
          [id, caller.id],
        );
        const acceptance = held.rows[0];
        if (acceptance !== undefined) {
          const now = clock.now();
          return reply.status(200).send(
            assignedView({
              ...fields,
              assignmentId: acceptance.id,
              acceptedAt: acceptance.accepted_at,
              deadline: acceptance.deadline,
              capture: captureObject(
                config.capture,
                acceptance.deadline,
                now,
                await liveNonce(pool, acceptance.id, now),
              ),
            }),
          );
        }
        if (isRequester) return reply.status(200).send(ownerView(fields));
        return fail(reply, 409, "ACCEPTED_BY_OTHER");
      }
      if (fresh.state === "AVAILABLE") {
        switch (outcome) {
          case "NOT_ACCEPTED":
            return fail(reply, 409, "NOT_ACCEPTED");
          case "CHAIN_UNAVAILABLE":
            return fail(reply, 503, "CHAIN_UNAVAILABLE");
          case "BINDING_MISMATCH":
            return fail(reply, 409, "BINDING_MISMATCH");
          case "UNKNOWN_SCOUT":
            return fail(reply, 409, "ACCEPTED_BY_OTHER");
          default:
            return fail(reply, 409, "BOUNTY_NOT_ACCEPTABLE");
        }
      }
      return fail(reply, 409, "BOUNTY_NOT_ACCEPTABLE");
    },
  );
}
