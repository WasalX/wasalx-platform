import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfiguratorConfig, ConfiguratorConfigError } from "../services/workspace-configurator/dist/config.js";
import { createVerifiedBackup, createVerifiedTenantBackup } from "../services/workspace-configurator/dist/backup-runtime.js";
import { S3BackupStore } from "../services/workspace-configurator/dist/s3-store.js";
import { startupRequest } from "../services/workspace-configurator/dist/startup-request.js";
import { assertSecretFree, safeError } from "../services/workspace-configurator/dist/safe-output.js";
import { runConfigurator } from "../services/workspace-configurator/dist/runtime.js";
import { ConfiguratorRuntimeError, ZammadAdminClient } from "../services/workspace-configurator/dist/zammad-client.js";
import { validateBackupManifest } from "../scripts/dr/contracts.mjs";

const tenantId = "10000000-0000-4000-8000-000000000001";
const compact = tenantId.replaceAll("-", "");
const packageVersion = "0.5.83";
const packageSha256 = "00069cb9565f2a9002d5df73cc29532f3adde2fce28f4f09400370f9c9d11153";

const credential = "credential-value-long-enough";
const ageRecipient = `age1${"q".repeat(58)}`;

function baseEnvironment() {
  return {
    NODE_ENV: "development", TENANT_ID: tenantId, ZAMMAD_BASE_URL: "http://zammad.internal",
    CONFIGURATOR_OUTPUT_DIRECTORY: "/tmp/wasalx-configurator-test",
  };
}

