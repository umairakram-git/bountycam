// FUNDING.md 2.3: the funding sequence. Steps 1 to 5 stop before the wallet
// opens; step 8 always runs after step 6, whatever step 6 returned.
//
// Every value the transaction carries comes from a FundingArgs that
// verifyCreatedBounty returned (POLICY.md 3.5 and 6.3). web3.js does the
// address derivation and the wire encoding; packages/shared does the checks.

import { Buffer } from 'buffer';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SpecError,
  TOKEN_PROGRAM_ID,
  checkFundingInstructions,
  createAndFundData,
  expectedFundingKeys,
} from '@hackathon/shared';
import type { FundingArgs, PlainInstruction } from '@hackathon/shared';

import { apiPostEmpty, errorCodeOf } from '../api/client';
import {
  ESCROW_CONFIG_ACCOUNT,
  ESCROW_PROGRAM_ID,
  MIN_LAMPORTS_FOR_FUNDING,
  SETTLEMENT_MINT,
  SOLANA_RPC_URL,
} from '../config';
import { formatUsdc } from '../create/createBounty';
import type { WalletProvider } from '../wallet/types';

export type LogLine = (line: string) => void;

/** Where the sequence ended, and what the requester is told (FUNDING.md 2.3). */
export type FundOutcome =
  /** 200 from the report: AVAILABLE with its program_account. */
  | { readonly kind: 'FUNDED'; readonly signature: string | undefined; readonly view: unknown }
  /** Stopped before the wallet opened. Nothing was sent. */
  | { readonly kind: 'NOT_SENT'; readonly message: string; readonly detail?: string }
  /** NOT_FUNDED at the last attempt after the wallet returned a signature. */
  | { readonly kind: 'PENDING'; readonly signature: string }
  /** NOT_FUNDED at the last attempt after the wallet reported failure. */
  | { readonly kind: 'NOT_FUNDED'; readonly message: string }
  /** A terminal server answer. */
  | { readonly kind: 'MISMATCH' | 'CANCELLED'; readonly message: string };

const REPORT_INTERVAL_MS = 2_000;
const REPORT_ATTEMPTS = 45;

const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);

function describeThrown(error: unknown): string {
  if (error instanceof SpecError) return error.code + ': ' + error.message;
  if (error instanceof Error) return error.name + ': ' + error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The associated token account of `owner` for `mint`, by its seeds. */
function associatedTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )[0];
}

export interface FundingAddresses {
  readonly requester: PublicKey;
  readonly config: PublicKey;
  readonly bounty: PublicKey;
  readonly usdcMint: PublicKey;
  readonly bountyVault: PublicKey;
  readonly requesterAta: PublicKey;
}

/** FUNDING.md 2.3 step 2. Throws if the config derivation disagrees with the constant. */
export function deriveAddresses(requester: PublicKey, args: FundingArgs): FundingAddresses {
  const programId = new PublicKey(ESCROW_PROGRAM_ID);
  const usdcMint = new PublicKey(SETTLEMENT_MINT);
  const config = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
  if (config.toBase58() !== ESCROW_CONFIG_ACCOUNT) {
    throw new Error('config derivation ' + config.toBase58() + ' is not ' + ESCROW_CONFIG_ACCOUNT);
  }
  const bounty = PublicKey.findProgramAddressSync(
    [Buffer.from('bounty'), requester.toBytes(), args.bountyId],
    programId,
  )[0];
  return {
    requester,
    config,
    bounty,
    usdcMint,
    bountyVault: associatedTokenAccount(bounty, usdcMint),
    requesterAta: associatedTokenAccount(requester, usdcMint),
  };
}

/** The transaction's instructions as the plain values the shared check reads. */
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

