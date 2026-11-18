#!/usr/bin/env node
import {requiredOperatorInput} from "./operator-input.mjs";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bracesPatchHash, bracesRuntimeHashes } from "../verify-braces-patch.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogPath = () => resolve(repository, requiredOperatorInput("WASALX_IMAGE_CATALOG"));
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const shaPattern = /^[0-9a-f]{40}$/u;
const packageShaPattern = /^[0-9a-f]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const tagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const imageNamePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const buildkitBuildType = "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";
const releasePlatforms = ["linux/amd64"];
const expectedImageIds = JSON.parse(await readFile(new URL("./product-images.json", import.meta.url), "utf8")).map(image => image.image);
const expectedDependencyIds = ["nginx", "redis", "memcached"];
const approvedBracesImageIds = new Set([
  "portal",
  "control-api",
  "connector-worker",
  "invitation-mailer",
  "identity-policy-activator",
  "tenant-provisioner",
  "tenant-workspace-controller",
  "workspace-provider",
]);
const approvedZlibVulnerabilities = new Set(["GHSA-g5fp-32jq-cfw2", "CVE-2026-85091"]);
const approvedGlibcVulnerability = "CVE-2026-19499";
const allowedHelmPaths = new Set([
  "portal.image",
  "api.image",
  "migration.image",
  "worker.image",
  "invitationMailer.image",
  "identityPolicyActivator.image",
  "workspaceProvider.image",
  "provisioner.image",
  "provisioner.controller.image",
  "controlPlaneBackup.image",
]);
const tenantProvisioningHelmPaths = 7;

const fail = (message) => {
  throw new Error(message);
};

const parseArguments = (values, allowed) => {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    const name = key.slice(2);
    if (!allowed.has(name)) fail(`unknown argument ${key}`);
    if (parsed[name] !== undefined) fail(`duplicate argument ${key}`);
    parsed[name] = value;
  }
  return parsed;
};

const requireArgument = (arguments_, name) => {
  const value = arguments_[name];
  if (!value) fail(`--${name} is required`);
  return value;
};

const json = async (path) => {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`cannot read valid JSON from ${path}: ${error.message}`);
  }
  return value;
};

const validatePublisherProvenance = async (path, release, digest) => {
  const results = await json(path);
  if (!Array.isArray(results) || results.length === 0) fail(`${path} lacks verified publisher certificates`);
  const sourceRef = release.sourceRef ?? `refs/tags/${release.releaseTag}`;
  const identity = `https://github.com/${release.sourceRepository}/${requiredOperatorInput("WASALX_RELEASE_WORKFLOW_PATH")}@${sourceRef}`;
  const expected = {
    runnerEnvironment: "self-hosted",
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: identity,
    buildSignerURI: identity,
    sourceRepositoryURI: `https://github.com/${release.sourceRepository}`,
    sourceRepositoryDigest: release.sourceRevision,
    sourceRepositoryRef: sourceRef,
  };
  for (const result of results) {
    // Certificate fields come from GitHub OIDC; predicate metadata is workflow-controlled.
    const verified = result?.verificationResult;
    const certificate = verified?.signature?.certificate;
    for (const [key, value] of Object.entries(expected)) {
      if (certificate?.[key] !== value) fail(`${path} publisher certificate ${key} mismatch`);
    }
    if (verified.statement?.predicateType !== "https://slsa.dev/provenance/v1" ||
        !verified.statement?.subject?.some(subject => subject.digest?.sha256 === digest.slice("sha256:".length))) {
      fail(`${path} publisher provenance does not bind the selected image digest`);
    }
  }
};

const requireExactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
};

const sha256File = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const evidenceItem = async (path) => ({ filename: basename(path), sha256: await sha256File(path) });

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};

const ensureNonempty = async (path, label) => {
  const contents = await readFile(path);
  if (contents.length === 0) fail(`${label} is empty: ${path}`);
  return contents;
};

