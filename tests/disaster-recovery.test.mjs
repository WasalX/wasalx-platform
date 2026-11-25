import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, openSync } from "node:fs";
import { readFile, stat, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptBackup } from "../scripts/dr/decrypt-backup.mjs";
import { rehearseControlPlaneBackup } from "../scripts/dr/rehearse-control-plane-backup.mjs";
import { runPostgresRestore } from "../scripts/dr/rehearse-postgres-restore.mjs";
import { lockRestoreDrill } from "../scripts/dr/restore-drill.mjs";
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
  assert.match(script, /flag: "wx"/);
  assert.match(script, /@sha256:[0-9a-f]{64}/);
  assert.match(script, /"pg_isready", "--host", "127\.0\.0\.1"/u);
});

const dump = "synthetic plaintext";
const ownedContainer = "d".repeat(64);
const otherContainer = "e".repeat(64);
const otherDrill = "60000000-0000-4000-8000-000000000006";

function dockerDrill(directory) {
  let lockFd;
  const containers = new Map([[otherContainer, { owner: otherDrill, name: "another-drill", purpose: "dr-rehearsal" }]]);
  const removed = [];
  const fixture = {
    containers, removed, failure: undefined,
    options: {
      state: directory, cache: directory,
      lock(path) {
        if (process.platform === "linux") return lockRestoreDrill(path);
        if (lockFd !== undefined) {
          try {
            fstatSync(lockFd);
          } catch (error) {
            assert.equal(error.code, "EBADF");
            lockFd = undefined;
          }
        }
        if (lockFd !== undefined) throw new Error("Another restore drill holds the recovery lock");
        return (lockFd = openSync(path, "a+"));
      },
      spawn(program, args, options) {
        assert.equal(program, "docker");
        assert.deepEqual(args.slice(0, 2), ["--host", "unix:///run/docker.sock"]);
        assert.equal(options.env.DOCKER_CONTEXT, undefined);
        assert.equal(options.env.DOCKER_HOST, undefined);
        const output = stdout => ({ status: 0, stdout });
        const [command, first, second] = args.slice(2);
        if (command === "info") return output("test-engine");
        if (command === "run") {
          fixture.onRun?.();
          assert.ok(args.includes("wasalx.io/purpose=dr-rehearsal"));
          const owner = args.find(arg => arg.startsWith("wasalx.io/rehearsal-id=")).split("=")[1];
          const name = args[args.indexOf("--name") + 1];
          assert.equal(name, `wasalx-dr-${owner.replaceAll("-", "")}`);
          const container = { owner, name, purpose: "dr-rehearsal" };
          if (fixture.failure === "start-timeout") {
            fixture.lateContainer = container;
            return { status: null, error: new Error("Docker request timed out") };
          }
          containers.set(ownedContainer, container);
          return fixture.failure === "start" ? { status: 1 } : output(`${ownedContainer}\n`);
        }
        if (command === "container" && first === "ls") {
          assert.ok(args.includes("--no-trunc"));
          if (fixture.failure === "list" && fixture.restored) return { status: null };
          const filter = args[args.indexOf("--filter") + 1];
          assert.match(filter, /^(?:label=wasalx\.io\/rehearsal-id=[a-f0-9-]+|id=[a-f0-9]{64})$/u);
          const rows = [...containers].filter(([id, row]) => filter === `id=${id}` || filter === `label=wasalx.io/rehearsal-id=${row.owner}`);
          return output(rows.map(([id, row]) => `${id} ${row.name} ${row.purpose} ${row.owner}`).join("\n"));
        }
        if (command === "rm") {
          assert.deepEqual(args.slice(2), ["rm", "--force", "--volumes", ownedContainer]);
          if (fixture.failure === "remove") return { status: 1 };
          if (fixture.failure === "remove-still-present") return output(ownedContainer);
          removed.push(ownedContainer);
          assert.ok(containers.delete(ownedContainer));
          return output(ownedContainer);
        }
        assert.equal(command, "exec");
        assert.equal(first, ownedContainer);
        assert.ok(containers.has(first));
        if (second === "pg_isready") return output("");
        if (second === "pg_restore") {
          fixture.restored = true;
          assert.equal(options.timeout, 3_600_000);
          return fixture.failure === "restore" ? { status: 1, stderr: "restore fixture failed" } : output("");
        }
        assert.equal(second, "psql");
        const query = args.at(-1);
        return output(query.startsWith("SELECT to_regclass") ? "t\n" : "1\n");
      },
    },
  };
  return fixture;
}

