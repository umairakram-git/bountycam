// CAPTURE.md sections 2 to 4: reading the server's capture object, taking the
// start fix, and the request body. The limits all come from the server; this
// module holds no copy of any of them. The fix is held in memory only and is
// sent nowhere but the capture-nonce request.

import * as Location from 'expo-location';
import { formatCoordinate } from '@hackathon/shared';

export interface CaptureNonce {
  readonly id: string;
  readonly value: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CaptureState {
  readonly serverTime: number;
  readonly startClosesAt: number;
  readonly maxAccuracyM: number;
  readonly fixTimeoutS: number;
  readonly maxAgeS: number;
  readonly nonce: CaptureNonce | null;
}

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function time(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : NaN;
}

/** POLICY.md 17.7's `capture` object; undefined when any field is malformed. */
export function readCapture(value: unknown): CaptureState | undefined {
  const rawNonce = get(value, 'capture_nonce');
  let nonce: CaptureNonce | null = null;
  if (rawNonce !== null) {
    const id = get(rawNonce, 'id');
    const hex = get(rawNonce, 'value');
    const issuedAt = time(get(rawNonce, 'issued_at'));
    const expiresAt = time(get(rawNonce, 'expires_at'));
    if (typeof id !== 'string' || typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
      return undefined;
    }
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return undefined;
    nonce = { id, value: hex, issuedAt, expiresAt };
  }
  const state: CaptureState = {
    serverTime: time(get(value, 'server_time')),
    startClosesAt: time(get(value, 'start_closes_at')),
    maxAccuracyM: positive(get(value, 'max_location_accuracy_m')),
    fixTimeoutS: positive(get(value, 'location_fix_timeout_s')),
    maxAgeS: positive(get(value, 'max_location_age_s')),
    nonce,
  };
  const numbers = [state.serverTime, state.startClosesAt, state.maxAccuracyM, state.fixTimeoutS,
    state.maxAgeS];
  return numbers.every(Number.isFinite) ? state : undefined;
}

export interface StartFix {
  readonly lat: number;
  readonly lon: number;
  readonly accuracyM: number;
  readonly timestamp: number;
}

export type FixResult =
  | { readonly ok: true; readonly fix: StartFix; readonly ageS: number }
  | { readonly ok: false; readonly kind: 'DENIED' | 'SERVICES_OFF' }
  | {
      readonly ok: false;
      readonly kind: 'NO_FIX';
      readonly accuracyM?: number;
      readonly ageS?: number;
    };

/** CAPTURE.md section 3 steps 1 to 3. The age is judged against the phone's own clock. */
export async function takeStartFix(fixTimeoutS: number, maxAgeS: number): Promise<FixResult> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') return { ok: false, kind: 'DENIED' };
  if (!(await Location.hasServicesEnabledAsync())) return { ok: false, kind: 'SERVICES_OFF' };
  let position: Location.LocationObject;
  try {
    position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no fix in time')), fixTimeoutS * 1000),
      ),
    ]);
  } catch {
    return { ok: false, kind: 'NO_FIX' };
  }
  const ageS = (Date.now() - position.timestamp) / 1000;
  const accuracy = position.coords.accuracy;
  if (accuracy === null || !Number.isFinite(accuracy) || accuracy < 0) {
    return { ok: false, kind: 'NO_FIX', ageS };
  }
  if (ageS > maxAgeS) return { ok: false, kind: 'NO_FIX', accuracyM: accuracy, ageS };
  return {
    ok: true,
    ageS,
    fix: {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracyM: accuracy,
      timestamp: position.timestamp,
    },
  };
}

/** CAPTURE.md section 3 step 6: the request body. */
export function startBody(fix: StartFix): Record<string, unknown> {
  return {
    lat: formatCoordinate(fix.lat, 'lat'),
    lon: formatCoordinate(fix.lon, 'lon'),
    horizontal_accuracy_m: fix.accuracyM,
    fixed_at: new Date(fix.timestamp).toISOString(),
  };
}

/** Section 3's small line: the numbers the phone judged, whichever it has. */
export function judgedLine(accuracyM?: number, distanceM?: number, ageS?: number): string {
  const parts: string[] = [];
  if (accuracyM !== undefined) parts.push('Accuracy about ' + String(Math.round(accuracyM)) + ' m');
  if (distanceM !== undefined) parts.push(String(Math.round(distanceM)) + ' m from the spot');
  if (ageS !== undefined) parts.push('fix ' + String(Math.max(0, Math.round(ageS))) + ' s old');
  return parts.join(' · ');
}

/** mm:ss for the countdown; never negative. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes) + ':' + String(seconds).padStart(2, '0');
}
