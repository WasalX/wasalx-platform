import { createHash } from "node:crypto";

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const BUCKET_NAME = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u;
export const CONTROL_BACKUP_PREFIX = "control-plane/backups/";

export const DR_OBJECTIVES = Object.freeze({
  controlPlaneRpoMinutes: 15,
  controlPlaneRtoHours: 4,
  tenantZammadRpoHours: 24,
  tenantZammadRtoHours: 8,
  searchRebuildRtoHours: 24,
  minimumPitrWindowDays: 7,
  backupFreshnessHours: 26,
  pilotRestoreRehearsalMaxAgeDays: 90,
  commercialRestoreRehearsalMaxAgeDays: 31,
});

export class DrContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DrContractError";
    this.code = code;
  }
}

export function validateBackupManifest(value, now = new Date()) {
  rejectSecretMaterial(value);
  const root = record(value, "backup manifest");
  exact(root.schemaVersion, 1, "BACKUP_SCHEMA", "Unsupported backup manifest schema");
  const backupId = uuid(root.backupId, "backupId");
  const workload = record(root.workload, "workload");
  const kind = oneOf(workload.kind, ["control-plane", "tenant-zammad"], "workload.kind");
  const tenantId = kind === "tenant-zammad"
    ? tenantUuid(workload.tenantId, "workload.tenantId")
    : nullValue(workload.tenantId, "workload.tenantId");
  const databaseName = databaseNameValue(workload.databaseName, "workload.databaseName");
  if (kind === "tenant-zammad" && databaseName !== `zammad_${tenantId.replaceAll("-", "")}`) {
    fail("BACKUP_TENANT_DATABASE", "Tenant backup database name does not match its immutable tenant ID");
  }
  const region = safeText(workload.region, "workload.region", 1, 80);
  const createdAt = timestamp(root.createdAt, "createdAt");
  const completedAt = timestamp(root.completedAt, "completedAt");
  if (completedAt < createdAt || completedAt.getTime() - createdAt.getTime() > 12 * 60 * 60 * 1_000) {
    fail("BACKUP_TIME_RANGE", "Backup completion time is invalid");
  }
  notFuture(completedAt, now, "BACKUP_FUTURE", "Backup completion time is in the future");

  const artifact = record(root.artifact, "artifact");
  exact(artifact.format, "postgres-custom", "BACKUP_FORMAT", "Only PostgreSQL custom-format artifacts are supported");
  const plaintextSha256 = sha256(artifact.plaintextSha256, "artifact.plaintextSha256");
  const sizeBytes = integer(artifact.sizeBytes, 1, 10 * 1_024 ** 4, "artifact.sizeBytes");
  const pgDumpMajor = integer(artifact.pgDumpMajor, 14, 18, "artifact.pgDumpMajor");

  const storage = record(root.storage, "storage");
  const bucket = bucketName(storage.bucket, "storage.bucket");
  const objectKey = safeText(storage.objectKey, "storage.objectKey", 1, 1_024);
  const expectedPrefix = kind === "tenant-zammad"
    ? `tenants/${tenantId}/backups/`
    : CONTROL_BACKUP_PREFIX;
  if (!objectKey.startsWith(expectedPrefix) || objectKey.includes("..") || objectKey.startsWith("/")) {
    fail("BACKUP_OBJECT_ISOLATION", "Backup object key is outside its immutable workload prefix");
  }
  const objectVersionId = safeText(storage.objectVersionId, "storage.objectVersionId", 1, 1_024);
  if (["null", "none", "unversioned"].includes(objectVersionId.toLowerCase())) {
    fail("BACKUP_OBJECT_VERSION", "Backup manifest must contain a real object version ID");
  }
  exact(storage.versioningState, "Enabled", "BACKUP_VERSIONING", "Backup bucket versioning was not observed as enabled");
  const observedAt = timestamp(storage.observedAt, "storage.observedAt");
  if (observedAt < completedAt) fail("BACKUP_STORAGE_OBSERVATION", "Object protection was observed before backup completion");
  notFuture(observedAt, now, "BACKUP_STORAGE_FUTURE", "Object observation time is in the future");
  const observationSource = record(storage.observationSource, "storage.observationSource");
  exact(observationSource.mode, "provider-api-live", "BACKUP_STORAGE_SOURCE", "Object protection must come from a live provider API observation");
  const provider = safeText(observationSource.provider, "storage.observationSource.provider", 1, 80);
  const requestId = safeText(observationSource.requestId, "storage.observationSource.requestId", 8, 256);
  const lifecycleRuleId = safeText(storage.lifecycleRuleId, "storage.lifecycleRuleId", 1, 256);
  const encryption = validateEncryption(storage.encryption, "storage.encryption");
  let ciphertext = {};
  if (encryption.mode === "CLIENT_ENVELOPE") {
    exact(encryption.algorithm, "age-x25519", "BACKUP_ENCRYPTION_ALGORITHM", "Unsupported client encryption");
    if (!/^key:age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/u.test(encryption.keyReference) || !objectKey.endsWith(".dump.age")) {
      fail("BACKUP_ENCRYPTION_BINDING", "Encrypted backup must bind its public recipient and object format");
    }
    const ciphertextSha256 = sha256(artifact.ciphertextSha256, "artifact.ciphertextSha256");
    if (ciphertextSha256 === plaintextSha256) fail("BACKUP_ENCRYPTION_BINDING", "Ciphertext must differ from plaintext");
    ciphertext = { ciphertextSha256, ciphertextSizeBytes: integer(artifact.ciphertextSizeBytes, 1, 10 * 1_024 ** 4, "artifact.ciphertextSizeBytes") };
  } else if (artifact.ciphertextSha256 !== undefined || artifact.ciphertextSizeBytes !== undefined) {
    fail("BACKUP_ENCRYPTION_BINDING", "Server-encrypted backup cannot claim client ciphertext");
  }

  const normalized = {
    schemaVersion: 1,
    backupId,
    workload: { kind, tenantId, databaseName, region },
    createdAt: createdAt.toISOString(),
    completedAt: completedAt.toISOString(),
    artifact: { format: "postgres-custom", plaintextSha256, sizeBytes, pgDumpMajor, ...ciphertext },
    storage: {
      bucket,
      objectKey,
      objectVersionId,
      versioningState: "Enabled",
      observedAt: observedAt.toISOString(),
      observationSource: { mode: "provider-api-live", provider, requestId },
      lifecycleRuleId,
      encryption,
    },
  };
  return { ...normalized, manifestSha256: canonicalSha256(normalized) };
}

