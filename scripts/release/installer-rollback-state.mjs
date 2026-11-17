import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { devContainerPreimage, devValueDigest } from "./installer-stack.mjs";

export const rollbackStatePath = (context, kind) => resolve(context.privateDirectory, `${kind}-${context.project}.json`);

export async function readOptionalState(context, kind) {
  try { return JSON.parse(await readFile(rollbackStatePath(context, kind), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

export async function observeRollbackState(context, rows) {
  const result = { databases: {}, migrationLedger: null, unknownFields: [] };
  for (const row of rows) {
    const service = row.Config.Labels["com.docker.compose.service"], field = `services.${service}`;
    if (/postgres/u.test(service)) {
      const environment = Object.fromEntries((row.Config.Env ?? []).map((entry) => {
        const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)];
      }));
      const query = (sql) => context.command("docker", ["exec", row.Id, "psql", "-U", environment.POSTGRES_USER ?? "wasalx",
        "-d", environment.POSTGRES_DB ?? "wasalx", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
        `BEGIN READ ONLY; ${sql}; COMMIT;`], context.environment);
      try {
        const wal = JSON.parse(await query("SELECT json_build_object('systemIdentifier',(pg_control_system()).system_identifier::text,'wal',pg_current_wal_insert_lsn()::text)"));
        if (!/^\d+$/u.test(wal.systemIdentifier) || !/^[0-9A-F]+\/[0-9A-F]+$/u.test(wal.wal)) throw new Error("invalid WAL observation");
        result.databases[service] = { containerId: row.Id, ...wal };
        if (service === "postgres") {
          const table = await query("SELECT to_regclass('public.wasalx_schema_migrations')");
          result.migrationLedger = table ? JSON.parse(await query("SELECT coalesce(json_agg(json_build_object('name',name,'checksum_sha256',checksum_sha256) ORDER BY name),'[]') FROM public.wasalx_schema_migrations")) : [];
          if (!Array.isArray(result.migrationLedger)) throw new Error("invalid migration observation");
        }
      } catch { result.unknownFields.push(`${field}.PostgreSQL.WAL`); }
      // A read-only observation is not an exclusive writer fence. Preserve this
      // gap instead of treating unchanged WAL as proof that future writes cannot race rollback.
      result.unknownFields.push(`${field}.PostgreSQL.concurrentWrites`);
      // WAL covers database writes, not arbitrary paths or external effects of a database image.
      if (row.HostConfig.Privileged || row.HostConfig.CapAdd?.length || row.HostConfig.Devices?.length) result.unknownFields.push(`${field}.HostConfig`);
      continue;
    }
    if (row.Mounts?.length || row.HostConfig.Binds?.length || row.HostConfig.Mounts?.length ||
        row.HostConfig.VolumesFrom?.length || Object.keys(row.HostConfig.Tmpfs ?? {}).length) result.unknownFields.push(`${field}.Mounts.protectedWriteHistory`);
    const executed = row.State.Running || (row.State.StartedAt && !row.State.StartedAt.startsWith("0001-"));
    if (!executed) continue;
    if (row.HostConfig.ReadonlyRootfs !== true) result.unknownFields.push(`${field}.RootFS.protectedWriteHistory`);
    if (row.HostConfig.NetworkMode !== "none") result.unknownFields.push(`${field}.externalEffects`);
    if (row.HostConfig.Privileged || row.HostConfig.CapAdd?.length || row.HostConfig.Devices?.length ||
        row.HostConfig.PidMode === "host" || row.HostConfig.IpcMode === "host" || !row.HostConfig.CapDrop?.includes("ALL")) {
      result.unknownFields.push(`${field}.HostConfig.protectedWriteCapabilities`);
    }
  }
  if (!context.model.services.migrate && !rows.some((row) => row.Config.Labels["com.docker.compose.service"] === "postgres")) result.migrationLedger = [];
  if (result.migrationLedger === null) result.unknownFields.push("migrationLedger");
  result.unknownFields.sort();
  return result;
}

export async function recordReplacementAfter(context, snapshot, rows, targets) {
  const record = { schemaVersion: 1, transactionId: snapshot.transactionId, targets,
    observedAt: new Date().toISOString(), containers: rows,
    observation: await observeRollbackState(context, rows) };
  const previous = await readOptionalState(context, "replacement-after");
  if (previous) assert.equal(previous.transactionId, snapshot.transactionId, "replacement postimage transaction changed");
  const path = rollbackStatePath(context, "replacement-after"), temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600, flush: true });
  await rename(temporary, path);
  return record;
}

export function assertRollbackInventory(snapshot, rows, after) {
  const services = new Set(snapshot.containers.map((row) => row.service));
  for (const [kind, containers] of [["current", rows], ["postimage", after?.containers ?? []]]) {
    assert.ok(containers.every((row) => services.has(row.Config.Labels["com.docker.compose.service"])), `unowned ${kind} rollback service`);
  }
}

export async function produceRollbackSafety(context, manifest, snapshot, rows) {
  const current = await observeRollbackState(context, rows), baseline = snapshot.rollbackObservation;
  const effects = await readOptionalState(context, "replacement-effects");
  const after = await readOptionalState(context, "replacement-after");
  assertRollbackInventory(snapshot, rows, after);
  if (after) {
    assert.equal(after.transactionId, snapshot.transactionId, "replacement postimage transaction changed");
    const project = (row) => ({ ...devContainerPreimage(row), networks: row.NetworkSettings?.Networks ?? {} });
    assert.deepEqual(rows.map(project), after.containers.map(project), "replacement postimage drift");
  }
  const unknownFields = [...(baseline?.unknownFields ?? ["preimage.rollbackObservation"]), ...current.unknownFields,
    ...(after ? after.observation?.unknownFields ?? ["replacement-after.observation"] : [])];
  let migrations = "UNKNOWN", protectedWrites = "UNKNOWN";
  if (baseline?.migrationLedger && current.migrationLedger) migrations = devValueDigest(baseline.migrationLedger) === devValueDigest(current.migrationLedger) ? "NONE" : "APPLIED";
  if (effects?.migrations === "STARTED" && migrations !== "APPLIED") migrations = "STARTED";
  if (effects && (!after || effects.transactionId !== snapshot.transactionId || after.transactionId !== snapshot.transactionId)) unknownFields.push("replacement-effects.unsettled");
  if (baseline?.databases && devValueDigest(baseline.databases) !== devValueDigest(current.databases)) protectedWrites = "OBSERVED";
  else if (baseline && unknownFields.length === 0) protectedWrites = "NONE";
  const receipt = { schemaVersion: 2, kind: "compose-rollback-safety", producer: "compose-rollback-state",
    candidateSha: context.candidateSha, candidateTree: context.candidateTree, project: context.project,
    host: snapshot.host, transactionId: snapshot.transactionId, preimageSha256: manifest.preimage.sha256,
    observedAt: new Date().toISOString(), migrations, protectedWrites,
    state: migrations === "NONE" && protectedWrites === "NONE" ? "CLEAR" : "UNKNOWN",
    unknownFields: [...new Set(unknownFields)].sort(), observation: current };
  const path = rollbackStatePath(context, "rollback-safety");
  await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flush: true });
  return receipt;
}
