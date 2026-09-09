/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE bounty_state AS ENUM (
      'DRAFT', 'FUNDED', 'AVAILABLE', 'ACCEPTED', 'SUBMITTED', 'IN_REVIEW',
      'APPROVED', 'REJECTED', 'DISPUTED', 'PAID', 'REFUNDED', 'EXPIRED',
      'CANCELLED'
    );

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_address text NOT NULL UNIQUE,
      display_name text,
      trust_level smallint NOT NULL DEFAULT 0,
      seeker_verified boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'active'
    );

    CREATE TABLE policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id uuid NOT NULL REFERENCES users (id),
      canonical_json text NOT NULL,
      policy_hash bytea NOT NULL,
      required_assurance smallint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON COLUMN policies.canonical_json IS
      'Exact serialisation policy_hash was computed over. Never regenerate or reformat.';

    CREATE TABLE bounties (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id uuid NOT NULL REFERENCES users (id),
      policy_id uuid NOT NULL REFERENCES policies (id),
      title text NOT NULL,
      category text NOT NULL,
      latitude double precision NOT NULL,
      longitude double precision NOT NULL,
      capture_radius_m integer NOT NULL,
      reward_amount numeric NOT NULL,
      deadline timestamptz NOT NULL,
      review_window_seconds integer NOT NULL,
      state bounty_state NOT NULL DEFAULT 'DRAFT',
      program_account text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX bounties_state_idx ON bounties (state);
    CREATE INDEX bounties_latitude_longitude_idx ON bounties (latitude, longitude);

    CREATE TABLE evidence_requirements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      policy_id uuid NOT NULL REFERENCES policies (id),
      type text NOT NULL,
      title text NOT NULL,
      instructions text NOT NULL,
      sequence integer NOT NULL,
      required boolean NOT NULL DEFAULT true
    );

    CREATE TABLE assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bounty_id uuid NOT NULL REFERENCES bounties (id),
      scout_id uuid NOT NULL REFERENCES users (id),
      challenge_nonce bytea NOT NULL UNIQUE,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      deadline timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'active'
    );

    -- Unique partial index: at most one active assignment per bounty.
    -- Also serves as the lookup index on assignments(bounty_id) for active rows.
    CREATE UNIQUE INDEX assignments_one_active_per_bounty_idx
      ON assignments (bounty_id)
      WHERE status = 'active';

    CREATE TABLE submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id uuid NOT NULL REFERENCES assignments (id),
      manifest_hash bytea NOT NULL,
      merkle_root bytea NOT NULL,
      achieved_assurance smallint NOT NULL,
      attester_signature bytea,
      submitted_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE evidence_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES submissions (id),
      requirement_id uuid NOT NULL REFERENCES evidence_requirements (id),
      storage_key text NOT NULL,
      hash bytea NOT NULL,
      c2pa_present boolean NOT NULL,
      captured_at timestamptz NOT NULL
    );

    CREATE TABLE decisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id uuid NOT NULL REFERENCES submissions (id),
      outcome text NOT NULL,
      failed_requirement_id uuid REFERENCES evidence_requirements (id),
      reason text,
      decided_by uuid NOT NULL REFERENCES users (id),
      decided_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT decisions_reject_requires_failed_requirement
        CHECK (outcome <> 'reject' OR failed_requirement_id IS NOT NULL)
    );

    CREATE TABLE reputation_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id),
      bounty_id uuid NOT NULL REFERENCES bounties (id),
      event_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE reputation_events;
    DROP TABLE decisions;
    DROP TABLE evidence_items;
    DROP TABLE submissions;
    DROP TABLE assignments;
    DROP TABLE evidence_requirements;
    DROP TABLE bounties;
    DROP TABLE policies;
    DROP TABLE users;
    DROP TYPE bounty_state;
  `);
};
