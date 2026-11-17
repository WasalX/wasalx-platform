import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SignJWT } from "jose";
import {
  ServiceUnavailableException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import { MeteringAuthService } from "../services/control-api/dist/metering-auth.service.js";
import {
  meterKeys,
  parseMeteringBatch,
  parseQuota,
  parseRate,
  parseTenantFilter,
  parseUsageWindow,
} from "../services/control-api/dist/platform-operations.controller.js";
import { MeteringService } from "../services/control-api/dist/metering.service.js";
import { MeteringReconcilerService } from "../services/control-api/dist/metering-reconciler.service.js";
import {
  operationHash,
  PlatformOperationsService,
} from "../services/control-api/dist/platform-operations.service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const migration = await readFile(
  new URL(
    "../services/control-api/migrations/0026_platform_operations_metering.sql",
    import.meta.url,
  ),
  "utf8",
);
const recoveryMigration = await readFile(
  new URL(
    "../services/control-api/migrations/0115_platform_operator_recovery.sql",
    import.meta.url,
  ),
  "utf8",
);
const controllerSource = await readFile(
  new URL(
    "../services/control-api/src/platform-operations.controller.ts",
    import.meta.url,
  ),
  "utf8",
);
const repositorySource = await readFile(
  new URL(
    "../services/control-api/src/platform-operations.repository.ts",
    import.meta.url,
  ),
  "utf8",
);

test("metering schema is forced-RLS, append-only, body-free, and role-separated", () => {
  assert.match(migration, /CREATE TABLE public\.usage_meter_events/);
  assert.match(migration, /CREATE TABLE public\.usage_daily_rollups/);
  assert.match(migration, /CREATE TABLE public\.tenant_meter_quotas/);
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 3);
  assert.match(migration, /tenant_id = app\.current_tenant_id\(\)/);
  assert.match(migration, /usage_meter_events_append_only/);
  assert.match(migration, /platform_meter_rates_append_only/);
  assert.match(migration, /wasalx_metering_ingest_client NOLOGIN NOBYPASSRLS/);
  assert.match(migration, /wasalx_platform_operations_client NOLOGIN NOBYPASSRLS/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.ingest_usage_meter_event[\s\S]*TO wasalx_metering_ingest_client/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.operator_platform_operations_overview[\s\S]*TO wasalx_platform_operations_client/);
  assert.doesNotMatch(
    migration,
    /SELECT[^;]*(?:message_body|message_text|payload|object_key|secret_reference)[^;]*FROM/is,
  );
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO wasalx_(?:metering_ingest|platform_operations)_client/i);
});

test("usage ingestion is idempotent, fingerprints content, rolls up cost, and preserves unpriced usage", () => {
  assert.match(migration, /UNIQUE \(tenant_id, source, source_event_id\)/);
  assert.match(migration, /event_sha256/);
  assert.match(migration, /period_start_value AT TIME ZONE 'UTC'/);
  assert.match(migration, /ON CONFLICT \(tenant_id,source,source_event_id\) DO NOTHING/);
  assert.match(migration, /metering event id was reused with different content/);
  assert.match(migration, /usage_daily_rollups/);
  assert.match(migration, /estimated_cost_micros/);
  assert.match(migration, /unpriced_quantity/);
  assert.match(migration, /enforcement_mode = 'OBSERVE'/);
});

test("authoritative hourly capture is checkpointed, replica-safe, and covers every required meter", () => {
  assert.match(migration, /CREATE TABLE public\.metering_capture_state/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION app\.capture_next_usage_metering_period/);
  assert.match(migration, /FROM public\.metering_capture_state WHERE singleton FOR UPDATE/);
  assert.match(migration, /date_trunc\('hour',now\(\) AT TIME ZONE 'UTC'\)/);
  for (const meter of meterKeys) assert.match(migration, new RegExp(`'${meter}'`));
  assert.match(migration, /normalized_messages/);
  assert.match(migration, /delivery_outbox/);
  assert.match(migration, /media_objects/);
  assert.match(migration, /resourceProfile/);
  assert.match(migration, /provider_sessions/);
  assert.match(migration, /Zero events add no billable quantity/);
  assert.match(migration, /app\.capture_next_usage_metering_period\(\)[\s\S]*TO wasalx_metering_ingest_client/);
});

