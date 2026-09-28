/**
 * Canonicalisation and hashing primitives, implemented to SPEC.md in this
 * package. SPEC.md is normative; where this implementation and the spec
 * disagree, the spec wins and this implementation is buggy.
 *
 * This module is the ONLY place in the monorepo where canonicalisation
 * and hashing are implemented. Do not reimplement these elsewhere —
 * import them from @hackathon/shared.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/**
 * Thrown for every input this package rejects. `code` names the violated
 * rule per SPEC.md §6. Codes are normative for this package only; other
 * implementations must reject the same inputs but need not match codes.
 */
export class SpecError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpecError";
    this.code = code;
  }
}

// Backslash built from its code point rather than written literally (D31).
const BS = String.fromCharCode(0x5c);

const MAX_DEPTH = 64;

// The five C0 characters with two-character escape forms (SPEC.md §1.4).
const TWO_CHAR_ESCAPES = new Map<number, string>([
  [0x08, "b"],
  [0x09, "t"],
  [0x0a, "n"],
  [0x0c, "f"],
  [0x0d, "r"],
]);

function serialiseNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new SpecError("NON_FINITE_NUMBER", "NaN and Infinity have no JSON representation");
  }
  if (!Number.isInteger(n)) {
    throw new SpecError("NON_INTEGER_NUMBER", "non-integer numbers are rejected (SPEC.md 1.3)");
  }
  if (!Number.isSafeInteger(n)) {
    throw new SpecError("UNSAFE_INTEGER", "integer outside the safe range (SPEC.md 1.3)");
  }
  return Object.is(n, -0) ? "0" : String(n);
}

function serialiseString(s: string): string {
  const parts: string[] = ['"'];
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu === 0x22) {
      parts.push(BS + '"');
    } else if (cu === 0x5c) {
      parts.push(BS + BS);
    } else if (TWO_CHAR_ESCAPES.has(cu)) {
      parts.push(BS + TWO_CHAR_ESCAPES.get(cu)!);
    } else if (cu < 0x20) {
      parts.push(BS + "u" + cu.toString(16).padStart(4, "0"));
    } else if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new SpecError("LONE_SURROGATE", "unpaired high surrogate has no UTF-8 encoding");
      }
      parts.push(s.charAt(i) + s.charAt(i + 1));
      i++;
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      throw new SpecError("LONE_SURROGATE", "unpaired low surrogate has no UTF-8 encoding");
    } else {
      parts.push(s.charAt(i));
    }
  }
  parts.push('"');
  return parts.join("");
}

function serialiseValue(value: unknown, path: object[], depth: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serialiseNumber(value);
  if (typeof value === "string") return serialiseString(value);
  if (typeof value === "undefined") {
    throw new SpecError("UNDEFINED", "undefined is rejected anywhere it appears (SPEC.md 1.6)");
  }
  if (typeof value === "bigint") {
    throw new SpecError("BIGINT", "BigInt has no JSON representation; pass it as a string");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new SpecError("FUNCTION_OR_SYMBOL", "functions and symbols are not data");
  }
  if (Array.isArray(value)) return serialiseArray(value, path, depth);
  return serialiseObject(value as object, path, depth);
}

function serialiseArray(arr: unknown[], path: object[], depth: number): string {
  // Check order is normative (SPEC.md 6.3): plainness, then cycle, then depth.
  if (Object.getPrototypeOf(arr) !== Array.prototype) {
    throw new SpecError("NON_PLAIN_OBJECT", "array prototype is not Array.prototype");
  }
  if (path.includes(arr)) {
    throw new SpecError("CYCLIC", "container is its own ancestor on the traversal path");
  }
  if (depth > MAX_DEPTH) {
    throw new SpecError("DEPTH_LIMIT", "nesting depth greater than " + String(MAX_DEPTH));
  }
  for (const key of Reflect.ownKeys(arr)) {
    if (typeof key === "symbol") {
      throw new SpecError("ARRAY_EXTRA_PROPERTY", "arrays carry only indices and length");
    }
    if (key === "length") continue;
    const n = Number(key);
    if (!(Number.isInteger(n) && n >= 0 && n < arr.length && String(n) === key)) {
      throw new SpecError("ARRAY_EXTRA_PROPERTY", "arrays carry only indices and length");
    }
  }
  path.push(arr);
  const parts: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(arr, i);
    if (desc === undefined) {
      throw new SpecError("ARRAY_HOLE", "sparse arrays are rejected (SPEC.md 1.1)");
    }
    if ("get" in desc) {
      throw new SpecError("ACCESSOR_PROPERTY", "accessor properties are rejected (SPEC.md 1.1)");
    }
    if (!desc.enumerable) {
      throw new SpecError("NON_ENUMERABLE_PROPERTY", "non-enumerable array index (SPEC.md 1.1)");
    }
    parts.push(serialiseValue(desc.value, path, depth + 1));
  }
  path.pop();
  return "[" + parts.join(",") + "]";
}

