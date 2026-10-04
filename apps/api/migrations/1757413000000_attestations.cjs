/* eslint-disable camelcase */

// POLICY.md section 19.2 (D148). Migration 14: the verifier's job table.
//
// One row per submission. The verifier inserts it PENDING, grades and signs it
// (SIGNED), and closes it SUBMITTED once the chain shows the attestation, or
// REFUSED, SHORTFALL or LAPSED. message and signature are written once and
// every send reuses them (D150); a job refused or lapsed after signing keeps
// them (amendment A1 to section 19.2). No column has a default: the verifier writes
// every value from its injectable clock.
//
// Down drops the table and the type. Valid against any table state.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE attestation_status AS ENUM
      ('PENDING', 'SIGNED', 'SUBMITTED', 'REFUSED', 'SHORTFALL', 'LAPSED');

    CREATE TABLE attestations (
      submission_id uuid PRIMARY KEY REFERENCES submissions (id),
      status attestation_status NOT NULL,
      achieved_assurance smallint,
      message bytea,
      signature bytea,
      reason text,
      tries integer NOT NULL,
      sends integer NOT NULL,
      next_attempt_at timestamptz NOT NULL,
      tx_signature text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT attestations_signed
        CHECK (status NOT IN ('SIGNED', 'SUBMITTED') OR message IS NOT NULL),
      CONSTRAINT attestations_signature_pair CHECK ((message IS NULL) = (signature IS NULL)),
      CONSTRAINT attestations_graded
        CHECK (status NOT IN ('SIGNED', 'SUBMITTED', 'SHORTFALL')
               OR achieved_assurance IS NOT NULL),
      CONSTRAINT attestations_reason
        CHECK ((status IN ('REFUSED', 'LAPSED')) = (reason IS NOT NULL)),
      CONSTRAINT attestations_submitted_tx
        CHECK (status <> 'SUBMITTED' OR tx_signature IS NOT NULL),
      CONSTRAINT attestations_message_length CHECK (octet_length(message) = 261),
      CONSTRAINT attestations_signature_length CHECK (octet_length(signature) = 64),
      CONSTRAINT attestations_assurance_range CHECK (achieved_assurance BETWEEN 0 AND 4),
      CONSTRAINT attestations_tries_range CHECK (tries >= 0),
      CONSTRAINT attestations_sends_range CHECK (sends >= 0)
    );

    CREATE INDEX attestations_due_idx
      ON attestations (next_attempt_at)
      WHERE status IN ('PENDING', 'SIGNED');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE attestations;
    DROP TYPE attestation_status;
  `);
};
