import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { devContainerPreimage, devValueDigest } from "./installer-stack.mjs";
import { assertRollbackInventory, observeRollbackState, produceRollbackSafety, readOptionalState, rollbackStatePath } from "./installer-rollback-state.mjs";
import { hostedIssuer, readHostedInventory } from "./installer-hosted-images.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fileDigest(path) {
  try { return sha256(await readFile(path)); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
export const artifactPath = (context) => resolve(context.directory, `${context.hostedImages ? "hosted-admission" : "candidate-artifacts"}-${context.project}.json`);
export const preimagePath = (context) => resolve(context.privateDirectory, `replacement-before-${context.project}.json`);
export const composeProfiles = ["full", "runtime-workers"];
export const rollbackTag = (project, id) => `wasalx/rollback-${project}:${id.startsWith("image-") ? id : id.slice(0, 12)}`;
export const isWithin = (parent, path) => { const part = relative(parent, path); return !part || (!part.startsWith("..") && !isAbsolute(part)); };
export function dockerfileOf(service) {
  return (typeof service.build === "object" ? service.build.dockerfile : "Dockerfile")?.replaceAll("\\", "/");
}
export const imageServices = (model, dockerfile) => Object.keys(model.services).filter((name) =>
  model.services[name].build && dockerfileOf(model.services[name]) === dockerfile.replaceAll("\\", "/")).sort();

export async function preparePrivateDirectory(context) {
  assert.ok(isAbsolute(context.privateDirectory ?? ""), "private preimage directory required");
  await mkdir(context.privateDirectory, { recursive: true, mode: 0o700 });
  const path = await realpath(context.privateDirectory);
  for (const forbidden of [context.directory, context.repository]) {
    assert.ok(forbidden && !isWithin(await realpath(forbidden), path), "private preimages must be outside candidate and evidence trees");
  }
  await chmod(path, 0o700);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o700, "private preimage directory permissions are not 0700");
  context.privateDirectory = path;
}

export async function atomicExclusiveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600, flush: true });
  try { await link(temporary, path); } finally { await unlink(temporary); }
}

