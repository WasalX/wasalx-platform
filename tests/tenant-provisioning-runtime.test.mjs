import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { jwtVerify } from "jose";
import { ServiceUnavailableException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import {
  PlatformOperatorGuard,
  assertPlatformOperatorClaims,
} from "../services/control-api/dist/platform-operator-auth.js";
import {
  HttpTenantProvisioningDriver,
  ProvisioningDriverError,
  validateDriverResult,
} from "../services/control-api/dist/tenant-provisioning.driver.js";
import {
  parseResumeReason,
  parseSpec,
} from "../services/control-api/dist/tenant-provisioning.controller.js";
import {
  TenantProvisioningService,
  configuredRelease,
  requestHash,
} from "../services/control-api/dist/tenant-provisioning.service.js";
import {
  StaleTenantProvisioningLeaseError,
  executeProvisioningTask,
  nextStep,
} from "../services/control-api/dist/tenant-provisioning.worker.js";
import { parseRequest as parseProvisionerRequest } from "../services/tenant-provisioner/dist/auth.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const leaseId = "30000000-0000-4000-8000-000000000001";
const zammadInstanceId = "40000000-0000-4000-8000-000000000001";

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
  },
};
const release = {
  packageVersion: "0.5.80",

  packageSha256: "a".repeat(64),
  images: {
    zammad: `registry.example.test/zammad@sha256:${"b".repeat(64)}`,
    configurator: `registry.example.test/configurator@sha256:${"c".repeat(64)}`,
    nginx: `registry.example.test/nginx@sha256:${"d".repeat(64)}`,
    redis: `registry.example.test/redis@sha256:${"e".repeat(64)}`,
    memcached: `registry.example.test/memcached@sha256:${"f".repeat(64)}`,
  },
};
const persistedSpec = {
  ...spec,
  deployment: { ...spec.deployment, release },
};

function releaseEnvironment(overrides = {}) {
  return {
    WASALX_ZAMMAD_PACKAGE_VERSION: release.packageVersion,
    WASALX_ZAMMAD_PACKAGE_SHA256: release.packageSha256,
    ZAMMAD_IMAGE_BY_VERSION_JSON: JSON.stringify({ [spec.deployment.zammadVersion]: release.images.zammad }),
    ZAMMAD_CONFIGURATOR_IMAGE: release.images.configurator,
    ZAMMAD_NGINX_IMAGE: release.images.nginx,
    ZAMMAD_REDIS_IMAGE: release.images.redis,
    ZAMMAD_MEMCACHED_IMAGE: release.images.memcached,
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    operationId,
    zammadInstanceId,
    tenantId,
    action: "PROVISION",
    status: "RUNNING",
    completedSteps: [],
    currentStep: null,
    stepResults: {},
    spec: persistedSpec,
    attempts: 1,
    maxAttempts: 25,
    fencingToken: 7,
    ...overrides,
  };
}

test("reactivation reason uses the same bounded safe confirmation contract", () => {
  assert.equal(parseResumeReason({ reason: " Fresh health verification " }), "Fresh health verification");
  assert.throws(() => parseResumeReason({ reason: "no" }), /Reactivation reason/);
  assert.throws(() => parseResumeReason({ reason: "unsafe\nreason" }), /Reactivation reason/);
});

test("platform operator claims require the dedicated role, MFA, and recent authentication", () => {
  const now = 1_800_000_000;
  assert.deepEqual(
    assertPlatformOperatorClaims(
      {
        sub: "operator-subject",
        email: "operator@example.test",
        name: "Platform Operator",
        platform_role: "platform_operator",
        amr: ["pwd", "otp"],
        auth_time: now - 60,
      },
      now,
      900,
    ),
    {
      subject: "operator-subject",
      email: "operator@example.test",
      displayName: "Platform Operator",
      authenticatedAt: now - 60,
    },
  );
  assert.throws(
    () =>
      assertPlatformOperatorClaims(
        {
          sub: "operator-subject",
          email: "operator@example.test",
          platform_role: "platform_operator",
          amr: ["pwd"],
          auth_time: now - 60,
        },
        now,
        900,
      ),
    /MFA is required/,
  );
  assert.throws(
    () =>
      assertPlatformOperatorClaims(
        {
          sub: "operator-subject",
          email: "operator@example.test",
          platform_role: "platform_operator",
          amr: ["pwd", "otp"],
          auth_time: now - 901,
        },
        now,
        900,
      ),
    /Recent platform operator authentication/,
  );
});

