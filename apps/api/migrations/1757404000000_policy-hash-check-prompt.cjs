/* eslint-disable camelcase */

// POLICY.md section 11.1. Empty-table validity (section 11.3): the rollback
// re-adds instructions as text NOT NULL with no default, so it runs only while
// evidence_requirements is empty. Forward succeeds on a non-empty table but
// destroys instructions data. Once Session 7b's endpoints write the first row,
// the down migration documents the reverse shape and is not runnable; rolling
// back then requires a data-preserving down migration written at that time.

exports.up = (pgm) => {
  pgm.sql(`
    -- The column stores the raw 32-byte digest, nothing else (POLICY.md
    -- section 3.3).
    ALTER TABLE policies
      ADD CONSTRAINT policies_policy_hash_32_bytes
        CHECK (octet_length(policy_hash) = 32);

    -- The hashed object has one prompt string per requirement (POLICY.md
    -- section 2.2); the column takes its name. Two prose columns for one
    -- hashed string is a drift surface (section 7.1).
    ALTER TABLE evidence_requirements RENAME COLUMN title TO prompt;
    ALTER TABLE evidence_requirements DROP COLUMN instructions;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Valid only while evidence_requirements is empty: NOT NULL, no default
    -- (the Session 3 definition).
    ALTER TABLE evidence_requirements ADD COLUMN instructions text NOT NULL;
    ALTER TABLE evidence_requirements RENAME COLUMN prompt TO title;
    ALTER TABLE policies DROP CONSTRAINT policies_policy_hash_32_bytes;
  `);
};
