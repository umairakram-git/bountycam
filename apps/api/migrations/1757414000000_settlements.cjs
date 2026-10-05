/* eslint-disable camelcase */

// POLICY.md section 20.2 (D158). Migration 15: settlement records.
//
// settlements holds one row per settled bounty: how it settled, the settling
// transaction's signature and its block time, written by the settlement projection
// (section 20.4) and nowhere else. decisions gains the rejection's or approval's
// signature and one decision per submission. submissions gains review_ends_at, the
// chain's submitted_at plus review_window_secs, so views never read the chain.
// No new column has a default: the projection writes every value.
//
// Up refuses to run over a decisions row (migrations 1 to 14 wrote none). Down
// refuses to run if settlements or decisions holds a row.

exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM decisions) THEN
        RAISE EXCEPTION 'migration 15 expects an empty decisions table';
      END IF;
    END $$;

    CREATE TYPE settlement_kind AS ENUM
      ('APPROVED', 'RELEASED', 'RESOLVED_PAID', 'RESOLVED_REFUNDED', 'EXPIRED_REFUNDED');

    CREATE TABLE settlements (
      bounty_id uuid PRIMARY KEY REFERENCES bounties (id),
      kind settlement_kind NOT NULL,
      tx_signature text NOT NULL,
      settled_at timestamptz NOT NULL,
      projected_at timestamptz NOT NULL
    );

    ALTER TABLE decisions ADD COLUMN tx_signature text;
    ALTER TABLE decisions
      ADD CONSTRAINT decisions_one_per_submission UNIQUE (submission_id);
    ALTER TABLE decisions
      ADD CONSTRAINT decisions_tx_signature
        CHECK (outcome = 'DISPUTE' OR tx_signature IS NOT NULL);

    ALTER TABLE submissions ADD COLUMN review_ends_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM settlements) OR EXISTS (SELECT 1 FROM decisions) THEN
        RAISE EXCEPTION 'migration 15 down expects empty settlements and decisions tables';
      END IF;
    END $$;

    ALTER TABLE submissions DROP COLUMN review_ends_at;
    ALTER TABLE decisions DROP CONSTRAINT decisions_tx_signature;
    ALTER TABLE decisions DROP CONSTRAINT decisions_one_per_submission;
    ALTER TABLE decisions DROP COLUMN tx_signature;
    DROP TABLE settlements;
    DROP TYPE settlement_kind;
  `);
};