test("platform operator guard rejects tenant-session headers and uses only its dedicated verifier", async () => {
  let authenticated = 0;
  const principal = {
    subject: "platform-operator",
    email: "operator@example.test",
    displayName: "Operator",
    authenticatedAt: 1,
  };
  const guard = new PlatformOperatorGuard(
    {
      authenticate: async () => {
        authenticated += 1;
        return principal;
      },
    },
    { getAllAndOverride: () => true },
  );
  const withTenantHeader = context({
    authorization: "Bearer platform-token",
    "x-wasalx-tenant-id": tenantId,
  });
  await assert.rejects(
    () => guard.canActivate(withTenantHeader),
    /must not use tenant-session headers/,
  );
  assert.equal(authenticated, 0);

  const request = { headers: { authorization: "Bearer platform-token" } };
  assert.equal(await guard.canActivate(context(request.headers, request)), true);
  assert.equal(request.platformOperator, principal);
  assert.equal(authenticated, 1);
});

test("driver responses must echo the fenced request and cannot persist secrets", () => {
  const request = {
    version: 1,
    operationId,
    zammadInstanceId,
    tenantId,
    action: "PROVISION",
    step: "database",
    fencingToken: 7,
    idempotencyKey: `provision:${tenantId}:${operationId}:database`,
    spec: persistedSpec,
    completedSteps: ["identity"],
    priorResults: {},
  };
  assert.deepEqual(
    { ...validateDriverResult(
      {
        status: "SUCCEEDED",
        operationId,
        zammadInstanceId,
        tenantId,
        action: "PROVISION",
        step: "database",
        fencingToken: 7,
        idempotencyKey: request.idempotencyKey,
        outputs: {
          database_reference: "postgresql://managed/tenant-db",
          service_secret_reference: "secret://tenants/northstar/zammad",
        },
      },
      request,
    ).outputs },
    {
      database_reference: "postgresql://managed/tenant-db",
      service_secret_reference: "secret://tenants/northstar/zammad",
    },
  );
  assert.throws(
    () =>
      validateDriverResult(
        {
          status: "SUCCEEDED",
          operationId,
          zammadInstanceId,
          tenantId: "wrong-tenant",
          action: "PROVISION",
          step: "database",
          fencingToken: 7,
          idempotencyKey: request.idempotencyKey,
          outputs: {},
        },
        request,
      ),
    ProvisioningDriverError,
  );
  assert.throws(
    () =>
      validateDriverResult(
        {
          status: "SUCCEEDED",
          operationId,
          zammadInstanceId,
          tenantId,
          action: "PROVISION",
          step: "database",
          fencingToken: 7,
          idempotencyKey: request.idempotencyKey,
          outputs: { database_password: "must-not-persist" },
        },
        request,
      ),
    /invalid or sensitive response/,
  );
  assert.throws(
    () =>
      validateDriverResult(
        {
          status: "SUCCEEDED",
          operationId,
          zammadInstanceId,
          tenantId,
          action: "PROVISION",
          step: "database",
          fencingToken: 7,
          idempotencyKey: request.idempotencyKey,
          outputs: {
            database_reference: "postgresql://fixture:placeholder@db.example.test:5432/example_db",
          },
        },
        request,
      ),
    /invalid or sensitive response/,
  );

  const resumeRequest = {
    ...request,
    action: "RESUME",
    resumePhase: "PREPARE",
    step: undefined,
    idempotencyKey: `resume:${tenantId}:${operationId}:prepare`,
  };
  assert.equal(
    validateDriverResult(
      {
        status: "SUCCEEDED",
        operationId,
        zammadInstanceId,
        tenantId,
        action: "RESUME",
        resumePhase: "PREPARE",
        fencingToken: 7,
        idempotencyKey: resumeRequest.idempotencyKey,
        outputs: {
          resumed: true,
          credentials_enabled: true,
          workloads_ready: true,
          ingress_enabled: true,
          healthy: true,
          isolation_verified: true,
        },
      },
      resumeRequest,
    ).outputs.credentials_enabled,
    true,
  );
});

