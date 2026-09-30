/**
 * The evidence manifest, implemented to SPEC.md section 11 (Session 20, P4, D141, D144).
 * SPEC.md is normative; where this file and the spec disagree, the spec wins and this file
 * is buggy.
 *
 * The phone builds a manifest and hashes its photos with these functions, the API checks a
 * submission with them, and P5 recomputes the root with them. An independent Python
 * implementation, vectors/gen_evidence_vectors.py, produced vectors V6 and V7.
 *
 * This module imports from ./index.js, which re-exports it: the same cycle as funding.ts,
 * acceptance.ts and location.ts, safe for the same reason. Every call into index.ts happens
 * inside a function at call time.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import {
  SpecError,
  canonicalise,
  sha256,
  merkleRoot,
  isValidLat,
  isValidLon,
} from "./index.js";

// Every rejection passes through this one function (HANDOFF Working rules).
function check(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new SpecError(code, message);
}

/** SPEC.md 11.6. */
export const EVIDENCE_DOMAIN_TAG = "BOUNTYCAM_EVIDENCE_V1";
export const EVIDENCE_SCHEMA_VERSION = 1;
/** SPEC.md 11.2. */
export const MANIFEST_VERSION = 1;
/** SPEC.md 11.1. */
export const MAX_EVIDENCE_ITEMS = 20;
/** SPEC.md 11.3: the largest `horizontal_accuracy_m`. */
export const MAX_MANIFEST_ACCURACY_M = 100000;

export interface EvidenceHeader {
  readonly assignment_id: string;
  readonly bounty_id: string;
  readonly capture_nonce: string;
  readonly deployment_id: number;
  readonly manifest_version: number;
  readonly policy_hash: string;
  readonly scout: string;
}

export interface EvidenceItem {
  readonly byte_length: number;
  readonly captured_at: string;
  readonly fixed_at: string;
  readonly horizontal_accuracy_m: number;
  readonly lat: string;
  readonly lon: string;
  readonly photo_sha256: string;
  readonly requirement_id: string;
}

