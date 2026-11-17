import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import type { ProviderMessage } from "../../../packages/connectors/src/types.js";
import {
  MediaService,
  MediaValidationError,
  maximumMediaBytes,
  normalizeMediaMime,
  safeMediaFilename,
  type MediaRecord,
  type MediaRepository,
  type MediaScanner,
  type MediaStorage,
} from "../../../packages/core/src/media.js";
import { ZammadClient, ZammadError, type ZammadAttachment } from "../../../packages/zammad/src/client.js";
import type { SecretResolver } from "./secrets.js";
import type { DeliveryJob } from "./types.js";

export type InboundMediaInput = {
  tenantId: string;
  connectionId: string;
  provider: "waha" | "meta";
  connectionSecretReference: string;
  providerBaseUrl?: string;
  providerSessionId: string;
  beforeMetaRequest?: (accessToken: string) => Promise<void>;
  retentionDays: number;
  media: NonNullable<ProviderMessage["media"]>;
};

export type PreparedInboundMedia = {
  attachment: ZammadAttachment;
  mediaObjectId: string;
  deduplicated: boolean;
};

export interface InboundMediaPipeline {
  prepare(input: InboundMediaInput): Promise<PreparedInboundMedia>;
}

export type PreparedOutboundMedia = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  mediaObjectId: string;
  newlyLinked: boolean;
  cleanupSource?: () => Promise<void>;
};

export interface OutboundMediaPipeline {
  prepare(job: DeliveryJob, zammadToken: string, beforeRequest?: () => Promise<void>): Promise<PreparedOutboundMedia>;
}

export type BotMediaUpload={tenantId:string;assetId:string;bytes:Uint8Array};
export interface BotMediaUploadRepository extends MediaRepository{
  mediaAssetUpload(tenantId:string,assetId:string):Promise<{filename:string;mimeType:string;byteSize:number;retentionDays:number;contentSha256:string}>;
  completeMediaAssetUpload(tenantId:string,assetId:string,mediaObjectId:string):Promise<void>;
  failMediaAssetUpload(tenantId:string,assetId:string,safeError:string):Promise<void>;
}

export class DefaultBotMediaUploadPipeline{
  private readonly media:MediaService;
  constructor(scanner:MediaScanner,storage:MediaStorage,private readonly repository:BotMediaUploadRepository){this.media=new MediaService(scanner,storage,repository)}
  async upload(input:BotMediaUpload){
    const descriptor=await this.repository.mediaAssetUpload(input.tenantId,input.assetId);
    if(input.bytes.length!==descriptor.byteSize)throw new MediaValidationError("Uploaded media size does not match its descriptor","INVALID_SIZE");
    try{
      if(hashHex(input.bytes)!==descriptor.contentSha256)throw new MediaValidationError("Uploaded media content does not match its declared digest","MEDIA_DIGEST_MISMATCH");
      const result=await this.media.ingest({tenantId:input.tenantId,bytes:input.bytes,declaredMime:descriptor.mimeType,filename:descriptor.filename,retentionDays:descriptor.retentionDays,issueSignedUrl:false});
      if(result.record.sha256!==descriptor.contentSha256)throw new MediaValidationError("Uploaded media content does not match its declared digest","MEDIA_DIGEST_MISMATCH");
      await this.repository.completeMediaAssetUpload(input.tenantId,input.assetId,result.record.id);
      return{assetId:input.assetId,state:"READY" as const};
    }catch(error){if(error instanceof MediaValidationError&&!error.retryable)await this.repository.failMediaAssetUpload(input.tenantId,input.assetId,error.message);throw error}
  }
}

export class MediaRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly quarantine = !retryable,
  ) {
    super(message);
    this.name = "MediaRuntimeError";
  }
}

type DownloadedMedia = { bytes: Uint8Array; mimeType: string; filename: string };

const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const META_MEDIA_CDN_ORIGIN = "https://lookaside.fbsbx.com";
const META_GRAPH_VERSION = /^v\d{1,3}\.\d{1,3}$/u;
const META_MEDIA_ID = /^[A-Za-z0-9_-]{1,510}={0,2}$/u;
const META_PHONE_NUMBER_ID = /^\d{1,32}$/u;
const META_MEDIA_REFERENCE = /^meta-media:\/\/([A-Za-z0-9_-]{1,510}={0,2})$/u;
const META_MEDIA_SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;
const META_MEDIA_SHA256_HEX = /^[0-9a-f]{64}$/iu;
const MAX_META_LOOKUP_BYTES = 32_768;

export class WahaMediaDownloader {
  private readonly baseUrl?: URL;

  constructor(baseUrl?: string, private readonly timeoutMs = 20_000) {
    this.baseUrl = baseUrl ? validatedPrivateWahaEndpoint(baseUrl) : undefined;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("WAHA media timeout is invalid");
  }