export function validatePitrEvidence(value, now = new Date()) {
  rejectSecretMaterial(value);
  const root = record(value, "PITR evidence");
  exact(root.schemaVersion, 1, "PITR_SCHEMA", "Unsupported PITR evidence schema");
  exact(root.kind, "control-plane-postgresql-pitr", "PITR_KIND", "PITR evidence is for the wrong workload");
  const environment = safeText(root.environment, "environment", 1, 80);
  if (["development", "test", "fixture", "local"].includes(environment.toLowerCase())) {
    fail("PITR_ENVIRONMENT", "Local or fixture PITR evidence cannot satisfy a release gate");
  }
  const capturedAt = timestamp(root.capturedAt, "capturedAt");
  notFuture(capturedAt, now, "PITR_FUTURE", "PITR evidence is in the future");
  if (hoursBetween(capturedAt, now) > 24) fail("PITR_STALE", "PITR evidence is older than 24 hours");
  const source = validateLiveSource(root.source, "source");
  const clusterId = safeText(root.clusterId, "clusterId", 1, 256);
  const pitr = record(root.pitr, "pitr");
  exact(pitr.state, "ENABLED", "PITR_DISABLED", "Continuous point-in-time recovery is not enabled");
  exact(pitr.continuousWalProtection, true, "PITR_WAL", "Continuous WAL protection is not verified");
  exact(pitr.encryptionAtRest, true, "PITR_ENCRYPTION", "Control-plane backup encryption at rest is not verified");
  const keyReference = safeReference(pitr.keyReference, "pitr.keyReference");
  const earliestRestorableAt = timestamp(pitr.earliestRestorableAt, "pitr.earliestRestorableAt");
  const latestRestorableAt = timestamp(pitr.latestRestorableAt, "pitr.latestRestorableAt");
  if (latestRestorableAt < earliestRestorableAt || latestRestorableAt > capturedAt) {
    fail("PITR_WINDOW", "PITR restorable window is invalid");
  }
  if (minutesBetween(latestRestorableAt, capturedAt) > DR_OBJECTIVES.controlPlaneRpoMinutes) {
    fail("PITR_RPO", "PITR latest restore point misses the control-plane RPO");
  }
  if (hoursBetween(earliestRestorableAt, latestRestorableAt) < DR_OBJECTIVES.minimumPitrWindowDays * 24) {
    fail("PITR_RETENTION", "PITR restore window is shorter than seven days");
  }
  return {
    schemaVersion: 1,
    kind: "control-plane-postgresql-pitr",
    environment,
    capturedAt: capturedAt.toISOString(),
    source,
    clusterId,
    pitr: {
      state: "ENABLED",
      continuousWalProtection: true,
      encryptionAtRest: true,
      keyReference,
      earliestRestorableAt: earliestRestorableAt.toISOString(),
      latestRestorableAt: latestRestorableAt.toISOString(),
    },
  };
}

