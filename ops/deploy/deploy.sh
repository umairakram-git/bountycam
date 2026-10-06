#!/bin/sh
# ops/DEPLOY.md section 5: deploy HEAD to the server. Run from the repo root on the laptop:
#   ops/deploy/deploy.sh
# Sends a git archive of HEAD (never the working tree), the server environment derived from
# ~/bountycam-env/api.env, and the five key files the API and the verifier read. The arbiter
# key is never sent. Prints no secret, key or password.
set -eu

HOST="ubuntu@51.161.153.97"
ENV_FILE="$HOME/bountycam-env/api.env"
ROOT=/opt/bountycam

[ -f ops/deploy/compose.yaml ] || { echo "run from the repo root" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
[ "$(stat -f '%OLp' "$ENV_FILE")" = "600" ] || { echo "$ENV_FILE must be mode 600" >&2; exit 1; }

STAGE=$(mktemp -d)
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/keys"

# server.env.base: api.env with every *_PATH pointing at /keys/<file name>, the store at its
# public HTTPS name, and DATABASE_URL left out (server-up.sh writes it from db.env). Each key
# file named by a *_PATH line is staged under its own name, mode 600.
python3 - "$ENV_FILE" "$STAGE" << 'PY'
import os, re, shutil, sys
env_file, stage = sys.argv[1], sys.argv[2]
out, names = [], set()
for line in open(env_file):
    m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
    if not m:
        continue
    k, v = m.group(1), m.group(2).strip("'\"")
    if k == "DATABASE_URL":
        continue
    if k.endswith("_PATH"):
        if k == "ARBITER_KEY_PATH":
            continue
        src = os.path.expanduser(os.path.expandvars(v))
        name = os.path.basename(src)
        if name in names:
            sys.exit(f"two key files share the name {name}")
        names.add(name)
        dst = os.path.join(stage, "keys", name)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        v = "/keys/" + name
    if k == "EVIDENCE_STORE_ENDPOINT":
        v = "https://store.bountycam.app"
    out.append(f"{k}={v}")
path = os.path.join(stage, "server.env.base")
with open(path, "w") as f:
    f.write("\n".join(out) + "\n")
os.chmod(path, 0o600)
print("keys staged: " + ", ".join(sorted(names)))
PY

HEAD=$(git rev-parse --short HEAD)
echo "deploying $HEAD to $HOST:$ROOT"
ssh "$HOST" "sudo mkdir -p $ROOT && sudo chown ubuntu:ubuntu $ROOT && chmod 700 $ROOT \
  && mkdir -p $ROOT/keys && chmod 700 $ROOT/keys && rm -rf $ROOT/src.new && mkdir $ROOT/src.new"
git archive --format=tar HEAD | ssh "$HOST" "tar -x -C $ROOT/src.new \
  && rm -rf $ROOT/src.old && { [ ! -d $ROOT/src ] || mv $ROOT/src $ROOT/src.old; } \
  && mv $ROOT/src.new $ROOT/src && echo $HEAD > $ROOT/src/DEPLOYED_HEAD"
scp -q -p "$STAGE/server.env.base" "$HOST:$ROOT/server.env.base"
scp -q -p "$STAGE"/keys/* "$HOST:$ROOT/keys/"
ssh "$HOST" "chmod 600 $ROOT/server.env.base $ROOT/keys/* && sh $ROOT/src/ops/deploy/server-up.sh"
