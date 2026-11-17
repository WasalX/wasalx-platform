import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const MAX_LIVE_JSON_BYTES = 1_048_576;

export function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function explicitBoolean(env, name) {
  const value = env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly true or false`);
}

export function liveBaseUrl(raw, label, allowInsecure = false) {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(local || allowInsecure))
  ) {
    throw new Error(`${label} must be an HTTPS origin without embedded credentials`);
  }
  return url;
}

export async function boundedJsonRequest(
  fetchImpl,
  url,
  init,
  { label, timeoutMs = 20_000, maximumBytes = MAX_LIVE_JSON_BYTES } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label ?? "Provider"} request failed before a response was received`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label ?? "Provider"} returned an oversized response`);
  }
  const bytes = await boundedBytes(response, maximumBytes, label ?? "Provider");
  let value;
  try {
    value = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label ?? "Provider"} returned invalid JSON`);
  }
  if (!response.ok) {
    // Provider bodies can contain phone numbers, message bodies, invite links, or tokens.
    throw new Error(`${label ?? "Provider"} request was rejected with HTTP ${response.status}`);
  }
  return value;
}

async function boundedBytes(response, maximumBytes, label) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} returned an oversized response`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function opaqueDigest(value) {
  if (typeof value !== "string" || !value) throw new Error("Cannot digest an empty identifier");
  return createHash("sha256").update(value).digest("hex");
}

export async function readBoundedJsonFile(path, maximumBytes = MAX_LIVE_JSON_BYTES) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
    throw new Error("Evidence input must be a bounded regular file");
  }
  const bytes = await readFile(path);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Evidence input is not valid UTF-8 JSON");
  }
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(importMetaUrl) === resolve(process.argv[1]);
}

export function writeEvidence(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
