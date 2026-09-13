/* eslint-disable camelcase */

// POLICY.md section 11.2. Empty-table validity (section 11.3): BOTH directions
// run only while bounties is empty. Forward adds three NOT NULL columns with
// no defaults (location_public, idempotency_key, request_digest); the rollback
// re-adds two (deadline, review_window_seconds — the Session 3 definitions).
// Once Session 7b's endpoints write the first row, both directions document
// shape and are not runnable; changing shape then requires a data-preserving
// migration written at that time.

exports.up = (pgm) => {
  pgm.sql(`
    -- Twenty digits hold the full u64 range; scale zero forbids fractional
    -- storage (POLICY.md section 6.2). Read-model copy, never authoritative.
    ALTER TABLE bounties
      ALTER COLUMN reward_amount TYPE numeric(20, 0);
    ALTER TABLE bounties
      ADD CONSTRAINT bounties_reward_amount_u64
        CHECK (reward_amount >= 1 AND reward_amount <= 18446744073709551615);

    -- Durations live in the policy; an absolute deadline cannot exist before
    -- the transition that starts its window (POLICY.md section 7.1, D62).
    ALTER TABLE bounties DROP COLUMN deadline;
    ALTER TABLE bounties DROP COLUMN review_window_seconds;

    -- The snapped public point (POLICY.md section 9.1) — the only geography
    -- discovery may filter or order on (section 8.4).
    ALTER TABLE bounties
      ADD COLUMN location_public geography(Point, 4326) NOT NULL;
    CREATE INDEX bounties_location_public_gist_idx
      ON bounties USING gist (location_public);

    ALTER TABLE bounties ADD COLUMN idempotency_key uuid NOT NULL;
    ALTER TABLE bounties ADD COLUMN request_digest bytea NOT NULL;
    ALTER TABLE bounties
      ADD CONSTRAINT bounties_request_digest_32_bytes
        CHECK (octet_length(request_digest) = 32);

    -- Index name is load-bearing: the create handler distinguishes an
    -- idempotent replay from every other unique violation by matching 23505
    -- against this name (POLICY.md section 8.3 step 9). Renaming it is an
    -- application change, not a cosmetic one. Both columns are NOT NULL, so
    -- the constraint is total (D59).
    CREATE UNIQUE INDEX bounties_requester_idempotency_uidx
      ON bounties (requester_id, idempotency_key);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Valid only while bounties is empty: deadline and review_window_seconds
    -- return as NOT NULL with no defaults (the Session 3 definitions).
    DROP INDEX bounties_requester_idempotency_uidx;

    ALTER TABLE bounties DROP CONSTRAINT bounties_request_digest_32_bytes;
    ALTER TABLE bounties DROP COLUMN request_digest;
    ALTER TABLE bounties DROP COLUMN idempotency_key;

    DROP INDEX bounties_location_public_gist_idx;
    ALTER TABLE bounties DROP COLUMN location_public;

    ALTER TABLE bounties ADD COLUMN review_window_seconds integer NOT NULL;
    ALTER TABLE bounties ADD COLUMN deadline timestamptz NOT NULL;

    ALTER TABLE bounties DROP CONSTRAINT bounties_reward_amount_u64;
    ALTER TABLE bounties ALTER COLUMN reward_amount TYPE numeric;
  `);
};
