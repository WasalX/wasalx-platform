import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BackupConfig } from "./config.js";
import { S3BackupStore } from "./s3-store.js";
import { ConfiguratorRuntimeError } from "./zammad-client.js";

type CommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

export async function createVerifiedBackup(
  config: BackupConfig,
  dependencies: {
    store?: S3BackupStore;
    run?: CommandRunner;
    now?: () => Date;
    uuid?: () => string;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const store = dependencies.store ?? new S3BackupStore(config.storage, config.backupTimeoutMs);
  const run = dependencies.run ?? runCommand;
  await mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.outputDirectory, 0o700);
  const backupId = uuid().toLowerCase();
  if (!isUuidV4(backupId)) fail("BACKUP_ID_INVALID");
  const createdAt = now();
  const timestamp = createdAt.toISOString().replace(/[:.]/gu, "-");
  const artifactName = `${timestamp}-${backupId}.dump`;
  const artifactPath = path.join(config.outputDirectory, `.${artifactName}.partial`);
  const encryptedPath = path.join(config.outputDirectory, `.${artifactName}.age.partial`);
  const clientEncrypted = config.storage.encryptionMode === "CLIENT_ENVELOPE";
  const objectKey = `${config.storage.prefix}/backups/${artifactName}${clientEncrypted ? ".age" : ""}`;
  try {
    await store.protectionEvidence();
    const major = await pgDumpMajor(run, config.requestTimeoutMs);
    await dumpDatabase(config, artifactPath, run);
    await chmod(artifactPath, 0o600);
    const artifact = await fileEvidence(artifactPath);
    if (artifact.sizeBytes < 1) fail("BACKUP_ARTIFACT_EMPTY");
    let ciphertext: { sha256: string; sizeBytes: number } | undefined;
    if (config.storage.encryptionMode === "CLIENT_ENVELOPE") {
      try {
        await run("age", ["--encrypt", "--recipient", config.storage.ageRecipient,
          "--output", encryptedPath, artifactPath], {
          env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: "/tmp", LANG: "C.UTF-8" }, timeoutMs: config.backupTimeoutMs,
        });
      } catch { fail("BACKUP_ENCRYPTION_FAILED"); }
      await chmod(encryptedPath, 0o600);
      ciphertext = await fileEvidence(encryptedPath);
      const file = await open(encryptedPath, "r");
      try {
        const expectedHeader = Buffer.from("age-encryption.org/v1\n");
        const header = Buffer.alloc(expectedHeader.length);
        await file.read(header, 0, header.length, 0);
        if (!header.equals(expectedHeader)) fail("BACKUP_ENCRYPTION_INVALID");
      } finally { await file.close(); }
      if (ciphertext.sha256 === artifact.sha256) fail("BACKUP_ENCRYPTION_INVALID");
    }
    const storedArtifact = ciphertext ?? artifact;
    const stored = await store.putFileAndVerify(objectKey, clientEncrypted ? encryptedPath : artifactPath,
      storedArtifact.sha256, storedArtifact.sizeBytes);
    const completedAt = now();
    const protection = await store.protectionEvidence();
    const normalized = {
      schemaVersion: 1,
      backupId,
      workload: {
        kind: config.action === "backup" ? "tenant-zammad" : "control-plane",
        tenantId: config.action === "backup" ? config.tenantId : null,
        databaseName: config.database.name,
        region: config.region,
      },
      createdAt: createdAt.toISOString(),
      completedAt: completedAt.toISOString(),
      artifact: {
        format: "postgres-custom",
        plaintextSha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        pgDumpMajor: major,
        ...(ciphertext ? { ciphertextSha256: ciphertext.sha256, ciphertextSizeBytes: ciphertext.sizeBytes } : {}),
      },
      storage: {
        bucket: config.storage.bucket,
        objectKey,
        objectVersionId: stored.objectVersionId,
        versioningState: protection.versioningState,
        observedAt: now().toISOString(),
        observationSource: {
          mode: "provider-api-live",
          provider: config.storage.provider,
          requestId: protection.requestId,
        },
        lifecycleRuleId: protection.lifecycleRuleId,
        encryption: protection.encryption,
      },
    } as const;
    const manifest = { ...normalized, manifestSha256: canonicalSha256(normalized) };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestObjectKey = `${objectKey}.manifest.json`;
    const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
    const manifestStored = await store.putBytesAndVerify(manifestObjectKey, manifestBytes, manifestDigest);
    const localManifest = path.join(config.outputDirectory, `${backupId}.manifest.json`);
    await atomicWrite(localManifest, manifestBytes);
    const receipt = {
      status: "SUCCEEDED",
      action: config.action,
      tenant_id: config.action === "backup" ? config.tenantId : null,
      backup_id: backupId,
      artifact: {
        format: "postgres-custom",
        sha256: artifact.sha256,
        size_bytes: artifact.sizeBytes,
        ...(ciphertext ? { ciphertext_sha256: ciphertext.sha256, ciphertext_size_bytes: ciphertext.sizeBytes } : {}),
        object_key: objectKey,
        object_version_id: stored.objectVersionId,
      },
      manifest: {
        sha256: manifest.manifestSha256,
        object_key: manifestObjectKey,
        object_version_id: manifestStored.objectVersionId,
        local_path: localManifest,
      },
      readback_verified: true,
      completed_at: completedAt.toISOString(),
    };
    await atomicWrite(
      path.join(config.outputDirectory, `${backupId}.receipt.json`),
      new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`),
    );
    return receipt;
  } finally {
    const cleanup = await Promise.allSettled([rm(artifactPath, { force: true }), rm(encryptedPath, { force: true })]);
    if (cleanup.some((result) => result.status === "rejected")) fail("BACKUP_STAGING_CLEANUP_FAILED");
  }
}

export const createVerifiedTenantBackup = createVerifiedBackup;

async function dumpDatabase(config: BackupConfig, destination: string, run: CommandRunner) {
  const sslmode = config.database.url.searchParams.get("sslmode") ?? "require";
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    HOME: "/tmp",
    LANG: "C.UTF-8",
    PGAPPNAME: "wasalx-workspace-configurator",
    PGHOST: config.database.url.hostname,
    PGPORT: config.database.url.port || "5432",
    PGDATABASE: config.database.name,
    PGUSER: decodeURIComponent(config.database.url.username),
    PGPASSWORD: decodeURIComponent(config.database.url.password),
    PGSSLMODE: sslmode,
    ...(config.caCertFile ? { PGSSLROOTCERT: config.caCertFile } : {}),
  };
  await run("pg_dump", [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-privileges",
    `--file=${destination}`,
  ], { env, timeoutMs: config.backupTimeoutMs });
}

async function pgDumpMajor(run: CommandRunner, timeoutMs: number) {
  const result = await run("pg_dump", ["--version"], {
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH,
      HOME: "/tmp",
      LANG: "C.UTF-8",
    },
    timeoutMs,
  });
  const match = result.stdout.match(/pg_dump \(PostgreSQL\) (\d+)(?:\.|\s|$)/u);
  const major = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(major) || major < 14 || major > 18) fail("PG_DUMP_VERSION_UNSUPPORTED");
  return major;
}

async function runCommand(command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= 16_384) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 64 * 1_024) child.kill("SIGKILL");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ConfiguratorRuntimeError("BACKUP_PROCESS_UNAVAILABLE"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new ConfiguratorRuntimeError(signal ? "BACKUP_PROCESS_TIMEOUT" : "BACKUP_PROCESS_FAILED"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

async function fileEvidence(filePath: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.size < 1) fail("BACKUP_ARTIFACT_INVALID");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return { sizeBytes: info.size, sha256: digest.digest("hex") };
}

async function atomicWrite(destination: string, bytes: Uint8Array) {
  const temporary = `${destination}.${process.pid}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUuidV4(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function fail(code: string): never {
  throw new ConfiguratorRuntimeError(code);
}
