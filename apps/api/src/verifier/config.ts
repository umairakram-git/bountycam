// POLICY.md sections 19.3 and 19.4 (D147, D152): the verifier's configuration. Its own
// loader, so the API's loadConfig never reads either key path and the API process never
// holds the attester or relayer key. No error message includes a file's content or the
// RPC URL, which may carry a provider key.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { isBase58For32Bytes } from "../base58.ts";
import { bytesEqual } from "../chain/config.ts";
import { CONFIG_DISCRIMINATOR, CONFIG_LENGTH } from "../chain/deployment.ts";
import type { AccountInfo } from "../chain/rpc.ts";
import {
  loadCaptureConfig,
  loadEvidenceConfig,
  type EvidenceStoreConfig,
} from "../config.ts";

export interface VerifierConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly programId: string;
  readonly programIdBytes: Uint8Array;
  readonly configAccount: string;
  readonly store: EvidenceStoreConfig;
  readonly maxBytes: number;
  readonly maxAccuracyM: number;
  readonly attesterSeed: Uint8Array;
  readonly attesterPubkey: Uint8Array;
  readonly relayerSeed: Uint8Array;
  readonly relayerPubkey: Uint8Array;
  readonly pollS: number;
  readonly deadlineMarginS: number;
  readonly confirmS: number;
  /** POLICY.md 20.11 (D159): VERIFIER_RELEASE_MARGIN_S, default 10. */
  readonly releaseMarginS: number;
}

const POSITIVE_INT = /^[1-9][0-9]{0,8}$/;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(name + " is not set");
  return value;
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!POSITIVE_INT.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

/** A Solana keypair file: a JSON array of 64 bytes, seed then public key. */
function readKeypair(path: string, name: string): { seed: Uint8Array; pubkey: Uint8Array } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(name + " could not be read as JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(name + " must hold a JSON array of 64 bytes");
  }
  const bytes = Uint8Array.from(parsed as number[]);
  const seed = bytes.slice(0, 32);
  const pubkey = bytes.slice(32, 64);
  if (!bytesEqual(ed25519.getPublicKey(seed), pubkey)) {
    throw new Error(name + "'s public half does not match its seed");
  }
  return { seed, pubkey };
}

export function loadVerifierConfig(env: Record<string, string | undefined>): VerifierConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  const rpcUrl = required(env, "SOLANA_RPC_URL");
  if (!rpcUrl.startsWith("https://")) throw new Error("SOLANA_RPC_URL must begin with https://");
  const programId = required(env, "ESCROW_PROGRAM_ID");
  if (!isBase58For32Bytes(programId)) {
    throw new Error("ESCROW_PROGRAM_ID must be base58 for exactly 32 bytes");
  }
  const configAccount = required(env, "ESCROW_CONFIG_ACCOUNT");
  if (!isBase58For32Bytes(configAccount)) {
    throw new Error("ESCROW_CONFIG_ACCOUNT must be base58 for exactly 32 bytes");
  }
  const evidence = loadEvidenceConfig(env);
  if (evidence.store === null) throw new Error("the verifier needs the evidence store keys");
  const capture = loadCaptureConfig(env);
  const attester = readKeypair(required(env, "ATTESTER_KEY_PATH"), "ATTESTER_KEY_PATH");
  const relayer = readKeypair(required(env, "RELAYER_KEY_PATH"), "RELAYER_KEY_PATH");
  if (bytesEqual(attester.pubkey, relayer.pubkey)) {
    throw new Error("the relayer key must differ from the attester key");
  }
  const pollS = positiveInt(env, "VERIFIER_POLL_S", 5);
  const deadlineMarginS = positiveInt(env, "VERIFIER_DEADLINE_MARGIN_S", 30);
  const confirmS = positiveInt(env, "VERIFIER_CONFIRM_S", 60);
  const releaseMarginS = positiveInt(env, "VERIFIER_RELEASE_MARGIN_S", 10);
  if (deadlineMarginS >= capture.deadlineBufferS - capture.submissionGraceS) {
    throw new Error(
      "VERIFIER_DEADLINE_MARGIN_S must be less than " +
        "CAPTURE_DEADLINE_BUFFER_S - CAPTURE_SUBMISSION_GRACE_S (D152)",
    );
  }
  return {
    databaseUrl,
    rpcUrl,
    programId,
    programIdBytes: base58.decode(programId),
    configAccount,
    store: evidence.store,
    maxBytes: evidence.maxBytes,
    maxAccuracyM: capture.maxLocationAccuracyM,
    attesterSeed: attester.seed,
    attesterPubkey: attester.pubkey,
    relayerSeed: relayer.seed,
    relayerPubkey: relayer.pubkey,
    pollS,
    deadlineMarginS,
    confirmS,
    releaseMarginS,
  };
}

/**
 * Section 19.3's startup check against the configuration account: it exists, is the
 * program's, is a Config account, and names this process's attester. Returns the
 * deployment id. Throws otherwise.
 */
export function checkConfigAccount(
  info: AccountInfo | null,
  config: Pick<VerifierConfig, "programId" | "attesterPubkey">,
): number {
  if (info === null) throw new Error("configuration account not found");
  if (info.owner !== config.programId) {
    throw new Error("configuration account is not owned by the escrow program");
  }
  const d = info.data;
  if (d.length !== CONFIG_LENGTH || !bytesEqual(d.slice(0, 8), CONFIG_DISCRIMINATOR)) {
    throw new Error("configuration account is not a Config account");
  }
  if (!bytesEqual(d.slice(73, 105), config.attesterPubkey)) {
    throw new Error("on-chain attester_authority is not this process's attester key");
  }
  return d[8] as number;
}
