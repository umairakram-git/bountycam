// DISCOVERY.md 3.3: the accept sequence. Steps 1 to 6 stop before the wallet
// opens; step 8 runs after step 7 whatever step 7 returned.
//
// Every value the transaction carries is either the phone's own (its wallet,
// compiled constants) or has passed checkVoucher (SPEC.md 9.3). web3.js does
// the wire encoding; packages/shared does the checks.

import { Buffer } from 'buffer';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ED25519_PROGRAM_ID,
  ELIGIBILITY_PROFILES,
  SpecError,
  acceptData,
  checkAcceptInstructions,
  checkVoucher,
  ed25519InstructionData,
  eligibilityProfileHash,
  expectedAcceptKeys,
  uuidBytes,
} from '@hackathon/shared';
import type { ExpectedAccept, PlainInstruction, Voucher } from '@hackathon/shared';

import { apiPostEmpty, errorCodeOf } from '../api/client';
import {
  DEPLOYMENT_ID,
  ELIGIBILITY_AUTHORITY,
  ESCROW_CONFIG_ACCOUNT,
  ESCROW_PROGRAM_ID,
  MIN_LAMPORTS_FOR_ACCEPT,
  SOLANA_RPC_URL,
} from '../config';
import type { WalletProvider } from '../wallet/types';
import { hexToBytes, type PublicBounty } from './views';

export type LogLine = (line: string) => void;

export type AcceptOutcome =
  /** 200 from the report: the assigned-Scout view, not yet verified. */
  | { readonly kind: 'ACCEPTED'; readonly view: unknown; readonly policyHash: Uint8Array }
  /** Stopped before the wallet opened. Nothing was sent. */
  | { readonly kind: 'NOT_SENT'; readonly message: string; readonly detail?: string }
  /** The wallet returned a signature; the acceptance is not confirmed yet. */
  | { readonly kind: 'PENDING'; readonly signature: string }
  /** The wallet did not send; the voucher is still valid. Accept is offered again. */
  | { readonly kind: 'RETRY'; readonly message: string }
  /** The wallet did not send and the hold has ended (D123 ruling 3). */
  | { readonly kind: 'HOLD_ENDED'; readonly message: string }
  /** A terminal server answer. */
  | { readonly kind: 'TAKEN' | 'GONE'; readonly message: string };

const REPORT_INTERVAL_MS = 2_000;
const REPORT_GRACE_MS = 60_000;
const WALLET_FAILED_ATTEMPTS = 3;
const NOT_SENT_PREPARING = 'Something went wrong preparing this transaction. Nothing was sent.';

const VOUCHER_MESSAGES: Readonly<Record<string, string>> = {
  BOUNTY_RESERVED: 'Another Scout is accepting this bounty. Try again in a few minutes.',
  BOUNTY_NOT_ACCEPTABLE: 'This bounty is no longer available.',
  ACCEPTANCE_WINDOW_CLOSED: 'This bounty has closed.',
  SCOUT_IS_REQUESTER: 'You posted this bounty.',
  SEEKER_NOT_HELD: 'This bounty needs a Seeker in this wallet.',
  SEEKER_ALREADY_CLAIMED: 'This Seeker is linked to another BountyCam account.',
  ACCOUNT_NOT_ACTIVE: "This account can't accept bounties right now.",
};

