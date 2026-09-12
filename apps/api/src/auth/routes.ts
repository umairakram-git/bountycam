import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { parseSignInMessageText } from "@solana/wallet-standard-util";
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { CHAIN_FORMS } from "./chains.ts";
import { issueToken, verifyToken } from "./jwt.ts";

// AUTH.md section 5.1 (D51).
export const STATEMENT =
  "Sign in to BountyCam. This proves you control this wallet and moves no funds.";

const CHALLENGE_LIFETIME_MS = 300_000;
const MAX_SIGNED_MESSAGE_BYTES = 4096;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface AuthDeps {
  pool: Pool;
  config: Config;
  clock: Clock;
}

interface ChallengeRow {
  domain: string;
  address: string;
  statement: string;
  chain: string;
  issued_at_value: string;
  expiration_time_value: string;
}

interface UserRow {
  id: string;
  wallet_address: string;
  status: string;
}

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.status(status).send({ error: code });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase58Key(address: string): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    return null;
  }
  return bytes.length === 32 ? bytes : null;
}

// RFC 4648 section 4 alphabet with padding; re-encode comparison rejects
// non-canonical input Buffer.from would silently accept.
function decodeBase64Strict(text: string): Buffer | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : null;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { pool, config, clock }: AuthDeps,
): void {
  // AUTH.md section 5.1
  app.post("/auth/siws/challenge", async (request, reply) => {
    const body = request.body;
    if (!isPlainObject(body) || typeof body["address"] !== "string") {
      return fail(reply, 400, "INVALID_REQUEST");
    }
    const chainForm = body["chain"];
    if (chainForm !== undefined && typeof chainForm !== "string") {
      return fail(reply, 400, "INVALID_REQUEST");
    }
    const address = body["address"];
    if (decodeBase58Key(address) === null) {
      return fail(reply, 400, "INVALID_ADDRESS");
    }
    const chain = CHAIN_FORMS.get(chainForm ?? "devnet");
    if (chain === undefined || !config.allowedChains.has(chain)) {
      return fail(reply, 400, "CHAIN_NOT_ALLOWED");
    }

    const nonce = randomBytes(16).toString("hex");
    const issued = clock.now();
    const expires = new Date(issued.getTime() + CHALLENGE_LIFETIME_MS);
    const issuedAt = issued.toISOString();
    const expirationTime = expires.toISOString();
    await pool.query(
      `INSERT INTO auth_challenges
         (nonce, address, domain, chain, statement,
          issued_at_value, expiration_time_value, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        nonce,
        address,
        config.siwsDomain,
        chain,
        STATEMENT,
        issuedAt,
        expirationTime,
        expires,
      ],
    );
    return reply.status(200).send({
      input: {
        domain: config.siwsDomain,
        address,
        statement: STATEMENT,
        version: "1",
        chainId: chain,
        nonce,
        issuedAt,
        expirationTime,
      },
    });
  });

  // AUTH.md section 5.2; the numbered order below is section 6 and is normative.
  app.post("/auth/siws/verify", async (request, reply) => {
    // 1. Body shape.
    const body = request.body;
    if (!isPlainObject(body)) return fail(reply, 400, "INVALID_REQUEST");
    const signedMessage = body["signed_message"];
    const signature = body["signature"];
    const signatureType = body["signature_type"];
    if (typeof signedMessage !== "string" || typeof signature !== "string") {
      return fail(reply, 400, "INVALID_REQUEST");
    }
    if (signatureType !== undefined && typeof signatureType !== "string") {
      return fail(reply, 400, "INVALID_REQUEST");
    }
    const messageBytes = decodeBase64Strict(signedMessage);
    if (messageBytes === null || messageBytes.length > MAX_SIGNED_MESSAGE_BYTES) {
      return fail(reply, 400, "INVALID_REQUEST");
    }
    const signatureBytes = decodeBase64Strict(signature);
    if (signatureBytes === null || signatureBytes.length !== 64) {
      return fail(reply, 400, "INVALID_REQUEST");
    }

    // 2. Signature type.
    if (signatureType !== undefined && signatureType !== "ed25519") {
      return fail(reply, 400, "UNSUPPORTED_SIGNATURE_TYPE");
    }

    // 3. Parse the exact bytes; never rebuild from a template (D39).
    let messageText: string;
    try {
      messageText = new TextDecoder("utf-8", { fatal: true }).decode(messageBytes);
    } catch {
      return fail(reply, 401, "MALFORMED_MESSAGE");
    }
    const parsed = parseSignInMessageText(messageText);
    if (parsed === null) return fail(reply, 401, "MALFORMED_MESSAGE");
    const publicKey =
      parsed.address === undefined ? null : decodeBase58Key(parsed.address);
    if (publicKey === null) return fail(reply, 401, "MALFORMED_MESSAGE");

    // 4. ed25519 over the exact received bytes, before nonce consumption.
    let signatureOk = false;
    try {
      signatureOk = ed25519.verify(signatureBytes, messageBytes, publicKey);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return fail(reply, 401, "SIGNATURE_INVALID");

    // 5. Nonce consumption — one atomic update; the app clock is the bind
    //    parameter, never the database's own current time (D41).
    const now = clock.now();
    const consumed = await pool.query<ChallengeRow>(
      `UPDATE auth_challenges SET consumed_at = $2
        WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING *`,
      [parsed.nonce ?? null, now],
    );
    if (consumed.rowCount === 0) {
      const read = await pool.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM auth_challenges WHERE nonce = $1",
        [parsed.nonce ?? null],
      );
      if (read.rowCount === 0) return fail(reply, 401, "NONCE_UNKNOWN");
      if (read.rows[0]!.consumed_at !== null) {
        return fail(reply, 401, "NONCE_CONSUMED");
      }
      return fail(reply, 401, "NONCE_EXPIRED");
    }
    const challenge = consumed.rows[0]!;

    // 6. Field checks, in order. A failure here leaves the nonce consumed —
    //    deliberate: any failed attempt burns the challenge.
    if (parsed.domain !== challenge.domain) {
      return fail(reply, 401, "DOMAIN_MISMATCH");
    }
    if (parsed.address !== challenge.address) {
      return fail(reply, 401, "ADDRESS_MISMATCH");
    }
    if (parsed.statement !== challenge.statement) {
      return fail(reply, 401, "STATEMENT_MISMATCH");
    }
    if (parsed.version !== "1") {
      return fail(reply, 401, "VERSION_MISMATCH");
    }
    const messageChain =
      parsed.chainId === undefined ? undefined : CHAIN_FORMS.get(parsed.chainId);
    if (messageChain === undefined || messageChain !== challenge.chain) {
      return fail(reply, 401, "CHAIN_NOT_ALLOWED");
    }
    if (parsed.issuedAt !== challenge.issued_at_value) {
      return fail(reply, 401, "ISSUED_AT_MISMATCH");
    }
    if (parsed.expirationTime !== challenge.expiration_time_value) {
      return fail(reply, 401, "EXPIRATION_TIME_MISMATCH");
    }
    if (
      parsed.uri !== undefined ||
      parsed.notBefore !== undefined ||
      parsed.requestId !== undefined ||
      parsed.resources !== undefined
    ) {
      return fail(reply, 401, "UNEXPECTED_FIELD");
    }

    // 7. Upsert returns a row whether or not the user existed (D43).
    const upserted = await pool.query<UserRow>(
      `INSERT INTO users (wallet_address) VALUES ($1)
       ON CONFLICT (wallet_address)
       DO UPDATE SET wallet_address = EXCLUDED.wallet_address
       RETURNING id, wallet_address, status`,
      [parsed.address],
    );
    const user = upserted.rows[0]!;

    // 8. Token.
    const token = await issueToken(config, clock, user.id, user.wallet_address);
    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        wallet_address: user.wallet_address,
        status: user.status,
      },
    });
  });

  // AUTH.md section 5.3
  app.get("/auth/me", async (request, reply) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) {
      return fail(reply, 401, "TOKEN_MISSING");
    }
    const result = await verifyToken(
      config,
      clock,
      header.slice("Bearer ".length),
    );
    if (!result.ok) return fail(reply, 401, result.error);
    const found = await pool.query<UserRow>(
      "SELECT id, wallet_address, status FROM users WHERE id = $1",
      [result.sub],
    );
    const user = found.rows[0];
    if (user === undefined) {
      // Unreachable in Session 6: users are never deleted, and every issued
      // token's subject came from a users row. Fails closed if that changes.
      return fail(reply, 401, "TOKEN_INVALID");
    }
    return reply.status(200).send({
      id: user.id,
      wallet_address: user.wallet_address,
      status: user.status,
    });
  });
}
