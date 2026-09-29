/**
 * Location helpers, implemented to SPEC.md section 10 (Session 19, P3, D133).
 * SPEC.md is normative; where this file and the spec disagree, the spec wins
 * and this file is buggy.
 *
 * The phone and the API run the same start gate from here, so they cannot
 * disagree. P4 and P5 reuse distanceM only; the gate's thresholds are not
 * theirs (apps/api POLICY.md section 17.9).
 *
 * This module imports from ./index.js, which re-exports it: the same cycle as
 * funding.ts and acceptance.ts, safe for the same reason. Every call into
 * index.ts happens inside a function at call time.
 */

import { SpecError, isValidLat, isValidLon } from "./index.js";

// Every rejection passes through this one function so that the check set can
// be removed as a whole to show the negative tests red (HANDOFF Working rules).
function check(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new SpecError(code, message);
}

/** SPEC.md 10.1: the sphere's radius in metres. */
export const EARTH_RADIUS_M = 6371008.8;

export type CaptureStartDecision = "PASS" | "IMPRECISE" | "TOO_FAR";

export interface CaptureStartResult {
  readonly decision: CaptureStartDecision;
  readonly distanceM: number;
  readonly effectiveDistanceM: number;
}

function isLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

// ---------------------------------------------------------------------------
// SPEC.md 10.1 — distanceM
// ---------------------------------------------------------------------------

/** Haversine distance in metres; the order of operations is SPEC.md 10.1's. */
export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  check(
    isLatitude(aLat) && isLongitude(aLon) && isLatitude(bLat) && isLongitude(bLon),
    "LOCATION_INPUT_INVALID",
    "coordinates must be finite degrees within range",
  );
  const rad = Math.PI / 180;
  const p1 = aLat * rad;
  const p2 = bLat * rad;
  const dp = (bLat - aLat) * rad;
  const dl = (bLon - aLon) * rad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(x)));
}

// ---------------------------------------------------------------------------
// SPEC.md 10.2 — captureStartDecision
// ---------------------------------------------------------------------------

export function captureStartDecision(
  distance: number,
  accuracyM: number,
  radiusM: number,
  maxAccuracyM: number,
): CaptureStartDecision {
  check(
    Number.isFinite(distance) && distance >= 0 &&
      Number.isFinite(accuracyM) && accuracyM >= 0 &&
      Number.isFinite(radiusM) && radiusM > 0 &&
      Number.isFinite(maxAccuracyM) && maxAccuracyM > 0,
    "LOCATION_INPUT_INVALID",
    "distance and accuracy must be finite and non-negative; radius and ceiling positive",
  );
  if (accuracyM > maxAccuracyM) return "IMPRECISE";
  const effective = Math.max(0, distance - accuracyM);
  return effective <= radiusM ? "PASS" : "TOO_FAR";
}

// ---------------------------------------------------------------------------
// SPEC.md 10.3 — checkCaptureStart
// ---------------------------------------------------------------------------

export function checkCaptureStart(
  fix: { readonly lat: number; readonly lon: number; readonly accuracyM: number },
  target: { readonly lat: string; readonly lon: string },
  radiusM: number,
  maxAccuracyM: number,
): CaptureStartResult {
  check(
    typeof target.lat === "string" && isValidLat(target.lat) &&
      typeof target.lon === "string" && isValidLon(target.lon),
    "LOCATION_INPUT_INVALID",
    "target coordinates must pass the GPS profile",
  );
  const distance = distanceM(fix.lat, fix.lon, Number(target.lat), Number(target.lon));
  const decision = captureStartDecision(distance, fix.accuracyM, radiusM, maxAccuracyM);
  return {
    decision,
    distanceM: distance,
    effectiveDistanceM: Math.max(0, distance - fix.accuracyM),
  };
}
