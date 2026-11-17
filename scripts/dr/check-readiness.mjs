#!/usr/bin/env node
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateDrReadiness } from "./contracts.mjs";

const options = argumentsFrom(process.argv.slice(2));
const pitrEvidence = await readJson(options.pitrEvidence);
const objectProtectionEvidence = await readJson(options.objectProtectionEvidence);
const activeTenantDocument = await readJson(options.activeTenants);
if (!activeTenantDocument || !Array.isArray(activeTenantDocument.tenantIds)) {
  throw new Error("--active-tenants must contain a tenantIds array");
}
const backupManifests = await readJsonDirectory(options.backupManifests);
const restoreEvidence = await readJsonDirectory(options.restoreEvidence);
const report = evaluateDrReadiness({
  pitrEvidence,
  objectProtectionEvidence,
  activeTenantIds: activeTenantDocument.tenantIds,
  backupManifests,
  restoreEvidence,
  stage: options.stage,
  now: new Date(),
});
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const output = resolve(options.output);
  await writeFile(output, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
process.stdout.write(serialized);
if (report.status !== "READY") process.exitCode = 2;

function argumentsFrom(values) {
  const parsed = {};
  const allowed = new Set([
    "pitrEvidence", "objectProtectionEvidence", "activeTenants",
    "backupManifests", "restoreEvidence", "stage", "output",
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) usage();
    const key = name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (!allowed.has(key) || key in parsed) usage();
    parsed[key] = value;
  }
  for (const required of ["pitrEvidence", "objectProtectionEvidence", "activeTenants", "backupManifests", "restoreEvidence"]) {
    if (!parsed[required]) usage();
  }
  parsed.stage ??= "pilot";
  if (!["pilot", "commercial"].includes(parsed.stage)) usage();
  return parsed;
}

async function readJson(path) {
  const absolute = await safeRegularFile(path);
  return JSON.parse(await readFile(absolute, "utf8"));
}

async function readJsonDirectory(path) {
  const absolute = await realpath(resolve(path));
  const details = await stat(absolute);
  if (!details.isDirectory()) throw new Error(`${path} must be a directory`);
  const names = (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort();
  if (names.length > 2_000) throw new Error(`${path} exceeds the 2000-file evidence limit`);
  return Promise.all(names.map((name) => readJson(resolve(absolute, name))));
}

async function safeRegularFile(path) {
  const absolute = await realpath(resolve(path));
  const details = await stat(absolute);
  if (!details.isFile()) throw new Error(`${path} must be a regular file`);
  if (details.size > 1_048_576) throw new Error(`${path} exceeds the one-megabyte evidence limit`);
  return absolute;
}

function usage() {
  process.stderr.write(
    "Usage: check-readiness.mjs --pitr-evidence FILE --object-protection-evidence FILE " +
    "--active-tenants FILE --backup-manifests DIR --restore-evidence DIR " +
    "[--stage pilot|commercial] [--output NEW_FILE]\n",
  );
  process.exit(64);
}
