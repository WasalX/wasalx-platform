#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink, stat, statfs, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { activeServiceNames, assertDevInstallPreimages, devContainerPreimage, devColdResidents, devHeldServices, devHeldPrerequisites, devPreservedServices, devValueDigest, captureDevReviewAuth, assertDevReviewAuthRows, devReviewAuthEnvironment, devReviewAuthConfiguration, assertInstallHostname } from "./installer-stack.mjs";
import { oneShotServiceNames, rehearsalComposeFile, rehearsalImageSource } from "./installer-stack.mjs";
import { parseRailsJson } from "./simulation-rails-json.mjs";
import { sha256, preserveReplacement, readBoundArtifacts, writeArtifactState,
  assertRetainedPreimage, composeProfiles, dockerfileOf, imageServices, inspectOwned, preparePrivateDirectory, preimagePath, fenceReplacementEffects, rollbackReplacement } from "./installer-artifacts.mjs";
import { produceRollbackSafety, readOptionalState, recordReplacementAfter } from "./installer-rollback-state.mjs";
import { enterComposeStageLock as enterStageLock, composeStageLockConflict } from "./compose-stage-lock.mjs";
import { hostedIssuer, readHostedInventory, verifyHostedImages } from "./installer-hosted-images.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const preflight = fileURLToPath(new URL("./preflight-full-env.mjs", import.meta.url));
const verifier = fileURLToPath(new URL("./installer-stack.mjs", import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/u;
const stages = ["preflight", "build", "verify-hosted", "preload-hosted", "admit-hosted", "replace", "smoke", "qualify", "rollback", "rollback-safety", "release-held"];
const migrationVerifierScript = `const fs=require('node:fs'),crypto=require('node:crypto');
    console.log(JSON.stringify(fs.readdirSync('/app/migrations').filter(n=>/^\\d{4}_[a-z0-9_]+\\.sql$/.test(n)).sort().map(name=>{
      const b=fs.readFileSync('/app/migrations/'+name);
      return {name,blob:crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\\0')).update(b).digest('hex'),
        checksum_sha256:crypto.createHash('sha256').update(b).digest('hex')};})));`;
const migrationVerifierScriptSha = createHash("sha256").update(migrationVerifierScript).digest("hex");


export async function verifyBuildContext(candidateSha, root = repository) {
  const listed = spawnSync("git", ["ls-tree", "-rz", candidateSha], { cwd: root, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  assert.equal(listed.status, 0, "cannot read canonical build tree");
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const [mode, type, expected] = entry.slice(0, separator).split(" ");
    assert.equal(type, "blob", "unsupported build tree entry");
    const path = resolve(root, entry.slice(separator + 1));
    const bytes = mode === "120000" ? Buffer.from(await readlink(path)) : await readFile(path);
    const actual = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    assert.equal(actual, expected, "build input differs from canonical Git bytes; use git -c core.autocrlf=false archive");
  }
  const archive = spawnSync("git", ["archive", "--format=tar", candidateSha],
    { cwd: root, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 ** 2, windowsHide: true });
  assert.equal(archive.status, 0, "cannot archive canonical build context");
  return archive.stdout;
}

export async function assertRepositoryBindMountsReadable(context) {
  const root = resolve(context.repository);
  const within = (path) => { const part = relative(root, path); return !part || (!part.startsWith("..") && !isAbsolute(part)); };
  const execute = context.command ?? run;
  const interpolated = JSON.parse(await execute("docker", [...context.composeArguments, "config", "--format", "json"], context.environment));
  const sources = new Set(Object.values(interpolated.services ?? {}).flatMap((service) =>
    (service.volumes ?? []).filter((mount) => mount.type === "bind" && typeof mount.source === "string")
      .map((mount) => resolve(root, mount.source))).filter(within));
  if (!sources.size) return;
  const listed = spawnSync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "utf8", windowsHide: true });
  assert.equal(listed.status, 0, "cannot read bind-mount Git index modes");
  const modes = new Map(listed.stdout.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\t");
    return [resolve(root, entry.slice(separator + 1)), entry.slice(0, separator)];
  }));
  const required = new Map();
  for (const source of sources) {
    const info = await stat(source);
    const files = info.isDirectory() ? [...modes.keys()].filter((path) => path.startsWith(source + "/") || path.startsWith(source + "\\")) : [source];
    assert.ok(files.length, `repository bind source has no Git index entries: ${source}`);
    for (const path of files) {
      assert.ok(modes.has(path), `repository bind source is absent from Git index: ${path}`);
      assert.match(modes.get(path), /^100(?:644|755) [0-9a-f]+ 0$/u, `unsupported bind-mount Git index mode: ${path}`);
      required.set(path, modes.get(path).startsWith("100755 ") ? 0o005 : 0o004);
      for (let parent = dirname(path); within(parent); parent = dirname(parent)) {
        required.set(parent, 0o001);
        if (parent === root) break;
      }
    }
  }
  const failures = [];
  for (const [path, bits] of required) {
    const mode = (await stat(path)).mode;
    if ((mode & bits) !== bits) failures.push(`${path} (requires ${bits === 1 ? "parent o+x" : bits === 5 ? "Git executable o+rx" : "file o+r"}, actual ${(mode & 0o777).toString(8)})`);
  }
  assert.equal(failures.length, 0, `repository bind-mount readability refusal: ${failures.join("; ")}`);
}

