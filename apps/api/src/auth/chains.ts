// AUTH.md section 4: accepted chain forms and the canonical chain each maps to.
// Any form not in this table is rejected with CHAIN_NOT_ALLOWED.
export const CHAIN_FORMS: ReadonlyMap<string, string> = new Map([
  ["devnet", "devnet"],
  ["solana:devnet", "devnet"],
]);
