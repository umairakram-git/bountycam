/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS postgis;

    CREATE TYPE decision_outcome AS ENUM ('APPROVE', 'REJECT', 'DISPUTE');
    CREATE TYPE assignment_status AS ENUM ('ACTIVE', 'ABANDONED', 'EXPIRED', 'COMPLETED');

    -- decisions.outcome: text -> decision_outcome
    ALTER TABLE decisions
      DROP CONSTRAINT decisions_reject_requires_failed_requirement;
    ALTER TABLE decisions
      ALTER COLUMN outcome TYPE decision_outcome
      USING upper(outcome)::decision_outcome;
    ALTER TABLE decisions
      ADD CONSTRAINT decisions_reject_requires_failed_requirement
        CHECK (outcome <> 'REJECT' OR failed_requirement_id IS NOT NULL);

    -- assignments.status: text -> assignment_status.
    -- The partial unique index references the old text value, so it must be
    -- dropped before the type change and recreated against the enum label.
    DROP INDEX assignments_one_active_per_bounty_idx;
    ALTER TABLE assignments ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE assignments
      ALTER COLUMN status TYPE assignment_status
      USING upper(status)::assignment_status;
    ALTER TABLE assignments ALTER COLUMN status SET DEFAULT 'ACTIVE';
    CREATE UNIQUE INDEX assignments_one_active_per_bounty_idx
      ON assignments (bounty_id)
      WHERE status = 'ACTIVE';

    -- bounties: latitude/longitude -> geography(Point, 4326) location
    DROP INDEX bounties_latitude_longitude_idx;
    ALTER TABLE bounties ADD COLUMN location geography(Point, 4326);
    UPDATE bounties
      SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography;
    ALTER TABLE bounties ALTER COLUMN location SET NOT NULL;
    ALTER TABLE bounties DROP COLUMN latitude, DROP COLUMN longitude;
    CREATE INDEX bounties_location_gist_idx ON bounties USING gist (location);

    -- policies.attester_pubkey: named by the requester at policy creation,
    -- covered by policy_hash. Deliberately NOT NULL with no default: existing
    -- rows cannot be backfilled because the hash already excludes the field.
    ALTER TABLE policies ADD COLUMN attester_pubkey text NOT NULL;
    COMMENT ON COLUMN policies.attester_pubkey IS
      'Verifier pubkey named by the requester at policy creation. Covered by policy_hash.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE policies DROP COLUMN attester_pubkey;

    DROP INDEX bounties_location_gist_idx;
    ALTER TABLE bounties ADD COLUMN latitude double precision;
    ALTER TABLE bounties ADD COLUMN longitude double precision;
    UPDATE bounties
      SET latitude = ST_Y(location::geometry),
          longitude = ST_X(location::geometry);
    ALTER TABLE bounties ALTER COLUMN latitude SET NOT NULL;
    ALTER TABLE bounties ALTER COLUMN longitude SET NOT NULL;
    ALTER TABLE bounties DROP COLUMN location;
    CREATE INDEX bounties_latitude_longitude_idx ON bounties (latitude, longitude);

    DROP INDEX assignments_one_active_per_bounty_idx;
    ALTER TABLE assignments ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE assignments
      ALTER COLUMN status TYPE text USING lower(status::text);
    ALTER TABLE assignments ALTER COLUMN status SET DEFAULT 'active';
    CREATE UNIQUE INDEX assignments_one_active_per_bounty_idx
      ON assignments (bounty_id)
      WHERE status = 'active';

    ALTER TABLE decisions
      DROP CONSTRAINT decisions_reject_requires_failed_requirement;
    ALTER TABLE decisions
      ALTER COLUMN outcome TYPE text USING lower(outcome::text);
    ALTER TABLE decisions
      ADD CONSTRAINT decisions_reject_requires_failed_requirement
        CHECK (outcome <> 'reject' OR failed_requirement_id IS NOT NULL);

    DROP TYPE assignment_status;
    DROP TYPE decision_outcome;

    DROP EXTENSION IF EXISTS postgis;
  `);
};
