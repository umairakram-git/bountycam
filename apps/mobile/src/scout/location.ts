// DISCOVERY.md 3.1 steps 1 and 2 and section 4. The position is held in memory
// only and sent nowhere but the discovery query.

import * as Location from 'expo-location';
import { formatCoordinate } from '@hackathon/shared';

import type { Point } from './views';

export type PositionResult =
  | { readonly ok: true; readonly point: Point; readonly lat: string; readonly lon: string }
  | { readonly ok: false; readonly kind: 'DENIED' | 'NO_FIX'; readonly detail?: string };

const FIX_TIMEOUT_MS = 15_000;

export async function currentPosition(): Promise<PositionResult> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') return { ok: false, kind: 'DENIED' };
  try {
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('no fix within 15 seconds')), FIX_TIMEOUT_MS),
      ),
    ]);
    const { latitude, longitude } = fix.coords;
    return {
      ok: true,
      point: { lat: latitude, lon: longitude },
      lat: formatCoordinate(latitude, 'lat'),
      lon: formatCoordinate(longitude, 'lon'),
    };
  } catch (error: unknown) {
    return { ok: false, kind: 'NO_FIX', detail: String(error) };
  }
}

/** Section 4: great-circle distance to the snapped centre, whole km, at least 1. */
export function aboutKm(from: Point | undefined, to: Point | undefined): string | undefined {
  if (from === undefined || to === undefined) return undefined;
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  return 'About ' + String(Math.max(1, Math.round(km))) + ' km away';
}
