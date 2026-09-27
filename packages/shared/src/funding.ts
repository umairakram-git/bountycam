/**
 * Funding-path helpers, implemented to SPEC.md section 8 (Session 17, P1,
 * D121). SPEC.md is normative; where this file and the spec disagree, the
 * spec wins and this file is buggy.
 *
 * Every helper here is pure and platform-free. The phone and the API both
 * import them from @hackathon/shared; nothing reimplements them elsewhere.
 *
 * This module imports the primitives from ./index.js, and index.ts re-exports
 * this module, which is a cycle. It is safe because nothing at this module's
 * top level calls an index.ts export: the constants below are literals, and
 * every call happens inside a function at call time.
 */

import { SpecError, canonicalise, sha256, eligibilityProfileHash } from "./index.js";
import type { EligibilityProfile } from "./index.js";

// Every rejection passes through this one function so that the check set can
// be removed as a whole to show the negative tests red (HANDOFF Working rules).
function check(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new SpecError(code, message);
}

// The validators return this instead of a literal false, for the same reason.
const REJECTED = false;

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

const U64_MAX = (1n << 64n) - 1n;
const HEX_64 = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPEC.md 8.1 — the GPS profile (the rules are POLICY.md section 5)
// ---------------------------------------------------------------------------

// Rules 1 to 5: ASCII digits only, at most one leading hyphen-minus, an
// integer part without leading zeros, exactly one full stop, exactly seven
// fraction digits. [0-9] without the u flag matches no other script's digits.
const GPS_FORM = /^-?(?:0|[1-9][0-9]*)\.[0-9]{7}$/;
const GPS_SCALE = 10_000_000n;

function scaled(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

// Rules 1 to 6.
function gpsForm(value: unknown): boolean {
  if (typeof value !== "string" || !GPS_FORM.test(value)) return false;
  // Rule 6: a sign appears only when the value is strictly negative.
  if (value.startsWith("-") && scaled(value) === 0n) return false;
  return true;
}

// Rule 7, after the form rules; callers pass a form-valid string.
function gpsInRange(value: string, maxDegrees: bigint): boolean {
  const bound = maxDegrees * GPS_SCALE;
  const s = scaled(value);
  return s >= -bound && s <= bound;
}

/** True exactly when `value` passes POLICY.md section 5 rules 1 to 7 as a latitude. */
export function isValidLat(value: string): boolean {
  if (!gpsForm(value) || !gpsInRange(value, 90n)) return REJECTED;
  return true;
}

/** True exactly when `value` passes POLICY.md section 5 rules 1 to 7 as a longitude. */
export function isValidLon(value: string): boolean {
  if (!gpsForm(value) || !gpsInRange(value, 180n)) return REJECTED;
  return true;
}

/**
 * The coordinate times ten million, exactly. Requires rules 1 to 6 only, so
 * the POLICY.md section 9 snap can scale a value it has not range-checked.
 */
export function gpsToScaled(value: string): bigint {
  check(gpsForm(value), "GPS_FORM_INVALID", "not a seven-decimal coordinate (SPEC.md 8.1)");
  return scaled(value);
}

/**
 * The producer: a number to the seven-decimal profile string for its axis.
 * Rounding is Number.prototype.toFixed's. Negative zero becomes `0.0000000`.
 */
export function formatCoordinate(degrees: number, axis: "lat" | "lon"): string {
  check(
    typeof degrees === "number" && Number.isFinite(degrees),
    "GPS_NOT_FINITE",
    "a coordinate must be a finite number (SPEC.md 8.1)",
  );
  let text = degrees.toFixed(7);
  if (text === "-0.0000000") text = "0.0000000";
  check(
    axis === "lat" ? isValidLat(text) : isValidLon(text),
    "GPS_OUT_OF_RANGE",
    "formatted coordinate is outside the " + axis + " range (SPEC.md 8.1)",
  );
  return text;
}

// Space, tab, line feed, carriage return — built from code points (D31).
const PAIR_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d].map((c) => String.fromCharCode(c));
const PAIR_PART = /^-?[0-9]+(?:\.[0-9]+)?$/;

