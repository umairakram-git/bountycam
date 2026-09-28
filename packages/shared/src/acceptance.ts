/**
 * Acceptance-path helpers, implemented to SPEC.md section 9 (Session 18, P2,
 * D127). SPEC.md is normative; where this file and the spec disagree, the spec
 * wins and this file is buggy.
 *
 * Every helper here is pure and platform-free. The phone uses them to check a
 * voucher, build and check the accept transaction, and verify the assigned
 * policy; the race-gate script uses the same ones.
 *
 * This module imports from ./index.js, which re-exports it: the same cycle as
 * funding.ts, safe for the same reason. The constants below are literals, and
 * every call into index.ts happens inside a function at call time.
 */

import { SpecError, canonicalise, sha256, eligibilityMessage } from "./index.js";
import { isValidLat, isValidLon } from "./index.js";
import type { PlainInstruction, PlainAccountMeta } from "./index.js";

// Every rejection passes through this one function so that the check set can
// be removed as a whole to show the negative tests red (HANDOFF Working rules).
function check(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new SpecError(code, message);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const HEX_64 = /^[0-9a-f]{64}$/;

function isI64(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= I64_MIN && value <= I64_MAX;
}

// ---------------------------------------------------------------------------
// SPEC.md 9.1 — acceptData
// ---------------------------------------------------------------------------

/** First 8 bytes of sha256 over "global:accept"; test 112 re-derives it. */
export const ACCEPT_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0x41, 0x96, 0x46, 0xd8, 0x85, 0x06, 0x6b, 0x04,
]);
export const ACCEPT_DATA_LENGTH = 18;

/** The 18 instruction-data bytes of `accept` (SPEC.md 9.1). */
export function acceptData(expiresAt: bigint, verificationIndex: number): Uint8Array {
  check(isI64(expiresAt), "ACCEPT_FIELD_RANGE", "expiresAt must be a bigint within i64");
  check(
    typeof verificationIndex === "number" &&
      Number.isInteger(verificationIndex) &&
      verificationIndex >= 0 &&
      verificationIndex <= 65535,
    "ACCEPT_FIELD_RANGE",
    "verificationIndex must be an integer from 0 to 65535 (SPEC.md 9.1)",
  );
  const out = new Uint8Array(ACCEPT_DATA_LENGTH);
  const view = new DataView(out.buffer);
  out.set(ACCEPT_DISCRIMINATOR, 0);
  view.setBigInt64(8, expiresAt, true);
  view.setUint16(16, verificationIndex, true);
  return out;
}

// ---------------------------------------------------------------------------
// SPEC.md 9.2 — ed25519InstructionData (escrow SPEC section 6.1)
// ---------------------------------------------------------------------------

const ED25519_HEADER_LENGTH = 16;
const ED25519_PUBKEY_OFFSET = 16;
const ED25519_SIGNATURE_OFFSET = 48;
const ED25519_MESSAGE_OFFSET = 112;
const ED25519_MAX_MESSAGE = 65535 - ED25519_MESSAGE_OFFSET;
const THIS_INSTRUCTION = 65535;

function edBytes(value: unknown, name: string): Uint8Array {
  check(value instanceof Uint8Array, "ED25519_FIELD_NOT_BYTES", name + " must be a Uint8Array");
  return value;
}

