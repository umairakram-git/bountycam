import pg from "pg";
import { buildApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig, type Config } from "./config.ts";
import { systemRandomness } from "./randomness.ts";
import { base58 } from "@scure/base";
import {
  loadEligibilityConfig,
  loadSeekerRpcUrl,
  type EligibilityConfig,
} from "./chain/config.ts";
import { resolveDeployment, type Deployment } from "./chain/deployment.ts";
import { jsonRpcChainReader } from "./chain/rpc.ts";
import { eligibilitySigner } from "./chain/signer.ts";
import { assertMainnet, heliusSeekerCheck } from "./eligibility/seeker.ts";
import { SWEEP_INTERVAL_MS, startReservationSweeper } from "./eligibility/sweeper.ts";
import { projectAcceptance } from "./acceptance/project.ts";
import { startFundingSweeper } from "./funding/sweeper.ts";

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
let seekerRpcUrl: string;
try {
  seekerRpcUrl = loadSeekerRpcUrl(process.env);
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

// ELIGIBILITY.md section 5.3: the Seeker endpoint must be mainnet-beta, or
// every check would find an empty wallet and refuse genuine owners. Checked
// once, before listening. The logged line carries no part of the URL.
try {
  await assertMainnet(seekerRpcUrl, fetch);
  console.log("seeker rpc: mainnet-beta genesis confirmed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const seeker = heliusSeekerCheck(seekerRpcUrl, fetch, systemClock);

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
// POLICY.md 16.7: it projects each expired reservation's bounty before flipping.
startReservationSweeper(pool, systemClock, (error) => app.log.error(error), SWEEP_INTERVAL_MS,
  (bountyId) =>
    projectAcceptance(
      {
        pool,
        chain,
        programId: eligibility.programId,
        alarm: (outcome, id) => app.log.error({ outcome, bountyId: id }, "acceptance alarm"),
      },
      bountyId,
    ),
);

// POLICY.md 15.5: the funding sweep, the backstop for a lost report.
startFundingSweeper(
  {
    pool,
    chain,
    programId: eligibility.programId,
    programIdBytes: eligibility.programIdBytes,
    alarm: (outcome, bountyId) => app.log.error({ outcome, bountyId }, "funding alarm"),
  },
  systemClock,
  (error) => app.log.error(error),
);
