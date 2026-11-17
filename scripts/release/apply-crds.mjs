#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const kubectl = process.env.KUBECTL ?? "kubectl";
const fieldManager = "wasalx-commercial-go";
const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const expectedContractIdentities = [
  ["tenantworkspaces.platform.wasalx.io", "tenantworkspaces.platform.wasalx.io", "platform.wasalx.io/v1alpha1", "TenantWorkspaceList", "infra/helm/wasalx/crds/platform.wasalx.io_tenantworkspaces.yaml"],
  ["workspaceproviderresources.providers.wasalx.io", "workspaceproviderresources.providers.wasalx.io", "providers.wasalx.io/v1alpha1", "WorkspaceProviderResourceList", "infra/helm/wasalx/crds/providers.wasalx.io_workspaceproviderresources.yaml"],
];

const fail = (message) => { throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  return value;
};
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const projectionHash = (document) => {
  const spec = object(document.spec, "CRD spec");
  if (spec.preserveUnknownFields !== undefined && spec.preserveUnknownFields !== false) {
    fail("CRD preserveUnknownFields must be absent or false");
  }
  if (spec.conversion !== undefined && (
    !spec.conversion || spec.conversion.strategy !== "None" || Object.keys(spec.conversion).length !== 1
  )) fail("CRD conversion must be absent or the native None strategy");
  return hash(JSON.stringify(canonical({
    group: spec.group,
    scope: spec.scope,
    names: spec.names,
    versions: spec.versions,
  })));
};

