import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../services/control-api/migrations/0007_connection_operations.sql",
  import.meta.url,
);
const stagingMigrationUrl = new URL(
  "../services/control-api/migrations/0111_secret_provisioning_stages.sql",
  import.meta.url,
);
const lifecycleSafetyMigrationUrl = new URL(
  "../services/control-api/migrations/0140_gows_group_lifecycle_safety.sql",
  import.meta.url,
);

async function migration() {
  return readFile(migrationUrl, "utf8");
}

async function stagingMigration() {
  return readFile(stagingMigrationUrl, "utf8");
}

test("connection operations cover every supported durable lifecycle command", async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE connection_operations/);
  for (const operation of [
    "PROVISION",
    "START",
    "RESTART",
    "PAUSE",
    "DISCONNECT",
    "SYNC_GROUPS",
  ]) {
    assert.match(sql, new RegExp(`'${operation}'`));
  }
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, connection_id\)/);
});

test("connection operations are tenant isolated and retain requester audit correlation", async () => {
  const sql = await migration();
  assert.match(sql, /ALTER TABLE connection_operations ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE connection_operations FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /tenant_id = app\.current_tenant_id\(\)/);
  assert.match(sql, /requested_by_type text NOT NULL/);
  assert.match(sql, /requested_by_id text NOT NULL/);
  assert.match(sql, /request_id text NOT NULL/);
  assert.match(sql, /connection_operations_request_idx/);
});

test("operation claims recover expired leases, fence stale workers, and terminalize exhaustion", async () => {
  const sql = await migration();
  assert.match(sql, /claim_connection_operations/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /state = 'RUNNING' AND candidate\.lease_expires_at < now\(\)/);
  assert.match(sql, /attempts = operation\.attempts \+ 1/);
  assert.match(sql, /fencing_token = operation\.fencing_token \+ 1/);
  assert.match(sql, /MAX_ATTEMPTS_EXHAUSTED/);
  assert.match(sql, /state = 'FAILED_TERMINAL'/);
  assert.match(sql, /max_attempts integer NOT NULL DEFAULT 8/);
  assert.match(sql, /FAILED_RETRYABLE/);
  assert.match(sql, /completed_at timestamptz/);
});

test("completion and failure transitions require the current lease and fencing token", async () => {
  const sql = await migration();
  assert.match(sql, /complete_connection_operation/);
  assert.match(sql, /fail_connection_operation/);
  assert.match(sql, /lease_id = worker_lease/);
  assert.match(sql, /fencing_token = expected_fencing_token/);
  assert.match(sql, /lease_expires_at >= now\(\)/);
  assert.match(sql, /attempts < max_attempts THEN 'FAILED_RETRYABLE'/);
});

test("provider session ownership is singular and independently fenced", async () => {
  const sql = await migration();
  assert.match(sql, /provider_sessions_one_active_per_connection_idx/);
  assert.match(sql, /WHERE ownership_state = 'ACTIVE'/);
  assert.match(sql, /acquire_provider_session_lease/);
  assert.match(sql, /renew_provider_session_lease/);
  assert.match(sql, /fencing_token = fencing_token \+ 1/);
  assert.match(sql, /fencing_token = expected_fencing_token/);
  assert.match(sql, /provider_sessions_tenant_connection_fk/);
  assert.match(sql, /provider_state text/);
  assert.match(sql, /provider_state_data jsonb/);
  assert.match(sql, /ADD COLUMN sync_state text NOT NULL DEFAULT 'ACTIVE'/);
});

test("runtime role can use the operation table only through tenant-scoped RLS", async () => {
  const sql = await migration();
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON connection_operations TO wasalx_app/,
  );
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.claim_connection_operations/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.complete_connection_operation/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.fail_connection_operation/);
  assert.doesNotMatch(sql, /BYPASSRLS|SUPERUSER/);
});

test("GOWS lifecycle safety drains admitted work in FIFO order through the connector-worker role", async () => {
  const sql = await readFile(lifecycleSafetyMigrationUrl, "utf8");
  assert.match(sql, /\(predecessor\.created_at,predecessor\.id\)<\(candidate\.created_at,candidate\.id\)/);
  assert.match(sql, /event\.received_at<=candidate\.created_at/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.claim_connection_operations\(uuid,integer\) TO wasalx_app,wasalx_connector_worker/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.queue_due_group_syncs\(integer\) TO wasalx_app,wasalx_connector_worker/);
  assert.match(sql, /CREATE TRIGGER preserve_webhook_event_admission_time/);
});

test("credential provisioning extends the existing operation queue without making staged work claimable", async () => {
  const sql = await stagingMigration();
  assert.match(sql, /'ROTATE_META_CREDENTIAL'/);
  assert.match(sql, /'STAGED'/);
  assert.match(sql, /operation\.state<>'STAGED'/);
  assert.match(sql, /ROTATE_META_CREDENTIAL'[\s\S]*FAILED_TERMINAL/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.claim_secret_cleanup_tasks\(uuid,integer\)[\s\S]*wasalx_secret_cleanup_client/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.expire_secret_provisioning_stages\(\)[\s\S]*wasalx_secret_cleanup_executor/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app\.expire_secret_provisioning_stages\(\)\s+TO wasalx_secret_cleanup_client/);
});
