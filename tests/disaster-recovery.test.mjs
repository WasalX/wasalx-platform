import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBackup } from "../scripts/dr/decrypt-backup.mjs";
import { rehearseControlPlaneBackup } from "../scripts/dr/rehearse-control-plane-backup.mjs";
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
  assert.match(script, /"--pull=never"/u);
  assert.match(script, /target=\/backup\/input\.dump,readonly/);
  assert.match(script, /docker", \["rm", "--force", "--volumes"/);
  assert.match(script, /flag: "wx"/);
  assert.match(script, /@sha256:[0-9a-f]{64}/);
  assert.match(script, /"pg_isready", "--host", "127\.0\.0\.1"/u);
});

test("quarterly restore uses the exact archive version and cleans scratch on failure", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-quarterly-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = manifest();
  value.storage.objectVersionId = "-opaque-version-id";
  const requiredEnvironment = {
    BACKUP_S3_BUCKET: value.storage.bucket, BACKUP_S3_REGION: value.workload.region,
    BACKUP_S3_ENDPOINT: "https://s3.example.test", CACHE_DIRECTORY: directory, STATE_DIRECTORY: directory,
    DOCKER_HOST: "tcp://docker.example.test:2376", DOCKER_CONTEXT: "remote-fixture",
  };
  let environment;
  const calls = [];
  let failedStage;
  let source = value;
  let scratch;
  const run = async (program, args, options) => {
    const manifestKey = `${source.storage.objectKey}.manifest.json`;
    const listedKey = failedStage === "key" ? "control-plane/backups/different.dump.manifest.json" : manifestKey;
    if (program === process.execPath) {
      if (args[0].endsWith("decrypt-backup.mjs")) {
        calls.push("decrypt");
        assert.ok(options.timeout >= 70 * 60_000);
        assert.deepEqual(args.slice(1), [
          join(scratch, "manifest.json"), join(scratch, "artifact"), environment.BACKUP_AGE_IDENTITY,
          join(scratch, "restore.dump"),
        ]);
        await writeFile(args.at(-1), "synthetic plaintext");
        return { stdout: "" };
      }
      calls.push("restore");
      assert.match(args[0], /rehearse-postgres-restore\.mjs$/u);
      assert.equal(args[4], join(scratch, failedStage === "client" ? "restore.dump" : "artifact"));
      assert.equal(options.env.DOCKER_HOST, "unix:///run/docker.sock");
      assert.equal(options.env.DOCKER_CONTEXT, undefined);
      assert.equal(args[args.indexOf("--timeout-seconds") + 1], "3600");
      assert.ok(options.timeout >= 80 * 60_000);
      if (failedStage === "restore") throw new Error("sensitive diagnostics");
      await writeFile(args[args.indexOf("--output") + 1], "synthetic evidence");
      return { stdout: "" };
    }
    assert.equal(program, "aws");
    if (args.includes("list-objects-v2")) {
      assert.equal(args[args.indexOf("--prefix") + 1], "control-plane/backups/");
      calls.push("list");
      return { stdout: JSON.stringify(listedKey) };
    }
    const key = args[args.indexOf("--key") + 1];
    const destination = args.at(-1);
    if (key === listedKey) {
      calls.push("manifest");
      scratch = join(destination, "..");
      const manifestSha256 = failedStage === "hash" ? "0".repeat(64) : validateBackupManifest(source, now).manifestSha256;
      const manifestText = JSON.stringify({ ...source, manifestSha256 });
      await writeFile(destination, failedStage === "size" ? manifestText.padEnd(1_048_577) : manifestText);
      return { stdout: JSON.stringify("manifest-version") };
    }
    calls.push("artifact");
    assert.equal(key, source.storage.objectKey);
    assert.ok(args.includes(`--version-id=${value.storage.objectVersionId}`));
    await writeFile(destination, "synthetic dump");
    const version = failedStage === "artifact" ? "wrong-version" : value.storage.objectVersionId;
    return { stdout: JSON.stringify(version) };
  };
  for (const [failure, expected, steps] of [
    [undefined, null, ["list", "manifest", "artifact", "restore"]],
    ["client", null, ["list", "manifest", "artifact", "decrypt", "restore"]],
    ["http", /requires an HTTPS S3 endpoint/u, []],
    ["credentials", /requires an HTTPS S3 endpoint/u, []],
    ["missing", /requires a backup bucket/u, []],
    ["hash", /does not match the selected backup/u, ["list", "manifest"]],
    ["key", /does not match the selected backup/u, ["list", "manifest"]],
    ["size", /manifest exceeds the evidence limit/u, ["list", "manifest"]],
    ["identity", /requires a recovery identity/u, ["list", "manifest"]],
    ["artifact", /version could not be verified/u, ["list", "manifest", "artifact"]],
    ["restore", /Disposable PostgreSQL restore failed/u, ["list", "manifest", "artifact", "restore"]],
    ["stale", /backup is stale/u, ["list", "manifest"]],
    ["bucket", /does not match the selected backup/u, ["list", "manifest"]],
  ]) {
    failedStage = failure;
    calls.length = 0;
    source = structuredClone(value);
    scratch = undefined;
    environment = { ...requiredEnvironment };
    if (failure === "http") environment.BACKUP_S3_ENDPOINT = "http://s3.example.test";
    if (failure === "credentials") environment.BACKUP_S3_ENDPOINT = "https://fixture:placeholder@s3.example.test";
    if (failure === "missing") delete environment.BACKUP_S3_BUCKET;
    if (failure === "client" || failure === "identity") {
      source.storage.objectKey += ".age";
      source.storage.encryption = { mode: "CLIENT_ENVELOPE", algorithm: "age-x25519", keyReference: `key:age1${"q".repeat(58)}` };
      source.artifact.ciphertextSha256 = "d".repeat(64);
      source.artifact.ciphertextSizeBytes = 4_300;
    }
    if (failure === "client") environment.BACKUP_AGE_IDENTITY = join(directory, "fixture-identity");
    if (failure === "stale") {
      source.createdAt = "2026-08-08T08:20:00.000Z";
      source.completedAt = "2026-08-08T08:30:00.000Z";
    }
    if (failure === "bucket") source.storage.bucket = "different-backup-bucket";
    const operation = rehearseControlPlaneBackup(environment, { run, now: () => now });
    if (expected) await assert.rejects(operation, expected);
    else {
      const result = await operation;
      assert.equal(result.backupId, value.backupId);
      assert.equal(result.manifestVersion, "manifest-version");
      assert.equal(result.artifactVersion, value.storage.objectVersionId);
      assert.equal(await readFile(result.evidence, "utf8"), "synthetic evidence");
    }
    assert.deepEqual(calls, steps);
    if (scratch) await assert.rejects(stat(scratch), { code: "ENOENT" });
  }
});

