// POLICY.md section 15.4: POST /bounties/:id/funding, the eight-step check
// order. No body: the server reads everything from the chain, so the request
// asserts nothing. Registered only when the chain dependencies exist.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import { bytesToHex } from "../bounties/policy.ts";
import { ownerView } from "../bounties/views.ts";
import type { ChainReader } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { projectFunding, readFundedAccount, type ProjectionDeps } from "./project.ts";

export interface FundingRouteDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  chain: ChainReader;
  programId: string;
  programIdBytes: Uint8Array;
}

interface FundingRow {
  id: string;
  title: string;
  category: string;
  state: string;
  program_account: string | null;
  created_at: Date;
  requester_id: string;
  wallet_address: string;
  policy_hash: Buffer;
  canonical_json: string;
}

const LOAD = `SELECT b.id, b.title, b.category, b.state, b.program_account, b.created_at,
                     b.requester_id, u.wallet_address, p.policy_hash, p.canonical_json
              FROM bounties b
              JOIN policies p ON p.id = b.policy_id
              JOIN users u ON u.id = b.requester_id
              WHERE b.id = $1`;

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

export function registerFundingRoutes(app: FastifyInstance, deps: FundingRouteDeps): void {
  const { pool, config, clock } = deps;
  const requireAuth = makeRequireAuth(config, clock);

  app.post<{ Params: { id: string } }>(
    "/bounties/:id/funding",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler.
      const caller = authUser(request);
      const projection: ProjectionDeps = {
        pool,
        chain: deps.chain,
        programId: deps.programId,
        programIdBytes: deps.programIdBytes,
        alarm: (outcome, bountyId) => request.log.error({ outcome, bountyId }, "funding alarm"),
      };

      // Step 2: any present body, section 8.7's rule.
      if (request.body !== undefined && request.body !== null) {
        return fail(reply, 400, "INVALID_REQUEST");
      }
      // Step 3.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      // Step 4.
      const loaded = await pool.query<FundingRow>(LOAD, [id]);
      const row = loaded.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      // Step 5.
      if (row.requester_id !== caller.id) {
        if (row.state === "DRAFT" || row.state === "CANCELLED") {
          return fail(reply, 404, "NOT_FOUND");
        }
        return fail(reply, 403, "FORBIDDEN");
      }

      const ownerBody = async (): Promise<Record<string, unknown>> => {
        const fresh = (await pool.query<FundingRow>(LOAD, [id])).rows[0] ?? row;
        return ownerView({
          id: fresh.id,
          title: fresh.title,
          category: fresh.category,
          state: fresh.state,
          programAccount: fresh.program_account,
          createdAt: fresh.created_at,
          policyHashHex: bytesToHex(fresh.policy_hash),
          canonicalJson: fresh.canonical_json,
        });
      };

      // Step 6: already projected.
      if (row.state !== "DRAFT" && row.state !== "CANCELLED") {
        return reply.status(200).send(await ownerBody());
      }
      // Step 7: cancelled. The read is best effort; the answer is not.
      if (row.state === "CANCELLED") {
        try {
          const read = await readFundedAccount(projection, row);
          if (read.kind === "FUNDED") projection.alarm("FUNDED_AFTER_CANCEL", row.id);
        } catch {
          // Reported nowhere: the answer below does not depend on it.
        }
        return fail(reply, 409, "BOUNTY_NOT_FUNDABLE");
      }
      // Step 8.
      const result = await projectFunding(projection, id);
      switch (result.outcome) {
        case "PROJECTED":
          return reply.status(200).send(await ownerBody());
        case "NOT_FUNDED":
          return fail(reply, 409, "NOT_FUNDED");
        case "CHAIN_UNAVAILABLE":
          return fail(reply, 503, "CHAIN_UNAVAILABLE");
        case "BINDING_MISMATCH":
          return fail(reply, 409, "BINDING_MISMATCH");
        case "FUNDED_AFTER_CANCEL":
          return fail(reply, 409, "BOUNTY_NOT_FUNDABLE");
        case "NOT_DRAFT":
          // Projected by a concurrent caller between steps 4 and 8.
          return reply.status(200).send(await ownerBody());
      }
    },
  );
}
