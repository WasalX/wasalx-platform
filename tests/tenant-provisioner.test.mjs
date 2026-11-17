import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import {
  authenticateProvisioningRequest,
  parseRequest,
} from "../services/tenant-provisioner/dist/auth.js";
import {
  loadConfig,
  privateKubernetesUrl,
} from "../services/tenant-provisioner/dist/config.js";
import { KubernetesWorkspaceClient } from "../services/tenant-provisioner/dist/kubernetes.js";
import {
  TenantWorkspaceReconciler,
  desiredResource,
} from "../services/tenant-provisioner/dist/reconciler.js";
import { ProvisionerError } from "../services/tenant-provisioner/dist/types.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const zammadInstanceId = "40000000-0000-4000-8000-000000000001";
const jwtSecret = "tenant-provisioner-test-secret-at-least-32-bytes";
const packageSha256 = "a".repeat(64);
const release = {
  packageVersion: "0.3.0",
  packageSha256,
  images: {
    zammad: `registry.example.test/zammad@sha256:${"b".repeat(64)}`,
    configurator: `registry.example.test/configurator@sha256:${"c".repeat(64)}`,
    nginx: `registry.example.test/nginx@sha256:${"d".repeat(64)}`,
    redis: `registry.example.test/redis@sha256:${"e".repeat(64)}`,
    memcached: `registry.example.test/memcached@sha256:${"f".repeat(64)}`,
  },
};
const spec = {
  tenant: { name: "Northstar", slug: "northstar", retentionDays: 90 },
  owner: {
    oidcSubject: "owner-subject",
    email: "owner@example.test",
    displayName: "Tenant Owner",
  },
  deployment: {
    region: "sa-riyadh-1",
    resourceProfile: "small",
    zammadVersion: "7.0.1",
    release,
  },
};

function request(overrides = {}) {
  return {
    version: 1,
    operationId,
    zammadInstanceId,
    tenantId,
    action: "PROVISION",
    step: "identity",
    fencingToken: 7,
    idempotencyKey: `provision:${tenantId}:${operationId}:identity`,
    spec,
    completedSteps: [],
    priorResults: {},
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    port: 8090,
    signingSecret: new TextEncoder().encode(jwtSecret),
    kubernetesApiUrl: new URL("https://kubernetes.default.svc/"),
    kubernetesTokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    workspaceNamespace: "wasalx-tenants",
    reconcilerIdentity: "wasalx-workspace-controller/v1",
    workspaceBaseDomain: "support.example.test",
    oidcIssuer: "https://identity.example.test/realms/wasalx",
    reconcileTimeoutMs: 1_000,
    pollIntervalMs: 100,
    kubernetesRequestTimeoutMs: 5_000,
    ...overrides,
  };
}

test("provisioner accepts only private Kubernetes APIs and fails closed on missing production dependencies", () => {
  assert.equal(privateKubernetesUrl("https://kubernetes.default.svc", true).hostname, "kubernetes.default.svc");
  assert.equal(privateKubernetesUrl("https://127.0.0.1", true).hostname, "127.0.0.1");
  assert.throws(() => privateKubernetesUrl("https://api.example.com", true), /private/);
  assert.throws(() => privateKubernetesUrl("http://kubernetes.default.svc", true, true), /private/);
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /required/);
  const loaded = loadConfig({
    NODE_ENV: "development",
    PROVISIONING_DRIVER_JWT_SECRET: jwtSecret,
    KUBERNETES_API_URL: "https://kubernetes.default.svc",
    PROVISIONING_RECONCILER_IDENTITY: "wasalx-workspace-controller/v1",
    PROVISIONING_WORKSPACE_BASE_DOMAIN: "support.example.test",
    PROVISIONING_OIDC_ISSUER: "https://identity.example.test/realms/wasalx",
    WASALX_ZAMMAD_PACKAGE_VERSION: "stale",
    WASALX_ZAMMAD_PACKAGE_SHA256: "stale",
  });
  assert.equal("packageVersion" in loaded, false);
  assert.equal("packageSha256" in loaded, false);
});

