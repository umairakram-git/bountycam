// programs/escrow/SPEC.md section 4.1: the fixed-offset prefix of the bounty
// account. Every field the voucher needs precedes the first Option, so the
// variable tail is never parsed. Anchor's account discriminator is
// sha256("account:<Name>")[0..8]; the rule was checked against the live devnet
// Config account on 21 September 2026 and Bounty's follows it.
import type { AccountInfo } from "./rpc.ts";

export const BOUNTY_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0xed, 0x10, 0x69, 0xc6, 0x13, 0x45, 0xf2, 0xea,
]);
export const BOUNTY_FIXED_LENGTH = 171; // 8 discriminator + 163, through bump
export const BOUNTY_MAX_LENGTH = 274; // section 4.1 maximum space

// Section 5.1, in discriminant order; append-only (D96).
export const BOUNTY_STATES = [
  "Funded",
  "Accepted",
  "Submitted",
  "Disputed",
  "Paid",
  "Refunded",
] as const;
export type BountyState = (typeof BOUNTY_STATES)[number];

export interface DecodedBounty {
  readonly bountyId: Uint8Array;
  readonly requester: Uint8Array;
  readonly rewardAmount: bigint;
  readonly platformFee: bigint;
  readonly policyHash: Uint8Array;
  readonly eligibilityProfileHash: Uint8Array;
  readonly requiredAssurance: number;
  readonly acceptanceWindowSecs: bigint;
  readonly completionWindowSecs: bigint;
  readonly reviewWindowSecs: bigint;
  readonly acceptanceCutoff: bigint;
  readonly state: BountyState;
  readonly bump: number;
}

export type BountyDecodeError =
  | "NOT_PROGRAM_ACCOUNT"
  | "BAD_LENGTH"
  | "BAD_DISCRIMINATOR"
  | "BAD_STATE";

export type BountyDecodeResult =
  | { readonly ok: true; readonly bounty: DecodedBounty }
  | { readonly ok: false; readonly error: BountyDecodeError };

// Checks in order: owner, length band, discriminator, state byte. The first
// failure wins. Byte fields are copied, never views over the input.
export function decodeBountyAccount(
  info: AccountInfo,
  programId: string,
): BountyDecodeResult {
  if (info.owner !== programId) return { ok: false, error: "NOT_PROGRAM_ACCOUNT" };
  const d = info.data;
  if (d.length < BOUNTY_FIXED_LENGTH || d.length > BOUNTY_MAX_LENGTH) {
    return { ok: false, error: "BAD_LENGTH" };
  }
  for (let i = 0; i < 8; i++) {
    if (d[i] !== BOUNTY_DISCRIMINATOR[i]) return { ok: false, error: "BAD_DISCRIMINATOR" };
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const stateByte = view.getUint8(169);
  const state = BOUNTY_STATES[stateByte];
  if (state === undefined) return { ok: false, error: "BAD_STATE" };
  return {
    ok: true,
    bounty: {
      bountyId: d.slice(8, 24),
      requester: d.slice(24, 56),
      rewardAmount: view.getBigUint64(56, true),
      platformFee: view.getBigUint64(64, true),
      policyHash: d.slice(72, 104),
      eligibilityProfileHash: d.slice(104, 136),
      requiredAssurance: view.getUint8(136),
      acceptanceWindowSecs: view.getBigInt64(137, true),
      completionWindowSecs: view.getBigInt64(145, true),
      reviewWindowSecs: view.getBigInt64(153, true),
      acceptanceCutoff: view.getBigInt64(161, true),
      state,
      bump: view.getUint8(170),
    },
  };
}

// POLICY.md 16.6 (D129): the two fields `accept` writes, read only from an
// Accepted account. Each Option is a tag byte, 1 for some, then its value:
// scout at 171 (tag) and 172..203, deadline at 204 (tag) and 205..212. The
// prefix decoder above never reads the tail, so its callers are unchanged.
export type AcceptanceRead =
  | { readonly ok: true; readonly scout: Uint8Array; readonly deadline: bigint }
  | { readonly ok: false; readonly error: "BAD_TAIL" };

export const ACCEPTED_TAIL_END = 213;

export function readAcceptance(info: AccountInfo): AcceptanceRead {
  const d = info.data;
  if (d.length < ACCEPTED_TAIL_END || d[169] !== 1 || d[171] !== 1 || d[204] !== 1) {
    return { ok: false, error: "BAD_TAIL" };
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { ok: true, scout: d.slice(172, 204), deadline: view.getBigInt64(205, true) };
}

// POLICY.md 19.10 (D153): the fields `submit_attestation` writes, read only from a
// Submitted account. After deadline (204..212) come submitted_at (tag 213, value
// 214..221), evidence_root (tag 222, value 223..254) and achieved_assurance (tag 255,
// value 256), each Some.
export type SubmissionRead =
  | {
      readonly ok: true;
      readonly scout: Uint8Array;
      readonly deadline: bigint;
      readonly submittedAt: bigint;
      readonly evidenceRoot: Uint8Array;
      readonly achievedAssurance: number;
    }
  | { readonly ok: false; readonly error: "BAD_TAIL" };

export const SUBMITTED_TAIL_END = 257;

export function readSubmission(info: AccountInfo): SubmissionRead {
  const d = info.data;
  if (
    d.length < SUBMITTED_TAIL_END || d[169] !== 2 || d[171] !== 1 || d[204] !== 1 ||
    d[213] !== 1 || d[222] !== 1 || d[255] !== 1
  ) {
    return { ok: false, error: "BAD_TAIL" };
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    ok: true,
    scout: d.slice(172, 204),
    deadline: view.getBigInt64(205, true),
    submittedAt: view.getBigInt64(214, true),
    evidenceRoot: d.slice(223, 255),
    achievedAssurance: view.getUint8(256),
  };
}

// POLICY.md 20.3 (D157): the six Option fields of the tail, read in serialised order
// from byte 171. A tag byte, 0 for none and 1 for some, precedes each value only when 1.
// Positions shift with every none, so only a sequential reader serves every state.
export interface Tail {
  readonly scout: Uint8Array | null;
  readonly deadline: bigint | null;
  readonly submittedAt: bigint | null;
  readonly evidenceRoot: Uint8Array | null;
  readonly achievedAssurance: number | null;
  readonly failedRequirementId: Uint8Array | null;
}

export type TailRead =
  | { readonly ok: true; readonly tail: Tail }
  | { readonly ok: false; readonly error: "BAD_TAIL" };

const TAIL_FIELDS = [
  ["scout", 32],
  ["deadline", 8],
  ["submittedAt", 8],
  ["evidenceRoot", 32],
  ["achievedAssurance", 1],
  ["failedRequirementId", 16],
] as const;

export function readTail(info: AccountInfo): TailRead {
  const d = info.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: Record<string, unknown> = {};
  let at = BOUNTY_FIXED_LENGTH;
  for (const [name, size] of TAIL_FIELDS) {
    if (at >= d.length) return { ok: false, error: "BAD_TAIL" };
    const tag = d[at] as number;
    at += 1;
    if (tag === 0) {
      out[name] = null;
      continue;
    }
    if (tag !== 1 || at + size > d.length) return { ok: false, error: "BAD_TAIL" };
    if (name === "deadline" || name === "submittedAt") out[name] = view.getBigInt64(at, true);
    else if (name === "achievedAssurance") out[name] = d[at] as number;
    else out[name] = d.slice(at, at + size);
    at += size;
  }
  return { ok: true, tail: out as unknown as Tail };
}
