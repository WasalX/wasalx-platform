import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FileBearerAuthenticator } from "../services/workspace-provider/dist/auth.js";
import { loadWorkspaceProviderConfig } from "../services/workspace-provider/dist/config.js";
import { buildProviderResource, KubernetesProviderGateway, validateReadyEvidence } from "../services/workspace-provider/dist/kubernetes.js";
import { WorkspaceProviderService } from "../services/workspace-provider/dist/service.js";
import { parseProviderRequest, ProviderError } from "../services/workspace-provider/dist/types.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";

function request(overrides = {}) {
  const value = {
    version: 1,
    tenant_id: tenantId,
    operation_id: "33333333-3333-4333-8333-333333333333",
    action: "verify",
    generation: 7,
    fencing_token: 19,
    idempotency_key: `controller:${tenantId}:verify:${"a".repeat(64)}:r30000000`,
    desired: {
      tenant_id: tenantId,
      slug: "acme",
      region: "sa-central-1",
      owner: { oidcSubject: "owner", email: "owner@example.com", displayName: "Owner" },
      database: { isolation: "DedicatedDatabaseAndRole", databaseName: "zammad_11111111111141118111111111111111", roleName: "zammad_11111111111141118111111111111111", secretReference: `secret://tenants/${tenantId}/zammad/database` },
      search: { isolation: "DedicatedNamespaceAndCredential", namespace: "wasalx_11111111111141118111111111111111", secretReference: `secret://tenants/${tenantId}/zammad/search` },
      storage: { isolation: "DedicatedPrefixAndCredential", prefix: `tenants/${tenantId}/`, secretReference: `secret://tenants/${tenantId}/zammad/storage` },
      service_secret_reference: `secret://tenants/${tenantId}/zammad/service`,
      privacy_secret_reference: `secret://tenants/${tenantId}/zammad/privacy`,
      zammad: { instanceId, version: "7.1.3", hostname: "acme.support.example.com", packageVersion: "0.5.5", packageSha256: "a".repeat(64) },
      oidc: { issuer: "https://identity.example.com/realms/wasalx", clientId: "wasalx-acme", secretReference: `secret://tenants/${tenantId}/zammad/oidc`, disablePasswordLogin: true },
      retention_days: 365,
      desired_state: "Active",
      desired_step: "secrets",
    },
    ...overrides,
  };
  if (overrides.idempotency_key) return value;
  const context = { ...value };
  delete context.idempotency_key;
  const refreshSequence = ["verify", "suspend", "resume"].includes(value.action) ? 30000000 : 0;
  const requestIdentity = createHash("sha256").update(canonicalJson(context)).digest("hex");
  return { ...value, idempotency_key: `controller:${value.tenant_id}:${value.action}:${requestIdentity}:r${refreshSequence}` };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

test("provider request parser rejects route and tenant binding mismatches", () => {
  assert.equal(parseProviderRequest(request(), tenantId, "verify").desired.zammad.instanceId, instanceId);
  assert.throws(() => parseProviderRequest(request(), tenantId, "database"), (error) => error instanceof ProviderError && error.code === "REQUEST_INVALID");
  assert.throws(() => parseProviderRequest({ ...request(), unexpected: true }, tenantId, "verify"), /invalid/u);
  assert.throws(() => parseProviderRequest({ ...request(), desired: { ...request().desired, zammad: { ...request().desired.zammad, password: "must-not-cross-boundary" } } }, tenantId, "verify"), /invalid/u);
});

test("provider authentication and operator readiness configuration fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-provider-auth-"));
  const tokenFile = join(directory, "token");
  const token = "provider-token-that-is-at-least-thirty-two-bytes";
  await writeFile(tokenFile, token, { mode: 0o600 });
  const auth = new FileBearerAuthenticator(tokenFile);
  await auth.authenticate(`Bearer ${token}`);
  await assert.rejects(() => auth.authenticate("Bearer incorrect-token-that-is-long-enough-123"), (error) => error.code === "AUTHENTICATION_REQUIRED");
  const base = {
    NODE_ENV: "production",
    PORT: "8092",
    WORKSPACE_PROVIDER_DATABASE_URL: "postgresql://runtime@postgres.internal/provider",
    WORKSPACE_PROVIDER_TOKEN_FILE: tokenFile,
    WORKSPACE_PROVIDER_TLS_CERT_FILE: "/tls/tls.crt",
    WORKSPACE_PROVIDER_TLS_KEY_FILE: "/tls/tls.key",
    KUBERNETES_API_URL: "https://kubernetes.default.svc",
    KUBERNETES_TOKEN_FILE: "/kubernetes/token",
    KUBERNETES_CA_FILE: "/kubernetes/ca.crt",
    WORKSPACE_PROVIDER_NAMESPACE: "wasalx",
    WORKSPACE_PROVIDER_FIELD_MANAGER: "wasalx-workspace-provider-v1",
  };
  assert.throws(() => loadWorkspaceProviderConfig(base), /OPERATOR_DEPLOYMENTS/u);
  const config = loadWorkspaceProviderConfig({ ...base, WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON: JSON.stringify({ identity: "idp-operator", database: "postgres-operator", search: "search-operator", storage: "storage-operator", secrets: "secrets-operator" }) });
  assert.equal(config.operatorDeployments.database, "postgres-operator");
});