function serialiseObject(obj: object, path: object[], depth: number): string {
  // Check order is normative (SPEC.md 6.3): plainness, then cycle, then depth.
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new SpecError("NON_PLAIN_OBJECT", "object prototype is not Object.prototype or null");
  }
  if (path.includes(obj)) {
    throw new SpecError("CYCLIC", "container is its own ancestor on the traversal path");
  }
  if (depth > MAX_DEPTH) {
    throw new SpecError("DEPTH_LIMIT", "nesting depth greater than " + String(MAX_DEPTH));
  }
  const keys: string[] = [];
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") {
      throw new SpecError("SYMBOL_KEY", "symbol-keyed properties are invisible to JSON");
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key)!;
    if ("get" in desc) {
      throw new SpecError("ACCESSOR_PROPERTY", "accessor properties are rejected (SPEC.md 1.1)");
    }
    if (!desc.enumerable) {
      throw new SpecError("NON_ENUMERABLE_PROPERTY", "non-enumerable own property (SPEC.md 1.1)");
    }
    keys.push(key);
    values.set(key, desc.value);
  }
  // Default sort compares UTF-16 code units — exactly SPEC.md 1.2 / RFC 8785 3.2.3.
  keys.sort();
  path.push(obj);
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(serialiseString(key) + ":" + serialiseValue(values.get(key), path, depth + 1));
  }
  path.pop();
  return "{" + parts.join(",") + "}";
}

/**
 * Serialise a value into its canonical JSON text per SPEC.md §1.
 *
 * RFC 8785 baseline with stated deviations: only safe integers are accepted
 * as numbers (fractional quantities travel as strings under the SPEC.md §1.3
 * domain profiles); object keys sort by UTF-16 code units; no unicode
 * normalisation; no whitespace outside string contents.
 *
 * Every rejected input throws {@link SpecError} with a §6.1 code.
 */
export function canonicalise(value: unknown): string {
  return serialiseValue(value, [], 1);
}

/**
 * SHA-256 (FIPS 180-4) of exactly the bytes in the given view (SPEC.md §2).
 *
 * Accepts any `Uint8Array` instance, including `Buffer`. Everything else
 * throws {@link SpecError} with code `NOT_BYTES`.
 *
 * @returns the raw 32-byte digest
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new SpecError("NOT_BYTES", "sha256 input must be a Uint8Array instance (SPEC.md 2)");
  }
  return nobleSha256(bytes);
}

function leafNode(h: Uint8Array): Uint8Array {
  const buf = new Uint8Array(33);
  buf[0] = 0x00;
  buf.set(h, 1);
  return nobleSha256(buf);
}

function internalNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(65);
  buf[0] = 0x01;
  buf.set(left, 1);
  buf.set(right, 33);
  return nobleSha256(buf);
}

/**
 * Merkle root over an ordered list of 32-byte digests (SPEC.md §3).
 *
 * RFC 6962-style domain separation: leaves re-hash under a one-byte 0x00
 * prefix, internal nodes under 0x01. Pairing is left-to-right; an odd node
 * is promoted unchanged; the empty list is rejected; a single element's
 * root is its leaf node. Rejections throw {@link SpecError} (§6.2).
 *
 * @param hashes ordered list of 32-byte digests — order is never sorted here
 * @returns the 32-byte root
 */
