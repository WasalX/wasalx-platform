import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("migration 0012 creates a tenant-isolated idempotency ledger with no response payload storage", async () => {
  const sql = await read("services/control-api/migrations/0012_connection_auth_actions.sql");
  assert.match(sql, /CREATE TABLE connection_auth_actions/);
  assert.match(sql, /action_type IN \('PAIRING_CODE','PASSKEY_ASSERTION','PASSKEY_CONFIRM'\)/);
  assert.match(sql, /request_sha256 text NOT NULL/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, connection_id\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY tenant_isolation/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.connection_auth_actions TO wasalx_app/);
  assert.doesNotMatch(sql, /response_(?:body|json|ciphertext)|pairing_code\s+(?:text|jsonb|bytea)|challenge\s+(?:text|jsonb|bytea)|assertion\s+(?:text|jsonb|bytea)/i);
});

test("PostgreSQL integration discovers and applies the complete ordered migration set", async () => {
  const integration = await read("scripts/test-postgres-integration.mjs");
  const migrator = await read("services/control-api/src/migrate.ts");
  assert.match(integration, /readdir\(controlMigrationsUrl\)/);
  assert.match(integration, /for\(const file of appliedBeforeOwnership\)/);
  assert.match(integration, /await migrate\(/);
  assert.match(integration, /new Set\(migrationFiles\.map\(file=>file\.slice\(0,4\)\)\)/);
  assert.match(integration, /fresh migration did not reach the blocked step/u);
  assert.match(migrator, /__wasalx_clean_install_0133__/u);
  assert.match(migrator, /marker\.checksum_sha256 !== manifestChecksum/u);
  assert.match(migrator, /DELETE FROM public\.wasalx_schema_migrations WHERE name=\$1/u);
});