test("internal request authentication binds every fenced body field to a short-lived JWT", async () => {
  const now = 1_800_000_000;
  const body = request();
  const rawBody = JSON.stringify(body);
  const token = await sign(body, now, rawBody);
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": body.idempotencyKey,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await authenticateProvisioningRequest(
      headers,
      rawBody,
      new TextEncoder().encode(jwtSecret),
      now,
    ))),
    body,
  );

  const changedFence = { ...body, fencingToken: 8 };
  await assert.rejects(
    () => authenticateProvisioningRequest(headers, JSON.stringify(changedFence), new TextEncoder().encode(jwtSecret), now),
    (error) => error instanceof ProvisionerError && error.code === "AUTHENTICATION_CONTEXT_MISMATCH",
  );
  await assert.rejects(
    () => authenticateProvisioningRequest(headers, `${rawBody} `, new TextEncoder().encode(jwtSecret), now),
    (error) => error instanceof ProvisionerError && error.code === "AUTHENTICATION_CONTEXT_MISMATCH",
  );
  await assert.rejects(
    () => authenticateProvisioningRequest(headers, `\uFEFF${rawBody}`, new TextEncoder().encode(jwtSecret), now),
    (error) => error instanceof ProvisionerError && error.code === "REQUEST_INVALID",
  );
  assert.throws(
    () => parseRequest({ ...body, step: "database" }),
    (error) => error instanceof ProvisionerError && error.code === "STEP_ORDER_INVALID",
  );
  for (const image of Object.keys(release.images)) {
    const missing = structuredClone(body);
    delete missing.spec.deployment.release.images[image];
    assert.throws(
      () => parseRequest(missing),
      (error) => error instanceof ProvisionerError && error.code === "REQUEST_INVALID",
      `${image} must be required`,
    );
  }
  const mutableImage = structuredClone(body);
  mutableImage.spec.deployment.release.images.nginx = "registry.example.test/nginx:latest";
  assert.throws(
    () => parseRequest(mutableImage),
    (error) => error instanceof ProvisionerError && error.code === "REQUEST_INVALID",
  );
});

test("desired workspace declaratively requires every isolated runtime resource without embedding credentials", () => {
  const desired = desiredResource(config(), request());
  assert.equal(desired.spec.database.isolation, "DedicatedDatabaseAndRole");
  assert.equal(desired.spec.database.databaseName, `zammad_${tenantId.replaceAll("-", "")}`);
  assert.equal(desired.spec.search.isolation, "DedicatedNamespaceAndCredential");
  assert.equal(desired.spec.storage.prefix, `tenants/${tenantId}/`);
  assert.equal(desired.spec.zammad.hostname, "northstar.support.example.test");
  assert.equal(desired.spec.zammad.instanceId, zammadInstanceId);
  assert.equal(desired.spec.zammad.image, release.images.zammad);
  assert.equal(desired.spec.zammad.configuratorImage, release.images.configurator);
  assert.equal(desired.spec.zammad.nginxImage, release.images.nginx);
  assert.equal(desired.spec.zammad.redisImage, release.images.redis);
  assert.equal(desired.spec.zammad.memcachedImage, release.images.memcached);
  assert.equal(desired.spec.zammad.packageVersion, release.packageVersion);
  assert.equal(desired.spec.zammad.packageSha256, packageSha256);
  assert.equal(desired.spec.oidc.disablePasswordLogin, true);
  assert.equal(desired.spec.oidc.secretReference, `secret://tenants/${tenantId}/zammad/oidc`);
  assert.equal(desired.spec.defaults.backupPolicy, "daily-encrypted");
  assert.equal(desired.spec.request.fencingToken, 7);
  assert.match(desired.spec.database.secretReference, /^secret:\/\/tenants\//);
  assert.equal(desired.spec.secrets.privacySecretReference, `secret://tenants/${tenantId}/zammad/privacy`);
  assert.doesNotMatch(JSON.stringify(desired), /"(?:password|apiKey|bearer|rawCredential)"\s*:/i);
});

test("reconciler reports success only after the named controller observes generation, fence, idempotency, and real outputs", async () => {
  let applied;
  const client = {
    get: async () => null,
    apply: async (resource) => {
      applied = structuredClone(resource);
      return readyWorkspace(resource, "identity", {
        identity_id: "keycloak-client-northstar",
        oidc_client_id: `wasalx-${tenantId.replaceAll("-", "")}`,
        oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
      });
    },
    ready: async () => true,
  };
  const result = await new TenantWorkspaceReconciler(config(), client).execute(request());
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.outputs.identity_id, "keycloak-client-northstar");
  assert.equal(applied.metadata.resourceVersion, undefined);
  assert.equal(applied.spec.request.idempotencyKey, request().idempotencyKey);
});

