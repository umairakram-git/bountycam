import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const dbName = `bountycam_migration_test_${randomBytes(4).toString("hex")}`;
const dbUrl = `postgres://localhost:5432/${dbName}`;

function psql(database: string, sql: string): string {
  return execFileSync("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], {
    encoding: "utf8",
  }).trim();
}

function migrate(...args: string[]): string {
  return execFileSync(
    "pnpm",
    ["exec", "node-pg-migrate", "--migrations-dir", "migrations", ...args],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: dbUrl } },
  );
}

const expectedTables = [
  "assignments",
  "bounties",
  "decisions",
  "evidence_items",
  "evidence_requirements",
  "policies",
  "reputation_events",
  "submissions",
  "users",
];

test("migrations apply to a scratch database and roll back cleanly", () => {
  psql("postgres", `CREATE DATABASE ${dbName}`);
  try {
    process.stdout.write(migrate("up"));

    const tables = psql(
      dbName,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    ).split("\n");
    for (const t of expectedTables) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }

    const applied = Number(psql(dbName, "SELECT count(*) FROM pgmigrations"));
    assert.ok(applied > 0, "no migrations recorded in pgmigrations");

    process.stdout.write(migrate("down", String(applied)));

    const remaining = psql(
      dbName,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    assert.equal(remaining, "pgmigrations", `tables left after rollback: ${remaining}`);

    const enumCount = psql(
      dbName,
      "SELECT count(*) FROM pg_type WHERE typname = 'bounty_state'",
    );
    assert.equal(enumCount, "0", "bounty_state enum not dropped on rollback");
  } finally {
    psql("postgres", `DROP DATABASE IF EXISTS ${dbName}`);
  }
});
