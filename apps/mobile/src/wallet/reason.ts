// TXN-004 (D169): why a wallet call ended without a result, read from what the
// Mobile Wallet Adapter threw. Pure, so it is testable without the native module.
//
// On React Native the adapter rejects with:
// - SolanaMobileWalletAdapterProtocolError, code -1 (authorization declined),
//   -3 (not signed: the user declined), -4 (signed but not submitted);
// - SolanaMobileWalletAdapterError with code ERROR_WALLET_NOT_FOUND, or with the
//   native rejection text as its code: "Session not established: Local association
//   cancelled by user" (the wallet was closed), "Timed out waiting for response"
//   and "Timed out waiting for local association to be ready".

export type WalletReason =
  /** The user declined in the wallet. Nothing was signed or sent. */
  | 'DECLINED'
  /** The wallet was closed before the user answered. Nothing was signed or sent. */
  | 'CLOSED'
  /** The wallet did not answer in time. A send may or may not have gone out. */
  | 'TIMEOUT'
  /** No installed wallet supports Mobile Wallet Adapter. */
  | 'NO_WALLET'
  /** The wallet signed but could not submit the transaction. Nothing was sent. */
  | 'NOT_SUBMITTED'
  /** Anything else. A send may or may not have gone out. */
  | 'OTHER';

export function reasonOf(error: unknown): WalletReason {
  if (!(error instanceof Error)) return 'OTHER';
  const code = (error as { code?: unknown }).code;
  if (code === 'ERROR_WALLET_NOT_FOUND') return 'NO_WALLET';
  if (error.name === 'SolanaMobileWalletAdapterProtocolError') {
    if (code === -1 || code === -3) return 'DECLINED';
    if (code === -4) return 'NOT_SUBMITTED';
    return 'OTHER';
  }
  const text = String(code ?? '') + ' ' + error.message;
  if (/cancel/i.test(text)) return 'CLOSED';
  if (/timed out|timeout/i.test(text)) return 'TIMEOUT';
  return 'OTHER';
}
