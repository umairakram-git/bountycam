// POLICY.md section 20.4 (D157, D161): the settlement projection. The only writer of
// DISPUTED, PAID, REFUNDED by expire_accepted, settlements rows and P6's decisions rows.
// Its evidence is the bounty account; the settling transaction's signature is found here
// from the chain, never taken from a caller. Callers: POST /bounties/:id/settlement, the
// verifier's settlement pass and settle.mjs.
import type { Pool, PoolClient } from "pg";
import { base58 } from "@scure/base";
import {
  decodeBountyAccount,
  readTail,
  type BountyState,
  type Tail,
} from "../chain/bounty.ts";
import { bytesEqual } from "../chain/config.ts";
import type { ChainReader, ConfirmedTransaction, SettlementReader } from "../chain/rpc.ts";
import {
  APPROVE_DISCRIMINATOR,
  EXPIRE_ACCEPTED_DISCRIMINATOR,
  REJECT_DISCRIMINATOR,
  RELEASE_DISCRIMINATOR,
  RESOLVE_DISCRIMINATOR,
} from "../chain/tx.ts";
import type { Clock } from "../clock.ts";

export type SettlementOutcome =
  | "PROJECTED"
  | "NOT_SETTLED"
  | "NOT_APPLICABLE"
  | "CHAIN_UNAVAILABLE"
  | "BINDING_MISMATCH"
  | "PARTY_MISMATCH"
  | "UNPROJECTED_STATE"
  | "FOREIGN_REQUIREMENT";

export const SETTLEMENT_ALARMS: ReadonlySet<SettlementOutcome> = new Set([
  "BINDING_MISMATCH",
  "PARTY_MISMATCH",
  "UNPROJECTED_STATE",
  "FOREIGN_REQUIREMENT",
]);

export interface SettlementDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly chain: ChainReader;
  readonly settlement: SettlementReader;
  readonly programId: string;
  /** One error-level line naming the outcome and the bounty id, and nothing else. */
  readonly alarm: (outcome: SettlementOutcome, bountyId: string) => void;
}

export interface SettlementResult {
  readonly outcome: SettlementOutcome;
  /** The chain state read, when the account was read and decoded. */
  readonly chainState?: BountyState;
  /** The review window's end, when known. */
  readonly reviewEndsAt?: Date | null;
}

export const SIGNATURE_LOOKUP_LIMIT = 20;

type Instruction = "reject" | "approve_or_release" | "resolve_pay" | "resolve_refund" | "expire";

interface Row {
  id: string;
  state: string;
  program_account: string | null;
  requester_id: string;
  canonical_json: string;
  assignment_id: string | null;
  scout_wallet: string | null;
  submission_id: string | null;
  evidence_root: Buffer | null;
  review_ends_at: Date | null;
  settled: boolean;
}

const LOAD = `
  SELECT b.id, b.state, b.program_account, b.requester_id, p.canonical_json,
         a.id AS assignment_id, su.wallet_address AS scout_wallet,
         s.id AS submission_id, s.evidence_root, s.review_ends_at,
         EXISTS (SELECT 1 FROM settlements t WHERE t.bounty_id = b.id) AS settled
  FROM bounties b
  JOIN policies p ON p.id = b.policy_id
  LEFT JOIN LATERAL (
    SELECT id, scout_id FROM assignments
    WHERE bounty_id = b.id AND accepted_at IS NOT NULL
      AND status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')
    ORDER BY accepted_at DESC LIMIT 1
  ) a ON true
  LEFT JOIN users su ON su.id = a.scout_id
  LEFT JOIN submissions s ON s.assignment_id = a.id
  WHERE b.id = $1`;

// Step 5's table: chain state and row state to the instruction that must have run.
function step5(chain: BountyState, row: string): Instruction | "NOT_SETTLED" | null {
  if (chain === "Accepted" && row === "ACCEPTED") return "NOT_SETTLED";
  if (chain === "Submitted" && (row === "SUBMITTED" || row === "ACCEPTED")) return "NOT_SETTLED";
  if (chain === "Disputed" && row === "DISPUTED") return "NOT_SETTLED";
  if (chain === "Disputed" && row === "SUBMITTED") return "reject";
  if (chain === "Paid" && row === "SUBMITTED") return "approve_or_release";
  if (chain === "Paid" && row === "DISPUTED") return "resolve_pay";
  if (chain === "Refunded" && row === "ACCEPTED") return "expire";
  if (chain === "Refunded" && row === "DISPUTED") return "resolve_refund";
  return null;
}