test("configurator fails closed and exposes credentials only to the selected action", () => {
  assert.throws(
    () => loadConfiguratorConfig(["package"], { ...baseEnvironment(), WASALX_PACKAGE_VERSION: packageVersion, WASALX_PACKAGE_SHA256: packageSha256 }),
    (error) => error instanceof ConfiguratorConfigError && error.code === "ZAMMAD_SERVICE_TOKEN_MISSING",
  );
  const packageConfig = loadConfiguratorConfig(["package"], {
    ...baseEnvironment(), ZAMMAD_SERVICE_TOKEN: credential, WASALX_PACKAGE_VERSION: packageVersion, WASALX_PACKAGE_SHA256: packageSha256,
  });
  assert.equal(packageConfig.action, "package");
  assert.equal("database" in packageConfig, false);
  assert.equal("storage" in packageConfig, false);
  const productionPackage = {
    ...baseEnvironment(), NODE_ENV: "production", ZAMMAD_SERVICE_TOKEN: credential,
    WASALX_PACKAGE_VERSION: packageVersion, WASALX_PACKAGE_SHA256: packageSha256,
  };
  assert.equal(
    loadConfiguratorConfig(["package"], { ...productionPackage, ZAMMAD_BASE_URL: `http://zammad-${compact}` }).zammadBaseUrl.hostname,
    `zammad-${compact}`,
  );
  for (const zammadBaseUrl of ["http://zammad.internal", `http://zammad-${compact}.example.test`, `http://zammad-${compact}:8080`]) {
    assert.throws(
      () => loadConfiguratorConfig(["package"], { ...productionPackage, ZAMMAD_BASE_URL: zammadBaseUrl }),
      (error) => error instanceof ConfiguratorConfigError && error.code === "ZAMMAD_BASE_URL_INSECURE",
    );
  }

  const backupEnvironment = {
    ...baseEnvironment(), NODE_ENV: "production", ZAMMAD_BASE_URL: "https://zammad.internal",
    DATABASE_URL: `postgresql://zammad:${credential}@postgres.internal:5432/zammad_${compact}?sslmode=require`,
    DATABASE_NAME: `zammad_${compact}`, WORKSPACE_REGION: "sa-riyadh-1", OBJECT_STORAGE_PREFIX: `tenants/${tenantId}/`,
    BACKUP_S3_ENDPOINT: "https://s3.internal", BACKUP_S3_REGION: "sa-riyadh-1", BACKUP_S3_BUCKET: "wasalx-tenant-backups",
    BACKUP_S3_ACCESS_KEY_ID: credential, BACKUP_S3_SECRET_ACCESS_KEY: credential,
    BACKUP_S3_KMS_KEY_REFERENCE: "arn:aws:kms:sa-riyadh-1:111122223333:key/abcd",
    BACKUP_S3_LIFECYCLE_RULE_ID: "tenant-backup-retention", BACKUP_S3_PROVIDER: "aws-s3",
  };
  const backupConfig = loadConfiguratorConfig(["backup"], backupEnvironment);
  assert.equal(backupConfig.action, "backup");
  assert.equal(backupConfig.storage.encryptionMode, "SSE_KMS");
  const envelopeEnvironment = { ...backupEnvironment, BACKUP_ENCRYPTION_MODE: "CLIENT_ENVELOPE",
    BACKUP_AGE_RECIPIENT: ageRecipient, BACKUP_S3_KMS_KEY_REFERENCE: undefined, BACKUP_CA_CERT_FILE: "/backup-ca/ca.crt" };
  for (const ca of [undefined, "relative/ca.crt", "/tmp/../ca.crt", "/tmp/ca\n"]) {
    assert.throws(() => loadConfiguratorConfig(["backup"], { ...envelopeEnvironment, BACKUP_CA_CERT_FILE: ca }));
  }
  assert.equal(loadConfiguratorConfig(["backup"], envelopeEnvironment).storage.ageRecipient, ageRecipient);
  for (const recipient of ["AGE-SECRET-KEY-private", "ssh-ed25519 key", `${ageRecipient} ${ageRecipient}`, `${ageRecipient}\n`, "/tmp/key"]) {
    assert.throws(() => loadConfiguratorConfig(["backup"], { ...envelopeEnvironment, BACKUP_AGE_RECIPIENT: recipient }));
  }
  assert.throws(() => loadConfiguratorConfig(["backup"], { ...envelopeEnvironment, BACKUP_ENCRYPTION_MODE: "NONE" }));
  assert.equal("zammadToken" in backupConfig, false);
  assert.throws(
    () => loadConfiguratorConfig(["backup"], { ...backupEnvironment, BACKUP_S3_SECRET_ACCESS_KEY: undefined }),
    (error) => error instanceof ConfiguratorConfigError && error.code === "BACKUP_S3_SECRET_ACCESS_KEY_MISSING",
  );

  const controlBackup = loadConfiguratorConfig(["control-backup"], {
    NODE_ENV: "production", DATABASE_URL: `postgresql://backup:${credential}@postgres.internal:5432/wasalx?sslmode=require`,
    DATABASE_NAME: "wasalx", WORKSPACE_REGION: "sa-riyadh-1", OBJECT_STORAGE_PREFIX: "control-plane/",
    BACKUP_S3_ENDPOINT: "https://s3.internal", BACKUP_S3_REGION: "sa-riyadh-1", BACKUP_S3_BUCKET: "wasalx-control-backups",
    BACKUP_S3_ACCESS_KEY_ID: credential, BACKUP_S3_SECRET_ACCESS_KEY: credential,
    BACKUP_S3_KMS_KEY_REFERENCE: "arn:aws:kms:sa-riyadh-1:111122223333:key/control",
    BACKUP_S3_LIFECYCLE_RULE_ID: "control-backup-retention", BACKUP_S3_PROVIDER: "aws-s3",
  });
  assert.equal(controlBackup.action, "control-backup");
  assert.equal("tenantId" in controlBackup, false);
  assert.equal("zammadBaseUrl" in controlBackup, false);
  assert.throws(
    () => loadConfiguratorConfig(["control-backup"], { ...backupEnvironment, OBJECT_STORAGE_PREFIX: "tenants/control-plane/" }),
    (error) => error instanceof ConfiguratorConfigError && error.code === "STORAGE_PREFIX_INVALID",
  );
});

