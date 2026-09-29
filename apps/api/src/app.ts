import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { Randomness } from "./randomness.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { registerBountyRoutes } from "./bounties/routes.ts";
import type { EligibilityDeps } from "./eligibility/deps.ts";
import { registerVoucherRoutes } from "./eligibility/routes.ts";
import { registerFundingRoutes } from "./funding/routes.ts";
import { registerAcceptanceRoutes } from "./acceptance/routes.ts";
import { registerCaptureRoutes } from "./capture/routes.ts";

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
  // POLICY.md 16.11 (D127): request logs carry the path only. Discovery's
  // query string holds the Scout's position, and the default serializer
  // records the full URL and the remote address.
  const serializers = {
    req: (req: { method?: string; url?: string }) => ({
      method: req.method,
      url: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
    }),
  };
  const logger =
    deps.logger === undefined || deps.logger === false
      ? false
      : deps.logger === true
        ? { serializers }
        : { ...deps.logger, serializers };
  const app = Fastify({ logger });

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
    // POLICY.md 15.4: the report endpoint shares the voucher's chain reader.
    registerFundingRoutes(app, {
      pool: deps.pool,
      config: deps.config,
      clock: deps.clock,
      chain: deps.eligibility.chain,
      programId: deps.eligibility.config.programId,
      programIdBytes: deps.eligibility.config.programIdBytes,
    });
    // POLICY.md 16.8: the acceptance report, on the same chain reader.
    registerAcceptanceRoutes(app, {
      pool: deps.pool,
      config: deps.config,
      clock: deps.clock,
      chain: deps.eligibility.chain,
      programId: deps.eligibility.config.programId,
    });
    // POLICY.md 17.6: deployment_id comes from the configuration account.
    registerCaptureRoutes(app, {
      pool: deps.pool,
      config: deps.config,
      clock: deps.clock,
      randomness: deps.randomness,
      deploymentId: deps.eligibility.deployment.deploymentId,
    });
  }
  return app;
}
