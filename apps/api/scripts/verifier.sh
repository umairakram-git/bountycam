#!/bin/sh
# BountyCam verifier launcher (POLICY.md section 19.4). Configuration lives outside the
# repo; this does not. Prints paths, never contents.
set -eu

ENV_FILE="$HOME/bountycam-env/api.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
MODE=$(stat -f '%OLp' "$ENV_FILE")
[ "$MODE" = "600" ] || { echo "$ENV_FILE mode $MODE, expected 600" >&2; exit 1; }

set -a
. "$ENV_FILE"
set +a

for v in DATABASE_URL SOLANA_RPC_URL ESCROW_PROGRAM_ID ESCROW_CONFIG_ACCOUNT \
         EVIDENCE_STORE_ENDPOINT EVIDENCE_STORE_BUCKET EVIDENCE_STORE_ACCESS_KEY_ID \
         EVIDENCE_STORE_SECRET_PATH ATTESTER_KEY_PATH RELAYER_KEY_PATH
do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is empty" >&2; exit 1; }
  case "$val" in *REPLACE_ME*) echo "$v still holds its placeholder" >&2; exit 1;; esac
done

for f in "$ATTESTER_KEY_PATH" "$RELAYER_KEY_PATH" "$EVIDENCE_STORE_SECRET_PATH"; do
  [ -f "$f" ] || { echo "$f not found" >&2; exit 1; }
  FMODE=$(stat -f '%OLp' "$f")
  [ "$FMODE" = "600" ] || { echo "$f mode $FMODE, expected 600" >&2; exit 1; }
done

echo "env sha256:  $(shasum -a 256 "$ENV_FILE" | cut -d' ' -f1)"
echo "program:     $ESCROW_PROGRAM_ID"
echo "config acct: $ESCROW_CONFIG_ACCOUNT"
echo "rpc host:    $(echo "$SOLANA_RPC_URL" | sed 's|^https://\([^/?]*\).*|\1|') (rest not printed)"
echo "attester:    $ATTESTER_KEY_PATH (contents not printed)"
echo "relayer:     $RELAYER_KEY_PATH (contents not printed)"
echo "evidence:    $EVIDENCE_STORE_ENDPOINT bucket $EVIDENCE_STORE_BUCKET (secret not printed)"
psql "$DATABASE_URL" -tAc "select 1" >/dev/null 2>&1 || {
  echo "database unreachable: $(echo "$DATABASE_URL" | sed 's|.*/||')" >&2
  exit 1
}
echo "database:    reachable (url not printed)"

cd "$(dirname "$0")/.."
exec node src/verifier/main.ts
