import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

test("host metrics resolves the patched service-name sanitizer", () => {
  const observability = createRequire(new URL("../packages/observability/package.json", import.meta.url));
  const instrumentation = createRequire(observability.resolve("@opentelemetry/auto-instrumentations-node"));
  const hostMetrics = createRequire(instrumentation.resolve("@opentelemetry/instrumentation-host-metrics"));
  const { sanitizeShellString } = hostMetrics("systeminformation/lib/util.js");
  // GHSA-3f7j-7jwc-fxfj: exercise only the pure sanitizer, never a shell or services().
  assert.equal(sanitizeShellString("service“quoted”–name"), "servicequotedname");
  for (const character of "‘’‚‛“”„–—―") assert.equal(sanitizeShellString(`a${character}b`), "ab");
  assert.equal(sanitizeShellString("WasalX.Service_1-2"), "WasalX.Service_1-2");
});

test("Node runtime exports WasalX metrics and traces as OTLP protobuf without sensitive dimensions", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = Object.fromEntries([
    "NODE_ENV",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_METRIC_EXPORT_INTERVAL_MS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SDK_DISABLED",
    "OTEL_SERVICE_INSTANCE_ID",
    "OTEL_SERVICE_NAME",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "test",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    OTEL_EXPORTER_OTLP_TIMEOUT: "10000",
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=test,tenant.id=tenant-resource-must-never-export,customer.phone=12025550178",
    OTEL_SDK_DISABLED: "false",
    OTEL_SERVICE_INSTANCE_ID: "runtime-proof-1",
    OTEL_SERVICE_NAME: "wasalx-observability-proof",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const runtime = await import("../packages/observability/dist/node.js");
  const observability = await import("../packages/observability/dist/index.js");
  runtime.startNodeObservability({ serviceName: "wasalx-observability-proof", serviceVersion: "test" });

  await observability.withSpan(
    "proof.process_provider_event",
    {
      attributes: {
        "wasalx.component": "runtime_proof",
        "wasalx.provider": "waha",
        "wasalx.request_id": "request-proof-1",
      },
    },
    async () => {
      observability.recordMetric("wasalx_webhook_accepted_total", 1, {
        provider: "waha",
        result: "accepted",
        tenant_id: "tenant-must-never-export",
        phone: "12025550178",
      });
      observability.recordWebhook("waha", "rejected", "signature");
    },
  );
  await runtime.shutdownNodeObservability();

  const traceRequests = requests.filter((request) => request.path === "/v1/traces");
  const metricRequests = requests.filter((request) => request.path === "/v1/metrics");
  assert.ok(traceRequests.length > 0, "expected at least one OTLP trace export");
  assert.ok(metricRequests.length > 0, "expected at least one OTLP metric export");
  assert.ok(traceRequests.every((request) => request.contentType === "application/x-protobuf"));
  assert.ok(metricRequests.every((request) => request.contentType === "application/x-protobuf"));

  const tracePayload = Buffer.concat(traceRequests.map((request) => request.body)).toString("latin1");
  const metricPayload = Buffer.concat(metricRequests.map((request) => request.body)).toString("latin1");
  const exportedPayload = `${tracePayload}${metricPayload}`;
  assert.match(tracePayload, /proof\.process_provider_event/u);
  assert.match(metricPayload, /wasalx_webhook_accepted_total/u);
  assert.match(metricPayload, /wasalx_webhook_rejected_total/u);
  assert.match(metricPayload, /signature/u);
  assert.match(metricPayload, /runtime-proof-1/u);
  assert.doesNotMatch(metricPayload, /tenant-must-never-export/u);
  assert.doesNotMatch(metricPayload, /12025550178/u);
  assert.doesNotMatch(exportedPayload, /tenant-resource-must-never-export/u);
  assert.doesNotMatch(exportedPayload, /customer\.phone/u);
  assert.doesNotMatch(exportedPayload, /process\.command_args/u);
  assert.doesNotMatch(exportedPayload, /process\.owner/u);
});

test("production observability fails closed when the OTLP endpoint is missing", async () => {
  const runtime = await import("../packages/observability/dist/node.js");
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED,
  };
  process.env.NODE_ENV = "production";
  process.env.OTEL_SDK_DISABLED = "false";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  try {
    assert.throws(
      () => runtime.startNodeObservability({ serviceName: "example-runtime" }),
      /OTEL_EXPORTER_OTLP_ENDPOINT is required in production/u,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runtime aggregate metrics remain identifier-free and execute-only", async () => {
  const [migration, privilegeMigration] = await Promise.all([
    readFile(
      new URL("../services/control-api/migrations/0021_observability_runtime_metrics.sql", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../services/control-api/migrations/0031_observability_metric_privileges.sql", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(migration, /RETURNS TABLE\(metric text, dimension text, value double precision\)/u);
  assert.match(migration, /SECURITY DEFINER/u);
  assert.match(migration, /SET row_security = off/u);
  assert.match(migration, /OWNER TO wasalx_scheduler_reader/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.observability_runtime_metrics\(\) FROM PUBLIC/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.observability_runtime_metrics\(\) TO wasalx_app/u);
  assert.doesNotMatch(migration, /RETURNS TABLE\([^)]*(?:tenant_id|connection_id|message_id|phone|reference)/u);
  for (const requiredGrant of [
    /GRANT SELECT \(status,received_at,lease_expires_at\)[\s\S]*event_inbox/u,
    /GRANT SELECT \(state,created_at,lease_expires_at\)[\s\S]*delivery_outbox/u,
    /GRANT SELECT \(completed_at,created_at,lease_expires_at\)[\s\S]*zammad_status_outbox/u,
    /GRANT SELECT \(state,created_at,lease_expires_at\)[\s\S]*connection_operations/u,
    /GRANT SELECT \(state,created_at,lease_expires_at\)[\s\S]*privacy_jobs/u,
  ]) {
    assert.match(migration, requiredGrant);
    assert.match(privilegeMigration, requiredGrant);
  }
  assert.doesNotMatch(privilegeMigration, /TO wasalx_app/u);
});

test("deployment wiring uses privacy-safe WasalX resources and actionable WAHA alerts", async () => {
  const [config, provisioner, compose, alerts, connector, webhook] = await Promise.all([
    readFile(new URL("../infra/helm/wasalx/templates/config.yaml", import.meta.url), "utf8"),
    readFile(new URL("../infra/helm/wasalx/templates/tenant-provisioner.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.full.yaml", import.meta.url), "utf8"),
    readFile(new URL("../infra/helm/wasalx/files/observability-rules.yaml", import.meta.url), "utf8"),
    readFile(new URL("../services/connector-worker/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/webhook-ingress.controller.ts", import.meta.url), "utf8"),
  ]);
  assert.match(config, /WASALX_ENVIRONMENT:/u);
  assert.match(config, /OTEL_METRIC_EXPORT_INTERVAL:/u);
  assert.doesNotMatch(config, /OTEL_RESOURCE_ATTRIBUTES:/u);
  assert.match(provisioner, /name: WASALX_ENVIRONMENT/u);
  assert.doesNotMatch(provisioner, /name: OTEL_RESOURCE_ATTRIBUTES/u);
  assert.match(compose, /WASALX_ENVIRONMENT: local-full/u);
  assert.doesNotMatch(compose, /OTEL_RESOURCE_ATTRIBUTES:/u);
  assert.match(alerts, /alert: WasalXWahaWorkerTelemetryMissing/u);
  assert.match(alerts, /alert: WasalXWahaWorkerUnhealthy/u);
  assert.match(alerts, /alert: WasalXWahaWorkerCapacityHigh/u);
  assert.match(alerts, /wasalx_waha_worker_sessions/u);
  assert.match(alerts, /wasalx_waha_worker_capacity/u);
  assert.match(alerts, /wasalx_worker_heartbeat\{component="connector_worker"\}/u);
  assert.match(
    connector,
    /recordMetric\("wasalx_worker_heartbeat", ready \? 1 : 0, \{ component: "connector_worker" \}\)/u,
  );
  assert.match(webhook,/function rejectWaha\(reason:"route"\|"algorithm"\|"timestamp"\|"stale"\|"signature"\|"ownership"\|"event",error:Error\):never\{recordWebhook\("waha","rejected",reason\);throw error\}/u);
});
