import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

if (process.env.NODE_ENV === "production") throw new Error("The development secret sidecar cannot run in production");

const MAX_REQUEST_BYTES = 16_384;
const MAX_REFERENCE_BYTES = 512;
const MAX_SECRET_DEPTH = 8;
const MAX_SECRET_KEYS = 128;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const STORE_VERSION = 1;
const STORE_CIPHER = "aes-256-gcm";
const STORE_AAD = Buffer.from("wasalx-development-secret-store:v1", "utf8");
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

main().catch(() => {
  // Never print the error object: filesystem and crypto errors can contain
  // paths or values that should not be copied into container logs.
  process.stderr.write("Development secret sidecar failed to initialize its encrypted store.\n");
  process.exitCode = 1;
});

async function main() {
  const legacyToken = process.env.DEV_SECRET_SIDECAR_TOKEN;
  const readToken = process.env.DEV_SECRET_SIDECAR_READ_TOKEN ?? legacyToken;
  const writeToken = process.env.DEV_SECRET_SIDECAR_WRITE_TOKEN ?? legacyToken;
  if (!readToken) throw new Error("DEV_SECRET_SIDECAR_READ_TOKEN is required");
  if (!writeToken) throw new Error("DEV_SECRET_SIDECAR_WRITE_TOKEN is required");

  const storePath = parseStorePath(process.env.DEV_SECRET_STORE_PATH);
  const encodedEncryptionKey = process.env.DEV_SECRET_STORE_ENCRYPTION_KEY;
  if (encodedEncryptionKey === readToken || encodedEncryptionKey === writeToken) {
    throw new Error("The store-encryption key must be distinct from sidecar bearer credentials");
  }
  const encryptionKey = parseEncryptionKey(encodedEncryptionKey);
  const responseLoss = responseLossConfiguration(process.env);
  const seed = parseStore(process.env.DEV_SECRET_STORE_JSON ?? "{}");
  let store = await loadOrCreateStore(storePath, encryptionKey, seed);
  let mutationTail = Promise.resolve();
  const port = Number(process.env.PORT ?? 8082);
  const host = parseHost(process.env.HOST);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be a valid TCP port");

  const mutate = (operation, afterPersist) => {
    const pending = mutationTail.then(async () => {
      const draft = cloneStore(store);
      const changed = await operation(draft);
      if (!changed) return;
      await persistStore(storePath, encryptionKey, draft);
      store = draft;
      return afterPersist ? afterPersist() : undefined;
    });
    mutationTail = pending.catch(() => undefined);
    return pending;
  };

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok" });
    if (request.method !== "POST" || !isSecretRoute(request.url)) return json(response, 404, { error: "not_found" });
    const requiredToken = request.url === "/v1/resolve" ? readToken : writeToken;
    if (!equal(request.headers.authorization ?? "", `Bearer ${requiredToken}`)) return json(response, 401, { error: "unauthorized" });

    try {
      const body = await readJson(request);
      if (!isSecretReference(body.reference)) return json(response, 400, { error: "invalid_reference" });

      if (request.url === "/v1/resolve") {
        // A resolve begun while a write is being committed observes the durable
        // result, never an in-memory value that has not reached disk.
        await mutationTail;
        const secret = store.get(body.reference);
        if (!secret) return json(response, 404, { error: "secret_not_found" });
        return json(response, 200, secret);
      }

      if (request.url === "/v1/store") {
        if (!isSafeSecret(body.value)) return json(response, 400, { error: "invalid_secret" });
        let claim;
        const dropResponse = await mutate(async draft => {
          // Claim is durable before touching the secret; a failed/uncertain
          // store never rearms this exact reference on restart or replay.
          claim = await reserveResponseLoss(responseLoss, body.reference, draft.has(body.reference));
          draft.set(body.reference, structuredClone(body.value));
          return true;
        }, () => finishResponseLoss(claim));
        if (dropResponse) { response.destroy(); return; }
        return empty(response, 204);
      }

      await mutate(draft => draft.delete(body.reference));
      return empty(response, 204);
    } catch (error) {
      if (error instanceof ResponseLossConsumedError) return json(response, 409, { error: "simulated_store_claim_consumed" });
      if (error instanceof RequestTooLargeError) return json(response, 413, { error: "payload_too_large" });
      if (error instanceof InvalidRequestError) return json(response, 400, { error: "invalid_json" });
      return json(response, 503, { error: "secret_store_unavailable" });
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`Development secret sidecar listening on ${listeningPort}\n`);
  });
}

