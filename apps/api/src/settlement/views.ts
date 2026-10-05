// POLICY.md section 20.8 (amendment A2): the dispute and settlement objects, served in
// the owner and assigned-Scout views of DISPUTED, PAID and REFUNDED bounties only. No photo
// URL, store key, coordinate or wallet.
import type { Pool } from "pg";

export const SETTLED_VIEW_STATES: ReadonlySet<string> = new Set(["DISPUTED", "PAID", "REFUNDED"]);

/** Null, or an object with exactly failed_requirement_id (null for a foreign id, D161). */
export async function disputeObject(
  pool: Pool,
  bountyId: string,
  state: string,
): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{ failed_requirement_id: string | null }>(
    `SELECT d.failed_requirement_id FROM decisions d
     JOIN submissions s ON s.id = d.submission_id
     WHERE s.bounty_id = $1 AND d.outcome = 'REJECT'`,
    [bountyId],
  );
  const row = r.rows[0];
  if (row !== undefined) return { failed_requirement_id: row.failed_requirement_id };
  // A DISPUTED bounty with no REJECT row was rejected with a foreign id (D161); a PAID
  // or REFUNDED one never went through a dispute unless its settlement says resolve.
  if (state === "DISPUTED") return { failed_requirement_id: null };
  const s = await pool.query<{ kind: string }>(
    "SELECT kind FROM settlements WHERE bounty_id = $1",
    [bountyId],
  );
  const kind = s.rows[0]?.kind;
  return kind === "RESOLVED_PAID" || kind === "RESOLVED_REFUNDED"
    ? { failed_requirement_id: null }
    : null;
}

/** Null, or an object with exactly kind, tx_signature, settled_at and amount. */
export async function settlementObject(
  pool: Pool,
  bountyId: string,
): Promise<Record<string, unknown> | null> {
  const r = await pool.query<{
    kind: string;
    tx_signature: string;
    settled_at: Date;
    reward_amount: string;
  }>(
    `SELECT t.kind, t.tx_signature, t.settled_at, b.reward_amount
     FROM settlements t JOIN bounties b ON b.id = t.bounty_id
     WHERE t.bounty_id = $1`,
    [bountyId],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    kind: row.kind,
    tx_signature: row.tx_signature,
    settled_at: row.settled_at.toISOString(),
    amount: String(row.reward_amount),
  };
}

/** The two keys, for the views of DISPUTED, PAID and REFUNDED. */
export async function settledFields(
  pool: Pool,
  bountyId: string,
  state: string,
): Promise<{ dispute?: Record<string, unknown> | null;
  settlement?: Record<string, unknown> | null }> {
  if (!SETTLED_VIEW_STATES.has(state)) return {};
  return {
    dispute: await disputeObject(pool, bountyId, state),
    settlement: await settlementObject(pool, bountyId),
  };
}
