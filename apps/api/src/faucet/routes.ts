// D167: POST /faucet. A signed-in wallet receives devnet SOL for fees and test USDC for
// funding, once per cooldown, within a daily cap across all wallets. The grant row is
// written before anything is sent, under a per-user advisory lock, so a double tap or a
// retry cannot mint twice.
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { base58 } from "@scure/base";
import { authUser, makeRequireAuth } from "../auth/middleware.ts";
import { signedWire } from "../chain/tx.ts";
import type { ChainWriter } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { FaucetConfig } from "./config.ts";
import { faucetMessage } from "./tx.ts";

export interface FaucetDeps {
  readonly faucet: FaucetConfig;
  readonly writer: ChainWriter;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FaucetRouteDeps extends FaucetDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly clock: Clock;
}

const STATUS_POLL_MS = 1000;
const DAY_MS = 86_400_000;

const decimal = (base: bigint, places: number): string => {
  const s = base.toString().padStart(places + 1, "0");
  const whole = s.slice(0, s.length - places);
  const frac = s.slice(s.length - places).replace(/0+$/, "");
  return frac.length === 0 ? whole : whole + "." + frac;
};

export function registerFaucetRoutes(app: FastifyInstance, deps: FaucetRouteDeps): void {
  const { pool, clock, faucet, writer } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const requireAuth = makeRequireAuth(deps.config, clock);

  app.post("/faucet", { preHandler: requireAuth }, async (request, reply) => {
    const caller = authUser(request);
    let recipient: Uint8Array;
    try {
      recipient = base58.decode(caller.wallet);
    } catch {
      return reply.status(400).send({ error: "INVALID_WALLET" });
    }
    if (recipient.length !== 32) return reply.status(400).send({ error: "INVALID_WALLET" });

    // Reserve the grant: cooldown, then the daily cap, then the PENDING row, in one
    // transaction under a lock on this user.
    const now = clock.now();
    const client = await pool.connect();
    let grantId: string;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["faucet:" + caller.id]);
      const last = await client.query<{ granted_at: Date }>(
        `SELECT granted_at FROM faucet_grants
         WHERE user_id = $1 AND status <> 'FAILED'
         ORDER BY granted_at DESC LIMIT 1`,
        [caller.id],
      );
      const lastAt = last.rows[0]?.granted_at;
      if (lastAt !== undefined) {
        const readyMs = lastAt.getTime() + faucet.cooldownS * 1000;
        if (readyMs > now.getTime()) {
          await client.query("ROLLBACK");
          return reply.status(429).send({
            error: "FAUCET_COOLDOWN",
            retry_after_s: Math.ceil((readyMs - now.getTime()) / 1000),
          });
        }
      }
      const today = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM faucet_grants
         WHERE status <> 'FAILED' AND granted_at > $1`,
        [new Date(now.getTime() - DAY_MS)],
      );
      if (Number(today.rows[0]?.n ?? "0") >= faucet.dailyCap) {
        await client.query("ROLLBACK");
        return reply.status(503).send({ error: "FAUCET_EXHAUSTED" });
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO faucet_grants (user_id, wallet_address, granted_at, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
        [caller.id, caller.wallet, now],
      );
      grantId = inserted.rows[0]!.id;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const markFailed = () =>
      pool.query("UPDATE faucet_grants SET status = 'FAILED' WHERE id = $1", [grantId]);

    let signature: string;
    try {
      const blockhash = await writer.getLatestBlockhash();
      const message = faucetMessage({
        relayer: faucet.relayerPubkey,
        faucet: faucet.faucetPubkey,
        recipient,
        mint: faucet.mint,
        lamports: faucet.lamports,
        usdcAmount: faucet.usdcAmount,
        blockhash,
      });
      const tx = signedWire(message, [faucet.relayerSeed, faucet.faucetSeed]);
      signature = tx.signature;
      await pool.query("UPDATE faucet_grants SET tx_signature = $2 WHERE id = $1", [
        grantId,
        signature,
      ]);
      await writer.sendTransaction(tx.wire);
    } catch (error) {
      await markFailed();
      request.log.error({ grant: grantId, err: String(error) }, "faucet send failed");
      return reply.status(502).send({ error: "FAUCET_SEND_FAILED" });
    }

    // Confirm, bounded. A failed transaction frees the cooldown; an unconfirmed one keeps
    // it, because it may still land.
    const until = clock.now().getTime() + faucet.confirmS * 1000;
    let confirmed = false;
    for (;;) {
      let status;
      try {
        [status] = await writer.getSignatureStatuses([signature]);
      } catch {
        status = undefined;
      }
      if (status !== null && status !== undefined) {
        if (status.failed) {
          await markFailed();
          return reply.status(502).send({ error: "FAUCET_SEND_FAILED", signature });
        }
        if (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized") {
          confirmed = true;
          break;
        }
      }
      if (clock.now().getTime() >= until) break;
      await sleep(STATUS_POLL_MS);
    }
    await pool.query("UPDATE faucet_grants SET status = 'SENT' WHERE id = $1", [grantId]);
    return reply.status(confirmed ? 200 : 202).send({
      signature,
      confirmed,
      usdc: decimal(faucet.usdcAmount, 6),
      sol: decimal(faucet.lamports, 9),
    });
  });
}