export function validateObjectProtectionEvidence(value, now = new Date()) {
  rejectSecretMaterial(value);
  const root = record(value, "object-store evidence");
  exact(root.schemaVersion, 1, "OBJECT_SCHEMA", "Unsupported object-store evidence schema");
  exact(root.kind, "object-storage-protection", "OBJECT_KIND", "Object-store evidence has the wrong kind");
  const environment = safeText(root.environment, "environment", 1, 80);
  if (["development", "test", "fixture", "local"].includes(environment.toLowerCase())) {
    fail("OBJECT_ENVIRONMENT", "Local or fixture object-store evidence cannot satisfy a release gate");
  }
  const capturedAt = timestamp(root.capturedAt, "capturedAt");
  notFuture(capturedAt, now, "OBJECT_FUTURE", "Object-store evidence is in the future");
  if (hoursBetween(capturedAt, now) > 24) fail("OBJECT_STALE", "Object-store evidence is older than 24 hours");
  const source = validateLiveSource(root.source, "source");
  if (!Array.isArray(root.buckets) || root.buckets.length === 0 || root.buckets.length > 100) {
    fail("OBJECT_BUCKETS", "Object-store evidence must cover at least one bucket");
  }
  const buckets = root.buckets.map((entry, index) => {
    const bucket = record(entry, `buckets[${index}]`);
    const name = bucketName(bucket.name, `buckets[${index}].name`);
    exact(bucket.versioningState, "Enabled", "OBJECT_VERSIONING", `Versioning is not enabled for ${name}`);
    const encryption = validateEncryption(bucket.encryption, `buckets[${index}].encryption`);
    const lifecycle = record(bucket.lifecycle, `buckets[${index}].lifecycle`);
    const ruleId = safeText(lifecycle.ruleId, `buckets[${index}].lifecycle.ruleId`, 1, 256);
    const noncurrentVersionRetentionDays = integer(
      lifecycle.noncurrentVersionRetentionDays,
      1,
      3_650,
      `buckets[${index}].lifecycle.noncurrentVersionRetentionDays`,
    );
    const abortIncompleteMultipartUploadDays = integer(
      lifecycle.abortIncompleteMultipartUploadDays,
      1,
      30,
      `buckets[${index}].lifecycle.abortIncompleteMultipartUploadDays`,
    );
    exact(bucket.tenantPrefixIsolation, true, "OBJECT_TENANT_PREFIX", `Tenant-prefix isolation is not verified for ${name}`);
    return {
      name,
      versioningState: "Enabled",
      encryption,
      lifecycle: { ruleId, noncurrentVersionRetentionDays, abortIncompleteMultipartUploadDays },
      tenantPrefixIsolation: true,
    };
  });
  if (new Set(buckets.map((entry) => entry.name)).size !== buckets.length) {
    fail("OBJECT_DUPLICATE_BUCKET", "Object-store evidence contains a duplicate bucket");
  }
  return { schemaVersion: 1, kind: "object-storage-protection", environment, capturedAt: capturedAt.toISOString(), source, buckets };
}

