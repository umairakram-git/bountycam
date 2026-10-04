// CAPTURE.md section 7 (P4): everything the checklist does that is not drawing. Readers for
// the assigned-Scout view, the shutter's record, hashing, one upload attempt, the manifest
// and the signed submission. The server is the authority on every limit; this module holds
// no copy of any (POLICY.md 18.3).
import { File, UploadType } from 'expo-file-system';
import {
  evidenceRoot,
  evidenceStatement,
  formatCoordinate,
  manifestAccuracy,
  sha256Chunked,
  type EvidenceItem,
  type EvidenceManifest,
} from '@hackathon/shared';

import { apiPost, errorCodeOf } from '../api/client';
import { DEPLOYMENT_ID } from '../config';
import type { WalletProvider } from '../wallet/types';

export interface Requirement {
  readonly id: string;
  readonly prompt: string;
  readonly required: boolean;
}

/** POLICY.md 19.11: the verifier's outcome, as the view reports it. */
export type Verification = 'CHECKING' | 'VERIFIED' | 'NOT_VERIFIED';

export interface SubmissionSummary {
  readonly submittedAt: number;
  readonly itemCount: number;
  readonly verification: Verification;
}

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The policy's requirements, in mission order (POLICY.md 2.2). */
export function readRequirements(view: unknown): Requirement[] {
  const list = get(get(view, 'policy'), 'evidence_requirements');
  if (!Array.isArray(list)) return [];
  return list.map((r) => ({
    id: String(get(r, 'id')),
    prompt: String(get(r, 'prompt')),
    required: get(r, 'required') === true,
  }));
}

/** The view's `submission` (POLICY.md 18.7, 19.11): null before, a summary after. */
export function readSubmission(view: unknown): SubmissionSummary | null {
  const raw = get(view, 'submission');
  if (raw === null || raw === undefined) return null;
  const at = Date.parse(String(get(raw, 'submitted_at')));
  const count = get(raw, 'item_count');
  const v = get(raw, 'verification');
  return {
    submittedAt: at,
    itemCount: typeof count === 'number' ? count : 0,
    verification: v === 'VERIFIED' || v === 'NOT_VERIFIED' ? v : 'CHECKING',
  };
}

export interface HeaderParts {
  readonly bountyId: string;
  readonly assignmentId: string;
  readonly policyHash: string;
  readonly scout: string;
}

export function readHeaderParts(view: unknown, scout: string): HeaderParts {
  return {
    bountyId: String(get(view, 'id')),
    assignmentId: String(get(get(view, 'assignment'), 'id')),
    policyHash: String(get(view, 'policy_hash')),
    scout,
  };
}

/** A location fix as expo-location reports it. */
export interface Fix {
  readonly lat: number;
  readonly lon: number;
  readonly accuracyM: number | null;
  readonly timestamp: number;
}

/** CAPTURE.md 7.3 step 5: the item fields known at the shutter. */
export function shutterRecord(
  requirementId: string,
  capturedAtServerMs: number,
  fix: Fix & { readonly accuracyM: number },
): Omit<EvidenceItem, 'byte_length' | 'photo_sha256'> {
  return {
    captured_at: new Date(capturedAtServerMs).toISOString(),
    fixed_at: new Date(fix.timestamp).toISOString(),
    horizontal_accuracy_m: manifestAccuracy(fix.accuracyM),
    lat: formatCoordinate(fix.lat, 'lat'),
    lon: formatCoordinate(fix.lon, 'lon'),
    requirement_id: requirementId,
  };
}

/** CAPTURE.md 7.3 steps 6 and 7: the file's bytes, hashed in chunks so the screen lives. */
export async function hashPhoto(uri: string): Promise<{
  byteLength: number;
  sha256Hex: string;
  hashMs: number;
}> {
  const bytes = await new File(uri).bytes();
  const started = Date.now();
  const digest = await sha256Chunked(bytes, 65536, () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return { byteLength: bytes.length, sha256Hex: hex, hashMs: Date.now() - started };
}

export function deletePhoto(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A file already gone is the goal.
  }
}

export type UploadOutcome = 'UPLOADED' | 'RETRY' | 'TOO_LARGE' | 'RELOAD';