test("package verification is read-only and requires the exact immutable package", async () => {
  const calls = [];
  const request = async (_url, init = {}) => {
    calls.push({ method: init.method ?? "GET", authorization: new Headers(init.headers).get("authorization") });
    assert.equal(init.method, undefined);
    assert.equal(new URL(_url).pathname, "/api/v1/wasalx/service/readiness");
    return Response.json({ tenant_id: tenantId, package: { name: "wasalx", version: packageVersion, state: "installed", sha256: packageSha256 } });
  };
  const client = new ZammadAdminClient(new URL("http://zammad.internal/"), credential, 5_000, request);
  const config = {
    action: "package", tenantId, zammadBaseUrl: new URL("http://zammad.internal/"), requestTimeoutMs: 5_000,
    outputDirectory: "/tmp", zammadToken: credential, packageVersion, packageSha256,
    packagePath: path.resolve(`build/zammad/wasalx-${packageVersion}.zpm`),
  };
  const result = await client.configurePackage(config);
  assert.deepEqual(result.package, { name: "wasalx", version: packageVersion, state: "installed", sha256: packageSha256 });
  await client.configurePackage(config);
  assert.equal(calls.filter((entry) => entry.method === "POST").length, 0);
  assert.ok(calls.every((entry) => entry.authorization === `Token token=${credential}`));

  const missing = new ZammadAdminClient(
    new URL("http://zammad.internal/"),
    credential,
    5_000,
    async (_url, init = {}) => {
      assert.equal(init.method, undefined);
      return Response.json({ tenant_id: tenantId, package: { name: "wasalx", version: packageVersion, state: "absent", sha256: packageSha256 } });
    },
  );
  await assert.rejects(
    () => missing.configurePackage(config),
    (error) => error instanceof ConfiguratorRuntimeError && error.code === "PACKAGE_VERIFY_FAILED",
  );
});

test("OIDC and defaults verify native setup through read-only readiness", async (t) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "wasalx-oidc-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? 'GET' });
    return Response.json({ tenant_id: tenantId,
      oidc: { client_id: 'wasalx-northstar', issuer: 'https://identity.example/realms/wasalx', uid_field: 'sub', scope: 'openid email profile', pkce: true, enabled: true, password_login_disabled: true },
      groups: [{ id: 7, name: 'Operations', active: true }],
    });
  };
  const client = new ZammadAdminClient(new URL("http://zammad.internal/"), credential, 5_000, request);
  const oidc = await runConfigurator({
    action: "oidc", tenantId, zammadBaseUrl: new URL("http://zammad.internal/"), requestTimeoutMs: 5_000,
    outputDirectory, zammadToken: credential, issuer: new URL("https://identity.example/realms/wasalx"),
    clientId: "wasalx-northstar", disablePasswordLogin: true,
  }, request);
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, "oidc.receipt.json"), "utf8")), oidc);
  assert.equal(JSON.stringify(oidc).includes(credential), false);
  assert.deepEqual(oidc.oidc, {
    issuer: "https://identity.example/realms/wasalx", client_id: "wasalx-northstar", pkce: true, password_login_disabled: true,
  });
  assert.deepEqual(calls, [{ path: "/api/v1/wasalx/service/readiness", method: "GET" }]);
  const defaults = await client.configureDefaults({
    action: "defaults", tenantId, zammadBaseUrl: new URL("http://zammad.internal/"), requestTimeoutMs: 5_000,
    outputDirectory: "/tmp", zammadToken: credential, initialGroup: "Operations", retentionDays: 90, backupPolicy: "daily-encrypted",
  });
  assert.deepEqual(defaults.defaults, {
    zammad_group_id: "7", zammad_group: "Operations", retention_days: 90, backup_policy: "daily-encrypted",
  });
});

test('readiness refuses OIDC public-setting drift and foreign workspace identity', async () => {
  const config = { action: 'oidc', tenantId, clientId: 'wasalx-northstar', issuer: new URL('https://identity.example/realms/wasalx'), disablePasswordLogin: true };
  const valid = { issuer: config.issuer.toString(), client_id: config.clientId, uid_field: 'sub', scope: 'openid email profile', pkce: true, enabled: true, password_login_disabled: true };
  for (const drift of [{ scope: 'openid' }, { scope: undefined }, { uid_field: 'email' }, { pkce: false }, { enabled: false }, { password_login_disabled: false }, { issuer: 'https://foreign.example' }, { client_id: 'foreign' }]) {
    const client = new ZammadAdminClient(new URL('https://native.example'), credential, 5000, async () => Response.json({ tenant_id: tenantId, oidc: { ...valid, ...drift } }));
    await assert.rejects(client.configureOidc(config), { code: 'OIDC_VERIFY_FAILED' });
  }
  const foreign = new ZammadAdminClient(new URL('https://native.example'), credential, 5000, async () => Response.json({ tenant_id: 'foreign', oidc: valid }));
  await assert.rejects(foreign.configureOidc(config), { code: 'WORKSPACE_IDENTITY_MISMATCH' });
});

