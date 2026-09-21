// ELIGIBILITY.md sections 3 and 5: what the voucher route needs beyond the
// bounty routes' dependencies. Injected as one object so a test builds the
// app with doubles and index.ts with the real reader, signer and deployment.
import type { EligibilityConfig } from "../chain/config.ts";
import type { Deployment } from "../chain/deployment.ts";
import type { ChainReader } from "../chain/rpc.ts";
import type { EligibilitySigner } from "../chain/signer.ts";

// Section 5.1: the check returns the qualifying mint address, never a
// boolean, because section 5.2 needs it. null means the wallet holds no
// qualifying token. A throw means the check could not be performed.
export interface SeekerCheck {
  findSeekerMint(wallet: string): Promise<string | null>;
}

export interface EligibilityDeps {
  readonly config: EligibilityConfig;
  readonly deployment: Deployment;
  readonly chain: ChainReader;
  readonly signer: EligibilitySigner;
  readonly seeker: SeekerCheck;
}
