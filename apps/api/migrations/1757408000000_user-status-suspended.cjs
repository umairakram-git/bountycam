/* eslint-disable camelcase */

// ELIGIBILITY.md section 8 (D114). Migration 9: user_status gains SUSPENDED.
//
// Migration 4 created the type with ACTIVE alone, so no row could fail the
// ELIGIBILITY.md section 5 base check and ACCOUNT_NOT_ACTIVE was unreachable
// (D34). No application code writes SUSPENDED; the only writer is test 10 of
// the eligibility suite, by direct SQL. Suspension as a feature is undecided
// and not implied by the value's existence.
//
// ADD VALUE is permitted inside a transaction on Postgres 12 and later
// provided the new value is not used in the same transaction; nothing here
// uses it.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE user_status ADD VALUE 'SUSPENDED';
  `);
};

// Postgres cannot remove a value from an enum type. Migration 4's down drops
// user_status entirely, so a full rollback is unaffected; a partial rollback
// to any point at or after migration 4 leaves the value in place, harmlessly.
exports.down = () => {};