interface Match {
  readonly kind: "APPROVED" | "RELEASED" | "RESOLVED_PAID" | "RESOLVED_REFUNDED" |
    "EXPIRED_REFUNDED" | "REJECTED";
  readonly signature: string;
  readonly settledAt: Date;
}

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

class Mismatch extends Error {}

// Step 6, for one transaction: the first top-level escrow instruction on this account.
function matchIn(
  tx: ConfirmedTransaction,
  want: Instruction,
  programId: string,
  account: string,
): Match["kind"] | null {
  for (const ix of tx.instructions) {
    if (tx.accountKeys[ix.programIdIndex] !== programId) continue;
    const at = (position: number) => tx.accountKeys[ix.accounts[position] ?? -1];
    if (want === "reject") {
      if (startsWith(ix.data, REJECT_DISCRIMINATOR) && at(1) === account) return "REJECTED";
    } else if (want === "approve_or_release") {
      if (at(2) !== account) continue;
      if (startsWith(ix.data, APPROVE_DISCRIMINATOR)) return "APPROVED";
      if (startsWith(ix.data, RELEASE_DISCRIMINATOR)) return "RELEASED";
    } else if (want === "expire") {
      if (startsWith(ix.data, EXPIRE_ACCEPTED_DISCRIMINATOR) && at(2) === account) {
        return "EXPIRED_REFUNDED";
      }
    } else if (startsWith(ix.data, RESOLVE_DISCRIMINATOR) && at(3) === account) {
      const expected = want === "resolve_pay" ? 0 : 1;
      if (ix.data.length !== 9 || ix.data[8] !== expected) throw new Mismatch();
      return want === "resolve_pay" ? "RESOLVED_PAID" : "RESOLVED_REFUNDED";
    }
  }
  return null;
}

async function findSettling(
  deps: SettlementDeps,
  account: string,
  want: Instruction,
): Promise<Match | "CHAIN_UNAVAILABLE"> {
  let entries;
  try {
    entries = await deps.settlement.getSignaturesForAddress(account, SIGNATURE_LOOKUP_LIMIT);
  } catch {
    return "CHAIN_UNAVAILABLE";
  }
  for (const entry of entries) {
    if (entry.failed) continue;
    let tx: ConfirmedTransaction | null;
    try {
      tx = await deps.settlement.getTransaction(entry.signature);
    } catch {
      return "CHAIN_UNAVAILABLE";
    }
    if (tx === null || tx.failed) continue;
    const kind = matchIn(tx, want, deps.programId, account);
    if (kind === null) continue;
    if (tx.blockTime === null) return "CHAIN_UNAVAILABLE";
    return { kind, signature: entry.signature, settledAt: new Date(tx.blockTime * 1000) };
  }
  return "CHAIN_UNAVAILABLE";
}