/** The native ed25519 instruction data in escrow SPEC 6.1's one shape. */
export function ed25519InstructionData(
  authority: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  const key = edBytes(authority, "authority");
  const sig = edBytes(signature, "signature");
  const msg = edBytes(message, "message");
  check(key.length === 32, "ED25519_FIELD_LENGTH", "authority must be 32 bytes");
  check(sig.length === 64, "ED25519_FIELD_LENGTH", "signature must be 64 bytes");
  check(
    msg.length >= 1 && msg.length <= ED25519_MAX_MESSAGE,
    "ED25519_FIELD_LENGTH",
    "message must be 1 to " + ED25519_MAX_MESSAGE + " bytes (SPEC.md 9.2)",
  );
  const out = new Uint8Array(ED25519_MESSAGE_OFFSET + msg.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 0);
  view.setUint16(2, ED25519_SIGNATURE_OFFSET, true);
  view.setUint16(4, THIS_INSTRUCTION, true);
  view.setUint16(6, ED25519_PUBKEY_OFFSET, true);
  view.setUint16(8, THIS_INSTRUCTION, true);
  view.setUint16(10, ED25519_MESSAGE_OFFSET, true);
  view.setUint16(12, msg.length, true);
  view.setUint16(14, THIS_INSTRUCTION, true);
  out.set(key, ED25519_HEADER_LENGTH);
  out.set(sig, ED25519_SIGNATURE_OFFSET);
  out.set(msg, ED25519_MESSAGE_OFFSET);
  return out;
}

// ---------------------------------------------------------------------------
// SPEC.md 9.3 — checkVoucher
// ---------------------------------------------------------------------------

/** A voucher from POST /bounties/:id/voucher, decoded to bytes by the caller. */
export interface Voucher {
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
  readonly authority: Uint8Array;
  readonly expiresAt: bigint;
}

/** What the phone knows independently of the voucher. */
export interface ExpectedVoucher {
  readonly programId: Uint8Array;
  readonly deploymentId: number;
  readonly bountyId: Uint8Array;
  readonly scout: Uint8Array;
  readonly policyHash: Uint8Array;
  readonly eligibilityProfileHash: Uint8Array;
  readonly requiredAssurance: number;
  readonly authority: Uint8Array;
}

/** Throws unless the voucher is exactly what the program will reconstruct. */
export function checkVoucher(voucher: Voucher, expected: ExpectedVoucher): void {
  check(
    isPlainObject(voucher) &&
      voucher.message instanceof Uint8Array &&
      voucher.message.length === 212 &&
      voucher.signature instanceof Uint8Array &&
      voucher.signature.length === 64 &&
      voucher.authority instanceof Uint8Array &&
      voucher.authority.length === 32 &&
      isI64(voucher.expiresAt),
    "VOUCHER_SHAPE_INVALID",
    "a voucher is a 212-byte message, a 64-byte signature, a 32-byte authority and an i64",
  );
  check(
    bytesEqual(voucher.authority, expected.authority),
    "VOUCHER_AUTHORITY_MISMATCH",
    "the voucher's authority is not the eligibility authority",
  );
  let rebuilt: Uint8Array | undefined;
  try {
    rebuilt = eligibilityMessage({
      deploymentId: expected.deploymentId,
      programId: expected.programId,
      bountyId: expected.bountyId,
      requester: voucher.message.slice(75, 107),
      scout: expected.scout,
      policyHash: expected.policyHash,
      eligibilityProfileHash: expected.eligibilityProfileHash,
      requiredAssurance: expected.requiredAssurance,
      expiresAt: voucher.expiresAt,
    });
  } catch {
    rebuilt = undefined;
  }
  check(
    rebuilt !== undefined && bytesEqual(voucher.message, rebuilt),
    "VOUCHER_FIELD_MISMATCH",
    "the voucher message differs from the expected fields (SPEC.md 9.3)",
  );
}

// ---------------------------------------------------------------------------
// SPEC.md 9.4 — checkAcceptInstructions (SECURITY.md section 3)
// ---------------------------------------------------------------------------

/** The native ed25519 program and the Instructions sysvar, as bytes. */
export const ED25519_PROGRAM_ID: Uint8Array = hexToBytes(
  "037d46d67c93fbbe12f9428f838d40ff0570744927f48a64fcca704480000000",
);
export const INSTRUCTIONS_SYSVAR_ID: Uint8Array = hexToBytes(
  "06a7d517187bd16635dad40455fdc2c0c124c68f215675a5dbbacb5f08000000",
);

