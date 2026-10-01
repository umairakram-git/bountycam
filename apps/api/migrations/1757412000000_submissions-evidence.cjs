/* eslint-disable camelcase */

// POLICY.md section 18.2 (D142). Migration 13: submissions and evidence_items,
// reshaped for P4.
//
// Both tables exist since migration 1 and no code has ever written them. Up
// and down each refuse to run over rows: the added NOT NULL columns have no
// honest value for a pre-existing row, and down cannot restore columns P4's
// rows never held.
//
// submissions gains its bounty, Scout and capture nonce, the canonical
// manifest and the Scout's statement signature. One composite foreign key to
// assignments_binding_key replaces the single-column one, so a submission's
// bounty and Scout are those of its assignment, as capture_nonces' are.
// achieved_assurance becomes nullable (P5 sets it) and submitted_at loses its
// default (the injectable clock sets it). One submission per assignment
// (D138 ruling 3).
//
// evidence_items gains each photo's length, location, accuracy and fix time.

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM submissions) OR EXISTS (SELECT 1 FROM evidence_items) THEN
        RAISE EXCEPTION 'migration 13 requires submissions and evidence_items to be empty';
      END IF;
    END
    $$;

    ALTER TABLE submissions DROP CONSTRAINT submissions_assignment_id_fkey;
    ALTER TABLE submissions DROP COLUMN manifest_hash;
    ALTER TABLE submissions RENAME COLUMN merkle_root TO evidence_root;
    ALTER TABLE submissions ALTER COLUMN achieved_assurance DROP NOT NULL;
    ALTER TABLE submissions ALTER COLUMN submitted_at DROP DEFAULT;
    ALTER TABLE submissions
      ADD COLUMN bounty_id uuid NOT NULL,
      ADD COLUMN scout_id uuid NOT NULL,
      ADD COLUMN capture_nonce_id uuid NOT NULL,
      ADD COLUMN manifest text NOT NULL,
      ADD COLUMN statement_signature bytea NOT NULL,
      ADD CONSTRAINT submissions_binding_fkey
        FOREIGN KEY (assignment_id, bounty_id, scout_id)
        REFERENCES assignments (id, bounty_id, scout_id),
      ADD CONSTRAINT submissions_capture_nonce_fkey
        FOREIGN KEY (capture_nonce_id) REFERENCES capture_nonces (id),
      ADD CONSTRAINT submissions_capture_nonce_key UNIQUE (capture_nonce_id),
      ADD CONSTRAINT submissions_one_per_assignment UNIQUE (assignment_id),
      ADD CONSTRAINT submissions_root_length CHECK (octet_length(evidence_root) = 32),
      ADD CONSTRAINT submissions_signature_length CHECK (octet_length(statement_signature) = 64);

    ALTER TABLE evidence_items
      ADD COLUMN byte_length bigint NOT NULL,
      ADD COLUMN lat text NOT NULL,
      ADD COLUMN lon text NOT NULL,
      ADD COLUMN horizontal_accuracy_m integer NOT NULL,
      ADD COLUMN fixed_at timestamptz NOT NULL,
      ADD CONSTRAINT evidence_items_byte_length_positive CHECK (byte_length > 0),
      ADD CONSTRAINT evidence_items_accuracy_range CHECK (horizontal_accuracy_m >= 0),
      ADD CONSTRAINT evidence_items_hash_length CHECK (octet_length(hash) = 32),
      ADD CONSTRAINT evidence_items_one_per_requirement UNIQUE (submission_id, requirement_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM submissions) OR EXISTS (SELECT 1 FROM evidence_items) THEN
        RAISE EXCEPTION 'migration 13 down requires submissions and evidence_items to be empty';
      END IF;
    END
    $$;

    ALTER TABLE evidence_items
      DROP CONSTRAINT evidence_items_one_per_requirement,
      DROP CONSTRAINT evidence_items_hash_length,
      DROP CONSTRAINT evidence_items_accuracy_range,
      DROP CONSTRAINT evidence_items_byte_length_positive,
      DROP COLUMN fixed_at,
      DROP COLUMN horizontal_accuracy_m,
      DROP COLUMN lon,
      DROP COLUMN lat,
      DROP COLUMN byte_length;

    ALTER TABLE submissions
      DROP CONSTRAINT submissions_signature_length,
      DROP CONSTRAINT submissions_root_length,
      DROP CONSTRAINT submissions_one_per_assignment,
      DROP CONSTRAINT submissions_capture_nonce_key,
      DROP CONSTRAINT submissions_capture_nonce_fkey,
      DROP CONSTRAINT submissions_binding_fkey,
      DROP COLUMN statement_signature,
      DROP COLUMN manifest,
      DROP COLUMN capture_nonce_id,
      DROP COLUMN scout_id,
      DROP COLUMN bounty_id;
    ALTER TABLE submissions ALTER COLUMN submitted_at SET DEFAULT now();
    ALTER TABLE submissions ALTER COLUMN achieved_assurance SET NOT NULL;
    ALTER TABLE submissions RENAME COLUMN evidence_root TO merkle_root;
    ALTER TABLE submissions ADD COLUMN manifest_hash bytea NOT NULL;
    ALTER TABLE submissions
      ADD CONSTRAINT submissions_assignment_id_fkey
        FOREIGN KEY (assignment_id) REFERENCES assignments (id);
  `);
};
