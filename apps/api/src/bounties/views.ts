// POLICY.md section 8.2: a bounty is serialised in one of two views, plus the
// list item — three separate functions, never one function with a mode flag,
// so no later edit can leak a field across views by flipping the wrong branch.
//
// publicView and listItem land in commit 7 beside tests 54 and 59, which pin
// their exact key sets; their absence here is scoping, not omission. When they
// arrive: policy_public is an allow-list rebuild (thirteen keys written out),
// and location_public is computed by snapLat/snapLon over the parsed policy's
// lat and lon strings — never read back from the PostGIS location_public
// column, because geography round-trips through float8 and would reintroduce
// floating point into the one value D58 keeps out. A later "we already have
// it in the row" optimisation is exactly what this comment exists to stop.

export interface OwnerViewInput {
  id: string;
  title: string;
  category: string;
  state: string;
  programAccount: string | null;
  createdAt: Date;
  policyHashHex: string;
  canonicalJson: string;
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
  };
}