export function validateRestoreEvidence(value, now = new Date()) {
  rejectSecretMaterial(value);
  const root = record(value, "restore evidence");
  exact(root.schemaVersion, 1, "RESTORE_SCHEMA", "Unsupported restore evidence schema");
  exact(root.kind, "postgres-disposable-restore", "RESTORE_KIND", "Restore evidence has the wrong kind");
  const rehearsalId = uuid(root.rehearsalId, "rehearsalId");
  const backupId = uuid(root.backupId, "backupId");
  const workload = record(root.workload, "workload");
  const workloadKind = oneOf(workload.kind, ["control-plane", "tenant-zammad"], "workload.kind");
  const tenantId = workloadKind === "tenant-zammad"
    ? tenantUuid(workload.tenantId, "workload.tenantId")
    : nullValue(workload.tenantId, "workload.tenantId");
  const startedAt = timestamp(root.startedAt, "startedAt");
  const completedAt = timestamp(root.completedAt, "completedAt");
  if (completedAt < startedAt) fail("RESTORE_TIME_RANGE", "Restore rehearsal time range is invalid");
  notFuture(completedAt, now, "RESTORE_FUTURE", "Restore rehearsal completion is in the future");
  const artifact = record(root.artifact, "artifact");
  const plaintextSha256 = sha256(artifact.plaintextSha256, "artifact.plaintextSha256");
  const manifestSha256 = sha256(artifact.manifestSha256, "artifact.manifestSha256");
  const sizeBytes = integer(artifact.sizeBytes, 1, 10 * 1_024 ** 4, "artifact.sizeBytes");
  const target = record(root.target, "target");
  exact(target.kind, "disposable-docker", "RESTORE_TARGET", "Restore target was not disposable Docker");
  const image = safeText(target.image, "target.image", 1, 512);
  if (!/@sha256:[0-9a-f]{64}$/u.test(image)) fail("RESTORE_IMAGE", "Restore target image is not digest pinned");
  exact(target.networkMode, "none", "RESTORE_NETWORK", "Restore target had external networking");
  exact(target.publishedPorts, 0, "RESTORE_PORTS", "Restore target published a host port");
  exact(target.readOnlyArtifactMount, true, "RESTORE_ARTIFACT_MOUNT", "Backup artifact was not mounted read-only");
  exact(target.destroyed, true, "RESTORE_CLEANUP", "Disposable restore target was not destroyed");
  const validation = record(root.validation, "validation");
  exact(validation.result, "PASSED", "RESTORE_RESULT", "Restore rehearsal did not pass");
  const requiredTables = arrayOfSafeText(validation.requiredTables, "validation.requiredTables", 1, 100);
  const migrationCount = integer(validation.migrationCount, 1, 100_000, "validation.migrationCount");
  const databaseRestoreSeconds = integer(validation.databaseRestoreSeconds, 0, 86_400, "validation.databaseRestoreSeconds");
  return {
    schemaVersion: 1,
    kind: "postgres-disposable-restore",
    rehearsalId,
    backupId,
    workload: { kind: workloadKind, tenantId },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    artifact: { plaintextSha256, manifestSha256, sizeBytes },
    target: { kind: "disposable-docker", image, networkMode: "none", publishedPorts: 0, readOnlyArtifactMount: true, destroyed: true },
    validation: { result: "PASSED", requiredTables, migrationCount, databaseRestoreSeconds },
  };
}