  async download(media: NonNullable<ProviderMessage["media"]>, apiKey: string, expectedSessionId: string, providerBaseUrl?: string): Promise<DownloadedMedia> {
    const declaredMime = normalizeMediaMime(media.mimeType ?? "");
    const maximum = maximumMediaBytes(declaredMime);
    if (!maximum) throw new MediaRuntimeError("The provider media type is unsupported", "UNSUPPORTED_MIME", false);
    if (!media.url) throw new MediaRuntimeError("The provider did not make media available for download", "MEDIA_URL_MISSING", false);
    if (!apiKey || apiKey.length > 4_096) throw new MediaRuntimeError("WAHA media credentials are unavailable", "WAHA_SECRET_INVALID", false);
    if (!expectedSessionId || expectedSessionId.length > 512) throw new MediaRuntimeError("WAHA session identity is unavailable", "WAHA_SESSION_INVALID", false);

    const baseUrl = providerBaseUrl ? validatedPrivateWahaEndpoint(providerBaseUrl) : this.baseUrl;
    if (!baseUrl) throw new MediaRuntimeError("WAHA worker assignment is unavailable", "WAHA_WORKER_UNAVAILABLE", true, false);
    const url = this.validatedMediaUrl(media.url, expectedSessionId, baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "x-api-key": apiKey, accept: declaredMime },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new MediaRuntimeError("WAHA media redirects are not accepted", "WAHA_MEDIA_REDIRECT", false);
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new MediaRuntimeError("WAHA media download failed", "WAHA_MEDIA_HTTP", retryable);
      }

      const responseMime = normalizeMediaMime(response.headers.get("content-type") ?? "");
      if (responseMime && responseMime !== "application/octet-stream" && responseMime !== declaredMime) {
        throw new MediaRuntimeError("WAHA media response type does not match the event", "WAHA_MEDIA_TYPE_MISMATCH", false);
      }
      const lengthHeader = response.headers.get("content-length");
      if (lengthHeader) {
        const length = Number(lengthHeader);
        if (!Number.isSafeInteger(length) || length < 1 || length > maximum) {
          throw new MediaRuntimeError("WAHA media size is outside the allowed range", "WAHA_MEDIA_SIZE", false);
        }
      }
      if (!response.body) throw new MediaRuntimeError("WAHA media response was empty", "WAHA_MEDIA_EMPTY", true, false);
      const bytes = await boundedBody(response.body, maximum);
      return {
        bytes,
        mimeType: declaredMime,
        filename: safeMediaFilename(media.fileName ?? defaultFilename(media.type, declaredMime)),
      };
    } catch (error) {
      if (error instanceof MediaRuntimeError) throw error;
      throw new MediaRuntimeError("WAHA media download timed out or the network was unavailable", "WAHA_MEDIA_NETWORK", true, false);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validatedMediaUrl(raw: string, expectedSessionId: string, baseUrl: URL) {
    if (raw.length > 8_192) throw new MediaRuntimeError("WAHA media URL is invalid", "WAHA_MEDIA_URL_INVALID", false);
    let value: URL;
    try {
      value = new URL(raw, baseUrl);
    } catch {
      throw new MediaRuntimeError("WAHA media URL is invalid", "WAHA_MEDIA_URL_INVALID", false);
    }
    if (value.username || value.password || value.hash) {
      throw new MediaRuntimeError("WAHA media URL is outside the private provider endpoint", "WAHA_MEDIA_ORIGIN", false);
    }
    if (value.origin !== baseUrl.origin) {
      const loopbackProxy = isLoopbackHost(value.hostname)
        && value.protocol === baseUrl.protocol
        && effectivePort(value) === effectivePort(baseUrl)
        && value.pathname.startsWith("/api/s3/");
      if (!loopbackProxy) {
        throw new MediaRuntimeError("WAHA media URL is outside the private provider endpoint", "WAHA_MEDIA_ORIGIN", false);
      }
      // GOWS emits its authenticated S3 proxy as localhost because the URL is
      // constructed inside the WAHA container. Route that one exact proxy path
      // through the already validated private worker origin; never follow the
      // public upstream media URL or accept an arbitrary loopback path.
      value = new URL(`${value.pathname}${value.search}`, baseUrl);
    }
    for (const key of value.searchParams.keys()) {
      if (/(?:api.?key|access.?token|authorization|secret|password)/i.test(key)) {
        throw new MediaRuntimeError("Credentials are not accepted in WAHA media URLs", "WAHA_MEDIA_URL_CREDENTIAL", false);
      }
    }
    const session = value.searchParams.get("session");
    if (session && session !== expectedSessionId) {
      throw new MediaRuntimeError("WAHA media URL belongs to another session", "WAHA_MEDIA_SESSION_MISMATCH", false);
    }
    return value;
  }
}

type MetaMediaMetadata = {
  id?: unknown;
  messaging_product?: unknown;
  url?: unknown;
  mime_type?: unknown;
  sha256?: unknown;
  file_size?: unknown;
};

/**
 * Resolves an opaque WhatsApp media ID through Meta's authenticated Graph API
 * and downloads the bytes without ever turning the provider URL into a public
 * or tenant-visible capability. Both requests are pinned to the official Graph
 * origin and reject redirects so bearer credentials cannot cross an origin.
 */
export class MetaMediaDownloader {
  private readonly graphVersion: string;
  private readonly timeoutMs: number;
  private readonly graphOrigin = new URL(META_GRAPH_ORIGIN);

  constructor(graphVersion: string, timeoutMs = 20_000) {
    if (!META_GRAPH_VERSION.test(graphVersion)) throw new Error("Meta Graph version is invalid");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("Meta media timeout is invalid");
    this.graphVersion = graphVersion;
    this.timeoutMs = timeoutMs;
  }

