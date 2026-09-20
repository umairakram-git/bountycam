/* eslint-disable camelcase */

// ELIGIBILITY.md section 8 (D109, D111, D113). Migration 8: reservations and
// device claims.
//
// On assignments: expires_at arrives NOT NULL — every reservation carries the
// instant it stops being ACTIVE (section 6.1). NOT NULL leaves challenge_nonce,
// deadline and accepted_at: all three are acceptance-time facts, absent at
// reservation and written together when the on-chain acceptance is observed.
// The unique constraint on challenge_nonce and the one-ACTIVE-per-bounty
// partial index are unchanged; Postgres admits many NULLs under a unique
// index, so every real nonce is still bound.
//
// seeker_devices: one row per Seeker Genesis Token mint, first claim wins,
// enforced by the primary key rather than application logic (section 5.2).
//
// Empty-table validity (POLICY.md section 11.4): the rollback adds NOT NULL
// back to three columns and drops expires_at, and fails once a row exists.
// assignments and seeker_devices are empty in every environment today.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE assignments
      ADD COLUMN expires_at timestamptz NOT NULL;
    ALTER TABLE assignments
      ALTER COLUMN challenge_nonce DROP NOT NULL,
      ALTER COLUMN deadline DROP NOT NULL,
      ALTER COLUMN accepted_at DROP NOT NULL;
    CREATE TABLE seeker_devices (
      sgt_mint text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id),
      claimed_at timestamptz NOT NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE seeker_devices;
    ALTER TABLE assignments
      ALTER COLUMN accepted_at SET NOT NULL,
      ALTER COLUMN deadline SET NOT NULL,
      ALTER COLUMN challenge_nonce SET NOT NULL;
    ALTER TABLE assignments
      DROP COLUMN expires_at;
  `);
};
