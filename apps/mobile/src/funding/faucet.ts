// D167: the devnet faucet. One call, POST /faucet with the session token; the server sends
// devnet SOL for fees and test USDC for funding to the signed-in wallet. Each answer maps
// to one sentence for the user.

import { apiPostEmpty, errorCodeOf } from '../api/client';

export interface FaucetResult {
  readonly ok: boolean;
  readonly message: string;
  readonly signature?: string;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(body: unknown, key: string): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

export async function requestTestFunds(token: string): Promise<FaucetResult> {
  let result;
  try {
    result = await apiPostEmpty(token, '/faucet');
  } catch {
    return { ok: false, message: "Couldn't reach BountyCam. Try again." };
  }
  const usdc = readString(result.body, 'usdc') ?? '20';
  const sol = readString(result.body, 'sol') ?? '0.02';
  const signature = readString(result.body, 'signature');
  const sig = signature === undefined ? {} : { signature };
  switch (result.status) {
    case 200:
      return { ok: true, message: 'Sent ' + usdc + ' test USDC and ' + sol + ' devnet SOL to your wallet.', ...sig };
    case 202:
      return { ok: true, message: 'Sent ' + usdc + ' test USDC and ' + sol + ' devnet SOL. It may take a few seconds to arrive.', ...sig };
    case 429: {
      const wait = readNumber(result.body, 'retry_after_s');
      const hours = wait === undefined ? undefined : Math.max(1, Math.ceil(wait / 3600));
      return {
        ok: false,
        message: hours === undefined
          ? 'Test funds were already sent to this wallet today.'
          : 'Test funds were already sent to this wallet today. Try again in about ' +
            String(hours) + (hours === 1 ? ' hour.' : ' hours.'),
      };
    }
    case 503:
      return { ok: false, message: 'Test funds are used up for today. Try again tomorrow, or email support@bountycam.app.' };
    case 404:
      return { ok: false, message: 'Test funds are not available on this server.' };
    default: {
      const code = errorCodeOf(result.body);
      return { ok: false, message: "Couldn't send test funds" + (code === undefined ? '' : ' (' + code + ')') + '. Try again.' };
    }
  }
}
