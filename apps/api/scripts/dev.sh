#!/bin/sh
# BountyCam API dev launcher. Configuration lives outside the repo; this does not.
set -eu

ENV_FILE="$HOME/bountycam-env/api.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
MODE=$(stat -f '%OLp' "$ENV_FILE")
[ "$MODE" = "600" ] || { echo "$ENV_FILE mode $MODE, expected 600" >&2; exit 1; }

set -a
. "$ENV_FILE"
set +a

for v in SIWS_DOMAIN SIWS_ALLOWED_CHAINS JWT_SECRET_PATH JWT_ISSUER \
         JWT_AUDIENCE SOLANA_CLUSTER SETTLEMENT_MINT ATTESTER_PUBKEYS DATABASE_URL
do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is empty" >&2; exit 1; }
  case "$val" in *REPLACE_ME*) echo "$v still holds its placeholder" >&2; exit 1;; esac
done

[ -f "$JWT_SECRET_PATH" ] || { echo "JWT secret file not found" >&2; exit 1; }
SMODE=$(stat -f '%OLp' "$JWT_SECRET_PATH")
[ "$SMODE" = "600" ] || { echo "JWT secret mode $SMODE, expected 600" >&2; exit 1; }

echo "env sha256:  $(shasum -a 256 "$ENV_FILE" | cut -d' ' -f1)"
echo "SIWS_DOMAIN: $SIWS_DOMAIN"
echo "chains:      $SIWS_ALLOWED_CHAINS   cluster: $SOLANA_CLUSTER"
echo "mint:        $SETTLEMENT_MINT"
echo "attester:    $ATTESTER_PUBKEYS"
echo "jwt:         iss=$JWT_ISSUER aud=$JWT_AUDIENCE (secret not printed)"
psql "$DATABASE_URL" -tAc "select 1" >/dev/null 2>&1 || {
  echo "database unreachable: $(echo "$DATABASE_URL" | sed 's|.*/||')" >&2
  exit 1
}
echo "database:    reachable (url not printed)"

cd "$(dirname "$0")/.."
exec node --watch src/index.ts
