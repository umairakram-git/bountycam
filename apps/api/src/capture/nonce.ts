// POLICY.md sections 17.7 and 17.8 (D134, D137): the capture object served in
// the assigned-Scout view and the 201, and consumeCaptureNonce, which P4's
// submission calls inside its own transaction.
import type { Pool, PoolClient } from "pg";
import type { CaptureConfig } from "../config.ts";

export interface NonceRow {
  id: string;
  value: Buffer;
  issued_at: Date;
  expires_at: Date;
}

/** Section 17.7's `capture` object; `nonce` is null when no session is live. */
export function captureObject(
  config: CaptureConfig,
  deadline: Date,
  now: Date,
  nonce: NonceRow | null,
): Record<string, unknown> {
  const closes = deadline.getTime() - (config.deadlineBufferS + config.minWindowS) * 1000;
  return {
    server_time: now.toISOString(),
    start_closes_at: new Date(closes).toISOString(),
    max_location_accuracy_m: config.maxLocationAccuracyM,
    location_fix_timeout_s: config.locationFixTimeoutS,
    max_location_age_s: config.maxLocationAgeS,
    capture_nonce:
      nonce === null
        ? null
        : {
            id: nonce.id,
            value: nonce.value.toString("hex"),
            issued_at: nonce.issued_at.toISOString(),
            expires_at: nonce.expires_at.toISOString(),
          },
  };
}

/** The assignment's ACTIVE nonce while `now < expires_at`, else null. */
export async function liveNonce(
  pool: Pool,
  assignmentId: string,
  now: Date,
): Promise<NonceRow | null> {
  const r = await pool.query<NonceRow>(
    `SELECT id, value, issued_at, expires_at FROM capture_nonces
     WHERE assignment_id = $1 AND status = 'ACTIVE' AND expires_at > $2`,
    [assignmentId, now],
  );
  return r.rows[0] ?? null;
}

export type ConsumeOutcome =
  | "CONSUMED"
  | "UNKNOWN"
  | "BINDING_MISMATCH"
  | "ALREADY_CONSUMED"
  | "SUPERSEDED"
  | "EXPIRED";

export interface ConsumeInput {
  value: Uint8Array;
  bountyId: string;
  assignmentId: string;
  scoutId: string;
  deploymentId: number;
}

/**
 * Section 17.8. Runs on the caller's client so that P4 consumes the nonce in
 * the same transaction as its submission write. The first applicable step
 * decides; only steps 4 and 5 write.
 */
export async function consumeCaptureNonce(
  client: PoolClient,
  input: ConsumeInput,
  now: Date,
  submissionGraceS: number,
): Promise<ConsumeOutcome> {
  // Step 1.
  const r = await client.query<{
    id: string;
    bounty_id: string;
    assignment_id: string;
    scout_id: string;
    deployment_id: number;
    status: string;
    expires_at: Date;
  }>(
    `SELECT id, bounty_id, assignment_id, scout_id, deployment_id, status, expires_at
     FROM capture_nonces WHERE value = $1 FOR UPDATE`,
    [Buffer.from(input.value)],
  );
  const row = r.rows[0];
  if (row === undefined) return "UNKNOWN";
  // Step 2.
  if (
    row.bounty_id !== input.bountyId ||
    row.assignment_id !== input.assignmentId ||
    row.scout_id !== input.scoutId ||
    row.deployment_id !== input.deploymentId
  ) {
    return "BINDING_MISMATCH";
  }
  // Step 3.
  if (row.status === "CONSUMED") return "ALREADY_CONSUMED";
  if (row.status === "SUPERSEDED") return "SUPERSEDED";
  if (row.status === "EXPIRED") return "EXPIRED";
  // Step 4.
  if (now.getTime() >= row.expires_at.getTime() + submissionGraceS * 1000) {
    await client.query("UPDATE capture_nonces SET status = 'EXPIRED' WHERE id = $1", [row.id]);
    return "EXPIRED";
  }
  // Step 5.
  await client.query(
    "UPDATE capture_nonces SET status = 'CONSUMED', consumed_at = $2 WHERE id = $1",
    [row.id, now],
  );
  return "CONSUMED";
}
