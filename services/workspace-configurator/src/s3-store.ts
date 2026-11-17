import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { startupRequest } from "./startup-request.js";
import type { BackupStorageConfig } from "./config.js";
import { ConfiguratorRuntimeError } from "./zammad-client.js";

type StoredObject = {
  objectVersionId: string;
  requestId: string;
};

export class S3BackupStore {
  constructor(
    private readonly config: BackupStorageConfig,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async protectionEvidence() {
    const [versioning, encryption, lifecycle] = await Promise.all([
      this.xmlRequest("GET", "", new URLSearchParams({ versioning: "" })),
      this.config.encryptionMode === "CLIENT_ENVELOPE" ? Promise.resolve(null)
        : this.xmlRequest("GET", "", new URLSearchParams({ encryption: "" })),
      this.xmlRequest("GET", "", new URLSearchParams({ lifecycle: "" })),
    ]);
    if (xmlText(versioning.body, "Status") !== "Enabled") fail("STORAGE_VERSIONING_DISABLED");
    if (this.config.encryptionMode !== "CLIENT_ENVELOPE") {
      if (!encryption || xmlText(encryption.body, "SSEAlgorithm") !== "aws:kms" ||
          xmlText(encryption.body, "KMSMasterKeyID") !== this.config.kmsKeyReference) fail("STORAGE_ENCRYPTION_MISMATCH");
    }
    const ruleIds = xmlTexts(lifecycle.body, "ID");
    if (!ruleIds.includes(this.config.lifecycleRuleId)) fail("STORAGE_LIFECYCLE_MISSING");
    const requestId = [versioning.requestId, encryption?.requestId ?? "", lifecycle.requestId].find((value) => value.length >= 8);
    if (!requestId) fail("STORAGE_REQUEST_ID_MISSING");
    return {
      versioningState: "Enabled" as const,
      lifecycleRuleId: this.config.lifecycleRuleId,
      encryption: this.config.encryptionMode === "CLIENT_ENVELOPE"
        ? { mode: "CLIENT_ENVELOPE" as const, algorithm: "age-x25519", keyReference: `key:${this.config.ageRecipient}` }
        : { mode: "SSE_KMS" as const, algorithm: "aws:kms", keyReference: this.config.kmsKeyReference },
      requestId,
    };
  }

  async putFileAndVerify(objectKey: string, filePath: string, sha256: string, sizeBytes: number): Promise<StoredObject> {
    const stored = await this.put(objectKey, createReadStream(filePath), sha256, sizeBytes, "application/octet-stream");
    await this.verifyReadback(objectKey, stored.objectVersionId, sha256, sizeBytes);
    return stored;
  }

  async putBytesAndVerify(objectKey: string, bytes: Uint8Array, sha256: string): Promise<StoredObject> {
    const stored = await this.put(objectKey, bytes, sha256, bytes.byteLength, "application/json");
    await this.verifyReadback(objectKey, stored.objectVersionId, sha256, bytes.byteLength);
    return stored;
  }

  private async put(
    objectKey: string,
    body: unknown,
    sha256: string,
    sizeBytes: number,
    contentType: string,
  ): Promise<StoredObject> {
    return this.signedRequest("PUT", objectKey, new URLSearchParams(), {
      body,
      payloadSha256: sha256,
      headers: {
        "content-length": String(sizeBytes),
        "content-type": contentType,
        ...(this.config.encryptionMode === "CLIENT_ENVELOPE" ? {} : {
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": this.config.kmsKeyReference,
        }),
      },
    }, async (response) => {
      await boundedBytes(response, 64 * 1_024);
      const objectVersionId = response.headers.get("x-amz-version-id") ?? "";
      const requestId = response.headers.get("x-amz-request-id") ?? response.headers.get("x-minio-deployment-id") ?? "";
      if (!objectVersionId || ["null", "none", "unversioned"].includes(objectVersionId.toLowerCase())) fail("STORAGE_OBJECT_UNVERSIONED");
      if (requestId.length < 8) fail("STORAGE_REQUEST_ID_MISSING");
      return { objectVersionId, requestId };
    });
  }

  private async verifyReadback(objectKey: string, versionId: string, expectedSha256: string, expectedSize: number) {
    await this.signedRequest("GET", objectKey, new URLSearchParams({ versionId }), {
      payloadSha256: emptySha256(),
      headers: {},
    }, async (response) => {
      if (!response.body) fail("STORAGE_READBACK_EMPTY");
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of Readable.fromWeb(response.body as never)) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > expectedSize) fail("STORAGE_READBACK_SIZE_MISMATCH");
        digest.update(bytes);
      }
      if (size !== expectedSize || digest.digest("hex") !== expectedSha256) fail("STORAGE_READBACK_MISMATCH");
      const returnedVersion = response.headers.get("x-amz-version-id");
      if (returnedVersion && returnedVersion !== versionId) fail("STORAGE_READBACK_VERSION_MISMATCH");
    });
  }

  private async xmlRequest(method: "GET", objectKey: string, query: URLSearchParams) {
    return this.signedRequest(method, objectKey, query, { payloadSha256: emptySha256(), headers: {} }, async (response) => {
      const body = new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, 1_048_576));
      return { body, requestId: response.headers.get("x-amz-request-id") ?? response.headers.get("x-minio-deployment-id") ?? "" };
    });
  }

  private async signedRequest<T>(
    method: string,
    objectKey: string,
    query: URLSearchParams,
    options: { payloadSha256: string; headers: Record<string, string>; body?: unknown },
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const date = this.now();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const dateStamp = amzDate.slice(0, 8);
    const path = `/${encodeSegment(this.config.bucket)}${objectKey ? `/${objectKey.split("/").map(encodeSegment).join("/")}` : ""}`;
    const url = new URL(path, this.config.endpoint);
    const entries = [...query.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const canonicalQuery = entries.map(([key, value]) => `${encodeSegment(key)}=${encodeSegment(value)}`).join("&");
    url.search = canonicalQuery;
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": options.payloadSha256,
      "x-amz-date": amzDate,
      ...options.headers,
    };
    const signedHeaderNames = Object.keys(headers).map((value) => value.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/gu, " ")}\n`).join("");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaderNames.join(";"), options.payloadSha256].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, dateStamp, this.config.region))
      .update(stringToSign)
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs * 4);
    try {
      const init = {
        method,
        headers,
        body: options.body as BodyInit | undefined,
        signal: controller.signal,
        redirect: "manual" as const,
        ...(options.body && !(options.body instanceof Uint8Array) ? { duplex: "half" as const } : {}),
      };
      const response = await startupRequest(this.request, url, init as RequestInit);
      if (!response.ok) {
        await boundedDiscard(response);
        fail(response.status >= 500 || response.status === 429 ? "STORAGE_UNAVAILABLE" : "STORAGE_REQUEST_REJECTED");
      }
      return await consume(response);
    } catch (error) {
      if (error instanceof ConfiguratorRuntimeError) throw error;
      fail("STORAGE_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function signingKey(secret: string, date: string, region: string) {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function emptySha256() {
  return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}

function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xmlText(value: string, tag: string) {
  return xmlTexts(value, tag)[0] ?? "";
}

function xmlTexts(value: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...value.matchAll(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${escaped}[^>]*>([^<]*)<\\/(?:[A-Za-z0-9_-]+:)?${escaped}>`, "gu"))]
    .map((match) => decodeXml(match[1] ?? ""));
}

function decodeXml(value: string) {
  return value.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

async function boundedDiscard(response: Response) {
  if (!response.body) return;
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1_024) break;
  }
}

async function boundedBytes(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    void response.body?.cancel().catch(() => undefined);
    fail("STORAGE_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => undefined);
        fail("STORAGE_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function fail(code: string): never {
  throw new ConfiguratorRuntimeError(code);
}
