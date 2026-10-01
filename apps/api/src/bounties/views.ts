// POLICY.md section 8.2: a bounty is serialised in one of two views, plus the
// list item — three separate functions, never one function with a mode flag,
// so no later edit can leak a field across views by flipping the wrong branch.
//
// publicView and listItem are pinned by tests 54 and 59, which assert their
// exact key sets. policy_public is an allow-list rebuild (thirteen keys
// written out), and location_public is computed by snapLat/snapLon over the
// parsed policy's lat and lon strings — never read back from the PostGIS
// location_public column, because geography round-trips through float8 and
// would reintroduce floating point into the one value D58 keeps out. A later
// "we already have it in the row" optimisation is exactly what this comment
// exists to stop.

import { snapLat, snapLon } from "./snap.ts";

export interface OwnerViewInput {
  id: string;
  title: string;
  category: string;
  state: string;
  programAccount: string | null;
  createdAt: Date;
  policyHashHex: string;
  canonicalJson: string;
  // POLICY.md section 18.7 (D138 ruling 5): passed for an ACCEPTED bounty only; the key
  // exists exactly when this is given.
  submission?: Record<string, unknown> | null;
}

// Section 8.2 owner view: eight keys, requester only. The policy is produced
// by parsing the stored canonical_json (section 3.4), never re-assembled from
// columns, so what the owner verifies (section 3.5) is what was hashed. The
// salt is present by spec (D54: it travels with the policy), owner view only.
export function ownerView(input: OwnerViewInput): Record<string, unknown> {
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    state: input.state,
    program_account: input.programAccount,
    created_at: input.createdAt.toISOString(),
    policy_hash: input.policyHashHex,
    policy: JSON.parse(input.canonicalJson) as unknown,
    ...(input.submission === undefined ? {} : { submission: input.submission }),
  };
}

export interface PublicViewInput {
  id: string;
  title: string;
  category: string;
  state: string;
  programAccount: string | null;
  createdAt: Date;
  policyHashHex: string;
  canonicalJson: string;
}

export interface ListItemInput {
  id: string;
  title: string;
  category: string;
  state: string;
  createdAt: Date;
  rewardAmount: string;
  requiredAssurance: number;
  canonicalJson: string;
}

// The parsed-policy types deliberately omit the salt and the requirement id:
// the withheld section 9.4 values are unreadable at compile time here, on top
// of the allow-list rebuilds that keep them out of every emitted object.
interface StoredRequirement {
  prompt: string;
  required: boolean;
  type: string;
}

interface StoredPolicy {
  acceptance_window_seconds: number;
  capture_radius_m: number;
  chain: string;
  challenge_window_seconds: number;
  cluster: string;
  completion_window_seconds: number;
  domain_tag: string;
  eligibility_profile_id: string;
  evidence_requirements: StoredRequirement[];
  fee_amount: string;
  lat: string;
  lon: string;
  required_assurance: number;
  reward_amount: string;
  settlement_mint: string;
}

// Section 8.2 public view: nine keys with section 16.4's program_account,
// any other authenticated caller.
// policy_public writes the thirteen keys out literally in canonical order;
// each requirement item is a new object of exactly prompt, required, type.
export function publicView(input: PublicViewInput): Record<string, unknown> {
  const policy = JSON.parse(input.canonicalJson) as StoredPolicy;
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    state: input.state,
    program_account: input.programAccount,
    created_at: input.createdAt.toISOString(),
    policy_hash: input.policyHashHex,
    location_public: { lat: snapLat(policy.lat), lon: snapLon(policy.lon) },
    policy_public: {
      acceptance_window_seconds: policy.acceptance_window_seconds,
      capture_radius_m: policy.capture_radius_m,
      chain: policy.chain,
      challenge_window_seconds: policy.challenge_window_seconds,
      cluster: policy.cluster,
      completion_window_seconds: policy.completion_window_seconds,
      domain_tag: policy.domain_tag,
      eligibility_profile_id: policy.eligibility_profile_id,
      evidence_requirements: policy.evidence_requirements.map((item) => ({
        prompt: item.prompt,
        required: item.required,
        type: item.type,
      })),
      fee_amount: policy.fee_amount,
      required_assurance: policy.required_assurance,
      reward_amount: policy.reward_amount,
      settlement_mint: policy.settlement_mint,
    },
  };
}

// Section 8.2 list item: eight keys, one shape for both list endpoints.
// reward_amount and required_assurance are the read-model copies (D65); the
// policy is parsed only for the lat and lon strings that feed the snap.
export function listItem(input: ListItemInput): Record<string, unknown> {
  const policy = JSON.parse(input.canonicalJson) as StoredPolicy;
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    state: input.state,
    created_at: input.createdAt.toISOString(),
    reward_amount: input.rewardAmount,
    required_assurance: input.requiredAssurance,
    location_public: { lat: snapLat(policy.lat), lon: snapLon(policy.lon) },
  };
}

export interface AssignedViewInput extends PublicViewInput {
  assignmentId: string;
  acceptedAt: Date;
  deadline: Date;
  // POLICY.md section 17.7 (D134): built by captureObject in capture/nonce.ts.
  capture: Record<string, unknown>;
  // POLICY.md section 18.7: null, or the submission's four keys.
  submission: Record<string, unknown> | null;
}

// POLICY.md section 16.4 (D127): the assigned-Scout view. The public view plus
// the full policy, parsed from the stored canonical text, and the assignment's
// times. Only the Scout holding the acceptance is served it; the exact lat and
// lon reach the response through the policy strings alone (9.1).
export function assignedView(input: AssignedViewInput): Record<string, unknown> {
  return {
    ...publicView(input),
    policy: JSON.parse(input.canonicalJson) as unknown,
    assignment: {
      id: input.assignmentId,
      accepted_at: input.acceptedAt.toISOString(),
      deadline: input.deadline.toISOString(),
    },
    capture: input.capture,
    submission: input.submission,
  };
}
