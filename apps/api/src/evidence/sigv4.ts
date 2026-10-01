// POLICY.md section 18.4 (D140): AWS Signature Version 4 for the evidence store, in query
// form for presigned URLs and in header form for the API's own HEAD and the scripts' bucket
// setup. No SDK: one request shape each, pinned by AWS's published query-signing example
// (evidence test 25) and checked against versitygw by the D139 run.
import { createHash, createHmac } from "node:crypto";

export interface SigningKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 unreserved characters stay; everything else is percent-encoded, upper hex. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** A path-style object path, each segment encoded: `/<bucket>/<key>`. */
export function objectPath(bucket: string, key: string): string {
  return "/" + [bucket, ...key.split("/")].map(uriEncode).join("/");
}

function stamp(now: Date): { amzDate: string; day: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function scope(day: string, key: SigningKey): string {
  return `${day}/${key.region}/${SERVICE}/aws4_request`;
}

function signature(key: SigningKey, day: string, stringToSign: string): string {
  const kDate = hmac("AWS4" + key.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, key.region), SERVICE), "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex");
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => uriEncode(k) + "=" + uriEncode(query[k] as string))
    .join("&");
}

function canonicalHeaders(headers: Record<string, string>): { text: string; names: string } {
  const names = Object.keys(headers).sort();
  return {
    text: names.map((n) => n + ":" + (headers[n] as string).trim() + "\n").join(""),
    names: names.join(";"),
  };
}

export interface PresignInput {
  readonly method: string;
  readonly host: string;
  /** Already encoded, as `objectPath` returns it. */
  readonly path: string;
  /** Lowercase names, host excluded; every one is signed. */
  readonly headers: Record<string, string>;
  readonly expiresS: number;
  readonly now: Date;
  readonly key: SigningKey;
}

/** The query string of a presigned URL, `X-Amz-Signature` last. */
export function presignQuery(input: PresignInput): string {
  const { amzDate, day } = stamp(input.now);
  const headers = { host: input.host, ...input.headers };
  const canon = canonicalHeaders(headers);
  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${input.key.accessKeyId}/${scope(day, input.key)}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresS),
    "X-Amz-SignedHeaders": canon.names,
  };
  const request = [input.method, input.path, canonicalQuery(query), canon.text, canon.names,
    "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = [ALGORITHM, amzDate, scope(day, input.key), sha256Hex(request)].join("\n");
  return canonicalQuery(query) + "&X-Amz-Signature=" + signature(input.key, day, toSign);
}

export interface HeaderSignInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** Lowercase names, host excluded. */
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
  readonly now: Date;
  readonly key: SigningKey;
}

/** The headers to send, `authorization` included, for a header-signed request. */
export function signHeaders(input: HeaderSignInput): Record<string, string> {
  const { amzDate, day } = stamp(input.now);
  const payload = sha256Hex(input.body);
  const send = { ...input.headers, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const canon = canonicalHeaders({ host: input.host, ...send });
  const request = [input.method, input.path, "", canon.text, canon.names, payload].join("\n");
  const toSign = [ALGORITHM, amzDate, scope(day, input.key), sha256Hex(request)].join("\n");
  const auth = `${ALGORITHM} Credential=${input.key.accessKeyId}/${scope(day, input.key)}, ` +
    `SignedHeaders=${canon.names}, Signature=${signature(input.key, day, toSign)}`;
  return { ...send, authorization: auth };
}
