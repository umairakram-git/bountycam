/* eslint-disable camelcase */

// ELIGIBILITY.md section 8 (D115). Migration 10: assignments.accepted_at loses
// the now() default that migration 1 declared and migration 8 left in place.
//
// A reservation is written with accepted_at absent (D113). With the default,
// an insert naming no accepted_at received the current time, every reservation
// read as an acceptance, and the section 6.1 flip — whose predicate is
// accepted_at IS NULL — matched nothing. ELIGIBILITY.md test 24 caught it.
//
// The down restores the default. A default constrains only future inserts, so
// both directions are valid against any table state.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE assignments ALTER COLUMN accepted_at DROP DEFAULT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE assignments ALTER COLUMN accepted_at SET DEFAULT now();
  `);
};
