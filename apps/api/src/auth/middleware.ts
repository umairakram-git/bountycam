import type { FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { verifyToken } from "./jwt.ts";

// POLICY.md section 8.1: GET /auth/me's verification, unchanged — HS256 only,
// iss and aud checked, 60-second tolerance, all inside verifyToken. The token
// carries sub and wallet, so authentication needs no database read; handlers
// read the caller's identity via authUser() and nowhere else.
// GET /auth/me itself is untouched: its user lookup returns status, which the
// token does not carry.

export interface AuthUser {
  readonly id: string;
  readonly wallet: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export function makeRequireAuth(
  config: Config,
  clock: Clock,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "TOKEN_MISSING" });
    }
    const result = await verifyToken(
      config,
      clock,
      header.slice("Bearer ".length),
    );
    if (!result.ok) {
      return reply.status(401).send({ error: result.error });
    }
    request.authUser = { id: result.sub, wallet: result.wallet };
  };
}

// The only sanctioned read of the decoration. Handlers receive a non-optional
// AuthUser, so there is no optional in handler scope for a non-null assertion
// to silence. The throw is reachable only on a route that skipped
// makeRequireAuth — a wiring bug, which fails closed as a 500 and cannot
// survive the endpoint's 401 tests.
export function authUser(request: FastifyRequest): AuthUser {
  if (request.authUser === undefined) {
    throw new Error("authUser read on a route without requireAuth");
  }
  return request.authUser;
}
