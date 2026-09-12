/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.sql(`
    -- Single value: the only status Session 6 code can produce (D34, D44).
    -- Later sessions that introduce suspension add values by migration.
    CREATE TYPE user_status AS ENUM ('ACTIVE');

    ALTER TABLE users ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE users
      ALTER COLUMN status TYPE user_status
      USING upper(status)::user_status;
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'ACTIVE';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE users
      ALTER COLUMN status TYPE text USING lower(status::text);
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';

    DROP TYPE user_status;
  `);
};
