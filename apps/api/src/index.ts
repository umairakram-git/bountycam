import pg from "pg";
import { buildApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig, type Config } from "./config.ts";
import { systemRandomness } from "./randomness.ts";
import { base58 } from "@scure/base";
import { loadEligibilityConfig, type EligibilityConfig } from "./chain/config.ts";
import { resolveDeployment, type Deployment } from "./chain/deployment.ts";
import { jsonRpcChainReader } from "./chain/rpc.ts";
import { eligibilitySigner } from "./chain/signer.ts";
import type { SeekerCheck } from "./eligibility/deps.ts";
import { startReservationSweeper } from "./eligibility/sweeper.ts";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let eligibility: EligibilityConfig;
try {
  eligibility = loadEligibilityConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const chain = jsonRpcChainReader(eligibility.rpcUrl, fetch);
const signer = eligibilitySigner(eligibility.keySeed);

// ELIGIBILITY.md section 3: deployment_id comes from the configuration
// account, read once at startup. The on-chain eligibility_authority must be
// this process's key and usdc_mint must be SETTLEMENT_MINT, or the process
// exits before listening. Both logged values are public.
let deployment: Deployment;
try {
  deployment = await resolveDeployment(chain, eligibility, config.settlementMint);
  console.log(`deployment_id: ${deployment.deploymentId}`);
  console.log(`eligibility authority: ${base58.encode(signer.pubkey)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// ELIGIBILITY.md section 5.1: the Seeker check ships in the next commit.
// Until then every A4_SEEKER_V1 voucher request answers
// SEEKER_CHECK_UNAVAILABLE, the code the specification gives a check that
// could not be performed. BASE_V1 bounties are unaffected.
const seeker: SeekerCheck = {
  findSeekerMint: async () => {
    throw new Error("Seeker check not yet implemented");
  },
};

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
const app = buildApp({
  config,
  pool,
  clock: systemClock,
  randomness: systemRandomness,
  logger: true,
  eligibility: { config: eligibility, deployment, chain, signer, seeker },
});

const port = Number(process.env["PORT"] ?? 3000);
await app.listen({ port, host: "127.0.0.1" });

// ELIGIBILITY.md section 6.1, the first writer. unref'd, so it never keeps
// the process alive on its own.
startReservationSweeper(pool, systemClock, (error) => app.log.error(error));
