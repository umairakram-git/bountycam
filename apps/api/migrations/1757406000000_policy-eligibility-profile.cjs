/* eslint-disable camelcase */

// POLICY.md section 11.3 (D108). On policies: attester_pubkey out,
// eligibility_profile_id in. Both are read-model copies of a hashed field and
// never authoritative — the canonical text is (section 2.4) — so neither
// carries a constraint beyond NOT NULL, and a value disagreeing with the
// canonical text is a bug in creation, not a state the column polices.
//
// Empty-table validity (section 11.4): the rollback re-adds attester_pubkey as
// text NOT NULL with no default and fails once a single row exists. policies is
// empty in every environment today.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE policies
      DROP COLUMN attester_pubkey;
    ALTER TABLE policies
      ADD COLUMN eligibility_profile_id text NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE policies
      DROP COLUMN eligibility_profile_id;
    ALTER TABLE policies
      ADD COLUMN attester_pubkey text NOT NULL;
  `);
};
