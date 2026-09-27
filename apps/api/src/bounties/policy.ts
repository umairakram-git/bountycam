// POLICY.md sections 2, 3 and 6: policy field validation, the sixteen-field
// build, canonical form and hash. Hashing is packages/shared and nothing else
// (SECURITY.md section 5); this module never reimplements it.
import {
  ELIGIBILITY_PROFILES,
  admissibleProfileId,
  canonicalise,
  isValidLat,
  isValidLon,
  sha256,
} from "@hackathon/shared";
import type { Randomness } from "../randomness.ts";

export const DOMAIN_TAG = "BOUNTYCAM_POLICY_V1";
export const FEE_AMOUNT = "0"; // D24: exactly the one-character string.

// POLICY.md section 2.5, the registry, and its assurance bijection are
// packages/shared's ELIGIBILITY_PROFILES and admissibleProfileId (SPEC.md
// section 8.2, D121). This module keeps no copy.

// Section 6.1: ASCII digits, no leading zero — rejects "0", signs, full
// stops, exponent markers and whitespace in one rule.
const REWARD_FORM = /^[1-9][0-9]*$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const U64_MAX_DIGITS = 20;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PolicyLimits {
  cluster: string;
  settlementMint: string;
}

// Extracted field by field from the request body at step 2; the raw body
// object never flows past extraction, so no unknown client key has a path to
// the hash (section 3.1).
export interface ValidatedPolicyInput {
  acceptanceWindowSeconds: number;
  captureRadiusM: number;
  challengeWindowSeconds: number;
  cluster: string | undefined;
  completionWindowSeconds: number;
  eligibilityProfileId: string;
  evidenceRequirements: ReadonlyArray<{
    prompt: string;
    required: boolean;
    type: string;
  }>;
  lat: string;
  lon: string;
  requiredAssurance: number;
  rewardAmount: string;
  settlementMint: string | undefined;
}

export type PolicyFieldError =
  | "INVALID_ASSURANCE"
  | "PROFILE_UNKNOWN"
  | "PROFILE_ASSURANCE_MISMATCH"
  | "CLUSTER_NOT_ALLOWED"
  | "MINT_NOT_ALLOWED"
  | "INVALID_GPS"
  | "INVALID_CAPTURE_RADIUS"
  | "INVALID_WINDOW"
  | "INVALID_REWARD_AMOUNT"
  | "INVALID_REQUIREMENTS"
  | "REQUIREMENT_TYPE_NOT_ALLOWED"
  | "INVALID_REQUIREMENT_PROMPT";

// Section 6.1. String and BigInt operations only (D57): form regex, length
// check before any parse — a 21-digit numeral is a form failure — then a
// BigInt comparison for the 20-digit band above the u64 maximum.
export function isValidRewardAmount(value: string): boolean {
  if (!REWARD_FORM.test(value)) return false;
  if (value.length > U64_MAX_DIGITS) return false;
  return BigInt(value) <= U64_MAX;
}

// Section 8.3 step 5: field rules in the canonical field order of section
// 2.1. The first failure wins. The evidence_requirements list bound — 1 to 20
// items, the section 2.1 field rule — is checked here at its canonical
// position (D63).
export function validatePolicyFields(
  input: ValidatedPolicyInput,
  limits: PolicyLimits,
): PolicyFieldError | null {
  if (
    input.acceptanceWindowSeconds < 60 ||
    input.acceptanceWindowSeconds > 2_592_000
  ) {
    return "INVALID_WINDOW";
  }
  if (input.captureRadiusM < 10 || input.captureRadiusM > 10_000) {
    return "INVALID_CAPTURE_RADIUS";
  }
  if (
    input.challengeWindowSeconds < 60 ||
    input.challengeWindowSeconds > 86_400
  ) {
    return "INVALID_WINDOW";
  }
  if (input.cluster !== undefined && input.cluster !== limits.cluster) {
    return "CLUSTER_NOT_ALLOWED";
  }
  if (
    input.completionWindowSeconds < 60 ||
    input.completionWindowSeconds > 2_592_000
  ) {
    return "INVALID_WINDOW";
  }
  // The canonical position of eligibility_profile_id: registry membership
  // only, because it depends on no other field (section 2.5, D110).
  if (!ELIGIBILITY_PROFILES.has(input.eligibilityProfileId)) {
    return "PROFILE_UNKNOWN";
  }
  if (
    input.evidenceRequirements.length < 1 ||
    input.evidenceRequirements.length > 20
  ) {
    return "INVALID_REQUIREMENTS";
  }
  if (!isValidLat(input.lat)) return "INVALID_GPS";
  if (!isValidLon(input.lon)) return "INVALID_GPS";
  if (input.requiredAssurance < 0 || input.requiredAssurance > 4) {
    return "INVALID_ASSURANCE";
  }
  // Out of canonical position, deliberately (D110). This rule's operands span
  // two field positions, so it is judged at the later one: at the profile's
  // position an assurance of -1 would return PROFILE_ASSURANCE_MISMATCH where
  // INVALID_ASSURANCE is required.
  if (
    admissibleProfileId(input.requiredAssurance) !== input.eligibilityProfileId
  ) {
    return "PROFILE_ASSURANCE_MISMATCH";
  }
  if (!isValidRewardAmount(input.rewardAmount)) {
    return "INVALID_REWARD_AMOUNT";
  }
  if (
    input.settlementMint !== undefined &&
    input.settlementMint !== limits.settlementMint
  ) {
    return "MINT_NOT_ALLOWED";
  }
  return null;
}

