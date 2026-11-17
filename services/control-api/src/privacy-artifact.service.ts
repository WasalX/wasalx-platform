import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";

@Injectable()
export class PrivacyArtifactService {
  async signedDownloadUrl(key: string, expiresSeconds: number) {
    if (!/^tenants\/[0-9a-f-]{36}\/privacy-exports\/[0-9a-f-]{36}(?:-[0-9]+)?\.json$/u.test(key)) {
      throw new ServiceUnavailableException("The export artifact reference is invalid");
    }
    return signedObjectUrl(key,expiresSeconds,"wasalx-privacy-export.json","application/json");
  }

  async signedMediaUrl(tenantId:string,key:string,sha256:string,filename:string,mimeType:string,expiresSeconds:number){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(tenantId)||
      !/^[0-9a-f]{64}$/u.test(sha256)||key!==`${tenantId}/sha256/${sha256.slice(0,2)}/${sha256}`)throw new ServiceUnavailableException("The media reference is invalid");
    const safeFilename=filename.normalize("NFC").replace(/[\p{Cc}\p{Cf}\\/]/gu,"_").replace(/\.\.+/gu,".").trim().slice(0,120)||"attachment";
    const safeMime=mimeType.toLowerCase();if(!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(safeMime))throw new ServiceUnavailableException("The media content type is invalid");
    return signedObjectUrl(key,expiresSeconds,safeFilename,safeMime);
  }
}

function signedObjectUrl(key:string,expiresSeconds:number,filename:string,mimeType:string){
    const config = configuration();
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 900) {
      throw new ServiceUnavailableException("The export download lifetime is invalid");
    }
    const url = objectUrl(config.endpoint, config.bucket, key);
    const { amzDate, dateStamp } = awsTime(new Date());
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
      "response-content-disposition": `attachment; filename*=UTF-8''${rfc3986(filename)}`,
      "response-content-type": mimeType,
    };
    const canonicalQuery = encodedQuery(query);
    const canonicalRequest = [
      "GET",
      url.pathname,
      canonicalQuery,
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    query["X-Amz-Signature"] = createHmac("sha256", signingKey(config.secretAccessKey, dateStamp, config.region))
      .update(stringToSign)
      .digest("hex");
    url.search = encodedQuery(query);
    return url.toString();
}

function configuration() {
  const endpointValue = process.env.PRIVACY_EXPORT_S3_ENDPOINT;
  const region = process.env.PRIVACY_EXPORT_S3_REGION;
  const bucket = process.env.PRIVACY_EXPORT_S3_BUCKET;
  const accessKeyId = process.env.PRIVACY_EXPORT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRIVACY_EXPORT_S3_SECRET_ACCESS_KEY;
  if (!endpointValue || !region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new ServiceUnavailableException("Privacy export download storage is not configured");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new ServiceUnavailableException("Privacy export storage endpoint is invalid");
  }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ServiceUnavailableException("Privacy export storage endpoint is invalid");
  }
  if (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:") {
    throw new ServiceUnavailableException("Privacy export storage must use HTTPS in production");
  }
  if (!/^[a-z0-9-]{1,63}$/u.test(region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new ServiceUnavailableException("Privacy export storage configuration is invalid");
  }
  if (accessKeyId.length > 256 || secretAccessKey.length > 4096) {
    throw new ServiceUnavailableException("Privacy export storage credential is invalid");
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

function objectUrl(endpoint: URL, bucket: string, key: string) {
  const url = new URL(endpoint);
  const base = endpoint.pathname.replace(/\/$/u, "");
  url.pathname = `${base}/${rfc3986(bucket)}/${key.split("/").map(rfc3986).join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

function awsTime(date: Date) {
  const value = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { amzDate: value, dateStamp: value.slice(0, 8) };
}

function signingKey(secret: string, date: string, region: string) {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function encodedQuery(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