function trimPair(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PAIR_WHITESPACE.includes(text.charAt(start))) start++;
  while (end > start && PAIR_WHITESPACE.includes(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/** A `lat, lon` pair pasted from a map app, to the two profile strings (D122). */
export function parseCoordinatePair(text: string): { lat: string; lon: string } {
  check(typeof text === "string", "GPS_PAIR_INVALID", "the pair must be a string (SPEC.md 8.1)");
  const parts = trimPair(text).split(",");
  check(parts.length === 2, "GPS_PAIR_INVALID", "the pair must hold exactly one comma");
  const lat = trimPair(parts[0]!);
  const lon = trimPair(parts[1]!);
  check(
    PAIR_PART.test(lat) && PAIR_PART.test(lon),
    "GPS_PAIR_INVALID",
    "each part must be a plain decimal number (SPEC.md 8.1)",
  );
  return { lat: formatCoordinate(Number(lat), "lat"), lon: formatCoordinate(Number(lon), "lon") };
}

// ---------------------------------------------------------------------------
// SPEC.md 8.2 — the eligibility profile registry (POLICY.md section 2.5)
// ---------------------------------------------------------------------------

/** The two registry rows, as the SPEC.md section 7.1 objects. The only copy. */
export const ELIGIBILITY_PROFILES: ReadonlyMap<string, EligibilityProfile> = new Map([
  [
    "BASE_V1",
    {
      domain_tag: "BOUNTYCAM_ELIGIBILITY_PROFILE_V1",
      profile_id: "BASE_V1",
      requires_sgt: false,
    },
  ],
  [
    "A4_SEEKER_V1",
    {
      domain_tag: "BOUNTYCAM_ELIGIBILITY_PROFILE_V1",
      profile_id: "A4_SEEKER_V1",
      requires_sgt: true,
    },
  ],
]);

/** The bijection of POLICY.md section 2.5: 0 to 3 admit BASE_V1, 4 admits A4_SEEKER_V1. */
export function admissibleProfileId(requiredAssurance: number): string {
  check(
    typeof requiredAssurance === "number" &&
      Number.isInteger(requiredAssurance) &&
      requiredAssurance >= 0 &&
      requiredAssurance <= 4,
    "ASSURANCE_OUT_OF_RANGE",
    "required assurance must be an integer from 0 to 4 (SPEC.md 8.2)",
  );
  return requiredAssurance === 4 ? "A4_SEEKER_V1" : "BASE_V1";
}

// ---------------------------------------------------------------------------
// SPEC.md 8.3 — uuidBytes
// ---------------------------------------------------------------------------

const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 16 bytes of a lowercase hyphenated uuid, hex pairs in written order. */
export function uuidBytes(uuid: string): Uint8Array {
  check(
    typeof uuid === "string" && UUID_FORM.test(uuid),
    "UUID_FORM_INVALID",
    "not a lowercase hyphenated uuid (SPEC.md 8.3)",
  );
  return hexToBytes(uuid.replace(/-/g, ""));
}

// ---------------------------------------------------------------------------
// SPEC.md 8.4 — createAndFundData
// ---------------------------------------------------------------------------

/** First 8 bytes of sha256 over "global:create_and_fund"; test 94 re-derives it. */
export const CREATE_AND_FUND_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0x51, 0xf1, 0x53, 0xb3, 0x13, 0xcb, 0xa7, 0x40,
]);
export const CREATE_AND_FUND_DATA_LENGTH = 121;
export const MAX_ACCEPTANCE_WINDOW_SECS = 2_592_000n;
export const MAX_COMPLETION_WINDOW_SECS = 2_592_000n;
export const MAX_REVIEW_WINDOW_SECS = 86_400n;

/** The arguments of `create_and_fund`, in the program's order. */
export interface FundingArgs {
  readonly bountyId: Uint8Array;
  readonly rewardAmount: bigint;
  readonly policyHash: Uint8Array;
  readonly eligibilityProfileHash: Uint8Array;
  readonly requiredAssurance: number;
  readonly acceptanceWindowSecs: bigint;
  readonly completionWindowSecs: bigint;
  readonly reviewWindowSecs: bigint;
}

function fundBytes(value: unknown, width: number, name: string): Uint8Array {
  check(value instanceof Uint8Array, "FUND_FIELD_NOT_BYTES", name + " must be a Uint8Array");
  check(value.length === width, "FUND_FIELD_LENGTH", name + " must be " + width + " bytes");
  return value;
}

function fundBigint(value: unknown, min: bigint, max: bigint, name: string): bigint {
  check(
    typeof value === "bigint" && value >= min && value <= max,
    "FUND_FIELD_RANGE",
    name + " must be a bigint from " + min + " to " + max + " (SPEC.md 8.4)",
  );
  return value;
}