const loadCatalog = async (profile) => {
  if (profile !== undefined && profile !== "production") fail("unsupported release profile");
  const catalog = await json(catalogPath());
  const profileHelmPaths = new Set(allowedHelmPaths);
  if (profile === "production") {
    requireExactKeys(catalog.productionSecretSidecar, ["dockerfile", "helmPaths"], "productionSecretSidecar");
    if (catalog.productionSecretSidecar.dockerfile !== "Dockerfile.production-secret-sidecar" ||
        JSON.stringify(catalog.productionSecretSidecar.helmPaths) !== JSON.stringify(["productionSecretSidecar.image"])) fail("invalid production secret image override");
    catalog.images = catalog.images.map(image => image.id === "secret-sidecar" ? { ...image, ...catalog.productionSecretSidecar } : image);
    profileHelmPaths.add("productionSecretSidecar.image");
  }
  if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.images)) {
    fail("release image catalog must use schemaVersion 2 and an images array");
  }
  const ids = catalog.images.map((image) => image.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedImageIds)) {
    fail(`release catalog must contain the canonical images in order: ${expectedImageIds.join(", ")}`);
  }
  if (!Array.isArray(catalog.smokeImageIds) || catalog.smokeImageIds.length === 0 ||
      new Set(catalog.smokeImageIds).size !== catalog.smokeImageIds.length ||
      JSON.stringify(catalog.smokeImageIds) !== JSON.stringify(ids.filter((id) => catalog.smokeImageIds.includes(id)))) {
    fail("release catalog smokeImageIds must contain nonempty unique catalog ids in catalog order");
  }
  const repositories = new Set();
  const dockerfiles = new Set();
  const helmPaths = new Set();
  for (const image of catalog.images) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(image.id)) fail(`invalid image id: ${image.id}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(image.repository)) fail(`invalid repository: ${image.repository}`);
    if (!/^(?:Dockerfile\.[A-Za-z0-9-]+|infra\/docker\/Dockerfile\.zammad)$/u.test(image.dockerfile)) fail(`invalid Dockerfile path: ${image.dockerfile}`);
    if (repositories.has(image.repository)) fail(`duplicate image repository: ${image.repository}`);
    if (dockerfiles.has(image.dockerfile)) fail(`duplicate Dockerfile: ${image.dockerfile}`);
    repositories.add(image.repository);
    dockerfiles.add(image.dockerfile);
    await access(resolve(repository, image.dockerfile));
    if (!Array.isArray(image.helmPaths)) fail(`${image.id}.helmPaths must be an array`);
    for (const path of image.helmPaths) {
      if (!profileHelmPaths.has(path)) fail(`unsupported Helm path for ${image.id}: ${path}`);
      if (helmPaths.has(path)) fail(`duplicate Helm image path: ${path}`);
      helmPaths.add(path);
    }
  }
  if (helmPaths.size !== profileHelmPaths.size) fail("release catalog does not cover every Helm image handoff path");
  requireExactKeys(catalog.tenantProvisioning, ["package", "configuratorImageId", "zammadImageIds", "dependencyImageIds"], "tenantProvisioning");
  requireExactKeys(catalog.tenantProvisioning.package, ["version", "sha256"], "tenantProvisioning.package");
  if (catalog.tenantProvisioning.package.version.length > 64 || !versionPattern.test(catalog.tenantProvisioning.package.version)) {
    fail("tenantProvisioning.package.version is invalid");
  }
  if (!packageShaPattern.test(catalog.tenantProvisioning.package.sha256)) fail("tenantProvisioning.package.sha256 is invalid");
  if (catalog.tenantProvisioning.configuratorImageId !== "workspace-configurator") {
    fail("tenantProvisioning.configuratorImageId must reference workspace-configurator");
  }
  const zammadImageIds = Object.entries(catalog.tenantProvisioning.zammadImageIds ?? {});
  if (zammadImageIds.length === 0 || new Set(zammadImageIds.map(([, id]) => id)).size !== zammadImageIds.length) {
    fail("tenantProvisioning.zammadImageIds must contain distinct catalog image ids");
  }
  for (const [version, id] of zammadImageIds) {
    if (version.length > 64 || !versionPattern.test(version) || !ids.includes(id) || id !== "zammad") {
      fail(`invalid tenantProvisioning Zammad image mapping: ${version}`);
    }
  }
  requireExactKeys(catalog.tenantProvisioning.dependencyImageIds, expectedDependencyIds, "tenantProvisioning.dependencyImageIds");
  for (const name of expectedDependencyIds) {
    if (catalog.tenantProvisioning.dependencyImageIds[name] !== `zammad-${name}`) {
      fail(`tenantProvisioning.dependencyImageIds.${name} must reference zammad-${name}`);
    }
  }
  return catalog;
};

const validateBuiltPackage = async (arguments_) => {
  const catalog = await loadCatalog();
  const source = await json(resolve(repository, "zammad-package/package-source.json"));
  if (source.name !== "wasalx" || source.version !== catalog.tenantProvisioning.package.version) {
    fail("the Zammad package source version does not match the release catalog");
  }
  const expectedFilename = `${source.name}-${source.version}.zpm`;
  const packagePath = resolve(arguments_.package ?? resolve(repository, "build/zammad", expectedFilename));
  const manifestPath = resolve(arguments_.manifest ?? resolve(repository, "build/zammad", `${source.name}-${source.version}.manifest.json`));
  if (basename(packagePath) !== expectedFilename) fail("the built Zammad package filename does not match its source identity");
  const bytes = await ensureNonempty(packagePath, "built Zammad package");
  const archive = await json(packagePath);
  const manifest = await json(manifestPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (archive.name !== source.name || archive.version !== source.version || !Array.isArray(archive.files) || archive.files.length === 0 ||
      manifest.schemaVersion !== 1 || manifest.name !== source.name || manifest.version !== source.version ||
      manifest.package?.bytes !== bytes.length || manifest.package?.sha256 !== digest ||
      digest !== catalog.tenantProvisioning.package.sha256) {
    fail("the built Zammad package identity or digest does not match the release catalog");
  }
  return { name: source.name, version: source.version, sha256: digest, bytes: bytes.length };
};

const validateReleaseCoordinates = ({ releaseTag, sourceRevision, sourceTree, sourceRef, sourceRepository, imageNamespace, profile }) => {
  if (profile !== undefined && profile !== "production") fail("unsupported release profile");
  if (profile === "production" && sourceTree === undefined) fail("production requires a source tree");
  if (sourceTree !== undefined && !shaPattern.test(sourceTree)) fail("invalid source tree");
  const tag = tagPattern.exec(releaseTag);
  if (!tag) fail(`invalid release tag: ${releaseTag}`);
  if (tag[1]?.split(".").some((identifier) => /^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    fail(`numeric prerelease identifiers cannot contain leading zeroes: ${releaseTag}`);
  }
  if (!shaPattern.test(sourceRevision)) fail(`invalid source revision: ${sourceRevision}`);
  if (sourceRef !== undefined && sourceRef !== `refs/tags/${releaseTag}`) {
    if (!["refs/heads/dev", "refs/heads/main"].includes(sourceRef) || profile !== "production") {
      fail("candidate source ref must be protected dev/main with the production artifact profile");
    }
    // A branch candidate has an immutable version label, not a fabricated Git tag.
    if (releaseTag !== `v0.0.0-${sourceRef.split("/").at(-1)}.sha${sourceRevision}`) {
      fail("branch candidate version must bind its branch and exact source revision");
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(sourceRepository)) fail(`invalid source repository: ${sourceRepository}`);
  if (!imageNamePattern.test(imageNamespace)) fail(`invalid lowercase image namespace: ${imageNamespace}`);
  return { isPrerelease: Boolean(tag[1]) };
};

const validateSbom = async (path) => {
  const sbom = await json(path);
  if (sbom.spdxVersion !== "SPDX-2.3") fail(`${path} is not an SPDX 2.3 JSON SBOM`);
  if (typeof sbom.documentNamespace !== "string" || !sbom.documentNamespace.startsWith("https://")) {
    fail(`${path} has no HTTPS SPDX document namespace`);
  }
  if (!Array.isArray(sbom.creationInfo?.creators) || sbom.creationInfo.creators.length === 0) {
    fail(`${path} has no SPDX creator evidence`);
  }
  if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) {
    fail(`${path} contains no SPDX packages`);
  }
};

const validateBuildkitProvenance = async (path, sourceRevision, sourceTree, dockerfile) => {
  if (sourceTree !== undefined && !shaPattern.test(sourceTree)) fail("invalid source tree");
  if (!shaPattern.test(sourceRevision)) fail("invalid source revision");
  const document = await json(path);
  const provenance = document?.SLSA && releasePlatforms.length === 1
    ? { [releasePlatforms[0]]: document }
    : document;
  const platforms = Object.keys(provenance ?? {}).sort();
  if (JSON.stringify(platforms) !== JSON.stringify(releasePlatforms)) {
    fail(`${path} does not contain max-mode BuildKit provenance for the release platform`);
  }
  for (const platform of platforms) {
    const predicate = provenance[platform]?.SLSA;
    if (predicate?.buildDefinition?.buildType !== buildkitBuildType) {
      fail(`${path} has invalid BuildKit SLSA v1 provenance for ${platform}`);
    }
    const definition = predicate.buildDefinition.internalParameters?.buildConfig?.llbDefinition;
    if (!Array.isArray(definition) || definition.length === 0) fail(`${path} does not contain max-mode BuildKit LLB provenance for ${platform}`);
    const source = predicate.runDetails?.metadata?.buildkit_metadata?.source;
    if (!Array.isArray(source?.infos) || source.infos.length === 0) fail(`${path} does not contain max-mode BuildKit source provenance for ${platform}`);
    const args = predicate.buildDefinition.externalParameters?.request?.args;
    const external = predicate.buildDefinition.externalParameters;
    const dockerfileDirectory = external?.request?.root?.request?.args?.["vcs:localdir:dockerfile"];
    const provenanceDockerfile = [dockerfileDirectory, external?.configSource?.path]
      .filter((segment) => segment && segment !== ".")
      .join("/");
    if (dockerfile !== undefined && provenanceDockerfile !== dockerfile) {
      fail(`${path} does not bind the selected Dockerfile for ${platform}`);
    }
    if (sourceTree !== undefined && args?.["build-arg:WASALX_CANDIDATE_TREE"] !== sourceTree) {
      fail(`${path} does not bind the candidate source tree for ${platform}`);
    }
    if (args?.["build-arg:WASALX_CANDIDATE_SHA"] !== sourceRevision) {
      fail(`${path} does not bind the candidate source revision for ${platform}`);
    }
  }
};

const validateBracesProof = async (report, imageId, { proofPath, imageReference, platform } = {}) => {
  const matches = [...report.matches, ...(report.ignoredMatches ?? [])].filter(match => match.artifact?.name === "braces");
  if (!matches.length && !proofPath) return;
  if (!approvedBracesImageIds.has(imageId) || !proofPath || platform !== "linux/amd64" ||
      !new RegExp(`^ghcr\\.io/[a-z0-9._-]+/[a-z0-9._-]+/${imageId}@sha256:[0-9a-f]{64}$`, "u").test(imageReference ?? "")) {
    fail(`${imageId} lacks image-bound braces patch proof`);
  }
  const proof = await json(proofPath);
  if (proof.schemaVersion !== 1 || proof.status !== "verified" || proof.patchHash !== bracesPatchHash ||
      proof.imageReference !== imageReference || proof.platform !== platform ||
      report.source?.target?.userInput !== imageReference ||
      !Array.isArray(proof.copies) || proof.copies.length === 0) fail("Invalid braces patch image binding");
  const roots = new Set();
  const locations = new Set();
  for (const copy of proof.copies) {
    if (copy.name !== "braces" || copy.version !== "3.0.3" || copy.behavior !== "verified" ||
        typeof copy.root !== "string" || !copy.root.startsWith("/app/node_modules/") ||
        copy.root.split("/").includes("..") || roots.has(copy.root) ||
        Object.keys(copy.files ?? {}).length !== Object.keys(bracesRuntimeHashes).length ||
        !Object.entries(bracesRuntimeHashes).every(([file, hash]) => copy.files[file] === hash) ||
        !Array.isArray(copy.packageJsonPaths) || copy.packageJsonPaths.length === 0) fail("Unverified braces runtime copy");
    roots.add(copy.root);
    for (const location of copy.packageJsonPaths) {
      if (typeof location !== "string" || !location.startsWith("/app/node_modules/") ||
          !location.endsWith("/braces/package.json") || location.split("/").includes("..") || locations.has(location)) {
        fail("Invalid braces runtime location");
      }
      locations.add(location);
    }
  }
  for (const match of matches) {
    if (match.artifact.version !== "3.0.3" || !Array.isArray(match.artifact.locations) ||
        match.artifact.locations.length === 0 || !match.artifact.locations.every(location => locations.has(location.path))) {
      fail("Scanner found an unverified braces copy");
    }
  }
};

const validateVulnerabilityScan = async (path, imageId, bracesProof) => {
  const report = await json(path);
  if (!Array.isArray(report.matches) ||
      (report.ignoredMatches !== undefined && !Array.isArray(report.ignoredMatches))) {
    fail(`${path} is not a Grype JSON vulnerability report`);
  }
  const ignoredMatches = report.ignoredMatches ?? [];
  const blocking = report.matches.filter((match) =>
    ["high", "critical"].includes(String(match.vulnerability?.severity ?? "").toLowerCase()));
  if (blocking.length) fail(`${path} contains an unsuppressed high or critical vulnerability`);
  await validateBracesProof(report, imageId, bracesProof);
  if (!ignoredMatches.length) return report;
  const coveredZlib = new Set();
  let coveredGlibc = false;
  for (const match of ignoredMatches) {
    const ids = new Set([match.vulnerability?.id, ...(match.relatedVulnerabilities ?? []).map(({ id }) => id)].filter(Boolean));
    let justification;
    if (approvedBracesImageIds.has(imageId) && match.artifact?.name === "braces" && match.artifact?.version === "3.0.3" &&
        ids.size === 2 && ids.has("GHSA-vfj7-8cjw-p6xm") && ids.has("CVE-2026-93687")) {
      justification = "inline_mitigations_already_exist";
    } else if (match.artifact?.name === "zlib" && match.artifact?.version === "1.3.1-r51" &&
        ids.size === 1 && approvedZlibVulnerabilities.has([...ids][0])) {
      coveredZlib.add([...ids][0]);
      justification = "vulnerable_code_not_present";
    } else if (match.artifact?.name === "glibc-2.44" && match.artifact?.version === "2.44-r6" &&
        ids.size === 1 && ids.has(approvedGlibcVulnerability)) {
      coveredGlibc = true;
      justification = "inline_mitigations_already_exist";
    } else {
      fail(`${path} suppresses an unapproved package or vulnerability`);
    }
    if (!Array.isArray(match.appliedIgnoreRules) || match.appliedIgnoreRules.length === 0 ||
        !match.appliedIgnoreRules.every((rule) => rule.namespace === "vex" &&
          rule["vex-status"] === "not_affected" &&
          rule["vex-justification"] === justification)) {
      fail(`${path} lacks the approved applied VEX reason`);
    }
  }
  if (coveredZlib.size > 0 && coveredZlib.size !== approvedZlibVulnerabilities.size) {
    fail(`${path} does not bind both approved zlib advisory aliases`);
  }
  if (coveredGlibc && ignoredMatches.filter(({ artifact }) => artifact?.name === "glibc-2.44").length !== 1) {
    fail(`${path} does not bind the single approved glibc VEX statement`);
  }
  return report;
};

const validateDependencyRecord = (record, catalog, imagesById) => {
  requireExactKeys(record, ["name", "imageId", "reference"], "dependency record");
  if (!expectedDependencyIds.includes(record.name)) fail("invalid dependency record identity");
  const expectedImageId = catalog.tenantProvisioning.dependencyImageIds[record.name];
  const image = imagesById.get(expectedImageId);
  if (record.imageId !== expectedImageId || !image || record.reference !== image.reference) {
    fail(`${record.name} dependency record does not match the release catalog`);
  }
};

const validateRecord = async (record, baseDirectory, catalogById) => {
  if (record.schemaVersion !== 2) fail("image record must use schemaVersion 2");
  const catalogImage = catalogById.get(record.id);
  if (!catalogImage) fail(`unknown image record id: ${record.id}`);
  validateReleaseCoordinates(record.release);
  const expectedImage = `${record.release.imageNamespace}/${catalogImage.repository}`;
  if (record.image !== expectedImage) fail(`${record.id} image must be ${expectedImage}`);
  if (!digestPattern.test(record.digest)) fail(`${record.id} has an invalid digest`);
  if (record.reference !== `${record.image}@${record.digest}`) fail(`${record.id} reference is not digest-pinned`);
  if (record.dockerfile !== catalogImage.dockerfile) fail(`${record.id} Dockerfile does not match the catalog`);
  if (JSON.stringify(record.platforms) !== JSON.stringify(releasePlatforms)) {
    fail(`${record.id} must publish linux/amd64`);
  }
  if (JSON.stringify(Object.keys(record.platformDigests ?? {})) !== JSON.stringify(record.platforms) ||
      !record.platforms.every((platform) => digestPattern.test(record.platformDigests[platform])) ||
      new Set(Object.values(record.platformDigests)).size !== record.platforms.length) {
    fail(`${record.id} lacks immutable platform manifest digests`);
  }
  if (record.provenance?.mode !== "max" || record.provenance?.verified !== true) {
    fail(`${record.id} lacks verified max-mode provenance`);
  }
  if (!/^https:\/\/github\.com\//u.test(record.provenance.attestationUrl)) {
    fail(`${record.id} has an invalid provenance attestation URL`);
  }
  if (record.signature?.scheme !== "sigstore-keyless" || record.signature?.verified !== true) {
    fail(`${record.id} lacks a verified keyless signature`);
  }
  const expectedIdentity = `https://github.com/${record.release.sourceRepository}/${requiredOperatorInput("WASALX_RELEASE_WORKFLOW_PATH")}@${record.release.sourceRef ?? `refs/tags/${record.release.releaseTag}`}`;
  if (record.signature.certificateIdentity !== expectedIdentity) fail(`${record.id} signature identity does not match this release workflow`);
  if (record.signature.oidcIssuer !== "https://token.actions.githubusercontent.com") fail(`${record.id} has an unexpected OIDC issuer`);
  if (JSON.stringify(record.sboms?.map(({ platform }) => platform)) !== JSON.stringify(releasePlatforms)) {
    fail(`${record.id} lacks the release-platform SBOM`);
  }
  if (JSON.stringify(record.signature?.sbomAttestationVerifications?.map(({ platform }) => platform)) !== JSON.stringify(releasePlatforms)) {
    fail(`${record.id} lacks the release-platform SBOM attestation verification`);
  }
  const evidence = [
    ...record.sboms.map((item) => [item, `${item.platform} SBOM`, true, false]),
    [record.provenance.verification, "provenance verification", false, false],
    [record.provenance.buildkitVerification, "BuildKit provenance verification", false, false],
    [record.signature.verification, "signature verification", false, false],
    ...record.signature.sbomAttestationVerifications.map((item) => [item, `${item.platform} SBOM attestation verification`, false, false]),
  ];
  if (record.security?.scanner !== "grype" ||
      JSON.stringify(record.security.vulnerabilityScans?.map(({ platform }) => platform)) !== JSON.stringify(releasePlatforms)) {
    fail(`${record.id} lacks the release-platform Grype vulnerability scan`);
  }
  for (const scan of record.security.vulnerabilityScans) {
    if (scan.bracesPatch) evidence.push([scan.bracesPatch, `${scan.platform} braces patch proof`, false, false]);
    evidence.push([scan, `${scan.platform} vulnerability scan`, false, true]);
  }
  for (const [item, label, isSbom, isVulnerabilityScan] of evidence) {
    if (
      !item ||
      !/^[a-z0-9][a-z0-9._-]+$/u.test(item.filename) ||
      !item.filename.startsWith(`${record.id}.`) ||
      !/^[0-9a-f]{64}$/u.test(item.sha256)
    ) {
      fail(`${record.id} has invalid ${label} metadata`);
    }
    const path = resolve(baseDirectory, item.filename);
    if (isSbom) await validateSbom(path);
    else if (isVulnerabilityScan) await validateVulnerabilityScan(path, record.id, {
      proofPath: item.bracesPatch ? resolve(baseDirectory, item.bracesPatch.filename) : undefined,
      imageReference: `${record.image}@${record.platformDigests[item.platform]}`,
      platform: item.platform,
    });
    else await ensureNonempty(path, `${record.id} ${label}`);
    if (item === record.provenance.verification) await validatePublisherProvenance(path, record.release, record.digest);
    if (item === record.provenance.buildkitVerification) await validateBuildkitProvenance(path, record.release.sourceRevision, record.release.sourceTree, record.release.sourceTree === undefined ? undefined : record.dockerfile);
    if (await sha256File(path) !== item.sha256) fail(`${record.id} ${label} digest mismatch`);
  }
};

