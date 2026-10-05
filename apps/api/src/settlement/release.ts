// POLICY.md section 20.6 (D155 ruling 2, D159): the verifier's settlement pass. Each
// tick projects every SUBMITTED and DISPUTED bounty; one still Submitted on chain after its
// review window plus the margin is released, the relayer paying. The projection reads the
// account before every send, so a settled bounty is projected rather than resent; preflight
// at confirmed makes a second release against a Paid account fail at no cost; after any
// failure the account is read again. Retry state is in memory: the chain is the record.
import type { Pool } from "pg";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { decodeBountyAccount, readTail } from "../chain/bounty.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../chain/pda.ts";
import type { ChainReader, ChainWriter, SettlementReader } from "../chain/rpc.ts";
import { releaseMessage, signedWire, type SettlementKeys } from "../chain/tx.ts";
import type { Clock } from "../clock.ts";
import { projectSettlement, SETTLEMENT_ALARMS } from "./project.ts";

export interface ReleaseDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly chain: ChainReader;
  readonly writer: ChainWriter;
  readonly settlement: SettlementReader;
  readonly programId: string;
  readonly programIdBytes: Uint8Array;
  readonly configAccount: string;
  readonly usdcMint: Uint8Array;
  readonly relayerSeed: Uint8Array;
  readonly releaseMarginS: number;
  readonly confirmS: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Bounty id to its consecutive failed sends and the time before which none is due. */
  readonly retries: Map<string, { tries: number; nextMs: number }>;
}

export const PASS_LIMIT = 50;
const BACKOFF_S = [5, 10, 20, 40, 60];
const STATUS_POLL_MS = 2000;

/** Section 20.7's keys for a bounty account just read. */
export function settlementKeys(
  programIdBytes: Uint8Array,
  configAccount: string,
  bounty: Uint8Array,
  requester: Uint8Array,
  mint: Uint8Array,
): SettlementKeys {
  const tokenProgram = base58.decode(TOKEN_PROGRAM_ID);
  const associatedTokenProgram = base58.decode(ASSOCIATED_TOKEN_PROGRAM_ID);
  return {
    programId: programIdBytes,
    config: base58.decode(configAccount),
    bounty,
    requester,
    mint,
    vault: associatedTokenAddress(bounty, mint, tokenProgram, associatedTokenProgram),
    tokenProgram,
    associatedTokenProgram,
    systemProgram: base58.decode(SYSTEM_PROGRAM_ID),
  };
}

async function sendRelease(deps: ReleaseDeps, account: string): Promise<string | null> {
  const info = await deps.chain.getAccount(account);
  if (info === null) return null;
  const decoded = decodeBountyAccount(info, deps.programId);
  const tail = readTail(info);
  if (!decoded.ok || !tail.ok || decoded.bounty.state !== "Submitted" || tail.tail.scout === null) {
    return null;
  }
  const keys = settlementKeys(deps.programIdBytes, deps.configAccount, base58.decode(account),
    decoded.bounty.requester, deps.usdcMint);
  const scout = tail.tail.scout;
  const payout = associatedTokenAddress(scout, deps.usdcMint, keys.tokenProgram,
    keys.associatedTokenProgram);
  const blockhash = await deps.writer.getLatestBlockhash();
  const relayer = ed25519.getPublicKey(deps.relayerSeed);
  const tx = signedWire(releaseMessage(keys, relayer, scout, payout, blockhash),
    [deps.relayerSeed]);
  await deps.writer.sendTransaction(tx.wire);
  const until = deps.clock.now().getTime() + deps.confirmS * 1000;
  while (deps.clock.now().getTime() < until) {
    const [status] = await deps.writer.getSignatureStatuses([tx.signature]);
    if (status !== null && status !== undefined) {
      if (status.failed) break;
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        break;
      }
    }
    await deps.sleep(STATUS_POLL_MS);
  }
  return tx.signature;
}

export async function settlementPass(deps: ReleaseDeps): Promise<void> {
  const due = await deps.pool.query<{ id: string; program_account: string }>(
    `SELECT id, program_account FROM bounties
     WHERE state IN ('SUBMITTED', 'DISPUTED') AND program_account IS NOT NULL
     ORDER BY created_at, id LIMIT $1`,
    [PASS_LIMIT],
  );
  const projection = {
    pool: deps.pool,
    clock: deps.clock,
    chain: deps.chain,
    settlement: deps.settlement,
    programId: deps.programId,
    alarm: (outcome: string, bountyId: string) =>
      deps.log("error", { bounty: bountyId, settlement: outcome }),
  };
  for (const row of due.rows) {
    const first = await projectSettlement(projection, row.id);
    if (first.outcome !== "NOT_SETTLED" || first.chainState !== "Submitted") continue;
    const ends = first.reviewEndsAt ?? null;
    const now = deps.clock.now().getTime();
    if (ends === null || now <= ends.getTime() + deps.releaseMarginS * 1000) continue;
    const waiting = deps.retries.get(row.id);
    if (waiting !== undefined && now < waiting.nextMs) continue;
    let signature: string | null = null;
    try {
      signature = await sendRelease(deps, row.program_account);
    } catch {
      signature = null;
    }
    const after = await projectSettlement(projection, row.id);
    if (after.outcome === "PROJECTED") {
      deps.retries.delete(row.id);
      deps.log("info", { bounty: row.id, release: "PROJECTED", tx: signature });
      continue;
    }
    if (SETTLEMENT_ALARMS.has(after.outcome)) continue;
    const tries = (waiting?.tries ?? 0) + 1;
    const delayS = BACKOFF_S[Math.min(tries, BACKOFF_S.length) - 1] as number;
    deps.retries.set(row.id, { tries, nextMs: deps.clock.now().getTime() + delayS * 1000 });
    deps.log("info", { bounty: row.id, release: after.outcome, tx: signature, retry: delayS });
  }
}