function bindDump(value) {
  value.artifact.plaintextSha256 = createHash("sha256").update(dump).digest("hex");
  value.artifact.sizeBytes = Buffer.byteLength(dump);
  return value;
}

async function directRestoreArgs(directory, value) {
  const files = ["restore-manifest.json", "restore.dump", "restore-evidence.json"].map(file => join(directory, file));
  await writeFile(files[0], JSON.stringify(value));
  await writeFile(files[1], dump);
  return ["--manifest", files[0], "--artifact", files[1], "--output", files[2]];
}

test("quarterly restore uses the exact archive version and cleans scratch on failure", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-quarterly-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = bindDump(manifest());
  const fixture = dockerDrill(directory);
  fixture.onRun = () => calls.push("restore");
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
      assert.match(args[0], /decrypt-backup\.mjs$/u);
      calls.push("decrypt");
      assert.ok(options.timeout >= 70 * 60_000);
      assert.deepEqual(args.slice(1), [
        join(scratch, "manifest.json"), join(scratch, "artifact"), environment.BACKUP_AGE_IDENTITY,
        join(scratch, "restore.dump"),
      ]);
      await writeFile(args.at(-1), dump);
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
    await writeFile(destination, dump);
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
    fixture.failure = failure;
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
    const operation = rehearseControlPlaneBackup(environment, { run, now: () => now, drillOptions: fixture.options });
    if (expected) await assert.rejects(operation, expected);
    else {
      const result = await operation;
      assert.equal(result.backupId, value.backupId);
      assert.equal(result.manifestVersion, "manifest-version");
      assert.equal(result.artifactVersion, value.storage.objectVersionId);
      const receipt = JSON.parse(await readFile(result.evidence, "utf8"));
      assert.equal(receipt.backupId, result.backupId);
      assert.equal(receipt.artifact.manifestSha256, validateBackupManifest(source, now).manifestSha256);
      assert.equal(receipt.artifact.plaintextSha256, source.artifact.plaintextSha256);
      assert.equal(receipt.target.destroyed, true);
    }
    assert.deepEqual(calls, steps);
    if (scratch) await assert.rejects(stat(scratch), { code: "ENOENT" });
    assert.deepEqual([...fixture.containers.keys()], [otherContainer]);
  }
});

test("service, direct restore and interrupted cleanup contend for one lock", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = bindDump(manifest());
  const args = await directRestoreArgs(directory, value);
  const fixture = dockerDrill(directory);
  const busy = /Another restore drill holds the recovery lock/u;
  const environment = {
    BACKUP_S3_BUCKET: value.storage.bucket, BACKUP_S3_REGION: value.workload.region,
    BACKUP_S3_ENDPOINT: "https://s3.example.test", CACHE_DIRECTORY: directory, STATE_DIRECTORY: directory,
  };
  const pending = join(directory, "pending-drill");
  const otherScratch = join(directory, `rehearsal-${otherDrill}`);
  await mkdir(otherScratch);
  const service = () => rehearseControlPlaneBackup(environment, {
    drillOptions: fixture.options,
    async run() {
      const owner = (await readFile(pending, "utf8")).trim();
      await assert.rejects(runPostgresRestore(args, fixture.options), busy);
      await assert.rejects(runPostgresRestore(["--cleanup-interrupted", owner], fixture.options), busy);
      await assert.rejects(stat(args.at(-1)), { code: "ENOENT" });
      assert.ok((await stat(join(directory, `rehearsal-${owner}`))).isDirectory());
      return { stdout: "null" };
    },
  });
  await assert.rejects(service(), /No complete control-plane backup manifest/u);

  let competingService;
  fixture.onRun = () => { competingService = assert.rejects(service(), busy); };
  const receipt = JSON.parse(await runPostgresRestore(args, fixture.options));
  await competingService;
  assert.equal(receipt.target.destroyed, true);
  assert.equal(receipt.artifact.manifestSha256, validateBackupManifest(value, now).manifestSha256);
  assert.deepEqual(JSON.parse(await readFile(args.at(-1), "utf8")), receipt);
  assert.deepEqual(fixture.removed, [ownedContainer]);
  assert.ok(fixture.containers.has(otherContainer));
  assert.ok((await stat(otherScratch)).isDirectory());
  await assert.rejects(stat(pending), { code: "ENOENT" });
});

