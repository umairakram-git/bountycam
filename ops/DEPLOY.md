# Deploying BountyCam — S0

**Status:** normative for Session 23 (S0). Written before the first deployment.
**Style:** per D31 — no line exceeds 100 characters.

Rulings: D165. SECURITY.md wins over this document everywhere.

---

## 1. What runs where

| Piece | Where | Reached as |
|---|---|---|
| API (`apps/api`) | the VPS, 127.0.0.1:3000 | `https://api.bountycam.app`, through Caddy |
| Verifier (`src/verifier/main.ts`) | the VPS | nothing reaches it; it reaches out |
| Postgres 16 with PostGIS | the VPS, 127.0.0.1:5432 | the API and the verifier only |
| Evidence store (versitygw) | the VPS, 127.0.0.1:7070 | `https://store.bountycam.app`, Caddy |
| Caddy | the VPS, ports 80 and 443 | the public |
| Arbiter key, `settle.mjs` | the laptop | an SSH tunnel to the VPS's Postgres (section 8) |
| Landing page | Cloudflare Pages (S3) | `https://bountycam.app` |

The VPS: OVHcloud VPS-1, Sydney, Ubuntu 24.04, `51.161.153.97`, user `ubuntu`, key login only,
ufw allowing 22, 80 and 443. DNS at Cloudflare: `api` and `store` are A records to that
address, DNS only (not proxied), so Caddy holds the certificates and uploads go direct.

## 2. Cluster

Devnet, unchanged: the same program, configuration, mint, attester and relayer as the laptop.
The server starts with an empty database at migration 15; bounties in the laptop's database
are not carried over.

## 3. Containers

`ops/deploy/compose.yaml`, project directory `/opt/bountycam`. Every service uses the host's
network, so the API, Postgres and the store keep listening on 127.0.0.1 exactly as on the
laptop, with no code change; only Caddy listens publicly. The API and the verifier share one
image (`ops/deploy/Dockerfile`): Node 22 running the TypeScript sources, pnpm 11.22.0, the
API's workspace dependencies, and `packages/shared` built.

The store runs as root inside its container so that it can write the evidence directory
without matching host user ids; the directory is mode 700 on the host.

## 4. TLS

`ops/deploy/Caddyfile`. Caddy obtains Let's Encrypt certificates for both names over port 80
and passes the client's `Host` header through unchanged: a presigned URL is signed over
`store.bountycam.app`, and the store checks the signature against the `Host` it receives.

## 5. Deploying

`ops/deploy/deploy.sh`, run from the repo root on the laptop with a clean tree:

1. Sends `git archive HEAD` to `/opt/bountycam/src`, keeping the previous tree as `src.old`.
2. Derives `server.env.base` from `~/bountycam-env/api.env`: every `*_PATH` becomes
   `/keys/<file name>`; `EVIDENCE_STORE_ENDPOINT` becomes `https://store.bountycam.app`;
   `DATABASE_URL` is dropped; `ARBITER_KEY_PATH` and its file are never sent.
3. Copies the key files those paths name to `/opt/bountycam/keys`, mode 600.
4. Runs `server-up.sh` on the server: `db.env` is written once with a random password and
   never changed after; `server.env` adds `DATABASE_URL`; `store.env` carries the store's root
   keys; the bucket directory is created; the image is built; Postgres and the store start;
   migrations run; the API, the verifier and Caddy start; `/health` and the store's 403 are
   checked from the server.

Nothing prints a secret, a key or the password. Redeploying is the same command.

## 6. Checks from outside

`ops/deploy/smoke.sh` on the laptop: `/health` over HTTPS; the store answering 403 to an
unsigned request; the certificate issuer; ports 3000, 5432 and 7070 closed from outside.

## 7. The release app

- `app.json`: name **BountyCam**, Android package and iOS bundle id **`app.bountycam`** (D165;
  permanent in the dApp Store).
- `API_BASE_URL` is `EXPO_PUBLIC_API_BASE_URL` when set at bundle time, else the development
  default `http://127.0.0.1:3000`. A release build sets it to `https://api.bountycam.app`.
- Metro caches inlined `EXPO_PUBLIC_*` values: switching between a release build and the
  development server needs `--clear` (`npx expo start --dev-client --clear`), or the dev
  client keeps the other address. Seen in the architect's sandbox.
- The SIWS domain and the app identity are unchanged (AUTH.md 14.2); `SIWS_DOMAIN` on the
  server is the laptop's value.
- The signing key and the build procedure are section 10; the listing is `ops/LISTING.md`.

## 8. The arbiter from the laptop

`settle.mjs` reads `DATABASE_URL` from the laptop's environment. To resolve against the
server, open a tunnel and point a copy of the environment at it; the arbiter key never leaves
the laptop. Written up when the first dispute on the server needs it.

## 9. Stated limits

- One VPS: no replica, no failover. OVHcloud's included daily backup covers the disk.
- The attester and relayer keys (devnet) live on the server, mode 600, read by the verifier.
- `versity/versitygw:latest` and `caddy:2` are not pinned to a digest.
- The deploy and server scripts are not in any gate: the architect's sandbox has no Docker.
  `deploy.sh`'s environment derivation was run there against a fabricated `api.env`.

## 10. The release build (recorded 6 October)

The procedure that produced v1.0.0, from the repo root on the laptop:

1. Signing key, once: `keytool -genkeypair -v -storetype PKCS12 -keystore
   ~/bountycam-keys/bountycam-release.p12 -alias bountycam -keyalg RSA -keysize 4096 -validity
   10000 -dname "CN=Umair Akram, O=BountyCam, C=AU"`, mode 600, backed up offline with its
   password. Certificate SHA-256 `cb6d8678d485c9d1a812fa138cf39109033a4f85c4684f8bd8463d4b6f04fa38`,
   valid to 2054. Every update must be signed with this key.
2. `cd apps/mobile && npx expo prebuild --platform android --clean` (namespace and applicationId
   `app.bountycam`).
3. Clear Metro's cache: `rm -rf "${TMPDIR%/}"/metro-cache "${TMPDIR%/}"/metro-file-map-*`.
4. `cd apps/mobile/android && EXPO_PUBLIC_API_BASE_URL=https://api.bountycam.app ./gradlew
   assembleRelease` (2 m 54 s on first run; build tools 36.0.0).
5. Check the bundle: `assets/index.android.bundle` holds `api.bountycam.app` once and
   `127.0.0.1:3000` never.
6. Sign: `apksigner sign --ks ~/bountycam-keys/bountycam-release.p12 --ks-key-alias bountycam
   --out ~/bountycam-release/bountycam-1.0.0.apk app-release.apk`; verify with `apksigner verify
   --print-certs` and `aapt2 dump badging`.

v1.0.0: versionCode 1, 90.98 MB, sha256
`8f6d6cfac27a74af845699ded040b997fe1af497905370fc1529000abd4b7417`. The size is four processor
architectures; an arm64-only build would be about a third of it (BACKLOG).
