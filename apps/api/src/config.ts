import { readFileSync } from "node:fs";
import { isBase58For32Bytes } from "./base58.ts";

// AUTH.md section 9: SIWS_DOMAIN, SIWS_ALLOWED_CHAINS, JWT_SECRET_PATH,
// JWT_ISSUER, JWT_AUDIENCE. POLICY.md section 8.1: SOLANA_CLUSTER,
// SETTLEMENT_MINT. All read once at startup; a missing or malformed required
// value exits non-zero before listening, never a 500 later.
//
// ATTESTER_PUBKEYS is deliberately absent (D108). The policy carries no
// attester, so the variable is neither read nor validated; leaving it set in an
// environment file has no effect.
// POLICY.md section 17.3 (D132, D133): the capture nonce's timing and the
// start gate's limits. Operational configuration, never policy fields.
export interface CaptureConfig {
  readonly nonceLifetimeS: number;
  readonly deadlineBufferS: number;
  readonly minWindowS: number;
  readonly submissionGraceS: number;
  readonly maxLocationAccuracyM: number;
  readonly locationFixTimeoutS: number;
  readonly maxLocationAgeS: number;
}

export interface Config {
  readonly siwsDomain: string;
  readonly allowedChains: ReadonlySet<string>;
  readonly jwtSecret: Uint8Array;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly cluster: string;
  readonly settlementMint: string;
  readonly capture: CaptureConfig;
}

const SECRET_HEX = /^[0-9a-f]{64}$/;
// A positive integer: no sign, no leading zero, no fraction, at most nine
// digits so the value stays well inside the safe integer range.
const POSITIVE_INT = /^[1-9][0-9]{0,8}$/;

function positiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!POSITIVE_INT.test(raw)) throw new Error(`${key} must be a positive integer`);
  return Number(raw);
}

// Section 17.3: seven optional keys and two invariants, checked before listening.
export function loadCaptureConfig(env: Record<string, string | undefined>): CaptureConfig {
  const capture: CaptureConfig = {
    nonceLifetimeS: positiveInt(env, "CAPTURE_NONCE_LIFETIME_S", 1200),
    deadlineBufferS: positiveInt(env, "CAPTURE_DEADLINE_BUFFER_S", 600),
    minWindowS: positiveInt(env, "CAPTURE_MIN_WINDOW_S", 600),
    submissionGraceS: positiveInt(env, "CAPTURE_SUBMISSION_GRACE_S", 480),
    maxLocationAccuracyM: positiveInt(env, "LOCATION_MAX_ACCURACY_M", 200),
    locationFixTimeoutS: positiveInt(env, "LOCATION_FIX_TIMEOUT_S", 10),
    maxLocationAgeS: positiveInt(env, "LOCATION_MAX_AGE_S", 30),
  };
  if (capture.nonceLifetimeS < capture.minWindowS) {
    throw new Error("CAPTURE_NONCE_LIFETIME_S must be at least CAPTURE_MIN_WINDOW_S");
  }
  if (capture.submissionGraceS >= capture.deadlineBufferS) {
    throw new Error("CAPTURE_SUBMISSION_GRACE_S must be less than CAPTURE_DEADLINE_BUFFER_S");
  }
  return capture;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const secretPath = env["JWT_SECRET_PATH"];
  if (secretPath === undefined || secretPath === "") {
    throw new Error("JWT_SECRET_PATH is not set");
  }
  // The error messages below never include the file's content.
  const hex = readFileSync(secretPath, "utf8").trim();
  if (!SECRET_HEX.test(hex)) {
    throw new Error(
      "JWT secret file must contain exactly 64 lowercase hex characters",
    );
  }
  const allowedChains = new Set(
    (env["SIWS_ALLOWED_CHAINS"] ?? "devnet")
      .split(",")
      .map((chain) => chain.trim())
      .filter((chain) => chain.length > 0),
  );

  const settlementMint = env["SETTLEMENT_MINT"];
  if (settlementMint === undefined || settlementMint === "") {
    throw new Error("SETTLEMENT_MINT is not set");
  }
  if (!isBase58For32Bytes(settlementMint)) {
    throw new Error("SETTLEMENT_MINT must be base58 for exactly 32 bytes");
  }

  return {
    siwsDomain: env["SIWS_DOMAIN"] ?? "app.example.com",
    allowedChains,
    jwtSecret: Uint8Array.from(Buffer.from(hex, "hex")),
    jwtIssuer: env["JWT_ISSUER"] ?? "bountycam-api",
    jwtAudience: env["JWT_AUDIENCE"] ?? "bountycam-app",
    cluster: env["SOLANA_CLUSTER"] ?? "devnet",
    settlementMint,
    capture: loadCaptureConfig(env),
  };
}