function uuidOf(bytes: Uint8Array): string {
  const h = Buffer.from(bytes).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function reviewEnd(tail: Tail, reviewWindowSecs: bigint): Date | null {
  return tail.submittedAt === null
    ? null
    : new Date(Number(tail.submittedAt + reviewWindowSecs) * 1000);
}

async function setReviewEnd(db: Pool | PoolClient, submissionId: string, at: Date) {
  await db.query(
    "UPDATE submissions SET review_ends_at = $2 WHERE id = $1 AND review_ends_at IS NULL",
    [submissionId, at],
  );
}

export async function projectSettlement(
  deps: SettlementDeps,
  bountyId: string,
  attempt = 0,
): Promise<SettlementResult> {
  const alarm = (outcome: SettlementOutcome, extra: Partial<SettlementResult> = {}) => {
    deps.alarm(outcome, bountyId);
    return { outcome, ...extra };
  };
  // Step 1.
  const row = (await deps.pool.query<Row>(LOAD, [bountyId])).rows[0];
  if (row === undefined) return { outcome: "NOT_APPLICABLE" };
  if ((row.state === "PAID" || row.state === "REFUNDED") && row.settled) {
    return { outcome: "PROJECTED" };
  }
  if (!["ACCEPTED", "SUBMITTED", "DISPUTED"].includes(row.state)) {
    return { outcome: "NOT_APPLICABLE" };
  }
  if (row.program_account === null) return alarm("BINDING_MISMATCH");
  // Step 2.
  let info;
  try {
    info = await deps.chain.getAccount(row.program_account);
  } catch {
    return { outcome: "CHAIN_UNAVAILABLE" };
  }
  if (info === null) return alarm("BINDING_MISMATCH");
  // Step 3.
  const decoded = decodeBountyAccount(info, deps.programId);
  const tailRead = readTail(info);
  if (!decoded.ok || !tailRead.ok ||
    uuidOf(decoded.bounty.bountyId) !== row.id) {
    return alarm("BINDING_MISMATCH");
  }
  const chainState = decoded.bounty.state;
  const tail = tailRead.tail;
  const ends = reviewEnd(tail, decoded.bounty.reviewWindowSecs);
  // Step 4.
  if (row.scout_wallet === null || tail.scout === null ||
    !bytesEqual(tail.scout, base58.decode(row.scout_wallet))) {
    return alarm("PARTY_MISMATCH", { chainState });
  }
  // Step 5.
  const want = step5(chainState, row.state);
  if (want === null) return alarm("UNPROJECTED_STATE", { chainState });
  if (want === "NOT_SETTLED") {
    if (chainState === "Submitted" && row.state === "SUBMITTED" &&
      row.submission_id !== null && row.review_ends_at === null && ends !== null) {
      await setReviewEnd(deps.pool, row.submission_id, ends);
    }
    return { outcome: "NOT_SETTLED", chainState, reviewEndsAt: row.review_ends_at ?? ends };
  }
  if (want !== "expire") {
    if (row.submission_id === null || row.evidence_root === null || tail.evidenceRoot === null ||
      !bytesEqual(tail.evidenceRoot, row.evidence_root)) {
      return alarm("BINDING_MISMATCH", { chainState });
    }
  }
  // Step 6.
  let found: Match | "CHAIN_UNAVAILABLE";
  try {
    found = await findSettling(deps, row.program_account, want);
  } catch (error) {
    if (error instanceof Mismatch) return alarm("BINDING_MISMATCH", { chainState });
    throw error;
  }
  if (found === "CHAIN_UNAVAILABLE") return { outcome: "CHAIN_UNAVAILABLE", chainState };
  // Step 7.
  let failedId: string | null = null;
  let foreign = false;
  if (want === "reject") {
    const policy = JSON.parse(row.canonical_json) as { evidence_requirements: { id: string }[] };
    failedId = tail.failedRequirementId === null ? null : uuidOf(tail.failedRequirementId);
    foreign = failedId === null || !policy.evidence_requirements.some((r) => r.id === failedId);
  }
  // Step 8.
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ state: string }>(
      "SELECT state FROM bounties WHERE id = $1 FOR UPDATE",
      [bountyId],
    );
    if (locked.rows[0]?.state !== row.state) {
      await client.query("ROLLBACK");
      if (attempt > 0) return { outcome: "CHAIN_UNAVAILABLE", chainState };
      return projectSettlement(deps, bountyId, attempt + 1);
    }
    const setState = (state: string) =>
      client.query("UPDATE bounties SET state = $2 WHERE id = $1", [bountyId, state]);
    const setAssignment = (status: string) =>
      client.query("UPDATE assignments SET status = $2 WHERE id = $1",
        [row.assignment_id, status]);
    const settle = (kind: string) =>
      client.query(
        `INSERT INTO settlements (bounty_id, kind, tx_signature, settled_at, projected_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [bountyId, kind, found.signature, found.settledAt, now],
      );
    const decide = (outcome: "APPROVE" | "REJECT", requirement: string | null) =>
      client.query(
        `INSERT INTO decisions (submission_id, outcome, failed_requirement_id, reason,
           decided_by, decided_at, tx_signature) VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [row.submission_id, outcome, requirement, row.requester_id, now, found.signature],
      );
    switch (found.kind) {
      case "REJECTED":
        await setState("DISPUTED");
        if (!foreign) await decide("REJECT", failedId);
        break;
      case "APPROVED":
        await setState("PAID");
        await decide("APPROVE", null);
        await settle("APPROVED");
        await setAssignment("COMPLETED");
        break;
      case "RELEASED":
        await setState("PAID");
        await settle("RELEASED");
        await setAssignment("COMPLETED");
        break;
      case "RESOLVED_PAID":
        await setState("PAID");
        await settle("RESOLVED_PAID");
        await setAssignment("COMPLETED");
        break;
      case "RESOLVED_REFUNDED":
        await setState("REFUNDED");
        await settle("RESOLVED_REFUNDED");
        await setAssignment("COMPLETED");
        break;
      case "EXPIRED_REFUNDED":
        await setState("REFUNDED");
        await settle("EXPIRED_REFUNDED");
        await setAssignment("EXPIRED");
        break;
    }
    if (row.submission_id !== null && ends !== null) {
      await setReviewEnd(client, row.submission_id, ends);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (foreign) return alarm("FOREIGN_REQUIREMENT", { chainState });
  return { outcome: "PROJECTED", chainState, reviewEndsAt: row.review_ends_at ?? ends };
}
