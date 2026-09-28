// POLICY.md section 16.7 (D124): the acceptance projection, the only writer of
// ACCEPTED and of an assignment's accepted_at and deadline. Its evidence is the
// bounty account at confirmed; no transaction is read. Three callers: the
// report endpoint (routes.ts here), the voucher endpoint when it reads an
// Accepted account, and the reservation sweep before it flips.
import type { Pool } from "pg";
import { base58 } from "@scure/base";
import { uuidBytes } from "@hackathon/shared";
import { decodeBountyAccount, readAcceptance } from "../chain/bounty.ts";
import { bytesEqual } from "../chain/config.ts";
import { ChainError, type ChainReader } from "../chain/rpc.ts";

export type AcceptanceOutcome =
  | "PROJECTED"
  | "NOT_ACCEPTED"
  | "NOT_APPLICABLE"
  | "CHAIN_UNAVAILABLE"
  | "BINDING_MISMATCH"
  | "UNPROJECTED_STATE"
  | "UNKNOWN_SCOUT";

export type AcceptanceAlarmOutcome = "BINDING_MISMATCH" | "UNPROJECTED_STATE" | "UNKNOWN_SCOUT";

/** One error-level line per alarm: the outcome and the bounty id, nothing else. */
export type AcceptanceAlarm = (outcome: AcceptanceAlarmOutcome, bountyId: string) => void;

export interface AcceptanceDeps {
  readonly pool: Pool;
  readonly chain: ChainReader;
  readonly programId: string; // base58
  readonly alarm: AcceptanceAlarm;
}

export async function projectAcceptance(
  deps: AcceptanceDeps,
  bountyId: string,
): Promise<AcceptanceOutcome> {
  const { pool } = deps;

  // Step 1: load. Only AVAILABLE and ACCEPTED proceed.
  const loaded = await pool.query<{ state: string; program_account: string | null }>(
    "SELECT state, program_account FROM bounties WHERE id = $1",
    [bountyId],
  );
  const row = loaded.rows[0];
  if (row === undefined || (row.state !== "AVAILABLE" && row.state !== "ACCEPTED")) {
    return "NOT_APPLICABLE";
  }
  if (row.program_account === null) return "NOT_ACCEPTED";

  // Step 2: read at confirmed.
  let info;
  try {
    info = await deps.chain.getAccount(row.program_account);
  } catch (error) {
    if (error instanceof ChainError) return "CHAIN_UNAVAILABLE";
    throw error;
  }
  if (info === null) return "NOT_ACCEPTED";

  // Step 3: the prefix, and the account's bounty_id against the row (D129).
  const decoded = decodeBountyAccount(info, deps.programId);
  if (!decoded.ok || !bytesEqual(decoded.bounty.bountyId, uuidBytes(bountyId))) {
    deps.alarm("BINDING_MISMATCH", bountyId);
    return "BINDING_MISMATCH";
  }

  // Step 4: state; then the two fields accept wrote.
  const state = decoded.bounty.state;
  if (state === "Funded") return "NOT_ACCEPTED";
  if (state !== "Accepted") {
    deps.alarm("UNPROJECTED_STATE", bountyId);
    return "UNPROJECTED_STATE";
  }
  const tail = readAcceptance(info);
  if (!tail.ok) {
    deps.alarm("BINDING_MISMATCH", bountyId);
    return "BINDING_MISMATCH";
  }

  // Step 5: the chain's Scout as a user.
  const users = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE wallet_address = $1",
    [base58.encode(tail.scout)],
  );
  const scoutId = users.rows[0]?.id;
  if (scoutId === undefined) {
    deps.alarm("UNKNOWN_SCOUT", bountyId);
    return "UNKNOWN_SCOUT";
  }

  // Step 6: the chain clock at accept is deadline minus the completion window.
  const deadline = new Date(Number(tail.deadline) * 1000);
  const acceptedAt = new Date(
    Number(tail.deadline - decoded.bounty.completionWindowSecs) * 1000,
  );

  // Step 7: one transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ state: string }>(
      "SELECT state FROM bounties WHERE id = $1 FOR UPDATE",
      [bountyId],
    );
    const lockedState = locked.rows[0]?.state;
    if (lockedState === "ACCEPTED") {
      const held = await client.query(
        "SELECT 1 FROM assignments WHERE bounty_id = $1 AND scout_id = $2 " +
          "AND status = 'ACTIVE' AND accepted_at IS NOT NULL",
        [bountyId, scoutId],
      );
      if (held.rowCount === 1) {
        await client.query("COMMIT");
        return "PROJECTED";
      }
      // Section 7.2 has no path to ACCEPTED without this row.
      throw new Error("ACCEPTED without the chain Scout's acceptance: " + bountyId);
    }
    if (lockedState !== "AVAILABLE") {
      await client.query("ROLLBACK");
      return "NOT_APPLICABLE";
    }
    // 7.2: the chain decided; any other live reservation ends.
    await client.query(
      "UPDATE assignments SET status = 'EXPIRED' " +
        "WHERE bounty_id = $1 AND status = 'ACTIVE' AND scout_id <> $2",
      [bountyId, scoutId],
    );
    // 7.3: the Scout's live reservation becomes the acceptance, or a new row
    // records it when the reservation was already flipped.
    const updated = await client.query(
      "UPDATE assignments SET accepted_at = $3, deadline = $4 " +
        "WHERE bounty_id = $1 AND scout_id = $2 AND status = 'ACTIVE'",
      [bountyId, scoutId, acceptedAt, deadline],
    );
    if (updated.rowCount === 0) {
      await client.query(
        "INSERT INTO assignments " +
          "(bounty_id, scout_id, status, accepted_at, deadline, expires_at) " +
          "VALUES ($1, $2, 'ACTIVE', $3, $4, $3)",
        [bountyId, scoutId, acceptedAt, deadline],
      );
    }
    // 7.4.
    await client.query(
      "UPDATE bounties SET state = 'ACCEPTED' WHERE id = $1 AND state = 'AVAILABLE'",
      [bountyId],
    );
    await client.query("COMMIT");
    return "PROJECTED";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