/** The whole sequence. `sessionWallet` is the base58 address the session signed in with. */
export async function fundBounty(
  provider: WalletProvider,
  token: string,
  bountyId: string,
  args: FundingArgs,
  sessionWallet: string,
  log: LogLine,
): Promise<FundOutcome> {
  // Step 1: the wallet is the session's wallet.
  const address = await provider.getAddress();
  if (!('addressBase58' in address)) {
    return { kind: 'NOT_SENT', message: 'Connect the wallet you signed in with first.' };
  }
  if (address.addressBase58 !== sessionWallet) {
    return { kind: 'NOT_SENT', message: 'Fund from the wallet you signed in with.' };
  }
  const requester = new PublicKey(address.addressBase58);

  // Step 2: derive.
  let addresses: FundingAddresses;
  try {
    addresses = deriveAddresses(requester, args);
  } catch (error: unknown) {
    return {
      kind: 'NOT_SENT',
      message: 'Something went wrong preparing this transaction. Nothing was sent.',
      detail: describeThrown(error),
    };
  }
  log('bounty account: ' + addresses.bounty.toBase58());
  log('vault: ' + addresses.bountyVault.toBase58());

  // Step 3: courtesy balance checks over the client RPC.
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const reward = formatUsdc(args.rewardAmount);
  try {
    const lamports = await connection.getBalance(requester);
    log('SOL balance: ' + String(lamports) + ' lamports');
    if (lamports < MIN_LAMPORTS_FOR_FUNDING) {
      return { kind: 'NOT_SENT', message: 'This wallet needs a little devnet SOL.' };
    }
    let held = 0n;
    try {
      const balance = await connection.getTokenAccountBalance(addresses.requesterAta);
      held = BigInt(balance.value.amount);
    } catch {
      held = 0n; // No token account is no balance.
    }
    log('test USDC held (base units): ' + held.toString());
    if (held < args.rewardAmount) {
      return {
        kind: 'NOT_SENT',
        message: 'This wallet needs at least ' + reward + ' test USDC.',
      };
    }
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: 'Could not read balances.', detail: describeThrown(error) };
  }

  // Step 4: build. One instruction, the requester paying, a fresh blockhash.
  let wire: Uint8Array;
  try {
    const data = createAndFundData(args);
    const keys = expectedFundingKeys({
      programId: new PublicKey(ESCROW_PROGRAM_ID).toBytes(),
      requester: requester.toBytes(),
      config: addresses.config.toBytes(),
      bounty: addresses.bounty.toBytes(),
      usdcMint: addresses.usdcMint.toBytes(),
      bountyVault: addresses.bountyVault.toBytes(),
      requesterAta: addresses.requesterAta.toBytes(),
      data,
    }).map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));
    const instruction = new TransactionInstruction({
      programId: new PublicKey(ESCROW_PROGRAM_ID),
      keys,
      data: Buffer.from(data),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: requester, blockhash, lastValidBlockHeight });
    tx.add(instruction);
    wire = Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  } catch (error: unknown) {
    return {
      kind: 'NOT_SENT',
      message: 'Something went wrong preparing this transaction. Nothing was sent.',
      detail: describeThrown(error),
    };
  }

  // Step 5: check the bytes the wallet will receive (SECURITY.md 3).
  try {
    const decoded = Transaction.from(wire);
    checkFundingInstructions(plainInstructions(decoded), {
      programId: new PublicKey(ESCROW_PROGRAM_ID).toBytes(),
      requester: requester.toBytes(),
      config: addresses.config.toBytes(),
      bounty: addresses.bounty.toBytes(),
      usdcMint: addresses.usdcMint.toBytes(),
      bountyVault: addresses.bountyVault.toBytes(),
      requesterAta: addresses.requesterAta.toBytes(),
      data: createAndFundData(args),
    });
    if (decoded.feePayer === undefined || !decoded.feePayer.equals(requester)) {
      throw new Error('fee payer is not the requester');
    }
  } catch (error: unknown) {
    return {
      kind: 'NOT_SENT',
      message: 'Something went wrong preparing this transaction. Nothing was sent.',
      detail: describeThrown(error),
    };
  }
  log('transaction checked: one instruction, nine accounts, ' + String(wire.length) + ' bytes');

  // Step 6: sign and send.
  const sent = await provider.signAndSendTransaction(wire);
  // Step 7: record.
  let signature: string | undefined;
  if (sent.ok) {
    signature = sent.signature;
    log('signature: ' + signature);
    log('https://explorer.solana.com/tx/' + signature + '?cluster=devnet');
  } else {
    log('wallet returned failure [' + sent.kind + ']: ' + sent.message);
    if (sent.detail !== undefined) log('  ' + sent.detail);
  }

  // Step 8: report, whatever step 6 said.
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await apiPostEmpty(token, '/bounties/' + bountyId + '/funding');
    } catch (error: unknown) {
      log('report attempt ' + String(attempt) + ' failed: ' + describeThrown(error));
      await sleep(REPORT_INTERVAL_MS);
      continue;
    }
    const code = errorCodeOf(result.body);
    if (result.status === 200) {
      log('report: 200 after ' + String(attempt) + ' attempt(s)');
      return { kind: 'FUNDED', signature, view: result.body };
    }
    if (result.status === 409 && code === 'BINDING_MISMATCH') {
      return {
        kind: 'MISMATCH',
        message: 'Funded, but it does not match its terms. It will not be listed.',
      };
    }
    if (result.status === 409 && code === 'BOUNTY_NOT_FUNDABLE') {
      return { kind: 'CANCELLED', message: 'This bounty was cancelled.' };
    }
    if (result.status !== 503 && !(result.status === 409 && code === 'NOT_FUNDED')) {
      log('report: unexpected HTTP ' + String(result.status) + ' ' + String(code));
    }
    await sleep(REPORT_INTERVAL_MS);
  }
  if (signature !== undefined) return { kind: 'PENDING', signature };
  return { kind: 'NOT_FUNDED', message: 'Funding did not go through.' };
}
