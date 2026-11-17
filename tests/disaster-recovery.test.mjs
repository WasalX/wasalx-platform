import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBackup } from "../scripts/dr/decrypt-backup.mjs";
import test from "node:test";
import {
  DrContractError,
  evaluateDrReadiness,
  validateBackupManifest,
  validateObjectProtectionEvidence,
  validatePitrEvidence,
  validateRestoreEvidence,
} from "../scripts/dr/contracts.mjs";

const now = new Date("2026-08-10T09:00:00.000Z");
const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000002";
const controlBackupId = "30000000-0000-4000-8000-000000000003";
const tenantABackupId = "40000000-0000-4000-8000-000000000004";
const tenantBBackupId = "50000000-0000-4000-8000-000000000005";

function manifest({ kind = "control-plane", tenantId = null, backupId = controlBackupId, completedAt = "2026-08-10T08:30:00.000Z" } = {}) {
  const suffix = tenantId ? tenantId.replaceAll("-", "") : "control";
  const artifactHash = tenantId ? suffix.padEnd(64, "a").slice(0, 64) : "c".repeat(64);
  return {
    schemaVersion: 1,
    backupId,
    workload: {
      kind,
      tenantId,
      databaseName: tenantId ? `zammad_${suffix}` : "wasalx",
      region: "sa-riyadh-1",
    },
    createdAt: "2026-08-10T08:20:00.000Z",
    completedAt,
    artifact: { format: "postgres-custom", plaintextSha256: artifactHash, sizeBytes: 4_096, pgDumpMajor: 17 },
    storage: {
      bucket: "wasalx-backups",
      objectKey: tenantId ? `tenants/${tenantId}/backups/${backupId}.dump` : `control-plane/backups/${backupId}.dump`,
      objectVersionId: `version-${backupId}`,
      versioningState: "Enabled",
      observedAt: "2026-08-10T08:31:00.000Z",
      observationSource: { mode: "provider-api-live", provider: "test-provider", requestId: `request-${backupId}` },
      lifecycleRuleId: "wasalx-noncurrent-retention",
      encryption: { mode: "SSE_KMS", algorithm: "AES256", keyReference: "arn:aws:kms:sa-east-1:123456789012:key/example" },
    },
  };
}

function pitr() {
  return {
    schemaVersion: 1,
    kind: "control-plane-postgresql-pitr",
    environment: "pilot",
    capturedAt: "2026-08-10T08:55:00.000Z",
    source: { mode: "provider-api-live", provider: "test-provider", requestId: "pitr-request-0001" },
    clusterId: "control-postgres-pilot",
    pitr: {
      state: "ENABLED",
      continuousWalProtection: true,
      encryptionAtRest: true,
      keyReference: "arn:aws:kms:sa-east-1:123456789012:key/example",
      earliestRestorableAt: "2026-08-01T08:50:00.000Z",
      latestRestorableAt: "2026-08-10T08:50:00.000Z",
    },
  };
}

function objects() {
  return {
    schemaVersion: 1,
    kind: "object-storage-protection",
    environment: "pilot",
    capturedAt: "2026-08-10T08:55:00.000Z",
    source: { mode: "provider-api-live", provider: "test-provider", requestId: "object-request-0001" },
    buckets: [{
      name: "wasalx-backups",
      versioningState: "Enabled",
      encryption: { mode: "SSE_KMS", algorithm: "AES256", keyReference: "arn:aws:kms:sa-east-1:123456789012:key/example" },
      lifecycle: { ruleId: "wasalx-noncurrent-retention", noncurrentVersionRetentionDays: 30, abortIncompleteMultipartUploadDays: 7 },
      tenantPrefixIsolation: true,
    }],
  };
}

function restore(manifestValue, rehearsalId) {
  const manifestSha256 = validateBackupManifest(manifestValue, now).manifestSha256;
  return {
    schemaVersion: 1,
    kind: "postgres-disposable-restore",
    rehearsalId,
    backupId: manifestValue.backupId,
    workload: { kind: manifestValue.workload.kind, tenantId: manifestValue.workload.tenantId },
    startedAt: "2026-08-09T07:00:00.000Z",
    completedAt: "2026-08-09T07:05:00.000Z",
    artifact: { plaintextSha256: manifestValue.artifact.plaintextSha256, manifestSha256, sizeBytes: manifestValue.artifact.sizeBytes },
    target: {
      kind: "disposable-docker",
      image: `postgres:17.10-alpine@sha256:${"a".repeat(64)}`,
      networkMode: "none",
      publishedPorts: 0,
      readOnlyArtifactMount: true,
      destroyed: true,
    },
    validation: { result: "PASSED", requiredTables: ["schema_migrations"], migrationCount: 25, databaseRestoreSeconds: 120 },
  };
}

test("backup manifests admit PostgreSQL 18 and reject unsupported dump majors", () => {
  const value = manifest();
  value.artifact.pgDumpMajor = 18;
  assert.equal(validateBackupManifest(value, now).artifact.pgDumpMajor, 18);
  value.artifact.pgDumpMajor = 19;
  assert.throws(() => validateBackupManifest(value, now), DrContractError);
});

