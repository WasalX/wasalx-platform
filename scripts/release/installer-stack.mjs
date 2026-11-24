#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryDigestMatches, writeRepositoryJson } from "../installer-evidence.mjs";
import { assertLocalRegistry, localRegistryReference } from "./installer-hosted-images.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const expectedFullServices = [
  "alertmanager", "clamav", "connector-worker", "control-api", "full-qualification-seed", "grafana",
  "identity-policy-activator", "jaeger", "keycloak", "keycloak-bootstrap",
  "keycloak-postgresql", "migrate", "minio", "minio-bootstrap", "otel-collector", "portal",
  "postgres", "prometheus", "public-webhook-preflight", "redis", "runtime-role-bootstrap", "secret-sidecar", "waha-gows",
  "zammad-activation", "zammad-backup", "zammad-elasticsearch", "zammad-init", "zammad-memcached",
  "zammad-nginx", "zammad-package", "zammad-postgresql", "zammad-railsserver", "zammad-redis",
  "zammad-runtime-bootstrap", "zammad-scheduler", "zammad-websocket",
].sort();
const expectedFullOneShots = [
  "full-qualification-seed", "keycloak-bootstrap", "migrate", "minio-bootstrap", "public-webhook-preflight", "runtime-role-bootstrap",
  "zammad-activation", "zammad-init", "zammad-package", "zammad-runtime-bootstrap",
].sort();
const expectedRuntimeWorkerServices = ["invitation-mailer"];
export const devColdResidents = Object.freeze(JSON.parse(await readFile(new URL("./compose-stage-config.json", import.meta.url))).coldResidents);
export const devHeldServices = Object.freeze([
  "connector-worker", "identity-policy-activator", "invitation-mailer", "waha-gows", "zammad-scheduler",
]);
export const devPreservedServices = Object.freeze([
  "full-qualification-seed", "keycloak-bootstrap", "minio-bootstrap", "public-webhook-preflight",
  "waha-gows", "zammad-activation", "zammad-backup", "zammad-runtime-bootstrap", "zammad-scheduler",
]);
export function devValueDigest(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
// Same projection for action-time capture and verification. No Env values leave memory.
export function devContainerPreimage(container) {
  return {
    service: container.Config?.Labels?.["com.docker.compose.service"] ?? container.service,
    id: container.Id, image: container.Image, configuredImage: container.Config?.Image,
    configSha256: devValueDigest(container.Config), hostConfigSha256: devValueDigest(container.HostConfig),
    mounts: (container.Mounts ?? []).map((mount) => ({
      type: mount.Type, name: mount.Name ?? null, destination: mount.Destination, rw: mount.RW,
      sourceSha256: createHash("sha256").update(mount.Source).digest("hex"),
    })).sort((left, right) => left.destination.localeCompare(right.destination)),
    readOnly: container.HostConfig?.ReadonlyRootfs,
    state: container.State?.Status, running: container.State?.Running, pid: container.State?.Pid,
    paused: container.State?.Paused, dead: container.State?.Dead, restarting: container.State?.Restarting ?? false,
    exitCode: container.State?.ExitCode, startedAt: container.State?.StartedAt, restartCount: container.RestartCount,
  };
}
export function devHeldPrerequisites(model, activeServices) {
  return Object.fromEntries(activeServices.map((name) => [name, activeServices.filter((dependent) =>
    model.services[dependent].depends_on?.[name]?.condition === "service_completed_successfully")])
    .filter(([, dependents]) => dependents.length && dependents.every((name) => devHeldServices.includes(name))));
}
export function devFreshHeldPlan(model, active) {
  assert.ok(devHeldServices.every(name => active.includes(name)), "fresh DEV hold inventory is incomplete");
  const prerequisites = devHeldPrerequisites(model, active);
  const held = [...devHeldServices, ...Object.keys(prerequisites)].sort();
  const start = active.filter(name => !held.includes(name));
  assert.ok(start.length, "fresh held project has no startup targets");
  for (const name of start) {
    const service = model.services[name];
    const dependencies = [
      ...Object.keys(service.depends_on ?? {}),
      ...(service.links ?? []).map(link => link.split(":")[0]),
      ...(service.volumes_from ?? []).map(volume => volume.split(":")[0]),
      ...[service.network_mode, service.ipc, service.pid].filter(value => value?.startsWith("service:")).map(value => value.slice(8)),
    ];
    for (const dependency of dependencies) {
      assert.ok(!held.includes(dependency), `${name} depends on held service ${dependency}`);
    }
  }
  return { held, start, prerequisites };
}

export function assertDevInstallPreimages(value, { candidateSha, candidateTree, project, machineIdSha256, activeServices, model }) {
  assert.equal(value?.kind, "dev-held-install-preimages");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.candidateSha, candidateSha); assert.equal(value.candidateTree, candidateTree);
  assert.equal(value.project, "wasalx-live"); assert.equal(project, value.project);
  assert.equal(value.machineIdSha256, machineIdSha256);
  if (value.devReviewAuth !== undefined) assertDevReviewAuth(value.devReviewAuth);
  assert.ok(value.admissionMode === undefined || value.admissionMode === "cold-held", "Unknown DEV admission mode");
  const cold = value.admissionMode === "cold-held";
  if (cold) assert.ok(devColdResidents.every((name) => activeServices.includes(name)), "Cold DEV resident inventory incomplete");
  const heldPrerequisites = devHeldPrerequisites(model, activeServices);
  assert.deepEqual(value.heldPrerequisites ?? {}, heldPrerequisites, "DEV held prerequisites changed");
  const held = cold ? activeServices.filter((name) => !devColdResidents.includes(name)) : [...devHeldServices, ...Object.keys(heldPrerequisites)];
  assert.deepEqual(value.heldServices, [...held].sort());
  assert.deepEqual(value.preservedServices, cold ? [...activeServices].sort() : [...devPreservedServices].sort());
  assert.deepEqual(value.services.map(({ service }) => service).sort(), [...activeServices].sort(), "DEV preimage inventory changed");
  for (const row of value.services) {
    assert.match(row.id, /^[0-9a-f]{64}$/u); assert.match(row.image, digestPattern);
    assert.match(row.configSha256, /^[0-9a-f]{64}$/u); assert.match(row.hostConfigSha256, /^[0-9a-f]{64}$/u);
    if (!held.includes(row.service)) assert.equal(row.restartCount, 0, `${row.service} non-held restart history requires review`);
    if (cold) {
      assert.equal(row.paused, false); assert.equal(row.dead, false); assert.equal(row.restarting, false);
      if (row.running) {
        assert.ok(devColdResidents.includes(row.service), `${row.service} cold hold was started`);
        assert.equal(row.state, "running"); assert.ok(row.pid > 0);
      } else {
        assert.equal(row.running, false); assert.equal(row.pid, 0);
        assert.ok(["created", "exited"].includes(row.state) && (row.service in heldPrerequisites || [0, 143].includes(row.exitCode)), `${row.service} stopped lifecycle requires review`);
      }
    }
  }
  for (const name of held) {
    const row = value.services.find(({ service }) => service === name);
    assert.ok(Number.isSafeInteger(row.restartCount) && row.restartCount >= 0, `${name} held restart history unavailable`);
    assert.equal(row.running, false, `${name} intentional hold was not stopped`);
    assert.equal(row.pid, 0);
    assert.ok(["created", "exited"].includes(row.state), `${name} intentional hold was started`);
    assert.equal(row.paused, false); assert.equal(row.dead, false); assert.equal(row.restarting, false);
    if (cold && !(name in heldPrerequisites)) assert.ok([0, 143].includes(row.exitCode), `${name} stopped exit requires review`);
  }
  for (const name of devPreservedServices.filter((name) => !devHeldServices.includes(name) && !(name in heldPrerequisites) && name !== "zammad-backup")) {
    const row = value.services.find(({ service }) => service === name);
    assert.equal(row.state, "exited"); assert.equal(row.exitCode, 0);
  }
  if (!cold) assert.equal(value.services.find(({ service }) => service === "zammad-backup").running, true);
  for (const name of ["connector-worker", "identity-policy-activator", "invitation-mailer"]) {
    assert.equal(value.services.find(({ service }) => service === name).readOnly, true);
  }
  const api = value.services.find(({ service }) => service === "control-api");
  assert.equal(api.running, false, "API ingress must be stopped for DEV migration");
  if (cold) assert.ok(["created", "exited"].includes(api.state), "Cold API ingress must remain stopped");
  else assert.equal(api.state, "exited", "API ingress must have exited for DEV migration");
  assert.equal(api.pid, 0, "API ingress still has a live process");
  assert.equal(api.restarting, false);
  assert.equal(api.paused, false);
  assert.equal(api.dead, false);
  if (cold && value.services.find(({ service }) => service === "postgres")?.running === false) {
    assert.deepEqual(value.nativeSync, { state: "UNKNOWN", reason: "postgres stopped" });
    return;
  }
  assert.equal(typeof value.nativeSync.tableExists, "boolean");
  assert.ok(Number.isSafeInteger(value.nativeSync.unavailableCount) && value.nativeSync.unavailableCount >= 0);
  assert.equal(value.nativeSync.pending, 0, "native membership work must be reviewed before DEV replacement");
  assert.match(value.nativeSync.unavailableSha256, /^[0-9a-f]{64}$/u);
}