test("the quarterly systemd timer activates the one-shot restore service", async () => {
  const timer = await readFile(new URL("../scripts/dr/wasalx-control-plane-restore.timer", import.meta.url), "utf8");
  const service = await readFile(new URL("../scripts/dr/wasalx-control-plane-restore.service", import.meta.url), "utf8");
  assert.match(timer, /^OnCalendar=\*-01,04,07,10-01 04:00:00 UTC$/mu);
  assert.match(timer, /^Persistent=true$/mu);
  assert.match(service, /^Type=oneshot$/mu);
  assert.match(service, /^ExecStart=\/usr\/bin\/node scripts\/dr\/rehearse-control-plane-backup\.mjs$/mu);
  for (const setting of [
    "User=wasalx-restore", "NoNewPrivileges=true", "ProtectSystem=strict", "PrivateTmp=true",
    "UMask=0077", "StateDirectoryMode=0700", "CacheDirectoryMode=0700", "UnsetEnvironment=DOCKER_CONTEXT",
    "After=network-online.target docker.service",
  ]) {
    assert.ok(service.split(/\r?\n/u).includes(setting), setting);
  }
  const startCleanup = service.match(/^ExecStartPre=(.+)$/mu)?.[1];
  const stopCleanup = service.match(/^ExecStopPost=(.+)$/mu)?.[1];
  assert.match(startCleanup, /docker --host unix:\/\/\/run\/docker\.sock ps -aq --filter label=wasalx\.io\/purpose=dr-rehearsal/u);
  assert.match(startCleanup, /xargs -r docker --host unix:\/\/\/run\/docker\.sock rm --force --volumes/u);
  assert.equal(stopCleanup, startCleanup);
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
