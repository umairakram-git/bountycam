import { readFileSync } from "node:fs";

// AUTH.md section 9: SIWS_DOMAIN, SIWS_ALLOWED_CHAINS, JWT_SECRET_PATH,
// JWT_ISSUER, JWT_AUDIENCE — all read once at startup.
export interface Config {
  readonly siwsDomain: string;
  readonly allowedChains: ReadonlySet<string>;
  readonly jwtSecret: Uint8Array;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
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
  return {
    siwsDomain: env["SIWS_DOMAIN"] ?? "app.example.com",
    allowedChains,
    jwtSecret: Uint8Array.from(Buffer.from(hex, "hex")),
    jwtIssuer: env["JWT_ISSUER"] ?? "bountycam-api",
    jwtAudience: env["JWT_AUDIENCE"] ?? "bountycam-app",
  };
}
