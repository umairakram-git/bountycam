// ELIGIBILITY.md section 6.1: the first writer. Every 30 seconds, flip every
// expired reservation out of ACTIVE. Idempotent; the interval carries no
// correctness weight and the lag bound is twice it. The clock is the one
// injectable clock, never the database's.
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import { FLIP_EXPIRED_SQL } from "./reservation.ts";

export const SWEEP_INTERVAL_MS = 30_000;

export async function sweepExpiredReservations(pool: Pool, now: Date): Promise<number> {
  const result = await pool.query(FLIP_EXPIRED_SQL, [now]);
  return result.rowCount ?? 0;
}

export function startReservationSweeper(
  pool: Pool,
  clock: Clock,
  onError: (error: unknown) => void,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    sweepExpiredReservations(pool, clock.now()).catch(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