const devReviewPortalFields = Object.freeze([
  "PORTAL_PUBLIC_ORIGIN", "PORTAL_COOKIE_SECURE", "OIDC_ISSUER", "OIDC_AUTHORIZATION_ENDPOINT",
  "OIDC_REDIRECT_URI", "OIDC_INVITATION_REDIRECT_URI", "PLATFORM_OPERATOR_OIDC_ISSUER",
  "PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT", "PLATFORM_OPERATOR_OIDC_REDIRECT_URI", "VINEXT_TRUSTED_HOSTS",
]);
const devReviewApiFields = Object.freeze(["PORTAL_PUBLIC_ORIGIN", "OIDC_ISSUER", "PLATFORM_OPERATOR_OIDC_ISSUER"]);

export function assertInstallHostname() {
  const expected = process.env.WASALX_INSTALL_EXPECTED_HOSTNAME;
  assert.ok(typeof expected === "string" && expected.trim(), "WASALX_INSTALL_EXPECTED_HOSTNAME is required");
  assert.ok(hostname() === expected, "installation hostname does not match WASALX_INSTALL_EXPECTED_HOSTNAME");
}

export const rehearsalComposeFile = "scripts/release/installer-nightly.compose.yaml";
const sideBySideDev = /^wasalx-dev-[a-z0-9][a-z0-9-]*$/u;
export const devFreshHeldFlag = "--dev-fresh-held";
export const devSimulatorFlag = "--dev-simulator";
const devGuestOnly = "fresh held and simulator options require a side-by-side DEV project";
const devSimulatorSmokeOnly = "simulator smoke requires --dev-fresh-held";

export function devGuestComposeFiles({ project, devFreshHeld, devSimulator, rehearsalMain, full = true }) {
  if (!devFreshHeld && !devSimulator) return [];
  const nonDev = [process.env.DEPLOY_ENVIRONMENT, process.env.WASALX_ENVIRONMENT]
    .some(value => !["", "dev"].includes(value?.trim().toLowerCase() ?? ""));
  assert.ok(full && sideBySideDev.test(project) && !rehearsalMain && !nonDev, devGuestOnly);
  return devSimulator ? [rehearsalComposeFile, "scripts/release/installer-dev-simulator.compose.yaml"] : [];
}

export const devSkipPublicWebhookPreflightFlag = "--dev-skip-public-webhook-preflight";
const devWebhookPreflightOnly = "public webhook preflight skip is DEV-only";

export function devWebhookPreflightOverlay({ project, devSkipPublicWebhookPreflight, rehearsalMain, full = true }) {
  if (!devSkipPublicWebhookPreflight) return [];
  const devProject = project === "wasalx-live" || sideBySideDev.test(project);
  const stgOrProd = [process.env.DEPLOY_ENVIRONMENT, process.env.WASALX_ENVIRONMENT]
    .some(value => /^(stg|staging|prod|production)$/iu.test(value?.trim() ?? ""));
  assert.ok(full && devProject && !rehearsalMain && !stgOrProd, devWebhookPreflightOnly);
  return ["scripts/release/installer-dev-skip-webhook.compose.yaml"];
}

