// ELIGIBILITY.md section 6: one transaction covers the section 5.2 device
// claim, the opportunistic expiry flip for this bounty, and the reservation
// itself — nothing else. Signing happens outside it. The Session 3 unique
// partial index is the race mechanism: two concurrent inserts resolve to one
// row and one unique violation, decided by the database (SECURITY.md 10,
// D79).
import type { Pool, PoolClient } from "pg";

export interface ReserveInput {
  readonly bountyId: string;
  readonly scoutId: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly seekerMint: string | null;
}

export type ReserveOutcome =
  | { readonly kind: "reserved"; readonly assignmentId: string }
  | { readonly kind: "held"; readonly assignmentId: string }
  | { readonly kind: "taken" }
  | { readonly kind: "claimed_elsewhere" };

const ONE_ACTIVE_INDEX = "assignments_one_active_per_bounty_idx";

// Section 6.1: only reservations flip. An accepted assignment has accepted_at
// set (D113) and its expiry is the chain's business, not this table's.
export const FLIP_EXPIRED_SQL =
  "UPDATE assignments SET status = 'EXPIRED' " +
  "WHERE status = 'ACTIVE' AND accepted_at IS NULL AND expires_at <= $1";

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === constraint;
}

export async function reserve(pool: Pool, input: ReserveInput): Promise<ReserveOutcome> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // The second writer of section 6.1: this bounty's stale reservation, if
    // any, flips before this request attempts its own insert.
    await client.query(FLIP_EXPIRED_SQL + " AND bounty_id = $2", [
      input.now,
      input.bountyId,
    ]);

    // Section 5.2: first claim wins, by the primary key. A conflicting insert
    // does nothing; the following read says who holds it.
    if (input.seekerMint !== null) {
      await client.query(
        "INSERT INTO seeker_devices (sgt_mint, user_id, claimed_at) " +
          "VALUES ($1, $2, $3) ON CONFLICT (sgt_mint) DO NOTHING",
        [input.seekerMint, input.scoutId, input.now],
      );
      const holder = await client.query<{ user_id: string }>(
        "SELECT user_id FROM seeker_devices WHERE sgt_mint = $1",
        [input.seekerMint],
      );
      if (holder.rows[0]?.user_id !== input.scoutId) {
        await client.query("ROLLBACK");
        return { kind: "claimed_elsewhere" };
      }
    }

    // Section 6: an ACTIVE reservation held by this Scout is not a failure
    // and is not extended. One held by anyone else is taken.
    const existing = await client.query<{ id: string; scout_id: string }>(
      "SELECT id, scout_id FROM assignments WHERE bounty_id = $1 AND status = 'ACTIVE'",
      [input.bountyId],
    );
    const live = existing.rows[0];
    if (live !== undefined) {
      if (live.scout_id === input.scoutId) {
        await client.query("COMMIT");
        return { kind: "held", assignmentId: live.id };
      }
      await client.query("ROLLBACK");
      return { kind: "taken" };
    }

    let inserted;
    try {
      inserted = await client.query<{ id: string }>(
        "INSERT INTO assignments (bounty_id, scout_id, status, expires_at) " +
          "VALUES ($1, $2, 'ACTIVE', $3) RETURNING id",
        [input.bountyId, input.scoutId, input.expiresAt],
      );
    } catch (error) {
      if (isUniqueViolation(error, ONE_ACTIVE_INDEX)) {
        await client.query("ROLLBACK");
        return { kind: "taken" };
      }
      throw error;
    }
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("assignments insert returned no row");
    await client.query("COMMIT");
    return { kind: "reserved", assignmentId: row.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