/** The 121 instruction-data bytes of `create_and_fund` (SPEC.md 8.4). */
export function createAndFundData(args: FundingArgs): Uint8Array {
  const bountyId = fundBytes(args.bountyId, 16, "bountyId");
  const rewardAmount = fundBigint(args.rewardAmount, 1n, U64_MAX, "rewardAmount");
  const policyHash = fundBytes(args.policyHash, 32, "policyHash");
  const profileHash = fundBytes(args.eligibilityProfileHash, 32, "eligibilityProfileHash");
  const assurance = args.requiredAssurance;
  check(
    typeof assurance === "number" &&
      Number.isInteger(assurance) &&
      assurance >= 0 &&
      assurance <= 4,
    "FUND_FIELD_RANGE",
    "requiredAssurance must be an integer from 0 to 4 (SPEC.md 8.4)",
  );
  const acceptance = fundBigint(
    args.acceptanceWindowSecs, 1n, MAX_ACCEPTANCE_WINDOW_SECS, "acceptanceWindowSecs",
  );
  const completion = fundBigint(
    args.completionWindowSecs, 1n, MAX_COMPLETION_WINDOW_SECS, "completionWindowSecs",
  );
  const review = fundBigint(args.reviewWindowSecs, 1n, MAX_REVIEW_WINDOW_SECS, "reviewWindowSecs");

  const out = new Uint8Array(CREATE_AND_FUND_DATA_LENGTH);
  const view = new DataView(out.buffer);
  out.set(CREATE_AND_FUND_DISCRIMINATOR, 0);
  out.set(bountyId, 8);
  view.setBigUint64(24, rewardAmount, true);
  out.set(policyHash, 32);
  out.set(profileHash, 64);
  view.setUint8(96, assurance);
  view.setBigInt64(97, acceptance, true);
  view.setBigInt64(105, completion, true);
  view.setBigInt64(113, review, true);
  return out;
}

// ---------------------------------------------------------------------------
// SPEC.md 8.5 — verifyCreatedBounty (POLICY.md section 3.5 as one function)
// ---------------------------------------------------------------------------

export interface ExpectedRequirement {
  readonly prompt: string;
  readonly required: boolean;
  readonly type: string;
}

/** The ten request-source fields of POLICY.md section 2.1, as the client sent them. */
export interface ExpectedPolicyRequest {
  readonly acceptance_window_seconds: number;
  readonly capture_radius_m: number;
  readonly challenge_window_seconds: number;
  readonly completion_window_seconds: number;
  readonly eligibility_profile_id: string;
  readonly evidence_requirements: readonly ExpectedRequirement[];
  readonly lat: string;
  readonly lon: string;
  readonly required_assurance: number;
  readonly reward_amount: string;
}

export interface CreatedBountyExpectation {
  readonly cluster: string;
  readonly settlementMint: string;
  readonly title: string;
  readonly category: string;
  readonly policy: ExpectedPolicyRequest;
}

const POLICY_KEYS = [
  "acceptance_window_seconds",
  "capture_radius_m",
  "chain",
  "challenge_window_seconds",
  "cluster",
  "completion_window_seconds",
  "domain_tag",
  "eligibility_profile_id",
  "evidence_requirements",
  "fee_amount",
  "lat",
  "lon",
  "required_assurance",
  "reward_amount",
  "salt",
  "settlement_mint",
] as const;
const INTEGER_KEYS = [
  "acceptance_window_seconds",
  "capture_radius_m",
  "challenge_window_seconds",
  "completion_window_seconds",
  "required_assurance",
] as const;
const STRING_KEYS = [
  "chain",
  "cluster",
  "domain_tag",
  "eligibility_profile_id",
  "fee_amount",
  "lat",
  "lon",
  "reward_amount",
  "salt",
  "settlement_mint",
] as const;
const REQUIREMENT_KEYS = ["id", "prompt", "required", "type"] as const;
// POLICY.md section 6.1: digits, no leading zero, at most the u64 maximum.
const REWARD_FORM = /^[1-9][0-9]*$/;

const SHAPE = "CREATED_SHAPE_INVALID";

function sameKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(object).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

