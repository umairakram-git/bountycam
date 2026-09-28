// POLICY.md section 15.3: the funding projection, the only writer of
// AVAILABLE. Its evidence is the bounty account at the derived address, read
// at confirmed; no transaction signature is read (D118). Two callers share
// it: the report endpoint (routes.ts here) and the sweep (sweeper.ts).
import type { Pool } from "pg";
import { base58 } from "@scure/base";
import { ELIGIBILITY_PROFILES, eligibilityProfileHash, uuidBytes } from "@hackathon/shared";
import { decodeBountyAccount, type DecodedBounty } from "../chain/bounty.ts";
import { bytesEqual } from "../chain/config.ts";
import { bountyAddress } from "../chain/pda.ts";
import { ChainError, type ChainReader } from "../chain/rpc.ts";

export type ProjectionOutcome =
  | "PROJECTED"
  | "NOT_FUNDED"
  | "CHAIN_UNAVAILABLE"
  | "BINDING_MISMATCH"
  | "FUNDED_AFTER_CANCEL"
  | "NOT_DRAFT";

/** One error-level line per alarm: the outcome and the bounty id, nothing else. */
export type Alarm = (outcome: "BINDING_MISMATCH" | "FUNDED_AFTER_CANCEL", bountyId: string) => void;

export interface ProjectionDeps {
  readonly pool: Pool;
  readonly chain: ChainReader;
  readonly programId: string; // base58
  readonly programIdBytes: Uint8Array;
  readonly alarm: Alarm;
}

interface ProjectionRow {
  id: string;
  state: string;
  program_account: string | null;
  wallet_address: string;
  canonical_json: string;
  policy_hash: Buffer;
}

interface StoredPolicy {
  reward_amount: string;
  eligibility_profile_id: string;
  required_assurance: number;
  acceptance_window_seconds: number;
  completion_window_seconds: number;
  challenge_window_seconds: number;
}

export interface ProjectionResult {
  readonly outcome: ProjectionOutcome;
  /** The derived address, base58, whenever the row was loaded. */
  readonly address?: string;
}

async function loadRow(pool: Pool, bountyId: string): Promise<ProjectionRow | undefined> {
  const result = await pool.query<ProjectionRow>(
    `SELECT b.id, b.state, b.program_account, u.wallet_address,
            p.canonical_json, p.policy_hash
     FROM bounties b
     JOIN policies p ON p.id = b.policy_id
     JOIN users u ON u.id = b.requester_id
     WHERE b.id = $1`,
    [bountyId],
  );
  return result.rows[0];
}

// Step 6: every row of both POLICY.md 2.6 tables. Policy values come from the
// stored canonical text, never from read-model columns.
function bindingsAgree(row: ProjectionRow, bounty: DecodedBounty): boolean {
  const policy = JSON.parse(row.canonical_json) as StoredPolicy;
  const profile = ELIGIBILITY_PROFILES.get(policy.eligibility_profile_id);
  if (profile === undefined) return false;
  return (
    bytesEqual(bounty.bountyId, uuidBytes(row.id)) &&
    bytesEqual(bounty.requester, base58.decode(row.wallet_address)) &&
    bounty.rewardAmount === BigInt(policy.reward_amount) &&
    bounty.platformFee === 0n &&
    bytesEqual(bounty.policyHash, Uint8Array.from(row.policy_hash)) &&
    bytesEqual(bounty.eligibilityProfileHash, eligibilityProfileHash(profile)) &&
    bounty.requiredAssurance === policy.required_assurance &&
    bounty.acceptanceWindowSecs === BigInt(policy.acceptance_window_seconds) &&
    bounty.completionWindowSecs === BigInt(policy.completion_window_seconds) &&
    bounty.reviewWindowSecs === BigInt(policy.challenge_window_seconds)
  );
}

/**
 * Steps 2 to 5 of section 15.3 without writing: derive, read, decode, state.
 * Shared with the CANCELLED arm of the report endpoint (15.4 step 7).
 */
export async function readFundedAccount(
  deps: ProjectionDeps,
  row: { id: string; wallet_address: string },
): Promise<
  | { kind: "FUNDED"; address: string; bounty: DecodedBounty }
  | { kind: "ABSENT"; address: string }
  | { kind: "UNDECODABLE"; address: string }
  | { kind: "CHAIN_UNAVAILABLE"; address: string }
> {
  const derived = bountyAddress(
    base58.decode(row.wallet_address),
    uuidBytes(row.id),
    deps.programIdBytes,
  );
  const address = base58.encode(derived.address);
  let info;
  try {
    info = await deps.chain.getAccount(address);
  } catch (error) {
    if (error instanceof ChainError) return { kind: "CHAIN_UNAVAILABLE", address };
    throw error;
  }
  if (info === null) return { kind: "ABSENT", address };
  const decoded = decodeBountyAccount(info, deps.programId);
  if (!decoded.ok || decoded.bounty.state !== "Funded") return { kind: "UNDECODABLE", address };
  return { kind: "FUNDED", address, bounty: decoded.bounty };
}

/** Section 15.3, steps 1 to 7. Only step 7 writes. */
export async function projectFunding(
  deps: ProjectionDeps,
  bountyId: string,
): Promise<ProjectionResult> {
  // Step 1.
  const row = await loadRow(deps.pool, bountyId);
  if (row === undefined || row.state !== "DRAFT") return { outcome: "NOT_DRAFT" };

  // Steps 2 to 5.
  const read = await readFundedAccount(deps, row);
  const address = read.address;
  if (read.kind === "CHAIN_UNAVAILABLE") return { outcome: "CHAIN_UNAVAILABLE", address };
  if (read.kind === "ABSENT") return { outcome: "NOT_FUNDED", address };
  if (read.kind === "UNDECODABLE") {
    deps.alarm("BINDING_MISMATCH", row.id);
    return { outcome: "BINDING_MISMATCH", address };
  }

  // Step 6.
  if (!bindingsAgree(row, read.bounty)) {
    deps.alarm("BINDING_MISMATCH", row.id);
    return { outcome: "BINDING_MISMATCH", address };
  }

  // Step 7: one conditional update.
  const updated = await deps.pool.query(
    `UPDATE bounties SET state = 'AVAILABLE', program_account = $2
     WHERE id = $1 AND state = 'DRAFT'`,
    [row.id, address],
  );
  if ((updated.rowCount ?? 0) === 1) return { outcome: "PROJECTED", address };

  // Zero rows: a concurrent writer won. Reload once.
  const again = await loadRow(deps.pool, bountyId);
  if (again?.state === "AVAILABLE" && again.program_account === address) {
    return { outcome: "PROJECTED", address };
  }
  if (again?.state === "CANCELLED") {
    deps.alarm("FUNDED_AFTER_CANCEL", row.id);
    return { outcome: "FUNDED_AFTER_CANCEL", address };
  }
  throw new Error("projection reload: unexpected state " + String(again?.state));
}