  async download(
    media: NonNullable<ProviderMessage["media"]>,
    accessToken: string,
    expectedPhoneNumberId: string,
    beforeRequest?: () => Promise<void>,
  ): Promise<DownloadedMedia> {
    const mediaId = metaMediaId(media.url);
    const declaredMime = normalizeMediaMime(media.mimeType ?? "");
    const maximum = maximumMediaBytes(declaredMime);
    if (!maximum) throw new MediaRuntimeError("The provider media type is unsupported", "UNSUPPORTED_MIME", false);
    if (!accessToken || accessToken.length > 4_096 || hasUnsafeSecretCharacter(accessToken)) {
      throw new MediaRuntimeError("Meta media credentials are unavailable", "META_SECRET_INVALID", false, false);
    }
    if (!META_PHONE_NUMBER_ID.test(expectedPhoneNumberId)) {
      throw new MediaRuntimeError("Meta phone-number identity is unavailable", "META_PHONE_NUMBER_INVALID", false, false);
    }

    const metadata = await this.lookup(mediaId, accessToken, expectedPhoneNumberId, beforeRequest);
    const responseMime = normalizeMediaMime(metaMetadataString(metadata.mime_type, 256, "META_MEDIA_METADATA"));
    if (responseMime !== declaredMime) {
      throw new MediaRuntimeError("Meta media metadata type does not match the event", "META_MEDIA_TYPE_MISMATCH", false);
    }
    const maximumFromMetadata = maximumMediaBytes(responseMime);
    if (!maximumFromMetadata) throw new MediaRuntimeError("The provider media type is unsupported", "UNSUPPORTED_MIME", false);
    const expectedSize = metaMediaSize(metadata.file_size, maximumFromMetadata);
    const expectedSha256 = metaSha256Hex(metadata.sha256);
    if (metadata.id !== mediaId || metadata.messaging_product !== "whatsapp") {
      throw new MediaRuntimeError("Meta returned metadata for a different media object", "META_MEDIA_METADATA", true, false);
    }
    const downloadUrl = this.validatedDownloadUrl(metaMetadataString(metadata.url, 8_192, "META_MEDIA_METADATA"));
    const bytes = await this.downloadBytes(downloadUrl, accessToken, responseMime, expectedSize, maximumFromMetadata, beforeRequest);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new MediaRuntimeError("Meta media integrity validation failed", "META_MEDIA_INTEGRITY", false);
    }
    return {
      bytes,
      mimeType: responseMime,
      filename: safeMediaFilename(media.fileName ?? defaultFilename(media.type, responseMime)),
    };
  }

  private async lookup(mediaId: string, accessToken: string, expectedPhoneNumberId: string, beforeRequest?: () => Promise<void>): Promise<MetaMediaMetadata> {
    const url = new URL(`/${this.graphVersion}/${encodeURIComponent(mediaId)}`, this.graphOrigin);
    // Meta documents phone_number_id as an ownership check for media lookup.
    // Using the connection's immutable provider-session identity prevents a
    // broader WABA token from retrieving media for a different number.
    url.searchParams.set("phone_number_id", expectedPhoneNumberId);
    let response = await this.request(url, accessToken, "application/json", "META_MEDIA_LOOKUP_NETWORK", false, beforeRequest);
    // Meta documents phone_number_id as optional. Forwarded stickers can fail
    // that ownership check even though their opaque ID came from our signed,
    // connection-routed webhook, so retry the same authenticated Graph lookup
    // once without the optional check before treating the token as invalid.
    if (response.status === 401 || response.status === 403) {
      url.searchParams.delete("phone_number_id");
      response = await this.request(url, accessToken, "application/json", "META_MEDIA_LOOKUP_NETWORK", false, beforeRequest);
    }
    if (!response.ok) throw metaMediaHttpError(response.status, "lookup");
    const responseMime = normalizeMediaMime(response.headers.get("content-type") ?? "");
    if (responseMime !== "application/json") {
      throw new MediaRuntimeError("Meta returned an invalid media lookup response", "META_MEDIA_METADATA", true, false);
    }
    const bytes = await boundedMetaBody(response.body, MAX_META_LOOKUP_BYTES, "META_MEDIA_METADATA", true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new MediaRuntimeError("Meta returned an invalid media lookup response", "META_MEDIA_METADATA", true, false);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MediaRuntimeError("Meta returned an invalid media lookup response", "META_MEDIA_METADATA", true, false);
    }
    return parsed as MetaMediaMetadata;
  }

  private async downloadBytes(url: URL, accessToken: string, expectedMime: string, expectedSize: number, maximum: number, beforeRequest?: () => Promise<void>) {
    const response = await this.request(url, accessToken, expectedMime, "META_MEDIA_NETWORK", true, beforeRequest);
    if (!response.ok) throw metaMediaHttpError(response.status, "download");
    const responseMime = normalizeMediaMime(response.headers.get("content-type") ?? "");
    if (responseMime !== expectedMime) {
      throw new MediaRuntimeError("Meta media response type does not match its metadata", "META_MEDIA_TYPE_MISMATCH", false);
    }
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null) {
      const declaredLength = Number(lengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength !== expectedSize || declaredLength > maximum) {
        throw new MediaRuntimeError("Meta media size does not match its metadata", "META_MEDIA_SIZE", false);
      }
    }
    const bytes = await boundedMetaBody(response.body, maximum, "META_MEDIA_SIZE", false);
    if (bytes.length !== expectedSize) {
      throw new MediaRuntimeError("Meta media size does not match its metadata", "META_MEDIA_SIZE", false);
    }
    return bytes;
  }

  private async request(url: URL, accessToken: string, accept: string, networkCode: string, mediaDownload = false, beforeRequest?: () => Promise<void>) {
    const expectedOrigin = mediaDownload ? [this.graphOrigin.origin, META_MEDIA_CDN_ORIGIN].includes(url.origin) : url.origin === this.graphOrigin.origin;
    if (!expectedOrigin || url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new MediaRuntimeError("Meta media URL is outside the trusted Graph origin", "META_MEDIA_ORIGIN", false);
    }
    await beforeRequest?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: `Bearer ${accessToken}`, accept },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new MediaRuntimeError("Meta media redirects are not accepted", "META_MEDIA_REDIRECT", false);
      }
      return response;
    } catch (error) {
      if (error instanceof MediaRuntimeError) throw error;
      throw new MediaRuntimeError("Meta media request timed out or the network was unavailable", networkCode, true, false);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validatedDownloadUrl(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new MediaRuntimeError("Meta returned an invalid media URL", "META_MEDIA_ORIGIN", false);
    }
    if (![this.graphOrigin.origin, META_MEDIA_CDN_ORIGIN].includes(url.origin) || url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new MediaRuntimeError("Meta media URL is outside the trusted Graph origin", "META_MEDIA_ORIGIN", false);
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:access.?token|authorization|secret|password)/i.test(key)) {
        throw new MediaRuntimeError("Credentials are not accepted in Meta media URLs", "META_MEDIA_URL_CREDENTIAL", false);
      }
    }
    return url;
  }
}

