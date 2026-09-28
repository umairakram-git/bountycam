/* eslint-disable camelcase */

// POLICY.md section 16.2 (D125, D126). Migration 11: the acceptance cutoff on
// bounties, and the constraint pairing an assignment's acceptance times.
//
// bounties.acceptance_cutoff is nullable with no default. Its only writer is
// the funding projection (section 16.3), which copies it from the bounty
// account; discovery lists a bounty only while the cutoff is at or after now.
// Rows projected before this migration keep a null cutoff and are not listed.
//
// assignments_acceptance_pair: accepted_at and deadline are both null (a
// reservation) or both set (an acceptance). challenge_nonce is not part of it:
// the capture nonce is issued at capture start, not at accept (D73, D125).
//
// Down drops both. Valid against any table state.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE bounties ADD COLUMN acceptance_cutoff timestamptz;
    ALTER TABLE assignments ADD CONSTRAINT assignments_acceptance_pair
      CHECK ((accepted_at IS NULL) = (deadline IS NULL));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE assignments DROP CONSTRAINT assignments_acceptance_pair;
    ALTER TABLE bounties DROP COLUMN acceptance_cutoff;
  `);
};
