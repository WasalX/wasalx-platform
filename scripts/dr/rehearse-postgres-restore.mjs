#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateBackupManifest, validateRestoreEvidence } from "./contracts.mjs";

const POSTGRES_IMAGE = "postgres:18.6-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd";
const RESTORE_DATABASE = "wasalx_dr_rehearsal";
const options = argumentsFrom(process.argv.slice(2));
const manifestPath = await safeRegularFile(options.manifest);
const artifactPath = await safeRegularFile(options.artifact);
if (artifactPath.includes(",")) throw new Error("Backup artifact path must not contain a comma");
const outputPath = resolve(options.output);
await ensureNewOutput(outputPath);

const manifestDetails = await stat(manifestPath);
if (manifestDetails.size > 1_048_576) throw new Error("Backup manifest exceeds the one-megabyte evidence limit");
const manifestBytes = await readFile(manifestPath);
const manifest = validateBackupManifest(JSON.parse(manifestBytes.toString("utf8")));
const artifactDetails = await stat(artifactPath);
if (artifactDetails.size !== manifest.artifact.sizeBytes) {
  throw new Error("Backup artifact size does not match its manifest");
}
const plaintextSha256 = await fileSha256(artifactPath);
if (plaintextSha256 !== manifest.artifact.plaintextSha256) {
  throw new Error("Backup artifact checksum does not match its manifest");
}

requireDocker();
const rehearsalId = randomUUID();
const containerName = `wasalx-dr-${rehearsalId.replaceAll("-", "")}`;
const password = randomBytes(32).toString("base64url");
const started = new Date();
let created = false;
let validation;
let operationError = null;
let cleanupError = null;

try {
  docker([
    "run", "--detach", "--pull=never", "--name", containerName,
    "--network", "none",
    "--label", "wasalx.io/purpose=dr-rehearsal",
    "--label", `wasalx.io/rehearsal-id=${rehearsalId}`,
    "--env", "POSTGRES_PASSWORD",
    "--env", `POSTGRES_DB=${RESTORE_DATABASE}`,
    "--mount", `type=bind,source=${artifactPath},target=/backup/input.dump,readonly`,
    POSTGRES_IMAGE,
  ], { timeout: 180_000, environment: { ...process.env, POSTGRES_PASSWORD: password } });
  created = true;
  await waitForPostgres(containerName);
  const restoreStarted = Date.now();
  docker([
    "exec", containerName,
    "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
    "--username", "postgres", "--dbname", RESTORE_DATABASE, "/backup/input.dump",
  ], { timeout: options.timeoutSeconds * 1_000 });
  validation = validateRestoredDatabase(containerName, manifest.workload.kind);
  validation.databaseRestoreSeconds = Math.ceil((Date.now() - restoreStarted) / 1_000);
} catch (error) {
  operationError = error;
} finally {
  if (created) {
    const cleanup = spawnSync("docker", ["rm", "--force", "--volumes", containerName], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (cleanup.status !== 0) {
      cleanupError = new Error("Disposable restore target cleanup failed; operator action is required");
    }
  }
}
if (cleanupError) throw cleanupError;
if (operationError) throw operationError;

const completed = new Date();
const evidence = validateRestoreEvidence({
  schemaVersion: 1,
  kind: "postgres-disposable-restore",
  rehearsalId,
  backupId: manifest.backupId,
  workload: { kind: manifest.workload.kind, tenantId: manifest.workload.tenantId },
  startedAt: started.toISOString(),
  completedAt: completed.toISOString(),
  artifact: {
    plaintextSha256,
    manifestSha256: manifest.manifestSha256,
    sizeBytes: artifactDetails.size,
  },
  target: {
    kind: "disposable-docker",
    image: POSTGRES_IMAGE,
    networkMode: "none",
    publishedPorts: 0,
    readOnlyArtifactMount: true,
    destroyed: true,
  },
  validation: { ...validation, result: "PASSED" },
});
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(serialized);

function validateRestoredDatabase(containerName, kind) {
  const requiredTables = kind === "control-plane"
    ? ["tenants", "connections", "event_inbox", "delivery_outbox", "audit_events", "wasalx_schema_migrations"]
    : ["users", "tickets", "ticket_articles", "schema_migrations"];
  for (const table of requiredTables) {
    const value = psql(containerName, `SELECT to_regclass('public.${table}') IS NOT NULL`);
    if (value !== "t") throw new Error(`Restored database is missing required ${kind} schema evidence`);
  }
  const migrationTable = kind === "control-plane" ? "wasalx_schema_migrations" : "schema_migrations";
  const migrationCount = Number(psql(containerName, `SELECT count(*) FROM public.${migrationTable}`));
  if (!Number.isSafeInteger(migrationCount) || migrationCount < 1) {
    throw new Error("Restored database has no migration evidence");
  }
  if (kind === "control-plane") {
    const forcedRls = Number(psql(
      containerName,
      "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity",
    ));
    if (!Number.isSafeInteger(forcedRls) || forcedRls < 1) {
      throw new Error("Restored control-plane database has no forced-RLS evidence");
    }
  }
  return { requiredTables, migrationCount, databaseRestoreSeconds: 0 };
}

function psql(containerName, query) {
  return docker([
    "exec", containerName,
    "psql", "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
    "--username", "postgres", "--dbname", RESTORE_DATABASE, "--command", query,
  ], { timeout: 30_000 }).trim();
}

async function waitForPostgres(containerName) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      // The image's temporary init server is socket-only.
      ["exec", containerName, "pg_isready", "--host", "127.0.0.1", "--username", "postgres", "--dbname", RESTORE_DATABASE],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Disposable PostgreSQL target did not become ready");
}