test("provider response errors reject reconciliation without crashing on oversized or interrupted streams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-provider-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  const caFile = join(directory, "ca");
  await writeFile(tokenFile, "rotated-kubernetes-token-12345", { mode: 0o600 });
  await writeFile(caFile, "test-ca");
  for (const failure of ["oversized", "interrupted"]) {
    const gateway = new KubernetesProviderGateway({
      kubernetesTokenFile: tokenFile, kubernetesCaFile: caFile,
      kubernetesApiUrl: new URL("https://kubernetes.default.svc/"),
      namespace: "wasalx", fieldManager: "wasalx-workspace-provider", requestTimeoutMs: 1000,
    }, (_url, options, callback) => {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.headers.authorization, "Bearer rotated-kubernetes-token-12345");
      const clientRequest = new EventEmitter();
      clientRequest.write = () => true;
      clientRequest.end = () => queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        callback(response);
        if (failure === "oversized") response.end(Buffer.alloc(256_001));
        else response.destroy(new Error("socket reset with private upstream detail"));
      });
      return clientRequest;
    });
    await assert.rejects(gateway.reconcile(parseProviderRequest(request(), tenantId, "verify")), (error) => {
      assert.equal(error.code, failure === "oversized" ? "KUBERNETES_RESPONSE_TOO_LARGE" : "KUBERNETES_UNAVAILABLE");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /private upstream detail/u);
      return true;
    });
  }
});

test("declarative provider resource carries only secret references and immutable instance binding", () => {
  const parsed = parseProviderRequest(request(), tenantId, "verify");
  const resource = buildProviderResource(parsed, "wasalx");
  assert.equal(resource.spec.resourceType, "secrets");
  assert.equal(resource.spec.refreshSequence, 30000000);
  assert.match(resource.spec.requestContextSha256, /^[0-9a-f]{64}$/u);
  const refreshed = buildProviderResource({ ...parsed, idempotency_key: `controller:${tenantId}:verify:${resource.spec.requestContextSha256}:r30000001` }, "wasalx");
  assert.equal(refreshed.spec.refreshSequence, 30000001);
  assert.equal(refreshed.spec.requestContextSha256, resource.spec.requestContextSha256);
  assert.deepEqual(resource.spec.secretBindings, {
    service: {
      reference: `secret://tenants/${tenantId}/zammad/service`,
      immutableProperties: {
        instance_id: instanceId,
        redis_host: "zammad-11111111111141118111111111111111-redis.wasalx.svc",
        redis_username: "zammad",
      },
    },
    privacy: { reference: `secret://tenants/${tenantId}/zammad/privacy` },
  });
  assert.doesNotMatch(JSON.stringify(resource), /"(?:password|private_key|secret_value)"\s*:/iu);
  assert.throws(
    () => buildProviderResource({ ...parsed, idempotency_key: `controller:${tenantId}:verify:${resource.spec.requestContextSha256}:r0` }, "wasalx"),
    (error) => error instanceof ProviderError && error.code === "IDEMPOTENCY_KEY_INVALID",
  );
});

test("resume reverses the exact persistent suspension resource", () => {
  const suspended = buildProviderResource(
    parseProviderRequest(request({
      action: "suspend",
      desired: { ...request().desired, desired_state: "Suspended", desired_step: "suspend" },
    }), tenantId, "suspend"),
    "wasalx",
  );
  const resumed = buildProviderResource(
    parseProviderRequest(request({
      action: "resume",
      desired: { ...request().desired, desired_state: "Active", desired_step: "resume_prepare" },
    }), tenantId, "resume"),
    "wasalx",
  );
  assert.equal(resumed.metadata.name, suspended.metadata.name);
  assert.equal(resumed.spec.resourceType, "suspend");
  assert.equal(suspended.spec.lifecycle, "Suspended");
  assert.equal(resumed.spec.lifecycle, "Present");
  resumed.metadata.generation = 8;
  resumed.status = {
    phase: "READY",
    observedGeneration: 8,
    fencingToken: 19,
    idempotencyKey: resumed.spec.idempotencyKey,
    evidence: {
      resumed: true,
      credentials_enabled: true,
      provider_resumed_at: new Date().toISOString(),
    },
  };
  assert.equal(validateReadyEvidence(
    parseProviderRequest(request({
      action: "resume",
      desired: { ...request().desired, desired_state: "Active", desired_step: "resume_prepare" },
    }), tenantId, "resume"),
    resumed,
  ).credentials_enabled, true);
});