function describeThrown(error: unknown): string {
  if (error instanceof SpecError) return error.code + ': ' + error.message;
  if (error instanceof Error) return error.name + ': ' + error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plainInstructions(tx: Transaction): PlainInstruction[] {
  return tx.instructions.map((ix) => ({
    programId: ix.programId.toBytes(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBytes(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Uint8Array.from(ix.data),
  }));
}

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/** Step 4's decode: base64 message and signature, base58 authority, integer expiry. */
function decodeVoucher(body: unknown): Voucher {
  const message = field(body, 'message');
  const signature = field(body, 'signature');
  const authority = field(body, 'authority');
  const expiresAt = field(body, 'expires_at');
  if (
    typeof message !== 'string' ||
    typeof signature !== 'string' ||
    typeof authority !== 'string' ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw new Error('voucher response has the wrong shape');
  }
  return {
    message: Uint8Array.from(Buffer.from(message, 'base64')),
    signature: Uint8Array.from(Buffer.from(signature, 'base64')),
    authority: new PublicKey(authority).toBytes(),
    expiresAt: BigInt(expiresAt),
  };
}

/** The whole sequence. `sessionWallet` is the base58 address the session signed in with. */
export async function acceptBounty(
  provider: WalletProvider,
  token: string,
  bounty: PublicBounty,
  sessionWallet: string,
  log: LogLine,
): Promise<AcceptOutcome> {
  // Step 1: the wallet is the session's wallet.
  const address = await provider.getAddress();
  if (!('addressBase58' in address)) {
    return { kind: 'NOT_SENT', message: 'Connect the wallet you signed in with first.' };
  }
  if (address.addressBase58 !== sessionWallet) {
    return { kind: 'NOT_SENT', message: 'Accept from the wallet you signed in with.' };
  }
  const scout = new PublicKey(address.addressBase58);

  // Step 2: courtesy balance check (SECURITY.md 12).
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  try {
    const lamports = await connection.getBalance(scout);
    log('SOL balance: ' + String(lamports) + ' lamports');
    if (lamports < MIN_LAMPORTS_FOR_ACCEPT) {
      return { kind: 'NOT_SENT', message: 'This wallet needs a little devnet SOL.' };
    }
  } catch (error: unknown) {
    return {
      kind: 'NOT_SENT',
      message: 'Could not read the balance.',
      detail: describeThrown(error),
    };
  }

  // Step 3: the voucher.
  let response;
  try {
    response = await apiPostEmpty(token, '/bounties/' + bounty.id + '/voucher');
  } catch (error: unknown) {
    return {
      kind: 'NOT_SENT',
      message: "Couldn't reach BountyCam. Try again.",
      detail: describeThrown(error),
    };
  }
  if (response.status !== 200) {
    const code = errorCodeOf(response.body);
    log('voucher: HTTP ' + String(response.status) + ' ' + String(code));
    const message =
      response.status === 503
        ? "Couldn't reach BountyCam. Try again."
        : (code !== undefined ? VOUCHER_MESSAGES[code] : undefined) ??
          "This bounty can't be accepted right now.";
    return { kind: 'NOT_SENT', message };
  }

  // Step 4: check the voucher against what the phone knows.
  let voucher: Voucher;
  let programAccount: PublicKey;
  let config: PublicKey;
  try {
    voucher = decodeVoucher(response.body);
    const profile = ELIGIBILITY_PROFILES.get(bounty.eligibilityProfileId);
    if (profile === undefined) throw new Error('unknown profile ' + bounty.eligibilityProfileId);
    if (!/^[0-9a-f]{64}$/.test(bounty.policyHash)) throw new Error('policy_hash is not hex');
    if (bounty.programAccount === undefined) throw new Error('no program_account');
    checkVoucher(voucher, {
      programId: new PublicKey(ESCROW_PROGRAM_ID).toBytes(),
      deploymentId: DEPLOYMENT_ID,
      bountyId: uuidBytes(bounty.id),
      scout: scout.toBytes(),
      policyHash: hexToBytes(bounty.policyHash),
      eligibilityProfileHash: eligibilityProfileHash(profile),
      requiredAssurance: bounty.requiredAssurance,
      authority: new PublicKey(ELIGIBILITY_AUTHORITY).toBytes(),
    });
    programAccount = new PublicKey(bounty.programAccount);
    config = PublicKey.findProgramAddressSync(
      [Buffer.from('config')],
      new PublicKey(ESCROW_PROGRAM_ID),
    )[0];
    if (config.toBase58() !== ESCROW_CONFIG_ACCOUNT) {
      throw new Error(
        'config derivation ' + config.toBase58() + ' is not ' + ESCROW_CONFIG_ACCOUNT,
      );
    }
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: NOT_SENT_PREPARING, detail: describeThrown(error) };
  }
  log('voucher checked; expires at ' + voucher.expiresAt.toString());
  const expected: ExpectedAccept = {
    programId: new PublicKey(ESCROW_PROGRAM_ID).toBytes(),
    scout: scout.toBytes(),
    config: config.toBytes(),
    bounty: programAccount.toBytes(),
    authority: voucher.authority,
    signature: voucher.signature,
    message: voucher.message,
    expiresAt: voucher.expiresAt,
  };

  // Step 5: build. The ed25519 check at index 0, then accept; the Scout pays.
  let wire: Uint8Array;
  try {
    const verify = new TransactionInstruction({
      programId: new PublicKey(ED25519_PROGRAM_ID),
      keys: [],
      data: Buffer.from(
        ed25519InstructionData(voucher.authority, voucher.signature, voucher.message),
      ),
    });
    const accept = new TransactionInstruction({
      programId: new PublicKey(ESCROW_PROGRAM_ID),
      keys: expectedAcceptKeys(expected).map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(acceptData(voucher.expiresAt, 0)),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: scout, blockhash, lastValidBlockHeight });
    tx.add(verify, accept);
    wire = Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: NOT_SENT_PREPARING, detail: describeThrown(error) };
  }

  // Step 6: check the bytes the wallet will receive (SECURITY.md 3).
  try {
    const decoded = Transaction.from(wire);
    checkAcceptInstructions(plainInstructions(decoded), expected);
    if (decoded.feePayer === undefined || !decoded.feePayer.equals(scout)) {
      throw new Error('fee payer is not the Scout');
    }
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: NOT_SENT_PREPARING, detail: describeThrown(error) };
  }
  log('transaction checked: two instructions, ' + String(wire.length) + ' bytes');

  // Step 7: sign and send.
  const sent = await provider.signAndSendTransaction(wire);
  let signature: string | undefined;
  if (sent.ok) {
    signature = sent.signature;
    log('signature: ' + signature);
    log('https://explorer.solana.com/tx/' + signature + '?cluster=devnet');
  } else {
    log('wallet returned failure [' + sent.kind + ']: ' + sent.message);
    if (sent.detail !== undefined) log('  ' + sent.detail);
  }

  // Step 8: report, whatever step 7 said.
  const stopAtMs = Number(voucher.expiresAt) * 1000 + REPORT_GRACE_MS;
  for (let attempt = 1; ; attempt++) {
    let result;
    try {
      result = await apiPostEmpty(token, '/bounties/' + bounty.id + '/acceptance');
    } catch (error: unknown) {
      log('report attempt ' + String(attempt) + ' failed: ' + describeThrown(error));
      result = undefined;
    }
    if (result !== undefined) {
      const code = errorCodeOf(result.body);
      if (result.status === 200) {
        log('report: 200 after ' + String(attempt) + ' attempt(s)');
        // The voucher's policy hash, which the program matched against the account.
        const policyHash = voucher.message.slice(139, 171);
        return { kind: 'ACCEPTED', view: result.body, policyHash };
      }
      if (result.status === 409 && code === 'ACCEPTED_BY_OTHER') {
        return { kind: 'TAKEN', message: 'Another Scout accepted this bounty first.' };
      }
      if (result.status === 409 && code === 'BOUNTY_NOT_ACCEPTABLE') {
        return { kind: 'GONE', message: 'This bounty is no longer available.' };
      }
      if (result.status !== 503 && !(result.status === 409 && code === 'NOT_ACCEPTED')) {
        log('report: unexpected HTTP ' + String(result.status) + ' ' + String(code));
      }
    }
    if (!sent.ok && attempt >= WALLET_FAILED_ATTEMPTS) {
      // Section 3.3: after a wallet failure, Accept is offered again while the
      // voucher is valid, and the hold-ended message once it is not.
      return Date.now() < Number(voucher.expiresAt) * 1000
        ? { kind: 'RETRY', message: "The wallet didn't send it. You can accept again." }
        : { kind: 'HOLD_ENDED', message: 'Your hold ended. The bounty may still be available.' };
    }
    if (Date.now() >= stopAtMs) break;
    await sleep(REPORT_INTERVAL_MS);
  }
  if (signature !== undefined) return { kind: 'PENDING', signature };
  return { kind: 'HOLD_ENDED', message: 'Your hold ended. The bounty may still be available.' };
}
