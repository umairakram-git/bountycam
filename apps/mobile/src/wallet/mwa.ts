// The Android WalletProvider, over Mobile Wallet Adapter.
//
// Every MWA type stays inside this file. The types quoted in comments below are
// the installed ones, read from
// @solana-mobile/mobile-wallet-adapter-protocol@2.3.0/lib/types/index.d.ts —
// the web3js package inherits `authorize` from it unchanged.

import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

import { APP_IDENTITY, MWA_CHAIN } from '../config';
import type {
  SiwsInput,
  WalletAddress,
  WalletAuthorizeResult,
  WalletAddressResult,
  WalletFailure,
  WalletFailureKind,
  WalletProvider,
  WalletSignInResult,
} from './types';

function fail(
  kind: WalletFailureKind,
  message: string,
  detail?: string,
): WalletFailure {
  return detail === undefined
    ? { ok: false, kind, message }
    : { ok: false, kind, message, detail };
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  return String(error);
}

/**
 * `Account.address` is typed `Base64EncodedAddress`, and that is the encoding
 * we treat as authoritative. `Buffer.from(_, 'base64')` does not throw on a
 * malformed string — it drops the characters it cannot read — so the length
 * check is the only real gate, and it is a hard one: a wrong length never
 * proceeds.
 */
function decodeAddress(addressBase64: string): WalletAddress | WalletFailure {
  const bytes = Buffer.from(addressBase64, 'base64');
  if (bytes.length !== 32) {
    return fail(
      'ADDRESS_NOT_32_BYTES',
      'wallet address decoded to ' + String(bytes.length) + ' bytes, expected 32',
      'raw base64: ' + addressBase64,
    );
  }
  return { addressBase64, addressBase58: new PublicKey(bytes).toBase58() };
}

/**
 * The authorize result, minus the auth token, as a log line.
 *
 * `auth_token` is a bearer credential for the wallet session — the same
 * category as the JWT, and not public by construction the way a SIWS message
 * and its signature are. Its length is evidence that one came back; its value
 * is not evidence of anything.
 */
function describeAuthorizeResult(result: {
  accounts: readonly { address: string }[];
  auth_token: string;
  wallet_uri_base: string;
}): string {
  const accounts = result.accounts.map((account) => account.address).join(', ');
  return (
    'accounts: [' +
    accounts +
    '], wallet_uri_base: ' +
    result.wallet_uri_base +
    ', auth_token: <redacted, length ' +
    String(result.auth_token.length) +
    '>, sign_in_result: absent'
  );
}

export function createMwaWalletProvider(): WalletProvider {
  let authToken: string | undefined;
  let account: WalletAddress | undefined;

  return {
    async authorize(): Promise<WalletAuthorizeResult> {
      let result;
      try {
        // First of two round-trips. No sign_in_payload: the challenge cannot be
        // requested until we know the address, and the address is what this
        // call is for.
        result = await transact(async (wallet) =>
          wallet.authorize({ identity: APP_IDENTITY, chain: MWA_CHAIN }),
        );
      } catch (error: unknown) {
        return fail('WALLET_ERROR', 'authorize threw: ' + describeThrown(error));
      }

      // `noUncheckedIndexedAccess` is on, so this really is possibly undefined.
      const first = result.accounts[0];
      if (first === undefined) {
        return fail('NO_ACCOUNTS', 'wallet authorized but returned no accounts');
      }

      const decoded = decodeAddress(first.address);
      if (!('addressBase64' in decoded)) {
        return decoded;
      }

      authToken = result.auth_token;
      account = decoded;
      return { ok: true, ...decoded };
    },

    async getAddress(): Promise<WalletAddressResult> {
      if (account === undefined) {
        return fail('NOT_AUTHORIZED', 'no account; authorize() has not succeeded');
      }
      return account;
    },

    async signIn(input: SiwsInput): Promise<WalletSignInResult> {
      const token = authToken;
      if (token === undefined) {
        return fail(
          'NOT_AUTHORIZED',
          'signIn() called before a successful authorize()',
        );
      }

      let result;
      try {
        // Second round-trip, carrying BOTH the token from the first authorize
        // and the payload. Whether a wallet honours sign_in_payload on what is
        // effectively a reauthorize is the device question this run answers; if
        // it does not, the caller sees NO_SIGN_IN_SUPPORT and the result below.
        //
        // sign_in_payload is `input` itself — the object JSON.parse produced,
        // by reference. Not a spread, not a field-by-field rebuild, not
        // re-encoded. This matters because the type cannot help here:
        // `SignInPayload` has every field optional in both branches of its
        // union, so TypeScript accepts `{}` in this position and would accept a
        // payload missing the nonce just as happily. Reference identity is the
        // only guarantee that what the server issued is what the wallet signs,
        // and the only way a ninth field the server adds later still arrives.
        result = await transact(async (wallet) =>
          wallet.authorize({
            identity: APP_IDENTITY,
            chain: MWA_CHAIN,
            auth_token: token,
            sign_in_payload: input,
          }),
        );
      } catch (error: unknown) {
        return fail(
          'WALLET_ERROR',
          'authorize with sign_in_payload threw: ' + describeThrown(error),
        );
      }

      authToken = result.auth_token;

      // `sign_in_result` is optional on AuthorizationResult. Absent means the
      // wallet did not do the sign-in. There is no fallback to signMessages in
      // this change: that path is a separate open item (AUTH.md 14.2) and
      // silently taking it would destroy the measurement.
      const signInResult = result.sign_in_result;
      if (signInResult === undefined) {
        return fail(
          'NO_SIGN_IN_SUPPORT',
          'wallet authorized but returned no sign_in_result',
          describeAuthorizeResult(result),
        );
      }

      return {
        ok: true,
        signedMessageBase64: signInResult.signed_message,
        signatureBase64: signInResult.signature,
        signatureType: signInResult.signature_type,
        addressBase64: signInResult.address,
      };
    },

    disconnect(): void {
      // Local only, by ruling. No deauthorize, no third transact. The wallet
      // keeps its side of the authorization; we forget ours.
      authToken = undefined;
      account = undefined;
    },
  };
}