test("stale workers and unsafe reconciler evidence fail closed", async () => {
  const newer = request({ fencingToken: 9 });
  const current = desiredResource(config(), newer);
  current.metadata.generation = 3;
  current.metadata.resourceVersion = "41";
  const staleClient = {
    get: async () => current,
    apply: async () => assert.fail("stale work must not reach Kubernetes apply"),
    ready: async () => true,
  };
  await assert.rejects(
    () => new TenantWorkspaceReconciler(config(), staleClient).execute(request()),
    (error) => error instanceof ProvisionerError && error.code === "STALE_FENCING_TOKEN",
  );

  const databaseRequest = request({
    step: "database",
    fencingToken: 10,
    idempotencyKey: `provision:${tenantId}:${operationId}:database`,
    completedSteps: ["identity"],
    priorResults: {
      identity: {
        identity_id: "identity-ready",
        oidc_client_id: `wasalx-${tenantId.replaceAll("-", "")}`,
        oidc_secret_reference: `secret://tenants/${tenantId}/zammad/oidc`,
      },
    },
  });
  const unsafeClient = {
    get: async () => null,
    apply: async (resource) => readyWorkspace(resource, "database", {
      database_reference: "postgresql://fixture:placeholder@db.example.test:5432/example_db",
      database_role: `zammad_${tenantId.replaceAll("-", "")}`,
      database_secret_reference: `secret://tenants/${tenantId}/zammad/database`,
    }),
    ready: async () => true,
  };
  await assert.rejects(
    () => new TenantWorkspaceReconciler(config(), unsafeClient).execute(databaseRequest),
    (error) => error instanceof ProvisionerError && error.code === "RECONCILER_OUTPUT_INVALID",
  );
});

test("a new fence cannot silently mutate immutable tenant provisioning inputs", async () => {
  const current = desiredResource(config(), request({ fencingToken: 7 }));
  current.metadata.generation = 2;
  current.metadata.resourceVersion = "40";
  const changed = request({
    fencingToken: 8,
    spec: {
      ...spec,
      deployment: { ...spec.deployment, resourceProfile: "large" },
    },
  });
  await assert.rejects(
    () => new TenantWorkspaceReconciler(config(), {
      get: async () => current,
      apply: async () => assert.fail("immutable drift must not reach Kubernetes apply"),
      ready: async () => true,
    }).execute(changed),
    (error) => error instanceof ProvisionerError && error.code === "WORKSPACE_SPEC_IMMUTABLE",
  );

  const cases = [
    { runtime: config({ workspaceBaseDomain: "other.example.test" }), input: request({ fencingToken: 8 }) },
    { runtime: config({ oidcIssuer: "https://other.example.test/realms/wasalx" }), input: request({ fencingToken: 8 }) },
    { runtime: config(), input: request({ fencingToken: 8, zammadInstanceId: "50000000-0000-4000-8000-000000000001" }) },
    { runtime: config(), input: request({ fencingToken: 8, spec: { ...spec, deployment: { ...spec.deployment, release: { ...release, packageVersion: "0.3.1" } } } }) },
    { runtime: config(), input: request({ fencingToken: 8, spec: { ...spec, deployment: { ...spec.deployment, release: { ...release, images: { ...release.images, redis: `registry.example.test/redis@sha256:${"0".repeat(64)}` } } } } }) },
  ];
  for (const entry of cases) {
    await assert.rejects(
      () => new TenantWorkspaceReconciler(entry.runtime, {
        get: async () => current,
        apply: async () => assert.fail("immutable drift must not reach Kubernetes apply"),
        ready: async () => true,
      }).execute(entry.input),
      (error) => error instanceof ProvisionerError && error.code === "WORKSPACE_SPEC_IMMUTABLE",
    );
  }
});