export async function localRegistryOverlay({ registry, project, envFile, profiles, render }) {
  assert.ok(!envFile.includes(","), "local registry env file path cannot contain a comma");
  const model = render();
  const services = Object.fromEntries(activeServiceNames(model, profiles).filter(name => !model.services[name].build)
    .map(name => [name, { image: localRegistryReference(registry, model.services[name].image) }]));
  assert.ok(Object.keys(services).length, "local registry requires pinned Compose dependencies");
  const path = `${envFile}.${project}.registry.compose.json`;
  const contents = `${JSON.stringify({ services })}\n`;
  try { await writeFile(path, contents, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(await readFile(path, "utf8"), contents, "local registry overlay differs from the current Compose model");
  }
  return path;
}

export function rehearsalImageSource(project, commit, runGit) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "installer rehearsal requires GitHub Actions");
  assert.equal(project, "wasalx-nightly", "installer rehearsal requires its disposable project");
  assert.match(commit, shaPattern, "rehearsal main commit is invalid");
  assert.ok(runGit(["rev-list", "--first-parent", "HEAD"]).split(/\r?\n/u).includes(commit),
    "rehearsal image source must be in the checkout's first-parent history");
  const tree = runGit(["rev-parse", `${commit}^{tree}`]);
  assert.match(tree, shaPattern, "rehearsal main tree is invalid");
  return { commit, tree };
}

// Explicit, nonsecret DEV origin admission. No arbitrary Env, URL path or proxy trust.
export function devReviewAuthConfiguration(origins) {
  const suffix = process.env.WASALX_DEV_REVIEW_ORIGIN_SUFFIX;
  assert.ok(typeof suffix === "string" && suffix.trim(), "WASALX_DEV_REVIEW_ORIGIN_SUFFIX is required");
  assert.ok(origins && typeof origins === "object" && !Array.isArray(origins), "DEV review origins are required");
  assert.deepEqual(Object.keys(origins).sort(), ["identityOrigin", "portalOrigin"], "Unexpected DEV review origin field");
  const urls = [origins.portalOrigin, origins.identityOrigin].map((value) => {
    assert.equal(typeof value, "string", "DEV review origin must be a string");
    const url = new URL(value);
    assert.ok(url.protocol === "https:" && url.origin === value && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash && url.hostname.endsWith(suffix), "DEV review requires a canonical HTTPS origin matching WASALX_DEV_REVIEW_ORIGIN_SUFFIX");
    return url;
  });
  assert.equal(urls[0].hostname, urls[1].hostname, "DEV review identity belongs to another host");
  assert.notEqual(urls[0].origin, urls[1].origin, "DEV portal and identity origins must be distinct");
  const { portalOrigin, identityOrigin } = origins;
  const portal = {
    PORTAL_PUBLIC_ORIGIN: portalOrigin, PORTAL_COOKIE_SECURE: "true",
    OIDC_ISSUER: `${identityOrigin}/realms/wasalx`,
    OIDC_AUTHORIZATION_ENDPOINT: `${identityOrigin}/realms/wasalx/protocol/openid-connect/auth`,
    OIDC_REDIRECT_URI: `${portalOrigin}/auth/callback`, OIDC_INVITATION_REDIRECT_URI: `${portalOrigin}/invitations/callback`,
    PLATFORM_OPERATOR_OIDC_ISSUER: `${identityOrigin}/realms/wasalx-platform`,
    PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT: `${identityOrigin}/realms/wasalx-platform/protocol/openid-connect/auth`,
    PLATFORM_OPERATOR_OIDC_REDIRECT_URI: `${portalOrigin}/platform/auth/callback`, VINEXT_TRUSTED_HOSTS: urls[0].host,
  };
  return { portalOrigin, identityOrigin, portal, controlApi: Object.fromEntries(devReviewApiFields.map((field) => [field, portal[field]])) };
}

export function assertDevReviewAuth(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "DEV review auth configuration is invalid");
  assert.deepEqual(Object.keys(value).sort(), ["controlApi", "identityOrigin", "portal", "portalOrigin"], "Unexpected DEV review auth field");
  assert.deepEqual(value, devReviewAuthConfiguration({ portalOrigin: value.portalOrigin, identityOrigin: value.identityOrigin }), "DEV review auth differs from approved origins");
}

export function assertDevReviewAuthRows(value, rows) {
  if (value === undefined) return;
  assertDevReviewAuth(value);
  for (const [service, fields, expected] of [["portal", devReviewPortalFields, value.portal], ["control-api", devReviewApiFields, value.controlApi]]) {
    const matches = rows.filter((row) => (row.service ?? row.Config?.Labels?.["com.docker.compose.service"]) === service);
    assert.equal(matches.length, 1, "DEV review service ownership is ambiguous");
    const environment = environmentObject(matches[0].Config?.Env);
    assert.deepEqual(Object.fromEntries(fields.map((field) => [field, environment[field]])), expected, `${service} approved review auth changed`);
  }
}

export function captureDevReviewAuth(rows, approvedOrigins) {
  if (approvedOrigins === undefined) {
    const portal = rows.find((row) => (row.service ?? row.Config?.Labels?.["com.docker.compose.service"]) === "portal");
    const origin = environmentObject(portal?.Config?.Env).PORTAL_PUBLIC_ORIGIN;
    assert.ok(origin === undefined || ["http://127.0.0.1:3000", "http://localhost:3000"].includes(origin), "DEV public review configuration requires explicit origin admission");
    return undefined;
  }
  const value = devReviewAuthConfiguration(approvedOrigins);
  assertDevReviewAuthRows(value, rows);
  return value;
}

