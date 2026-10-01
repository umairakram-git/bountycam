#!/bin/sh
# POLICY.md section 18.10 (D140): the development evidence store, versitygw on
# 127.0.0.1:7070 over ~/bountycam-evidence. Its keys come from the API's
# environment file and reach versitygw as environment variables, never on the
# command line, so no process listing shows them.
set -eu

ENV_FILE="$HOME/bountycam-env/api.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a
. "$ENV_FILE"
set +a

for v in EVIDENCE_STORE_ACCESS_KEY_ID EVIDENCE_STORE_SECRET_PATH; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is empty" >&2; exit 1; }
done
[ -f "$EVIDENCE_STORE_SECRET_PATH" ] || { echo "evidence store secret file not found" >&2; exit 1; }
MODE=$(stat -f '%OLp' "$EVIDENCE_STORE_SECRET_PATH")
[ "$MODE" = "600" ] || { echo "evidence store secret mode $MODE, expected 600" >&2; exit 1; }
command -v versitygw >/dev/null || {
  echo "versitygw not installed: brew install versitygw" >&2
  exit 1
}

DATA="$HOME/bountycam-evidence"
mkdir -p "$DATA"
chmod 700 "$DATA"
echo "evidence store: 127.0.0.1:7070 over $DATA (keys not printed)"

ROOT_ACCESS_KEY="$EVIDENCE_STORE_ACCESS_KEY_ID"
ROOT_SECRET_KEY="$(cat "$EVIDENCE_STORE_SECRET_PATH")"
export ROOT_ACCESS_KEY ROOT_SECRET_KEY
exec versitygw --port 127.0.0.1:7070 --quiet posix "$DATA"