function requireDocker() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error("Docker is required for the isolated restore rehearsal");
}

function docker(arguments_, { timeout, environment } = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    timeout,
    env: environment ?? process.env,
    maxBuffer: 2 * 1_024 * 1_024,
  });
  if (result.status !== 0) {
    const detail = sanitize(`${result.stderr || result.stdout || "Docker command failed"}`);
    throw new Error(detail);
  }
  return result.stdout;
}

async function safeRegularFile(path) {
  const requested = resolve(path);
  const linkDetails = await lstat(requested);
  if (linkDetails.isSymbolicLink()) throw new Error(`${basename(path)} must not be a symbolic link`);
  const absolute = await realpath(requested);
  const details = await stat(absolute);
  if (!details.isFile()) throw new Error(`${basename(path)} must be a regular file`);
  return absolute;
}

async function ensureNewOutput(path) {
  try {
    await lstat(path);
    throw new Error("Restore evidence output already exists; use a new evidence path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function argumentsFrom(values) {
  const parsed = {};
  const allowed = new Set(["manifest", "artifact", "output", "timeoutSeconds"]);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) usage();
    const key = name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (!allowed.has(key) || key in parsed) usage();
    parsed[key] = value;
  }
  for (const required of ["manifest", "artifact", "output"]) if (!parsed[required]) usage();
  parsed.timeoutSeconds ??= 3_600;
  parsed.timeoutSeconds = Number(parsed.timeoutSeconds);
  if (!Number.isInteger(parsed.timeoutSeconds) || parsed.timeoutSeconds < 60 || parsed.timeoutSeconds > 14_400) usage();
  return parsed;
}

function sanitize(value) {
  return value
    .replaceAll(password, "[redacted]")
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, "$1[redacted]")
    .slice(0, 2_000)
    .trim();
}

function usage() {
  process.stderr.write(
    "Usage: rehearse-postgres-restore.mjs --manifest FILE --artifact FILE --output NEW_FILE " +
    "[--timeout-seconds 3600]\n",
  );
  process.exit(64);
}