async function boundedBody(stream: ReadableStream<Uint8Array>, maximum: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maximum) {
        await reader.cancel();
        throw new MediaRuntimeError("WAHA media size is outside the allowed range", "WAHA_MEDIA_SIZE", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new MediaRuntimeError("WAHA media response was empty", "WAHA_MEDIA_EMPTY", true, false);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class ClamAvMediaScanner implements MediaScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 20_000,
  ) {
    if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error("ClamAV host is invalid");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("ClamAV port is invalid");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("ClamAV timeout is invalid");
  }

  async scan(bytes: Uint8Array, mimeType: string) {
    void mimeType;
    try {
      const response = await this.exchange(bytes);
      return parseClamAvResponse(response);
    } catch {
      return { state: "ERROR" as const, engine: "clamav" };
    }
  }

  private exchange(bytes: Uint8Array) {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let response = "";
      const socket = createConnection({ host: this.host, port: this.port });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(response.replaceAll("\0", "").trim());
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error("ClamAV timeout")));
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk: Buffer) => {
        response += new TextDecoder().decode(chunk);
        if (response.length > 8_192) finish(new Error("ClamAV response is too large"));
      });
      socket.once("end", () => finish());
      socket.once("connect", () => writeClamStream(socket, bytes));
    });
  }
}

function writeClamStream(socket: Socket, bytes: Uint8Array) {
  for (const frame of clamAvInstreamFrames(bytes)) socket.write(frame);
  socket.end();
}

export function clamAvInstreamFrames(bytes: Uint8Array) {
  const frames: Uint8Array[] = [Buffer.from("zINSTREAM\0")];
  for (let offset = 0; offset < bytes.length; offset += 64 * 1_024) {
    const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1_024, bytes.length));
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32BE(chunk.length);
    frames.push(size, chunk);
  }
  frames.push(Buffer.alloc(4));
  return frames;
}

export function parseClamAvResponse(response: string) {
  const normalized = response.replaceAll("\0", "").trim();
  if (/\bOK\s*$/i.test(normalized)) return { state: "CLEAN" as const, engine: "clamav" };
  const infected = normalized.match(/:\s*(.+?)\s+FOUND\s*$/i);
  if (infected) return { state: "INFECTED" as const, engine: "clamav", signature: safeSignature(infected[1] ?? "detected") };
  return { state: "ERROR" as const, engine: "clamav" };
}

function safeSignature(value: string) {
  return value.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
}

function isLocalEnvironment(value?: string) {
  return value === "local" || value === "local-full" || value === "development" || value === "test";
}

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  serverSideEncryption?: "AES256" | "aws:kms" | "MANAGED" | "NONE";
  kmsKeyId?: string;
  environment?: string;
  timeoutMs?: number;
};

export class S3MediaStorage implements MediaStorage {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly serverSideEncryption: "AES256" | "aws:kms" | "MANAGED" | "NONE";