function checkShape(
  response: unknown,
): {
  id: string;
  title: string;
  category: string;
  policyHash: string;
  policy: Record<string, unknown>;
} {
  check(isPlainObject(response), SHAPE, "the response must be a plain object (SPEC.md 8.5)");
  const id = response["id"];
  check(typeof id === "string" && UUID_FORM.test(id), SHAPE, "id must be a uuid");
  const title = response["title"];
  const category = response["category"];
  check(typeof title === "string" && typeof category === "string", SHAPE, "title, category");
  check(response["state"] === "DRAFT", SHAPE, "state must be DRAFT");
  const policyHash = response["policy_hash"];
  check(typeof policyHash === "string" && HEX_64.test(policyHash), SHAPE, "policy_hash form");
  const policy = response["policy"];
  check(isPlainObject(policy), SHAPE, "policy must be a plain object");
  check(sameKeys(policy, POLICY_KEYS), SHAPE, "policy must carry exactly the sixteen fields");
  for (const key of INTEGER_KEYS) {
    check(Number.isSafeInteger(policy[key]), SHAPE, key + " must be a safe integer");
  }
  for (const key of STRING_KEYS) {
    check(typeof policy[key] === "string", SHAPE, key + " must be a string");
  }
  const reward = policy["reward_amount"] as string;
  check(
    REWARD_FORM.test(reward) && reward.length <= 20 && BigInt(reward) <= U64_MAX,
    SHAPE,
    "reward_amount must be a base-unit integer string within u64",
  );
  check(HEX_64.test(policy["salt"] as string), SHAPE, "salt must be 64 lowercase hex characters");
  const requirements = policy["evidence_requirements"];
  check(Array.isArray(requirements), SHAPE, "evidence_requirements must be an array");
  const ids = new Set<string>();
  for (const item of requirements as unknown[]) {
    check(isPlainObject(item), SHAPE, "each requirement must be a plain object");
    check(sameKeys(item, REQUIREMENT_KEYS), SHAPE, "each requirement carries exactly four keys");
    const itemId = item["id"];
    check(typeof itemId === "string" && UUID_FORM.test(itemId), SHAPE, "requirement id form");
    check(!ids.has(itemId), SHAPE, "requirement ids must be distinct");
    ids.add(itemId);
    check(typeof item["prompt"] === "string", SHAPE, "requirement prompt must be a string");
    check(typeof item["required"] === "boolean", SHAPE, "requirement required must be boolean");
    check(typeof item["type"] === "string", SHAPE, "requirement type must be a string");
  }
  return { id, title, category, policyHash, policy };
}

/**
 * POLICY.md section 3.5, steps 1 to 5, then the funding arguments. The
 * return value is the only source the funding transaction may be built from.
 */
export function verifyCreatedBounty(
  response: unknown,
  expected: CreatedBountyExpectation,
): FundingArgs {
  // Step 1.
  const r = checkShape(response);
  const p = r.policy;

  // Step 2.
  let text: string;
  try {
    text = canonicalise(p);
  } catch (error) {
    if (error instanceof SpecError) throw new SpecError(SHAPE, "policy is not canonicalisable");
    throw error;
  }
  const policyHash = hexToBytes(r.policyHash);
  check(
    bytesEqual(sha256(new TextEncoder().encode(text)), policyHash),
    "CREATED_HASH_MISMATCH",
    "policy_hash is not the hash of the returned policy (SPEC.md 8.5)",
  );

  // Step 3.
  check(
    p["chain"] === "solana" &&
      p["domain_tag"] === "BOUNTYCAM_POLICY_V1" &&
      p["fee_amount"] === "0",
    "CREATED_CONSTANT_MISMATCH",
    "a constant field does not carry its documented value (SPEC.md 8.5)",
  );

  // Step 4.
  check(
    p["cluster"] === expected.cluster && p["settlement_mint"] === expected.settlementMint,
    "CREATED_ENVIRONMENT_MISMATCH",
    "cluster or settlement_mint is not this client's environment (SPEC.md 8.5)",
  );

  // Step 5.
  const e = expected.policy;
  const FIELD = "CREATED_FIELD_MISMATCH";
  check(r.title === expected.title && r.category === expected.category, FIELD, "title, category");
  check(
    p["acceptance_window_seconds"] === e.acceptance_window_seconds &&
      p["capture_radius_m"] === e.capture_radius_m &&
      p["challenge_window_seconds"] === e.challenge_window_seconds &&
      p["completion_window_seconds"] === e.completion_window_seconds &&
      p["eligibility_profile_id"] === e.eligibility_profile_id &&
      p["lat"] === e.lat &&
      p["lon"] === e.lon &&
      p["required_assurance"] === e.required_assurance &&
      p["reward_amount"] === e.reward_amount,
    FIELD,
    "a request field differs from what was sent (SPEC.md 8.5)",
  );
  const items = p["evidence_requirements"] as Record<string, unknown>[];
  check(items.length === e.evidence_requirements.length, FIELD, "requirement count differs");
  for (let i = 0; i < items.length; i++) {
    const got = items[i]!;
    const want = e.evidence_requirements[i]!;
    check(
      got["prompt"] === want.prompt &&
        got["required"] === want.required &&
        got["type"] === want.type,
      FIELD,
      "requirement " + i + " differs from what was sent (SPEC.md 8.5)",
    );
  }
  const profile = ELIGIBILITY_PROFILES.get(p["eligibility_profile_id"] as string);
  check(profile !== undefined, FIELD, "eligibility_profile_id is not in the registry");

  // Step 6.
  return {
    bountyId: uuidBytes(r.id),
    rewardAmount: BigInt(p["reward_amount"] as string),
    policyHash,
    eligibilityProfileHash: eligibilityProfileHash(profile),
    requiredAssurance: p["required_assurance"] as number,
    acceptanceWindowSecs: BigInt(p["acceptance_window_seconds"] as number),
    completionWindowSecs: BigInt(p["completion_window_seconds"] as number),
    reviewWindowSecs: BigInt(p["challenge_window_seconds"] as number),
  };
}

