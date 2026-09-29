/* eslint-disable camelcase */

// POLICY.md section 17.2 (D131). Migration 12: the capture nonce's own table.
//
// capture_nonces holds every nonce ever issued, one ACTIVE per assignment at
// most. The composite foreign key to assignments_binding_key makes the row's
// bounty and Scout those of its assignment. status has no default: the
// issuing transaction writes ACTIVE, and consumeCaptureNonce is the only
// writer of CONSUMED and EXPIRED (sections 17.6 and 17.8).
//
// assignments.challenge_nonce is dropped with its unique constraint. No row
// ever held a value (29 September): the column was the design D73 rejected.
//
// Down restores challenge_nonce as nullable and unique, then drops the table,
// the binding key and the type. Valid against any table state.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE capture_nonce_status AS ENUM ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'CONSUMED');

    ALTER TABLE assignments
      ADD CONSTRAINT assignments_binding_key UNIQUE (id, bounty_id, scout_id);

    CREATE TABLE capture_nonces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id uuid NOT NULL,
      bounty_id uuid NOT NULL,
      scout_id uuid NOT NULL,
      deployment_id smallint NOT NULL,
      value bytea NOT NULL,
      status capture_nonce_status NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      start_lat text NOT NULL,
      start_lon text NOT NULL,
      start_accuracy_m double precision NOT NULL,
      start_fixed_at timestamptz NOT NULL,
      CONSTRAINT capture_nonces_value_key UNIQUE (value),
      CONSTRAINT capture_nonces_value_length CHECK (octet_length(value) = 32),
      CONSTRAINT capture_nonces_deployment_range CHECK (deployment_id BETWEEN 0 AND 255),
      CONSTRAINT capture_nonces_accuracy_range CHECK (start_accuracy_m >= 0),
      CONSTRAINT capture_nonces_expiry_after_issue CHECK (expires_at > issued_at),
      CONSTRAINT capture_nonces_consumed_pair
        CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL)),
      CONSTRAINT capture_nonces_assignment_fkey
        FOREIGN KEY (assignment_id, bounty_id, scout_id)
        REFERENCES assignments (id, bounty_id, scout_id)
    );

    CREATE UNIQUE INDEX capture_nonces_one_active_idx
      ON capture_nonces (assignment_id)
      WHERE status = 'ACTIVE';

    ALTER TABLE assignments DROP COLUMN challenge_nonce;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE assignments ADD COLUMN challenge_nonce bytea UNIQUE;
    DROP TABLE capture_nonces;
    ALTER TABLE assignments DROP CONSTRAINT assignments_binding_key;
    DROP TYPE capture_nonce_status;
  `);
};
