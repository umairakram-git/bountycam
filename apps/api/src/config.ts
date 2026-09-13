import { readFileSync } from "node:fs";
import { isBase58For32Bytes } from "./base58.ts";

// AUTH.md section 9: SIWS_DOMAIN, SIWS_ALLOWED_CHAINS, JWT_SECRET_PATH,
// JWT_ISSUER, JWT_AUDIENCE. POLICY.md section 8.1: SOLANA_CLUSTER,
// SETTLEMENT_MINT, ATTESTER_PUBKEYS. All read once at startup; a missing or
// malformed required value exits non-zero before listening, never a 500 later.
export interface Config {
  readonly siwsDomain: string;
  readonly allowedChains: ReadonlySet<string>;
  readonly jwtSecret: Uint8Array;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly cluster: string;
  readonly settlementMint: string;
  readonly attesterPubkeys: ReadonlySet<string>;
}

const SECRET_HEX = /^[0-9a-f]{64}$/;

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

  // POLICY.md section 8.1: comma-separated, strict — no trimming, no empty
  // elements, no duplicates. A malformed list is a loud startup failure,
  // never a silently shorter one.
  const attesterPubkeysRaw = env["ATTESTER_PUBKEYS"];
  if (attesterPubkeysRaw === undefined || attesterPubkeysRaw === "") {
    throw new Error("ATTESTER_PUBKEYS is not set");
  }
  const attesterList = attesterPubkeysRaw.split(",");
  if (attesterList.length < 1) {
    throw new Error("ATTESTER_PUBKEYS must contain at least one key");
  }
  for (const key of attesterList) {
    if (!isBase58For32Bytes(key)) {
      throw new Error(
        "ATTESTER_PUBKEYS must be comma-separated base58 keys, each exactly 32 bytes",
      );
    }
  }
  const attesterPubkeys = new Set(attesterList);
  if (attesterPubkeys.size !== attesterList.length) {
    throw new Error("ATTESTER_PUBKEYS must not contain duplicate keys");
  }

  return {
    siwsDomain: env["SIWS_DOMAIN"] ?? "app.example.com",
    allowedChains,
    jwtSecret: Uint8Array.from(Buffer.from(hex, "hex")),
    jwtIssuer: env["JWT_ISSUER"] ?? "bountycam-api",
    jwtAudience: env["JWT_AUDIENCE"] ?? "bountycam-app",
    cluster: env["SOLANA_CLUSTER"] ?? "devnet",
    settlementMint,
    attesterPubkeys,
  };
}
