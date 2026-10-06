#!/bin/sh
# ops/DEPLOY.md section 5, the server half. Run by deploy.sh; safe to run again by hand:
#   sh /opt/bountycam/src/ops/deploy/server-up.sh
# Writes db.env once (the Postgres password never changes after the first run), server.env
# and store.env, builds the image, migrates, starts everything and checks it from inside.
set -eu
ROOT=/opt/bountycam
cd "$ROOT"
DC="docker compose --project-directory $ROOT -f $ROOT/src/ops/deploy/compose.yaml"

if [ ! -f db.env ]; then
  umask 077
  printf 'POSTGRES_USER=bountycam\nPOSTGRES_DB=bountycam\nPOSTGRES_PASSWORD=%s\n' \
    "$(openssl rand -hex 24)" > db.env
  echo "db.env created (password not printed)"
fi
PW=$(sed -n 's/^POSTGRES_PASSWORD=//p' db.env)
umask 077
{ cat server.env.base; printf 'DATABASE_URL=postgres://bountycam:%s@127.0.0.1:5432/bountycam\n' "$PW"; } > server.env
val() { sed -n "s/^$1=//p" server.env | head -1; }
SECRET_FILE="$ROOT/keys/$(basename "$(val EVIDENCE_STORE_SECRET_PATH)")"
printf 'ROOT_ACCESS_KEY=%s\nROOT_SECRET_KEY=%s\n' "$(val EVIDENCE_STORE_ACCESS_KEY_ID)" \
  "$(tr -d '\n' < "$SECRET_FILE")" > store.env
BUCKET=$(val EVIDENCE_STORE_BUCKET)
mkdir -p "evidence/$BUCKET"
chmod 700 evidence
echo "env written: server.env, store.env (values not printed); bucket directory $BUCKET"

echo "-- build"
$DC build --quiet
echo "-- database and store"
$DC up -d --wait db
$DC up -d store
echo "-- migrations"
$DC run --rm --no-deps api pnpm exec node-pg-migrate --migrations-dir migrations up \
  | grep -E "^(> |### |Migrations complete|No migrations)" || true
echo "-- api, verifier, caddy"
$DC up -d api verifier caddy
sleep 8
$DC ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
echo "-- checks from the server"
printf 'api /health: '; curl -s http://127.0.0.1:3000/health; echo
printf 'store (expect 403): '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7070/
echo "-- last log lines"
$DC logs --tail 15 api verifier
echo "deployed $(cat "$ROOT/src/DEPLOYED_HEAD")"