test("resume health verification reuses the durable health resource contract", () => {
  for (const desiredStep of ["resume_prepare", "resume_publish"]) {
    const parsed = parseProviderRequest(request({
      action: "verify",
      desired: { ...request().desired, desired_state: "Active", desired_step: desiredStep },
    }), tenantId, "verify");
    const resource = buildProviderResource(parsed, "wasalx");
    assert.equal(resource.spec.resourceType, "health");
    resource.metadata.generation = 8;
    resource.status = {
      phase: "READY",
      observedGeneration: 8,
      fencingToken: parsed.fencing_token,
      idempotencyKey: parsed.idempotency_key,
      evidence: {
        healthy: true,
        isolation_verified: true,
        zammad_base_url: "https://acme.support.example.com",
        checked_at: new Date().toISOString(),
      },
    };
    assert.equal(validateReadyEvidence(parsed, resource).healthy, true);
  }
});

test("READY evidence is fenced and service-secret instance-bound without returning instance_id", () => {
  const parsed = parseProviderRequest(request(), tenantId, "verify");
  const resource = buildProviderResource(parsed, "wasalx");
  resource.metadata.generation = 4;
  resource.status = {
    phase: "READY",
    observedGeneration: 4,
    fencingToken: 19,
    idempotencyKey: parsed.idempotency_key,
    secretBindings: {
      service: {
        reference: parsed.desired.service_secret_reference,
        properties: {
          instance_id: instanceId,
          redis_host: "zammad-11111111111141118111111111111111-redis.wasalx.svc",
          redis_username: "zammad",
        },
      },
    },
    evidence: {
      service_secret_reference: parsed.desired.service_secret_reference,
      privacy_secret_reference: parsed.desired.privacy_secret_reference,
    },
  };
  assert.deepEqual(validateReadyEvidence(parsed, resource), resource.status.evidence);
  assert.equal(Object.hasOwn(validateReadyEvidence(parsed, resource), "instance_id"), false);
  resource.status.secretBindings.service.properties.instance_id = "44444444-4444-4444-8444-444444444444";
  assert.throws(() => validateReadyEvidence(parsed, resource), (error) => error instanceof ProviderError && error.code === "SERVICE_SECRET_INSTANCE_MISMATCH");
  resource.status.secretBindings.service.properties.instance_id = instanceId;
  resource.status.evidence.unexpected = "unsafe-contract-drift";
  assert.throws(() => validateReadyEvidence(parsed, resource), (error) => error instanceof ProviderError && error.code === "PROVIDER_EVIDENCE_INVALID");
});

test("provider service persists success, replays deterministically, and compensates terminal failures", async () => {
  const input = parseProviderRequest(request({ action: "database", desired: { ...request().desired, desired_step: "database" } }), tenantId, "database");
  const calls = [];
  const store = {
    async claim() { return { kind: "CLAIMED", token: "claim" }; },
    async complete(_input, token, response) { calls.push(["complete", token, response.status]); },
    async release() { calls.push(["release"]); },
    async fail(_input, token, code, pending) { calls.push(["fail", token, code, pending]); },
    async rollbackIfAuthoritative(_input, token, rollback) {
      calls.push(["rollback-authorized", token]);
      await rollback();
      return true;
    },
    async ready() { return true; },
    async close() {},
  };
  const gateway = {
    async reconcile() { return { database_reference: "postgresql://postgres.internal/zammad", database_role: "role", database_secret_reference: input.desired.service_secret_reference }; },
    async rollback() { calls.push(["rollback"]); },
    async ready() { return true; },
  };
  const service = new WorkspaceProviderService(store, gateway);
  assert.equal((await service.execute(input)).status, "READY");
  assert.deepEqual(calls, [["complete", "claim", "READY"]]);

  gateway.reconcile = async () => { throw new ProviderError(409, "DENIED", "Denied."); };
  await assert.rejects(() => service.execute(input), (error) => error.code === "DENIED");
  assert.deepEqual(calls.slice(1), [["fail", "claim", "DENIED", true], ["rollback-authorized", "claim"], ["rollback"]]);

  store.rollbackIfAuthoritative = async () => {
    calls.push(["rollback-superseded"]);
    return false;
  };
  await assert.rejects(() => service.execute(input), (error) => error.code === "DENIED");
  assert.equal(calls.at(-1)[0], "rollback-superseded");
  assert.equal(calls.filter(([operation]) => operation === "rollback").length, 1);
});