test("platform tenant actions are derived at the execution boundary and fail closed while transitions run", () => {
  assert.match(recoveryMigration, /CREATE OR REPLACE FUNCTION app\.operator_list_tenant_operations/);
  assert.match(recoveryMigration, /WHEN p\.status IN \('FAILED','FAILED_RETRYABLE'\)[\s\S]*jsonb_build_array\('RETRY'\)/);
  assert.match(recoveryMigration, /WHEN t\.state='ACTIVE' AND p\.status='COMPLETE' AND z\.state='WORKING'[\s\S]*jsonb_build_array\('SUSPEND'\)/);
  assert.match(recoveryMigration, /WHEN t\.state='SUSPENDED' AND p\.status='SUSPENDED' AND z\.state='SUSPENDED'[\s\S]*jsonb_build_array\('RESUME'\)/);
  assert.match(recoveryMigration, /ELSE '\[\]'::jsonb/);
  assert.doesNotMatch(recoveryMigration, /WHEN t\.state='ACTIVE'[\s\S]{0,120}jsonb_build_array\('RESUME'\)/);
});

test("metering batch accepts numeric counters only and rejects duplicate IDs and arbitrary dimensions", () => {
  const periodStart = new Date(Date.now() - 3_600_000).toISOString();
  const periodEnd = new Date(Date.now() - 1_000).toISOString();
  const result = parseMeteringBatch({
    events: [
      {
        eventId: "connector-worker:hour:2026-08-10T08",
        meter: "INBOUND_MESSAGES",
        quantity: "42",
        periodStart,
        periodEnd,
        resourceId: "connection-17",
      },
      {
        eventId: "media-service:hour:2026-08-10T08",
        meter: "MEDIA_BYTES",
        quantity: "1250000",
        periodStart,
        periodEnd,
      },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].quantity, "42");
  assert.equal(meterKeys.length, 10);
  assert.throws(
    () =>
      parseMeteringBatch({
        events: [
          { ...result[0], eventId: "duplicate" },
          { ...result[1], eventId: "duplicate" },
        ],
      }),
    /unique in a batch/,
  );
  assert.throws(
    () =>
      parseMeteringBatch({
        events: [
          {
            eventId: "attempt-to-store-body",
            meter: "MESSAGE_BODY",
            quantity: "1",
            periodStart,
            periodEnd,
          },
        ],
      }),
    /Meter key is invalid/,
  );
});

test("quota, rate, usage-window, and tenant-list inputs are bounded", () => {
  assert.deepEqual(
    parseQuota(tenantId, "CONNECTED_NUMBER_HOURS", {
      period: "MONTH",
      softLimit: "1000",
      hardLimit: "1250",
      expectedVersion: 2,
    }),
    {
      tenantId,
      meter: "CONNECTED_NUMBER_HOURS",
      period: "MONTH",
      softLimit: "1000",
      hardLimit: "1250",
      expectedVersion: 2,
    },
  );
  assert.throws(
    () =>
      parseQuota(tenantId, "CONNECTED_NUMBER_HOURS", {
        period: "MONTH",
        softLimit: "1000",
        hardLimit: "999",
      }),
    /below the soft limit/,
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(
    parseRate({
      meter: "INBOUND_MESSAGES",
      unitPriceMicros: 25,
      currency: "SAR",
      effectiveFrom: today,
    }).unitPriceMicros,
    25,
  );
  assert.equal(parseTenantFilter("FAILED", "north", "25").limit, 25);
  assert.throws(() => parseTenantFilter(undefined, undefined, "101"), /between 1 and 100/);
  assert.throws(
    () => parseTenantFilter(undefined, undefined, undefined, "opaque-not-a-uuid"),
    /cursor is invalid/,
  );
  const window = parseUsageWindow(
    tenantId,
    new Date(Date.now() - 86_400_000).toISOString(),
    new Date().toISOString(),
  );
  assert.equal(window.tenantId, tenantId);
});

test("metering service tokens have a dedicated issuer, audience, scope, tenant, source, and five-minute ceiling", async () => {
  const secret = "metering-test-secret-at-least-32-bytes-long";
  const previous = process.env.METERING_SERVICE_JWT_SECRET;
  process.env.METERING_SERVICE_JWT_SECRET = secret;
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: tenantId,
      source: "connector-worker",
      scope: "metering:write",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("wasalx-runtime")
      .setAudience("wasalx-metering")
      .setSubject("connector-worker-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));
    assert.deepEqual(await new MeteringAuthService().authenticate(`Bearer ${token}`), {
      tenantId,
      source: "connector-worker",
      subject: "connector-worker-1",
    });
    const wrongAudience = await new SignJWT({
      tenant_id: tenantId,
      source: "connector-worker",
      scope: "metering:write",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("wasalx-runtime")
      .setAudience("wasalx-control")
      .setSubject("connector-worker-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));
    await assert.rejects(
      () => new MeteringAuthService().authenticate(`Bearer ${wrongAudience}`),
      /Invalid metering service token/,
    );
    const futureIssued = await new SignJWT({
      tenant_id: tenantId,
      source: "connector-worker",
      scope: "metering:write",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("wasalx-runtime")
      .setAudience("wasalx-metering")
      .setSubject("connector-worker-1")
      .setIssuedAt(now + 600)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(secret));
    await assert.rejects(
      () => new MeteringAuthService().authenticate(`Bearer ${futureIssued}`),
      /Invalid metering service token/,
    );
  } finally {
    if (previous === undefined) delete process.env.METERING_SERVICE_JWT_SECRET;
    else process.env.METERING_SERVICE_JWT_SECRET = previous;
  }
});

test("platform and metering repositories fail closed without execution-only identities", async () => {
  const platform = new PlatformOperationsService({
    isConfigured: () => false,
  });
  await assert.rejects(
    () =>
      platform.overview(
        {
          subject: "operator",
          email: "operator@example.test",
          displayName: "Operator",
          authenticatedAt: 1,
        },
        "request-1",
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /least-privilege platform operations database role/.test(error.message),
  );
  const metering = new MeteringService({ isConfigured: () => false });
  await assert.rejects(
    () =>
      metering.ingest(
        { tenantId, source: "connector-worker", subject: "worker-1" },
        [],
      ),
    /least-privilege metering ingestion database role/,
  );
  assert.match(repositorySource, /role=wasalx_platform_operations_client/);
});

test("platform API remains behind the dedicated operator guard and deterministic idempotency hashes", () => {
  assert.match(controllerSource, /@SkipTenantAuthentication\(\)/);
  assert.match(controllerSource, /@PlatformOperatorOnly\(\)/);
  assert.match(controllerSource, /@UseGuards\(PlatformOperatorGuard\)/);
  assert.match(controllerSource, /@Controller\("internal\/v1\/metering"\)/);
  assert.notEqual(
    operationHash({ action: "SET_QUOTA", softLimit: "100" }),
    operationHash({ action: "SET_QUOTA", softLimit: "101" }),
  );
});

test("metering reconciler bounds catch-up and stops when the durable checkpoint is current", async () => {
  const calls = [];
  const reconciler = new MeteringReconcilerService({
    isConfigured: () => true,
    captureNextPeriod: async () => {
      calls.push(true);
      return calls.length === 1
        ? { caught_up: false, period_start: "2026-08-10T08:00:00.000Z" }
        : { caught_up: true, period_start: "2026-08-10T09:00:00.000Z" };
    },
  });
  await reconciler.tick();
  assert.equal(calls.length, 2);
  reconciler.onModuleDestroy();
});
