// The SIWS sign-in flow (AUTH.md section 2), device side.
//
// Nothing here knows what wallet is behind the WalletProvider.

import { Buffer } from 'buffer';

import { API_BASE_URL } from '../config';
import type { SiwsInput, WalletProvider } from '../wallet/types';

export interface SiwsUser {
  readonly id: string;
  readonly wallet_address: string;
  readonly status: string;
}

/** Where a run stopped. */
export type SignInStage = 'AUTHORIZE' | 'CHALLENGE' | 'WALLET_SIGN_IN' | 'VERIFY';

export interface SignInSuccess {
  readonly ok: true;
  readonly status: number;
  /** A bearer credential. The caller must not log it. */
  readonly token: string;
  readonly user: SiwsUser;
}

export interface SignInFailure {
  readonly ok: false;
  readonly stage: SignInStage;
  /** The HTTP status, when the stage reached the server. */
  readonly status: number | undefined;
  /** The server's error code from `{ "error": "<CODE>" }` (AUTH.md 7). */
  readonly errorCode: string | undefined;
  readonly message: string;
}

export type SignInOutcome = SignInSuccess | SignInFailure;

/** Appends one line to the on-screen log. */
export type LogLine = (line: string) => void;

const SIWS_INPUT_FIELDS = [
  'domain',
  'address',
  'statement',
  'version',
  'chainId',
  'nonce',
  'issuedAt',
  'expirationTime',
] as const;

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return record[key];
}

/**
 * Confirms the eight fields AUTH.md 5.1 names are present and are strings.
 *
 * This is a type predicate on purpose. It narrows the value in place instead of
 * returning a new one, so the caller keeps the exact object `JSON.parse`
 * produced — with any further field the server sends still attached. A
 * validator that built and returned `{ domain, address, ... }` would type-check
 * identically and would silently drop that field before it ever reached the
 * wallet.
 */
function isSiwsInput(value: unknown): value is SiwsInput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return SIWS_INPUT_FIELDS.every((field) => typeof record[field] === 'string');
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

/** The server's error code, when the body carries one in the AUTH.md 7 shape. */
function errorCodeOf(body: unknown): string | undefined {
  const code = readProperty(body, 'error');
  return typeof code === 'string' ? code : undefined;
}

function failure(
  stage: SignInStage,
  status: number | undefined,
  errorCode: string | undefined,
  message: string,
): SignInFailure {
  return { ok: false, stage, status, errorCode, message };
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function postJson(path: string, body: string): Promise<HttpResult> {
  const response = await fetch(API_BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A non-JSON body is itself the finding; `raw` carries it to the log.
    parsed = undefined;
  }
  return { status: response.status, body: parsed, raw };
}

export async function runSiwsSignIn(
  provider: WalletProvider,
  log: LogLine,
): Promise<SignInOutcome> {
  // 1. Authorize, to learn the address the challenge is issued against.
  const authorized = await provider.authorize();
  if (!authorized.ok) {
    log('wallet authorize failed [' + authorized.kind + ']: ' + authorized.message);
    if (authorized.detail !== undefined) log('  wallet returned: ' + authorized.detail);
    return failure('AUTHORIZE', undefined, undefined, authorized.message);
  }
  log('address (base64, as the wallet returned it): ' + authorized.addressBase64);
  log('address (base58, decoded, 32 bytes): ' + authorized.addressBase58);

  // 2. Challenge.
  //
  // The body carries the base58 address only. No `chain` field: AUTH.md 5.1
  // makes it optional and defaults it to devnet, and the one chain value this
  // app holds is MWA_CHAIN ('solana:devnet'), which is the MWA cluster
  // selector and not the SIWS chain form. Sending it here would unify two
  // values that must stay separate. The canonical `chainId` comes back from
  // the server inside `input`.
  let challenge: HttpResult;
  try {
    challenge = await postJson(
      '/auth/siws/challenge',
      JSON.stringify({ address: authorized.addressBase58 }),
    );
  } catch (error: unknown) {
    const message = 'challenge request failed: ' + describeThrown(error);
    log(message);
    return failure('CHALLENGE', undefined, undefined, message);
  }

  if (challenge.status !== 200) {
    const code = errorCodeOf(challenge.body);
    log('challenge HTTP ' + String(challenge.status) + ' error=' + String(code));
    return failure(
      'CHALLENGE',
      challenge.status,
      code,
      'challenge returned HTTP ' + String(challenge.status),
    );
  }

  // Parsed once, above. `input` below is that parse's own object, and it is the
  // value handed to the wallet — see isSiwsInput.
  const input = readProperty(challenge.body, 'input');
  if (!isSiwsInput(input)) {
    const message = 'challenge input is missing a required field or it is not a string';
    log(message + '; body was: ' + challenge.raw);
    return failure('CHALLENGE', challenge.status, undefined, message);
  }
  log('challenge input the server issued: ' + JSON.stringify(input, null, 2));

  // 3. Wallet sign-in, with that same object.
  const signed = await provider.signIn(input);
  if (!signed.ok) {
    log('wallet sign-in failed [' + signed.kind + ']: ' + signed.message);
    if (signed.detail !== undefined) log('  wallet returned: ' + signed.detail);
    return failure('WALLET_SIGN_IN', undefined, undefined, signed.message);
  }
  log('sign_in_result: present');
  log('signed_message (base64): ' + signed.signedMessageBase64);
  log(
    'signed_message (utf-8):\n' +
      Buffer.from(signed.signedMessageBase64, 'base64').toString('utf8'),
  );
  log('signature (base64): ' + signed.signatureBase64);
  log('signature_type: ' + (signed.signatureType ?? '<absent>'));
  log('sign_in_result address (base64): ' + signed.addressBase64);

  // 4. Verify. Exactly the three fields AUTH.md 5.2 names, carrying the
  // wallet's base64 strings as they arrived: no re-encode, no trim, no
  // normalisation. There is no address field; the server takes the address
  // from the parsed message.
  const verifyBody: {
    signed_message: string;
    signature: string;
    signature_type?: string;
  } = {
    signed_message: signed.signedMessageBase64,
    signature: signed.signatureBase64,
  };
  if (signed.signatureType !== undefined) {
    verifyBody.signature_type = signed.signatureType;
  }

  let verify: HttpResult;
  try {
    verify = await postJson('/auth/siws/verify', JSON.stringify(verifyBody));
  } catch (error: unknown) {
    const message = 'verify request failed: ' + describeThrown(error);
    log(message);
    return failure('VERIFY', undefined, undefined, message);
  }

  if (verify.status !== 200) {
    const code = errorCodeOf(verify.body);
    log('verify HTTP ' + String(verify.status) + ' error=' + String(code));
    if (code === undefined) log('  body was: ' + verify.raw);
    return failure(
      'VERIFY',
      verify.status,
      code,
      'verify returned HTTP ' + String(verify.status),
    );
  }

  const token = readProperty(verify.body, 'token');
  const user = readProperty(verify.body, 'user');
  const id = readProperty(user, 'id');
  const walletAddress = readProperty(user, 'wallet_address');
  const status = readProperty(user, 'status');
  if (
    typeof token !== 'string' ||
    typeof id !== 'string' ||
    typeof walletAddress !== 'string' ||
    typeof status !== 'string'
  ) {
    const message = 'verify returned 200 with an unexpected body shape';
    // `verify.raw` holds the token on this path, so it is not logged.
    log(message);
    return failure('VERIFY', verify.status, undefined, message);
  }

  log('verify HTTP 200 — success');
  return {
    ok: true,
    status: verify.status,
    token,
    user: { id, wallet_address: walletAddress, status },
  };
}