  constructor(private readonly config: S3Config) {
    this.endpoint = validatedEndpoint(config.endpoint, "S3 endpoint");
    if (!isLocalEnvironment(config.environment) && this.endpoint.protocol !== "https:") {
      throw new Error("S3 media storage must use HTTPS outside local environments");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error("S3 bucket is invalid");
    if (!/^[a-z0-9-]{1,63}$/.test(config.region)) throw new Error("S3 region is invalid");
    if (!config.accessKeyId || config.accessKeyId.length > 256 || !config.secretAccessKey || config.secretAccessKey.length > 4_096) {
      throw new Error("S3 credentials are invalid");
    }
    this.serverSideEncryption = config.serverSideEncryption ?? "AES256";
    if (!["AES256", "aws:kms", "MANAGED", "NONE"].includes(this.serverSideEncryption)) {
      throw new Error("S3 server-side encryption mode is invalid");
    }
    if (this.serverSideEncryption === "NONE" && !isLocalEnvironment(config.environment)) {
      throw new Error("Unencrypted S3 media storage is allowed only in a local environment");
    }
    if (this.serverSideEncryption === "aws:kms" && (!config.kmsKeyId || !/^[A-Za-z0-9:/_-]{1,2048}$/u.test(config.kmsKeyId))) {
      throw new Error("S3 KMS key identifier is required for KMS encryption");
    }
    if (this.serverSideEncryption !== "aws:kms" && config.kmsKeyId) {
      throw new Error("S3 KMS key identifier requires KMS encryption");
    }
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error("S3 media timeout is invalid");
    }
  }

  async put(key: string, bytes: Uint8Array, metadata: Record<string, string>) {
    const url = this.objectUrl(key);
    const payloadHash = hashHex(bytes);
    const { amzDate, dateStamp } = awsTime(new Date());
    const headers: Record<string, string> = {
      "content-type": normalizeMediaMime(metadata.mime_type ?? "") || "application/octet-stream",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (!["NONE", "MANAGED"].includes(this.serverSideEncryption)) headers["x-amz-server-side-encryption"] = this.serverSideEncryption;
    if (this.serverSideEncryption === "aws:kms") {
      headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.config.kmsKeyId!;
    }
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
      const name = rawKey.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
      if (name) headers[`x-amz-meta-${name}`] = asciiMetadata(rawValue);
    }
    const signed = signedHeaders(url, headers);
    const canonicalRequest = ["PUT", url.pathname, "", signed.canonical, signed.names, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
    const signature = hmacHex(signingKey(this.config.secretAccessKey, dateStamp, this.config.region), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed.names}, Signature=${signature}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "PUT", headers, body: Uint8Array.from(bytes).buffer, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new MediaRuntimeError("Private media storage rejected the object", "MEDIA_STORAGE_HTTP", retryable, !retryable);
      }
    } catch (error) {
      if (error instanceof MediaRuntimeError) throw error;
      throw new MediaRuntimeError("Private media storage timed out or was unavailable", "MEDIA_STORAGE_NETWORK", true, false);
    } finally {
      // Cleanup must not extend the request deadline if cancellation stalls.
      void response?.body?.cancel().catch(() => undefined);
      clearTimeout(timeout);
    }
  }

  async delete(key: string) {
    const url = this.objectUrl(key);
    const payloadHash = hashHex(new Uint8Array());
    const { amzDate, dateStamp } = awsTime(new Date());
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signed = signedHeaders(url, headers);
    const canonicalRequest = ["DELETE", url.pathname, "", signed.canonical, signed.names, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
    const signature = hmacHex(signingKey(this.config.secretAccessKey, dateStamp, this.config.region), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed.names}, Signature=${signature}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "DELETE", headers, redirect: "error", signal: controller.signal });
      if (response.status === 404) return;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new MediaRuntimeError("Private media storage rejected object deletion", "MEDIA_STORAGE_DELETE_HTTP", retryable, !retryable);
      }
    } catch (error) {
      if (error instanceof MediaRuntimeError) throw error;
      throw new MediaRuntimeError("Private media storage deletion timed out or was unavailable", "MEDIA_STORAGE_DELETE_NETWORK", true, false);
    } finally {
      void response?.body?.cancel().catch(() => undefined);
      clearTimeout(timeout);
    }
  }

  async signedUrl(key: string, expiresSeconds: number) {
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 900) throw new Error("Signed media URL expiry is invalid");
    const url = this.objectUrl(key);
    const { amzDate, dateStamp } = awsTime(new Date());
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = encodedQuery(query);
    const canonicalHeaders = `host:${url.host}\n`;
    const canonicalRequest = ["GET", url.pathname, canonicalQuery, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
    query["X-Amz-Signature"] = hmacHex(signingKey(this.config.secretAccessKey, dateStamp, this.config.region), stringToSign);
    url.search = encodedQuery(query);
    return url.toString();
  }

  async get(key: string, maximumBytes: number, expectedMime: string) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 100_000_000) {
      throw new MediaRuntimeError("Private media size limit is invalid", "MEDIA_STORAGE_SIZE", false);
    }
    const url = this.objectUrl(key);
    const { amzDate, dateStamp } = awsTime(new Date());
    const payloadHash = hashHex(new Uint8Array());
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signed = signedHeaders(url, headers);
    const canonicalRequest = ["GET", url.pathname, "", signed.canonical, signed.names, payloadHash].join("\n");
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
    const signature = hmacHex(signingKey(this.config.secretAccessKey, dateStamp, this.config.region), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed.names}, Signature=${signature}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new MediaRuntimeError(
          response.status === 404 ? "Outbound media is no longer available" : "Private media storage rejected the read",
          response.status === 404 ? "MEDIA_EXPIRED" : "MEDIA_STORAGE_HTTP",
          retryable,
          !retryable,
        );
      }
      const responseMime = normalizeMediaMime(response.headers.get("content-type") ?? "");
      const normalizedExpected = normalizeMediaMime(expectedMime);
      if (responseMime && responseMime !== "application/octet-stream" && responseMime !== normalizedExpected) {
        throw new MediaRuntimeError("Private media type does not match its durable record", "MEDIA_STORAGE_MIME", false);
      }
      const lengthHeader = response.headers.get("content-length");
      if (lengthHeader) {
        const declared = Number(lengthHeader);
        if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximumBytes) {
          throw new MediaRuntimeError("Private media size is outside the allowed range", "MEDIA_STORAGE_SIZE", false);
        }
      }
      if (!response.body) throw new MediaRuntimeError("Private media response was empty", "MEDIA_STORAGE_EMPTY", true, false);
      return await boundedStorageBody(response.body, maximumBytes);
    } catch (error) {
      // Also release bodies rejected at the status/header boundary.
      await response?.body?.cancel().catch(() => undefined);
      if (error instanceof MediaRuntimeError) throw error;
      throw new MediaRuntimeError("Private media storage timed out or was unavailable", "MEDIA_STORAGE_NETWORK", true, false);
    } finally {
      clearTimeout(timeout);
    }
  }

  private objectUrl(key: string) {
    if (!key || key.length > 1_024 || key.startsWith("/") || key.includes("..")) throw new Error("Media object key is invalid");
    const basePath = this.endpoint.pathname.replace(/\/$/, "");
    const objectPath = key.split("/").map(rfc3986).join("/");
    const url = new URL(this.endpoint);
    url.pathname = `${basePath}/${rfc3986(this.config.bucket)}/${objectPath}`;
    url.search = "";
    url.hash = "";
    return url;
  }
}

