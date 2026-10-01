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
         JWT_AUDIENCE SOLANA_CLUSTER SETTLEMENT_MINT DATABASE_URL \
         SOLANA_RPC_URL SEEKER_RPC_URL ESCROW_PROGRAM_ID ESCROW_CONFIG_ACCOUNT \
         ELIGIBILITY_KEY_PATH
do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is empty" >&2; exit 1; }
  case "$val" in *REPLACE_ME*) echo "$v still holds its placeholder" >&2; exit 1;; esac
done

[ -f "$JWT_SECRET_PATH" ] || { echo "JWT secret file not found" >&2; exit 1; }
SMODE=$(stat -f '%OLp' "$JWT_SECRET_PATH")
[ "$SMODE" = "600" ] || { echo "JWT secret mode $SMODE, expected 600" >&2; exit 1; }
[ -f "$ELIGIBILITY_KEY_PATH" ] || { echo "eligibility key file not found" >&2; exit 1; }
KMODE=$(stat -f '%OLp' "$ELIGIBILITY_KEY_PATH")
[ "$KMODE" = "600" ] || { echo "eligibility key mode $KMODE, expected 600" >&2; exit 1; }

echo "env sha256:  $(shasum -a 256 "$ENV_FILE" | cut -d' ' -f1)"
echo "SIWS_DOMAIN: $SIWS_DOMAIN"
echo "chains:      $SIWS_ALLOWED_CHAINS   cluster: $SOLANA_CLUSTER"
echo "mint:        $SETTLEMENT_MINT"
echo "program:     $ESCROW_PROGRAM_ID"
echo "config acct: $ESCROW_CONFIG_ACCOUNT"
echo "rpc host:    $(echo "$SOLANA_RPC_URL" | sed 's|^https://\([^/?]*\).*|\1|') (rest not printed)"
echo "seeker rpc:  $(echo "$SEEKER_RPC_URL" | sed 's|^https://\([^/?]*\).*|\1|') (rest not printed)"
echo "elig key:    $ELIGIBILITY_KEY_PATH (contents not printed)"
echo "jwt:         iss=$JWT_ISSUER aud=$JWT_AUDIENCE (secret not printed)"
if [ -n "${EVIDENCE_STORE_SECRET_PATH:-}" ]; then
  [ -f "$EVIDENCE_STORE_SECRET_PATH" ] || {
    echo "evidence store secret file not found" >&2
    exit 1
  }
  EMODE=$(stat -f '%OLp' "$EVIDENCE_STORE_SECRET_PATH")
  [ "$EMODE" = "600" ] || { echo "evidence store secret mode $EMODE, expected 600" >&2; exit 1; }
  echo "evidence:    ${EVIDENCE_STORE_ENDPOINT:-} bucket ${EVIDENCE_STORE_BUCKET:-}" \
    "(secret not printed)"
else
  echo "evidence:    store not configured; upload and submission routes off"
fi
psql "$DATABASE_URL" -tAc "select 1" >/dev/null 2>&1 || {
  echo "database unreachable: $(echo "$DATABASE_URL" | sed 's|.*/||')" >&2
  exit 1
}
echo "database:    reachable (url not printed)"

cd "$(dirname "$0")/.."
exec node --watch src/index.ts