// Section 8.3 step 6 (D63): items in index order, keys in canonical order
// within each item — prompt bounds, then type value. A non-boolean required
// is a step 2 type failure, so the only required rule here is list-level:
// at least one true, checked last, after every per-item check.
export function validateRequirements(
  items: ValidatedPolicyInput["evidenceRequirements"],
): PolicyFieldError | null {
  for (const item of items) {
    if (item.prompt.length < 1 || item.prompt.length > 500) {
      return "INVALID_REQUIREMENT_PROMPT";
    }
    if (item.type !== "PHOTO") {
      return "REQUIREMENT_TYPE_NOT_ALLOWED";
    }
  }
  if (!items.some((item) => item.required)) {
    return "INVALID_REQUIREMENTS";
  }
  return null;
}

// Hex encoding exists once in this module, over the interface type: pure
// Uint8Array arithmetic, so a production Buffer and a plain-Uint8Array test
// double take the identical path.
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export interface BuiltRequirement {
  id: string;
  prompt: string;
  required: boolean;
  type: string;
}

export interface BuiltPolicy {
  policy: Record<string, unknown>;
  // The same array object the policy holds, exposed typed so the
  // evidence_requirements insert reads the assigned ids without a cast.
  requirements: ReadonlyArray<BuiltRequirement>;
  canonicalJson: string;
  policyHashBytes: Uint8Array;
  policyHashHex: string;
}

// Sections 2.1 and 3: assemble the sixteen-field object — a literal with
// every key written out, no spread — canonicalise it and hash the UTF-8
// bytes. The salt is 32 bytes from the injectable randomness; each
// requirement id is a fresh v4 uuid from the same module (D54).
export function buildPolicy(
  input: ValidatedPolicyInput,
  limits: PolicyLimits,
  randomness: Randomness,
): BuiltPolicy {
  const salt = bytesToHex(randomness.randomBytes(32));
  if (salt.length !== 64) {
    throw new Error("randomness returned the wrong number of salt bytes");
  }
  const requirements = input.evidenceRequirements.map((item) => {
    const id = randomness.randomUUID();
    if (!UUID_V4.test(id)) {
      throw new Error("randomness returned a malformed requirement id");
    }
    return {
      id,
      prompt: item.prompt,
      required: item.required,
      type: item.type,
    };
  });
  const policy = {
    acceptance_window_seconds: input.acceptanceWindowSeconds,
    capture_radius_m: input.captureRadiusM,
    chain: "solana",
    challenge_window_seconds: input.challengeWindowSeconds,
    cluster: input.cluster ?? limits.cluster,
    completion_window_seconds: input.completionWindowSeconds,
    domain_tag: DOMAIN_TAG,
    eligibility_profile_id: input.eligibilityProfileId,
    evidence_requirements: requirements,
    fee_amount: FEE_AMOUNT,
    lat: input.lat,
    lon: input.lon,
    required_assurance: input.requiredAssurance,
    reward_amount: input.rewardAmount,
    salt,
    settlement_mint: input.settlementMint ?? limits.settlementMint,
  };
  const canonicalJson = canonicalise(policy);
  const policyHashBytes = sha256(new TextEncoder().encode(canonicalJson));
  return {
    policy,
    requirements,
    canonicalJson,
    policyHashBytes,
    policyHashHex: bytesToHex(policyHashBytes),
  };
}