export class DefaultOutboundMediaPipeline implements OutboundMediaPipeline {
  private readonly media: MediaService;

  constructor(
    scanner: MediaScanner,
    private readonly storage: S3MediaStorage,
    repository: MediaRepository,
  ) {
    this.media = new MediaService(scanner, storage, repository);
  }

  async prepare(job: DeliveryJob, zammadToken: string, beforeRequest?: () => Promise<void>): Promise<PreparedOutboundMedia> {
    const descriptor = job.media;
    if (!descriptor) throw new MediaRuntimeError("Outbound media descriptor is missing", "MEDIA_DESCRIPTOR_MISSING", false);
    if (!job.mediaEnabled) throw new MediaRuntimeError("Media delivery is disabled for this group", "MEDIA_DISABLED", false, false);
    if (descriptor.state === "FAILED") throw new MediaRuntimeError("Outbound media previously failed validation", "MEDIA_FAILED", false);
    const mimeType = normalizeMediaMime(descriptor.mimeType);
    const maximum = maximumMediaBytes(mimeType);
    if (!maximum) throw new MediaRuntimeError("Outbound media type is unsupported", "UNSUPPORTED_MIME", false);
    if (!Number.isSafeInteger(descriptor.byteSize) || descriptor.byteSize < 1 || descriptor.byteSize > maximum) {
      throw new MediaRuntimeError("Outbound media size is outside the allowed range", "INVALID_SIZE", false);
    }
    const filename = safeMediaFilename(descriptor.filename);

    const workspaceSource = descriptor.zammadUploadId && descriptor.zammadUploadStoreId
      ? { uploadId: descriptor.zammadUploadId, storeId: descriptor.zammadUploadStoreId }
      : null;
    const zammad = workspaceSource || !descriptor.mediaObjectId
      ? new ZammadClient({ baseUrl: job.zammadBaseUrl, token: zammadToken, beforeRequest })
      : null;
    const cleanupSource = workspaceSource && zammad
      ? () => cleanupWorkspaceUpload(zammad, workspaceSource.uploadId, workspaceSource.storeId)
      : undefined;

    if (descriptor.mediaObjectId) {
      const record = durableMediaRecord(job, descriptor);
      if (!descriptor.botMediaAssetId && new Date(record.expiresAt).getTime() <= Date.now()) {
        throw new MediaRuntimeError("Outbound media has expired", "MEDIA_EXPIRED", false);
      }
      const bytes = await this.storage.get(record.objectKey, record.byteSize, record.mimeType);
      if (bytes.length !== record.byteSize || hashHex(bytes) !== record.sha256) {
        throw new MediaRuntimeError("Private media integrity validation failed", "MEDIA_INTEGRITY", false);
      }
      return { bytes, filename, mimeType: record.mimeType, mediaObjectId: record.id, newlyLinked: false, cleanupSource };
    }

    if (!zammadToken) throw new MediaRuntimeError("Zammad media credentials are unavailable", "ZAMMAD_SECRET_INVALID", false, false);
    const client = zammad!;
    let downloaded: Awaited<ReturnType<ZammadClient["downloadAttachment"]>>;
    try {
      downloaded = workspaceSource
        ? await client.downloadWorkspaceUpload(workspaceSource.uploadId, workspaceSource.storeId, descriptor.byteSize)
        : await client.downloadAttachment(Number(job.ticketId), Number(job.articleId), descriptor.zammadAttachmentId!, descriptor.byteSize);
    } catch (error) {
      if (error instanceof ZammadError) {
        throw new MediaRuntimeError(error.message, "ZAMMAD_MEDIA_DOWNLOAD", error.retryable, !error.retryable);
      }
      throw error;
    }
    if (downloaded.bytes.length !== descriptor.byteSize) throw new MediaRuntimeError("Zammad attachment size does not match its descriptor", "ZAMMAD_MEDIA_SIZE", false);
    if (normalizeMediaMime(downloaded.mimeType) !== mimeType) throw new MediaRuntimeError("Zammad attachment type does not match its descriptor", "ZAMMAD_MEDIA_MIME", false);
    const result = await this.media.ingest({tenantId:job.tenantId,bytes:downloaded.bytes,declaredMime:mimeType,filename,retentionDays:job.retentionDays,issueSignedUrl:false});
    // Private object storage is the durable hand-off boundary.  Read the
    // staged object back through the authenticated S3 path even on the first
    // attempt so provider adapters never depend on ephemeral Zammad response
    // bytes or on a public/signed URL.
    const bytes = await this.storage.get(
      result.record.objectKey,
      result.record.byteSize,
      result.record.mimeType,
    );
    if (bytes.length !== result.record.byteSize || hashHex(bytes) !== result.record.sha256) {
      throw new MediaRuntimeError("Private media integrity validation failed", "MEDIA_INTEGRITY", false);
    }
    return {
      bytes,
      filename,
      mimeType: result.record.mimeType,
      mediaObjectId: result.record.id,
      newlyLinked: true,
      cleanupSource,
    };
  }
}

