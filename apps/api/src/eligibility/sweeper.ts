// ELIGIBILITY.md section 6.1: the first writer. Every 30 seconds, flip every
// expired reservation out of ACTIVE. Idempotent; the interval carries no
// correctness weight and the lag bound is twice it. The clock is the one
// injectable clock, never the database's.
//
// POLICY.md 16.7 (D124): before flipping, each expired reservation's bounty is
// projected, so an accept whose report was lost becomes an acceptance rather
// than a lapsed hold. A projection failure does not stop the flip: a stale
// reservation affects visibility only.
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import { FLIP_EXPIRED_SQL } from "./reservation.ts";

export const SWEEP_INTERVAL_MS = 30_000;

export type ProjectBounty = (bountyId: string) => Promise<unknown>;

export async function sweepExpiredReservations(
  pool: Pool,
  now: Date,
  project?: ProjectBounty,
): Promise<number> {
  if (project !== undefined) {
    const expired = await pool.query<{ bounty_id: string }>(
      "SELECT DISTINCT bounty_id FROM assignments " +
        "WHERE status = 'ACTIVE' AND accepted_at IS NULL AND expires_at <= $1",
      [now],
    );
    for (const row of expired.rows) {
      try {
        await project(row.bounty_id);
      } catch {
        // The flip below still runs; the next voucher or report projects.
      }
    }
  }
  const result = await pool.query(FLIP_EXPIRED_SQL, [now]);
  return result.rowCount ?? 0;
}

export function startReservationSweeper(
  pool: Pool,
  clock: Clock,
  onError: (error: unknown) => void,
  intervalMs: number = SWEEP_INTERVAL_MS,
  project?: ProjectBounty,
): () => void {
  const timer = setInterval(() => {
    sweepExpiredReservations(pool, clock.now(), project).catch(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