/** The expected accept transaction, from the phone's own values. */
export interface ExpectedAccept {
  readonly programId: Uint8Array;
  readonly scout: Uint8Array;
  readonly config: Uint8Array;
  readonly bounty: Uint8Array;
  readonly authority: Uint8Array;
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
  readonly expiresAt: bigint;
}

/** The four accounts of SPEC.md 9.4 in order, each with its flags. */
export function expectedAcceptKeys(expected: ExpectedAccept): PlainAccountMeta[] {
  return [
    // D128: the Scout pays the fee, and a fee payer is writable in the message.
    { pubkey: expected.scout, isSigner: true, isWritable: true },
    { pubkey: expected.config, isSigner: false, isWritable: false },
    { pubkey: expected.bounty, isSigner: false, isWritable: true },
    { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
  ];
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

/** Throws unless `instructions` is exactly the ed25519 check followed by `accept`. */
export function checkAcceptInstructions(
  instructions: readonly PlainInstruction[],
  expected: ExpectedAccept,
): void {
  check(
    Array.isArray(instructions) && instructions.length === 2,
    "TX_INSTRUCTION_COUNT",
    "the accept transaction carries exactly two instructions (SPEC.md 9.4)",
  );
  const verify = instructions[0]!;
  const accept = instructions[1]!;
  check(
    bytesEqual(verify.programId, ED25519_PROGRAM_ID) &&
      bytesEqual(accept.programId, expected.programId),
    "TX_PROGRAM",
    "the ed25519 program then the escrow program (SPEC.md 9.4)",
  );
  check(
    verify.keys.length === 0 && keysEqual(accept.keys, expectedAcceptKeys(expected)),
    "TX_ACCOUNTS",
    "the accounts, their order or their flags differ (SPEC.md 9.4)",
  );
  check(
    bytesEqual(
      verify.data,
      ed25519InstructionData(expected.authority, expected.signature, expected.message),
    ) && bytesEqual(accept.data, acceptData(expected.expiresAt, 0)),
    "TX_DATA",
    "instruction data differs (SPEC.md 9.4)",
  );
}

// ---------------------------------------------------------------------------
// SPEC.md 9.5 — verifyAssignedPolicy
// ---------------------------------------------------------------------------

/** The exact location from an assigned-Scout view whose policy hashes as expected. */
export function verifyAssignedPolicy(
  response: unknown,
  expectedPolicyHash: Uint8Array,
): { lat: string; lon: string } {
  check(
    isPlainObject(response) &&
      typeof response["policy_hash"] === "string" &&
      HEX_64.test(response["policy_hash"]) &&
      isPlainObject(response["policy"]),
    "ASSIGNED_SHAPE_INVALID",
    "not an assigned-Scout view (SPEC.md 9.5)",
  );
  const policy = response["policy"] as Record<string, unknown>;
  let text: string | undefined;
  try {
    text = canonicalise(policy);
  } catch {
    text = undefined;
  }
  check(text !== undefined, "ASSIGNED_SHAPE_INVALID", "the policy does not canonicalise");
  const hash = sha256(new TextEncoder().encode(text));
  check(
    expectedPolicyHash instanceof Uint8Array &&
      bytesEqual(hash, expectedPolicyHash) &&
      bytesEqual(hash, hexToBytes(response["policy_hash"] as string)),
    "ASSIGNED_HASH_MISMATCH",
    "the policy does not hash to the expected policy hash (SPEC.md 9.5)",
  );
  const lat = policy["lat"];
  const lon = policy["lon"];
  check(
    typeof lat === "string" && isValidLat(lat) && typeof lon === "string" && isValidLon(lon),
    "ASSIGNED_SHAPE_INVALID",
    "the policy's lat or lon fails the GPS profile (SPEC.md 9.5)",
  );
  return { lat, lon };
}