async function cleanupWorkspaceUpload(client: ZammadClient, uploadId: string, storeId: number) {
  try {
    await client.deleteWorkspaceUpload(uploadId, storeId);
  } catch (error) {
    if (error instanceof ZammadError) {
      throw new MediaRuntimeError(error.message, "ZAMMAD_MEDIA_CLEANUP", error.retryable, false);
    }
    throw error;
  }
}

export class DefaultInboundMediaPipeline implements InboundMediaPipeline {
  private readonly media: MediaService;

  constructor(
    private readonly secrets: SecretResolver,
    private readonly wahaDownloader: WahaMediaDownloader,
    private readonly metaDownloader: MetaMediaDownloader,
    scanner: MediaScanner,
    storage: MediaStorage,
    repository: MediaRepository,
  ) {
    this.media = new MediaService(scanner, storage, repository);
  }

  async prepare(input: InboundMediaInput): Promise<PreparedInboundMedia> {
    const secret = await this.secrets.resolve(input.connectionSecretReference,input.provider==="waha"
      ?{kind:"exact",expectedReference:input.connectionSecretReference}
      :{kind:"meta-connection",tenantId:input.tenantId,connectionId:input.connectionId});
    const downloaded = input.provider === "waha"
      ? await this.downloadWaha(input, secret.apiKey)
      : await this.downloadMeta(input, secret.accessToken);
    const result = await this.media.ingest({
      tenantId: input.tenantId,
      bytes: downloaded.bytes,
      declaredMime: downloaded.mimeType,
      filename: downloaded.filename,
      retentionDays: input.retentionDays,
      issueSignedUrl: false,
    });
    return {
      attachment: {
        filename: downloaded.filename,
        data: Buffer.from(downloaded.bytes).toString("base64"),
        "mime-type": result.record.mimeType,
      },
      mediaObjectId: result.record.id,
      deduplicated: result.deduplicated,
    };
  }

  private downloadWaha(input: InboundMediaInput, apiKey?: string) {
    if (!apiKey) throw new MediaRuntimeError("WAHA media credentials are unavailable", "WAHA_SECRET_INVALID", false, false);
    return this.wahaDownloader.download(input.media, apiKey, input.providerSessionId, input.providerBaseUrl);
  }

  private downloadMeta(input: InboundMediaInput, accessToken?: string) {
    if (!accessToken) throw new MediaRuntimeError("Meta media credentials are unavailable", "META_SECRET_INVALID", false, false);
    if (!input.beforeMetaRequest) throw new MediaRuntimeError("Meta media credential context is unavailable", "META_CREDENTIAL_CONTEXT_MISSING", false, false);
    return this.metaDownloader.download(input.media, accessToken, input.providerSessionId, () => input.beforeMetaRequest!(accessToken));
  }
}

export function isRetryableMediaError(error: unknown) {
  return (error instanceof MediaRuntimeError || error instanceof MediaValidationError) && error.retryable;
}

export function isQuarantinedMediaError(error: unknown) {
  return (error instanceof MediaRuntimeError || error instanceof MediaValidationError) && error.quarantine;
}

function durableMediaRecord(job: DeliveryJob, descriptor: NonNullable<DeliveryJob["media"]>): MediaRecord {
  if (!descriptor.mediaObjectId || !descriptor.objectKey || !descriptor.sha256 || !descriptor.storedMimeType ||
      descriptor.storedByteSize === undefined || !descriptor.expiresAt) {
    throw new MediaRuntimeError("Durable outbound media record is incomplete", "MEDIA_RECORD_INVALID", false);
  }
  if (!/^[0-9a-f]{64}$/.test(descriptor.sha256) || descriptor.storedByteSize !== descriptor.byteSize ||
      normalizeMediaMime(descriptor.storedMimeType) !== normalizeMediaMime(descriptor.mimeType)) {
    throw new MediaRuntimeError("Durable outbound media record does not match its descriptor", "MEDIA_RECORD_MISMATCH", false);
  }
  const expiresAt = new Date(descriptor.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) throw new MediaRuntimeError("Durable outbound media expiry is invalid", "MEDIA_RECORD_INVALID", false);
  return {
    id: descriptor.mediaObjectId,
    tenantId: job.tenantId,
    sha256: descriptor.sha256,
    objectKey: descriptor.objectKey,
    mimeType: normalizeMediaMime(descriptor.storedMimeType),
    byteSize: descriptor.storedByteSize,
    scanState: "CLEAN",
    expiresAt: expiresAt.toISOString(),
    createdAt: expiresAt.toISOString(),
  };
}