test("pending reconciliation times out as retryable and never invents success", async () => {
  let now = 0;
  let pending;
  const client = {
    get: async () => pending ?? null,
    apply: async (resource) => {
      pending = { ...structuredClone(resource), metadata: { ...resource.metadata, generation: 1 } };
      return pending;
    },
    ready: async () => true,
  };
  await assert.rejects(
    () => new TenantWorkspaceReconciler(
      config({ reconcileTimeoutMs: 200, pollIntervalMs: 100 }),
      client,
      { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } },
    ).execute(request()),
    (error) => error instanceof ProvisionerError && error.code === "RECONCILIATION_PENDING" && error.retryable,
  );
});

test("Kubernetes client uses server-side apply, a rotated token file, bounded reads, and no redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-provisioner-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "rotated-service-account-token", { mode: 0o600 });
  const observed = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    observed.push({ input: String(input), init });
    const resource = desiredResource(config(), request());
    resource.metadata.generation = 1;
    return Response.json(resource);
  };
  try {
    const client = new KubernetesWorkspaceClient(config({ kubernetesTokenFile: tokenFile }));
    await client.apply(desiredResource(config(), request()));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(observed[0].init.method, "PATCH");
  assert.equal(observed[0].init.redirect, "error");
  assert.equal(new Headers(observed[0].init.headers).get("authorization"), "Bearer rotated-service-account-token");
  assert.equal(new Headers(observed[0].init.headers).get("content-type"), "application/apply-patch+yaml");
  assert.match(observed[0].input, /tenantworkspaces\/tenant-10000000-0000-4000-8000-000000000001\?fieldManager=/);
});

async function sign(body, now, rawBody = JSON.stringify(body)) {
  return new SignJWT({
    scope: "tenant:provision",
    tenant_id: body.tenantId,
    operation_id: body.operationId,
    zammad_instance_id: body.zammadInstanceId,
    action: body.action,
    step: body.step,
    fencing_token: body.fencingToken,
    idempotency_key: body.idempotencyKey,
    request_sha256: createHash("sha256").update(rawBody).digest("hex"),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("wasalx-control-plane")
    .setAudience("wasalx-provisioning-driver")
    .setSubject("tenant-provisioning-worker")
    .setJti("30000000-0000-4000-8000-000000000001")
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .sign(new TextEncoder().encode(jwtSecret));
}

function readyWorkspace(resource, step, outputs) {
  return {
    ...structuredClone(resource),
    metadata: { ...resource.metadata, generation: 1, resourceVersion: "40" },
    status: {
      observedGeneration: 1,
      observedFencingToken: resource.spec.request.fencingToken,
      lastAppliedIdempotencyKey: resource.spec.request.idempotencyKey,
      reconciler: "wasalx-workspace-controller/v1",
      conditions: [{ type: `${step[0].toUpperCase()}${step.slice(1)}Ready`, status: "True", observedGeneration: 1 }],
      outputs: { [step]: outputs },
    },
  };
}
