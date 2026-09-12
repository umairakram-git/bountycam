import { SignJWT, jwtVerify, errors } from "jose";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";

// AUTH.md section 9: 7 days (D6).
const TOKEN_LIFETIME_MS = 604_800_000;
// AUTH.md section 8: 60-second tolerance, JWT time claims only.
const CLOCK_TOLERANCE_SECONDS = 60;

export async function issueToken(
  config: Config,
  clock: Clock,
  userId: string,
  wallet: string,
): Promise<string> {
  const now = clock.now();
  return new SignJWT({ wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt(now)
    .setExpirationTime(new Date(now.getTime() + TOKEN_LIFETIME_MS))
    .sign(config.jwtSecret);
}

export type TokenResult =
  | { ok: true; sub: string; wallet: string }
  | { ok: false; error: "TOKEN_INVALID" | "TOKEN_EXPIRED" };

export async function verifyToken(
  config: Config,
  clock: Clock,
  token: string,
): Promise<TokenResult> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: clock.now(),
    });
    const wallet = payload["wallet"];
    if (typeof payload.sub !== "string" || typeof wallet !== "string") {
      return { ok: false, error: "TOKEN_INVALID" };
    }
    return { ok: true, sub: payload.sub, wallet };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, error: "TOKEN_EXPIRED" };
    }
    return { ok: false, error: "TOKEN_INVALID" };
  }
}
