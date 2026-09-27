// Authenticated JSON calls to the BountyCam API (POLICY.md 8.1: every endpoint
// takes a bearer token). One module, so the token is handled in one place and
// never logged. The report endpoint takes no body (POLICY.md 15.4 step 2), so
// POST without a body sends none.

import { API_BASE_URL } from '../config';

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The server's error code, when the body carries one in the `{ error }` shape. */
export function errorCodeOf(body: unknown): string | undefined {
  const code = readProperty(body, 'error');
  return typeof code === 'string' ? code : undefined;
}

async function call(token: string, method: 'GET' | 'POST', path: string, body?: string) {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API_BASE_URL + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw };
}

export function apiGet(token: string, path: string): Promise<ApiResult> {
  return call(token, 'GET', path);
}

export function apiPost(token: string, path: string, body: unknown): Promise<ApiResult> {
  return call(token, 'POST', path, JSON.stringify(body));
}

/** POST with no body at all, for POLICY.md 15.4. */
export function apiPostEmpty(token: string, path: string): Promise<ApiResult> {
  return call(token, 'POST', path);
}
