// TXN-004 (D169): what the user reads after a wallet error, rejection or
// cancellation — what happened, whether anything was sent, and what to do next.
// The technical detail still goes to Technical details; this is the screen text.
import type { WalletFailure } from './types';

/** What the wallet was asked to do, which decides what "nothing happened" means. */
export type WalletContext = 'SIGN_IN' | 'SEND' | 'SIGN';

const NOTHING: Readonly<Record<WalletContext, string>> = {
  SIGN_IN: "You're not signed in.",
  SEND: 'Nothing was sent and no money moved.',
  SIGN: 'Nothing was signed or submitted.',
};

/**
 * True when the failure proves no transaction went out, so a flow can say so at
 * once instead of waiting for the chain. A timeout or an unknown error proves
 * nothing: the wallet may have sent before it stopped answering.
 */
export function definitelyNotSent(failure: WalletFailure): boolean {
  switch (failure.kind) {
    case 'NOT_AUTHORIZED':
    case 'ACCOUNT_CHANGED':
      return true;
    case 'WALLET_ERROR':
      return failure.reason === 'DECLINED' || failure.reason === 'CLOSED' ||
        failure.reason === 'NO_WALLET' || failure.reason === 'NOT_SUBMITTED';
    default:
      return false;
  }
}

/** The screen text for a wallet failure. `retry` is the button to tap, as labelled. */
export function walletFailureText(
  failure: WalletFailure,
  context: WalletContext,
  retry: string,
): string {
  const nothing = NOTHING[context];
  switch (failure.kind) {
    case 'ACCOUNT_CHANGED':
      return 'Your wallet is on a different account from the one you signed in with. ' + nothing +
        ' Switch back to that account in your wallet, or sign out and sign in with this one.';
    case 'NOT_AUTHORIZED':
      return 'Your wallet connection ended. ' + nothing + ' Sign out, then sign in again.';
    case 'NO_SIGN_IN_SUPPORT':
      return "This wallet doesn't support Sign In With Solana. " + nothing +
        ' Try another wallet app, such as Phantom, Solflare or Seed Vault Wallet.';
    case 'WALLET_ERROR':
      switch (failure.reason) {
        case 'DECLINED':
          return 'You declined the request in your wallet. ' + nothing + ' Tap ' + retry +
            " when you're ready.";
        case 'CLOSED':
          return 'The wallet was closed before you approved. ' + nothing + ' Tap ' + retry +
            ' to reopen it.';
        case 'TIMEOUT':
          return "Your wallet didn't respond in time." +
            (context === 'SEND' ? '' : ' ' + nothing) +
            ' Open your wallet app, check it is unlocked, then tap ' + retry + '.';
        case 'NO_WALLET':
          return 'No Solana wallet app was found on this phone. ' + nothing +
            ' Install one that supports Mobile Wallet Adapter, such as Phantom or Solflare' +
            ' (Seed Vault Wallet is built into Seeker), then tap ' + retry + '.';
        case 'NOT_SUBMITTED':
          return "Your wallet signed, but couldn't send the transaction to Solana. " + nothing +
            ' Check your internet connection, then tap ' + retry + '.';
        default:
          break;
      }
      break;
    default:
      break;
  }
  return 'Your wallet reported a problem.' + (context === 'SEND' ? '' : ' ' + nothing) +
    ' Tap ' + retry + '. If it keeps happening, close and reopen your wallet app.';
}
