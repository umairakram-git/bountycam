// D167: the devnet faucet's configuration. Off unless FAUCET_KEY_PATH is set. Devnet only:
// the faucet key may hold the test mint's authority, and nothing here may ever mint or send
// on another cluster.
import { base58 } from "@scure/base";
import { bytesEqual } from "../chain/config.ts";
import { readKeypair } from "../verifier/config.ts";

export interface FaucetConfig {
  readonly rpcUrl: string;
  readonly mint: Uint8Array;
  readonly mintAddress: string;
  readonly faucetSeed: Uint8Array;
  readonly faucetPubkey: Uint8Array;
  readonly relayerSeed: Uint8Array;
  readonly relayerPubkey: Uint8Array;
  /** Test USDC base units per grant (6 decimals). */
  readonly usdcAmount: bigint;
  /** Devnet lamports per grant. */
  readonly lamports: bigint;
  readonly cooldownS: number;
  readonly dailyCap: number;
  readonly confirmS: number;
}

const POSITIVE_INT = /^[1-9][0-9]{0,11}$/;

function positive(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!POSITIVE_INT.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(name + " is not set");
  return value;
}

/** Null when the faucet is off; throws when it is on but misconfigured. */
export function loadFaucetConfig(env: Record<string, string | undefined>): FaucetConfig | null {
  const faucetPath = env["FAUCET_KEY_PATH"];
  if (faucetPath === undefined || faucetPath === "") return null;
  const cluster = env["SOLANA_CLUSTER"] ?? "devnet";
  if (cluster !== "devnet") throw new Error("the faucet runs on devnet only (D167)");
  const rpcUrl = required(env, "SOLANA_RPC_URL");
  if (!rpcUrl.startsWith("https://")) throw new Error("SOLANA_RPC_URL must begin with https://");
  if (rpcUrl.includes("mainnet")) throw new Error("the faucet refuses a mainnet RPC URL (D167)");
  const mintAddress = required(env, "SETTLEMENT_MINT");
  const mint = base58.decode(mintAddress);
  if (mint.length !== 32) throw new Error("SETTLEMENT_MINT must be base58 for exactly 32 bytes");
  const faucet = readKeypair(faucetPath, "FAUCET_KEY_PATH");
  const relayer = readKeypair(required(env, "RELAYER_KEY_PATH"), "RELAYER_KEY_PATH");
  if (bytesEqual(faucet.pubkey, relayer.pubkey)) {
    throw new Error("the faucet key must differ from the relayer key");
  }
  return {
    rpcUrl,
    mint,
    mintAddress,
    faucetSeed: faucet.seed,
    faucetPubkey: faucet.pubkey,
    relayerSeed: relayer.seed,
    relayerPubkey: relayer.pubkey,
    usdcAmount: BigInt(positive(env, "FAUCET_USDC_BASE_UNITS", 20_000_000)),
    lamports: BigInt(positive(env, "FAUCET_LAMPORTS", 20_000_000)),
    cooldownS: positive(env, "FAUCET_COOLDOWN_S", 86_400),
    dailyCap: positive(env, "FAUCET_DAILY_CAP", 200),
    confirmS: positive(env, "FAUCET_CONFIRM_S", 30),
  };
}

/**
 * The SPL mint's authority, from the account data: a COption<Pubkey> at offset 0, four tag
 * bytes then 32 key bytes. Null when the mint has no authority or the data is too short.
 */
export function mintAuthority(data: Uint8Array): Uint8Array | null {
  if (data.length < 36) return null;
  const tag = data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24);
  return tag === 1 ? data.slice(4, 36) : null;
}