// ---------------------------------------------------------------------------
// SPEC.md 8.6 — decimalToBaseUnits
// ---------------------------------------------------------------------------

/** A typed decimal amount to its base-unit integer string. No double is involved. */
export function decimalToBaseUnits(text: string, decimals: number): string {
  check(
    typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18,
    "AMOUNT_FORM_INVALID",
    "decimals must be an integer from 0 to 18 (SPEC.md 8.6)",
  );
  // [.] rather than an escaped full stop, so no backslash is written (D31).
  const form = new RegExp("^(0|[1-9][0-9]*)([.][0-9]{1," + String(Math.max(decimals, 1)) + "})?$");
  check(
    typeof text === "string" && form.test(text) && (decimals > 0 || !text.includes(".")),
    "AMOUNT_FORM_INVALID",
    "not a decimal amount with at most " + decimals + " fraction digits (SPEC.md 8.6)",
  );
  const [whole, fraction = ""] = text.split(".") as [string, string?];
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  check(value >= 1n && value <= U64_MAX, "AMOUNT_OUT_OF_RANGE", "amount must be 1 to u64 max");
  return value.toString();
}

// ---------------------------------------------------------------------------
// SPEC.md 8.7 — checkFundingInstructions (SECURITY.md section 3)
// ---------------------------------------------------------------------------

export interface PlainAccountMeta {
  readonly pubkey: Uint8Array;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface PlainInstruction {
  readonly programId: Uint8Array;
  readonly keys: readonly PlainAccountMeta[];
  readonly data: Uint8Array;
}

/** The expected instruction, from the phone's own derivations. */
export interface ExpectedFunding {
  readonly programId: Uint8Array;
  readonly requester: Uint8Array;
  readonly config: Uint8Array;
  readonly bounty: Uint8Array;
  readonly usdcMint: Uint8Array;
  readonly bountyVault: Uint8Array;
  readonly requesterAta: Uint8Array;
  readonly data: Uint8Array;
}

// The three program addresses, as bytes: Token, Associated Token, System.
export const TOKEN_PROGRAM_ID: Uint8Array = hexToBytes(
  "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID: Uint8Array = hexToBytes(
  "8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859",
);
export const SYSTEM_PROGRAM_ID: Uint8Array = new Uint8Array(32);

/** The nine accounts of SPEC.md 8.7 in order, each with its signer and writable flags. */
export function expectedFundingKeys(expected: ExpectedFunding): PlainAccountMeta[] {
  return [
    { pubkey: expected.requester, isSigner: true, isWritable: true },
    { pubkey: expected.config, isSigner: false, isWritable: false },
    { pubkey: expected.bounty, isSigner: false, isWritable: true },
    { pubkey: expected.usdcMint, isSigner: false, isWritable: false },
    { pubkey: expected.bountyVault, isSigner: false, isWritable: true },
    { pubkey: expected.requesterAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

/** Throws unless `instructions` is exactly the one expected funding instruction. */
export function checkFundingInstructions(
  instructions: readonly PlainInstruction[],
  expected: ExpectedFunding,
): void {
  check(
    Array.isArray(instructions) && instructions.length === 1,
    "TX_INSTRUCTION_COUNT",
    "the funding transaction carries exactly one instruction (SPEC.md 8.7)",
  );
  const ix = instructions[0]!;
  check(bytesEqual(ix.programId, expected.programId), "TX_PROGRAM", "not the escrow program");
  const want = expectedFundingKeys(expected);
  check(
    ix.keys.length === want.length &&
      want.every((w, i) => {
        const k = ix.keys[i]!;
        return (
          bytesEqual(k.pubkey, w.pubkey) &&
          k.isSigner === w.isSigner &&
          k.isWritable === w.isWritable
        );
      }),
    "TX_ACCOUNTS",
    "the nine accounts, their order or their flags differ (SPEC.md 8.7)",
  );
  check(bytesEqual(ix.data, expected.data), "TX_DATA", "instruction data differs (SPEC.md 8.7)");
}