test("failed cleanup suppresses evidence, and stale recovery cannot remove another drill", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = await directRestoreArgs(directory, bindDump(manifest()));
  const fixture = dockerDrill(directory);
  const direct = () => runPostgresRestore(args, fixture.options);
  const recover = id => runPostgresRestore(["--cleanup-interrupted", id], fixture.options);
  const pending = join(directory, "pending-drill");

  fixture.failure = "start";
  await assert.rejects(direct(), /Could not start the disposable restore target/u);
  assert.deepEqual(fixture.removed, [ownedContainer], "the start may fail after creating a container");
  await assert.rejects(stat(pending), { code: "ENOENT" });

  fixture.failure = "list";
  await assert.rejects(direct(), /cleanup failed: Could not verify restore container ownership/u);
  const [firstDrill] = (await readFile(pending, "utf8")).trim().split(" ");
  fixture.failure = undefined;
  await recover(firstDrill);

  fixture.failure = "remove";
  await assert.rejects(direct(), /cleanup failed: Could not confirm removal/u);
  await assert.rejects(stat(args.at(-1)), { code: "ENOENT" });
  const [secondDrill, id] = (await readFile(pending, "utf8")).trim().split(" ");
  assert.equal(id, ownedContainer);
  assert.notEqual(firstDrill, secondDrill);
  await assert.rejects(direct(), /requires interrupted-drill cleanup/u);
  await assert.rejects(recover(firstDrill), /does not match the pending drill/u);
  assert.equal(fixture.containers.get(ownedContainer).owner, secondDrill);

  fixture.failure = undefined;
  const owned = fixture.containers.get(ownedContainer);
  fixture.containers.set(ownedContainer, { ...owned, owner: otherDrill });
  await assert.rejects(recover(secondDrill), /ownership does not match this drill/u);
  fixture.containers.set(ownedContainer, owned);
  fixture.containers.set(otherContainer, { ...owned });
  await assert.rejects(recover(secondDrill), /ownership does not match this drill/u);
  assert.deepEqual(fixture.removed, [ownedContainer, ownedContainer]);
  fixture.containers.set(otherContainer, { owner: otherDrill, name: "another-drill", purpose: "dr-rehearsal" });
  await recover(secondDrill);
  assert.deepEqual([...fixture.containers.keys()], [otherContainer]);
  await assert.rejects(stat(pending), { code: "ENOENT" });
  await assert.rejects(recover(secondDrill), /does not match the pending drill/u);
  await assert.rejects(stat(args.at(-1)), { code: "ENOENT" });
});

test("a timed-out Docker start stays pending until the late target is removed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-dr-late-target-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = await directRestoreArgs(directory, bindDump(manifest()));
  const fixture = dockerDrill(directory);
  fixture.failure = "start-timeout";
  await assert.rejects(runPostgresRestore(args, fixture.options), /Could not confirm removal/u);
  const recover = () => runPostgresRestore(["--cleanup-interrupted", fixture.lateContainer.owner], fixture.options);
  await assert.rejects(recover(), /Could not confirm removal/u);
  await assert.rejects(runPostgresRestore(args, fixture.options), /requires interrupted-drill cleanup/u);
  await assert.rejects(stat(args.at(-1)), { code: "ENOENT" });

  fixture.containers.set(ownedContainer, fixture.lateContainer);
  fixture.failure = "remove-still-present";
  await assert.rejects(recover(), /Could not confirm removal/u);
  assert.ok(fixture.containers.has(ownedContainer));
  assert.ok((await readFile(join(directory, "pending-drill"), "utf8")).endsWith(` ${ownedContainer}\n`));
  fixture.failure = undefined;
  await recover();
  assert.deepEqual(fixture.removed, [ownedContainer]);
  assert.deepEqual([...fixture.containers.keys()], [otherContainer]);
  await assert.rejects(stat(join(directory, "pending-drill")), { code: "ENOENT" });
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
    "After=network-online.target docker.service", "TimeoutStartSec=4h",
  ]) {
    assert.ok(service.split(/\r?\n/u).includes(setting), setting);
  }
  assert.doesNotMatch(service, /^Exec(?:StartPre|StopPost)=.*(?:docker|rm -rf)/mu, "systemd must not sweep resources outside the runner lock");
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