function parseHost(value) {
  const host = value ?? "0.0.0.0";
  if (!["0.0.0.0", "127.0.0.1", "::", "::1"].includes(host)) {
    throw new Error("HOST must be an explicit local or all-interface bind address");
  }
  return host;
}

function parseStorePath(value) {
  if (!value || !isAbsolute(value) || value.includes("\0") || basename(value) === "." || basename(value) === "..") {
    throw new Error("DEV_SECRET_STORE_PATH must be an absolute file path");
  }
  return value;
}

function parseEncryptionKey(value) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new Error("DEV_SECRET_STORE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("DEV_SECRET_STORE_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return decoded;
}

async function loadOrCreateStore(path, key, seed) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STORE_BYTES) throw new SecretStoreError();
    const encrypted = await readFile(path, { encoding: "utf8" });
    return decryptStore(encrypted, key);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new SecretStoreError();
    await persistStore(path, key, seed);
    return cloneStore(seed);
  }
}

function decryptStore(serializedEnvelope, key) {
  try {
    const envelope = JSON.parse(serializedEnvelope);
    const expectedKeys = ["cipher", "ciphertext", "iv", "tag", "version"];
    if (!isRecord(envelope) || Object.keys(envelope).sort().join(",") !== expectedKeys.join(",")) throw new SecretStoreError();
    if (envelope.version !== STORE_VERSION || envelope.cipher !== STORE_CIPHER) throw new SecretStoreError();

    const iv = decodeCanonicalBase64(envelope.iv, 12);
    const tag = decodeCanonicalBase64(envelope.tag, 16);
    const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
    const decipher = createDecipheriv(STORE_CIPHER, key, iv, { authTagLength: 16 });
    decipher.setAAD(STORE_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_STORE_BYTES) throw new SecretStoreError();
    return parseStore(plaintext.toString("utf8"));
  } catch {
    throw new SecretStoreError();
  }
}

function decodeCanonicalBase64(value, expectedLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STORE_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new SecretStoreError();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) throw new SecretStoreError();
  return decoded;
}

