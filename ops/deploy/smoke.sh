#!/bin/sh
# ops/DEPLOY.md section 6: checks from outside, run on the laptop after deploy.sh.
set -u
printf 'api health:  '; curl -sS --max-time 15 https://api.bountycam.app/health; echo
printf 'store (403): '; curl -sS --max-time 15 -o /dev/null -w '%{http_code}\n' https://store.bountycam.app/
printf 'api cert:    '; curl -sSv --max-time 15 -o /dev/null https://api.bountycam.app/health 2>&1 \
  | sed -n 's/^\*  issuer: //p'
printf 'not public:  '; for p in 3000 5432 7070; do
  if nc -z -G 5 51.161.153.97 $p 2>/dev/null; then printf '%s OPEN ' $p; else printf '%s closed ' $p; fi
done; echo
