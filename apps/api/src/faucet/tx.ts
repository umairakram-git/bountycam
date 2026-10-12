// D167: the faucet transaction. The relayer pays the fee and sends devnet SOL; the
// recipient's associated token account is created if missing; the faucet key, as the test
// mint's authority, mints test USDC into it. Three instructions, two signers.
import { base58 } from "@scure/base";
import { legacyMessage } from "../chain/tx.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
} from "../chain/pda.ts";

export const SYSTEM_PROGRAM = base58.decode(SYSTEM_PROGRAM_ID);
export const TOKEN_PROGRAM = base58.decode(TOKEN_PROGRAM_ID);
export const ATA_PROGRAM = base58.decode(ASSOCIATED_TOKEN_PROGRAM_ID);

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u64le(n: bigint): number[] {
  if (n < 0n || n >= 1n << 64n) throw new Error("amount out of u64 range");
  const out: number[] = [];
  let v = n;
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

export interface FaucetTxInput {
  readonly relayer: Uint8Array;
  readonly faucet: Uint8Array;
  readonly recipient: Uint8Array;
  readonly mint: Uint8Array;
  readonly lamports: bigint;
  readonly usdcAmount: bigint;
  readonly blockhash: Uint8Array;
}

export function recipientTokenAccount(recipient: Uint8Array, mint: Uint8Array): Uint8Array {
  return associatedTokenAddress(recipient, mint, TOKEN_PROGRAM, ATA_PROGRAM);
}

/** The message the relayer and the faucet sign, in that order. */
export function faucetMessage(input: FaucetTxInput): Uint8Array {
  if (input.recipient.length !== 32) throw new Error("recipient must be 32 bytes");
  const ata = recipientTokenAccount(input.recipient, input.mint);
  return legacyMessage(input.relayer, [input.faucet], [
    {
      programId: SYSTEM_PROGRAM, // Transfer
      accounts: [
        { key: input.relayer, writable: true },
        { key: input.recipient, writable: true },
      ],
      data: Uint8Array.from([...u32le(2), ...u64le(input.lamports)]),
    },
    {
      programId: ATA_PROGRAM, // CreateIdempotent
      accounts: [
        { key: input.relayer, writable: true },
        { key: ata, writable: true },
        { key: input.recipient, writable: false },
        { key: input.mint, writable: false },
        { key: SYSTEM_PROGRAM, writable: false },
        { key: TOKEN_PROGRAM, writable: false },
      ],
      data: Uint8Array.from([1]),
    },
    {
      programId: TOKEN_PROGRAM, // MintTo
      accounts: [
        { key: input.mint, writable: true },
        { key: ata, writable: true },
        { key: input.faucet, writable: false },
      ],
      data: Uint8Array.from([7, ...u64le(input.usdcAmount)]),
    },
  ], input.blockhash);
}
