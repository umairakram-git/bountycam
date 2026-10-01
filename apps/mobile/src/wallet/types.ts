// The wallet boundary.
//
// SECURITY.md 14 (and PRD section 52, which it cites) requires that all wallet
// interaction sit behind this interface, so that an iOS adapter can implement
// the same shape later. No type in this file comes from any MWA package, and no
// signature here mentions one. Chain-specific encoding stays inside the
// adapters that implement `WalletProvider`.

/**
 * The SIWS input exactly as `POST /auth/siws/challenge` issued it
 * (AUTH.md 5.1).
 *
 * The eight fields below are the ones the server names, and a runtime check
 * confirms all eight are present and are strings before this type is applied.
 * That check is a gate, not a filter: the value carried under this type is
 * always the object `JSON.parse` produced, with every field the server sent,
 * including any the server may add later. Nothing in this codebase rebuilds it.
 */
export interface SiwsInput {
  readonly domain: string;
  readonly address: string;
  readonly statement: string;
  readonly version: string;
  readonly chainId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
}

/** An authorized account, in both encodings the flow needs. */
export interface WalletAddress {
  /** Exactly as the wallet returned it. Authoritative; never recomputed. */
  readonly addressBase64: string;
  /** Decoded from `addressBase64`, which was confirmed to be 32 bytes. */
  readonly addressBase58: string;
}

/**
 * Why a wallet call did not produce a result. One kind per distinct cause; a
 * cause that cannot occur gets no kind (the D34 rule against unreachable
 * codes).
 */
export type WalletFailureKind =
  /** The wallet authorized but returned no `sign_in_result` at all. */
  | 'NO_SIGN_IN_SUPPORT'
  /** The wallet authorized but returned no account. */
  | 'NO_ACCOUNTS'
  /**
   * The returned address did not decode to exactly 32 bytes. Covers a
   * non-base64 string too, since that decodes to the wrong length rather than
   * throwing.
   */
  | 'ADDRESS_NOT_32_BYTES'
  /** `signIn` was called before a successful `authorize`. */
  | 'NOT_AUTHORIZED'
  /** The wallet, or the transport to it, threw. */
  | 'WALLET_ERROR'
  /** The reauthorize inside a send returned a different account (FUNDING.md 3). */
  | 'ACCOUNT_CHANGED'
  /** The wallet sent nothing back for the one transaction or message it was given. */
  | 'NO_SIGNATURE'
  /**
   * A signed message came back neither as 64 bytes nor as the message followed by 64
   * bytes (CAPTURE.md 7.8). The detail carries the returned length.
   */
  | 'SIGNATURE_SHAPE';

export interface WalletFailure {
  readonly ok: false;
  readonly kind: WalletFailureKind;
  /** Readable, for the log pane. Never swallowed. */
  readonly message: string;
  /** Whatever the wallet did return, when that is the evidence. */
  readonly detail?: string;
}

export interface WalletAuthorizeSuccess extends WalletAddress {
  readonly ok: true;
}

export interface WalletSignInSuccess {
  readonly ok: true;
  /** Base64, exactly as the wallet returned it. Forwarded without re-encoding. */
  readonly signedMessageBase64: string;
  /** Base64, exactly as the wallet returned it. Forwarded without re-encoding. */
  readonly signatureBase64: string;
  /**
   * Absent when the wallet omitted it. AUTH.md 5.2 makes the field optional and
   * requires `ed25519` when present; the adapter reports what came back and the
   * server decides.
   */
  readonly signatureType: string | undefined;
  /** Base64, as named in the wallet's own result. Not sent to verify. */
  readonly addressBase64: string;
}

export type WalletAuthorizeResult = WalletAuthorizeSuccess | WalletFailure;
export type WalletAddressResult = WalletAddress | WalletFailure;
export type WalletSignInResult = WalletSignInSuccess | WalletFailure;

export interface WalletSendSuccess {
  readonly ok: true;
  /** The transaction signature in base58, as the wallet returned it. */
  readonly signature: string;
}

export type WalletSendResult = WalletSendSuccess | WalletFailure;

export interface WalletSignMessageSuccess {
  readonly ok: true;
  /** The 64-byte ed25519 signature over the message, alone. */
  readonly signature: Uint8Array;
}

export type WalletSignMessageResult = WalletSignMessageSuccess | WalletFailure;

export interface WalletProvider {
  /**
   * Connect and select an account. Must succeed before `signIn`, because the
   * challenge is issued against the address this returns.
   */
  authorize(): Promise<WalletAuthorizeResult>;

  /**
   * The account from the last successful `authorize`. Asynchronous so that an
   * adapter which has to ask its wallet, rather than read a cache, can
   * implement the same shape.
   */
  getAddress(): Promise<WalletAddressResult>;

  /**
   * Sign the server's SIWS input. The argument is handed to the wallet as the
   * same object reference it arrived as — see the adapter for why that matters.
   */
  signIn(input: SiwsInput): Promise<WalletSignInResult>;

  /**
   * Sign and send one transaction (FUNDING.md section 3). The argument is the
   * unsigned transaction's wire bytes, so this interface names no chain-library
   * type. A failure result does not prove nothing was sent: the caller must
   * still ask the server (FUNDING.md 2.3 step 8).
   */
  signAndSendTransaction(transaction: Uint8Array): Promise<WalletSendResult>;

  /**
   * Sign one off-chain message with the signed-in account (CAPTURE.md 7.8): the
   * BOUNTYCAM_EVIDENCE_V1 statement. Returns the 64-byte signature alone, whichever of the
   * two shapes the wallet used.
   */
  signMessage(message: Uint8Array): Promise<WalletSignMessageResult>;

  /** Drop local session state. Local only; talks to no wallet. */
  disconnect(): void;
}
