// ELIGIBILITY.md sections 3 and 5: the values the voucher path needs beyond
// config.ts. A second strict parser rather than an extension of loadConfig,
// so the existing suites build the app without a key file. All read once at
// startup; a missing or malformed value exits before listening, never a 500
// later. No error message includes a file's content or the RPC URL, which
// may carry a provider key.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { isBase58For32Bytes } from "../base58.ts";

export interface EligibilityConfig {
  readonly rpcUrl: string;
  readonly programId: string; // base58
  readonly programIdBytes: Uint8Array; // 32
  readonly configAccount: string; // base58
  readonly keySeed: Uint8Array; // 32, ed25519 seed
  readonly keyPubkey: Uint8Array; // 32
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(name + " is not set");
  return value;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function loadEligibilityConfig(
  env: Record<string, string | undefined>,
): EligibilityConfig {
  const rpcUrl = required(env, "SOLANA_RPC_URL");
  if (!rpcUrl.startsWith("https://")) {
    throw new Error("SOLANA_RPC_URL must begin with https://");
  }
  const programId = required(env, "ESCROW_PROGRAM_ID");
  if (!isBase58For32Bytes(programId)) {
    throw new Error("ESCROW_PROGRAM_ID must be base58 for exactly 32 bytes");
  }
  const configAccount = required(env, "ESCROW_CONFIG_ACCOUNT");
  if (!isBase58For32Bytes(configAccount)) {
    throw new Error("ESCROW_CONFIG_ACCOUNT must be base58 for exactly 32 bytes");
  }
  const keyPath = required(env, "ELIGIBILITY_KEY_PATH");
  // Solana keypair file: a JSON array of 64 integers, seed then public key.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    throw new Error("ELIGIBILITY_KEY_PATH could not be read as JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error("eligibility key file must be a JSON array of 64 bytes");
  }
  const bytes = Uint8Array.from(parsed as number[]);
  const keySeed = bytes.slice(0, 32);
  const keyPubkey = bytes.slice(32, 64);
  if (!bytesEqual(ed25519.getPublicKey(keySeed), keyPubkey)) {
    throw new Error("eligibility key file's public half does not match its seed");
  }
  return {
    rpcUrl,
    programId,
    programIdBytes: base58.decode(programId),
    configAccount,
    keySeed,
    keyPubkey,
  };
}

// ELIGIBILITY.md section 5.3: the Seeker check's mainnet endpoint, as a full URL
// whose query carries the provider key — never a bare key. A separate reader from
// loadEligibilityConfig, so the suites that build that config never need it;
// index.ts reads it before listening, and startup confirms the cluster.
export function loadSeekerRpcUrl(env: Record<string, string | undefined>): string {
  const url = required(env, "SEEKER_RPC_URL");
  if (!url.startsWith("https://")) {
    throw new Error("SEEKER_RPC_URL must begin with https://");
  }
  return url;
}