test("Zammad response limits cancel oversized streams without awaiting cleanup", { timeout: 1000 }, async () => {
  const maximum = 5 * 1_024 * 1_024;
  for (const declared of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(declared ? 1 : maximum + 1));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const client = new ZammadAdminClient(new URL("https://native.example"), credential, 5000, async () =>
      new Response(body, { headers: declared ? { "content-length": String(maximum + 1) } : {} }));
    await assert.rejects(client.configureDefaults({ tenantId }), { code: "ZAMMAD_RESPONSE_TOO_LARGE" });
    assert.equal(cancelled, true);
  }
});

test("Zammad rejects unsuccessful responses without waiting for stream cancellation", { timeout: 1000 }, async () => {
  for (const status of [302, 400, 503]) {
    let cancelled = false;
    const client = new ZammadAdminClient(new URL("https://native.example"), credential, 10, async () =>
      new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { status }));
    await assert.rejects(client.configureDefaults({ tenantId }), { code: status >= 500 ? "ZAMMAD_UNAVAILABLE" : "ZAMMAD_REQUEST_REJECTED" });
    assert.equal(cancelled, true);
  }
});

test("Zammad request timeout remains active while the response body is pending", async () => {
  let signal;
  const client = new ZammadAdminClient(new URL("https://native.example"), credential, 10, async (_url, init) => {
    signal = init.signal;
    assert.equal(init.redirect, "error");
    return stalledResponse(signal);
  });
  await assert.rejects(client.configureDefaults({ tenantId }), { code: "ZAMMAD_UNAVAILABLE" });
  assert.equal(signal.aborted, true);
});

test("storage bounds protection and upload streams without awaiting cancellation", { timeout: 1000 }, async () => {
  const config = { endpoint: new URL("https://s3.example/"), region: "sa-riyadh-1", bucket: "wasalx-backups",
    accessKeyId: credential, secretAccessKey: credential, encryptionMode: "CLIENT_ENVELOPE", ageRecipient,
    lifecycleRuleId: "backup-retention", provider: "minio", prefix: "control-plane" };
  for (const operation of ["protection", "upload"]) for (const declared of [false, true]) {
    let cancelled = 0;
    const oversizedLength = operation === "protection" ? 1_048_577 : 65_537;
    const store = new S3BackupStore(config, 5000, async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(oversizedLength));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
      cancel() { cancelled += 1; return new Promise(() => {}); },
    }), { headers: declared ? { "content-length": String(oversizedLength) } : {} }));
    await assert.rejects(operation === "protection" ? store.protectionEvidence() :
      store.putBytesAndVerify("test", new Uint8Array([1]), "unused"), { code: "STORAGE_RESPONSE_TOO_LARGE" });
    assert.ok(cancelled > 0);
  }
});

test("storage request deadlines cover protection, upload and readback bodies", async () => {
  const config = { endpoint: new URL("https://s3.example/"), region: "sa-riyadh-1", bucket: "wasalx-backups",
    accessKeyId: credential, secretAccessKey: credential, encryptionMode: "CLIENT_ENVELOPE", ageRecipient,
    lifecycleRuleId: "backup-retention", provider: "minio", prefix: "control-plane" };
  for (const operation of ["protection", "upload", "readback"]) {
    const signals = [];
    const store = new S3BackupStore(config, 10, async (_url, init) => {
      if (operation === "readback" && init.method === "PUT") {
        return new Response(null, { headers: { "x-amz-version-id": "version-0001", "x-amz-request-id": "request-0001" } });
      }
      signals.push(init.signal);
      return stalledResponse(init.signal);
    });
    await assert.rejects(operation === "protection" ? store.protectionEvidence() :
      store.putBytesAndVerify("test", new Uint8Array([1]), "unused"), { code: "STORAGE_UNAVAILABLE" });
    assert.ok(signals.some((signal) => signal.aborted));
  }
});

function stalledResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), { once: true });
    },
  }));
}

