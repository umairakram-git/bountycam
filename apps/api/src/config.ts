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

// POLICY.md section 18.3 (D140): the evidence store and the photo limits. The four store keys
// go together: all set is a store, none set is no store, anything else exits at startup.
export interface EvidenceStoreConfig {
  /** The origin, exactly: scheme, host and port, no path. */
  readonly endpoint: string;
  /** The endpoint's host and port, as signed into every request. */
  readonly host: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface EvidenceConfig {
  readonly store: EvidenceStoreConfig | null;
  readonly maxBytes: number;
  readonly uploadUrlTtlS: number;
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
  /** Optional in the type, so hand-built test configurations stay valid. */
  readonly evidence?: EvidenceConfig;
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

const STORE_KEYS = [
  "EVIDENCE_STORE_ENDPOINT",
  "EVIDENCE_STORE_BUCKET",
  "EVIDENCE_STORE_ACCESS_KEY_ID",
  "EVIDENCE_STORE_SECRET_PATH",
] as const;
const BUCKET = /^[a-z0-9-]{3,63}$/;
const PRINTABLE = /^[\x21-\x7e]{1,128}$/;
const REGION = /^[a-z0-9-]{1,32}$/;

// Section 18.3. The secret's content never appears in an error message.
export function loadEvidenceConfig(env: Record<string, string | undefined>): EvidenceConfig {
  const set = STORE_KEYS.filter((k) => env[k] !== undefined && env[k] !== "");
  if (set.length !== 0 && set.length !== STORE_KEYS.length) {
    throw new Error(
      "EVIDENCE_STORE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_PATH go together",
    );
  }
  const uploadUrlTtlS = positiveInt(env, "EVIDENCE_UPLOAD_URL_TTL_S", 900);
  if (uploadUrlTtlS > 900) throw new Error("EVIDENCE_UPLOAD_URL_TTL_S must be at most 900 (D4)");
  const maxBytes = positiveInt(env, "EVIDENCE_MAX_BYTES", 10485760);
  if (set.length === 0) return { store: null, maxBytes, uploadUrlTtlS };

  const endpointText = env["EVIDENCE_STORE_ENDPOINT"] as string;
  let url: URL;
  try {
    url = new URL(endpointText);
  } catch {
    throw new Error("EVIDENCE_STORE_ENDPOINT is not a URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== endpointText) {
    throw new Error("EVIDENCE_STORE_ENDPOINT must be an http or https origin with no path");
  }
  const bucket = env["EVIDENCE_STORE_BUCKET"] as string;
  if (!BUCKET.test(bucket)) throw new Error("EVIDENCE_STORE_BUCKET is malformed");
  const accessKeyId = env["EVIDENCE_STORE_ACCESS_KEY_ID"] as string;
  if (!PRINTABLE.test(accessKeyId)) throw new Error("EVIDENCE_STORE_ACCESS_KEY_ID is malformed");
  const secretAccessKey = readFileSync(env["EVIDENCE_STORE_SECRET_PATH"] as string, "utf8").trim();
  if (!PRINTABLE.test(secretAccessKey)) {
    throw new Error("the evidence store secret file must hold one printable line");
  }
  const region = env["EVIDENCE_STORE_REGION"] || "us-east-1";
  if (!REGION.test(region)) throw new Error("EVIDENCE_STORE_REGION is malformed");
  return {
    store: { endpoint: url.origin, host: url.host, bucket, accessKeyId, secretAccessKey, region },
    maxBytes,
    uploadUrlTtlS,
  };
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
    evidence: loadEvidenceConfig(env),
  };
}