export function evaluateDrReadiness({
  pitrEvidence,
  objectProtectionEvidence,
  backupManifests,
  restoreEvidence,
  activeTenantIds,
  stage = "pilot",
  now = new Date(),
}) {
  const issues = [];
  const capture = (code, operation) => {
    try { return operation(); }
    catch (error) {
      issues.push({ code: error instanceof DrContractError ? error.code : code, message: safeError(error) });
      return null;
    }
  };
  const pitr = capture("PITR_INVALID", () => validatePitrEvidence(pitrEvidence, now));
  const objects = capture("OBJECT_PROTECTION_INVALID", () => validateObjectProtectionEvidence(objectProtectionEvidence, now));
  const manifests = backupManifests
    .map((value, index) => capture(`BACKUP_MANIFEST_${index}_INVALID`, () => validateBackupManifest(value, now)))
    .filter(Boolean);
  const rehearsals = restoreEvidence
    .map((value, index) => capture(`RESTORE_EVIDENCE_${index}_INVALID`, () => validateRestoreEvidence(value, now)))
    .filter(Boolean);
  const tenants = Array.isArray(activeTenantIds) ? activeTenantIds : [];
  const normalizedTenants = [];
  for (const [index, value] of tenants.entries()) {
    const normalized = capture(`ACTIVE_TENANT_${index}_INVALID`, () => tenantUuid(value, `activeTenantIds[${index}]`));
    if (normalized) normalizedTenants.push(normalized);
  }
  if (new Set(normalizedTenants).size !== normalizedTenants.length) {
    issues.push({ code: "ACTIVE_TENANT_DUPLICATE", message: "Active tenant list contains duplicates" });
  }

  const newestControl = newest(manifests.filter((entry) => entry.workload.kind === "control-plane"));
  requireFreshBackup(newestControl, "control-plane", now, issues);
  for (const tenantId of normalizedTenants) {
    const manifest = newest(manifests.filter((entry) => entry.workload.tenantId === tenantId));
    requireFreshBackup(manifest, `tenant:${tenantId}`, now, issues);
  }

  if (objects) {
    const protectedBuckets = new Map(objects.buckets.map((entry) => [entry.name, entry]));
    for (const manifest of manifests) {
      const bucket = protectedBuckets.get(manifest.storage.bucket);
      if (!bucket) {
        issues.push({ code: "BACKUP_BUCKET_UNVERIFIED", message: `Backup bucket ${manifest.storage.bucket} is absent from live object-store evidence` });
      } else if (bucket.lifecycle.ruleId !== manifest.storage.lifecycleRuleId) {
        issues.push({ code: "BACKUP_LIFECYCLE_MISMATCH", message: `Backup lifecycle evidence does not match ${manifest.storage.bucket}` });
      }
    }
  }

  const maxAgeDays = stage === "commercial"
    ? DR_OBJECTIVES.commercialRestoreRehearsalMaxAgeDays
    : DR_OBJECTIVES.pilotRestoreRehearsalMaxAgeDays;
  requireRecentRestore("control-plane", null, manifests, rehearsals, maxAgeDays, now, issues);
  for (const tenantId of normalizedTenants) {
    requireRecentRestore("tenant-zammad", tenantId, manifests, rehearsals, maxAgeDays, now, issues);
  }

  return {
    schemaVersion: 1,
    evaluatedAt: now.toISOString(),
    stage,
    status: issues.length === 0 ? "READY" : "BLOCKED",
    objectives: DR_OBJECTIVES,
    coverage: {
      activeTenants: normalizedTenants.length,
      validBackupManifests: manifests.length,
      validRestoreRehearsals: rehearsals.length,
      pitrEvidence: Boolean(pitr),
      objectProtectionEvidence: Boolean(objects),
    },
    issues,
  };
}

function requireFreshBackup(manifest, workload, now, issues) {
  if (!manifest) {
    issues.push({ code: "BACKUP_MISSING", message: `No valid backup manifest covers ${workload}` });
    return;
  }
  if (hoursBetween(new Date(manifest.completedAt), now) > DR_OBJECTIVES.backupFreshnessHours) {
    issues.push({ code: "BACKUP_STALE", message: `Latest valid backup for ${workload} is older than 26 hours` });
  }
}

function requireRecentRestore(kind, tenantId, manifests, rehearsals, maxAgeDays, now, issues) {
  const matching = rehearsals
    .filter((entry) => entry.workload.kind === kind && entry.workload.tenantId === tenantId)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const rehearsal = matching[0];
  const label = tenantId ? `tenant:${tenantId}` : "control-plane";
  if (!rehearsal) {
    issues.push({ code: "RESTORE_REHEARSAL_MISSING", message: `No disposable restore rehearsal covers ${label}` });
    return;
  }
  if (hoursBetween(new Date(rehearsal.completedAt), now) > maxAgeDays * 24) {
    issues.push({ code: "RESTORE_REHEARSAL_STALE", message: `Restore rehearsal for ${label} exceeds the ${maxAgeDays}-day gate` });
  }
  const manifest = manifests.find((entry) => entry.backupId === rehearsal.backupId);
  if (
    !manifest ||
    manifest.artifact.plaintextSha256 !== rehearsal.artifact.plaintextSha256 ||
    manifest.manifestSha256 !== rehearsal.artifact.manifestSha256
  ) {
    issues.push({ code: "RESTORE_ARTIFACT_UNBOUND", message: `Restore rehearsal for ${label} is not bound to an included backup manifest` });
  }
}

function newest(values) {
  return [...values].sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0] ?? null;
}

function validateEncryption(value, name) {
  const encryption = record(value, name);
  const mode = oneOf(encryption.mode, ["SSE_KMS", "CLIENT_ENVELOPE"], `${name}.mode`);
  const algorithm = safeText(encryption.algorithm, `${name}.algorithm`, 1, 80);
  const keyReference = safeReference(encryption.keyReference, `${name}.keyReference`);
  return { mode, algorithm, keyReference };
}

