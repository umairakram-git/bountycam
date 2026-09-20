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