export function devReviewAuthEnvironment(value) {
  if (value !== undefined) assertDevReviewAuth(value);
  // Empty values suppress inherited/unreviewed overrides while retaining defaults.
  return Object.fromEntries(devReviewPortalFields.map((field) => [`WASALX_DEV_REVIEW_${field}`, value?.portal[field] ?? ""]));
}

export async function verifyDevReviewPublicRedirect(value, { fetch: fetchRequest = globalThis.fetch, timeoutMs = 8000 } = {}) {
  assertDevReviewAuth(value);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000, "DEV review redirect timeout is invalid");
  let response;
  try {
  response = await fetchRequest(new URL("/auth/login", value.portalOrigin), {
    method: "GET", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 307, "DEV public login did not produce its authorization redirect");
  const location = response.headers.get("location");
  assert.ok(location, "DEV public login redirect is missing");
  const target = new URL(location);
  assert.equal(target.origin, value.identityOrigin, "DEV login redirected outside its approved identity origin");
  assert.equal(target.pathname, "/realms/wasalx/protocol/openid-connect/auth", "DEV login redirected to another identity route");
  assert.ok(!target.username && !target.password && !target.hash, "DEV login redirect is invalid");
  for (const [name, expected] of [["client_id", "wasalx-portal"], ["response_type", "code"], ["redirect_uri", value.portal.OIDC_REDIRECT_URI], ["code_challenge_method", "S256"]]) {
    assert.deepEqual(target.searchParams.getAll(name), [expected], `DEV login ${name} is invalid`);
  }
  for (const name of ["state", "nonce", "code_challenge"]) {
    assert.equal(target.searchParams.getAll(name).length, 1, "DEV login transaction is invalid");
    assert.match(target.searchParams.get(name), /^[A-Za-z0-9_-]{43}$/u, "DEV login transaction is invalid");
  }
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const transactions = cookies.filter((cookie) => cookie.startsWith(`__Host-wasalx_oidc_${target.searchParams.get("state")}=`));
  assert.equal(transactions.length, 1, "DEV login secure transaction cookie is missing");
  const attributes = transactions[0].split(";").slice(1).map((part) => part.trim().toLowerCase());
  assert.ok(["secure", "httponly", "path=/", "samesite=lax"].every((attribute) => attributes.includes(attribute)) &&
    !attributes.some((attribute) => attribute.startsWith("domain=")), "DEV login transaction cookie protection changed");
  // No state, nonce, challenge, cookie value or full Location leaves memory.
  return { portalOrigin: value.portalOrigin, identityOrigin: value.identityOrigin, status: response.status,
    authorizationPath: target.pathname, callbackPath: "/auth/callback", clientId: "wasalx-portal", pkce: "S256", secureTransactionCookie: true, authenticatedSignInVerified: false };
  } catch {
    throw new Error("DEV public authorization redirect failed");
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

function candidateIdForService(service, catalog) {
  if (!service.build) return null;
  const dockerfile = (typeof service.build === "object" ? service.build.dockerfile : "Dockerfile")?.replaceAll("\\", "/");
  return catalog.images.find((image) => {
    const expected = image.dockerfile.replaceAll("\\", "/");
    return dockerfile === expected || dockerfile?.endsWith(`/${expected}`);
  })?.id ?? null;
}

function environmentObject(value) {
  if (!Array.isArray(value)) return value ?? {};
  return Object.fromEntries(value.map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

export function activeServiceNames(compose, profiles = []) {
  const selected = new Set(profiles);
  return Object.entries(compose.services ?? {})
    .filter(([, service]) => !service.profiles?.length || service.profiles.some((profileName) => selected.has(profileName)))
    .map(([name]) => name)
    .sort();
}

export function oneShotServiceNames(model, active) {
  return [...new Set(active.flatMap((name) => Object.entries(model.services[name].depends_on ?? {})
    .filter(([, dependency]) => dependency?.condition === "service_completed_successfully")
    .map(([dependency]) => dependency)))].filter((name) => active.includes(name)).sort();
}

export function verifyCandidateScope(catalog, candidateIds, requiredIds, fullCatalog = false) {
  const catalogIds = new Set(catalog.images.map(({ id }) => id));
  assert.equal(catalogIds.size, catalog.images.length, "release catalog image ids must be unique");
  const selected = new Set(candidateIds);
  assert.ok(candidateIds.every((id) => catalogIds.has(id)), "candidate image is absent from release/installer-images.json");
  assert.ok(requiredIds.every((id) => selected.has(id)), "candidate image inventory does not cover the active stack");
  const expected = fullCatalog ? [...catalogIds] : catalog.smokeImageIds;
  assert.ok(Array.isArray(expected), "release catalog smokeImageIds is missing");
  assert.deepEqual([...selected].sort(), [...expected].sort(),
    fullCatalog ? "full release requires every catalog image" : "Docker smoke requires the exact smoke image inventory");
}

export function assertSmokePorts(compose) {
  for (const name of ["portal", "control-api"]) {
    assert.ok(compose.services?.[name], `smoke service missing: ${name}`);
    assert.deepEqual(compose.services[name].ports ?? [], [], `smoke must not publish ${name} on the host`);
  }
}

export function projectStack({ compose, containers, imageInspections, catalog, candidateImages, candidateSha, candidateTree, imageSource, activeServices: selectedServices, repositoryRoot = root, fullCatalog = false, devPreimages = null, devFreshHeld = false }) {
  assert.match(candidateSha, shaPattern);
  assert.match(candidateTree, shaPattern);
  assert.ok(compose && typeof compose === "object" && !Array.isArray(compose), "Compose projection is invalid");
  const services = compose.services ?? {};
  const activeServices = selectedServices ?? Object.entries(services).filter(([, service]) => !(service.profiles?.length)).map(([name]) => name).sort();
  assert.equal(new Set(activeServices).size, activeServices.length, "active Compose services must be unique");
  assert.ok(activeServices.every((name) => services[name]), "active Compose service is missing from the rendered model");
  assert.deepEqual(containers.map((container) => container.service).sort(), activeServices, "Compose service inventory is incomplete or duplicated");
  const oneShotServices = oneShotServiceNames(compose, activeServices);
  if (devPreimages) assertDevInstallPreimages(devPreimages, {
    candidateSha, candidateTree, project: devPreimages.project, machineIdSha256: devPreimages.machineIdSha256, activeServices, model: compose,
  });
  assertDevReviewAuthRows(devPreimages?.devReviewAuth, containers);
  const freshHold = devFreshHeld ? devFreshHeldPlan(compose, activeServices) : null;
  const held = new Set(freshHold?.held ?? (devPreimages ? [...devHeldServices, ...Object.keys(devPreimages.heldPrerequisites ?? {})] : []));
  const preserved = new Set(devPreimages ? devPreservedServices : []);
  const imageByReference = new Map(imageInspections.map((image) => [image.reference, image.details]));
  assert.equal(imageByReference.size, imageInspections.length, "Docker image inspection references must be unique");
  const candidateById = new Map(candidateImages.map(({ id, reference }) => [id, reference]));
  assert.equal(candidateById.size, candidateImages.length, "candidate image ids must be unique");
  assert.equal(new Set(candidateImages.map(({ reference }) => reference)).size, candidateImages.length, "candidate image references must be unique");
  const requiredCandidateIds = activeServices.map((name) => candidateIdForService(services[name], catalog)).filter(Boolean);
  verifyCandidateScope(catalog, [...candidateById.keys()], requiredCandidateIds, fullCatalog);

  const inventory = new Map();
  const addImage = (details, { service = null, reference, candidateId = null }) => {
    assert.match(details?.Id ?? "", digestPattern, `image ${reference} has no immutable local image id`);
    const entry = inventory.get(details.Id) ?? {
      imageId: details.Id, services: new Set(), references: new Set(), candidateIds: new Set(), repoDigests: new Set(),
      sourceRevision: null, sourceTree: null, packageSha256: null,
    };
    if (service) entry.services.add(service);
    entry.references.add(reference);
    if (candidateId) {
      entry.candidateIds.add(candidateId);
      entry.sourceRevision = details.Config?.Labels?.["org.opencontainers.image.revision"] ?? null;
      entry.sourceTree = details.Config?.Labels?.["io.wasalx.source.tree"] ?? null;
      if (candidateId === "zammad") entry.packageSha256 = details.Config?.Labels?.["com.wasalx.zammad.package.sha256"] ?? null;
    }
    for (const digest of details.RepoDigests ?? []) entry.repoDigests.add(digest);
    inventory.set(details.Id, entry);
  };

  const serviceInventory = [];
  for (const container of [...containers].sort((left, right) => left.service.localeCompare(right.service))) {
    const definition = services[container.service];
    assert.ok(definition, `unknown Compose service: ${container.service}`);
    assert.ok(container.Config && container.State, `Docker inspect failed for ${container.service}`);
    const preservedOld = preserved.has(container.service);
    const configuredImageMatches = container.Config.Image === definition.image ||
      (container.Config.Image === container.Image && digestPattern.test(container.Image));
    if (preservedOld) assert.deepEqual(devContainerPreimage(container),
      devPreimages.services.find(({ service }) => service === container.service), `${container.service} preserved state changed`);
    else assert.ok(configuredImageMatches, `${container.service} is running another configured image`);
    const before = devPreimages?.services.find(({ service }) => service === container.service);
    assert.equal(container.RestartCount, held.has(container.service) && container.Id === before?.id ? before.restartCount : 0,
      `${container.service} restart history changed`);
    const oneShot = oneShotServices.includes(container.service);
    const configuredRestartPolicy = definition.restart ?? "no";
    const restartPolicy = container.HostConfig?.RestartPolicy?.Name || "no";
    assert.equal(restartPolicy, configuredRestartPolicy, `${container.service} runtime restart policy changed`);
    if (!held.has(container.service) && ["waha-gows", "waha-noweb"].includes(container.service)) {
      assert.equal(String(environmentObject(definition.environment).WAHA_WORKER_RESTART_SESSIONS ?? "").toLowerCase(), "true", `${container.service} must resume retained sessions after restart`);
      assert.equal(String(environmentObject(container.Config.Env).WAHA_WORKER_RESTART_SESSIONS ?? "").toLowerCase(), "true", `${container.service} runtime must resume retained sessions after restart`);
    }
    const healthcheck = container.Config.Healthcheck?.Test;
    const healthcheckRequired = Array.isArray(healthcheck) && healthcheck.length > 0 && healthcheck[0] !== "NONE";
    if (definition.healthcheck && definition.healthcheck.disable !== true) {
      assert.equal(healthcheckRequired, true, `${container.service} runtime healthcheck is disabled`);
    }
    if (held.has(container.service)) {
      assert.equal(container.State.Running, false); assert.equal(container.State.Pid, 0);
      assert.ok(["created", "exited"].includes(container.State.Status), `${container.service} hold was started`);
      assert.equal(container.State.Restarting ?? false, false);
      assert.equal(container.State.Paused, false); assert.equal(container.State.Dead, false);
      if (devFreshHeld && definition.read_only) assert.equal(container.HostConfig.ReadonlyRootfs, true);
      if (devPreimages && !preservedOld && !oneShot) {
        const before = devPreimages.services.find(({ service }) => service === container.service);
        assert.equal(container.HostConfig.ReadonlyRootfs, true);
        assert.deepEqual(devContainerPreimage(container).mounts, before.mounts, "readonly worker mounts changed");
      }
    } else if (oneShot) {
      assert.ok(["no", "on-failure"].includes(restartPolicy), `${container.service} has an invalid one-shot restart policy`);
      assert.equal(container.State.Status, "exited", `${container.service} one-shot did not exit`);
      assert.equal(container.State.ExitCode, 0, `${container.service} one-shot failed`);
    } else {
      assert.equal(container.State.Running, true, `${container.service} is not running`);
      assert.equal(container.State.Status, "running", `${container.service} is not in the running state`);
      assert.equal(container.State.Restarting ?? false, false, `${container.service} is restarting`);
      assert.equal(container.State.Paused, false, `${container.service} is paused`);
      if (healthcheckRequired)
        assert.equal(container.State.Health?.Status, "healthy", `${container.service} is unhealthy`);
    }
    const image = imageByReference.get(preservedOld ? container.Image : definition.image);
    assert.ok(image, `Docker image was not inspected: ${definition.image}`);
    assert.equal(container.Image, image.Id, `${container.service} container image id does not match its configured image`);
    const candidateId = preservedOld ? null : candidateIdForService(definition, catalog);
    if (preservedOld) {
      assert.equal(image.Id, container.Image);
      if (!definition.build) {
        assert.ok(configuredImageMatches, "preserved dependency image changed");
        assert.ok((image.RepoDigests ?? []).some((value) => repositoryDigestMatches(definition.image, value)), "preserved dependency digest mismatch");
      }
    } else if (definition.build) {
      assert.ok(typeof definition.build === "object" && !Array.isArray(definition.build), `${container.service} build definition is invalid`);
      assert.equal(resolve(definition.build.context ?? ""), resolve(repositoryRoot), `${container.service} build context is not the repository root`);
      assert.ok(candidateId, `${container.service} build is missing from release/installer-images.json`);
      assert.equal(candidateById.get(candidateId), definition.image, `${container.service} is not bound to its qualified candidate image`);
    } else {
      assert.ok((image.RepoDigests ?? []).some((value) => repositoryDigestMatches(definition.image, value)),
        `${container.service} pulled repository digest does not match Compose`);
    }
    addImage(image, { service: container.service, reference: preservedOld ? container.Image : definition.image, candidateId });
    serviceInventory.push({
      service: container.service,
      ...(devPreimages ? { installation: preservedOld ? "PRESERVED_NOT_INSTALLED" : "CANDIDATE_INSTALLED" } : {}),
      state: container.State.Status,
      health: oneShot || held.has(container.service) ? null : container.State.Health?.Status ?? null,
      image: preservedOld ? container.Config.Image : definition.image,
      imageId: image.Id,
      restartCount: container.RestartCount,
      startedAt: container.State.StartedAt ?? null,
      candidateId,
      oneShot,
      restartPolicy,
      healthcheckRequired,
      exitCode: container.State.ExitCode,
    });
  }

  for (const [candidateId, reference] of [...candidateById.entries()].sort()) {
    const image = imageByReference.get(reference);
    assert.ok(image, `candidate image was not inspected: ${candidateId}`);
    assert.equal(image.Config?.Labels?.["org.opencontainers.image.revision"], imageSource?.commit ?? candidateSha, `${candidateId} has another source revision`);
    assert.equal(image.Config?.Labels?.["io.wasalx.source.tree"], imageSource?.tree ?? candidateTree, `${candidateId} has another source tree`);
    if (candidateId === "zammad") {
      assert.equal(image.Config?.Labels?.["com.wasalx.zammad.package.sha256"], catalog.tenantProvisioning.package.sha256,
        "zammad has another WasalX package digest");
    }
    addImage(image, { reference, candidateId });
  }
  assert.equal(new Set(candidateImages.map(({ reference }) => imageByReference.get(reference)?.Id)).size, candidateImages.length,
    "candidate images must have unique immutable image ids");

  return {
    ...(devPreimages ? { heldServices: [...held].sort(), heldPrerequisites: devPreimages.heldPrerequisites ?? {}, preservedServices: [...preserved].sort(), fullLiveAcceptance: false } : {}),
    ...(freshHold ? { heldServices: freshHold.held, heldPrerequisites: freshHold.prerequisites, fullLiveAcceptance: false } : {}),
    oneShotServices,
    services: serviceInventory,
    images: [...inventory.values()].map((entry) => ({
      imageId: entry.imageId,
      services: [...entry.services].sort(),
      references: [...entry.references].sort(),
      candidateIds: [...entry.candidateIds].sort(),
      repoDigests: [...entry.repoDigests].sort(),
      sourceRevision: entry.sourceRevision,
      sourceTree: entry.sourceTree,
      packageSha256: entry.packageSha256,
    })).sort((left, right) => left.imageId.localeCompare(right.imageId)),
  };
}

function argumentsFrom(values) {
  const [project, ...rest] = values;
  const candidateImages = [];
  const composeFiles = [];
  const profiles = [];
  let output;
  let envFile;
  let full = false;
  let devPreimagesFile; let devPreimagesSha256;
  let rehearsalMain;
  let localRegistry;
  let devSkipPublicWebhookPreflight = false;
  let devFreshHeld = false; let devSimulator = false;
  for (let index = 0; index < rest.length;) {
    const option = rest[index];
    if (option === "--full") {
      assert.equal(full, false, "--full can be provided only once");
      full = true;
      index += 1;
      continue;
    }
    if (option === devSkipPublicWebhookPreflightFlag) {
      assert.equal(devSkipPublicWebhookPreflight, false, `${option} can be provided only once`);
      devSkipPublicWebhookPreflight = true;
      index += 1;
      continue;
    }
    if (option === devFreshHeldFlag || option === devSimulatorFlag) {
      assert.ok(option === devFreshHeldFlag ? !devFreshHeld : !devSimulator, `${option} can be provided only once`);
      if (option === devFreshHeldFlag) devFreshHeld = true;
      else devSimulator = true;
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    assert.ok(value, `${option ?? "argument"} requires a value`);
    if (option === "--candidate-image") {
      const [id, reference, ...extra] = value.split("=");
      assert.match(id, /^[a-z][a-z0-9-]+$/u);
      assert.ok(reference && extra.length === 0, "candidate image must be id=reference");
      candidateImages.push({ id, reference });
    } else if (option === "--compose-file") {
      composeFiles.push(value.replaceAll("\\", "/"));
    } else if (option === "--dev-preimages-sha256") {
      assert.equal(devPreimagesSha256, undefined); assert.match(value, /^[0-9a-f]{64}$/u); devPreimagesSha256 = value;
    } else if (option === "--dev-preimages") {
      assert.equal(devPreimagesFile, undefined); assert.ok(isAbsolute(value)); devPreimagesFile = value;
    } else if (option === "--profile") {
      profiles.push(value);
    } else if (option === "--output") {
      assert.equal(output, undefined, "--output can be provided only once");
      output = value.replaceAll("\\", "/");
    } else if (option === "--env-file") {
      assert.equal(envFile, undefined, "--env-file can be provided only once");
      envFile = value;
    } else if (option === "--local-registry") {
      assert.equal(localRegistry, undefined);
      assertLocalRegistry(value);
      localRegistry = value;
    } else if (option === "--rehearsal-main") {
      assert.equal(rehearsalMain, undefined);
      rehearsalMain = value;
    } else {
      assert.fail(`unknown stack verifier argument: ${option}`);
    }
    index += 2;
  }
  return { project, candidateImages, composeFiles, profiles, output, envFile, full, devPreimagesFile,
    devPreimagesSha256, rehearsalMain, localRegistry, devSkipPublicWebhookPreflight, devFreshHeld, devSimulator };
}

export async function verifyStack({ repositoryRoot: verificationRoot = root } = {}) {
  const root = resolve(verificationRoot);
  const candidateSha = process.env.WASALX_CANDIDATE_SHA;
  const candidateTree = process.env.WASALX_CANDIDATE_TREE;
  const parsed = argumentsFrom(process.argv.slice(2));
  const { project, candidateImages } = parsed;
  const guestFiles = devGuestComposeFiles(parsed);
  assert.ok(!parsed.devSimulator || parsed.devFreshHeld, devSimulatorSmokeOnly);
  const overlay = devWebhookPreflightOverlay(parsed);
  assert.match(candidateSha ?? "", shaPattern, "WASALX_CANDIDATE_SHA is required");
  assert.match(candidateTree ?? "", shaPattern, "WASALX_CANDIDATE_TREE is required");
  assert.match(project ?? "", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u, "Compose project is invalid");
  const requestedFiles = parsed.composeFiles.length ? parsed.composeFiles : ["compose.yaml", "compose.smoke.yaml"];
  const profiles = parsed.profiles;
  const fullMode = parsed.full;
  if (fullMode) assertInstallHostname();
  assert.ok(!parsed.rehearsalMain || (fullMode && !parsed.devPreimagesFile), "rehearsal requires the full synthetic stack");
  assert.ok(!parsed.devPreimagesFile || (fullMode && project === "wasalx-live" && JSON.stringify(profiles) === JSON.stringify(["full", "runtime-workers"])), "DEV preservation requires the exact existing DEV full profile");
  assert.equal(Boolean(parsed.devPreimagesFile), Boolean(parsed.devPreimagesSha256), "DEV preimage digest binding is required");
  const evidenceName = parsed.rehearsalMain ? "nightly-stack" : parsed.devPreimagesFile ? "dev-held-stack"
    : parsed.devFreshHeld ? "dev-fresh-held-stack" : fullMode ? "remote-full-stack" : "exact-stack";
  const fullComposeFiles = ["compose.yaml", "compose.full.yaml", ...(parsed.rehearsalMain ? [rehearsalComposeFile] : [])];
  assert.ok((fullMode && JSON.stringify(requestedFiles) === JSON.stringify(fullComposeFiles) &&
    (JSON.stringify(profiles) === JSON.stringify(["full"]) || JSON.stringify(profiles) === JSON.stringify(["full", "runtime-workers"])) && isAbsolute(parsed.envFile ?? "")) ||
    (!fullMode && JSON.stringify(requestedFiles) === JSON.stringify(["compose.yaml", "compose.smoke.yaml"]) && profiles.length === 0 && parsed.envFile === undefined),
    "stack verification supports only the smoke overlay or the exact full profile");
  assert.ok(!parsed.devFreshHeld || (!parsed.devPreimagesFile && JSON.stringify(profiles) === JSON.stringify(["full", "runtime-workers"])),
    "fresh held smoke requires the full DEV runtime profile");
  const composeFiles = [...requestedFiles, ...guestFiles, ...overlay];
  const evidenceFile = parsed.devFreshHeld ? `${evidenceName}-${project}` : evidenceName;
  const canonicalOutput = `output/release-evidence/${candidateSha}/${evidenceFile}.json`;
  const outputPath = parsed.output ?? canonicalOutput;
  assert.equal(outputPath, canonicalOutput,
    "stack verification output must be the candidate-scoped canonical path");
  const devPreimageBytes = parsed.devPreimagesFile ? await readFile(parsed.devPreimagesFile) : null;
  if (devPreimageBytes) assert.equal(createHash("sha256").update(devPreimageBytes).digest("hex"), parsed.devPreimagesSha256, "DEV preimage file changed");
  const devPreimages = devPreimageBytes ? JSON.parse(devPreimageBytes.toString("utf8")) : null;
  if (devPreimages) {
    assert.equal(devPreimages.candidateSha, candidateSha); assert.equal(devPreimages.candidateTree, candidateTree);
    assert.equal(devPreimages.project, project);
    assert.equal(devPreimages.machineIdSha256, createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex"));
  }
  const dockerEnvironment = { ...process.env, ...devReviewAuthEnvironment(devPreimages?.devReviewAuth), COMPOSE_PROFILES: "", PORTAL_FIXTURE_ROLE: "" };
  const run = (command, arguments_) => {
    const result = spawnSync(command, arguments_, { cwd: root, encoding: "utf8", env: dockerEnvironment });
    assert.equal(result.status, 0, `${command} ${arguments_.join(" ")} failed`);
    return result.stdout.trim();
  };
  assert.equal(run("git", ["rev-parse", "HEAD"]), candidateSha);
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"]), candidateTree);
  assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]), "", "candidate checkout is dirty");
  const imageSource = parsed.rehearsalMain ? rehearsalImageSource(project, parsed.rehearsalMain, args => run("git", args)) : undefined;
  if (fullMode) {
    assert.equal(process.env.DOCKER_HOST ?? "", "", "DOCKER_HOST is not allowed during stack verification");
    assert.equal(process.env.DOCKER_CONTEXT ?? "", "", "DOCKER_CONTEXT is not allowed during stack verification");
    assert.equal(run("docker", ["context", "show"]), "default", "stack verification requires the default Docker context");
  }
  const composeArguments = [
    "compose",
    ...(parsed.envFile ? ["--env-file", parsed.envFile] : []),
    ...composeFiles.flatMap((file) => ["--file", file]),
    ...profiles.flatMap((profileName) => ["--profile", profileName]),
    "--project-name", project,
  ];
  if (parsed.localRegistry) {
    assert.ok(fullMode, "local registry requires the full stack");
    const path = await localRegistryOverlay({ registry: parsed.localRegistry, project, envFile: parsed.envFile, profiles,
      render: () => JSON.parse(run("docker", [...composeArguments, "config", "--no-interpolate", "--no-env-resolution", "--format", "json"])) });
    composeFiles.push(path);
    composeArguments.push("--file", path);
  }
  run("docker", [...composeArguments, "config", "--quiet"]);
  const renderedCompose = run("docker", [
    ...composeArguments, "config", "--no-interpolate", "--no-env-resolution", "--format", "json",
  ]);
  const compose = JSON.parse(renderedCompose);
  if (!fullMode) assertSmokePorts(compose);
  const activeServices = activeServiceNames(compose, profiles);
  if (fullMode) assert.deepEqual(activeServices, [...expectedFullServices,...(profiles.includes("runtime-workers")?expectedRuntimeWorkerServices:[])].sort(), "the exact full Compose profile must contain the canonical services");
  const rowsText = run("docker", [...composeArguments, "ps", "--all", "--format", "json"]);
  let rows;
  try {
    const parsed = JSON.parse(rowsText);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = rowsText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
  const containers = rows.map((row) => {
    const [container] = JSON.parse(run("docker", ["inspect", row.ID]));
    return { ...container, service: row.Service };
  });
  const references = new Set(candidateImages.map(({ reference }) => reference));
  for (const name of activeServices) {
    const service = compose.services?.[name];
    assert.ok(service.image, `Compose service has no image: ${name}`);
    references.add(service.image);
    if (parsed.devPreimagesFile && devPreservedServices.includes(name)) references.add(containers.find((container) => container.service === name)?.Image);
  }
  const imageInspections = [...references].sort().map((reference) => ({
    reference,
    details: JSON.parse(run("docker", ["image", "inspect", reference]))[0],
  }));
  const catalog = JSON.parse(await readFile(resolve(root, "release/installer-images.json"), "utf8"));
  if (devPreimages) assertDevInstallPreimages(devPreimages, { candidateSha, candidateTree, project, activeServices, model: compose,
    machineIdSha256: createHash("sha256").update(await readFile("/etc/machine-id")).digest("hex") });
  const projection = projectStack({ compose, containers, imageInspections, catalog, candidateImages, candidateSha, candidateTree, imageSource,
    activeServices, fullCatalog: fullMode, devPreimages, devFreshHeld: parsed.devFreshHeld, repositoryRoot: root });
  if (fullMode) {
    assert.deepEqual(projection.oneShotServices, expectedFullOneShots, "the exact full stack one-shot inventory changed");
    const portalEnvironment = environmentObject(compose.services?.portal?.environment);
    assert.equal(portalEnvironment.PORTAL_DATA_BACKEND, "control-plane", "full portal is not connected to the control plane");
    assert.equal(portalEnvironment.NODE_ENV, "production", "full portal is not running in production mode");
    assert.equal(portalEnvironment.PORTAL_FIXTURE_ROLE ?? "", "", "full portal enables a fixture role");
  }
  const composeEvidence = await Promise.all(composeFiles.map(async (path) => {
    const bytes = await readFile(resolve(root, path));
    return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const machineId = (await readFile("/etc/machine-id", "utf8")).trim();
  assert.match(machineId, /^[0-9a-f]{32}$/u, "runtime machine identity is invalid");
  if (fullMode) {
    assertInstallHostname();
    assert.equal(platform(), "linux", "remote full verification requires Linux");
    assert.equal(arch(), "x64", "remote full verification requires x64");
  }
  assert.equal(run("git", ["rev-parse", "HEAD"]), candidateSha, "candidate revision changed during stack verification");
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"]), candidateTree, "candidate tree changed during stack verification");
  assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]), "", "candidate checkout changed during stack verification");
  const manifest = {
    schemaVersion: 1,
    kind: imageSource || devPreimages || parsed.devFreshHeld ? evidenceName : "exact-stack",
    candidateSha,
    candidateTree,
    clean: true,
    generatedAt: new Date().toISOString(),
    project,
    stackProfile: imageSource ? "nightly" : devPreimages ? "dev-held" : parsed.devFreshHeld ? "dev-fresh-held" : fullMode ? "remote-full" : "docker-smoke",
    ...(imageSource ? { imageSource } : {}),
    ...(parsed.devSkipPublicWebhookPreflight ? { devSkipPublicWebhookPreflight: true } : {}),
    ...(parsed.devSimulator ? { devSimulator: true } : {}),
    profiles,
    composeFiles: composeEvidence,
    renderedCompose: { bytes: Buffer.byteLength(renderedCompose), sha256: createHash("sha256").update(renderedCompose).digest("hex") },
    runtime: {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      machineIdSha256: createHash("sha256").update(machineId).digest("hex"),
    },
    ...(devPreimages ? { devPreimagesSha256: parsed.devPreimagesSha256 } : {}),
    ...projection,
    tools: {
      docker: run("docker", ["version", "--format", "{{.Client.Version}}"]),
      compose: run("docker", ["compose", "version", "--short"]),
    },
  };
  const output = await writeRepositoryJson(outputPath, manifest);
  process.stdout.write(`${output}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyStack().catch((error) => {
    // Parser and subprocess errors can contain private captured input.
    const variable = ["WASALX_INSTALL_EXPECTED_HOSTNAME", "WASALX_DEV_REVIEW_ORIGIN_SUFFIX"].find((name) => error.message?.includes(name));
    const reason = [devWebhookPreflightOnly, devGuestOnly, devSimulatorSmokeOnly].find(message => error.message === message)
      ?? (variable ? `check ${variable}` : "");
    process.stderr.write(`exact stack verification failed${reason ? `: ${reason}` : ""}\n`);
    process.exitCode = 1;
  });
}
