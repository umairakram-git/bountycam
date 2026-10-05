// POLICY.md section 19.4 (D147): the verifier process. Started by scripts/verifier.sh;
// listens on no port; one instance. Holds the attester and relayer keys, which the API
// process never loads. Logs one JSON line per outcome and never a URL, store key,
// coordinate, message or key material.
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { base58 } from "@scure/base";
import { systemClock } from "../clock.ts";
import {
  jsonRpcChainReader,
  jsonRpcChainWriter,
  jsonRpcSettlementReader,
} from "../chain/rpc.ts";
import { s3EvidenceStore } from "../evidence/store.ts";
import { checkConfigAccount, loadVerifierConfig, type VerifierConfig } from "./config.ts";
import { tick, type VerifierDeps } from "./run.ts";

function log(level: "info" | "error", fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

let config: VerifierConfig;
try {
  config = loadVerifierConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const chain = jsonRpcChainReader(config.rpcUrl, fetch);
const writer = jsonRpcChainWriter(config.rpcUrl, fetch);

let deploymentId: number;
let usdcMint: Uint8Array;
try {
  const configInfo = await chain.getAccount(config.configAccount);
  deploymentId = checkConfigAccount(configInfo, config);
  // POLICY.md 20.7: the configured mint, Config bytes 9..41, for the release pass.
  usdcMint = (configInfo as { data: Uint8Array }).data.slice(9, 41);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(`deployment_id: ${deploymentId}`);
console.log(`attester: ${base58.encode(config.attesterPubkey)}`);
console.log(`relayer:  ${base58.encode(config.relayerPubkey)}`);

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const deps: VerifierDeps = {
  pool,
  clock: systemClock,
  chain,
  writer,
  // Upload URLs are never issued here, so the TTL is unused; 900 is section 18.3's default.
  store: s3EvidenceStore(config.store, 900, fetch),
  programId: config.programId,
  programIdBytes: config.programIdBytes,
  configAccount: config.configAccount,
  deploymentId,
  attesterSeed: config.attesterSeed,
  attesterPubkey: config.attesterPubkey,
  relayerSeed: config.relayerSeed,
  maxBytes: config.maxBytes,
  maxAccuracyM: config.maxAccuracyM,
  deadlineMarginS: config.deadlineMarginS,
  confirmS: config.confirmS,
  sleep: async (ms) => {
    await sleep(ms);
  },
  log,
  // POLICY.md 20.6 (D159): the settlement pass and its release sends.
  release: {
    pool,
    clock: systemClock,
    chain,
    writer,
    settlement: jsonRpcSettlementReader(config.rpcUrl, fetch),
    programId: config.programId,
    programIdBytes: config.programIdBytes,
    configAccount: config.configAccount,
    usdcMint,
    relayerSeed: config.relayerSeed,
    releaseMarginS: config.releaseMarginS,
    confirmS: config.confirmS,
    sleep: async (ms) => {
      await sleep(ms);
    },
    log,
    retries: new Map(),
  },
};

console.log(`verifier: polling every ${config.pollS} s`);
for (;;) {
  try {
    await tick(deps);
  } catch (error) {
    log("error", { tick: error instanceof Error ? error.name : "error" });
  }
  await sleep(config.pollS * 1000);
}
