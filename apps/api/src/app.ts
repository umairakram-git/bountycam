import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import { registerAuthRoutes } from "./auth/routes.ts";

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  logger?: boolean;
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
  return app;
}
