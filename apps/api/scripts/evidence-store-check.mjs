// POLICY.md section 18.10 (D139, D140): creates the evidence bucket if absent,
// then runs the spike's nine storage checks through src/evidence against the
// configured store. Run by hand from apps/api; not in the gate. Reads
// ~/bountycam-env/api.env itself. Prints no URL and no key.
//
//   node scripts/evidence-store-check.mjs
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEvidenceConfig } from "../src/config.ts";
import { objectPath, presignQuery, signHeaders } from "../src/evidence/sigv4.ts";
import { s3EvidenceStore, signingKey } from "../src/evidence/store.ts";

function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const config = loadEvidenceConfig({ ...readEnvFile(join(homedir(), "bountycam-env", "api.env")) });
if (config.store === null) {
  console.log("FAIL the evidence store is not configured in ~/bountycam-env/api.env");
  process.exit(1);
}
const cfg = config.store;
const key = signingKey(cfg);
const store = s3EvidenceStore(cfg, config.uploadUrlTtlS, fetch);
const sha = (b) => createHash("sha256").update(b).digest();

async function signed(method, path, extra = {}) {
  const headers = signHeaders({
    method, host: cfg.host, path, headers: extra, body: new Uint8Array(0), now: new Date(), key,
  });
  return fetch(cfg.endpoint + path, { method, headers });
}

const bucket = await signed("PUT", "/" + cfg.bucket);
if (bucket.status !== 200 && bucket.status !== 409) {
  console.log(`FAIL bucket ${cfg.bucket}: status ${bucket.status}`);
  process.exit(1);
}
console.log(`bucket ${cfg.bucket}: ${bucket.status === 200 ? "created" : "present"}`);

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -- ${detail}`);
};
const put = (objectName, digestOf, length, body, now = new Date(), withChecksum = true) => {
  const p = store.presignPut(objectName, sha(digestOf), length, now);
  const headers = withChecksum ? p.headers : { "content-type": "image/jpeg" };
  return fetch(p.url, { method: "PUT", body, headers });
};

const good = randomBytes(300000);
const name = "check/" + sha(good).toString("hex") + ".jpg";
let r = await put(name, good, good.length, good);
check("S1 correct bytes are stored", r.status === 200, `status ${r.status}`);
const head = await store.head(name);
check("S2 HEAD reports length and sha256", head !== null && head.byteLength === good.length &&
  head.sha256Base64 === sha(good).toString("base64"), JSON.stringify(head));
const wrong = Buffer.from(good);
wrong[0] ^= 1;
r = await put("check/wrong.jpg", good, good.length, wrong);
const refused = (status) => status >= 400 && status < 500;
check("S3 wrong bytes, same length, refused", refused(r.status), `status ${r.status}`);
check("S3b nothing stored for them", (await store.head("check/wrong.jpg")) === null, "HEAD");
r = await put("check/longer.jpg", good, good.length, Buffer.concat([good, Buffer.from([0])]));
check("S4 a different length refused", refused(r.status), `status ${r.status}`);
r = await put("check/nochecksum.jpg", good, good.length, good, new Date(), false);
check("S5 no checksum header refused", refused(r.status), `status ${r.status}`);
r = await fetch(cfg.endpoint + objectPath(cfg.bucket, name));
check("S6 anonymous GET refused", r.status === 403, `status ${r.status}`);
r = await put("check/expired.jpg", good, good.length, good, new Date(Date.now() - 1_200_000));
check("S7 an expired URL refused", r.status === 403, `status ${r.status}`);
const getPath = objectPath(cfg.bucket, name);
const getQuery = presignQuery({
  method: "GET", host: cfg.host, path: getPath, headers: {}, expiresS: 60, now: new Date(), key,
});
r = await fetch(cfg.endpoint + getPath + "?" + getQuery);
const back = Buffer.from(await r.arrayBuffer());
check("S8 a presigned GET returns the bytes", r.status === 200 && back.equals(good),
  `status ${r.status}`);
r = await put(name, good, good.length, good);
check("S9 the same key again (a retry) succeeds", r.status === 200, `status ${r.status}`);

const passed = results.filter(Boolean).length;
console.log(`EVIDENCE STORE CHECK: ${passed} of ${results.length} passed`);
process.exitCode = passed === results.length ? 0 : 1;
