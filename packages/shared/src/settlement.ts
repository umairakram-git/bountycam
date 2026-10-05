// SPEC.md section 13 (D160): the settlement-path helpers. The requester's phone builds
// `approve` and `reject` and checks them here before MWA sees them (SECURITY.md 3).
import { SpecError } from "./index.js";
import type { PlainAccountMeta, PlainInstruction } from "./index.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./funding.js";

// Every rejection passes through this one function so that the check set can be removed as
// a whole to show the negative tests red (HANDOFF Working rules).
function check(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new SpecError(code, message);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function keysEqual(got: readonly PlainAccountMeta[], want: readonly PlainAccountMeta[]): boolean {
  return (
    got.length === want.length &&
    want.every((w, i) => {
      const k = got[i]!;
      return (
        bytesEqual(k.pubkey, w.pubkey) && k.isSigner === w.isSigner && k.isWritable === w.isWritable
      );
    })
  );
}

// ---------------------------------------------------------------------------
// SPEC.md 13.1 — constants and data
// ---------------------------------------------------------------------------

/** The first eight bytes of sha256("global:approve"). */
export const APPROVE_DISCRIMINATOR: Uint8Array = hexToBytes("454ad9247375614c");
/** The first eight bytes of sha256("global:reject"). */
export const REJECT_DISCRIMINATOR: Uint8Array = hexToBytes("87073f5583726fe0");
/** The first eight bytes of sha256("account:Bounty"). */
export const BOUNTY_ACCOUNT_DISCRIMINATOR: Uint8Array = hexToBytes("ed1069c61345f2ea");

export function approveData(): Uint8Array {
  return Uint8Array.from(APPROVE_DISCRIMINATOR);
}

export function rejectData(requirementId: Uint8Array): Uint8Array {
  check(requirementId instanceof Uint8Array, "NOT_BYTES", "requirementId must be a Uint8Array");
  check(
    requirementId.length === 16 && requirementId.some((b) => b !== 0),
    "REQUIREMENT_ID_INVALID",
    "a requirement id is 16 bytes, not all zero (SPEC.md 13.1)",
  );
  const out = new Uint8Array(24);
  out.set(REJECT_DISCRIMINATOR, 0);
  out.set(requirementId, 8);
  return out;
}

// ---------------------------------------------------------------------------
// SPEC.md 13.2 — checkApproveInstructions
// ---------------------------------------------------------------------------

export interface ExpectedApprove {
  readonly programId: Uint8Array;
  readonly requester: Uint8Array;
  readonly config: Uint8Array;
  readonly bounty: Uint8Array;
  readonly usdcMint: Uint8Array;
  readonly bountyVault: Uint8Array;
  readonly scout: Uint8Array;
  readonly scoutPayout: Uint8Array;
}

/** The two instructions' keys, in order, with their flags (SPEC.md 13.2's table). */
export function expectedApproveKeys(e: ExpectedApprove): PlainAccountMeta[][] {
  return [
    [
      { pubkey: e.requester, isSigner: true, isWritable: true },
      { pubkey: e.scoutPayout, isSigner: false, isWritable: true },
      { pubkey: e.scout, isSigner: false, isWritable: false },
      { pubkey: e.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    [
      { pubkey: e.requester, isSigner: true, isWritable: true },
      { pubkey: e.config, isSigner: false, isWritable: false },
      { pubkey: e.bounty, isSigner: false, isWritable: true },
      { pubkey: e.usdcMint, isSigner: false, isWritable: false },
      { pubkey: e.bountyVault, isSigner: false, isWritable: true },
      { pubkey: e.scout, isSigner: false, isWritable: false },
      { pubkey: e.scoutPayout, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  ];
}

/** Throws unless `instructions` is exactly the payout account's idempotent create, then approve. */
export function checkApproveInstructions(
  instructions: readonly PlainInstruction[],
  expected: ExpectedApprove,
): void {
  check(
    Array.isArray(instructions) && instructions.length === 2,
    "TX_INSTRUCTION_COUNT",
    "the approve transaction carries exactly two instructions (SPEC.md 13.2)",
  );
  const create = instructions[0]!;
  const approve = instructions[1]!;
  check(
    bytesEqual(create.programId, ASSOCIATED_TOKEN_PROGRAM_ID) &&
      bytesEqual(approve.programId, expected.programId),
    "TX_PROGRAM",
    "the Associated Token program then the escrow program (SPEC.md 13.2)",
  );
  const [k0, k1] = expectedApproveKeys(expected);
  check(
    keysEqual(create.keys, k0!) && keysEqual(approve.keys, k1!),
    "TX_ACCOUNTS",
    "the accounts, their order or their flags differ (SPEC.md 13.2)",
  );
  check(
    bytesEqual(create.data, Uint8Array.from([1])) && bytesEqual(approve.data, approveData()),
    "TX_DATA",
    "instruction data differs (SPEC.md 13.2)",
  );
}

// ---------------------------------------------------------------------------
// SPEC.md 13.3 — checkRejectInstructions
// ---------------------------------------------------------------------------

export interface ExpectedReject {
  readonly programId: Uint8Array;
  readonly requester: Uint8Array;
  readonly bounty: Uint8Array;
  readonly requirementId: Uint8Array;
}

/** Throws unless `instructions` is exactly one reject naming `requirementId`. */
export function checkRejectInstructions(
  instructions: readonly PlainInstruction[],
  expected: ExpectedReject,
): void {
  check(
    Array.isArray(instructions) && instructions.length === 1,
    "TX_INSTRUCTION_COUNT",
    "the reject transaction carries exactly one instruction (SPEC.md 13.3)",
  );
  const ix = instructions[0]!;
  check(bytesEqual(ix.programId, expected.programId), "TX_PROGRAM",
    "the escrow program (SPEC.md 13.3)");
  check(
    keysEqual(ix.keys, [
      { pubkey: expected.requester, isSigner: true, isWritable: true },
      { pubkey: expected.bounty, isSigner: false, isWritable: true },
    ]),
    "TX_ACCOUNTS",
    "the accounts, their order or their flags differ (SPEC.md 13.3)",
  );
  check(bytesEqual(ix.data, rejectData(expected.requirementId)), "TX_DATA",
    "instruction data differs (SPEC.md 13.3)");
}

// ---------------------------------------------------------------------------
// SPEC.md 13.4 — submittedScout
// ---------------------------------------------------------------------------

/** The 32 Scout bytes of a Submitted bounty account's data. */
export function submittedScout(data: Uint8Array): Uint8Array {
  check(
    data instanceof Uint8Array &&
      data.length >= 257 &&
      bytesEqual(data.slice(0, 8), BOUNTY_ACCOUNT_DISCRIMINATOR) &&
      data[169] === 2 &&
      data[171] === 1 && data[204] === 1 && data[213] === 1 && data[222] === 1 &&
      data[255] === 1,
    "ACCOUNT_NOT_SUBMITTED",
    "not a Submitted bounty account (SPEC.md 13.4)",
  );
  return data.slice(172, 204);
}