function metaMediaId(raw?: string) {
  if (!raw || raw.length > 768) throw new MediaRuntimeError("Meta media reference is missing", "META_MEDIA_REFERENCE", false);
  const match = META_MEDIA_REFERENCE.exec(raw);
  const mediaId = match?.[1];
  if (!mediaId || !META_MEDIA_ID.test(mediaId)) {
    throw new MediaRuntimeError("Meta media reference is invalid", "META_MEDIA_REFERENCE", false);
  }
  return mediaId;
}

function metaMetadataString(value: unknown, maximum: number, code: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new MediaRuntimeError("Meta returned invalid media metadata", code, true, false);
  }
  return value;
}

function metaSha256Hex(value: unknown) {
  const digest = metaMetadataString(value, 64, "META_MEDIA_METADATA");
  if (META_MEDIA_SHA256_HEX.test(digest)) return digest.toLowerCase();
  if (META_MEDIA_SHA256_BASE64.test(digest)) return Buffer.from(digest, "base64").toString("hex");
  throw new MediaRuntimeError("Meta returned invalid media integrity metadata", "META_MEDIA_METADATA", true, false);
}

function metaMediaSize(value: unknown, maximum: number) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,12}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new MediaRuntimeError("Meta media size is outside the allowed range", "META_MEDIA_SIZE", false);
  }
  return parsed;
}

function metaMediaHttpError(status: number, operation: "lookup" | "download") {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const unavailable = status === 404 || status === 410;
  const unauthorized = status === 401 || status === 403;
  const code = unauthorized
    ? "META_MEDIA_AUTH"
    : unavailable
      ? "META_MEDIA_UNAVAILABLE"
      : operation === "lookup" ? "META_MEDIA_LOOKUP_HTTP" : "META_MEDIA_HTTP";
  return new MediaRuntimeError(
    unauthorized
      ? "Meta media authorization failed"
      : unavailable
        ? "Meta media is no longer available"
        : `Meta media ${operation} failed`,
    code,
    retryable,
    false,
  );
}

function hasUnsafeSecretCharacter(value: string) {
  return /[\p{Cc}\p{Cf}\s]/u.test(value);
}

async function boundedMetaBody(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  code: string,
  retryable: boolean,
) {
  if (!stream) throw new MediaRuntimeError("Meta media response was empty", code, retryable, !retryable);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maximum) {
        await reader.cancel();
        throw new MediaRuntimeError(
          code === "META_MEDIA_SIZE" ? "Meta media size is outside the allowed range" : "Meta media lookup response is too large",
          code,
          retryable,
          !retryable,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new MediaRuntimeError("Meta media response was empty", code, retryable, !retryable);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function boundedStorageBody(stream: ReadableStream<Uint8Array>, maximum: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maximum) {
        throw new MediaRuntimeError("Private media size is outside the allowed range", "MEDIA_STORAGE_SIZE", false);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new MediaRuntimeError("Private media response was empty", "MEDIA_STORAGE_EMPTY", true, false);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function validatedEndpoint(raw: string, label: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} is invalid`);
  }
  return url;
}

function validatedPrivateWahaEndpoint(raw: string) {
  const url = validatedEndpoint(raw, "WAHA media endpoint");
  if (url.pathname !== "/" || !isPrivateHost(url.hostname)) {
    throw new Error("WAHA media endpoint must be a private origin");
  }
  return url;
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host.endsWith(".svc") || host.includes(".svc.cluster.local")) return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  if (!host.includes(".")) return /^[a-z0-9][a-z0-9-]{0,62}$/.test(host);
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10
      || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254);
  }
  return false;
}

function isLoopbackHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1";
}

function effectivePort(url: URL) {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function defaultFilename(type: NonNullable<ProviderMessage["media"]>["type"], mime: string) {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  };
  return `${type}.${extensions[mime] ?? "bin"}`;
}

function awsTime(date: Date) {
  const value = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: value, dateStamp: value.slice(0, 8) };
}

function signedHeaders(url: URL, input: Record<string, string>) {
  const entries = [["host", url.host], ...Object.entries(input)]
    .map(([name, value]) => [name.toLowerCase().trim(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([left], [right]) => canonicalCompare(left, right));
  return {
    canonical: `${entries.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    names: entries.map(([name]) => name).join(";"),
  };
}

function signingKey(secret: string, date: string, region: string) {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function hmacHex(key: string | Uint8Array, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function hashHex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function asciiMetadata(value: string) {
  return encodeURIComponent(value).slice(0, 1_024);
}

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedQuery(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([left], [right]) => canonicalCompare(left, right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