function validateLiveSource(value, name) {
  const source = record(value, name);
  exact(source.mode, "provider-api-live", "EVIDENCE_SOURCE", `${name} must be a live provider API observation`);
  return {
    mode: "provider-api-live",
    provider: safeText(source.provider, `${name}.provider`, 1, 80),
    requestId: safeText(source.requestId, `${name}.requestId`, 8, 256),
  };
}

function rejectSecretMaterial(value, path = "evidence", seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("EVIDENCE_CYCLE", `${path} contains a cycle`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/(?:password|passphrase|access.?key|secret(?!.*reference)|credential|bearer|private.?key|token)/iu.test(key)) {
      fail("EVIDENCE_SECRET", `${path} contains prohibited secret-like material`);
    }
    rejectSecretMaterial(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CONTRACT_OBJECT", `${name} must be an object`);
  return value;
}

function safeText(value, name, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || hasControl(value)) {
    fail("CONTRACT_TEXT", `${name} is invalid`);
  }
  return value;
}

function hasControl(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeReference(value, name) {
  const reference = safeText(value, name, 8, 512);
  if (!/^(?:arn:|kms:|key:|https:\/\/|projects\/|subscriptions\/|secret:\/\/)/u.test(reference)) {
    fail("CONTRACT_REFERENCE", `${name} must be a non-secret provider key reference`);
  }
  if (reference.startsWith("https://")) {
    let url;
    try { url = new URL(reference); }
    catch { fail("CONTRACT_REFERENCE", `${name} must be a non-secret provider key reference`); }
    if (url.username || url.password || url.search || url.hash) {
      fail("CONTRACT_REFERENCE", `${name} must not contain credentials, query parameters, or fragments`);
    }
  }
  return reference;
}

function timestamp(value, name) {
  const text = safeText(value, name, 20, 40);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) fail("CONTRACT_TIMESTAMP", `${name} is invalid`);
  return date;
}

function notFuture(value, now, code, message) {
  if (value.getTime() > now.getTime() + 5 * 60 * 1_000) fail(code, message);
}

function uuid(value, name) {
  const text = safeText(value, name, 36, 36);
  if (!UUID.test(text)) fail("CONTRACT_UUID", `${name} is invalid`);
  return text.toLowerCase();
}

function tenantUuid(value, name) {
  const text = safeText(value, name, 36, 36);
  if (!TENANT_UUID.test(text)) fail("CONTRACT_TENANT", `${name} must be a version-4 tenant UUID`);
  return text.toLowerCase();
}

function sha256(value, name) {
  const text = safeText(value, name, 64, 64).toLowerCase();
  if (!SHA256.test(text)) fail("CONTRACT_SHA256", `${name} is invalid`);
  return text;
}

function databaseNameValue(value, name) {
  const text = safeText(value, name, 1, 63);
  if (!DATABASE_NAME.test(text)) fail("CONTRACT_DATABASE", `${name} is invalid`);
  return text;
}

function bucketName(value, name) {
  const text = safeText(value, name, 3, 63);
  if (!BUCKET_NAME.test(text) || /\.\./u.test(text)) fail("CONTRACT_BUCKET", `${name} is invalid`);
  return text;
}

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("CONTRACT_INTEGER", `${name} is invalid`);
  return value;
}

function oneOf(value, values, name) {
  if (!values.includes(value)) fail("CONTRACT_ENUM", `${name} is invalid`);
  return value;
}

function nullValue(value, name) {
  if (value !== null) fail("CONTRACT_NULL", `${name} must be null`);
  return null;
}

function exact(value, expected, code, message) {
  if (value !== expected) fail(code, message);
}

function arrayOfSafeText(value, name, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("CONTRACT_ARRAY", `${name} is invalid`);
  const entries = value.map((entry, index) => safeText(entry, `${name}[${index}]`, 1, 128));
  if (new Set(entries).size !== entries.length) fail("CONTRACT_ARRAY_DUPLICATE", `${name} contains duplicates`);
  return entries;
}

function minutesBetween(left, right) {
  return Math.max(0, right.getTime() - left.getTime()) / 60_000;
}

function hoursBetween(left, right) {
  return Math.max(0, right.getTime() - left.getTime()) / 3_600_000;
}

function safeError(error) {
  return error instanceof Error
    ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, "$1[redacted]").slice(0, 500)
    : "Disaster-recovery evidence is invalid";
}

function fail(code, message) {
  throw new DrContractError(code, message);
}
