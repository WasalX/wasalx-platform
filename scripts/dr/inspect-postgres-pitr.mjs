#!/usr/bin/env node
import pg from "pg";

const { Client } = pg;
const environmentName = process.argv[2] ?? "DR_CONTROL_DATABASE_URL";
if (!/^[A-Z][A-Z0-9_]{2,80}$/u.test(environmentName)) {
  throw new Error("Pass only the name of the environment variable containing the database URL");
}
const connectionString = process.env[environmentName];
if (!connectionString) throw new Error(`${environmentName} is required`);

const client = new Client({
  connectionString,
  application_name: "wasalx-dr-read-only-inspection",
  statement_timeout: 10_000,
  query_timeout: 15_000,
});
await client.connect();
let row;
try {
  await client.query("BEGIN READ ONLY");
  const result = await client.query(`SELECT
    current_setting('server_version') AS server_version,
    current_setting('wal_level') AS wal_level,
    current_setting('archive_mode') AS archive_mode,
    CASE
      WHEN current_setting('archive_command', true) IS NULL THEN 'not-visible'
      WHEN btrim(current_setting('archive_command', true)) IN ('', '(disabled)') THEN 'disabled'
      ELSE 'configured-not-disclosed'
    END AS archive_command_state,
    pg_is_in_recovery() AS is_replica,
    archived_count,
    failed_count,
    last_archived_wal,
    last_archived_time,
    last_failed_wal,
    last_failed_time
  FROM pg_stat_archiver`);
  row = result.rows[0];
  await client.query("ROLLBACK");
} finally {
  await client.end();
}

const findings = [];
if (!row || !["replica", "logical"].includes(row.wal_level)) findings.push("wal_level does not support a normal PITR chain");
if (!row || !["on", "always"].includes(row.archive_mode)) findings.push("archive_mode is not enabled on this PostgreSQL node");
if (!row || row.archive_command_state !== "configured-not-disclosed") findings.push("a WAL archive command is not visibly configured");
if (Number(row?.failed_count ?? 0) > 0 && row?.last_failed_time && (!row.last_archived_time || new Date(row.last_failed_time) > new Date(row.last_archived_time))) {
  findings.push("the most recent WAL archive observation is a failure");
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: "postgres-self-managed-pitr-inspection",
  capturedAt: new Date().toISOString(),
  status: findings.length === 0 ? "DATABASE_SETTINGS_APPEAR_READY" : "DATABASE_SETTINGS_NOT_READY",
  releaseGateStatus: "UNPROVEN",
  reason: "PostgreSQL settings cannot prove encrypted backup storage, object immutability, or a restorable provider window.",
  observation: row ? {
    serverVersion: row.server_version,
    walLevel: row.wal_level,
    archiveMode: row.archive_mode,
    archiveCommandState: row.archive_command_state,
    isReplica: row.is_replica,
    archivedCount: Number(row.archived_count),
    failedCount: Number(row.failed_count),
    lastArchivedWal: row.last_archived_wal,
    lastArchivedAt: row.last_archived_time,
    lastFailedWal: row.last_failed_wal,
    lastFailedAt: row.last_failed_time,
  } : null,
  findings,
}, null, 2)}\n`);
if (findings.length > 0) process.exitCode = 2;
