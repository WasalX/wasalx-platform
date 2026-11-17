import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WahaWorkerMonitor,
  WahaWorkerRegistryRepository,
  parseWahaWorkerConfigs,
  probeWahaWorker,
} from "../services/connector-worker/dist/services/connector-worker/src/waha-worker-registry.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { parseModeChange } from "../services/control-api/dist/waha-workers.controller.js";
import {
  assertWahaRegistryTransition,
  runWahaRolloutPreflight,
  parseDesiredManagedWorkers,
  safeRolloutFailureEvidence,
  safeRolloutFailureCategory,
} from "../services/connector-worker/dist/services/connector-worker/src/waha-rollout-preflight.js";

const stableConfig = {
  workerKey: "gows-prod-a",
  engine: "GOWS",
  baseUrl: "http://waha-gows-a.internal:3000/",
  secretReference: "secret://platform/waha/gows-a",
  capacity: 100,
  rolloutMode: "STABLE",
  heartbeatTtlSeconds: 45,
};

test("production requires an explicit bounded worker registry and rejects unsafe endpoints", () => {
  assert.throws(
    () => parseWahaWorkerConfigs({ NODE_ENV: "production" }),
    /WAHA_WORKERS_JSON is required/,
  );
  const parsed = parseWahaWorkerConfigs({
    NODE_ENV: "production",
    WAHA_WORKERS_JSON: JSON.stringify([
      stableConfig,
      {
        ...stableConfig,
        workerKey: "noweb-canary-a",
        engine: "NOWEB",
        baseUrl: "https://waha-noweb-a.svc.cluster.local/",
        capacity: 20,
        rolloutMode: "CANARY",
        canarySessionLimit: 3,
      },
    ]),
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], {
    workerKey: "noweb-canary-a",
    engine: "NOWEB",
    baseUrl: "https://waha-noweb-a.svc.cluster.local/",
    secretReference: "secret://platform/waha/gows-a",
    capacity: 20,
    rolloutMode: "CANARY",
    canarySessionLimit: 3,
    heartbeatTtlSeconds: 45,
  });

  assert.throws(
    () => parseWahaWorkerConfigs({
      NODE_ENV: "production",
      WAHA_WORKERS_JSON: JSON.stringify([{ ...stableConfig, baseUrl: "https://waha.example.com/" }]),
    }),
    /private endpoint/,
  );
  assert.throws(
    () => parseWahaWorkerConfigs({
      NODE_ENV: "production",
      WAHA_WORKERS_JSON: JSON.stringify([stableConfig, stableConfig]),
    }),
    /duplicated/,
  );
  assert.throws(
    () => parseWahaWorkerConfigs({
      NODE_ENV: "production",
      WAHA_WORKERS_JSON: JSON.stringify([{ ...stableConfig, rolloutMode: "CANARY" }]),
    }),
    /canary limit/,
  );
});

test("rollout preflight accepts only bounded generated worker identities and validates DB evidence", async () => {
  const desiredWorkers = [{
    workerKey: "managed-gows-0",
    engine: "GOWS",
    baseUrl: "http://wasalx-waha-gows-0-0.wasalx-waha-gows-0.wasalx.svc.cluster.local:3000/",
    secretReference: "secret://platform/waha/managed-gows-0",
  }];
  assert.deepEqual(
    parseDesiredManagedWorkers(JSON.stringify(desiredWorkers)),
    desiredWorkers,
  );
  assert.deepEqual(parseDesiredManagedWorkers("[]"), []);
  assert.throws(() => parseDesiredManagedWorkers(undefined), /is required/);
  assert.throws(() => parseDesiredManagedWorkers('["external-gows-a"]'), /worker is invalid/);
  assert.throws(() => parseDesiredManagedWorkers(JSON.stringify([...desiredWorkers, ...desiredWorkers])), /duplicated/);
  assert.throws(
    () => parseDesiredManagedWorkers(JSON.stringify([{ ...desiredWorkers[0], baseUrl: "https://public.example.com/" }])),
    /identity is invalid/,
  );

  let query;
  const result = await assertWahaRegistryTransition({
    async query(sql, values) {
      query = { sql, values };
      return { rows: [{ checked_workers: "3", omitted_workers: "1" }] };
    },
  }, desiredWorkers);
  assert.deepEqual(result, { checkedWorkers: 3, omittedWorkers: 1 });
  assert.match(query.sql, /app\.assert_waha_worker_registry_transition\(\$1::jsonb\)/);
  assert.deepEqual(query.values, [JSON.stringify(desiredWorkers)]);
  await assert.rejects(
    () => assertWahaRegistryTransition({ async query() { return { rows: [] }; } }, []),
    /invalid result/,
  );
});