test("client encryption binds ciphertext and cannot be asserted on a plaintext manifest", () => {
  const value = manifest();
  value.storage.objectKey += ".age";
  value.storage.encryption = { mode: "CLIENT_ENVELOPE", algorithm: "age-x25519", keyReference: `key:age1${"q".repeat(58)}` };
  value.artifact.ciphertextSha256 = "d".repeat(64);
  value.artifact.ciphertextSizeBytes = 4300;
  const verified = validateBackupManifest(value, now);
  for (const mutate of [
    (copy) => { delete copy.artifact.ciphertextSha256; },
    (copy) => { copy.artifact.ciphertextSha256 = copy.artifact.plaintextSha256; },
    (copy) => { copy.artifact.ciphertextSizeBytes = 0; },
    (copy) => { copy.storage.encryption.algorithm = "plaintext"; },
    (copy) => { copy.storage.encryption.mode = "SSE_KMS"; },
    (copy) => { copy.storage.objectKey = copy.storage.objectKey.slice(0, -4); },
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(() => validateBackupManifest(copy, now), DrContractError);
  }
  const changed = structuredClone(value);
  changed.artifact.ciphertextSha256 = "e".repeat(64);
  assert.notEqual(validateBackupManifest(changed, now).manifestSha256, verified.manifestSha256);
});

test("backup manifests bind tenant database, object prefix, encryption, version, and live observation", () => {
  const value = manifest({ kind: "tenant-zammad", tenantId: tenantA, backupId: tenantABackupId });
  assert.deepEqual(validateBackupManifest(value, now).workload, {
    kind: "tenant-zammad",
    tenantId: tenantA,
    databaseName: `zammad_${tenantA.replaceAll("-", "")}`,
    region: "sa-riyadh-1",
  });
  assert.throws(
    () => validateBackupManifest({ ...value, storage: { ...value.storage, objectKey: `tenants/${tenantB}/backups/cross-tenant.dump` } }, now),
    error => error instanceof DrContractError && error.code === "BACKUP_OBJECT_ISOLATION",
  );
  assert.throws(
    () => validateBackupManifest({ ...value, storage: { ...value.storage, objectVersionId: "null" } }, now),
    error => error instanceof DrContractError && error.code === "BACKUP_OBJECT_VERSION",
  );
  assert.throws(
    () => validateBackupManifest({ ...value, providerToken: "must-not-enter-evidence" }, now),
    error => error instanceof DrContractError && error.code === "EVIDENCE_SECRET",
  );
  assert.throws(
    () => validateBackupManifest({
      ...value,
      storage: {
        ...value.storage,
        encryption: { ...value.storage.encryption, keyReference: "https://fixture:placeholder@api.example.test/path" },
      },
    }, now),
    error => error instanceof DrContractError && error.code === "CONTRACT_REFERENCE",
  );
});

test("PITR and object-store gates require fresh non-local live-provider evidence", () => {
  assert.equal(validatePitrEvidence(pitr(), now).pitr.state, "ENABLED");
  assert.equal(validateObjectProtectionEvidence(objects(), now).buckets[0].versioningState, "Enabled");
  assert.throws(
    () => validatePitrEvidence({ ...pitr(), environment: "local" }, now),
    error => error instanceof DrContractError && error.code === "PITR_ENVIRONMENT",
  );
  assert.throws(
    () => validatePitrEvidence({ ...pitr(), pitr: { ...pitr().pitr, continuousWalProtection: false } }, now),
    error => error instanceof DrContractError && error.code === "PITR_WAL",
  );
  assert.throws(
    () => validateObjectProtectionEvidence({ ...objects(), capturedAt: "2026-08-08T08:00:00.000Z" }, now),
    error => error instanceof DrContractError && error.code === "OBJECT_STALE",
  );
});

test("restore evidence proves a read-only artifact mount and destroyed network-isolated target", () => {
  const value = restore(manifest(), "60000000-0000-4000-8000-000000000006");
  assert.equal(validateRestoreEvidence(value, now).validation.result, "PASSED");
  assert.throws(
    () => validateRestoreEvidence({ ...value, target: { ...value.target, networkMode: "bridge" } }, now),
    error => error instanceof DrContractError && error.code === "RESTORE_NETWORK",
  );
  assert.throws(
    () => validateRestoreEvidence({ ...value, target: { ...value.target, destroyed: false } }, now),
    error => error instanceof DrContractError && error.code === "RESTORE_CLEANUP",
  );
});

test("release readiness requires fresh backup and restore coverage for every active tenant", () => {
  const control = manifest();
  const a = manifest({ kind: "tenant-zammad", tenantId: tenantA, backupId: tenantABackupId });
  const b = manifest({ kind: "tenant-zammad", tenantId: tenantB, backupId: tenantBBackupId });
  const ready = evaluateDrReadiness({
    pitrEvidence: pitr(),
    objectProtectionEvidence: objects(),
    backupManifests: [control, a, b],
    restoreEvidence: [
      restore(control, "60000000-0000-4000-8000-000000000006"),
      restore(a, "70000000-0000-4000-8000-000000000007"),
      restore(b, "80000000-0000-4000-8000-000000000008"),
    ],
    activeTenantIds: [tenantA, tenantB],
    now,
  });
  assert.equal(ready.status, "READY");
  const alteredAfterRehearsal = evaluateDrReadiness({
    pitrEvidence: pitr(),
    objectProtectionEvidence: objects(),
    backupManifests: [
      { ...control, storage: { ...control.storage, objectVersionId: "version-changed-after-rehearsal" } },
      a,
      b,
    ],
    restoreEvidence: [
      restore(control, "60000000-0000-4000-8000-000000000006"),
      restore(a, "70000000-0000-4000-8000-000000000007"),
      restore(b, "80000000-0000-4000-8000-000000000008"),
    ],
    activeTenantIds: [tenantA, tenantB],
    now,
  });
  assert.equal(alteredAfterRehearsal.status, "BLOCKED");
  assert.ok(alteredAfterRehearsal.issues.some(entry => entry.code === "RESTORE_ARTIFACT_UNBOUND"));
  const blocked = evaluateDrReadiness({
    pitrEvidence: pitr(),
    objectProtectionEvidence: objects(),
    backupManifests: [control, a],
    restoreEvidence: [restore(control, "60000000-0000-4000-8000-000000000006")],
    activeTenantIds: [tenantA, tenantB],
    now,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.issues.some(entry => entry.code === "BACKUP_MISSING" && entry.message.includes(tenantB)));
  assert.ok(blocked.issues.some(entry => entry.code === "RESTORE_REHEARSAL_MISSING" && entry.message.includes(tenantB)));
});

test("local MinIO bootstrap enables versioning, imports lifecycle, and verifies both buckets", async () => {
  const bootstrap = new URL("../infra/docker/full/minio/bootstrap.sh", import.meta.url);
  const script = await readFile(bootstrap, "utf8");
  const lifecycle = JSON.parse(await readFile(new URL("../infra/docker/full/minio/noncurrent-lifecycle.json", import.meta.url), "utf8"));
  const executable = process.platform === "win32"
    ? execFileSync("git", ["ls-files", "--stage", "--", "infra/docker/full/minio/bootstrap.sh"], {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
      }).startsWith("100755 ")
    : Boolean((await stat(bootstrap)).mode & 0o100);
  assert.ok(executable, "bootstrap must be executable");
  for (const bucket of ["wasalx-media", "waha-media"]) {
    assert.match(script, new RegExp(`mc mb[\\s\\S]*${bucket}`));
  }
  assert.match(script, /mc version enable/);
  assert.match(script, /mc ilm rule import/);
  assert.match(script, /mc version info/);
  assert.match(script, /mc ilm rule ls --json/);
  assert.equal(lifecycle.Rules[0].ID, "wasalx-noncurrent-retention");
  assert.equal(lifecycle.Rules[0].Status, "Enabled");
  assert.equal(lifecycle.Rules[0].NoncurrentVersionExpiration.NoncurrentDays, 30);
  assert.equal(lifecycle.Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation, 7);
});

test("restore runner cannot target a database endpoint and keeps the disposable container isolated", async () => {
  const script = await readFile(new URL("../scripts/dr/rehearse-postgres-restore.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /--target-url|DATABASE_URL|DROP DATABASE|--publish|\s-p\s/u);
  assert.match(script, /"--network", "none"/);
  assert.match(script, /target=\/backup\/input\.dump,readonly/);
  assert.match(script, /docker", \["rm", "--force", "--volumes"/);
  assert.match(script, /flag: "wx"/);
  assert.match(script, /@sha256:[0-9a-f]{64}/);
});

test("PITR inspector is read-only and cannot promote database settings into release proof", async () => {
  const script = await readFile(new URL("../scripts/dr/inspect-postgres-pitr.mjs", import.meta.url), "utf8");
  assert.match(script, /BEGIN READ ONLY/);
  assert.match(script, /archive_command_state/);
  assert.match(script, /configured-not-disclosed/);
  assert.match(script, /releaseGateStatus: "UNPROVEN"/);
  assert.doesNotMatch(script, /CREATE |ALTER |DROP |DELETE |INSERT |UPDATE /u);
  assert.doesNotMatch(script, /process\.argv\[2\].*postgres/iu);
});

test("operator decryption rejects altered ciphertext before invoking age or creating plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-decrypt-"));
  try {
    const value = manifest();
    value.storage.objectKey += ".age";
    value.storage.encryption = { mode: "CLIENT_ENVELOPE", algorithm: "age-x25519", keyReference: `key:age1${"q".repeat(58)}` };
    value.artifact.ciphertextSha256 = "d".repeat(64);
    value.artifact.ciphertextSizeBytes = 3;
    const files = ["manifest.json", "cipher", "identity", "plain"].map(file => join(directory, file));
    await writeFile(files[0], JSON.stringify(value));
    await writeFile(files[1], "bad");
    await writeFile(files[2], "unused synthetic identity");
    await assert.rejects(decryptBackup(...files), /Ciphertext does not match manifest/u);
    await assert.rejects(stat(files[3]), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true }); }
});