const yamlScalar = (value) => JSON.stringify(value);

const assignNested = (target, path, value) => {
  const segments = path.startsWith("/") ? path.slice(1).split("/") : path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  cursor[segments.at(-1)] = value;
};

const resolveTenantProvisioning = (catalog, imagesById) => ({
  packageVersion: catalog.tenantProvisioning.package.version,
  packageSha256: catalog.tenantProvisioning.package.sha256,
  configuratorImage: imagesById.get(catalog.tenantProvisioning.configuratorImageId).reference,
  nginxImage: imagesById.get(catalog.tenantProvisioning.dependencyImageIds.nginx).reference,
  redisImage: imagesById.get(catalog.tenantProvisioning.dependencyImageIds.redis).reference,
  memcachedImage: imagesById.get(catalog.tenantProvisioning.dependencyImageIds.memcached).reference,
  zammadImages: Object.fromEntries(Object.entries(catalog.tenantProvisioning.zammadImageIds)
    .map(([version, id]) => [version, imagesById.get(id).reference])),
});

const buildHelmHandoff = (catalog, imagesById) => {
  const helm = {};
  for (const image of catalog.images) {
    for (const path of image.helmPaths) assignNested(helm, path, imagesById.get(image.id).reference);
  }
  const tenantProvisioning = resolveTenantProvisioning(catalog, imagesById);
  assignNested(helm, "provisioner.packageVersion", tenantProvisioning.packageVersion);
  assignNested(helm, "provisioner.packageSha256", tenantProvisioning.packageSha256);
  assignNested(helm, "provisioner.controller.configuratorImage", tenantProvisioning.configuratorImage);
  assignNested(helm, "provisioner.controller.nginxImage", tenantProvisioning.nginxImage);
  assignNested(helm, "provisioner.controller.redisImage", tenantProvisioning.redisImage);
  assignNested(helm, "provisioner.controller.memcachedImage", tenantProvisioning.memcachedImage);
  assignNested(helm, "provisioner.controller.zammadImages", tenantProvisioning.zammadImages);
  return helm;
};