test("rollout preflight emits only allowlisted worker-state failure evidence", () => {
  assert.deepEqual(
    safeRolloutFailureEvidence({
      code: "P0001",
      message: "managed WAHA worker managed-gows-4 cannot leave the registry: state DISABLED, protected assignments 2",
    }),
    { worker: "managed-gows-4", state: "DISABLED", protectedAssignments: 2 },
  );
  assert.equal(
    safeRolloutFailureEvidence({ code: "P0001", message: "tenant 123 secret://do-not-log" }),
    undefined,
  );
  assert.equal(
    safeRolloutFailureEvidence({ code: "08006", message: "postgresql://secret-host" }),
    undefined,
  );
});

test("rollout infrastructure diagnostics expose only fixed categories", () => {
  for (const [code, category] of [
    ["ENOENT", "trust_bundle_missing"], ["ECONNREFUSED", "connection_refused"],
    ["ETIMEDOUT", "connection_timeout"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failed"],
    ["28P01", "authentication_failed"], ["42501", "authorization_failed"],
    ["42883", "database_contract_missing"], ["PRIVATE_SENTINEL", "internal"],
  ]) {
    assert.equal(safeRolloutFailureCategory({ code, message: "postgresql://PRIVATE_SENTINEL", path: "/PRIVATE_SENTINEL", detail: "PRIVATE_SENTINEL" }), category);
  }
  for (const error of [null, undefined, "PRIVATE_SENTINEL", {}, { code: 123 }]) {
    assert.equal(safeRolloutFailureCategory(error), "internal");
  }
});

test("health is based on real WAHA health and server-status responses", async () => {
  const calls = [];
  const startedAt = Date.now() - 10_000;
  const result = await probeWahaWorker(
    stableConfig.baseUrl,
    "provider-api-key",
    5_000,
    async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", info: {}, error: {}, details: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ startTimestamp: startedAt, uptime: 10_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.deepEqual(result, {
    healthy: true,
    startedAt: new Date(startedAt).toISOString(),
  });
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/health", "/api/server/status"]);
  assert.equal(calls.every(({ init }) => init.headers["x-api-key"] === "provider-api-key"), true);
  assert.equal(calls.every(({ init }) => init.redirect === "manual"), true);

  const invalid = await probeWahaWorker(
    stableConfig.baseUrl,
    "provider-api-key",
    5_000,
    async () => new Response(JSON.stringify({ status: "error" }), { status: 200 }),
  );
  assert.deepEqual(invalid, { healthy: false, errorCode: "WAHA_HEALTH_INVALID" });
});

test("health and server-status observations run concurrently under independent deadlines", async () => {
  const calls = [];
  const responders = new Map();
  const startedAt = Date.now() - 5_000;
  const pending = probeWahaWorker(
    stableConfig.baseUrl,
    "provider-api-key",
    1_000,
    (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      return new Promise((resolve) => responders.set(path, resolve));
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["/health", "/api/server/status"]);
  responders.get("/health")(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
  responders.get("/api/server/status")(
    new Response(JSON.stringify({ startTimestamp: startedAt }), { status: 200 }),
  );
  assert.deepEqual(await pending, {
    healthy: true,
    startedAt: new Date(startedAt).toISOString(),
  });
});

test("monitor persists failed probes as unhealthy and does not overlap ticks", async () => {
  const reports = [];
  const repository = {
    async report(config, result) { reports.push({ config, result }); },
    async ready() { return true; },
    async close() {},
  };
  const secrets = { async resolve() { return {}; } };
  const monitor = new WahaWorkerMonitor([stableConfig], repository, secrets, 5_000, 1_000);
  assert.equal(monitor.ready(), false);
  await Promise.all([monitor.tick(), monitor.tick()]);
  assert.equal(monitor.ready(), true);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].result, {
    healthy: false,
    errorCode: "WAHA_SECRET_INVALID",
  });
});