test("provisioner accepts only vetted lifecycle history for suspend and resume", () => {
  const completedSteps = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"];
  const request = {
    version: 1,
    operationId,
    zammadInstanceId,
    tenantId,
    action: "RESUME",
    resumePhase: "PREPARE",
    fencingToken: 8,
    idempotencyKey: `resume:${tenantId}:${operationId}:prepare`,
    spec: persistedSpec,
    completedSteps,
    priorResults: {
      suspend: {
        suspended: true,
        credentials_disabled: true,
        workloads_scaled_to_zero: true,
        ingress_disabled: true,
      },
    },
  };
  assert.equal(parseProvisionerRequest(request).priorResults.suspend.credentials_disabled, true);
  assert.throws(
    () => parseProvisionerRequest({ ...request, priorResults: { arbitrary: { healthy: true } } }),
    /invalid/u,
  );
  assert.throws(
    () => parseProvisionerRequest({ ...request, priorResults: { suspend: { credentials_enabled: "raw-value" } } }),
    /invalid/u,
  );
});

test("HTTP driver uses the internal contract, scoped short-lived JWT, and stable idempotency header", async () => {
  const secret = "provisioning-driver-test-secret-32-bytes-minimum";
  let observed;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawBody = String(init.body);
    const body = JSON.parse(rawBody);
    const { payload } = await jwtVerify(
      String(init.headers.authorization).slice(7),
      new TextEncoder().encode(secret),
      {
        issuer: "wasalx-control-plane",
        audience: "wasalx-provisioning-driver",
        algorithms: ["HS256"],
      },
    );
    observed = { url: String(input), headers: init.headers, rawBody, body, payload };
    return new Response(
      JSON.stringify({
        status: "SUCCEEDED",
        operationId: body.operationId,
        zammadInstanceId: body.zammadInstanceId,
        tenantId,
        action: "PROVISION",
        step: "identity",
        fencingToken: body.fencingToken,
        idempotencyKey: body.idempotencyKey,
        outputs: { identity_id: "identity-ready" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const before = snapshotEnv([
    "PROVISIONING_DRIVER_URL",
    "PROVISIONING_DRIVER_JWT_SECRET",
    "ALLOW_INSECURE_PROVISIONING_DRIVER",
    "NODE_ENV",
  ]);
  process.env.PROVISIONING_DRIVER_URL = "https://driver.example.test/driver";
  process.env.PROVISIONING_DRIVER_JWT_SECRET = secret;
  delete process.env.ALLOW_INSECURE_PROVISIONING_DRIVER;
  process.env.NODE_ENV = "production";
  try {
    const driver = new HttpTenantProvisioningDriver();
    const result = await driver.execute({
      version: 1,
      operationId,
      zammadInstanceId,
      tenantId,
      action: "PROVISION",
      step: "identity",
      fencingToken: 7,
      idempotencyKey: `provision:${tenantId}:${operationId}:identity`,
      spec: persistedSpec,
      completedSteps: [],
      priorResults: {},
    });
    assert.equal(result.outputs.identity_id, "identity-ready");
    assert.equal(
      observed.url,
      "https://driver.example.test/driver/internal/v1/tenant-provisioning/execute",
    );
    assert.equal(
      observed.headers["idempotency-key"],
      `provision:${tenantId}:${operationId}:identity`,
    );
    assert.equal(observed.payload.scope, "tenant:provision");
    assert.equal(observed.payload.tenant_id, tenantId);
    assert.equal(observed.payload.operation_id, operationId);
    assert.equal(observed.payload.zammad_instance_id, zammadInstanceId);
    assert.equal(observed.payload.fencing_token, 7);
    assert.equal(
      observed.payload.request_sha256,
      createHash("sha256").update(observed.rawBody).digest("hex"),
    );
    assert.equal(
      observed.payload.idempotency_key,
      `provision:${tenantId}:${operationId}:identity`,
    );
    assert.ok(observed.payload.exp - observed.payload.iat <= 120);
  } finally {
    restoreEnv(before);
    globalThis.fetch = originalFetch;
  }
});

test("worker advances exactly one ordered step with a stable idempotency key", async () => {
  const calls = [];
  const repository = store({
    startStep: async (_task, actualLease, step) => {
      calls.push(`start:${actualLease}:${step}`);
      return true;
    },
    completeStep: async (_task, actualLease, step, outputs) => {
      calls.push(`complete:${actualLease}:${step}:${outputs.resource_id}`);
      return true;
    },
  });
  const driver = {
    isConfigured: () => true,
    execute: async (request) => {
      calls.push(`driver:${request.idempotencyKey}`);
      return {
        status: "SUCCEEDED",
        tenantId,
        action: "PROVISION",
        step: request.step,
        idempotencyKey: request.idempotencyKey,
        outputs: { resource_id: "identity-ready" },
      };
    },
  };
  let kicked = 0;
  await executeProvisioningTask(
    repository,
    driver,
    leaseId,
    task(),
    () => (kicked += 1),
  );
  assert.deepEqual(calls, [
    `start:${leaseId}:identity`,
    `driver:provision:${tenantId}:${operationId}:identity`,
    `complete:${leaseId}:identity:identity-ready`,
  ]);
  assert.equal(kicked, 1);
  assert.equal(nextStep(["identity", "database"]), "search");
  assert.throws(() => nextStep(["database"]), /out of order/);
});

test("stale fences cannot complete and suspension remains driver-backed", async () => {
  const stale = store({ startStep: async () => false });
  await assert.rejects(
    () =>
      executeProvisioningTask(stale, { isConfigured: () => true, execute: async () => assert.fail() }, leaseId, task()),
    StaleTenantProvisioningLeaseError,
  );

  const calls = [];
  const repository = store({
    completeSuspension: async (_task, actualLease, outputs) => {
      calls.push(`complete:${actualLease}:${outputs.suspended}`);
      return true;
    },
  });
  await executeProvisioningTask(
    repository,
    {
      isConfigured: () => true,
      execute: async (request) => {
        calls.push(`driver:${request.action}:${request.idempotencyKey}`);
        return {
          status: "SUCCEEDED",
          tenantId,
          action: "SUSPEND",
          idempotencyKey: request.idempotencyKey,
          outputs: { suspended: true },
        };
      },
    },
    leaseId,
    task({ action: "SUSPEND", status: "SUSPENDING" }),
  );
  assert.deepEqual(calls, [
    `driver:SUSPEND:suspend:${tenantId}:${operationId}`,
    `complete:${leaseId}:true`,
  ]);
});

test("provisioning retries the failed step with the same key and retains completed work through health", async () => {
  const steps = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"];
  const completedSteps = [];
  const attempts = [];
  let storageFailed = false;
  const repository = store({
    completeStep: async (_task, actualLease, step) => {
      assert.equal(actualLease, leaseId);
      completedSteps.push(step);
      return true;
    },
  });
  const driver = {
    execute: async (request) => {
      attempts.push({ step: request.step, key: request.idempotencyKey });
      assert.deepEqual(request.completedSteps, steps.slice(0, completedSteps.length));
      if (request.step === "storage" && !storageFailed) {
        storageFailed = true;
        throw new ProvisioningDriverError("DEPENDENCY_UNAVAILABLE", "Temporary dependency failure", true);
      }
      return { outputs: { resource_id: `${request.step}-ready` } };
    },
  };
  for (let index = 0; index < 3; index++) {
    await executeProvisioningTask(repository, driver, leaseId, task({ completedSteps: [...completedSteps] }));
  }
  await assert.rejects(
    () => executeProvisioningTask(repository, driver, leaseId, task({ completedSteps: [...completedSteps] })),
    (error) => error instanceof ProvisioningDriverError && error.retryable,
  );
  assert.deepEqual(completedSteps, ["identity", "database", "search"]);
  while (completedSteps.length < steps.length) {
    await executeProvisioningTask(repository, driver, leaseId, task({ completedSteps: [...completedSteps] }));
  }
  assert.deepEqual(completedSteps, steps);
  assert.deepEqual(attempts.map(({ step }) => step), [...steps.slice(0, 4), ...steps.slice(3)]);
  assert.ok(attempts.every(({ step, key }) => key === `provision:${tenantId}:${operationId}:${step}`));
  assert.equal(attempts[3].key, attempts[4].key);
});

test("a fence lost after provisioning I/O cannot advance or schedule the next step", async () => {
  let executed = false;
  await assert.rejects(
    () => executeProvisioningTask(
      store({ completeStep: async () => false }),
      { execute: async () => { executed = true; return { outputs: { resource_id: "identity-ready" } }; } },
      leaseId,
      task(),
      () => assert.fail("stale completion must not schedule the next step"),
    ),
    StaleTenantProvisioningLeaseError,
  );
  assert.equal(executed, true);
});

test("resumption authorizes ACTIVE after prepare and publishes through a second fenced action", async () => {
  const calls = [];
  const repository = store({
    authorizeResumption: async (_task, actualLease, outputs) => {
      calls.push(`authorize:${actualLease}:${outputs.prepared}:${outputs.isolation_verified}`);
      return true;
    },
    completeResumption: async (_task, actualLease, outputs) => {
      calls.push(`complete:${actualLease}:${outputs.resumed}:${outputs.isolation_verified}`);
      return true;
    },
  });
  await executeProvisioningTask(
    repository,
    {
      isConfigured: () => true,
      execute: async (request) => {
        calls.push(`driver:${request.action}:${request.idempotencyKey}`);
        return {
          status: "SUCCEEDED",
          tenantId,
          action: "RESUME",
          idempotencyKey: request.idempotencyKey,
          resumePhase: request.resumePhase,
          outputs: { prepared: true, isolation_verified: true },
        };
      },
    },
    leaseId,
    task({
      action: "RESUME",
      status: "RESUMING",
      currentStep: "resume_prepare",
      completedSteps: ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"],
    }),
    () => calls.push("kick:publish-claim-now"),
  );
  assert.deepEqual(calls, [
    `driver:RESUME:resume:${tenantId}:${operationId}:prepare`,
    `authorize:${leaseId}:true:true`,
    "kick:publish-claim-now",
  ]);

  calls.length = 0;
  await executeProvisioningTask(
    repository,
    {
      isConfigured: () => true,
      execute: async (request) => {
        calls.push(`driver:${request.action}:${request.idempotencyKey}`);
        return {
          status: "SUCCEEDED",
          tenantId,
          action: "RESUME",
          resumePhase: request.resumePhase,
          idempotencyKey: request.idempotencyKey,
          outputs: { resumed: true, isolation_verified: true },
        };
      },
    },
    leaseId,
    task({
      action: "RESUME",
      status: "RESUMING",
      currentStep: "resume_publish",
      completedSteps: ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"],
    }),
  );
  assert.deepEqual(calls, [
    `driver:RESUME:resume:${tenantId}:${operationId}:publish`,
    `complete:${leaseId}:true:true`,
  ]);

  await assert.rejects(
    () => executeProvisioningTask(
      store({ completeResumption: async () => false }),
      {
        isConfigured: () => true,
        execute: async (request) => ({
          status: "SUCCEEDED",
          tenantId,
          action: "RESUME",
          resumePhase: request.resumePhase,
          idempotencyKey: request.idempotencyKey,
          outputs: { resumed: true },
        }),
      },
      leaseId,
      task({
        action: "RESUME",
        status: "RESUMING",
        currentStep: "resume_publish",
        completedSteps: ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"],
      }),
    ),
    StaleTenantProvisioningLeaseError,
  );
});

test("operator service fails closed without the real driver and parses pinned deployment input", async () => {
  const repository = store({ isConfigured: () => true });
  const service = new TenantProvisioningService(
    repository,
    { isConfigured: () => false },
    { isOperational: () => false },
  );
  await assert.rejects(
    () =>
      service.create(spec, {
        idempotencyKey: "create-northstar-1",
        operator: {
          subject: "operator",
          email: "operator@example.test",
          displayName: "Operator",
          authenticatedAt: 1,
        },
        requestId: "request-1",
      }),
    ServiceUnavailableException,
  );
  assert.deepEqual(
    parseSpec({
      name: " Northstar ",
      slug: "Northstar",
      retentionDays: 90,
      owner: spec.owner,
      deployment: spec.deployment,
    }),
    spec,
  );
  assert.throws(
    () => parseSpec({ ...spec.tenant, owner: spec.owner, deployment: { ...spec.deployment, zammadVersion: "latest" } }),
    /pinned semantic Zammad version/,
  );
  assert.throws(() => parseSpec({ ...spec.tenant, name: "N", owner: spec.owner, deployment: spec.deployment }), /Tenant name/);
  assert.throws(() => parseSpec({ ...spec.tenant, owner: { ...spec.owner, displayName: "x".repeat(121) }, deployment: spec.deployment }), /Owner display name/);
  assert.throws(() => parseSpec({ ...spec.tenant, owner: spec.owner, deployment: { ...spec.deployment, region: "SA_Riyadh" } }), /DNS-label safe/);
  assert.equal(requestHash({ b: 2, a: 1 }), requestHash({ a: 1, b: 2 }));
});

test("create snapshots the server release once and replays without consulting a changed catalog", async () => {
  const environment = releaseEnvironment();
  assert.deepEqual(configuredRelease(spec.deployment.zammadVersion, environment), release);
  assert.throws(() => configuredRelease("7.0.2", environment), /not supported/);
  assert.throws(() => configuredRelease(spec.deployment.zammadVersion, releaseEnvironment({ ZAMMAD_NGINX_IMAGE: "registry.example.test/nginx:latest" })), /invalid/);
  assert.throws(() => configuredRelease(spec.deployment.zammadVersion, releaseEnvironment({ WASALX_ZAMMAD_PACKAGE_VERSION: `1.0.0-${"a".repeat(59)}` })), /invalid/);
  assert.throws(() => configuredRelease(spec.deployment.zammadVersion, releaseEnvironment({ ZAMMAD_NGINX_IMAGE: `${"a".repeat(1977)}@sha256:${"b".repeat(64)}` })), /invalid/);
  assert.throws(() => configuredRelease(spec.deployment.zammadVersion, releaseEnvironment({ WASALX_ZAMMAD_PACKAGE_SHA256: undefined })), /incomplete/);

  const names = Object.keys(environment);
  const before = snapshotEnv(names);
  Object.assign(process.env, environment);
  let created;
  let kicks = 0;
  const operator = {
    idempotencyKey: "create-northstar-release-1",
    operator: { subject: "operator", email: "operator@example.test", displayName: "Operator", authenticatedAt: 1 },
    requestId: "request-release-1",
  };
  try {
    const service = new TenantProvisioningService(
      store({
        replayCreate: async () => null,
        create: async (input) => { created = input; return { tenant_id: tenantId, duplicate: false }; },
      }),
      { isConfigured: () => true },
      { isOperational: () => true, kick: () => { kicks += 1; } },
    );
    assert.deepEqual(await service.create(spec, operator), { tenant_id: tenantId, duplicate: false });
    assert.deepEqual(created.spec, persistedSpec);
    assert.equal(created.requestSha256, requestHash({ action: "CREATE", spec }));
    assert.equal("release" in spec.deployment, false);
    assert.equal(kicks, 1);
    await assert.rejects(
      () => service.create(
        { ...spec, deployment: { ...spec.deployment, zammadVersion: "7.0.2" } },
        { ...operator, idempotencyKey: "create-unsupported-zammad" },
      ),
      (error) => error?.getStatus?.() === 422,
    );

    for (const name of names) delete process.env[name];
    const replay = { tenant_id: tenantId, duplicate: true };
    const replayService = new TenantProvisioningService(
      store({
        replayCreate: async (input) => {
          assert.equal(input.requestSha256, requestHash({ action: "CREATE", spec }));
          return replay;
        },
        create: async () => assert.fail("a committed create replay must not re-enter creation"),
      }),
      { isConfigured: () => false },
      { isOperational: () => false, kick: () => assert.fail("a replay must not kick provisioning") },
    );
    assert.equal(await replayService.create(spec, operator), replay);
  } finally {
    restoreEnv(before);
  }
});

test("migration enforces durable claims, operator audit, and the least-privilege role", async () => {
  const sql = await readFile(
    new URL(
      "../services/control-api/migrations/0013_tenant_provisioning_runtime.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE provisioning_operator_requests/);
  assert.match(sql, /CREATE ROLE wasalx_provisioning_client NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /REVOKE ALL ON public\.provisioning_operator_requests FROM PUBLIC, wasalx_app, wasalx_provisioner/);
  assert.match(sql, /FOR UPDATE OF p SKIP LOCKED/);
  assert.match(sql, /fencing_token=p\.fencing_token\+1/);
  assert.match(sql, /lease_id=worker_lease/);
  assert.match(sql, /expected_fencing_token/);
  assert.match(sql, /completed_steps = CASE step_value/);
  assert.match(sql, /existing_request\.actor_subject <> actor_subject/);
  assert.match(sql, /'PLATFORM_OPERATOR'/);
  assert.match(sql, /'tenant\.provisioning_inspected'/);
  assert.match(sql, /step_value='health' THEN 'COMPLETE'/);
  assert.match(sql, /UPDATE tenants SET state='ACTIVE'/);
  assert.match(sql, /UPDATE tenants SET state='SUSPENDED'/);
  assert.doesNotMatch(sql, /GRANT .*provisioning_operator_requests.* TO wasalx_app/);

  const repository = await readFile(
    new URL(
      "../services/control-api/src/tenant-provisioning.repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(repository, /options: "-c role=wasalx_provisioning_client"/);
});

test("provisioning completion materializes the fenced per-tenant Zammad instance", async () => {
  const sql = await readFile(
    new URL(
      "../services/control-api/migrations/0034_provisioned_zammad_instance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN zammad_instance_id uuid NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(sql, /SET zammad_instance_id=instance\.id[\s\S]*instance\.tenant_id=operation\.tenant_id/);
  assert.match(sql, /'zammadInstanceId',p\.zammad_instance_id/);
  assert.match(sql, /'zammad_instance_id',p\.zammad_instance_id/);
  assert.match(sql, /INSERT INTO zammad_instances/);
  assert.match(sql, /operation_value\.zammad_instance_id,tenant_value/);
  assert.match(sql, /service_secret_reference_value <> 'secret:\/\/tenants\/' \|\| tenant_value::text \|\| '\/zammad\/service'/);
  assert.match(sql, /privacy_secret_reference_value <> 'secret:\/\/tenants\/' \|\| tenant_value::text \|\| '\/zammad\/privacy'/);
  assert.match(sql, /WHERE zammad_instances\.id=EXCLUDED\.id/);
  assert.match(sql, /UPDATE zammad_instances SET state='SUSPENDED'/);
  assert.match(sql, /TO wasalx_provisioning_executor/);
  assert.match(sql, /TO wasalx_provisioning_client/);
});

test("resume migration is idempotent, fenced, evidence-gated, and least privilege", async () => {
  const sql = await readFile(
    new URL(
      "../services/control-api/migrations/0037_tenant_resume_runtime.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /CHECK \(action IN \('PROVISION','SUSPEND','RESUME'\)\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app\.operator_resume_tenant/);
  assert.match(sql, /only a fully suspended tenant can be resumed/);
  assert.match(sql, /'tenant\.resumption_requested'/);
  assert.match(sql, /status='RESUMING'/);
  assert.match(sql, /current_step='resume_prepare'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app\.authorize_tenant_resumption/);
  assert.match(sql, /SET status='RESUME_PENDING',current_step='resume_publish'/);
  assert.match(sql, /status='RESUME_PENDING',current_step='resume_publish'[\s\S]*lease_id=NULL,lease_expires_at=NULL,available_at=now\(\)/);
  assert.match(sql, /p\.current_step='resume_publish' AND t\.state='ACTIVE'/);
  assert.match(sql, /fencing_token=expected_fencing_token/);
  assert.match(sql, /result_value->'healthy' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /result_value->'isolation_verified' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /resumption evidence is stale/);
  assert.match(sql, /result_value->>'zammad_base_url' <> instance_url/);
  assert.match(sql, /UPDATE zammad_instances SET state='WORKING'/);
  assert.match(sql, /UPDATE tenants SET state='ACTIVE'/);
  assert.match(sql, /current_step='resume_publish'[\s\S]*t\.state='ACTIVE'[\s\S]*z\.state='WORKING'/);
  assert.match(sql, /'tenant\.resumption_completed'/);
  assert.match(sql, /'RESUME_PENDING','RESUMING'/);
  assert.match(sql, /observability_runtime_metrics/);
  assert.match(sql, /operator_list_tenant_operations/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.operator_resume_tenant/);
  assert.match(sql, /TO wasalx_provisioning_client/);
  assert.match(sql, /result_value->'suspended' IS DISTINCT FROM 'true'::jsonb/);
  assert.match(sql, /suspension evidence is stale/);
  assert.match(sql, /result_value \? 'ingress_enabled'/);
  assert.doesNotMatch(sql, /GRANT .*operator_resume_tenant.*wasalx_app/);
});

function store(overrides = {}) {
  return {
    isConfigured: () => true,
    replayCreate: async () => null,
    create: async () => ({}),
    status: async () => ({}),
    retry: async () => ({}),
    suspend: async () => ({}),
    resume: async () => ({}),
    claim: async () => [],
    startStep: async () => true,
    completeStep: async () => true,
    completeSuspension: async () => true,
    authorizeResumption: async () => true,
    completeResumption: async () => true,
    fail: async () => true,
    ...overrides,
  };
}

function context(headers, request = { headers }) {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