// Inspect immutable image bytes without application credentials or network access.
export async function verifyMigrationInputs(context, imageId) {
  const execute = context.command ?? run;
  const expected = (await execute("git", ["ls-tree", "-r", context.candidateSha,
    "--", "services/control-api/migrations"], context.environment)).split("\n")
    .map((line) => line.match(/^100644 blob ([0-9a-f]{40})\tservices\/control-api\/migrations\/(\d{4}_[a-z0-9_]+\.sql)$/u))
    .filter(Boolean).map((match) => ({ name: match[2], blob: match[1] }));
  assert.ok(expected.length, "canonical migrations missing");
  const verifierName = `${context.project}-migration-input-${context.candidateSha.slice(0, 12)}`;
  const existing = (await execute("docker", ["ps", "-aq", "--filter", `name=^/${verifierName}$`], context.environment)).trim();
  let packagedOutput;
  if (existing) {
    const details = JSON.parse(await execute("docker", ["inspect", verifierName], context.environment))[0];
    assert.equal(details.Image, imageId, "migration verifier image changed");
    assert.equal(details.State?.Status, "exited", "migration verifier is not reusable");
    assert.equal(details.State?.ExitCode, 0, "migration verifier failed");
    assert.equal(details.Config?.Labels?.["io.wasalx.migration-verifier.candidate"], context.candidateSha,
      "migration verifier candidate changed");
    assert.equal(details.Config?.Labels?.["io.wasalx.migration-verifier.script-sha256"], migrationVerifierScriptSha,
      "migration verifier script changed");
    assert.deepEqual(details.Config?.Entrypoint, ["node"], "migration verifier entrypoint changed");
    assert.deepEqual(details.Config?.Cmd, ["-e", migrationVerifierScript], "migration verifier command changed");
    assert.equal(details.HostConfig?.NetworkMode, "none", "migration verifier network isolation changed");
    assert.equal(details.HostConfig?.ReadonlyRootfs, true, "migration verifier root filesystem is writable");
    assert.ok(details.HostConfig?.CapDrop?.includes("ALL"), "migration verifier capabilities changed");
    assert.ok(details.HostConfig?.SecurityOpt?.some((option) => option === "no-new-privileges" || option === "no-new-privileges:true"),
      "migration verifier privilege isolation changed");
    packagedOutput = await execute("docker", ["logs", verifierName], context.environment);
  } else {
    packagedOutput = await execute("docker", ["run", "--name", verifierName, "--pull", "never",
      "--label", `io.wasalx.migration-verifier.candidate=${context.candidateSha}`,
      "--label", `io.wasalx.migration-verifier.script-sha256=${migrationVerifierScriptSha}`,
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--entrypoint", "node", imageId, "-e", migrationVerifierScript], context.environment);
  }
  const packaged = JSON.parse(packagedOutput);
  assert.deepEqual(packaged.map(({ name, blob }) => ({ name, blob })), expected,
    "packaged migrations differ from canonical Git bytes");
  const ids = (await execute("docker", ["ps", "-aq", "--filter",
    `label=com.docker.compose.project=${context.project}`, "--filter",
    "label=com.docker.compose.service=postgres"], context.environment)).split(/\s+/u).filter(Boolean);
  assert.ok(ids.length <= 1, "ambiguous migration database");
  if (!ids.length) {
    assert.ok(!context.requireCompleteMigrationLedger, "complete DEV migration ledger requires postgres");
    return; // Default fresh installation remains owned by migrate.ts.
  }
  const query = async (sql) => execute("docker", ["exec", ids[0], "psql", "-U", "wasalx", "-d", "wasalx",
    "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `BEGIN READ ONLY; ${sql}; COMMIT;`], context.environment);
  if (!(await query("SELECT to_regclass('public.wasalx_schema_migrations')"))) {
    assert.ok(!context.requireCompleteMigrationLedger, "complete DEV migration ledger requires its installed table");
    return;
  }
  const ledger = JSON.parse(await query("SELECT coalesce(json_agg(json_build_object('name',name,'checksum_sha256',checksum_sha256) ORDER BY name),'[]') FROM public.wasalx_schema_migrations"));
  if (context.requireCompleteMigrationLedger) assert.deepEqual(ledger,
    packaged.map(({ name, checksum_sha256 }) => ({ name, checksum_sha256 })), "DEV migration ledger is not the complete exact candidate");
  // Check historical bytes, not clean-install/boundary policy (owned by migrate.ts).
  for (const row of ledger.filter(({ name }) => /^\d{4}_/u.test(name))) {
    assert.equal(packaged.find(({ name }) => name === row.name)?.checksum_sha256,
      row.checksum_sha256, "packaged migration differs from applied ledger");
  }
}

export function matchesCandidate(image, sha, tree, dockerfile, buildContextSha256) {
  return /^sha256:[0-9a-f]{64}$/u.test(image?.Id ?? "")
    && image.Config?.Labels?.["org.opencontainers.image.revision"] === sha
    && image.Config?.Labels?.["io.wasalx.source.tree"] === tree
    && image.Config?.Labels?.["io.wasalx.build.dockerfile"] === dockerfile
    && (buildContextSha256 === undefined || image.Config?.Labels?.["io.wasalx.build.context-sha256"] === buildContextSha256);
}

// Fixed existing DEV preservation only. A fresh capture is diagnosis/admission input,
// never authority to replay a historical initializer or unknown provider effect.
async function devInspect(context) {
  const execute = context.command ?? run;
  const ids = (await execute("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${context.project}`], context.environment)).split(/\s+/u).filter(Boolean);
  assert.ok(ids.length, "existing DEV project is missing");
  const rows = JSON.parse(await execute("docker", ["inspect", ...ids], context.environment));
  assert.ok(rows.every((row) => row.Config?.Labels?.["com.docker.compose.project"] === context.project));
  return rows;
}
export async function devReadOnlyQuery(context, sql) {
  const execute = context.command ?? run;
  const postgres = (await devInspect(context)).filter((row) => row.Config.Labels["com.docker.compose.service"] === "postgres");
  assert.equal(postgres.length, 1, "ambiguous DEV database"); assert.equal(postgres[0].State.Running, true);
  return execute("docker", ["exec", postgres[0].Id, "psql", "-U", "wasalx", "-d", "wasalx", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `BEGIN READ ONLY; ${sql}; COMMIT;`], context.environment);
}
export async function readDevNativeSync(context) {
  const exists = await devReadOnlyQuery(context, "SELECT to_regclass('public.native_membership_projections')");
  if (!exists) return { tableExists: false, pending: 0, unavailableCount: 0, unavailableSha256: devValueDigest([]) };
  const result = JSON.parse(await devReadOnlyQuery(context, `SELECT json_build_object(
    'pending',count(*) FILTER (WHERE sync_state='PENDING'),
    'unavailable',coalesce(json_agg(to_jsonb(p) ORDER BY tenant_id,user_id) FILTER (WHERE sync_state='UNAVAILABLE'),'[]'::json))
    FROM public.native_membership_projections p`));
  assert.ok(Number.isSafeInteger(result.pending) && result.pending >= 0);
  assert.ok(Array.isArray(result.unavailable));
  return { tableExists: true, pending: result.pending, unavailableCount: result.unavailable.length, unavailableSha256: devValueDigest(result.unavailable) };
}
export function assertDevNativeSync(before, after) {
  assert.equal(after.tableExists, true, "required native projection migration did not install");
  assert.equal(after.pending, 0, "native membership pending effects prevent API startup");
  assert.equal(after.unavailableCount, before.unavailableCount, "native membership UNKNOWN count changed");
  assert.equal(after.unavailableSha256, before.unavailableSha256, "native membership UNKNOWN intent changed");
}
export async function captureDevInstallPreimages(context) {
  const rows = await devInspect(context);
  const api = rows.find((row) => row.Config.Labels["com.docker.compose.service"] === "control-api");
  const active = activeServiceNames(context.model, composeProfiles);
  const heldPrerequisites = devHeldPrerequisites(context.model, active);
  const oneShots = new Set(oneShotServiceNames(context.model, active));
  const cold = rows.some((row) => !["control-api", ...devColdResidents, ...devHeldServices].includes(row.Config.Labels["com.docker.compose.service"])
    && !oneShots.has(row.Config.Labels["com.docker.compose.service"]) && !row.State.Running);
  const held = cold ? active.filter((name) => !devColdResidents.includes(name)) : [...devHeldServices, ...Object.keys(heldPrerequisites)];
  for (const row of rows) {
    const name = row.Config.Labels["com.docker.compose.service"];
    if (cold && !devColdResidents.includes(name)) assert.equal(row.State.Running, false, `${name} cold hold was started`);
    // API is temporarily quiesced for migration; its exited/PID0 preimage is mandatory below.
    if (cold && !row.State.Running) {
      assert.ok(["created", "exited"].includes(row.State.Status) && row.State.Pid === 0 && (name in heldPrerequisites || [0, 143].includes(row.State.ExitCode))
        && !row.State.OOMKilled && !row.State.Error, `${name} stopped lifecycle requires review`);
      if (oneShots.has(name) && !(name in heldPrerequisites)) assert.equal(row.State.ExitCode, 0, `${name} existing one-shot failed`);
    } else if (name !== "control-api" && !held.includes(name)) {
      if (oneShots.has(name)) {
        assert.equal(row.State.Status, "exited", `${name} existing one-shot did not complete`);
        assert.equal(row.State.ExitCode, 0, `${name} existing one-shot failed`);
      } else {
        assert.equal(row.State.Running, true, `${name} required DEV resident is stopped`);
        assert.equal(row.State.Status, "running", `${name} required DEV resident is not running`);
      }
    }
    if (!held.includes(name)) assert.equal(row.RestartCount, 0, "existing DEV restart history requires review before replacement");
    assert.equal(row.State.Paused, false); assert.equal(row.State.Dead, false); assert.equal(row.State.Restarting ?? false, false);
    const test = row.Config.Healthcheck?.Test;
    // Old portal readiness depends on the deliberately stopped API; installed candidate health stays mandatory.
    const awaitingHeldApi = name === "portal" && context.model.services.portal?.depends_on?.["control-api"]?.condition === "service_healthy"
      && api?.State.Status === "exited" && api.State.Running === false && api.State.Pid === 0;
    if (row.State.Running && !awaitingHeldApi && Array.isArray(test) && test.length && test[0] !== "NONE") assert.equal(row.State.Health?.Status, "healthy", "existing DEV prerequisite is unhealthy");
  }
  if (cold) assert.ok(devColdResidents.every((name) => active.includes(name)), "Cold DEV resident inventory incomplete");
  const record = { schemaVersion: 1, kind: "dev-held-install-preimages", candidateSha: context.candidateSha,
    candidateTree: context.candidateTree, project: context.project, observedAt: new Date().toISOString(),
    machineIdSha256: createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex"),
    ...(cold ? { admissionMode: "cold-held" } : {}),
    heldServices: [...held].sort(), heldPrerequisites, preservedServices: cold ? [...active].sort() : [...devPreservedServices].sort(),
    services: rows.map(devContainerPreimage).sort((a,b) => a.service.localeCompare(b.service)),
    nativeSync: cold && !rows.find((row) => row.Config.Labels["com.docker.compose.service"] === "postgres")?.State.Running
      ? { state: "UNKNOWN", reason: "postgres stopped" } : await readDevNativeSync(context),
    ...(context.devReviewAuthOrigins ? { devReviewAuth: captureDevReviewAuth(rows, context.devReviewAuthOrigins) } : {}) };
  if (!context.devReviewAuthOrigins) captureDevReviewAuth(rows);
  assertDevInstallPreimages(record, { ...context, machineIdSha256: record.machineIdSha256,
    activeServices: activeServiceNames(context.model, composeProfiles) });
  return record;
}
export function assertDevPreserved(record, rows, released = []) {
  for (const name of devPreservedServices.filter((name) => !released.includes(name))) {
    const row = rows.find((item) => item.Config.Labels["com.docker.compose.service"] === name);
    assert.ok(row, `${name} preserved container is missing`);
    assert.deepEqual(devContainerPreimage(row), record.services.find(({ service }) => service === name), `${name} preserved preimage changed`);
  }
}
export async function verifyDevNativePackage(context) {
  const execute = context.command ?? run;
  const rails = (await devInspect(context)).filter((row) => row.Config.Labels["com.docker.compose.service"] === "zammad-railsserver");
  assert.equal(rails.length, 1); assert.equal(rails[0].State.Running, true);
  const script = `ActiveRecord::Base.transaction do
    ActiveRecord::Base.connection.execute('SET TRANSACTION READ ONLY')
    proof = Wasalx::InstalledPackage.verify!
    raise 'Service identity addon schema is missing' unless Setting.exists?(name: Wasalx::ServiceIdentity::SETTING) && Permission.where(name: ['wasalx_service','wasalx_privacy']).count == 2
    receipt = Wasalx::ServiceIdentity.receipt
    markers = Wasalx::ServiceIdentity.handover_evidence?
    raise 'Service identity markers require receipt reconciliation' if markers && !receipt
    puts JSON.generate(proof.merge('receipt_phase' => receipt && receipt['phase'], 'machine_evidence' => markers,
      'service_identity_authority_verified' => false, 'retained_receipt_reconciliation_required' => !!receipt))
  end`;
  const proof = parseRailsJson(await execute("docker", ["exec", rails[0].Id, "/opt/zammad/bin/rails", "runner", script], context.environment));
  assert.equal(proof.candidate_commit_sha, context.candidateSha); assert.equal(proof.candidate_tree_sha, context.candidateTree);
  assert.equal(proof.package_version, context.nativePackage.version); assert.equal(proof.native_package_sha256, context.nativePackage.sha256);
  assert.ok(Number.isSafeInteger(proof.source_files_verified) && proof.source_files_verified > 0);
  assert.ok(proof.receipt_phase === null || ["PREPARED", "BOUND", "COMPLETE"].includes(proof.receipt_phase));
  assert.equal(proof.service_identity_authority_verified, false);
  assert.equal(proof.retained_receipt_reconciliation_required, proof.receipt_phase !== null);
  return proof;
}
async function devPhase(context, record, name, oneShot = false, released = []) {
  const execute = context.command ?? run;
  assert.ok(released.includes(name) || (!devPreservedServices.includes(name) && !devHeldServices.includes(name)), "preserved service must never execute");
  const rows = await devInspect(context);
  assertDevPreserved(record, rows, released);
  const before = rows.find((row) => row.Config.Labels["com.docker.compose.service"] === name);
  if (released.includes(name)) assert.equal(before?.RestartCount,
    record.services.find(({ service }) => service === name)?.restartCount, `${name} held restart history changed`);
  for (const [dependency, condition] of Object.entries(context.model.services[name].depends_on ?? {})) {
    const row = rows.find((item) => item.Config.Labels["com.docker.compose.service"] === dependency);
    assert.ok(row, `${name} prerequisite missing: ${dependency}`);
    if (condition.condition === "service_completed_successfully") {
      assert.equal(row.State.Status, "exited", `${dependency} prerequisite not completed`); assert.equal(row.State.ExitCode, 0);
    } else {
      assert.equal(row.State.Running, true, `${dependency} prerequisite not running`);
      if (condition.condition === "service_healthy") assert.equal(row.State.Health?.Status, "healthy", `${dependency} prerequisite unhealthy`);
    }
  }
  if (name === "control-api") {
    const activation = await devReadOnlyQuery(context, `SELECT count(*) FROM zammad_instances WHERE
      id='00000000-0000-4000-8000-000000000003' AND tenant_id='00000000-0000-4000-8000-000000000001'
      AND base_url='http://zammad-nginx:8080' AND version='7.1.3-0000'
      AND service_secret_reference='secret://tenants/00000000-0000-4000-8000-000000000001/zammad/service' AND state='WORKING'`);
    assert.equal(activation, "1", "retained activation row requires reviewed reconciliation");
    assertDevNativeSync(record.nativeSync, await readDevNativeSync(context));
  }
  const flags = oneShot ? ["--abort-on-container-exit", "--exit-code-from", name] : ["--detach", "--wait"];
  assert.equal(await execute("docker", [...context.composeArguments, "up", "--no-deps", "--no-build", "--pull", "never", ...flags, name], context.environment, true), 0, `${name} phase failed; no replay`);
  const completed = (await devInspect(context)).find((row) => row.Config.Labels["com.docker.compose.service"] === name);
  assert.ok(completed);
  assert.equal(completed.RestartCount, 0, `${name} restarted during its phase`);
  if (oneShot) { assert.equal(completed.State.Status, "exited"); assert.equal(completed.State.ExitCode, 0); }
  else {
    assert.equal(completed.State.Running, true); assert.equal(completed.State.Status, "running");
    const test = completed.Config.Healthcheck?.Test;
    if (context.model.services[name].healthcheck && context.model.services[name].healthcheck.disable !== true)
      assert.ok(Array.isArray(test) && test.length && test[0] !== "NONE", `${name} runtime healthcheck is disabled`);
    if (Array.isArray(test) && test.length && test[0] !== "NONE") assert.equal(completed.State.Health?.Status, "healthy");
  }
}

export async function releaseDevHeld(context, record, service) {
  assert.equal(context.project, "wasalx-live", "held release requires DEV");
  assert.notEqual(record.admissionMode, "cold-held", "cold held release requires separate review");
  assertDevInstallPreimages(record, { ...context, activeServices: activeServiceNames(context.model, composeProfiles),
    machineIdSha256: createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex") });
  assert.ok(record.heldServices.includes(service) && devHeldServices.includes(service), "service is not a recorded held sender");
  const before = await devInspect(context);
  assertDevReviewAuthRows(record.devReviewAuth, before);
  const held = before.find((row) => row.Config.Labels["com.docker.compose.service"] === service);
  assert.ok(held && !held.State.Running && held.State.Pid === 0 && ["created", "exited"].includes(held.State.Status), "held sender must remain stopped");
  assert.ok(!held.State.Paused && !held.State.Dead && !held.State.Restarting, "held sender lifecycle requires review");
  assert.equal(held.RestartCount, record.services.find(({ service: name }) => name === service).restartCount,
    `${service} held restart history changed`);
  for (const [prerequisite, dependents] of Object.entries(record.heldPrerequisites ?? {})) {
    if (dependents.includes(service)) await devPhase(context, record, prerequisite, true, record.heldServices);
  }
  await devPhase(context, record, service, false, record.heldServices);
  const after = await devInspect(context);
  assertDevPreserved(record, after, record.heldServices);
  assertDevReviewAuthRows(record.devReviewAuth, after);
  return 0;
}

export async function replaceDevHeld(context, record) {
  assert.notEqual(record.admissionMode, "cold-held", "Cold admission requires the chain-preserving Python held installer");
  const execute = context.command ?? run;
  const before = await devInspect(context);
  assertDevReviewAuthRows(record.devReviewAuth, before);
  for (const name of ["control-api", ...devHeldServices]) assert.deepEqual(
    devContainerPreimage(before.find((row) => row.Config.Labels["com.docker.compose.service"] === name)),
    record.services.find(({ service }) => service === name), "DEV ingress hold changed");
  assertDevPreserved(record, before);
  const phase = (name, oneShot = false) => devPhase(context, record, name, oneShot);
  // Fixed small layers, never implicit dependencies or legacy/seed bootstrap.
  await phase("migrate", true);
  const migrationImage = context.plan.find(({ id }) => id === "control-api");
  await verifyMigrationInputs({ ...context, requireCompleteMigrationLedger: true },
    JSON.parse(await execute("docker", ["image", "inspect", migrationImage.reference], context.environment))[0].Id);
  await phase("runtime-role-bootstrap", true);
  assertDevNativeSync(record.nativeSync, await readDevNativeSync(context));
  await phase("zammad-init", true);
  await phase("zammad-package", true);
  for (const name of ["secret-sidecar", "zammad-railsserver", "zammad-websocket", "zammad-nginx"]) await phase(name);
  for (const name of ["connector-worker", "identity-policy-activator", "invitation-mailer"]) {
    assert.equal(await execute("docker", [...context.composeArguments, "up", "--no-start", "--no-deps", "--no-build", "--pull", "never", name], context.environment, true), 0);
    const row = (await devInspect(context)).find((item) => item.Config.Labels["com.docker.compose.service"] === name);
    assert.ok(row); assert.equal(row.State.Running, false); assert.equal(row.State.Pid, 0);
    assert.equal(row.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(devContainerPreimage(row).mounts, record.services.find(({ service }) => service === name).mounts);
  }
  await verifyDevNativePackage(context);
  await phase("control-api"); await phase("portal");
  const after = await devInspect(context);
  assertDevPreserved(record, after);
  assertDevReviewAuthRows(record.devReviewAuth, after);
  return 0;
}

// This is stage execution, not operator acceptance: browser sign-in and
// reviewed in-flight effects cannot be inferred from environment variables.
export async function executeStage(action, context) {
  const { plan, candidateSha, candidateTree, environment, composeArguments, project,
    model, directory, drained = false, retryReviewed = false, command = run } = context;
  const execute = (...args) => command(...args);
  context = { ...context, command };
  assert.ok(!["verify-hosted", "admit-hosted"].includes(action) || context.hostedImages, "explicit hosted inventory required");
  assert.ok(!context.hostedImages || !["build", "qualify"].includes(action), "hosted admission cannot use the local build stage");
  if (action === "admit-hosted") {
    // Capture original mutable tags before the separately controlled preload.
    await readFile(preimagePath(context));
  }
  const hosted = context.hostedImages && ["preflight", "verify-hosted", "admit-hosted"].includes(action)
    ? await verifyHostedImages(context, { verifyOnly: action === "verify-hosted" }) : null;
  if (action === "verify-hosted") return 0;
  if (action === "rollback-safety" || (action === "replace" && !context.hostedImages)) await preparePrivateDirectory(context);
  if (action === "rollback") return rollbackReplacement(context);
  if (action === "rollback-safety") {
    const { manifest, snapshot } = await readBoundArtifacts(context);
    return (await produceRollbackSafety(context, manifest, snapshot, await inspectOwned(context))).state === "CLEAR" ? 0 : 1;
  }
  const active = activeServiceNames(model, composeProfiles);
  const inspect = async () => {
    const ids = (await execute("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], environment)).split(/\s+/u).filter(Boolean);
    if (!ids.length) return [];
    const containers = JSON.parse(await execute("docker", ["inspect", ...ids], environment));
    return containers.map((container) => {
      assert.equal(container.Config?.Labels?.["com.docker.compose.project"], project, "container ownership changed");
      return { id: container.Id, image: container.Image,
        service: container.Config.Labels["com.docker.compose.service"],
        running: container.State.Running, exitCode: container.State.ExitCode };
    });
  };
  const inspectImage = async (reference) => {
    try { return JSON.parse(await execute("docker", ["image", "inspect", reference], environment))[0]; }
    catch { return null; }
  };
  const dependencies = [...new Set(active.filter((name) => !model.services[name].build)
    .map((name) => model.services[name].image))];
  const verifyDependencies = async (pullMissing = false) => {
    for (const reference of dependencies) {
      assert.match(reference ?? "", /@sha256:[0-9a-f]{64}$/u, "dependency image must be pinned");
      if (!await inspectImage(reference) && pullMissing) {
        const exit = await execute("docker", ["pull", "--quiet", reference], environment, true);
        assert.equal(exit, 0, `dependency image pull failed: ${reference}`);
      }
      assert.ok(await inspectImage(reference), `dependency image missing; run build before replacement: ${reference}`);
    }
  };
  if (action === "preload-hosted") {
    assert.ok(context.imageSource && context.hostedImages, "preload requires signed rehearsal inputs");
    await readFile(preimagePath(context));
    await verifyHostedImages(context, { verifyOnly: true });
    const inventory = await readHostedInventory(context);
    for (const { id, reference } of plan) {
      const source = inventory.images[id].pullReference;
      assert.equal(await execute("docker", ["pull", "--platform", "linux/amd64", "--quiet", source], environment, true), 0,
        `${id} digest pull failed`);
      await execute("docker", ["image", "tag", source, reference], environment);
    }
    await verifyDependencies(true);
    return 0;
  }
  if (action === "preflight") {
    await assertRepositoryBindMountsReadable(context);
    if (context.capturePreimage) await preserveReplacement(context);
    if (context.devReviewAuthOrigins && !context.captureDevPreimagesFile) captureDevReviewAuth(await devInspect(context), context.devReviewAuthOrigins);
    if (context.captureDevPreimagesFile) await writeFile(context.captureDevPreimagesFile,
      `${JSON.stringify(await captureDevInstallPreimages(context))}\n`, { flag: "wx", mode: 0o600 });
    return 0;
  }
  if (action === "build") {
    assert.match(context.buildContextSha256 ?? "", /^[0-9a-f]{64}$/u, "verified build context hash required");
    assert.equal(sha256(context.buildContext), context.buildContextSha256, "build context bytes changed");
    assert.match(context.catalogSha256 ?? "", /^[0-9a-f]{64}$/u, "catalog bytes hash required");
    const preserved = await preserveReplacement(context);
    const manifest = { schemaVersion: 1, kind: "compose-candidate-artifacts", candidateSha, candidateTree, project,
      buildContextSha256: context.buildContextSha256, catalogSha256: context.catalogSha256,
      buildContextAlgorithm: "sha256-git-archive-tar-v1",
      modelSha256: devValueDigest(model), model, plan,
      preimage: { sha256: preserved.sha256, transactionId: preserved.snapshot.transactionId },
      state: "BUILDING", images: plan.map((image) => ({ ...image, imageId: null, state: "PENDING",
        services: imageServices(model, image.dockerfile) })) };
    await writeArtifactState(context, manifest);
    let buildingImage;
    try {
      for (const image of manifest.images) {
        buildingImage = image;
        if (matchesCandidate(await inspectImage(image.reference), candidateSha, candidateTree, image.dockerfile, context.buildContextSha256)) {
          image.state = "REUSED";
        } else {
          const exit = await execute("docker", ["build",
            "--build-arg", `COMMIT_SHA=${candidateSha}`,
            "--build-arg", `WASALX_CANDIDATE_SHA=${candidateSha}`,
            "--build-arg", `WASALX_CANDIDATE_TREE=${candidateTree}`,
            "--label", `org.opencontainers.image.revision=${candidateSha}`,
            "--label", `io.wasalx.source.tree=${candidateTree}`,
            "--label", `io.wasalx.build.dockerfile=${image.dockerfile}`,
            "--label", `io.wasalx.build.context-sha256=${context.buildContextSha256}`,
            "--file", image.dockerfile, "--tag", image.reference, "-"], environment, true, context.buildContext);
          assert.equal(exit, 0, `${image.id} build failed`);
          image.state = "BUILT";
        }
        const details = await inspectImage(image.reference);
        assert.ok(matchesCandidate(details, candidateSha, candidateTree, image.dockerfile, context.buildContextSha256), `${image.id} build identity mismatch`);
        image.imageId = details.Id;
        await writeArtifactState(context, manifest);
        buildingImage = undefined;
      }
      if (model.services.migrate) {
        const migrationImage = plan.find(({ id }) => id === "control-api");
        assert.ok(migrationImage, "migration image missing from candidate plan");
        await verifyMigrationInputs(context, (await inspectImage(migrationImage.reference)).Id);
      }
      await verifyDependencies(true);
      manifest.state = "PASS";
    } catch (error) {
      if (buildingImage) buildingImage.state = "FAILED";
      manifest.state = "FAILED";
      throw error;
    } finally { await writeArtifactState(context, manifest); }
    return 0;
  }
  if (action === "admit-hosted") {
    await verifyDependencies();
    const preserved = await preserveReplacement(context);
    await writeArtifactState(context, { schemaVersion: 1, kind: "compose-hosted-image-admission",
      candidateSha, candidateTree, project, catalogSha256: context.catalogSha256,
      hostedImagesSha256: context.hostedImagesSha256, trustedRootSha256: hosted.trustedRootSha256,
      publisher: hosted.publisher, issuer: hostedIssuer,
      modelSha256: devValueDigest(model), model, plan, state: "PASS",
      preimage: { sha256: preserved.sha256, transactionId: preserved.snapshot.transactionId },
      images: hosted.images.map(image => ({ ...image, services: imageServices(model, image.dockerfile) })) });
    return 0;
  }
  // Missing/stale images fail before any stop, migration or start.
  const admission = context.hostedImages ? (await readBoundArtifacts(context)).manifest : null;
  await verifyDependencies();
  const imageIds = [];
  for (const [index, image] of plan.entries()) {
    const details = await inspectImage(image.reference);
    // The admitted ID pins the verified config directly or through its manifest.
    if (admission) assert.equal(details?.Id, admission.images[index].imageId, "admitted hosted image changed");
    else assert.ok(matchesCandidate(details, candidateSha, candidateTree, image.dockerfile, context.buildContextSha256), `${image.id} requires the build stage`);
    imageIds.push(details.Id);
  }
  if (action === "release-held") {
    assert.ok(context.devPreimagesFile && context.devPreimagesSha256, "held release requires bound DEV preimages");
    const bytes = await readFile(context.devPreimagesFile);
    assert.equal(sha256(bytes), context.devPreimagesSha256, "DEV preimage file changed");
    return releaseDevHeld(context, JSON.parse(bytes), context.service);
  }
  if (action === "replace") {
    if (admission) await preparePrivateDirectory(context);
    assert.ok(drained, "replace requires --drained after test quiescence and in-flight review");
    if (model.services.migrate) {
      const index = plan.findIndex(({ id }) => id === "control-api");
      assert.ok(index >= 0, "migration image missing from candidate plan");
      await verifyMigrationInputs(context, imageIds[index]);
    }
    let devRecord;
    if (context.devPreimagesFile) {
      assert.equal(retryReviewed, false, "DEV preserving replacement cannot replay a prior attempt");
      const bytes = await readFile(context.devPreimagesFile);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), context.devPreimagesSha256, "DEV preimage file changed");
      devRecord = JSON.parse(bytes.toString("utf8"));
      assert.notEqual(devRecord.admissionMode, "cold-held", "Cold admission requires the chain-preserving Python held installer");
      assertDevInstallPreimages(devRecord, { ...context, activeServices: active,
        machineIdSha256: createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex") });
      assert.ok(Date.now() - Date.parse(devRecord.observedAt) >= 0 && Date.now() - Date.parse(devRecord.observedAt) <= 60_000,
        "DEV mutation requires fresh action-time preimages");
      assert.deepEqual((await devInspect(context)).map(devContainerPreimage).sort((a,b)=>a.service.localeCompare(b.service)), devRecord.services);
      assert.deepEqual(await readDevNativeSync(context), devRecord.nativeSync, "DEV native-sync preimage changed before replacement");
    }
    const { manifest, snapshot } = await readBoundArtifacts(context);
    for (let index = 0; index < plan.length; index += 1) {
      assert.equal(manifest.images[index]?.imageId, imageIds[index], "candidate immutable image changed since build");
    }
    const effects = await readOptionalState(context, "replacement-effects");
    if (effects) {
      assert.equal(effects.transactionId, snapshot.transactionId, "effect fence transaction changed");
      assert.ok(retryReviewed, "partial replacement requires --retry-reviewed");
    } else await assertRetainedPreimage(context, snapshot);
    const before = await inspect();
    assert.ok(before.every(({ service }) => active.includes(service)), "review owned orphan containers before replacement");
    const marker = resolve(directory, `replacement-started-${project}.json`);
    const attempt = { candidateSha, candidateTree, project, startedAt: new Date().toISOString(), imageIds, ...(devRecord ? { devPreimagesSha256: context.devPreimagesSha256 } : {}) };
    try { await writeFile(marker, `${JSON.stringify(attempt)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || !retryReviewed) throw error;
      await writeFile(resolve(directory, `replacement-retry-${project}-${Date.now()}.json`),
        `${JSON.stringify(attempt)}\n`, { flag: "wx", mode: 0o600 });
    }
    const old = before.filter(({ service, running }) => running && model.services[service]?.build && (!devRecord || !devPreservedServices.includes(service)));
    if (old.length) {
      const exit = await execute("docker", ["stop", "--time", "60", ...old.map(({ id }) => id)], environment, true);
      if (exit !== 0) return exit;
      const after = await inspect();
      assert.ok(old.every(({ id }) => {
        const stopped = after.find((container) => container.id === id);
        return !stopped || (!stopped.running && stopped.exitCode !== 137);
      }), "old application did not drain cleanly; inspect before resuming");
    }
    for (let index = 0; index < plan.length; index += 1) {
      assert.equal((await inspectImage(plan[index].reference))?.Id, imageIds[index], "candidate image changed during replacement");
    }
    await fenceReplacementEffects(context, manifest.preimage.transactionId);
    const targets = active.filter((name) => model.services[name].build && (!devRecord || !devPreservedServices.includes(name)));
    if (devRecord) {
      const exit = await replaceDevHeld(context, devRecord);
      if (exit === 0) await recordReplacementAfter(context, snapshot, await inspectOwned(context), targets);
      return exit;
    }
    // Let Compose reconcile only changed services. Do not force-recreate healthy
    // databases, identity services or provider sessions; never down/prune volumes.
    const exit = await execute("docker", [...composeArguments, "up", "--no-build", "--pull", "never", "--wait"], environment, true);
    if (exit === 0) await recordReplacementAfter(context, snapshot, await inspectOwned(context), targets);
    return exit;
  }
  assert.equal(action, "smoke");
  return execute(process.execPath, [verifier, project, "--full", "--env-file", context.envFile,
    "--compose-file", "compose.yaml", "--compose-file", "compose.full.yaml",
    ...(context.imageSource ? ["--compose-file", rehearsalComposeFile, "--rehearsal-main", context.imageSource.commit] : []),
    ...composeProfiles.flatMap((profile) => ["--profile", profile]),
    ...(context.devPreimagesFile ? ["--dev-preimages", context.devPreimagesFile, "--dev-preimages-sha256", context.devPreimagesSha256] : []),
    ...plan.flatMap(({ id, reference }) => ["--candidate-image", `${id}=${reference}`]),
  ], environment, true);
}

export function createCandidatePlan(catalog, compose) {
  const builtServices = Object.entries(compose.services ?? {}).filter(([, service]) => service.build);
  const plan = catalog.images.map((image) => {
    const references = new Set(builtServices
      .filter(([, service]) => dockerfileOf(service) === image.dockerfile.replaceAll("\\", "/"))
      .map(([, service]) => service.image));
    assert.ok(references.size <= 1, `${image.id} has conflicting Compose image references`);
    const fallback = image.id === "zammad"
      ? `wasalx/zammad:7.1.3-wasalx-${catalog.tenantProvisioning.package.version}`
      : `wasalx/${image.repository}:local`;
    return { id: image.id, dockerfile: image.dockerfile, reference: [...references][0] ?? fallback };
  });
  assert.equal(new Set(plan.map(({ id }) => id)).size, plan.length, "candidate image ids must be unique");
  assert.equal(new Set(plan.map(({ reference }) => reference)).size, plan.length, "candidate image references must be unique");
  return plan;
}

function commandStderrTail(stderr, environment) {
  if (!stderr) return "";
  const source = stripVTControlCharacters(stderr);
  const values = Object.values(environment ?? process.env).filter(Boolean)
    .map(value => stripVTControlCharacters(value))
    .filter(value => value && source.includes(value));
  const patterns = [
    /(\b(?:Bearer|Basic)\s+)\S+/giu,
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+(?=@)/giu,
    /((?<![\w.-])(?=[\w.-]*(?:password|passwd|pwd|token|secret|api[_-]?key|private[_-]?key|credential))[\w.-]+["']?[ \t]*:[ \t]*)(?:"(?:\\.|[^"\\])*"(?=[ \t]*[,}])|[^\r\n]+)/giu,
    /((?<![\w.-])[\w.-]+[ \t]*=[ \t]*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/giu,
    /()\b[\w+/-]{24,}={0,2}/gu,
  ];
  // Match against the same text so an environment value in a key cannot change how it is parsed.
  const ranges = patterns.flatMap(pattern => Array.from(source.matchAll(pattern),
    match => [match.index + match[1].length, match.index + match[0].length]));
  for (const value of new Set(values)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp("(?=" + escaped + ")", "gu"))) {
      ranges.push([match.index, match.index + value.length]);
    }
  }
  ranges.sort(([left], [right]) => left - right);
  const parts = [];
  let end = 0;
  for (const [start, stop] of ranges) {
    if (start >= end) parts.push(source.slice(end, start), "[redacted]");
    end = Math.max(end, stop);
  }
  parts.push(source.slice(end));
  const detail = parts.join("").replace(/[\s\p{Cc}]+/gu, " ").trim();
  return Buffer.from(detail).subarray(-2048).toString("utf8").replace(/^\uFFFD+/u, "");
}

export function run(command, arguments_, environment, inherit = false, input) {
  if (inherit) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, arguments_, { cwd: repository, env: environment,
        stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", shell: false, windowsHide: true });
      child.once("error", rejectPromise);
      if (input) {
        child.stdin.on("error", (error) => { if (error.code !== "EPIPE") rejectPromise(error); });
        child.stdin.end(input);
      }
      child.once("exit", (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)));
    });
  }
  const result = spawnSync(command, arguments_, { cwd: repository, env: environment, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    const tail = commandStderrTail(result.stderr, environment);
    assert.equal(result.status, 0, tail ? `${command} failed: ${tail}` : `${command} failed`);
  }
  return result.stdout.trim();
}

export function enterComposeStageLock(arguments_, environment, command = run) {
  return enterStageLock(arguments_, environment, command, fileURLToPath(import.meta.url));
}

export function stageFailureReason(error) {
  if (error?.name === "AssertionError") {
    // Node can append the assertion's actual and expected values to the message.
    if (!error.generatedMessage) return error.message.split(/\r?\n/u, 1)[0];
    const frame = String(error.stack ?? "").split(/\r?\n/u).find((line) => /^\s+at /u.test(line));
    const location = frame?.match(/scripts[\\/]release[\\/]([^/\\():]+):(\d+):\d+/u);
    return location ? `assertion failed at ${location[1]}:${location[2]}` : "assertion failed at unknown";
  }
  if (error?.code) {
    const path = error.path ?? error.filename ?? error.dest;
    // Split on both separators so neither a POSIX nor a Windows directory leaks on any host.
    return path ? `${error.code} (${String(path).split(/[\\/]/u).pop()})` : String(error.code);
  }
  return error?.name ?? "unknown error";
}

export function reportStageFailure(stage, error, stream = process.stderr) {
  stream.write(`remote full stage ${stage} failed; inspect before retry\n`);
  stream.write(`remote full stage ${stage} reason: ${stageFailureReason(error)}\n`);
}

async function main() {
  const [action, envFlag, envFile, projectFlag, project, ...extra] = process.argv.slice(2);
  const rest = []; let devPreimagesFile; let captureDevPreimagesFile; let devPreimagesSha256;
  let devReviewPortalOrigin; let devReviewIdentityOrigin;
  let service;
  let rollbackSafetyFile; let rollbackSafetySha256;
  let hostedImages; let hostedImagesSha256; let hostedTrustedRoot;
  let rehearsalMain;
  for (let i = 0; i < extra.length; i += 1) {
    if (["--hosted-images", "--hosted-images-sha256", "--hosted-trusted-root"].includes(extra[i])) {
      const flag = extra[i], value = extra[++i];
      if (flag === "--hosted-images-sha256") {
        assert.equal(hostedImagesSha256, undefined); assert.match(value ?? "", /^[0-9a-f]{64}$/u); hostedImagesSha256 = value;
      } else {
        assert.ok(isAbsolute(value ?? ""));
        if (flag === "--hosted-images") { assert.equal(hostedImages, undefined); hostedImages = value; }
        else { assert.equal(hostedTrustedRoot, undefined); hostedTrustedRoot = value; }
      }
    } else if (extra[i] === "--rehearsal-main") {
      assert.equal(rehearsalMain, undefined);
      rehearsalMain = extra[++i];
      assert.match(rehearsalMain ?? "", shaPattern);
    } else if (extra[i] === "--service") {
      assert.equal(action, "release-held"); assert.equal(service, undefined);
      service = extra[++i]; assert.match(service ?? "", /^[a-z0-9][a-z0-9_.-]*$/u);
    }
    else if (extra[i] === "--stage-lock-fd") { assert.match(extra[++i] ?? "", /^\d+$/u); }
    else if (extra[i] === "--capture-preimage") { assert.equal(action, "preflight"); rest.push(extra[i]); }
    else if (["--rollback-safety", "--rollback-safety-sha256"].includes(extra[i])) {
      const flag = extra[i], value = extra[++i];
      assert.equal(action, "rollback");
      if (flag === "--rollback-safety") {
        assert.equal(rollbackSafetyFile, undefined); assert.ok(isAbsolute(value ?? "")); rollbackSafetyFile = value;
      } else {
        assert.equal(rollbackSafetySha256, undefined); assert.match(value ?? "", /^[0-9a-f]{64}$/u); rollbackSafetySha256 = value;
      }
    } else if (["--dev-review-origin", "--dev-review-identity-origin"].includes(extra[i])) {
      const flag = extra[i]; const value = extra[++i]; assert.ok(value, "DEV review origin is required");
      if (flag === "--dev-review-origin") { assert.equal(devReviewPortalOrigin, undefined); devReviewPortalOrigin = value; }
      else { assert.equal(devReviewIdentityOrigin, undefined); devReviewIdentityOrigin = value; }
    } else if (["--dev-preimages", "--capture-dev-preimages", "--dev-preimages-sha256"].includes(extra[i])) {
      const value = extra[++i];
      if (extra[i-1] === "--dev-preimages-sha256") {
        assert.equal(devPreimagesSha256, undefined); assert.match(value ?? "", /^[0-9a-f]{64}$/u); devPreimagesSha256 = value; continue;
      }
      assert.ok(isAbsolute(value ?? ""));
      if (extra[i-1] === "--dev-preimages") { assert.equal(devPreimagesFile, undefined); devPreimagesFile = value; }
      else { assert.equal(captureDevPreimagesFile, undefined); captureDevPreimagesFile = value; }
    } else rest.push(extra[i]);
  }
  assert.equal(Boolean(hostedImages), Boolean(hostedImagesSha256), "hosted inventory hash required");
  assert.equal(Boolean(hostedImages), Boolean(hostedTrustedRoot), "separate trusted Sigstore root required");
  assert.ok(!["verify-hosted", "admit-hosted"].includes(action) || hostedImages, "hosted admission inventory required");
  assert.ok(!hostedImages || !["build", "qualify"].includes(action), "hosted admission requires separate stages");
  assert.equal(Boolean(rollbackSafetyFile), Boolean(rollbackSafetySha256), "rollback safety digest binding is required");
  assert.equal(Boolean(devReviewPortalOrigin), Boolean(devReviewIdentityOrigin), "Both approved DEV review origins are required");
  assert.ok(!devReviewPortalOrigin || (action === "preflight" && project === "wasalx-live"), "DEV review origin admission requires DEV preflight");
  const devReviewAuthOrigins = devReviewPortalOrigin ? { portalOrigin: devReviewPortalOrigin, identityOrigin: devReviewIdentityOrigin } : undefined;
  if (devReviewAuthOrigins) devReviewAuthConfiguration(devReviewAuthOrigins);
  assert.equal(Boolean(devPreimagesFile), Boolean(devPreimagesSha256), "DEV preimage digest binding is required");
  assert.ok(!captureDevPreimagesFile || (action === "preflight" && !devPreimagesFile));
  assert.ok(!devPreimagesFile || ["replace", "smoke", "release-held"].includes(action));
  assert.ok(!(devPreimagesFile || captureDevPreimagesFile) || project === "wasalx-live");
  assert.ok(action !== "release-held" || (service && devPreimagesFile && project === "wasalx-live"), "held release requires --service and DEV preimages");
  if (!stages.includes(action) || envFlag !== "--env-file" || !isAbsolute(envFile ?? "") ||
      projectFlag !== "--project-name" || !/^[a-z0-9][a-z0-9_.-]{0,62}$/u.test(project ?? "") ||
      new Set(rest).size !== rest.length || rest.some((flag) => !["--drained", "--retry-reviewed", "--capture-preimage"].includes(flag)) ||
      (rest.length && !["replace", "qualify", "rollback", "preflight"].includes(action)) ||
      (action === "rollback" && rest.includes("--retry-reviewed"))) {
    throw new Error("invalid arguments");
  }

  assertInstallHostname();
  const imageSource = rehearsalMain ? rehearsalImageSource(project, rehearsalMain, args => run("git", args, process.env)) : undefined;
  assert.ok(!imageSource || (["preflight", "preload-hosted", "admit-hosted", "replace", "smoke"].includes(action)
    && !devPreimagesFile && !captureDevPreimagesFile && (action === "preflight" || hostedImages)), "invalid rehearsal stage");
  assert.ok(action !== "preload-hosted" || imageSource, "preload is limited to the disposable rehearsal");
  let devRecord;
  if (devPreimagesFile) {
    const bytes = await readFile(devPreimagesFile);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), devPreimagesSha256, "DEV preimage file changed");
    devRecord = JSON.parse(bytes.toString("utf8"));
    devReviewAuthEnvironment(devRecord?.devReviewAuth);
  }
  if (action === "verify-hosted") {
    const candidateSha = run("git", ["rev-parse", "HEAD"], process.env);
    const candidateTree = run("git", ["rev-parse", "HEAD^{tree}"], process.env);
    assert.match(candidateSha, shaPattern); assert.match(candidateTree, shaPattern);
    assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"], process.env), "", "candidate checkout is dirty");
    const catalog = JSON.parse(await readFile(resolve(repository, "release/installer-images.json"), "utf8"));
    await executeStage(action, { candidateSha, candidateTree, catalog, plan: catalog.images,
      hostedImages, hostedImagesSha256, hostedTrustedRoot, environment: process.env });
    process.stdout.write("hosted inputs verified; no images loaded or tagged\n");
    return 0;
  }
  const preflightExit = await run(process.execPath, [preflight, "--env-file", envFile], process.env, true);
  if (preflightExit !== 0) return preflightExit;
  assert.deepEqual([platform(), arch()], ["linux", "x64"], "qualification must run in the WasalX VM");
  assert.equal(process.env.DOCKER_HOST ?? "", "", "DOCKER_HOST is not allowed during qualification");
  assert.equal(process.env.DOCKER_CONTEXT ?? "", "", "DOCKER_CONTEXT is not allowed during qualification");
  assert.equal(run("docker", ["context", "show"], process.env), "default", "qualification requires the default Docker context");
  // OS-managed lock releases on exit/crash; no stale custom lock recovery loop.
  const locked = enterComposeStageLock(process.argv.slice(2), process.env);
  if (locked !== null) {
    const exit = await locked;
    if (exit === composeStageLockConflict) process.stderr.write("remote full stage lock contention (75); no stage executed\n");
    return exit;
  }
  if (["preflight", "build", "qualify"].includes(action)) {
    const disk = await statfs(repository);
    assert.ok(disk.bavail * disk.bsize >= 10 * 1024 ** 3, "less than 10 GiB free for qualification");
  }

  const candidateSha = run("git", ["rev-parse", "HEAD"], process.env);
  const candidateTree = run("git", ["rev-parse", "HEAD^{tree}"], process.env);
  assert.match(candidateSha, shaPattern);
  assert.match(candidateTree, shaPattern);
  assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"], process.env), "", "candidate checkout is dirty");
  const buildContext = hostedImages ? undefined : await verifyBuildContext(candidateSha);
  const buildContextSha256 = hostedImages ? undefined : sha256(buildContext);

  if (devPreimagesFile) {
    assert.equal(devRecord.candidateSha, candidateSha); assert.equal(devRecord.candidateTree, candidateTree);
    assert.equal(devRecord.project, project);
    assert.equal(devRecord.machineIdSha256, createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex"));
  }
  const environment = {
    ...process.env,
    ...devReviewAuthEnvironment(devRecord?.devReviewAuth),
    COMMIT_SHA: candidateSha,
    WASALX_CANDIDATE_SHA: candidateSha,
    WASALX_CANDIDATE_TREE: candidateTree,
    COMPOSE_PROFILES: "",
    PORTAL_FIXTURE_ROLE: "",
  };
  const composeArguments = [
    "compose", "--env-file", envFile, "--file", "compose.yaml", "--file", "compose.full.yaml",
    ...(imageSource ? ["--file", rehearsalComposeFile] : []),
    ...composeProfiles.flatMap((profile) => ["--profile", profile]), "--project-name", project,
  ];
  run("docker", [...composeArguments, "config", "--quiet"], environment);
  const safeCompose = JSON.parse(run("docker", [
    ...composeArguments, "config", "--no-interpolate", "--no-env-resolution", "--format", "json",
  ], environment));
  const catalogBytes = await readFile(resolve(repository, "release/installer-images.json"));
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const plan = createCandidatePlan(catalog, safeCompose);

  const selected = action === "qualify" ? ["build", "replace", "smoke"] : [action];
  if (action === "qualify") assert.ok(rest.includes("--drained"), "qualify requires reviewed --drained; prefer separate stages");
  for (const stage of selected) {
    try {
      const exit = await executeStage(stage, { plan, candidateSha, candidateTree, environment, composeArguments,
        buildContext, buildContextSha256, catalog, catalogSha256: sha256(catalogBytes), rollbackSafetyFile, rollbackSafetySha256,
        hostedImages, hostedImagesSha256, hostedTrustedRoot, imageSource,
        project, envFile, repository, capturePreimage: rest.includes("--capture-preimage"),
        privateDirectory: resolve(homedir(), `.local/state/wasalx-compose/${candidateSha}/${project}`),
        nativePackage: catalog.tenantProvisioning.package, model: safeCompose, directory: resolve(repository, `output/release-evidence/${candidateSha}`),
        devPreimagesFile, devPreimagesSha256, captureDevPreimagesFile, devReviewAuthOrigins, service, drained: rest.includes("--drained"), retryReviewed: rest.includes("--retry-reviewed") });
      if (exit !== 0) { process.stderr.write(`remote full stage ${stage} failed; inspect before retry\n`); return exit; }
      process.stdout.write(`remote full stage ${stage} passed (operator authentication/live acceptance separate)\n`);
    } catch (error) {
      reportStageFailure(stage, error);
      if (error.rollbackFields) process.stderr.write(`unrecreatable fields: ${JSON.stringify(error.rollbackFields)}\n`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const variable = ["WASALX_INSTALL_EXPECTED_HOSTNAME", "WASALX_DEV_REVIEW_ORIGIN_SUFFIX"].find((name) => error.message?.includes(name));
    process.stderr.write(`remote full qualification failed${variable ? `: check ${variable}` : ""}\n`);
    process.stderr.write(`remote full qualification reason: ${stageFailureReason(error)}\n`);
    process.exitCode = 1;
  }
}