const renderYaml = (value, depth = 0) => {
  const indentation = "  ".repeat(depth);
  return Object.entries(value)
    .map(([key, child]) => {
      if (typeof child === "object" && child !== null) {
        return `${indentation}${key}:\n${renderYaml(child, depth + 1)}`;
      }
      return `${indentation}${key}: ${yamlScalar(child)}\n`;
    })
    .join("");
};

const commands = {
  async "validate-package"(arguments_) {
    process.stdout.write(`${JSON.stringify({ ...await validateBuiltPackage(arguments_), status: "verified" })}\n`);
  },

  async "validate-catalog"(arguments_) {
    const catalog = await loadCatalog(arguments_.profile);
    process.stdout.write(`${JSON.stringify({ images: catalog.images.length, helmPaths: allowedHelmPaths.size + tenantProvisioningHelmPaths + (arguments_.profile === "production" ? 1 : 0) })}\n`);
  },

  async "validate-coordinates"(arguments_) {
    const release = {
      releaseTag: requireArgument(arguments_, "release-tag"),
      sourceRevision: requireArgument(arguments_, "source-revision"),
      ...(arguments_["source-tree"] !== undefined ? { sourceTree: arguments_["source-tree"] } : {}),
      ...(arguments_["source-ref"] !== undefined ? { sourceRef: arguments_["source-ref"] } : {}),
      ...(arguments_.profile !== undefined ? { profile: arguments_.profile } : {}),
      sourceRepository: requireArgument(arguments_, "source-repository"),
      imageNamespace: requireArgument(arguments_, "image-namespace"),
    };
    const classification = validateReleaseCoordinates(release);
    process.stdout.write(`${JSON.stringify({ ...release, ...classification, status: "verified" })}\n`);
  },

  async "validate-buildkit-provenance"(arguments_) {
    await validateBuildkitProvenance(
      resolve(requireArgument(arguments_, "file")),
      requireArgument(arguments_, "source-revision"),
      arguments_["source-tree"],
      arguments_.dockerfile,
    );
    process.stdout.write(`${JSON.stringify({ platforms: releasePlatforms, mode: "max", status: "verified" })}\n`);
  },

  async "validate-publisher-provenance"(arguments_) {
    const digest = requireArgument(arguments_, "digest");
    if (!digestPattern.test(digest)) fail("publisher image digest must be a sha256 value");
    await validatePublisherProvenance(resolve(requireArgument(arguments_, "file")), {
      sourceRepository: requireArgument(arguments_, "source-repository"),
      sourceRevision: requireArgument(arguments_, "source-revision"),
      sourceRef: requireArgument(arguments_, "source-ref"),
    }, digest);
    process.stdout.write(`${JSON.stringify({ runnerEnvironment: "self-hosted", status: "verified" })}\n`);
  },

  async "validate-vulnerability-scan"(arguments_) {
    await validateVulnerabilityScan(
      resolve(requireArgument(arguments_, "file")),
      requireArgument(arguments_, "id"),
      { proofPath: arguments_["braces-patch"], imageReference: arguments_["image-reference"], platform: arguments_.platform },
    );
    process.stdout.write(`${JSON.stringify({ status: "verified" })}\n`);
  },

  async matrix(arguments_) {
    const catalog = await loadCatalog(arguments_.profile);
    process.stdout.write(JSON.stringify({ include: catalog.images.map(({ id, repository, dockerfile }) => ({ id, repository, dockerfile })) }));
  },

  async repositories() {
    const catalog = await loadCatalog();
    process.stdout.write(`${catalog.images.map((image) => image.repository).join("\n")}\n`);
  },

  async record(arguments_) {
    const catalog = await loadCatalog(arguments_.profile);
    const catalogById = new Map(catalog.images.map((image) => [image.id, image]));
    const id = requireArgument(arguments_, "id");
    const image = catalogById.get(id);
    if (!image) fail(`unknown image id: ${id}`);
    const release = {
      releaseTag: requireArgument(arguments_, "release-tag"),
      sourceRevision: requireArgument(arguments_, "source-revision"),
      ...(arguments_["source-tree"] !== undefined ? { sourceTree: arguments_["source-tree"] } : {}),
      ...(arguments_["source-ref"] !== undefined ? { sourceRef: arguments_["source-ref"] } : {}),
      ...(arguments_.profile !== undefined ? { profile: arguments_.profile } : {}),
      sourceRepository: requireArgument(arguments_, "source-repository"),
      imageNamespace: requireArgument(arguments_, "image-namespace"),
    };
    validateReleaseCoordinates(release);
    const digest = requireArgument(arguments_, "digest");
    if (!digestPattern.test(digest)) fail(`invalid image digest: ${digest}`);
    const platformDigests = {
      "linux/amd64": requireArgument(arguments_, "platform-digest-amd64"),
    };
    if (!Object.values(platformDigests).every((value) => digestPattern.test(value))) {
      fail("platform manifest digest must be a sha256 value");
    }
    const sbomPaths = [
      ["linux/amd64", resolve(requireArgument(arguments_, "sbom-amd64"))],
    ];
    const provenanceVerificationPath = resolve(requireArgument(arguments_, "provenance-verification"));
    const buildkitProvenanceVerificationPath = resolve(requireArgument(arguments_, "buildkit-provenance-verification"));
    const signatureVerificationPath = resolve(requireArgument(arguments_, "signature-verification"));
    const sbomAttestationVerificationPaths = [
      ["linux/amd64", resolve(requireArgument(arguments_, "sbom-attestation-verification-amd64"))],
    ];
    const vulnerabilityScanPaths = [
      ["linux/amd64", resolve(requireArgument(arguments_, "vulnerability-scan-amd64"))],
    ];
    for (const [, path] of sbomPaths) await validateSbom(path);
    await validatePublisherProvenance(provenanceVerificationPath, release, digest);
    await validateBuildkitProvenance(buildkitProvenanceVerificationPath, release.sourceRevision, release.sourceTree, release.sourceTree === undefined ? undefined : image.dockerfile);
    await ensureNonempty(signatureVerificationPath, "signature verification");
    for (const [, path] of sbomAttestationVerificationPaths) await ensureNonempty(path, "SBOM attestation verification");
    for (const [platform, path] of vulnerabilityScanPaths) await validateVulnerabilityScan(path, id, {
      proofPath: arguments_["braces-patch-amd64"],
      imageReference: `${release.imageNamespace}/${image.repository}@${platformDigests[platform]}`,
      platform,
    });
    const record = {
      schemaVersion: 2,
      id,
      release,
      image: `${release.imageNamespace}/${image.repository}`,
      digest,
      reference: `${release.imageNamespace}/${image.repository}@${digest}`,
      dockerfile: image.dockerfile,
      platforms: releasePlatforms,
      platformDigests,
      sboms: await Promise.all(sbomPaths.map(async ([platform, path]) => ({ platform, ...await evidenceItem(path) }))),
      provenance: {
        mode: "max",
        verified: true,
        attestationUrl: requireArgument(arguments_, "provenance-url"),
        verification: await evidenceItem(provenanceVerificationPath),
        buildkitVerification: await evidenceItem(buildkitProvenanceVerificationPath),
      },
      signature: {
        scheme: "sigstore-keyless",
        verified: true,
        certificateIdentity: requireArgument(arguments_, "certificate-identity"),
        oidcIssuer: "https://token.actions.githubusercontent.com",
        verification: await evidenceItem(signatureVerificationPath),
        sbomAttestationVerifications: await Promise.all(sbomAttestationVerificationPaths.map(async ([platform, path]) => ({ platform, ...await evidenceItem(path) }))),
      },
      security: {
        scanner: "grype",
        vulnerabilityScans: await Promise.all(vulnerabilityScanPaths.map(async ([platform, path]) => ({
          platform,
          ...await evidenceItem(path),
          ...(arguments_["braces-patch-amd64"] ? { bracesPatch: await evidenceItem(resolve(arguments_["braces-patch-amd64"])) } : {}),
        }))),
      },
    };
    await validateRecord(record, dirname(sbomPaths[0][1]), catalogById);
    await writeJson(resolve(requireArgument(arguments_, "output")), record);
  },

  async assemble(arguments_) {
    const recordsDirectory = resolve(requireArgument(arguments_, "records"));
    const outputDirectory = resolve(requireArgument(arguments_, "output"));
    const files = (await readdir(recordsDirectory)).filter((file) => file.endsWith(".record.json")).sort();
    if (files.length !== expectedImageIds.length) fail(`expected ${expectedImageIds.length} image records, received ${files.length}`);
    const firstInput = await json(resolve(recordsDirectory, files[0]));
    validateReleaseCoordinates(firstInput.release ?? {});
    const catalog = await loadCatalog(firstInput.release.profile);
    const catalogById = new Map(catalog.images.map((image) => [image.id, image]));
    const records = [];
    for (const file of files) {
      const record = await json(resolve(recordsDirectory, file));
      await validateRecord(record, recordsDirectory, catalogById);
      records.push(record);
    }
    const byId = new Map();
    for (const record of records) {
      if (byId.has(record.id)) fail(`duplicate image record: ${record.id}`);
      byId.set(record.id, record);
    }
    for (const id of expectedImageIds) if (!byId.has(id)) fail(`missing image record: ${id}`);
    const first = byId.get(expectedImageIds[0]);
    for (const record of records) {
      if (JSON.stringify(record.release) !== JSON.stringify(first.release)) fail(`${record.id} release coordinates differ from the other records`);
    }
    const images = catalog.images.map((image) => {
      const record = byId.get(image.id);
      return {
        id: record.id,
        image: record.image,
        digest: record.digest,
        reference: record.reference,
        dockerfile: record.dockerfile,
        platforms: record.platforms,
        platformDigests: record.platformDigests,
        sboms: record.sboms,
        provenance: record.provenance,
        signature: record.signature,
        security: record.security,
      };
    });
    const manifest = {
      schemaVersion: 3,
      release: first.release,
      images,
      dependencies: expectedDependencyIds.map((name) => {
        const imageId = catalog.tenantProvisioning.dependencyImageIds[name];
        return { name, imageId, reference: byId.get(imageId).reference };
      }),
      tenantProvisioning: resolveTenantProvisioning(catalog, byId),
    };
    const helm = buildHelmHandoff(catalog, byId);
    await mkdir(outputDirectory, { recursive: true });
    await writeJson(resolve(outputDirectory, "wasalx-release-manifest.json"), manifest);
    await writeFile(resolve(outputDirectory, "wasalx-helm-images.yaml"), `# Generated from wasalx-release-manifest.json; do not replace digests with tags.\n${renderYaml(helm)}`, { flag: "wx" });
  },

  async verify(arguments_) {
    const manifestPath = resolve(requireArgument(arguments_, "manifest"));
    const manifest = await json(manifestPath);
    if (manifest.schemaVersion !== 3 || !Array.isArray(manifest.images) || !Array.isArray(manifest.dependencies)) {
      fail("release manifest must use schemaVersion 3 with image and dependency evidence arrays");
    }
    validateReleaseCoordinates(manifest.release);
    const catalog = await loadCatalog(manifest.release.profile);
    if (manifest.images.length !== expectedImageIds.length) fail(`release manifest must contain ${expectedImageIds.length} images`);
    const catalogById = new Map(catalog.images.map((image) => [image.id, image]));
    for (let index = 0; index < catalog.images.length; index += 1) {
      const expected = catalog.images[index];
      const image = manifest.images[index];
      if (image.id !== expected.id || image.dockerfile !== expected.dockerfile) fail(`release manifest catalog drift at index ${index}`);
      await validateRecord({ schemaVersion: 2, release: manifest.release, ...image }, dirname(manifestPath), catalogById);
    }
    if (JSON.stringify(manifest.dependencies.map(({ name }) => name)) !== JSON.stringify(expectedDependencyIds)) {
      fail(`release manifest must contain dependency evidence for ${expectedDependencyIds.join(", ")}`);
    }
    const imagesById = new Map(manifest.images.map((image) => [image.id, image]));
    for (const dependency of manifest.dependencies) validateDependencyRecord(dependency, catalog, imagesById);
    const expectedTenantProvisioning = resolveTenantProvisioning(catalog, imagesById);
    if (JSON.stringify(manifest.tenantProvisioning) !== JSON.stringify(expectedTenantProvisioning)) {
      fail("release manifest tenant provisioning tuple does not match the catalog and signed images");
    }
    const helmPath = arguments_.helm ? resolve(arguments_.helm) : undefined;
    if (helmPath) {
      const helm = await readFile(helmPath, "utf8");
      const expectedHelm = buildHelmHandoff(catalog, imagesById);
      const expectedText = `# Generated from wasalx-release-manifest.json; do not replace digests with tags.\n${renderYaml(expectedHelm)}`;
      if (helm !== expectedText) fail("Helm handoff does not exactly match the release digest manifest");
    }
    process.stdout.write(`${JSON.stringify({ images: manifest.images.length, dependencies: manifest.dependencies.length, helmPaths: allowedHelmPaths.size + tenantProvisioningHelmPaths + (manifest.release.profile === "production" ? 1 : 0), status: "verified" })}\n`);
  },
};

