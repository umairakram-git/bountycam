// ELIGIBILITY.md sections 3, 4 and 7: POST /bounties/:id/voucher, the ten-step
// check order. State comes from the chain, not the database (3.1); the
// database projection must agree with it (2.6). Two mappings this document
// leaves to the implementation, stated here: a visible bounty with no
// program_account, or whose account no longer exists, is BOUNTY_NOT_ACCEPTABLE
// — nothing on chain is Funded; an account that exists but fails the decoder
// is BINDING_MISMATCH — the projection points at something that is not a
// bounty.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { base58 } from "@scure/base";
import { eligibilityMessage } from "@hackathon/shared";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { UUID_FORM } from "../bounties/extract.ts";
import { decodeBountyAccount } from "../chain/bounty.ts";
import { bytesEqual } from "../chain/config.ts";
import { ChainError } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { EligibilityDeps } from "./deps.ts";
import { profileIdForHash, profileRequiresSgt } from "./registry.ts";
import { reserve } from "./reservation.ts";

export interface VoucherDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
  eligibility: EligibilityDeps;
}

// Section 4.1: the SIWS challenge lifetime, deliberately the same figure.
export const VOUCHER_LIFETIME_SECONDS = 300n;

interface VoucherRow {
  id: string;
  requester_id: string;
  state: string;
  program_account: string | null;
  policy_hash: Buffer;
  eligibility_profile_id: string;
  required_assurance: number;
}

function fail(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ error: code });
}

export function registerVoucherRoutes(app: FastifyInstance, deps: VoucherDeps): void {
  const { pool, config, clock } = deps;
  const { chain, signer, deployment, seeker } = deps.eligibility;
  const programId = deps.eligibility.config.programId;
  const programIdBytes = deps.eligibility.config.programIdBytes;
  const requireAuth = makeRequireAuth(config, clock);
  const authority = base58.encode(signer.pubkey);

  app.post<{ Params: { id: string } }>(
    "/bounties/:id/voucher",
    { preHandler: requireAuth },
    async (request, reply) => {
      // Step 1 ran as the preHandler. A body is ignored, not rejected (3).
      const caller = authUser(request);

      // Step 2: exists and visible, the section 8.5 rule — a malformed id,
      // an absent row, and a hidden state are all NOT_FOUND.
      const { id } = request.params;
      if (!UUID_FORM.test(id)) return fail(reply, 404, "NOT_FOUND");
      const loaded = await pool.query<VoucherRow>(
        `SELECT b.id, b.requester_id, b.state, b.program_account,
                p.policy_hash, p.eligibility_profile_id, p.required_assurance
         FROM bounties b
         JOIN policies p ON p.id = b.policy_id
         WHERE b.id = $1`,
        [id],
      );
      const row = loaded.rows[0];
      if (row === undefined) return fail(reply, 404, "NOT_FOUND");
      const isRequester = row.requester_id === caller.id;
      if (!isRequester && (row.state === "DRAFT" || row.state === "CANCELLED")) {
        return fail(reply, 404, "NOT_FOUND");
      }

      // Step 3: before any chain read, deliberately (4).
      if (isRequester) return fail(reply, 403, "SCOUT_IS_REQUESTER");

      // Step 4: the bounty account at confirmed.
      if (row.program_account === null) {
        return fail(reply, 409, "BOUNTY_NOT_ACCEPTABLE");
      }
      let info;
      try {
        info = await chain.getAccount(row.program_account);
      } catch (error) {
        if (error instanceof ChainError) return fail(reply, 503, "CHAIN_UNAVAILABLE");
        throw error;
      }
      if (info === null) return fail(reply, 409, "BOUNTY_NOT_ACCEPTABLE");
      const decoded = decodeBountyAccount(info, programId);
      if (!decoded.ok) return fail(reply, 409, "BINDING_MISMATCH");
      const bounty = decoded.bounty;

      // Step 5.
      if (bounty.state !== "Funded") return fail(reply, 409, "BOUNTY_NOT_ACCEPTABLE");

      // Step 6: the app clock, in whole seconds, at or before the cutoff.
      const now = clock.now();
      const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
      if (nowSeconds > bounty.acceptanceCutoff) {
        return fail(reply, 409, "ACCEPTANCE_WINDOW_CLOSED");
      }

      // Step 7: the section 2.6 register. The profile row is judged through
      // the registry: a known hash that names a different id than the
      // projection is a mismatch; a hash matching nothing is left for step 8.
      if (!bytesEqual(Uint8Array.from(row.policy_hash), bounty.policyHash)) {
        return fail(reply, 409, "BINDING_MISMATCH");
      }
      if (row.required_assurance !== bounty.requiredAssurance) {
        return fail(reply, 409, "BINDING_MISMATCH");
      }
      const profileId = profileIdForHash(bounty.eligibilityProfileHash);
      if (profileId !== undefined && profileId !== row.eligibility_profile_id) {
        return fail(reply, 409, "BINDING_MISMATCH");
      }

      // Step 8: profile qualification (5). Registry membership, the base
      // check, then the Seeker check for the profile that requires it.
      if (profileId === undefined) return fail(reply, 409, "PROFILE_UNKNOWN");
      const user = await pool.query<{ status: string }>(
        "SELECT status FROM users WHERE id = $1",
        [caller.id],
      );
      if (user.rows[0]?.status !== "ACTIVE") return fail(reply, 403, "ACCOUNT_NOT_ACTIVE");
      let seekerMint: string | null = null;
      if (profileRequiresSgt(profileId)) {
        try {
          seekerMint = await seeker.findSeekerMint(caller.wallet);
        } catch {
          return fail(reply, 503, "SEEKER_CHECK_UNAVAILABLE");
        }
        if (seekerMint === null) return fail(reply, 403, "SEEKER_NOT_HELD");
      }

      // Section 4.1: the earlier of clock plus 300 and the cutoff. The
      // reservation expires at the same instant.
      const lifetimeEnd = nowSeconds + VOUCHER_LIFETIME_SECONDS;
      const expiresAt =
        lifetimeEnd < bounty.acceptanceCutoff ? lifetimeEnd : bounty.acceptanceCutoff;
      const expiresAtDate = new Date(Number(expiresAt) * 1000);

      // Step 9: the reservation, after qualification (6).
      const outcome = await reserve(pool, {
        bountyId: row.id,
        scoutId: caller.id,
        now,
        expiresAt: expiresAtDate,
        seekerMint,
      });
      if (outcome.kind === "taken") return fail(reply, 409, "BOUNTY_RESERVED");
      if (outcome.kind === "claimed_elsewhere") {
        return fail(reply, 403, "SEEKER_ALREADY_CLAIMED");
      }

      // Step 10: build from the chain read and the caller, sign, respond.
      const message = eligibilityMessage({
        deploymentId: deployment.deploymentId,
        programId: programIdBytes,
        bountyId: bounty.bountyId,
        requester: bounty.requester,
        scout: base58.decode(caller.wallet),
        policyHash: bounty.policyHash,
        eligibilityProfileHash: bounty.eligibilityProfileHash,
        requiredAssurance: bounty.requiredAssurance,
        expiresAt,
      });
      const signature = signer.sign(message);
      return reply.status(200).send({
        message: Buffer.from(message).toString("base64"),
        signature: Buffer.from(signature).toString("base64"),
        expires_at: Number(expiresAt),
        authority,
      });
    },
  );
}
