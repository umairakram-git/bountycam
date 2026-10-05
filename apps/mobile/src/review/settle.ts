// REVIEW.md sections 3 and 4: the requester's approve and reject sequences. Steps before
// the wallet opens send nothing; the report always runs after the wallet returns
// (FUNDING.md 2.3's pattern). The Scout is read from the bounty account on chain (D160);
// packages/shared checks every instruction before MWA sees it (SECURITY.md 3).
import { Buffer } from 'buffer';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SpecError,
  TOKEN_PROGRAM_ID,
  approveData,
  checkApproveInstructions,
  checkRejectInstructions,
  expectedApproveKeys,
  rejectData,
  submittedScout,
  uuidBytes,
  verifyAssignedPolicy,
} from '@hackathon/shared';
import type { PlainInstruction } from '@hackathon/shared';

import { apiPostEmpty, errorCodeOf } from '../api/client';
import {
  ESCROW_CONFIG_ACCOUNT,
  ESCROW_PROGRAM_ID,
  SETTLEMENT_MINT,
  SOLANA_RPC_URL,
} from '../config';
import type { WalletProvider } from '../wallet/types';

export type LogLine = (line: string) => void;

export type SettleOutcome =
  /** The server's view after the state left SUBMITTED. */
  | { readonly kind: 'DONE'; readonly view: unknown }
  /** Stopped before the wallet opened. Nothing was sent. */
  | { readonly kind: 'NOT_SENT'; readonly message: string; readonly detail?: string }
  /** The wallet refused, and the bounty is still SUBMITTED. */
  | { readonly kind: 'CANCELLED'; readonly message: string }
  /** Signed, but the server has not seen the change yet. */
  | { readonly kind: 'PENDING'; readonly signature: string | undefined };

const REPORT_INTERVAL_MS = 2_000;
const REPORT_ATTEMPTS = 45;
const PREPARE_FAILED = 'Something went wrong preparing this transaction. Nothing was sent.';

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

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )[0];
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

function get(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** The view's own policy_hash as bytes, or undefined. */
function viewHash(view: unknown): Uint8Array | undefined {
  const h = get(view, 'policy_hash');
  if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return undefined;
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

interface Prepared {
  readonly requester: PublicKey;
  readonly programId: PublicKey;
  readonly config: PublicKey;
  readonly bounty: PublicKey;
  readonly mint: PublicKey;
  readonly vault: PublicKey;
  readonly connection: Connection;
}

/** Section 3 steps 2 to 4: the session wallet, the hashed policy, the derived addresses. */
async function prepare(
  provider: WalletProvider,
  view: unknown,
  sessionWallet: string,
): Promise<Prepared | { readonly kind: 'NOT_SENT'; readonly message: string; readonly detail?: string }> {
  const address = await provider.getAddress();
  if (!('addressBase58' in address)) {
    return { kind: 'NOT_SENT', message: 'Connect the wallet you signed in with first.' };
  }
  if (address.addressBase58 !== sessionWallet) {
    return { kind: 'NOT_SENT', message: 'Use the wallet you signed in with.' };
  }
  try {
    const hash = viewHash(view);
    if (hash === undefined) throw new Error('the view has no policy_hash');
    verifyAssignedPolicy(view, hash);
    const programId = new PublicKey(ESCROW_PROGRAM_ID);
    const requester = new PublicKey(address.addressBase58);
    const config = PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
    if (config.toBase58() !== ESCROW_CONFIG_ACCOUNT) throw new Error('config derivation differs');
    const id = String(get(view, 'id'));
    const bounty = PublicKey.findProgramAddressSync(
      [Buffer.from('bounty'), requester.toBytes(), uuidBytes(id)],
      programId,
    )[0];
    if (bounty.toBase58() !== get(view, 'program_account')) {
      throw new Error('the bounty address does not derive from this wallet and id');
    }
    const mint = new PublicKey(SETTLEMENT_MINT);
    return {
      requester,
      programId,
      config,
      bounty,
      mint,
      vault: ata(bounty, mint),
      connection: new Connection(SOLANA_RPC_URL, 'confirmed'),
    };
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: PREPARE_FAILED, detail: describeThrown(error) };
  }
}

/** Sign, send, then report until the state leaves SUBMITTED (section 3 steps 7 and 8). */
async function sendAndReport(
  provider: WalletProvider,
  token: string,
  bountyId: string,
  wire: Uint8Array,
  log: LogLine,
): Promise<SettleOutcome> {
  const sent = await provider.signAndSendTransaction(wire);
  let signature: string | undefined;
  if (sent.ok) {
    signature = sent.signature;
    log('signature: ' + signature);
  } else {
    log('wallet returned failure [' + sent.kind + ']: ' + sent.message);
  }
  for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt++) {
    try {
      const result = await apiPostEmpty(token, '/bounties/' + bountyId + '/settlement');
      const state = get(result.body, 'state');
      if (result.status === 200 && state !== 'SUBMITTED') return { kind: 'DONE', view: result.body };
      if (result.status === 200 && !sent.ok) {
        return { kind: 'CANCELLED', message: 'Cancelled. Nothing was sent.' };
      }
      if (result.status !== 200 && result.status !== 503) {
        log('report: HTTP ' + String(result.status) + ' ' + String(errorCodeOf(result.body)));
      }
    } catch (error: unknown) {
      log('report attempt ' + String(attempt) + ' failed: ' + describeThrown(error));
    }
    await sleep(REPORT_INTERVAL_MS);
  }
  return { kind: 'PENDING', signature };
}