test("monitor readiness stays closed until every heartbeat is durable", async () => {
  let fail = true;
  const repository = {
    async report() {
      if (fail) throw new Error("registry unavailable");
    },
    async ready() { return !fail; },
    async close() {},
  };
  const secrets = { async resolve() { return {}; } };
  const monitor = new WahaWorkerMonitor([stableConfig], repository, secrets, 5_000, 1_000);
  await monitor.tick();
  assert.equal(monitor.ready(), false);
  fail = false;
  await monitor.tick();
  assert.equal(monitor.ready(), true);
});

test("durable heartbeat emits the assigned-session saturation gauge contract", async () => {
  let query;
  const repository = new WahaWorkerRegistryRepository({
    async query(sql, values) {
      query = { sql, values };
      return { rows: [{
        waha_worker_id: "30000000-0000-4000-8000-000000000001",
        worker_key: stableConfig.workerKey,
        engine: stableConfig.engine,
        health_state: "HEALTHY",
        capacity: stableConfig.capacity,
        assigned_sessions: "12",
        renewed_assignments: "12",
      }] };
    },
  });
  await repository.report(stableConfig, {
    healthy: true,
    startedAt: "2026-08-09T20:00:00.000Z",
  });
  assert.match(query.sql, /heartbeat\.assigned_sessions/);
  assert.match(query.sql,/app\.renew_waha_worker_assignments\(heartbeat\.worker_key,interval '120 seconds'\)/);
  const source = await readFile(
    new URL("../services/connector-worker/src/waha-worker-registry.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /recordMetric\("wasalx_waha_worker_sessions", assignedSessions, \{[\s\S]*worker: config\.workerKey,[\s\S]*engine: config\.engine\.toLowerCase\(\)/);
});

test("inbound media renews the exact tenant session, worker, and assignment fence", async () => {
  const workerId = "30000000-0000-4000-8000-000000000001";
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes("app.renew_waha_session_assignment")) {
        return { rows: [{
          waha_worker_id: workerId,
          base_url: stableConfig.baseUrl,
          secret_reference: stableConfig.secretReference,
          assignment_fencing_token: "7",
          assignment_lease_expires_at: "2026-08-09T23:59:59.000Z",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const repository = new InboundRepository({ connect: async () => client });
  const event = {
    id: "40000000-0000-4000-8000-000000000001",
    tenantId: "10000000-0000-4000-8000-000000000001",
    connectionId: "20000000-0000-4000-8000-000000000001",
    provider: "waha",
    providerEventId: "event-1",
    eventType: "message",
    payload: {},
    attempts: 1,
  };
  const context = {
    providerSessionId: "opaque-session-1",
    wahaWorkerId: workerId,
    wahaAssignmentFencingToken: 7,
    providerBaseUrl: stableConfig.baseUrl,
    connectionSecretReference: stableConfig.secretReference,
  };
  const renewed = await repository.renewWahaWorkerAssignment(event, context);
  const renewal = statements.find(({ sql }) => sql.includes("app.renew_waha_session_assignment"));
  assert.deepEqual(renewal.values, [event.tenantId, event.connectionId, context.providerSessionId, workerId, 7]);
  assert.match(renewal.sql, /tenant_id=\$1 AND connection_id=\$2 AND opaque_session_id=\$3/);
  assert.equal(renewed.wahaAssignmentLeaseExpiresAt, "2026-08-09T23:59:59.000Z");
});

test("platform mode mutations are versioned and canary-safe", () => {
  assert.deepEqual(parseModeChange({
    version: 4,
    lifecycleState: "DRAINING",
    rolloutMode: "STABLE",
    reason: "Drain before the pinned WAHA upgrade.",
  }), {
    version: 4,
    lifecycleState: "DRAINING",
    rolloutMode: "STABLE",
    reason: "Drain before the pinned WAHA upgrade.",
  });
  assert.deepEqual(parseModeChange({
    version: 5,
    lifecycleState: "ACTIVE",
    rolloutMode: "CANARY",
    canarySessionLimit: 2,
    reason: "Limit the first rollout to two sessions.",
  }).canarySessionLimit, 2);
  assert.throws(
    () => parseModeChange({
      version: 1,
      lifecycleState: "ACTIVE",
      rolloutMode: "CANARY",
      reason: "Missing the limit.",
    }),
    /canary session limit/,
  );
});

test("migration enforces durable capacity, drain/canary selection, expiry, fencing, and safe registry shrink", async () => {
  const [source, upgrade, rolloutGate,renewal] = await Promise.all([
    readFile(
      new URL("../services/control-api/migrations/0024_waha_worker_capacity.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../services/control-api/migrations/0030_runtime_least_privilege.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../services/control-api/migrations/0033_waha_rollout_gate.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../services/control-api/migrations/0128_waha_worker_renewal_lock_avoidance.sql",import.meta.url),"utf8"),
  ]);
  assert.match(source, /CREATE TABLE public\.waha_workers/);
  assert.match(source, /lifecycle_state IN \('ACTIVE','DRAINING','DISABLED'\)/);
  assert.match(source, /rollout_mode IN \('STABLE','CANARY'\)/);
  assert.match(source, /assignment_fencing_token = assignment_fencing_token \+ 1/);
  assert.match(source, /assignment_lease_expires_at >= now\(\)/);
  assert.match(source, /worker\.lifecycle_state = 'ACTIVE'/);
  assert.match(source, /FOR UPDATE OF worker SKIP LOCKED/);
  assert.match(source, /count\(\*\).*worker\.capacity/s);
  assert.match(source, /renew_waha_session_assignment/);
  assert.match(source, /WAHA worker identity is immutable/);
  assert.match(source, /wasalx_waha_registry_client/);
  assert.match(source, /wasalx_waha_operator_client/);
  assert.match(source, /SECURITY DEFINER[\s\S]*SET row_security = off/);
  assert.match(source, /CREATE OR REPLACE FUNCTION app\.current_waha_session_runtime/);
  assert.match(source, /session\.tenant_id=app\.current_tenant_id\(\)/);
  assert.match(source, /REVOKE ALL ON public\.waha_workers,public\.waha_worker_events FROM PUBLIC,wasalx_app/);
  assert.doesNotMatch(source, /GRANT SELECT ON public\.waha_workers TO wasalx_app/);
  assert.doesNotMatch(source, /report_waha_worker_heartbeat[\s\S]{0,300}TO wasalx_app/);
  assert.doesNotMatch(source, /set_waha_worker_mode[\s\S]{0,300}TO wasalx_app/);
  assert.match(renewal,/CREATE OR REPLACE FUNCTION app\.renew_waha_worker_assignments/);
  assert.match(renewal,/session\.waha_worker_id=worker\.id[\s\S]*session\.ownership_state='ACTIVE'/);
  assert.match(renewal,/FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(renewal,/renew_waha_session_assignment[\s\S]*assignment_lease_expires_at >= now\(\)/);
  assert.match(renewal,/GRANT EXECUTE ON FUNCTION app\.renew_waha_worker_assignments\(text,interval\)[\s\S]*TO wasalx_waha_registry_client/);
  assert.match(renewal,/REVOKE ALL ON FUNCTION app\.renew_waha_worker_assignments[\s\S]*FROM PUBLIC,wasalx_app/);
  assert.match(upgrade, /REVOKE ALL ON public\.waha_workers,public\.waha_worker_events\s+FROM PUBLIC,wasalx_app/);
  assert.match(upgrade, /ALTER FUNCTION app\.renew_waha_session_assignment[\s\S]*SECURITY DEFINER/);
  assert.match(rolloutGate, /CREATE OR REPLACE FUNCTION app\.assert_waha_worker_registry_transition/);
  assert.match(rolloutGate, /worker\.lifecycle_state <> 'DISABLED'/);
  assert.match(rolloutGate, /session\.ownership_state='ACTIVE'[\s\S]*session\.assignment_lease_expires_at >= now\(\)/);
  assert.match(rolloutGate, /wasalx_waha_rollout_gate_client NOLOGIN NOBYPASSRLS/);
  assert.match(rolloutGate, /CREATE TABLE app\.waha_registry_rollout_guard/);
  assert.match(rolloutGate, /CREATE TRIGGER waha_workers_rollout_guard/);
  assert.match(rolloutGate, /pg_advisory_xact_lock\(hashtextextended\('wasalx\.waha\.registry\.rollout',0\)\)/);
  assert.match(rolloutGate, /managed WAHA worker identity differs from the staged registry/);
  assert.match(rolloutGate, /managed WAHA worker cannot reactivate outside the staged registry/);
  assert.match(rolloutGate, /jsonb_typeof\(desired\.worker->'engine'\) <> 'string'/);
  assert.match(rolloutGate, /IS DISTINCT FROM desired\.worker->>'secretReference'/);
  assert.match(rolloutGate, /GRANT EXECUTE ON FUNCTION app\.assert_waha_worker_registry_transition\(jsonb\)[\s\S]*TO wasalx_waha_rollout_gate_client/);
  assert.match(rolloutGate, /REVOKE ALL ON app\.waha_registry_rollout_guard,[\s\S]*public\.waha_workers,public\.waha_worker_events,public\.provider_sessions[\s\S]*FROM wasalx_waha_rollout_gate_client/);
  assert.doesNotMatch(rolloutGate, /tenant_id|message_body|opaque_session_id/);
});

test("every WAHA provider call path uses a healthy fenced assignment without exposing infrastructure to tenants", async () => {
  const [repository, inboundRepository, inboundProcessor, authorization, authorizationClient, lifecycle, runtime, operatorService, connections] = await Promise.all([
    readFile(new URL("../services/connector-worker/src/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/connector-worker/src/inbound-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/connector-worker/src/inbound-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/waha-authorization.service.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/waha-authorization.client.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/connector-worker/src/connection-operation-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/connector-worker/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/waha-workers.service.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/connections.controller.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /worker\.base_url AS provider_base_url/);
  assert.match(repository, /app\.current_waha_session_runtime\(ps\.id\)/);
  assert.doesNotMatch(repository, /JOIN waha_workers/u);
  assert.match(repository, /app\.renew_waha_session_assignment/);
  assert.match(lifecycle, /acquireWahaWorkerAssignment\(job/);
  assert.match(lifecycle, /assignment\.engine !== job\.engine/);
  assert.match(inboundRepository, /worker\.health_state='HEALTHY'/);
  assert.match(inboundRepository, /app\.current_waha_session_runtime\(ps\.id\)/);
  assert.doesNotMatch(inboundRepository, /JOIN waha_workers/u);
  assert.match(inboundRepository, /renewWahaWorkerAssignment/);
  assert.match(inboundRepository, /app\.renew_waha_session_assignment/);
  assert.match(inboundProcessor, /renewWahaWorkerAssignment\(event, context\)/);
  assert.match(authorization, /context\.workerBaseUrl/);
  assert.match(authorization, /app\.current_waha_session_runtime\(ps\.provider_session_id\)/);
  assert.doesNotMatch(authorization, /JOIN waha_workers/u);
  assert.match(authorization, /app\.renew_waha_session_assignment/);
  assert.match(authorizationClient, /create\(apiKey: string, opaqueSessionId: string, baseUrl: string\)/);
  assert.match(lifecycle, /baseUrl: assignment\.baseUrl/);
  assert.match(runtime, /parseWahaWorkerConfigs\(\)/);
  assert.match(runtime, /wahaWorkerMonitor\.start\(\)/);
  assert.match(runtime, /required\("WAHA_REGISTRY_DATABASE_URL"\)/);
  assert.doesNotMatch(runtime, /required\("WAHA_BASE_URL"\)/);
  assert.match(operatorService, /WAHA_OPERATOR_DATABASE_URL/);
  assert.doesNotMatch(operatorService, /base_url:/);
  assert.doesNotMatch(operatorService, /secret_reference:/);
  assert.match(connections, /app\.current_waha_session_runtime\(ps\.id\)/);
  assert.doesNotMatch(connections, /JOIN waha_workers/u);
});

test("rollout gate retries refused startup connections but never SQL or authorization failures", async () => {
  for (const scenario of ["settles", "refused", "authentication", "sql"]) {
    let connections = 0, queries = 0, releases = 0;
    const failure = Object.assign(new Error("private failure"), {
      code: scenario === "authentication" ? "28P01" : "ECONNREFUSED",
    });
    const pool = {
      async connect() {
        connections++;
        if (scenario === "refused" || scenario === "authentication" ||
            (scenario === "settles" && connections === 1)) throw failure;
        return {
          async query() {
            queries++;
            if (scenario === "sql") throw failure;
            return { rows: [{ checked_workers: 1, omitted_workers: 0 }] };
          },
          release() { releases++; },
        };
      },
    };
    if (scenario === "settles") {
      assert.deepEqual(await runWahaRolloutPreflight(pool, []), { checkedWorkers: 1, omittedWorkers: 0 });
    } else {
      await assert.rejects(runWahaRolloutPreflight(pool, []), error => error === failure);
    }
    assert.equal(connections, scenario === "refused" ? 6 : scenario === "settles" ? 2 : 1);
    assert.equal(queries, ["settles", "sql"].includes(scenario) ? 1 : 0);
    assert.equal(releases, queries);
  }
});
