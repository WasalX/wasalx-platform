import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../services/control-api/migrations/0011_provider_status_fencing.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../services/connector-worker/src/inbound-repository.ts",
  import.meta.url,
);
const integrationUrl = new URL("../scripts/test-postgres-integration.mjs", import.meta.url);
const dockerSmokeUrl = new URL("../scripts/test-docker-stack.sh", import.meta.url);
const connectionsControllerUrl = new URL("../services/control-api/src/connections.controller.ts", import.meta.url);
const databaseServiceUrl = new URL("../services/control-api/src/database.service.ts", import.meta.url);

test("migration 0011 adds an active-generation status timestamp fence and is in every migration gate", async () => {
  const [migration, integration, dockerSmoke] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(integrationUrl, "utf8"),
    readFile(dockerSmokeUrl, "utf8"),
  ]);

  assert.match(migration, /ADD COLUMN last_provider_status_at timestamptz/);
  assert.match(migration, /provider_sessions_status_fence_idx/);
  assert.match(migration, /WHERE ownership_state = 'ACTIVE'/);
  assert.match(integration, /const controlMigrationsUrl=/);
  assert.match(integration, /readdir\(controlMigrationsUrl\)/);
  assert.match(integration, /for\(const file of appliedBeforeOwnership\)/);
  assert.match(integration, /await migrate\(/);
  assert.match(dockerSmoke, /expected_migration_count=.*find services\/control-api\/migrations/);
  assert.match(dockerSmoke, /Expected %s migrations, received %s/);
});

test("provider status persistence serializes and fences generation, time, terminal state, and pending commands", async () => {
  const source = await readFile(repositoryUrl, "utf8");

  assert.match(source, /ps\.provider_state,ps\.provider_state_data,ps\.last_provider_status_at/);
  assert.match(source, /ps\.ownership_state='ACTIVE'/);
  assert.match(source, /FOR UPDATE OF c,ps/);
  assert.match(source, /active\.opaque_session_id!==observation\.opaqueSessionId/);
  assert.match(source, /\["PAUSED","REVOKED"\]\.includes\(active\.connection_state\)/);
  assert.match(source, /operation_type IN \('PROVISION','START','RESTART','PAUSE','DISCONNECT'\)/);
  assert.match(source, /state IN \('QUEUED','RUNNING','FAILED_RETRYABLE'\)/);
  assert.match(source, /observedAt\.getTime\(\)<=lastObserved\.getTime\(\)/);
  assert.match(source, /last_provider_status_at=\$4/);
  assert.match(source, /onboarding_qr_ready_at=CASE WHEN \$2='SCAN_QR_CODE'/);
  assert.match(source, /onboarding_scan_acknowledged_at=CASE\s+WHEN \$2='SCAN_QR_CODE'/);
  assert.match(source, /onboarding_scan_completed_at=CASE/);
  assert.match(source, /onboarding_scan_acknowledged_at<=COALESCE\(onboarding_working_at,\$4\)/);
  assert.match(source, /onboarding_working_at=CASE/);
  assert.match(source, /provider_state_data\?\.qrSequence/);
  assert.match(source, /active\.provider_state==="SCAN_QR_CODE"/);
  assert.match(source, /Math\.min\(previousQrSequence\+1,6\)/);
  assert.match(source, /id=\$7 AND ownership_state='ACTIVE'/);
});

test("connection catalog projects the same durable readiness evidence as connection details", async () => {
  const source = await readFile(connectionsControllerUrl, "utf8");
  assert.match(source, /ps\.state AS provider_session_state,ps\.provider_state/);
  assert.match(source, /ps\.onboarding_working_at,wr\.state AS webhook_state,wr\.admission_opened_at AS webhook_admission_opened_at/);
  assert.match(source, /ps\.ownership_state='ACTIVE'/);
  assert.match(source, /count\(DISTINCT g\.id\)::int AS group_count/);
  assert.match(source, /ps\.last_provider_status_at>=runtime\.last_started_at/);
});

test("WAHA boot readiness keeps the runtime tenant fence and caller signature", async () => {
  const migration = await readFile(new URL("../services/control-api/migrations/0190_waha_session_boot_readiness.sql", import.meta.url), "utf8");
  assert.match(migration, /ALTER TYPE app\.waha_session_runtime ADD ATTRIBUTE last_started_at timestamptz/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION app\.current_waha_session_runtime\(provider_session_id uuid\)/);
  assert.match(migration, /RETURNS SETOF app\.waha_session_runtime/);
  assert.match(migration, /session\.assignment_lease_expires_at,worker\.last_started_at/);
  assert.match(migration, /session\.tenant_id=app\.current_tenant_id\(\)/);
  assert.match(migration, /session\.ownership_state='ACTIVE'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.current_waha_session_runtime\(uuid\) FROM PUBLIC/);
  assert.doesNotMatch(migration, /GRANT SELECT|DROP (?:TYPE|FUNCTION)|UPDATE public\./);
  const groups = await readFile(new URL("../services/control-api/src/groups.controller.ts", import.meta.url), "utf8");
  assert.match(groups, /session\.last_provider_status_at>=runtime\.last_started_at/);
});

test("second-precision provider timestamps use the same precision as the admission fence", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /date_trunc\('second',\$4::timestamptz\)>=date_trunc\('second',route\.admission_opened_at\)/u);
  const second = value => Math.trunc(Date.parse(value) / 1_000);
  assert(second("2026-09-16T16:00:00.000Z") >= second("2026-09-16T16:00:00.999Z"));
  assert(!(second("2026-09-16T15:59:59.999Z") >= second("2026-09-16T16:00:00.000Z")));
});

test("ingress fences ordinary messages while admitting lifecycle and verified identity safety receipts", async () => {
  const source = await readFile(databaseServiceUrl, "utf8");
  assert.match(source, /route\.provider==="WAHA"&&input\.eventType==="session\.status"/u);
  assert.match(source, /route\.provider==="META"&&input\.eventType==="message\.status"/u);
  assert.match(source, /const identitySafety=route\.provider==="META"&&input\.eventType==="messages"\?metaDirectIdentityChangeEvidence\(input\.payload,input\.payloadSha256\):null/u);
  assert.match(source, /!lifecycleEvent&&!identitySafety&&\(connection\.state!=="WORKING"\|\|session\.rows\[0\]\?\.state!=="WORKING"\)/u);
  assert.match(source, /SELECT app\.resolve_meta_identity_source_asset\(\$1,\$2,\$3,\$4\) AS resolution/u);
  assert.match(source, /else if\(connection\.state!=="WORKING"\|\|currentSession\.state!=="WORKING"\|\|activeRoute\.rows\[0\]\?\.state==="PAUSED"\)throw new NotFoundException/u);
});

test("lifecycle function execution is never inherited from PostgreSQL PUBLIC", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  for (const signature of [
    "app.claim_connection_operations(uuid, integer)",
    "app.complete_connection_operation(uuid, uuid, bigint, jsonb)",
    "app.fail_connection_operation(uuid, uuid, bigint, boolean, text, text, timestamptz)",
    "app.acquire_provider_session_lease(uuid, text, interval)",
    "app.renew_provider_session_lease(uuid, text, bigint, interval)",
  ]) {
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[().]/g, "\\$&")} FROM PUBLIC;`),
    );
  }
});