async function blockhashTx(c: Connection, feePayer: PublicKey): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  return new Transaction({ feePayer, blockhash, lastValidBlockHeight });
}

/** REVIEW.md section 3. `view` is the owner view of a SUBMITTED bounty. */
export async function approveBounty(
  provider: WalletProvider,
  token: string,
  view: unknown,
  sessionWallet: string,
  log: LogLine,
): Promise<SettleOutcome> {
  const p = await prepare(provider, view, sessionWallet);
  if ('kind' in p) return p;
  let wire: Uint8Array;
  try {
    // Step 5: the Scout from the chain.
    const info = await p.connection.getAccountInfo(p.bounty, 'confirmed');
    if (info === null || !info.owner.equals(p.programId)) throw new Error('no escrow account');
    const scout = new PublicKey(submittedScout(Uint8Array.from(info.data)));
    const payout = ata(scout, p.mint);
    log('scout: ' + scout.toBase58());
    // Step 6: build and check.
    const expected = {
      programId: p.programId.toBytes(),
      requester: p.requester.toBytes(),
      config: p.config.toBytes(),
      bounty: p.bounty.toBytes(),
      usdcMint: p.mint.toBytes(),
      bountyVault: p.vault.toBytes(),
      scout: scout.toBytes(),
      scoutPayout: payout.toBytes(),
    };
    const [k0, k1] = expectedApproveKeys(expected);
    const meta = (k: { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    });
    const tx = await blockhashTx(p.connection, p.requester);
    tx.add(new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: k0!.map(meta),
      data: Buffer.from([1]),
    }));
    tx.add(new TransactionInstruction({
      programId: p.programId,
      keys: k1!.map(meta),
      data: Buffer.from(approveData()),
    }));
    wire = Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const decoded = Transaction.from(wire);
    checkApproveInstructions(plainInstructions(decoded), expected);
    if (decoded.feePayer === undefined || !decoded.feePayer.equals(p.requester)) {
      throw new Error('fee payer is not the requester');
    }
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: PREPARE_FAILED, detail: describeThrown(error) };
  }
  log('approve checked: two instructions, ' + String(wire.length) + ' bytes');
  return sendAndReport(provider, token, String(get(view, 'id')), wire, log);
}

/** REVIEW.md section 4. `requirementId` is one of the verified policy's requirement ids. */
export async function rejectBounty(
  provider: WalletProvider,
  token: string,
  view: unknown,
  requirementId: string,
  sessionWallet: string,
  log: LogLine,
): Promise<SettleOutcome> {
  const p = await prepare(provider, view, sessionWallet);
  if ('kind' in p) return p;
  let wire: Uint8Array;
  try {
    const requirements = get(get(view, 'policy'), 'evidence_requirements');
    if (!Array.isArray(requirements) ||
      !requirements.some((r) => get(r, 'id') === requirementId)) {
      throw new Error('the requirement is not in this bounty');
    }
    const id = uuidBytes(requirementId);
    const tx = await blockhashTx(p.connection, p.requester);
    tx.add(new TransactionInstruction({
      programId: p.programId,
      keys: [
        { pubkey: p.requester, isSigner: true, isWritable: true },
        { pubkey: p.bounty, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(rejectData(id)),
    }));
    wire = Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const decoded = Transaction.from(wire);
    checkRejectInstructions(plainInstructions(decoded), {
      programId: p.programId.toBytes(),
      requester: p.requester.toBytes(),
      bounty: p.bounty.toBytes(),
      requirementId: id,
    });
    if (decoded.feePayer === undefined || !decoded.feePayer.equals(p.requester)) {
      throw new Error('fee payer is not the requester');
    }
  } catch (error: unknown) {
    return { kind: 'NOT_SENT', message: PREPARE_FAILED, detail: describeThrown(error) };
  }
  log('reject checked: one instruction, ' + String(wire.length) + ' bytes');
  return sendAndReport(provider, token, String(get(view, 'id')), wire, log);
}