export function merkleRoot(hashes: Uint8Array[]): Uint8Array {
  if (!Array.isArray(hashes)) {
    throw new SpecError("NOT_AN_ARRAY", "merkleRoot input must be an array (SPEC.md 3.2)");
  }
  if (hashes.length === 0) {
    throw new SpecError("EMPTY_LIST", "the empty list has no root (SPEC.md 3.3)");
  }
  for (const h of hashes) {
    if (!(h instanceof Uint8Array)) {
      throw new SpecError("ELEMENT_NOT_BYTES", "every element must be a Uint8Array instance");
    }
    if (h.length !== 32) {
      throw new SpecError("ELEMENT_NOT_32_BYTES", "every element view must be exactly 32 bytes");
    }
  }
  let level = hashes.map(leafNode);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    let i = 0;
    for (; i + 1 < level.length; i += 2) {
      next.push(internalNode(level[i]!, level[i + 1]!));
    }
    if (i < level.length) {
      next.push(level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

// ---------------------------------------------------------------------------
// Eligibility profiles (SPEC.md section 7)
// ---------------------------------------------------------------------------

/**
 * A version 1 eligibility profile (SPEC.md §7.1): exactly three keys, no more
 * and no fewer. Which ids exist and what each one requires operationally is
 * the registry, and the registry lives in apps/api/POLICY.md — not here.
 */
export interface EligibilityProfile {
  readonly domain_tag: string;
  readonly profile_id: string;
  readonly requires_sgt: boolean;
}

const PROFILE_DOMAIN_TAG = "BOUNTYCAM_ELIGIBILITY_PROFILE_V1";

// SPEC.md §7.2: uppercase ASCII letters, digits and underscore; the first
// character a letter, so neither an underscore nor a digit can begin an id;
// ending with _V and one or more digits. Length is checked separately so the
// 1..40 bound reads as the spec states it.
const PROFILE_ID_FORM = /^[A-Z][A-Z0-9_]*_V[0-9]+$/;

function profileField(profile: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(profile, key);
  if (desc === undefined || !("value" in desc) || !desc.enumerable) {
    throw new SpecError(
      "PROFILE_SHAPE_INVALID",
      "profile key " + key + " must be an enumerable data property (SPEC.md 7.1)",
    );
  }
  return desc.value;
}

/**
 * The 32-byte commitment to an eligibility profile (SPEC.md §7.3).
 *
 * Hashes the profile's contents, never its id alone: changing what an id
 * requires changes this hash, so a voucher for a bounty funded under the old
 * definition fails loudly rather than passing under new rules (§7.5).
 *
 * Validation precedes canonicalisation. Shape faults throw
 * `PROFILE_SHAPE_INVALID`; a malformed id throws `PROFILE_ID_INVALID`.
 *
 * @returns the raw 32-byte digest, not hex
 */
export function eligibilityProfileHash(profile: EligibilityProfile): Uint8Array {
  const proto: unknown =
    profile === null || typeof profile !== "object"
      ? undefined
      : Object.getPrototypeOf(profile);
  if (proto !== Object.prototype && proto !== null) {
    throw new SpecError(
      "PROFILE_SHAPE_INVALID",
      "a profile must be a plain object (SPEC.md 7.1)",
    );
  }
  if (Reflect.ownKeys(profile).length !== 3) {
    throw new SpecError(
      "PROFILE_SHAPE_INVALID",
      "a version 1 profile carries exactly three keys (SPEC.md 7.1)",
    );
  }
  const domainTag = profileField(profile, "domain_tag");
  const profileId = profileField(profile, "profile_id");
  const requiresSgt = profileField(profile, "requires_sgt");
  if (domainTag !== PROFILE_DOMAIN_TAG) {
    throw new SpecError(
      "PROFILE_SHAPE_INVALID",
      "domain_tag must be exactly " + PROFILE_DOMAIN_TAG + " (SPEC.md 7.1)",
    );
  }
  if (typeof profileId !== "string" || typeof requiresSgt !== "boolean") {
    throw new SpecError(
      "PROFILE_SHAPE_INVALID",
      "profile_id must be a string and requires_sgt a boolean (SPEC.md 7.1)",
    );
  }
  if (profileId.length < 1 || profileId.length > 40 || !PROFILE_ID_FORM.test(profileId)) {
    throw new SpecError(
      "PROFILE_ID_INVALID",
      "profile_id does not satisfy the SPEC.md 7.2 format",
    );
  }
  // Rebuilt from the three validated values, so the text that is hashed is
  // exactly what this function checked.
  const text = canonicalise({
    domain_tag: domainTag,
    profile_id: profileId,
    requires_sgt: requiresSgt,
  });
  return sha256(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Eligibility voucher message (MESSAGES.md section 4)

export const ELIGIBILITY_DOMAIN_TAG = "BOUNTYCAM_ELIGIBILITY_V1";
export const ELIGIBILITY_SCHEMA_VERSION = 1;
export const ELIGIBILITY_MESSAGE_LENGTH = 212;
export const MAX_ASSURANCE_LEVEL = 4;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/**
 * The state-derived and caller-supplied fields of a BOUNTYCAM_ELIGIBILITY_V1
 * message (MESSAGES.md sections 4 and 5). The domain tag, schema version and
 * layout are fixed here. The program id is a per-deployment constant the caller
 * passes, because this package carries no deployment knowledge.
 */
export interface EligibilityMessageFields {
  readonly deploymentId: number;
  readonly programId: Uint8Array;
  readonly bountyId: Uint8Array;
  readonly requester: Uint8Array;
  readonly scout: Uint8Array;
  readonly policyHash: Uint8Array;
  readonly eligibilityProfileHash: Uint8Array;
  readonly requiredAssurance: number;
  readonly expiresAt: bigint;
}

function requireBytes(value: unknown, width: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new SpecError(
      "MESSAGE_FIELD_NOT_BYTES",
      name + " must be a Uint8Array (MESSAGES.md 4)",
    );
  }
  if (value.length !== width) {
    throw new SpecError(
      "MESSAGE_FIELD_LENGTH",
      name + " must be exactly " + width + " bytes (MESSAGES.md 4)",
    );
  }
  return value;
}

function requireU8(value: unknown, max: number, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new SpecError(
      "MESSAGE_FIELD_RANGE",
      name + " must be an integer from 0 to " + max + " (MESSAGES.md 4)",
    );
  }
  return value;
}

/**
 * Build the 212-byte BOUNTYCAM_ELIGIBILITY_V1 message (MESSAGES.md section 4).
 * Little-endian throughout. Fields are checked in offset order; the first
 * failure wins (SPEC.md section 6.4). Signing is the caller's concern.
 */
export function eligibilityMessage(fields: EligibilityMessageFields): Uint8Array {
  const deploymentId = requireU8(fields.deploymentId, 255, "deploymentId");
  const programId = requireBytes(fields.programId, 32, "programId");
  const bountyId = requireBytes(fields.bountyId, 16, "bountyId");
  const requester = requireBytes(fields.requester, 32, "requester");
  const scout = requireBytes(fields.scout, 32, "scout");
  const policyHash = requireBytes(fields.policyHash, 32, "policyHash");
  const profileHash = requireBytes(
    fields.eligibilityProfileHash,
    32,
    "eligibilityProfileHash",
  );
  const requiredAssurance = requireU8(
    fields.requiredAssurance,
    MAX_ASSURANCE_LEVEL,
    "requiredAssurance",
  );
  const expiresAt = fields.expiresAt;
  if (typeof expiresAt !== "bigint" || expiresAt < I64_MIN || expiresAt > I64_MAX) {
    throw new SpecError(
      "MESSAGE_FIELD_RANGE",
      "expiresAt must be a bigint within i64 (MESSAGES.md 4)",
    );
  }

  const out = new Uint8Array(ELIGIBILITY_MESSAGE_LENGTH);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(ELIGIBILITY_DOMAIN_TAG), 0);
  view.setUint16(24, ELIGIBILITY_SCHEMA_VERSION, true);
  view.setUint8(26, deploymentId);
  out.set(programId, 27);
  out.set(bountyId, 59);
  out.set(requester, 75);
  out.set(scout, 107);
  out.set(policyHash, 139);
  out.set(profileHash, 171);
  view.setUint8(203, requiredAssurance);
  view.setBigInt64(204, expiresAt, true);
  return out;
}

// SPEC.md section 8: the funding-path helpers (Session 17, D121).
export * from "./funding.js";

// SPEC.md section 9: the acceptance-path helpers (Session 18, D127).
export * from "./acceptance.js";
