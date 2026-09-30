// Narrow readers for the API's JSON (POLICY.md 8.2 and 16.4). The server is
// trusted for display only; every value that reaches a transaction or the
// exact location passes a packages/shared check first (DISCOVERY.md 3.3, 3.4).

import { formatUsdc } from '../create/createBounty';

export interface Point {
  readonly lat: number;
  readonly lon: number;
}

export interface BountySummary {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly rewardAmount: string;
  readonly area: Point | undefined;
}

export interface PublicBounty extends BountySummary {
  readonly programAccount: string | undefined;
  readonly policyHash: string;
  readonly eligibilityProfileId: string;
  readonly requiredAssurance: number;
  readonly completionWindowSeconds: number;
  readonly prompts: readonly string[];
}

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : NaN;
}

function area(value: unknown): Point | undefined {
  const lat = Number(str(get(value, 'lat')));
  const lon = Number(str(get(value, 'lon')));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
}

export function rewardText(baseUnits: string): string {
  return /^[0-9]+$/.test(baseUnits) ? formatUsdc(BigInt(baseUnits)) + ' USDC' : baseUnits;
}

/** GET /bounties and GET /me/missions list items. */
export function asSummaries(body: unknown, key: 'bounties' | 'missions'): BountySummary[] {
  const list = get(body, key);
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    id: str(get(item, 'id')),
    title: str(get(item, 'title')),
    category: str(get(item, 'category')),
    rewardAmount: str(get(item, 'reward_amount')),
    area: area(get(item, 'location_public')),
  }));
}

/** GET /bounties/:id, public view. Undefined when the shape is not a public view. */
export function asPublicBounty(body: unknown): PublicBounty | undefined {
  const policy = get(body, 'policy_public');
  const id = str(get(body, 'id'));
  if (id === '' || typeof policy !== 'object' || policy === null) return undefined;
  const requirements = get(policy, 'evidence_requirements');
  const program = get(body, 'program_account');
  return {
    id,
    title: str(get(body, 'title')),
    category: str(get(body, 'category')),
    rewardAmount: str(get(policy, 'reward_amount')),
    area: area(get(body, 'location_public')),
    programAccount: typeof program === 'string' ? program : undefined,
    policyHash: str(get(body, 'policy_hash')),
    eligibilityProfileId: str(get(policy, 'eligibility_profile_id')),
    requiredAssurance: num(get(policy, 'required_assurance')),
    completionWindowSeconds: num(get(policy, 'completion_window_seconds')),
    prompts: Array.isArray(requirements)
      ? requirements.map((r) => str(get(r, 'prompt')))
      : [],
  };
}

/** The assigned-Scout view's display fields, read after verifyAssignedPolicy passed. */
export function missionDetails(body: unknown): {
  id: string;
  title: string;
  rewardAmount: string;
  deadline: string;
  captureRadiusM: number;
  prompts: string[];
} {
  const policy = get(body, 'policy');
  const requirements = get(policy, 'evidence_requirements');
  return {
    id: str(get(body, 'id')),
    captureRadiusM: num(get(policy, 'capture_radius_m')),
    title: str(get(body, 'title')),
    rewardAmount: str(get(policy, 'reward_amount')),
    deadline: str(get(get(body, 'assignment'), 'deadline')),
    prompts: Array.isArray(requirements)
      ? requirements.map((r) => str(get(r, 'prompt')))
      : [],
  };
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