test("S3 adapter signs requests, requires live protection, and reads the exact object version", async () => {
  const objects = new Map();
  const authorizations = [];
  const request = async (url, init = {}) => {
    const parsed = new URL(url);
    authorizations.push(new Headers(init.headers).get("authorization"));
    if (parsed.searchParams.has("versioning")) return xml("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
    if (parsed.searchParams.has("encryption")) return xml("<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>arn:aws:kms:test:key/1</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>");
    if (parsed.searchParams.has("lifecycle")) return xml("<LifecycleConfiguration><Rule><ID>tenant-backup-retention</ID></Rule></LifecycleConfiguration>");
    if (init.method === "PUT") {
      const chunks = [];
      if (init.body && Symbol.asyncIterator in Object(init.body)) for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(init.body));
      objects.set(parsed.pathname, Buffer.concat(chunks));
      return new Response(null, { status: 200, headers: { "x-amz-version-id": "version-0001", "x-amz-request-id": "request-0001" } });
    }
    return new Response(objects.get(parsed.pathname), { status: 200, headers: { "x-amz-version-id": "version-0001", "x-amz-request-id": "request-0002" } });
  };
  const store = new S3BackupStore({
    endpoint: new URL("https://s3.example/"), region: "sa-riyadh-1", bucket: "wasalx-backups",
    accessKeyId: credential, secretAccessKey: credential, kmsKeyReference: "arn:aws:kms:test:key/1",
    lifecycleRuleId: "tenant-backup-retention", provider: "aws-s3", prefix: `tenants/${tenantId}`,
  }, 5_000, request, () => new Date("2026-08-11T12:00:00.000Z"));
  const bytes = new TextEncoder().encode("verified backup bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal((await store.putBytesAndVerify(`tenants/${tenantId}/backups/proof.json`, bytes, digest)).objectVersionId, "version-0001");
  assert.ok(authorizations.every((value) => value?.startsWith("AWS4-HMAC-SHA256 Credential=")));
  assert.equal((await store.protectionEvidence()).versioningState, "Enabled");
});

test("storage retries refused reads within a bound, never writes or TLS/HTTP failures", async () => {
  const config = { endpoint: new URL("https://s3.example/"), region: "sa-riyadh-1", bucket: "wasalx-backups",
    accessKeyId: credential, secretAccessKey: credential, encryptionMode: "CLIENT_ENVELOPE", ageRecipient,
    lifecycleRuleId: "backup-retention", provider: "minio", prefix: "control-plane" };
  const refusal = () => new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  const attempts = new Map();
  const recovering = new S3BackupStore(config, 5000, async (url) => {
    const key = new URL(url).search;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (count === 1) throw refusal();
    return xml(key.includes("versioning") ? "<Status>Enabled</Status>" : "<ID>backup-retention</ID>");
  });
  assert.equal((await recovering.protectionEvidence()).versioningState, "Enabled");
  assert.deepEqual([...attempts.values()], [2, 2]);
  let refusedReads = 0;
  const unavailable = new S3BackupStore(config, 5000, async () => { refusedReads += 1; throw refusal(); });
  await assert.rejects(unavailable.protectionEvidence(), { code: "STORAGE_UNAVAILABLE" });
  assert.ok(refusedReads >= 7 && refusedReads <= 8); // Two concurrent reads, at most four attempts each.
  for (const failure of [refusal, () => new TypeError("TLS", { cause: { code: "CERT_HAS_EXPIRED" } })]) {
    let calls = 0;
    const store = new S3BackupStore(config, 5000, async () => { calls += 1; throw failure(); });
    await assert.rejects(store.putBytesAndVerify("test", Buffer.from("x"), "unused"), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(calls, 1);
  }
  for (const result of [() => { throw new TypeError("TLS", { cause: { code: "CERT_HAS_EXPIRED" } }); },
    () => new Response(null, { status: 503 })]) {
    let calls = 0;
    const store = new S3BackupStore(config, 5000, async () => { calls += 1; return result(); });
    await assert.rejects(store.protectionEvidence(), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(calls, 2);
  }
});

test("receipt guard permits only the verified disabled-login flag and rejects before writing", async (t) => {
  assert.doesNotThrow(() => assertSecretFree({ oidc: { password_login_disabled: true } }));
  assert.doesNotThrow(() => assertSecretFree({ oidc: { password_login_disabled: false } }));
  for (const value of ["true", credential, {}, [], null]) {
    assert.throws(() => assertSecretFree({ oidc: { password_login_disabled: value } }), { code: "UNSAFE_OUTPUT" });
  }
  for (const key of ["password", "token", "credential", "authorization", "database_url", "access_key", "password_login_disabled_extra"]) {
    assert.throws(() => assertSecretFree({ nested: [{ [key]: true }] }), { code: "UNSAFE_OUTPUT" });
  }
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "wasalx-unsafe-receipt-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  t.mock.method(ZammadAdminClient.prototype, "configureOidc", async () => ({ password: credential }));
  await assert.rejects(runConfigurator({
    action: "oidc", outputDirectory, zammadBaseUrl: new URL("http://zammad.internal/"),
    zammadToken: credential, requestTimeoutMs: 5_000,
  }), { code: "UNSAFE_OUTPUT" });
  assert.deepEqual(await readdir(outputDirectory), []);
});

test("Zammad startup reads recover without replaying configuration writes", async () => {
  const config = { action: "defaults", tenantId, initialGroup: "Operations", retentionDays: 90, backupPolicy: "daily-encrypted" };
  for (const existing of [true, false, null]) {
    let reads = 0;
    const writes = [];
    const client = new ZammadAdminClient(new URL("https://zammad.internal"), credential, 5000, async (_url, init) => {
      if ((init.method ?? "GET") === "GET") {
        reads += 1;
        if (reads === 1) throw new TypeError("refused", { cause: { code: "ECONNREFUSED" } });
        return Response.json({ tenant_id: tenantId, groups: existing === null ? [] : [{ id: 7, name: "Operations", active: existing }] });
      }
      writes.push(init.method);
      throw new TypeError("refused", { cause: { code: "ECONNREFUSED" } });
    });
    if (existing === true) assert.equal((await client.configureDefaults(config)).status, "SUCCEEDED");
    else await assert.rejects(client.configureDefaults(config), { code: "DEFAULTS_VERIFY_FAILED" });
    assert.deepEqual(writes, []);
    assert.equal(reads, 2);
  }
  let calls = 0;
  await assert.rejects(startupRequest(async () => {
    calls += 1;
    throw new TypeError("refused", { cause: { code: "ECONNREFUSED" } });
  }, new URL("https://zammad.internal"), { signal: AbortSignal.timeout(20) }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("client encryption preserves live storage gates without claiming server KMS", async () => {
  let protection = "valid";
  let stored;
  const config = { endpoint: new URL("https://s3.example/"), region: "sa-riyadh-1", bucket: "wasalx-backups",
    accessKeyId: credential, secretAccessKey: credential, encryptionMode: "CLIENT_ENVELOPE", ageRecipient,
    lifecycleRuleId: "backup-retention", provider: "minio", prefix: "control-plane" };
  const request = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.has("encryption"), false);
    assert.equal(new Headers(init.headers).has("x-amz-server-side-encryption"), false);
    if (parsed.searchParams.has("versioning")) return xml(`<Status>${protection === "versioning" ? "Suspended" : "Enabled"}</Status>`);
    if (parsed.searchParams.has("lifecycle")) return xml(`<ID>${protection === "lifecycle" ? "missing" : "backup-retention"}</ID>`);
    if (init.method === "PUT") stored = Buffer.from(init.body);
    else assert.equal(parsed.searchParams.get("versionId"), "cipher-version-1");
    return new Response(init.method === "PUT" ? null : protection === "readback" ? Buffer.from("corrupted") : stored,
      { headers: { "x-amz-version-id": protection === "object-version" ? "null" : "cipher-version-1", "x-amz-request-id": "request-000001" } });
  };
  const store = new S3BackupStore(config, 5000, request);
  assert.equal((await store.protectionEvidence()).encryption.keyReference, `key:${ageRecipient}`);
  for (protection of ["versioning", "lifecycle"]) await assert.rejects(store.protectionEvidence());
  protection = "valid";
  const bytes = Buffer.from("metadata");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await store.putBytesAndVerify("control-plane/backups/manifest.json", bytes, hash);
  for (protection of ["object-version", "readback"]) await assert.rejects(store.putBytesAndVerify("control-plane/backups/manifest.json", bytes, hash));
});

test("backup emits a validated DR manifest only after readback and removes plaintext staging", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wasalx-configurator-"));
  const uploaded = [];
  try {
    const config = {
      action: "backup", tenantId, zammadBaseUrl: new URL("http://unused.internal/"), requestTimeoutMs: 5_000, backupTimeoutMs: 60_000, outputDirectory: directory,
      database: { url: new URL(`postgresql://zammad:${credential}@postgres.internal:5432/zammad_${compact}?sslmode=require`), name: `zammad_${compact}` },
      region: "sa-riyadh-1",
      storage: { endpoint: new URL("https://s3.internal/"), region: "sa-riyadh-1", bucket: "wasalx-tenant-backups",
        accessKeyId: credential, secretAccessKey: credential, kmsKeyReference: "arn:aws:kms:test:key/1",
        lifecycleRuleId: "tenant-backup-retention", provider: "aws-s3", prefix: `tenants/${tenantId}` },
    };
    const store = {
      protectionEvidence: async () => ({ versioningState: "Enabled", lifecycleRuleId: "tenant-backup-retention",
        encryption: { mode: "SSE_KMS", algorithm: "aws:kms", keyReference: "arn:aws:kms:test:key/1" }, requestId: "request-live-0001" }),
      putFileAndVerify: async (objectKey, filePath, sha256, sizeBytes) => {
        const bytes = await readFile(filePath);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
        assert.equal(bytes.length, sizeBytes);
        uploaded.push(objectKey);
        return { objectVersionId: "artifact-version-1", requestId: "request-live-0002" };
      },
      putBytesAndVerify: async (objectKey, bytes, sha256) => {
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
        uploaded.push(objectKey);
        return { objectVersionId: "manifest-version-1", requestId: "request-live-0003" };
      },
    };
    const run = async (_command, args) => {
      if (args[0] === "--version") return { stdout: "pg_dump (PostgreSQL) 18.6\n" };
      const output = args.find((value) => value.startsWith("--file=")).slice("--file=".length);
      await writeFile(output, "custom-format-dump-fixture", { flag: "wx" });
      return { stdout: "" };
    };
    const result = await createVerifiedTenantBackup(config, { store, run,
      now: () => new Date("2026-08-11T12:00:00.000Z"), uuid: () => "40000000-0000-4000-8000-000000000001" });
    assert.equal(result.readback_verified, true);
    for (const stdout of ["pg_dump (PostgreSQL) 19.0", "invalid version"]) {
      await assert.rejects(createVerifiedTenantBackup(config, {
        store, run: async () => ({ stdout }),
      }), (error) => error.code === "PG_DUMP_VERSION_UNSUPPORTED");
    }
    assert.equal(uploaded.length, 2);
    const manifest = JSON.parse(await readFile(path.join(directory, `${result.backup_id}.manifest.json`), "utf8"));
    assert.equal(validateBackupManifest(manifest, new Date("2026-08-11T12:00:01.000Z")).manifestSha256, manifest.manifestSha256);
    assert.equal(JSON.stringify(result).includes(credential), false);
    const encryptedConfig = { ...config, storage: { ...config.storage, encryptionMode: "CLIENT_ENVELOPE", ageRecipient } };
    const encryptedStore = { ...store, protectionEvidence: async () => ({
      ...await store.protectionEvidence(), encryption: { mode: "CLIENT_ENVELOPE", algorithm: "age-x25519", keyReference: `key:${ageRecipient}` },
    }) };
    for (const scenario of ["valid", "copied", "non-age", "failed"]) {
      const before = uploaded.length;
      const encryptedRun = async (command, args, options) => {
        if (command !== "age") return run(command, args);
        assert.equal(options.env.NODE_ENV, "production");
        assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "NODE_ENV", "PATH"]);
        if (scenario === "failed") throw new Error("private process error");
        const bytes = scenario === "valid" ? "age-encryption.org/v1\nfixture ciphertext"
          : scenario === "copied" ? "custom-format-dump-fixture" : "invalid encrypted output";
        await writeFile(args[args.indexOf("--output") + 1], bytes, { flag: "wx" });
        return { stdout: "" };
      };
      const promise = createVerifiedTenantBackup(encryptedConfig, { store: encryptedStore, run: encryptedRun });
      if (scenario === "valid") {
        const encrypted = await promise;
        assert.ok(encrypted.artifact.object_key.endsWith(".dump.age"));
        assert.notEqual(encrypted.artifact.ciphertext_sha256, encrypted.artifact.sha256);
        const manifest = JSON.parse(await readFile(encrypted.manifest.local_path, "utf8"));
        assert.equal(validateBackupManifest(manifest).artifact.ciphertextSha256, encrypted.artifact.ciphertext_sha256);
        assert.equal(uploaded.length, before + 2);
      } else {
        await assert.rejects(promise, (error) => error.code === (scenario === "failed" ? "BACKUP_ENCRYPTION_FAILED" : "BACKUP_ENCRYPTION_INVALID"));
        assert.equal(uploaded.length, before);
      }
      assert.equal((await readdir(directory)).some((name) => name.endsWith(".partial")), false);
    }
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".dump") || name.endsWith(".partial")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("control-plane backup reuses verified storage with the reserved workload prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wasalx-control-backup-"));
  const uploaded = [];
  try {
    const config = {
      action: "control-backup", requestTimeoutMs: 5_000, backupTimeoutMs: 60_000, outputDirectory: directory,
      database: { url: new URL(`postgresql://backup:${credential}@postgres.internal:5432/wasalx?sslmode=require`), name: "wasalx" },
      region: "sa-riyadh-1",
      storage: { endpoint: new URL("https://s3.internal/"), region: "sa-riyadh-1", bucket: "wasalx-control-backups",
        accessKeyId: credential, secretAccessKey: credential, kmsKeyReference: "arn:aws:kms:test:key/control",
        lifecycleRuleId: "control-backup-retention", provider: "aws-s3", prefix: "control-plane" },
    };
    const store = {
      protectionEvidence: async () => ({ versioningState: "Enabled", lifecycleRuleId: "control-backup-retention",
        encryption: { mode: "SSE_KMS", algorithm: "aws:kms", keyReference: "arn:aws:kms:test:key/control" }, requestId: "request-live-control-1" }),
      putFileAndVerify: async (objectKey, filePath, sha256, sizeBytes) => {
        const bytes = await readFile(filePath);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
        assert.equal(bytes.length, sizeBytes);
        uploaded.push(objectKey);
        return { objectVersionId: "artifact-control-version-1", requestId: "request-live-control-2" };
      },
      putBytesAndVerify: async (objectKey, bytes, sha256) => {
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
        uploaded.push(objectKey);
        return { objectVersionId: "manifest-control-version-1", requestId: "request-live-control-3" };
      },
    };
    const run = async (_command, args) => {
      if (args[0] === "--version") return { stdout: "pg_dump (PostgreSQL) 18.6\n" };
      const output = args.find((value) => value.startsWith("--file=")).slice("--file=".length);
      await writeFile(output, "control-plane-custom-format-dump", { flag: "wx" });
      return { stdout: "" };
    };
    const result = await createVerifiedBackup(config, { store, run,
      now: () => new Date("2026-08-13T18:00:00.000Z"), uuid: () => "40000000-0000-4000-8000-000000000002" });
    const manifest = JSON.parse(await readFile(path.join(directory, `${result.backup_id}.manifest.json`), "utf8"));
    assert.equal(manifest.workload.kind, "control-plane");
    assert.equal(manifest.workload.tenantId, null);
    assert.equal(manifest.storage.objectKey.startsWith("control-plane/backups/"), true);
    assert.equal(validateBackupManifest(manifest, new Date("2026-08-13T18:00:01.000Z")).manifestSha256, manifest.manifestSha256);
    assert.equal(uploaded.length, 2);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".dump") || name.endsWith(".partial")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure output contains only a bounded safe code", () => {
  const error = Object.assign(new Error(`database ${credential}`), { code: "STORAGE_UNAVAILABLE", password: credential });
  assert.deepEqual(safeError(error), { status: "FAILED", code: "STORAGE_UNAVAILABLE" });
});

function xml(body) {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml", "x-amz-request-id": "request-0000" } });
}
