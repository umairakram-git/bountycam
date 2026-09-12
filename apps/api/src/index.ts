import pg from "pg";
import { buildApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig, type Config } from "./config.ts";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
const app = buildApp({ config, pool, clock: systemClock, logger: true });

const port = Number(process.env["PORT"] ?? 3000);
await app.listen({ port, host: "127.0.0.1" });