async function persistStore(path, key, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const plaintext = Buffer.from(serializeStore(value), "utf8");
  if (plaintext.length > MAX_STORE_BYTES) throw new SecretStoreError();
  const iv = randomBytes(12);
  const cipher = createCipheriv(STORE_CIPHER, key, iv, { authTagLength: 16 });
  cipher.setAAD(STORE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = JSON.stringify({
    version: STORE_VERSION,
    cipher: STORE_CIPHER,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(envelope, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    throw new SecretStoreError();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

function serializeStore(value) {
  const serialized = Object.create(null);
  for (const [reference, secret] of value.entries()) serialized[reference] = secret;
  return JSON.stringify(serialized);
}

function cloneStore(value) {
  return new Map([...value.entries()].map(([reference, secret]) => [reference, structuredClone(secret)]));
}

function parseStore(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SecretStoreError();
  }
  if (!isRecord(parsed)) throw new SecretStoreError();
  const entries = Object.entries(parsed);
  const result = new Map();
  for (const [reference, secret] of entries) {
    if (!isSecretReference(reference) || !isSafeSecret(secret)) throw new SecretStoreError();
    result.set(reference, structuredClone(secret));
  }
  return result;
}

function isSecretRoute(url) {
  return url === "/v1/resolve" || url === "/v1/store" || url === "/v1/delete";
}

function isSecretReference(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REFERENCE_BYTES) return false;
  return /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(value);
}

function isSafeSecret(value) {
  if (!isRecord(value)) return false;
  let keys = 0;
  const visit = (candidate, depth) => {
    if (depth > MAX_SECRET_DEPTH) return false;
    if (Array.isArray(candidate)) return candidate.every(item => visit(item, depth + 1));
    if (candidate === null || typeof candidate !== "object") return isJsonPrimitive(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      keys += 1;
      if (keys > MAX_SECRET_KEYS || FORBIDDEN_KEYS.has(key) || !visit(nested, depth + 1)) return false;
    }
    return Object.getOwnPropertySymbols(candidate).length === 0;
  };
  return visit(value, 0);
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isJsonPrimitive(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function empty(response, status) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRequestError();
  }
}

class RequestTooLargeError extends Error {}
class InvalidRequestError extends Error {}
class SecretStoreError extends Error {}

// Opt-in local fixture only. No HTTP control endpoint and no secret payload in
// the claim/receipt. Installed source/image/container admission is driver-owned.
function responseLossConfiguration(environment) {
  if (environment.DEV_SECRET_STORE_RESPONSE_LOSS_ENABLED !== "true") return undefined;
  if (!["development", "test"].includes(environment.NODE_ENV)
    || environment.DEV_SECRET_STORE_RESPONSE_LOSS_MODE !== "SIMULATED") throw new SecretStoreError();
  const directory = environment.DEV_SECRET_STORE_RESPONSE_LOSS_DIR;
  if (!directory || !isAbsolute(directory) || directory.includes("\0")) throw new SecretStoreError();
  return directory;
}
async function readPrivateClaim(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (process.platform !== "win32" && (metadata.uid !== process.getuid() || (metadata.mode & 0o077)))) throw new SecretStoreError();
  let handle;
  try {
    handle = await open(join(directory, "claim.json"), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const file = await handle.stat();
    if (!file.isFile() || file.size > 4096
      || (process.platform !== "win32" && (file.uid !== process.getuid() || (file.mode & 0o077)))) throw new SecretStoreError();
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new SecretStoreError();
  } finally { if (handle) await handle.close(); }
}
async function reserveResponseLoss(directory, reference, alreadyStored) {
  if (!directory) return undefined;
  const claim = await readPrivateClaim(directory);
  const referenceSha256 = createHash("sha256").update(reference).digest("hex");
  const receiptPath = join(directory, `${referenceSha256}.receipt.json`);
  // The private directory was validated above. Consumed authority belongs to
  // the requested reference, independently of a removed or replacement arm.
  try {
    await lstat(receiptPath);
    throw new ResponseLossConsumedError();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!claim) return undefined;
  const keys = ["candidateSha256", "claimId", "connectionId", "expiresAt", "ownerClaimSha256", "referenceSha256", "runtimeSha256", "schemaVersion", "tenantId"];
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  if (!isRecord(claim)) throw new SecretStoreError();
  const expires = typeof claim.expiresAt === "string" ? Date.parse(claim.expiresAt) : NaN;
  if (!isRecord(claim) || Object.keys(claim).sort().join(",") !== keys.join(",") || claim.schemaVersion !== 1
    || ![claim.claimId, claim.tenantId, claim.connectionId].every(value => typeof value === "string" && uuid.test(value))
    || ![claim.candidateSha256, claim.runtimeSha256, claim.ownerClaimSha256, claim.referenceSha256].every(value => typeof value === "string" && digest.test(value))
    || !Number.isFinite(expires)) throw new SecretStoreError();
  if (referenceSha256 !== claim.referenceSha256) return undefined;
  if (expires <= Date.now() || expires > Date.now() + 300000) throw new SecretStoreError();
  const prefix = `secret://${claim.tenantId}/connections/${claim.connectionId}/meta/rotations/`;
  if (!reference.startsWith(prefix) || !digest.test(reference.slice(prefix.length))) throw new SecretStoreError();
  if (alreadyStored) throw new ResponseLossConsumedError();
  const receipt = { ...claim, state: "CLAIMED", storeAttempts: 1, claimedAt: new Date().toISOString() };
  let handle;
  try {
    handle = await open(receiptPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(receipt)); await handle.sync();
    await handle.close(); handle = undefined; await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (error?.code === "EEXIST") throw new ResponseLossConsumedError();
    throw new SecretStoreError();
  }
  return { directory, receiptPath, receipt, expires };
}
async function finishResponseLoss(claim) {
  if (!claim) return false;
  const drop = Date.now() < claim.expires;
  // Called only after the incumbent encrypted file, rename and directory fsync.
  const receipt = { ...claim.receipt, state: drop ? "PERSISTED_RESPONSE_DROPPED" : "PERSISTED_RESPONSE_RETURNED",
    persistedAt: new Date().toISOString() };
  const temporary = join(claim.directory, `.receipt.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, claim.receiptPath); await syncDirectory(claim.directory);
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    throw new SecretStoreError();
  }
  return drop;
}
class ResponseLossConsumedError extends Error {}