async function referenceImageId(context, reference) {
  const ids = String(await context.command("docker", ["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${reference}`], context.environment)).split(/\s+/u).filter(Boolean);
  assert.ok(ids.length <= 1, "ambiguous mutable image reference");
  if (!ids.length) return null;
  assert.match(ids[0], /^sha256:[0-9a-f]{64}$/u);
  return ids[0];
}

export async function writeArtifactState(context, manifest) {
  const path = artifactPath(context), temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600, flush: true });
  await rename(temporary, path);
}

export async function dockerIdentity(context) {
  const host = JSON.parse(await context.command("docker", ["info", "--format", "{{json .}}"], context.environment));
  assert.ok(host.ID && host.Name && isAbsolute(host.DockerRootDir), "Docker host identity unavailable");
  return { id: host.ID, name: host.Name, dataRoot: host.DockerRootDir };
}

export async function inspectOwned(context) {
  const ids = (await context.command("docker", ["ps", "-aq", "--filter",
    `label=com.docker.compose.project=${context.project}`], context.environment)).split(/\s+/u).filter(Boolean);
  if (!ids.length) return [];
  const rows = JSON.parse(await context.command("docker", ["inspect", ...ids], context.environment));
  assert.equal(rows.length, ids.length, "incomplete container census");
  const services = new Set();
  for (const row of rows) {
    assert.match(row.Id, /^[0-9a-f]{64}$/u); assert.match(row.Image, /^sha256:[0-9a-f]{64}$/u);
    const labels = row.Config?.Labels;
    assert.equal(labels?.["com.docker.compose.project"], context.project, "container ownership changed");
    const service = labels["com.docker.compose.service"];
    assert.ok(service && !services.has(service), "ambiguous service preimage"); services.add(service);
  }
  return rows.sort((a, b) => a.Id.localeCompare(b.Id));
}

export function resolveComposeServiceReferences(service, rows = [], project) {
  const resolved = structuredClone(service), references = {};
  const container = (name, field) => {
    const matches = rows.filter((row) => row.Config?.Labels?.["com.docker.compose.project"] === project &&
      row.Config.Labels["com.docker.compose.service"] === name);
    if (matches.length !== 1 || !/^[0-9a-f]{64}$/u.test(matches[0].Id)) refuse([field], "service reference missing or ambiguous in owned census");
    references[field] = { service: name, containerId: matches[0].Id };
    return matches[0].Id;
  };
  for (const field of ["network_mode", "ipc", "pid"]) {
    if (service[field]?.startsWith("service:")) resolved[field] = `container:${container(service[field].slice(8), field)}`;
  }
  if (service.volumes_from?.length) resolved.volumes_from = service.volumes_from.map((value, index) => {
    const parts = value.split(":");
    // Compose v2.40.3 resolveVolumeFrom hashes bare IDs/names, without the mode suffix.
    if (parts[0] === "container") return parts[1];
    return container(parts[0], `volumes_from.${index}`);
  });
  return { service: resolved, references };
}

export async function composeServiceHash(context, compose, name, rows) {
  if (process.platform !== "win32") assert.equal(process.getuid(), 0, "private Compose hash inputs require root");
  const model = structuredClone(compose.rendered);
  const service = model.services?.[name];
  assert.ok(service, "original rendered service unavailable");
  // These optional runtime injections require provider/credential state, not a guessed replay.
  if (service.use_api_socket) refuse([`${name}.use_api_socket`], "unsupported pre-hash runtime injection");
  if (Object.keys(service.models ?? {}).length) refuse([`${name}.models`], "unsupported pre-hash runtime injection");
  const resolved = resolveComposeServiceReferences(service, rows, context.project);
  model.services[name] = resolved.service;
  // The loader treats bare volumes_from IDs as dependencies, even with --no-consistency.
  for (const reference of resolved.service.volumes_from ?? []) model.services[reference] ??= { image: "scratch" };
  const directory = await mkdtemp(resolve(tmpdir(), "wasalx-compose-hash-"));
  try {
    for (const forbidden of [context.repository, context.directory].filter(Boolean)) {
      assert.ok(!isWithin(await realpath(forbidden), await realpath(directory)), "private hash inputs must be outside candidate and evidence trees");
    }
    await chmod(directory, 0o700);
    const path = resolve(directory, "resolved.json");
    await writeFile(path, JSON.stringify(model), { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    const arguments_ = [];
    for (let i = 0; i < compose.arguments_.length; i++) {
      if (compose.arguments_[i] === "--file") { i++; continue; }
      arguments_.push(compose.arguments_[i]);
    }
    // Compose's rendered JSON escapes dollars; reload it once using the upstream hash function.
    const output = await context.command("docker", [...arguments_, "--file", path, "config",
      "--no-normalize", "--no-consistency", "--hash", name], compose.environment);
    const hash = String(output).trim().split(/\s+/u);
    assert.ok(hash.length === 2 && hash[0] === name && /^[0-9a-f]{64}$/u.test(hash[1]), "invalid Compose service hash");
    return { hash: hash[1], references: resolved.references };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function composePreimage(row, context, image, version, rows) {
  const labels = row.Config.Labels;
  const workingDirectory = labels["com.docker.compose.project.working_dir"];
  const files = labels["com.docker.compose.project.config_files"]?.split(",");
  assert.ok(isAbsolute(workingDirectory ?? "") && files?.length, "actual ordered Compose chain unavailable");
  const capture = async (path) => {
    assert.ok(isAbsolute(path), "Compose preimage path must be absolute");
    assert.ok(!isWithin(await realpath(context.repository), await realpath(path)), "deployed Compose inputs resolve inside candidate repository");
    const bytes = await readFile(path);
    return { path, sha256: sha256(bytes) };
  };
  assert.ok(!isWithin(await realpath(context.repository), await realpath(workingDirectory)), "deployed Compose working directory resolves inside candidate repository");
  const environmentFiles = labels["com.docker.compose.project.environment_file"]?.split(",") ?? [];
  const inputs = await Promise.all(files.map(capture));
  const environments = await Promise.all(environmentFiles.map(capture));
  // Without --env-file Compose can read implicit .env. Retain it when present.
  if (!environmentFiles.length) {
    try { environments.push(await capture(resolve(workingDirectory, ".env"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const arguments_ = ["compose", "--project-directory", workingDirectory,
    ...environmentFiles.flatMap((path) => ["--env-file", path]),
    ...files.flatMap((path) => ["--file", path]), ...composeProfiles.flatMap((profile) => ["--profile", profile]),
    "--project-name", context.project];
  const service = labels["com.docker.compose.service"];
  if (version.match(/^v?(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.~_-]+)?$/u)?.[1] !== labels["com.docker.compose.version"]) {
    refuse([`${service}.compose.version`], "original Compose version changed");
  }
  const environment = Object.fromEntries((row.Config.Env ?? []).map((entry) => {
    const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)];
  }).filter(([key]) => !["PATH", "HOME"].includes(key) && !/^(DOCKER_|COMPOSE_)/u.test(key)));
  Object.assign(environment, Object.fromEntries(Object.entries(context.environment).filter(([key]) =>
    ["PATH", "HOME", "USER", "SystemRoot"].includes(key) || /^(DOCKER_|COMPOSE_)/u.test(key))));
  const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
  const tree = image.Config?.Labels?.["io.wasalx.source.tree"];
  if (revision) Object.assign(environment, { COMMIT_SHA: revision, WASALX_CANDIDATE_SHA: revision });
  if (tree) environment.WASALX_CANDIDATE_TREE = tree;
  const unresolved = JSON.parse(await context.command("docker", [...arguments_, "config", "--no-interpolate", "--no-env-resolution", "--format", "json"], environment));
  const serviceEnvironmentFiles = await Promise.all((unresolved.services?.[service]?.env_file ?? []).map(async (entry) => {
    const path = typeof entry === "string" ? entry : entry.path;
    if (path.includes("$")) refuse([`${service}.env_file`], "cannot bind an interpolated service env_file path");
    try { return await capture(path); }
    catch (error) {
      if (error.code !== "ENOENT" || entry.required !== false) throw error;
      assert.ok(isAbsolute(path) && !isWithin(await realpath(context.repository), path), "invalid optional env_file path");
      return { path, sha256: null };
    }
  }));
  const rendered = JSON.parse(await context.command("docker", [...arguments_, "config", "--format", "json"], environment));
  assert.ok(rendered.services?.[service], "original rendered service unavailable");
  const { hash, references } = await composeServiceHash(context, { arguments_, rendered, environment }, service, rows);
  if (hash !== labels["com.docker.compose.config-hash"]) {
    const families = [...new Set(Object.keys(references).map((field) => field.split(".")[0]))];
    refuse([`${service}.compose.config-hash`, ...families.map((field) => `${service}.${field}`)], "actual Compose chain changed");
  }
  for (const input of [...inputs, ...environments, ...serviceEnvironmentFiles]) {
    assert.equal(await fileDigest(input.path), input.sha256, "Compose input changed during capture");
  }
  return { workingDirectory, files: inputs, environmentFiles: environments, arguments_, rendered, environment,
    version, serviceReferences: references, serviceEnvironmentFiles };
}

export async function preserveReplacement(context) {
  await mkdir(context.directory, { recursive: true, mode: 0o700 });
  await preparePrivateDirectory(context);
  let snapshot;
  try { snapshot = JSON.parse(await readFile(preimagePath(context), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const host = await dockerIdentity(context), rows = await inspectOwned(context);
    const version = await context.command("docker", ["compose", "version", "--short"], context.environment);
    const containers = [];
    for (const row of rows) {
      assert.ok(row.HostConfig && Array.isArray(row.Mounts), "complete private container preimage unavailable");
      const images = JSON.parse(await context.command("docker", ["image", "inspect", row.Image], context.environment));
      assert.equal(images[0]?.Id, row.Image, "old image preimage unavailable");
      containers.push({ id: row.Id, image: row.Image, service: row.Config.Labels["com.docker.compose.service"],
        running: row.State.Running, exitCode: row.State.ExitCode, inspect: row, imageInspect: images[0],
        rollbackTag: rollbackTag(context.project, row.Id),
        rootfsChanges: String(await context.command("docker", ["diff", row.Id], context.environment)).trim(),
        networks: await Promise.all(Object.keys(row.NetworkSettings?.Networks ?? {}).map(async (name) => ({ name,
          inspect: JSON.parse(await context.command("docker", ["network", "inspect", name], context.environment))[0] }))),
        compose: await composePreimage(row, context, images[0], version, rows) });
    }
    assert.deepEqual((await inspectOwned(context)).map(devContainerPreimage), rows.map(devContainerPreimage), "container census changed during capture");
    const buildTags = [];
    for (const image of context.plan) {
      const oldImageId = await referenceImageId(context, image.reference);
      buildTags.push({ reference: image.reference, image: oldImageId,
        rollbackTag: oldImageId ? containers.find((old) => old.image === oldImageId)?.rollbackTag ?? rollbackTag(context.project, `image-${oldImageId.slice(7)}`) : null });
    }
    snapshot = { schemaVersion: 1, kind: "compose-replacement-preimage", transactionId: randomUUID(),
      candidateSha: context.candidateSha, candidateTree: context.candidateTree, project: context.project,
      host, observedAt: new Date().toISOString(), containers, buildTags,
      rollbackObservation: await observeRollbackState(context, rows) };
    await atomicExclusiveJson(preimagePath(context), snapshot);
  }
  await assertSnapshotHeader(context, snapshot);
  await assertRetainedPreimage(context, snapshot);
  for (const container of snapshot.containers) {
    assert.equal(container.id, container.inspect.Id); assert.equal(container.image, container.inspect.Image);
    assert.equal(container.rollbackTag, rollbackTag(context.project, container.id));
    await context.command("docker", ["image", "tag", container.image, container.rollbackTag], context.environment);
  }
  for (const image of snapshot.buildTags) if (image.image) await context.command("docker", ["image", "tag", image.image, image.rollbackTag], context.environment);
  return { snapshot, sha256: sha256(await readFile(preimagePath(context))) };
}

async function assertSnapshotHeader(context, snapshot) {
  assert.equal(snapshot.schemaVersion, 1, "legacy rollback inventory lacks exact preimages");
  assert.equal(snapshot.kind, "compose-replacement-preimage");
  assert.ok(Array.isArray(snapshot.buildTags), "mutable build-tag preimage unavailable");
  assert.deepEqual(snapshot.buildTags.map(({ reference }) => reference), context.plan.map(({ reference }) => reference), "mutable build-tag inventory changed");
  for (const old of snapshot.containers) {
    assert.equal(old.id, old.inspect.Id); assert.equal(old.image, old.inspect.Image);
    assert.equal(old.service, old.inspect.Config.Labels["com.docker.compose.service"]);
    assert.equal(old.inspect.Config.Labels["com.docker.compose.project"], context.project);
    assert.equal(old.rollbackTag, rollbackTag(context.project, old.id));
  }
  for (const image of snapshot.buildTags) {
    if (image.image === null) assert.equal(image.rollbackTag, null);
    else {
      assert.match(image.image, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(image.rollbackTag, snapshot.containers.find((old) => old.image === image.image)?.rollbackTag ?? rollbackTag(context.project, `image-${image.image.slice(7)}`));
    }
  }
  for (const key of ["candidateSha", "candidateTree", "project"]) assert.equal(snapshot[key], context[key], `${key} preimage binding changed`);
  assert.deepEqual(snapshot.host, await dockerIdentity(context), "Docker host changed");
}

export async function readBoundArtifacts(context, { allowPartial = false } = {}) {
  const manifest = JSON.parse(await readFile(artifactPath(context), "utf8"));
  const hosted = context.hostedImages ? await readHostedInventory(context) : null;
  assert.equal(manifest.kind, hosted ? "compose-hosted-image-admission" : "compose-candidate-artifacts"); assert.equal(manifest.schemaVersion, 1);
  assert.ok((allowPartial ? ["PASS", "BUILDING", "FAILED"] : ["PASS"]).includes(manifest.state), "candidate artifact build is incomplete");
  for (const key of ["candidateSha", "candidateTree", "project", hosted ? "hostedImagesSha256" : "buildContextSha256", "catalogSha256"]) {
    assert.ok(context[key], `${key} binding unavailable`); assert.equal(manifest[key], context[key], `${key} binding changed`);
  }
  assert.equal(manifest.modelSha256, devValueDigest(context.model), "Compose candidate model changed");
  assert.deepEqual(manifest.plan, context.plan, "candidate plan changed");
  if (hosted) {
    assert.equal(manifest.state, "PASS");
    assert.equal(manifest.publisher, hosted.publisher); assert.equal(manifest.issuer, hostedIssuer);
    assert.equal(manifest.trustedRootSha256, sha256(await readFile(context.hostedTrustedRoot)), "hosted trust root changed");
    assert.equal(manifest.buildContextAlgorithm, undefined, "hosted admission is not a local build receipt");
  } else assert.equal(manifest.buildContextAlgorithm, "sha256-git-archive-tar-v1");
  assert.deepEqual(manifest.images.map(({ id, dockerfile, reference }) => ({ id, dockerfile, reference })), context.plan,
    "candidate artifact map changed");
  for (const image of manifest.images) {
    assert.deepEqual(image.services, imageServices(context.model, image.dockerfile), "candidate service/image binding changed");
    if (hosted) {
      const row = hosted.images[image.id];
      assert.equal(image.state, "ADMITTED", "hosted image admission is incomplete");
      assert.equal(image.sourceReference, row.pullReference); assert.equal(image.manifestDigest, row.digest);
      assert.equal(image.configDigest, row.configDigest);
      assert.ok([row.digest, row.configDigest].includes(image.imageId), "hosted immutable image mismatch");
      for (const key of ["signatureSha256", "attestationSha256"]) assert.match(image[key] ?? "", /^[0-9a-f]{64}$/u);
    } else assert.ok((allowPartial ? ["PENDING", "BUILT", "REUSED", "FAILED"] : ["BUILT", "REUSED"]).includes(image.state), "candidate image build is incomplete");
    if (image.imageId !== null) assert.match(image.imageId, /^sha256:[0-9a-f]{64}$/u);
    else assert.ok(allowPartial, "candidate immutable image missing");
  }
  const bytes = await readFile(preimagePath(context));
  assert.equal(manifest.preimage.sha256, sha256(bytes), "replacement preimage changed");
  const snapshot = JSON.parse(bytes);
  assert.equal(manifest.preimage.transactionId, snapshot.transactionId);
  await assertSnapshotHeader(context, snapshot);
  return { manifest, snapshot };
}

export async function assertRetainedPreimage(context, snapshot) {
  const rows = await inspectOwned(context);
  assert.equal(rows.length, snapshot.containers.length, "preimage container inventory changed");
  for (const old of snapshot.containers) {
    const row = rows.find(({ Id }) => Id === old.id);
    assert.ok(row, "original container preimage changed"); assert.equal(row.Image, old.image);
    for (const key of ["Name", "Config", "HostConfig", "Mounts"]) {
      let current = row[key], retained = old.inspect[key];
      if (key === "Mounts") {
        // Docker inspect can return unchanged mounts in a different order.
        const byDestination = (a, b) => a.Destination.localeCompare(b.Destination)
          || (a.Source ?? "").localeCompare(b.Source ?? "") || a.Type.localeCompare(b.Type);
        current = current.toSorted(byDestination); retained = retained.toSorted(byDestination);
      }
      assert.deepEqual(current, retained, `${key} preimage changed`);
    }
    for (const input of [...old.compose.files, ...old.compose.environmentFiles, ...old.compose.serviceEnvironmentFiles ?? []]) {
      assert.equal(await fileDigest(input.path), input.sha256, "original Compose input changed");
    }
    await assertPreservedNetworks(context, old, row);
  }
  return rows;
}

// Starting Compose can migrate or write protected state even when it returns an error.
export async function fenceReplacementEffects(context, transactionId, migrationStarted = false) {
  const path = rollbackStatePath(context, "replacement-effects");
  try { await writeFile(path,
    `${JSON.stringify({ transactionId, state: "UNKNOWN", migrations: migrationStarted ? "STARTED" : "UNKNOWN", protectedWrites: "UNKNOWN" })}\n`,
    { flag: "wx", mode: 0o600, flush: true }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(path, "utf8"));
    assert.equal(previous.transactionId, transactionId, "effect fence transaction changed");
    if (migrationStarted && previous.migrations !== "STARTED") {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ...previous, migrations: "STARTED" })}\n`, { flag: "wx", mode: 0o600, flush: true });
      await rename(temporary, path);
    }
  }
}

export function firstDifference(expected, actual, field) {
  if (devValueDigest(expected ?? null) === devValueDigest(actual ?? null)) return null;
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(key in expected) || !(key in actual)) return `${field}.${key}`;
      const difference = firstDifference(expected[key], actual[key], `${field}.${key}`);
      if (difference) return difference;
    }
  }
  return field;
}

function refuse(fields, message = "exact rollback refused") {
  const error = new Error(`${message}: ${fields.join(", ")}`);
  error.rollbackFields = fields;
  throw error;
}

function assertContainerFields(old, row, resolved) {
  if (!row) refuse([`${old.service}.container`]);
  for (const key of ["Name", "Config", "HostConfig", "Mounts"]) {
    const expected = structuredClone(old.inspect[key]);
    if (key === "Config" && expected.Hostname === old.id.slice(0, 12) && !old.compose.rendered.services[old.service].hostname) {
      expected.Hostname = row.Id.slice(0, 12);
    }
    if (resolved && key === "Config") expected.Labels["com.docker.compose.config-hash"] = resolved.hash;
    if (resolved && key === "HostConfig") {
      for (const [field, hostField] of [["network_mode", "NetworkMode"], ["ipc", "IpcMode"], ["pid", "PidMode"]]) {
        if (resolved.references[field]) expected[hostField] = `container:${resolved.references[field].containerId}`;
      }
    }
    const byDestination = (a, b) => a.Destination.localeCompare(b.Destination)
      || (a.Source ?? "").localeCompare(b.Source ?? "") || a.Type.localeCompare(b.Type);
    const difference = firstDifference(key === "Mounts" ? expected.toSorted(byDestination) : expected,
      key === "Mounts" ? row[key].toSorted(byDestination) : row[key], `${old.service}.${key}`);
    if (difference) refuse([difference]);
  }
  assert.equal(row.Image, old.image, "original immutable image changed");
}

async function assertRestoredContainer(context, old, row, rows) {
  const symbolic = old.compose.rendered.services[old.service];
  const { references } = resolveComposeServiceReferences(symbolic, rows, context.project);
  if (row?.Id === old.id) {
    const original = old.compose.serviceReferences ?? {};
    for (const [field, reference] of Object.entries(references)) {
      if (original[field]?.containerId !== reference.containerId) refuse([`${old.service}.${field}`], "retained container has a stale service reference");
    }
    return assertContainerFields(old, row);
  }
  const resolved = Object.keys(references).length ? await composeServiceHash(context, old.compose, old.service, rows) : undefined;
  assertContainerFields(old, row, resolved);
}

function orderRecreations(snapshot, services) {
  const ordered = [], visiting = new Set();
  const visit = (name) => {
    if (ordered.includes(name)) return;
    assert.ok(!visiting.has(name), "cyclic rollback service references");
    visiting.add(name);
    const old = snapshot.containers.find((entry) => entry.service === name);
    for (const reference of Object.values(old.compose.serviceReferences ?? {})) {
      if (services.includes(reference.service)) visit(reference.service);
    }
    visiting.delete(name); ordered.push(name);
  };
  services.forEach(visit);
  return ordered;
}

async function assertPreservedNetworks(context, old, row) {
  const endpoints = old.inspect.NetworkSettings?.Networks ?? {}, current = row.NetworkSettings?.Networks ?? {};
  assert.deepEqual(Object.keys(current).sort(), Object.keys(endpoints).sort(), `${old.service} attached networks changed`);
  assert.ok(Array.isArray(old.networks) && old.networks.length === Object.keys(endpoints).length, `${old.service} network preimages unavailable`);
  for (const { name, inspect } of old.networks) {
    const network = JSON.parse(await context.command("docker", ["network", "inspect", name], context.environment))[0];
    const topology = ({ ...settings }) => {
      delete settings.Containers;
      return settings;
    };
    assert.deepEqual(topology(network), topology(inspect), `${old.service}.${name} network changed`);
    assert.ok(!current[name].NetworkID || current[name].NetworkID === inspect.Id, `${old.service}.${name} network ID changed`);
    // Endpoint IDs, assigned addresses and DNS names are runtime identities; retain every configured setting.
    const settings = (endpoint, identifier) => Object.fromEntries(Object.entries(endpoint).filter(([key]) =>
      !["NetworkID", "EndpointID", "Gateway", "IPAddress", "IPPrefixLen", "IPv6Gateway", "GlobalIPv6Address", "GlobalIPv6PrefixLen", "MacAddress", "DNSNames"].includes(key))
      .map(([key, value]) => [key, key === "Aliases" && Array.isArray(value) ? value.map((alias) => alias === identifier.slice(0, 12) ? "<container-id>" : alias) : value]));
    const difference = firstDifference(settings(endpoints[name], old.id), settings(current[name], row.Id), `${old.service}.NetworkSettings.Networks.${name}`);
    if (difference) refuse([difference]);
    const model = old.compose.rendered.services[old.service];
    const configuredNetwork = Object.entries(model.networks ?? {}).find(([key]) =>
      (old.compose.rendered.networks?.[key]?.name ?? key) === name)?.[1];
    if (model.mac_address || configuredNetwork?.mac_address) {
      assert.equal(current[name].MacAddress, endpoints[name].MacAddress, `${old.service}.${name} configured MAC changed`);
    }
  }
}

export function recreateRefusals(old) {
  const fields = [], service = old.compose.rendered?.services?.[old.service];
  if (!service) return [`${old.service}.compose.rendered`];
  if (old.rootfsChanges !== "") fields.push(`${old.service}.RootFS`);
  for (const [field, key] of [["Hostname", "hostname"], ["Domainname", "domainname"]]) {
    if (field === "Hostname" && !service.hostname && old.inspect.Config.Hostname === old.id.slice(0, 12)) continue;
    if ((old.inspect.Config[field] ?? "") !== (service[key] ?? "")) fields.push(`${old.service}.Config.${field}`);
  }
  if (old.inspect.Config.Labels["com.docker.compose.replace"]) fields.push(`${old.service}.Config.Labels.com.docker.compose.replace`);
  for (const key of ["ContainerIDFile", "Links", "VolumesFrom", "Devices", "DeviceRequests", "Tmpfs"]) {
    const value = old.inspect.HostConfig[key];
    if (value && (typeof value !== "object" || Object.keys(value).length)) fields.push(`${old.service}.HostConfig.${key}`);
  }
  if (/^(container:|host$)/u.test(old.inspect.HostConfig.NetworkMode ?? "") &&
      !old.compose.serviceReferences?.network_mode) fields.push(`${old.service}.HostConfig.NetworkMode`);
  for (const mount of old.inspect.Mounts) {
    const model = (service.volumes ?? []).find((entry) => entry.target === mount.Destination);
    if (!model?.source || !["bind", "volume"].includes(mount.Type)) fields.push(`${old.service}.Mounts.${mount.Destination}.Source`);
    if (mount.Type === "volume" && model?.volume?.nocopy !== true) fields.push(`${old.service}.Mounts.${mount.Destination}.volume.nocopy`);
  }
  return fields;
}

export async function rollbackReplacement(context) {
  assert.ok(context.drained, "rollback requires --drained after current effect reconciliation");
  await preparePrivateDirectory(context);
  const { manifest, snapshot } = await readBoundArtifacts(context, { allowPartial: true });
  const effects = await readOptionalState(context, "replacement-effects");
  const postimage = await readOptionalState(context, "replacement-after");
  const tagOnly = manifest.state !== "PASS" && !effects;
  assert.ok(manifest.state === "PASS" || tagOnly, "incomplete build with replacement effects requires reconciliation");
  const rows = await inspectOwned(context);
  assertRollbackInventory(snapshot, rows, postimage);
  let safety;
  if (effects) {
    const suppliedBytes = context.rollbackSafetyFile ? await readFile(context.rollbackSafetyFile) : null;
    safety = await produceRollbackSafety(context, manifest, snapshot, rows);
    if (suppliedBytes) {
      assert.equal(sha256(suppliedBytes), context.rollbackSafetySha256, "rollback safety receipt changed");
      const supplied = JSON.parse(suppliedBytes);
      assert.equal(supplied.schemaVersion, 2, "machine-produced rollback safety receipt required");
      assert.equal(supplied.state, "CLEAR", "rollback safety is unknown");
      const age = Date.now() - Date.parse(supplied.observedAt);
      assert.ok(age >= 0 && age <= 60_000, "rollback safety receipt is stale");
      for (const key of ["producer", "candidateSha", "candidateTree", "project", "host", "transactionId", "preimageSha256", "migrations", "protectedWrites", "observation"]) {
        assert.deepEqual(supplied[key], safety[key], `rollback safety ${key} changed`);
      }
    }
    if (safety.migrations !== "NONE") refuse(["migrationLedger"], "post-preimage migrations prevent image rollback");
    if (safety.protectedWrites !== "NONE") refuse(safety.unknownFields.length ? safety.unknownFields : ["protectedWrites"], "protected writes unknown or observed");
  }
  if (!effects) await assertRetainedPreimage(context, snapshot);
  const targets = effects ? postimage.targets : snapshot.containers.map(({ service }) => service);
  assert.ok(Array.isArray(targets) && targets.every((name) => snapshot.containers.some((old) => old.service === name)), "unowned rollback target");
  const recreate = [], restart = [], references = new Map(snapshot.buildTags.map((entry) => [entry.reference, entry.image]));
  for (const old of snapshot.containers) {
    const row = rows.find((entry) => entry.Config.Labels["com.docker.compose.service"] === old.service);
    if (!targets.includes(old.service) || row?.Id === old.id) {
      await assertRestoredContainer(context, old, row, rows);
      assert.equal(row.State.StartedAt, old.inspect.State.StartedAt, "old container executed after its preimage");
      assert.ok(!row.State.Paused && !row.State.Dead && !row.State.Restarting, "unsafe original container state");
      assert.ok(!row.State.Running || old.running, "held container was started");
      if (old.running && !row.State.Running) {
        assert.notEqual(row.State.ExitCode, 137, "force-killed original requires reconciliation");
        assert.ok(!row.State.OOMKilled, "OOM-killed original requires reconciliation"); restart.push(old.service);
      }
    } else {
      const fields = recreateRefusals(old);
      if (fields.length) refuse(fields);
      assert.equal(await context.command("docker", ["compose", "version", "--short"], context.environment), old.compose.version, "original Compose version changed");
      recreate.push(old.service);
    }
    await assertPreservedNetworks(context, old, recreate.includes(old.service) ? old.inspect : row);
    for (const input of [...old.compose.files, ...old.compose.environmentFiles, ...old.compose.serviceEnvironmentFiles ?? []]) {
      assert.equal(await fileDigest(input.path), input.sha256, "original Compose input changed");
    }
    const image = JSON.parse(await context.command("docker", ["image", "inspect", old.rollbackTag], context.environment))[0];
    assert.equal(image?.Id, old.image, "rollback tag changed");
    const reference = old.inspect.Config.Image;
    assert.ok(typeof reference === "string" && reference, "original image reference unavailable");
    assert.ok(!references.has(reference) || references.get(reference) === null || references.get(reference) === old.image, "conflicting original image references");
    if (!references.has(reference)) references.set(reference, old.image);
  }
  for (const [reference, oldImage] of references) {
    const current = await referenceImageId(context, reference);
    if (current === null) continue;
    const image = JSON.parse(await context.command("docker", ["image", "inspect", reference], context.environment))[0];
    const labels = image?.Config?.Labels;
    assert.ok(image && (image.Id === oldImage || manifest.images.some((entry) => entry.reference === reference && entry.imageId === image.Id) ||
      (tagOnly && labels?.["org.opencontainers.image.revision"] === context.candidateSha && labels?.["io.wasalx.source.tree"] === context.candidateTree)),
    "image reference moved outside this transaction");
  }
  for (const image of snapshot.buildTags.filter((entry) => entry.image)) {
    const details = JSON.parse(await context.command("docker", ["image", "inspect", image.rollbackTag], context.environment))[0];
    assert.equal(details?.Id, image.image, "mutable build rollback tag changed");
  }
  const recreationOrder = orderRecreations(snapshot, recreate);
  await atomicExclusiveJson(rollbackStatePath(context, "rollback-started"), {
    transactionId: snapshot.transactionId, preimageSha256: manifest.preimage.sha256, tagOnly, recreate, restart });
  for (const old of snapshot.containers) {
    const reference = old.inspect.Config.Image;
    if (reference !== old.image && !reference.includes("@sha256:")) await context.command("docker", ["image", "tag", old.rollbackTag, reference], context.environment);
  }
  for (const image of snapshot.buildTags) {
    if (image.image) await context.command("docker", ["image", "tag", image.rollbackTag, image.reference], context.environment);
  }
  for (const service of recreationOrder) {
    const old = snapshot.containers.find((entry) => entry.service === service);
    const candidate = rows.find((entry) => entry.Config.Labels["com.docker.compose.service"] === service);
    if (candidate) {
      if (candidate.State.Running) assert.equal(await context.command("docker", ["stop", "--time", "60", candidate.Id], context.environment, true), 0, "candidate stop failed");
      const stopped = (await inspectOwned(context)).find((entry) => entry.Id === candidate.Id);
      assert.ok(stopped && !stopped.State.Running && stopped.State.ExitCode !== 137, "candidate did not drain cleanly");
      assert.equal(await context.command("docker", ["rm", candidate.Id], context.environment, true), 0, "candidate removal failed");
    }
    assert.equal(await context.command("docker", [...old.compose.arguments_, "up", "--no-start", "--no-deps", "--no-build", "--pull", "never", service], old.compose.environment, true), 0, "original container creation failed");
    const current = await inspectOwned(context);
    const created = current.find((entry) => entry.Config.Labels["com.docker.compose.service"] === service);
    await assertRestoredContainer(context, old, created, current);
    await assertPreservedNetworks(context, old, created);
    assert.equal(created.State.Running, false, "recreated container started before exact verification");
    if (old.running) restart.push(service);
  }
  for (const image of snapshot.buildTags.filter((entry) => !entry.image)) {
    if (await referenceImageId(context, image.reference)) {
      assert.equal(await context.command("docker", ["image", "rm", image.reference], context.environment, true), 0, "owned build tag removal failed");
    }
  }
  for (const image of snapshot.buildTags) assert.equal(await referenceImageId(context, image.reference), image.image, "mutable image reference restoration failed");
  // Start the exact verified residents only; smoke owns health and dependency qualification.
  for (const service of restart) {
    const row = (await inspectOwned(context)).find((entry) => entry.Config.Labels["com.docker.compose.service"] === service);
    await assertPreservedNetworks(context, snapshot.containers.find((old) => old.service === service), row);
    assert.equal(await context.command("docker", ["start", row.Id], context.environment, true), 0, "original container restart failed");
  }
  const after = await inspectOwned(context);
  const restored = [];
  for (const old of snapshot.containers) {
    const row = after.find((entry) => entry.Config.Labels["com.docker.compose.service"] === old.service);
    await assertRestoredContainer(context, old, row, after);
    assert.equal(row.State.Running, old.running);
    restored.push({ service: old.service, originalId: old.id, restoredId: row.Id, image: row.Image });
  }
  await atomicExclusiveJson(resolve(context.directory, `rollback-complete-${context.project}.json`), {
    transactionId: snapshot.transactionId, preimageSha256: manifest.preimage.sha256,
    state: !effects && !restart.length ? "TAGS_RESTORED" : "REQUIRES_SMOKE", requiresSmoke: Boolean(effects || restart.length), containers: restored });
  return 0;
}
