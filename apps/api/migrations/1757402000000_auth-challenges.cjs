/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE auth_challenges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nonce text NOT NULL UNIQUE,
      address text NOT NULL,
      domain text NOT NULL,
      chain text NOT NULL,
      statement text NOT NULL,
      issued_at_value text NOT NULL,
      expiration_time_value text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON COLUMN auth_challenges.issued_at_value IS
      'Exact issuedAt string issued. Verification is string equality, never a re-rendering.';
    COMMENT ON COLUMN auth_challenges.expiration_time_value IS
      'Exact expirationTime string issued. Verification is string equality, never a re-rendering.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE auth_challenges;
  `);
};
