import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { Randomness } from "./randomness.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { registerBountyRoutes } from "./bounties/routes.ts";
import type { EligibilityDeps } from "./eligibility/deps.ts";
import { registerVoucherRoutes } from "./eligibility/routes.ts";

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  randomness: Randomness;
  // ELIGIBILITY.md: the voucher route registers only when its dependencies
  // are supplied; suites that never sign build the app without them.
  eligibility?: EligibilityDeps;
  // A stream lets a test capture log output and scan it (POLICY.md test 10);
  // Fastify passes the object to pino unchanged.
  logger?: boolean | { level: string; stream: { write: (msg: string) => void } };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    const code = (error as { code?: string }).code;
    if (
      error instanceof SyntaxError ||
      (typeof code === "string" && code.startsWith("FST_ERR_CTP"))
    ) {
      // Unparseable or wrongly typed body — a body-shape failure per section 6.
      return reply.status(400).send({ error: "INVALID_REQUEST" });
    }
    request.log.error(error);
    return reply.status(500).send({ error: "INTERNAL_ERROR" });
  });

  app.get("/health", async () => ({ ok: true }));

  registerAuthRoutes(app, deps);
  registerBountyRoutes(app, deps);
  if (deps.eligibility !== undefined) {
    registerVoucherRoutes(app, { ...deps, eligibility: deps.eligibility });
  }
  return app;
}