/** CAPTURE.md 7.4 steps 1 to 3, once. The caller schedules retries. */
export async function uploadOnce(
  token: string,
  bountyId: string,
  sessionId: string,
  item: { requirementId: string; sha256Hex: string; byteLength: number },
  uri: string,
): Promise<UploadOutcome> {
  let asked;
  try {
    asked = await apiPost(token, '/bounties/' + bountyId + '/evidence/upload-url', {
      capture_session_id: sessionId,
      requirement_id: item.requirementId,
      photo_sha256: item.sha256Hex,
      byte_length: item.byteLength,
    });
  } catch {
    return 'RETRY';
  }
  const code = errorCodeOf(asked.body);
  if (code === 'EVIDENCE_TOO_LARGE') return 'TOO_LARGE';
  if (code === 'CAPTURE_SESSION_NOT_LIVE' || code === 'ALREADY_SUBMITTED') return 'RELOAD';
  if (asked.status !== 200) return 'RETRY';
  const upload = get(asked.body, 'upload');
  const url = get(upload, 'url');
  const headers = get(upload, 'headers');
  if (typeof url !== 'string' || typeof headers !== 'object' || headers === null) return 'RETRY';
  try {
    const put = await new File(uri).upload(url, {
      httpMethod: 'PUT',
      uploadType: UploadType.BINARY_CONTENT,
      headers: headers as Record<string, string>,
    });
    return put.status === 200 ? 'UPLOADED' : 'RETRY';
  } catch {
    return 'RETRY';
  }
}

/** CAPTURE.md 7.4: 2, 4, 8, 16 seconds, then every 30. */
export function retryDelayMs(attempt: number): number {
  return attempt < 4 ? 2000 * 2 ** attempt : 30000;
}

/** CAPTURE.md 7.5 step 2. Items arrive in policy order. */
export function buildManifest(
  parts: HeaderParts,
  nonceHex: string,
  items: readonly EvidenceItem[],
): EvidenceManifest {
  return {
    header: {
      assignment_id: parts.assignmentId,
      bounty_id: parts.bountyId,
      capture_nonce: nonceHex,
      deployment_id: DEPLOYMENT_ID,
      manifest_version: 1,
      policy_hash: parts.policyHash,
      scout: parts.scout,
    },
    items: [...items],
  };
}

export type SubmitOutcome =
  | { readonly kind: 'SUBMITTED' }
  | { readonly kind: 'NOT_SIGNED'; readonly detail: string }
  | { readonly kind: 'NOT_UPLOADED' }
  | { readonly kind: 'EXPIRED' }
  | { readonly kind: 'RELOAD' }
  | { readonly kind: 'REFUSED'; readonly code: string }
  | { readonly kind: 'UNREACHABLE' };

const RELOAD_CODES = new Set([
  'CAPTURE_SESSION_SUPERSEDED',
  'CAPTURE_SESSION_USED',
  'CAPTURE_NONCE_INVALID',
  'ALREADY_SUBMITTED',
  'BOUNTY_NOT_CAPTURABLE',
  'NOT_ASSIGNED',
  'NOT_FOUND',
]);

const REFUSED_CODES = new Set([
  'LOCATION_TOO_IMPRECISE',
  'LOCATION_TOO_FAR',
  'CAPTURED_OUTSIDE_SESSION',
  'REQUIREMENTS_INCOMPLETE',
  'UNKNOWN_REQUIREMENT',
  'MANIFEST_MISMATCH',
  'INVALID_MANIFEST',
  'SUBMISSION_SIGNATURE_INVALID',
  'EVIDENCE_TOO_LARGE',
]);

/**
 * CAPTURE.md 7.5 steps 2 to 4. `signed` holds the last signature by root, so a resend of an
 * unchanged manifest reuses it and the wallet opens only once.
 */
export async function submitEvidence(
  provider: WalletProvider,
  token: string,
  manifest: EvidenceManifest,
  signed: Map<string, string>,
): Promise<SubmitOutcome> {
  const root = evidenceRoot(manifest);
  let rootHex = '';
  for (const b of root) rootHex += b.toString(16).padStart(2, '0');
  let signature = signed.get(rootHex);
  if (signature === undefined) {
    const result = await provider.signMessage(evidenceStatement(manifest.header.bounty_id, root));
    if (!result.ok) return { kind: 'NOT_SIGNED', detail: result.kind + ': ' + result.message };
    signature = '';
    for (const b of result.signature) signature += b.toString(16).padStart(2, '0');
    signed.set(rootHex, signature);
  }
  let sent;
  try {
    sent = await apiPost(token, '/bounties/' + manifest.header.bounty_id + '/submission', {
      manifest,
      signature,
    });
  } catch {
    return { kind: 'UNREACHABLE' };
  }
  if (sent.status === 201 || sent.status === 200) return { kind: 'SUBMITTED' };
  const code = errorCodeOf(sent.body);
  if (code === 'EVIDENCE_NOT_UPLOADED') return { kind: 'NOT_UPLOADED' };
  if (code === 'CAPTURE_SESSION_EXPIRED') return { kind: 'EXPIRED' };
  if (code !== undefined && RELOAD_CODES.has(code)) return { kind: 'RELOAD' };
  if (code !== undefined && REFUSED_CODES.has(code)) return { kind: 'REFUSED', code };
  return { kind: 'UNREACHABLE' };
}
