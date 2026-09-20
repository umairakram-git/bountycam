// programs/escrow/SPEC.md section 3: the configuration account, read once at
// startup (ELIGIBILITY.md section 3). Three facts come from it and two are
// cross-checked against this process's own configuration: eligibility_authority
// must be the key this process signs with, and usdc_mint must be
// SETTLEMENT_MINT. A mismatch is a deployment fault, so startup exits.
import { base58 } from "@scure/base";
import { bytesEqual, type EligibilityConfig } from "./config.ts";
import type { ChainReader } from "./rpc.ts";

// sha256("account:Config")[0..8], checked against the live devnet account on
// 21 September 2026.
export const CONFIG_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82,
]);
export const CONFIG_LENGTH = 138;

export interface Deployment {
  readonly deploymentId: number;
  readonly usdcMint: Uint8Array;
  readonly eligibilityAuthority: Uint8Array;
}

export type DeploymentErrorCode =
  | "CONFIG_ACCOUNT_MISSING"
  | "CONFIG_NOT_PROGRAM_ACCOUNT"
  | "CONFIG_BAD_LENGTH"
  | "CONFIG_BAD_DISCRIMINATOR"
  | "ELIGIBILITY_AUTHORITY_MISMATCH"
  | "SETTLEMENT_MINT_MISMATCH";

export class DeploymentError extends Error {
  readonly code: DeploymentErrorCode;

  constructor(code: DeploymentErrorCode, message: string) {
    super(message);
    this.name = "DeploymentError";
    this.code = code;
  }
}

// Checks in order: existence, owner, length, discriminator, authority, mint.
export async function resolveDeployment(
  reader: ChainReader,
  config: EligibilityConfig,
  settlementMint: string,
): Promise<Deployment> {
  const info = await reader.getAccount(config.configAccount);
  if (info === null) {
    throw new DeploymentError("CONFIG_ACCOUNT_MISSING", "configuration account not found");
  }
  if (info.owner !== config.programId) {
    throw new DeploymentError(
      "CONFIG_NOT_PROGRAM_ACCOUNT",
      "configuration account is not owned by the escrow program",
    );
  }
  const d = info.data;
  if (d.length !== CONFIG_LENGTH) {
    throw new DeploymentError("CONFIG_BAD_LENGTH", "configuration account has the wrong size");
  }
  if (!bytesEqual(d.slice(0, 8), CONFIG_DISCRIMINATOR)) {
    throw new DeploymentError(
      "CONFIG_BAD_DISCRIMINATOR",
      "configuration account is not a Config account",
    );
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const deploymentId = view.getUint8(8);
  const usdcMint = d.slice(9, 41);
  const eligibilityAuthority = d.slice(41, 73);
  if (!bytesEqual(eligibilityAuthority, config.keyPubkey)) {
    throw new DeploymentError(
      "ELIGIBILITY_AUTHORITY_MISMATCH",
      "on-chain eligibility_authority is not this process's key",
    );
  }
  if (!bytesEqual(usdcMint, base58.decode(settlementMint))) {
    throw new DeploymentError(
      "SETTLEMENT_MINT_MISMATCH",
      "on-chain usdc_mint is not SETTLEMENT_MINT",
    );
  }
  return { deploymentId, usdcMint, eligibilityAuthority };
}