export interface EvidenceManifest {
  readonly header: EvidenceHeader;
  readonly items: readonly EvidenceItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const HEADER_KEYS: Record<string, "string" | "number"> = {
  assignment_id: "string",
  bounty_id: "string",
  capture_nonce: "string",
  deployment_id: "number",
  manifest_version: "number",
  policy_hash: "string",
  scout: "string",
};

const ITEM_KEYS: Record<string, "string" | "number"> = {
  byte_length: "number",
  captured_at: "string",
  fixed_at: "string",
  horizontal_accuracy_m: "number",
  lat: "string",
  lon: "string",
  photo_sha256: "string",
  requirement_id: "string",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((k, i) => k === want[i]);
}

function shapeOf(value: unknown, table: Record<string, "string" | "number">, what: string): void {
  check(isPlainObject(value), "MANIFEST_SHAPE", what + " is not an object (SPEC.md 11)");
  check(sameKeys(value, Object.keys(table)), "MANIFEST_SHAPE", what + " has the wrong keys");
  for (const [key, type] of Object.entries(table)) {
    check(typeof value[key] === type, "MANIFEST_SHAPE", what + "." + key + " is not a " + type);
  }
}

function isTime(value: string): boolean {
  if (!UTC_MILLIS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function intIn(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function field(condition: boolean, what: string): void {
  check(condition, "MANIFEST_FIELD", what + " fails its SPEC.md 11.2 or 11.3 rule");
}

/** SPEC.md 11.1 to 11.4. Returns the value, typed. */
export function checkEvidenceManifest(value: unknown): EvidenceManifest {
  // Shape: every key set and JSON type.
  check(isPlainObject(value), "MANIFEST_SHAPE", "the manifest is not an object (SPEC.md 11.1)");
  check(sameKeys(value, ["header", "items"]), "MANIFEST_SHAPE", "the manifest has the wrong keys");
  shapeOf(value["header"], HEADER_KEYS, "header");
  const items = value["items"];
  check(Array.isArray(items), "MANIFEST_SHAPE", "items is not an array");
  items.forEach((item, i) => shapeOf(item, ITEM_KEYS, "items[" + String(i) + "]"));
  const header = value["header"] as unknown as EvidenceHeader;
  const typed = items as unknown as EvidenceItem[];

  // Items: count and uniqueness.
  check(typed.length >= 1 && typed.length <= MAX_EVIDENCE_ITEMS, "MANIFEST_ITEMS",
    "items must number 1 to 20 (SPEC.md 11.1)");
  const seen = new Set(typed.map((item) => item.requirement_id));
  check(seen.size === typed.length, "MANIFEST_ITEMS", "two items name one requirement");

  // Fields.
  field(UUID.test(header.assignment_id), "header.assignment_id");
  field(UUID.test(header.bounty_id), "header.bounty_id");
  field(HEX64.test(header.capture_nonce), "header.capture_nonce");
  field(intIn(header.deployment_id, 0, 255), "header.deployment_id");
  field(header.manifest_version === MANIFEST_VERSION, "header.manifest_version");
  field(HEX64.test(header.policy_hash), "header.policy_hash");
  field(BASE58_KEY.test(header.scout), "header.scout");
  typed.forEach((item, i) => {
    const at = "items[" + String(i) + "].";
    field(intIn(item.byte_length, 1, Number.MAX_SAFE_INTEGER), at + "byte_length");
    field(isTime(item.captured_at), at + "captured_at");
    field(isTime(item.fixed_at), at + "fixed_at");
    field(intIn(item.horizontal_accuracy_m, 0, MAX_MANIFEST_ACCURACY_M),
      at + "horizontal_accuracy_m");
    field(isValidLat(item.lat), at + "lat");
    field(isValidLon(item.lon), at + "lon");
    field(HEX64.test(item.photo_sha256), at + "photo_sha256");
    field(UUID.test(item.requirement_id), at + "requirement_id");
  });
  return { header, items: typed };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** SPEC.md 11.5: the header's digest, then each item's, in order. */
export function evidenceLeaves(manifest: unknown): Uint8Array[] {
  const checked = checkEvidenceManifest(manifest);
  const header = sha256(utf8(canonicalise(checked.header)));
  const items = checked.items.map((item) => sha256(utf8(canonicalise(item))));
  return [header, ...items];
}

/** SPEC.md 11.5: the evidence root, `merkleRoot` of the leaves. */
export function evidenceRoot(manifest: unknown): Uint8Array {
  return merkleRoot(evidenceLeaves(manifest));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** SPEC.md 11.6: the UTF-8 bytes the Scout's wallet signs. */
export function evidenceStatement(bountyId: string, root: Uint8Array): Uint8Array {
  check(typeof bountyId === "string" && UUID.test(bountyId), "STATEMENT_INPUT_INVALID",
    "bountyId is not a lowercase uuid (SPEC.md 11.7)");
  check(root instanceof Uint8Array && root.length === 32, "STATEMENT_INPUT_INVALID",
    "root is not a 32-byte Uint8Array (SPEC.md 11.7)");
  return utf8(canonicalise({
    bounty_id: bountyId,
    domain_tag: EVIDENCE_DOMAIN_TAG,
    evidence_root: toHex(root),
    schema_version: EVIDENCE_SCHEMA_VERSION,
  }));
}

/** SPEC.md 11.3 and 11.7: whole metres, rounded up. */
export function manifestAccuracy(accuracyM: number): number {
  check(typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM >= 0 &&
    accuracyM <= MAX_MANIFEST_ACCURACY_M, "ACCURACY_INVALID",
    "accuracy must be finite, 0 to 100000 (SPEC.md 11.7)");
  return Math.ceil(accuracyM);
}

/**
 * SPEC.md 11.7: `sha256(bytes)`, fed in chunks with `pause()` awaited between consecutive
 * chunks, so a phone's screen stays live while a photo hashes (D144).
 */
export async function sha256Chunked(
  bytes: Uint8Array,
  chunkBytes: number,
  pause: () => Promise<void>,
): Promise<Uint8Array> {
  check(bytes instanceof Uint8Array, "NOT_BYTES", "input must be a Uint8Array (SPEC.md 2)");
  check(Number.isSafeInteger(chunkBytes) && chunkBytes > 0, "CHUNK_INVALID",
    "chunkBytes must be a positive safe integer (SPEC.md 11.7)");
  const hash = nobleSha256.create();
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    if (offset > 0) await pause();
    hash.update(bytes.subarray(offset, offset + chunkBytes));
  }
  return hash.digest();
}