const parseArguments = (values) => {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || result[key.slice(2)] !== undefined) {
      fail(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
};

const arguments_ = parseArguments(process.argv.slice(2));
const required = (name) => arguments_[name] || fail(`--${name} is required`);
const context = required("context");
const candidateSha = required("candidate-sha");
const candidateTree = required("candidate-tree");
if (!shaPattern.test(candidateSha) || !shaPattern.test(candidateTree)) fail("candidate SHA and tree must be exact 40-character Git object IDs");
if (context.length > 253 || /[\p{Cc}\p{Cf}]/u.test(context)) fail("the Kubernetes context is invalid");

const run = async (commandArguments, acceptedCodes = [0]) => {
  try {
    const result = await execFile(kubectl, [`--context=${context}`, ...commandArguments, "--request-timeout=30s"], { maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (acceptedCodes.includes(error.code)) return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    fail(`kubectl ${commandArguments[0]} failed (${error.code ?? "unknown"}): ${String(error.stderr ?? error.message).trim()}`);
  }
};

const git = async (...commandArguments) => (await execFile("git", commandArguments, { cwd: repository })).stdout.trim();

const loadContracts = async () => {
  const manifest = JSON.parse(await readFile(resolve(repository, "release/crd-contract.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.contracts) || manifest.contracts.length !== 2) {
    fail("the CRD contract manifest is invalid");
  }
  const contracts = await Promise.all(manifest.contracts.map(async (entry) => {
    object(entry, "CRD contract entry");
    if (!entry.name || !entry.resource || !entry.apiVersion || !entry.listKind ||
        !/^infra\/helm\/wasalx\/crds\/[a-z0-9._-]+\.yaml$/u.test(entry.source) ||
        !digestPattern.test(entry.sourceSha256) || !digestPattern.test(entry.projectionSha256)) {
      fail("the CRD contract manifest entry is invalid");
    }
    const file = resolve(repository, entry.source);
    if (hash(await readFile(file)) !== entry.sourceSha256) fail(`${entry.name} source does not match the frozen CRD contract`);
    return { ...entry, file };
  }));
  const identities = contracts.map(({ name, resource, apiVersion, listKind, source }) => [name, resource, apiVersion, listKind, source]);
  if (JSON.stringify(identities) !== JSON.stringify(expectedContractIdentities)) fail("the CRD contract manifest identities are invalid");
  return contracts;
};

const parseJson = (value, label) => {
  try { return JSON.parse(value); }
  catch { fail(`kubectl returned invalid JSON for ${label}`); }
};

const listCount = async ({ resource, apiVersion, listKind }) => {
  const [group, version, ...rest] = apiVersion.split("/");
  const plural = resource.slice(0, resource.indexOf("."));
  if (rest.length || !/^[a-z0-9.-]+$/u.test(group) || !/^[a-z0-9]+$/u.test(version) ||
      !/^[a-z0-9]+$/u.test(plural) || resource !== `${plural}.${group}`) fail("the CRD inventory contract is invalid");
  const document = parseJson((await run(["get", `--raw=/apis/${group}/${version}/${plural}?limit=1`])).stdout, resource);
  const continuation = document.metadata?.continue;
  if (document.apiVersion !== apiVersion || document.kind !== listKind || !Array.isArray(document.items) ||
      (continuation !== undefined && typeof continuation !== "string") || (!document.items.length && continuation)) {
    fail(`kubectl returned an invalid or incomplete ${resource} list`);
  }
  return document.items.length;
};

const liveContract = async (entry) => {
  const document = parseJson((await run(["get", "crd", entry.name, "-o", "json"])).stdout, entry.name);
  const metadata = object(document.metadata, `${entry.name} metadata`);
  const status = object(document.status, `${entry.name} status`);
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const accepted = (type) => conditions.some((condition) => condition?.type === type && condition.status === "True");
  const liveHash = projectionHash(document);
  if (document.apiVersion !== "apiextensions.k8s.io/v1" || document.kind !== "CustomResourceDefinition" ||
      metadata.name !== entry.name || metadata.deletionTimestamp !== undefined ||
      metadata.annotations?.["wasalx.io/contract-version"] !== "commercial-go-v1" ||
      metadata.annotations?.["wasalx.io/contract-sha256"] !== entry.projectionSha256 ||
      liveHash !== entry.projectionSha256 || !accepted("Established") || !accepted("NamesAccepted") ||
      JSON.stringify(status.storedVersions) !== JSON.stringify(["v1alpha1"]) ||
      typeof metadata.uid !== "string" || !metadata.uid || typeof metadata.resourceVersion !== "string" ||
      !metadata.resourceVersion || !Number.isInteger(metadata.generation) || metadata.generation < 1) {
    fail(`${entry.name} does not exactly match the established CRD contract`);
  }
  return {
    name: entry.name,
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
    generation: metadata.generation,
    projectionSha256: liveHash,
  };
};

const main = async () => {
  if (await git("rev-parse", "HEAD") !== candidateSha || await git("rev-parse", "HEAD^{tree}") !== candidateTree) {
    fail("the checked-out Git candidate does not match the requested SHA and tree");
  }
  if (await git("status", "--porcelain=v1")) fail("the checked-out candidate is not clean");
  const resources = await loadContracts();
  const version = parseJson((await run(["version", "-o", "json"])).stdout, "Kubernetes version");
  const major = Number.parseInt(version.serverVersion?.major, 10);
  const minor = Number.parseInt(version.serverVersion?.minor, 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 1 || (major === 1 && minor < 30)) {
    fail("the Kubernetes API server must be version 1.30 or newer");
  }
  const cluster = parseJson((await run(["get", "namespace", "kube-system", "-o", "json"])).stdout, "cluster identity");
  if (typeof cluster.metadata?.uid !== "string" || !cluster.metadata.uid || cluster.metadata.deletionTimestamp !== undefined) {
    fail("the Kubernetes cluster identity is invalid");
  }

  const plans = [];
  for (const item of resources) {
    const current = await run(["get", "crd", item.name, "-o", "name", "--ignore-not-found=true"]);
    const exists = current.stdout.trim() !== "";
    if (hash(await readFile(item.file)) !== item.sourceSha256) fail(`${item.name} source changed during admission`);
    const dryRun = parseJson((await run(["apply", "--server-side=true", `--field-manager=${fieldManager}`, "--dry-run=server", "--validate=strict", "-o", "json", "-f", item.file])).stdout, `${item.name} server dry-run`);
    if (dryRun.apiVersion !== "apiextensions.k8s.io/v1" || dryRun.kind !== "CustomResourceDefinition" ||
        dryRun.metadata?.name !== item.name || dryRun.metadata?.annotations?.["wasalx.io/contract-sha256"] !== item.projectionSha256 ||
        projectionHash(dryRun) !== item.projectionSha256) fail(`${item.name} changes under Kubernetes API admission`);
    const difference = await run(["diff", "--server-side=true", `--field-manager=${fieldManager}`, "-f", item.file], [0, 1]);
    plans.push({ ...item, exists, changes: difference.code === 1 });
  }

  const transitioning = plans.some(({ changes }) => changes);
  if (transitioning) {
    if (arguments_["schema-transition-window"] !== "exclusive") {
      fail("a CRD schema transition requires --schema-transition-window exclusive");
    }
    const counts = await Promise.all(plans.map((item) => item.exists ? listCount(item) : 0));
    if (counts.some((count) => count !== 0)) fail("the coupled CRD transition requires zero tenant and provider resources cluster-wide");
  }

  for (const item of plans) {
    if (hash(await readFile(item.file)) !== item.sourceSha256) fail(`${item.name} source changed before apply`);
    await run(["apply", "--server-side=true", `--field-manager=${fieldManager}`, "--validate=strict", "-f", item.file]);
  }
  for (const item of plans) {
    await run(["wait", "--for=condition=Established", `crd/${item.name}`, "--timeout=60s"]);
    await run(["wait", "--for=condition=NamesAccepted", `crd/${item.name}`, "--timeout=60s"]);
  }
  const contracts = await Promise.all(plans.map(liveContract));
  if (transitioning && (await Promise.all(plans.map(listCount))).some((count) => count !== 0)) {
    fail("tenant resources appeared during the coupled CRD transition; stop before deploying WasalX workloads");
  }
  process.stdout.write(`${JSON.stringify({
    candidateSha,
    candidateTree,
    context,
    clusterUid: cluster.metadata.uid,
    kubernetes: version.serverVersion.gitVersion,
    transition: transitioning ? "exclusive-greenfield" : "exact-replay",
    contracts,
    status: "verified",
  })}\n`);
};

try { await main(); }
catch (error) {
  process.stderr.write(`WasalX CRD admission failed: ${error.message}\n`);
  process.exitCode = 1;
}