const commandArguments = {
  "validate-package": new Set(["package", "manifest"]),
  "validate-catalog": new Set(["profile"]),
  "validate-coordinates": new Set(["release-tag", "source-revision", "source-tree", "source-ref", "profile", "source-repository", "image-namespace"]),
  "validate-buildkit-provenance": new Set(["file", "source-revision", "source-tree", "dockerfile"]),
  "validate-publisher-provenance": new Set(["file", "source-repository", "source-revision", "source-ref", "digest"]),
  "validate-vulnerability-scan": new Set(["id", "file", "braces-patch", "image-reference", "platform"]),
  matrix: new Set(["profile"]),
  repositories: new Set(),
  record: new Set([
    "id", "release-tag", "source-revision", "source-tree", "source-ref", "profile", "source-repository", "image-namespace", "digest",
    "platform-digest-amd64", "sbom-amd64",
    "provenance-verification", "buildkit-provenance-verification", "signature-verification",
    "sbom-attestation-verification-amd64", "vulnerability-scan-amd64", "braces-patch-amd64", "provenance-url",
    "certificate-identity", "output",
  ]),
  assemble: new Set(["records", "output"]),
  verify: new Set(["manifest", "helm"]),
};

const [command, ...rawArguments] = process.argv.slice(2);
if (!Object.hasOwn(commands, command)) {
  process.stderr.write("usage: artifact-contract.mjs <validate-package|validate-catalog|validate-coordinates|validate-buildkit-provenance|validate-publisher-provenance|validate-vulnerability-scan|matrix|repositories|record|assemble|verify> [--key value ...]\n");
  process.exitCode = 2;
} else {
  try {
    await commands[command](parseArguments(rawArguments, commandArguments[command]));
  } catch (error) {
    process.stderr.write(`release artifact contract failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
