/* eslint-disable camelcase */

// D167. Migration 16: devnet faucet grants.
//
// One row per request to POST /faucet. A row that is not FAILED counts against the
// caller's cooldown and the daily cap, so a double tap cannot mint twice. tx_signature is
// written before the transaction is sent; status moves PENDING -> SENT or FAILED.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE faucet_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id),
      wallet_address text NOT NULL,
      granted_at timestamptz NOT NULL,
      tx_signature text,
      status text NOT NULL,
      CONSTRAINT faucet_grants_status CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
    );
    CREATE INDEX faucet_grants_user_time ON faucet_grants (user_id, granted_at DESC);
    CREATE INDEX faucet_grants_time ON faucet_grants (granted_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE faucet_grants;`);
};
