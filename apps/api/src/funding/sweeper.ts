// POLICY.md section 15.5: the backstop for a report that never arrives. Every
// 30 seconds, DRAFT rows created within 24 hours of the injectable clock,
// newest first, at most 50, each projected in turn. NOT_FUNDED and
// CHAIN_UNAVAILABLE are silent; the alarms log through the projection.
import type { Pool } from "pg";
import type { Clock } from "../clock.ts";
import { projectFunding, type ProjectionDeps } from "./project.ts";

export const FUNDING_SWEEP_INTERVAL_MS = 30_000;
export const FUNDING_SWEEP_WINDOW_MS = 24 * 3_600_000;
export const FUNDING_SWEEP_LIMIT = 50;

export async function sweepFunding(deps: ProjectionDeps, now: Date): Promise<number> {
  const since = new Date(now.getTime() - FUNDING_SWEEP_WINDOW_MS);
  const rows = await deps.pool.query<{ id: string }>(
    `SELECT id FROM bounties
     WHERE state = 'DRAFT' AND created_at >= $1
     ORDER BY created_at DESC, id ASC
     LIMIT $2`,
    [since, FUNDING_SWEEP_LIMIT],
  );
  let projected = 0;
  for (const row of rows.rows) {
    const result = await projectFunding(deps, row.id);
    if (result.outcome === "PROJECTED") projected++;
  }
  return projected;
}

export function startFundingSweeper(
  deps: ProjectionDeps,
  clock: Clock,
  onError: (error: unknown) => void,
  intervalMs: number = FUNDING_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    sweepFunding(deps, clock.now()).catch(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
