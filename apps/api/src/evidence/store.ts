// POLICY.md section 18.4 (D140): the evidence store. Routes see only EvidenceStore; the S3
// implementation serves versitygw in development and R2 in production. Presigned URLs and
// the secret key are never logged (SECURITY.md section 3).
import type { EvidenceStoreConfig } from "../config.ts";
import { objectPath, presignQuery, signHeaders, type SigningKey } from "./sigv4.ts";

export interface PresignedPut {
  readonly url: string;
  /** Exactly the headers the client must add; its HTTP client sets content-length. */
  readonly headers: Record<string, string>;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly byteLength: number;
  readonly sha256Base64: string;
}

export interface EvidenceStore {
  presignPut(key: string, sha256: Uint8Array, byteLength: number, now: Date): PresignedPut;
  /** Null for 404; throws when the store cannot be reached or answers otherwise. */
  head(key: string): Promise<StoredObject | null>;
}

/** Section 18.4's object key, all lowercase. */
export function objectKey(
  bountyId: string,
  sessionId: string,
  requirementId: string,
  sha256Hex: string,
): string {
  return `evidence/${bountyId}/${sessionId}/${requirementId}/${sha256Hex}.jpg`;
}

export function signingKey(config: EvidenceStoreConfig): SigningKey {
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  };
}

export function s3EvidenceStore(
  config: EvidenceStoreConfig,
  uploadUrlTtlS: number,
  fetchFn: typeof fetch,
  now: () => Date = () => new Date(),
): EvidenceStore {
  const key = signingKey(config);
  return {
    presignPut(objectName, sha256, byteLength, at) {
      const checksum = Buffer.from(sha256).toString("base64");
      const path = objectPath(config.bucket, objectName);
      const query = presignQuery({
        method: "PUT",
        host: config.host,
        path,
        headers: { "content-length": String(byteLength), "x-amz-checksum-sha256": checksum },
        expiresS: uploadUrlTtlS,
        now: at,
        key,
      });
      return {
        url: config.endpoint + path + "?" + query,
        headers: { "content-type": "image/jpeg", "x-amz-checksum-sha256": checksum },
        expiresAt: new Date(at.getTime() + uploadUrlTtlS * 1000),
      };
    },
    async head(objectName) {
      const path = objectPath(config.bucket, objectName);
      const headers = signHeaders({
        method: "HEAD",
        host: config.host,
        path,
        headers: { "x-amz-checksum-mode": "ENABLED" },
        body: new Uint8Array(0),
        now: now(),
        key,
      });
      const response = await fetchFn(config.endpoint + path, { method: "HEAD", headers });
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`evidence store HEAD answered ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      const checksum = response.headers.get("x-amz-checksum-sha256");
      if (!Number.isSafeInteger(length) || checksum === null) {
        throw new Error("evidence store HEAD lacked length or checksum");
      }
      return { byteLength: length, sha256Base64: checksum };
    },
  };
}
