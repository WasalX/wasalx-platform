#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateBackupManifest, validateRestoreEvidence } from "./contracts.mjs";
import { purposeLabel, recoverRestoreDrill, rehearsalLabel, runRestoreDrill } from "./restore-drill.mjs";

const POSTGRES_IMAGE = "postgres:18.6-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd";
const RESTORE_DATABASE = "wasalx_dr_rehearsal";
export async function rehearsePostgresRestore(options, drill) {
  const manifestPath = await safeRegularFile(options.manifest);
  const artifactPath = await safeRegularFile(options.artifact);
  if (artifactPath.includes(",")) throw new Error("Backup artifact path must not contain a comma");

  const manifestDetails = await stat(manifestPath);
  if (manifestDetails.size > 1_048_576) throw new Error("Backup manifest exceeds the one-megabyte evidence limit");
  const manifest = validateBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const artifactDetails = await stat(artifactPath);
  if (artifactDetails.size !== manifest.artifact.sizeBytes) {
    throw new Error("Backup artifact size does not match its manifest");
  }
  const plaintextSha256 = await fileSha256(artifactPath);
  if (plaintextSha256 !== manifest.artifact.plaintextSha256) {
    throw new Error("Backup artifact checksum does not match its manifest");
  }

  const { rehearsalId } = drill;
  const available = drill.docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
  if (available.status !== 0) throw new Error("Docker is required for the isolated restore rehearsal");
  const password = randomBytes(32).toString("base64url");
  const started = new Date();
  const containerId = await drill.startContainer([
    "run", "--detach", "--pull=never", "--name", drill.name,
    "--network", "none",
    "--label", purposeLabel,
    "--label", `${rehearsalLabel}=${rehearsalId}`,
    "--env", "POSTGRES_PASSWORD",
    "--env", `POSTGRES_DB=${RESTORE_DATABASE}`,
    "--mount", `type=bind,source=${artifactPath},target=/backup/input.dump,readonly`,
    POSTGRES_IMAGE,
  ], { ...process.env, POSTGRES_PASSWORD: password });
  await waitForPostgres(drill.docker, containerId);
  const docker = (args, timeout) => {
    const result = drill.docker(args, { timeout });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "Docker command failed")
        .replaceAll(password, "[redacted]")
        .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted]")
        .slice(0, 2_000).trim();
      throw new Error(detail);
    }
    return result.stdout;
  };
  const restoreStarted = Date.now();
  docker([
    "exec", containerId,
    "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges",
    "--username", "postgres", "--dbname", RESTORE_DATABASE, "/backup/input.dump",
  ], options.timeoutSeconds * 1_000);
  const validation = validateRestoredDatabase(docker, containerId, manifest.workload.kind);
  validation.databaseRestoreSeconds = Math.ceil((Date.now() - restoreStarted) / 1_000);
  return {
    schemaVersion: 1,
    kind: "postgres-disposable-restore",
    rehearsalId,
    backupId: manifest.backupId,
    workload: { kind: manifest.workload.kind, tenantId: manifest.workload.tenantId },
    startedAt: started.toISOString(),
    artifact: { plaintextSha256, manifestSha256: manifest.manifestSha256, sizeBytes: artifactDetails.size },
    target: {
      kind: "disposable-docker", image: POSTGRES_IMAGE, networkMode: "none", publishedPorts: 0,
      readOnlyArtifactMount: true,
    },
    validation: { ...validation, result: "PASSED" },
  };
}

export async function writeRestoreReceipt(output, receipt) {
  const evidence = validateRestoreEvidence({
    ...receipt, completedAt: new Date().toISOString(), target: { ...receipt.target, destroyed: true },
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(output, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return serialized;
}

export async function runPostgresRestore(args, drillOptions) {
  if (args.length === 2 && args[0] === "--cleanup-interrupted") {
    await recoverRestoreDrill(args[1], drillOptions);
    return "";
  }
  const options = argumentsFrom(args);
  const output = resolve(options.output);
  return runRestoreDrill(async drill => {
    await ensureNewOutput(output);
    return rehearsePostgresRestore(options, drill);
  }, receipt => writeRestoreReceipt(output, receipt), drillOptions);
}

function validateRestoredDatabase(docker, containerId, kind) {
  const requiredTables = kind === "control-plane"
    ? ["tenants", "connections", "event_inbox", "delivery_outbox", "audit_events", "wasalx_schema_migrations"]
    : ["users", "tickets", "ticket_articles", "schema_migrations"];
  for (const table of requiredTables) {
    const value = psql(docker, containerId, `SELECT to_regclass('public.${table}') IS NOT NULL`);
    if (value !== "t") throw new Error(`Restored database is missing required ${kind} schema evidence`);
  }
  const migrationTable = kind === "control-plane" ? "wasalx_schema_migrations" : "schema_migrations";
  const migrationCount = Number(psql(docker, containerId, `SELECT count(*) FROM public.${migrationTable}`));
  if (!Number.isSafeInteger(migrationCount) || migrationCount < 1) {
    throw new Error("Restored database has no migration evidence");
  }
  if (kind === "control-plane") {
    const forcedRls = Number(psql(
      docker, containerId,
      "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relforcerowsecurity",
    ));
    if (!Number.isSafeInteger(forcedRls) || forcedRls < 1) {
      throw new Error("Restored control-plane database has no forced-RLS evidence");
    }
  }
  return { requiredTables, migrationCount, databaseRestoreSeconds: 0 };
}

function psql(docker, containerId, query) {
  return docker([
    "exec", containerId,
    "psql", "--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
    "--username", "postgres", "--dbname", RESTORE_DATABASE, "--command", query,
  ], 30_000).trim();
}

async function waitForPostgres(docker, containerId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = docker(
      // The image's temporary init server is socket-only.
      ["exec", containerId, "pg_isready", "--host", "127.0.0.1", "--username", "postgres", "--dbname", RESTORE_DATABASE],
      { timeout: 5_000 },
    );
    if (result.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Disposable PostgreSQL target did not become ready");
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

function usage() {
  process.stderr.write(
    "Usage: rehearse-postgres-restore.mjs --manifest FILE --artifact FILE --output NEW_FILE " +
    "[--timeout-seconds 3600]\n" +
    "       rehearse-postgres-restore.mjs --cleanup-interrupted REHEARSAL_ID\n",
  );
  process.exit(64);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    process.stdout.write(await runPostgresRestore(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`PostgreSQL restore rehearsal failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
