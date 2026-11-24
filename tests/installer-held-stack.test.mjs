import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fsPromises, { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { activeServiceNames, projectStack, devFreshHeldPlan, devHeldServices, devPreservedServices, devContainerPreimage, devValueDigest, assertInstallHostname, devReviewAuthConfiguration, rehearsalImageSource, stackVerificationDiagnostic, verifyStack } from "../scripts/release/installer-stack.mjs";
import { executeStage, run, stageFailureReason } from "../scripts/release/installer-stages.mjs";
import { repositoryDigestMatches } from "../scripts/installer-evidence.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha = "a".repeat(40);
const tree = "b".repeat(40);

test("pinned image evidence recognizes exact Docker Hub registry aliases", () => {
  const digest = `@sha256:${"c".repeat(64)}`;
  assert.ok(repositoryDigestMatches(`postgres:17${digest}`, `registry-1.docker.io/library/postgres${digest}`));
  assert.ok(repositoryDigestMatches(`index.docker.io/postgres${digest}`, `docker.io/library/postgres${digest}`));
  const explicitPort = `index.docker.io:443/library/postgres${digest}`;
  assert.ok(repositoryDigestMatches(explicitPort, explicitPort));
  for (const registry of ["index.docker.io.example.test", "example.test.index.docker.io", "index.docker.io:443"]) {
    assert.equal(repositoryDigestMatches(`postgres${digest}`, `${registry}/library/postgres${digest}`), false);
  }
  const malformed = `registry.example.test?invalid/library/postgres${digest}`;
  assert.equal(repositoryDigestMatches(malformed, malformed), false);
});

function operatorEnvironment(t, name) {
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("installer hostname requires explicit configuration and exact equality", t => {
  operatorEnvironment(t, "WASALX_INSTALL_EXPECTED_HOSTNAME");
  t.mock.method(os, "hostname", () => "synthetic-install-vm");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  delete process.env.WASALX_INSTALL_EXPECTED_HOSTNAME;
  assert.throws(assertInstallHostname, /WASALX_INSTALL_EXPECTED_HOSTNAME is required/);
  for (const value of ["", "   "]) {
    process.env.WASALX_INSTALL_EXPECTED_HOSTNAME = value;
    assert.throws(assertInstallHostname, /WASALX_INSTALL_EXPECTED_HOSTNAME is required/);
  }
  for (const value of ["wrong-vm", "install-vm", "synthetic-install-vm.extra"]) {
    process.env.WASALX_INSTALL_EXPECTED_HOSTNAME = value;
    assert.throws(assertInstallHostname, /does not match WASALX_INSTALL_EXPECTED_HOSTNAME/);
  }
  process.env.WASALX_INSTALL_EXPECTED_HOSTNAME = "synthetic-install-vm";
  assert.doesNotThrow(assertInstallHostname);
});

test("DEV review origins require an explicit matching literal suffix", t => {
  operatorEnvironment(t, "WASALX_DEV_REVIEW_ORIGIN_SUFFIX");
  const origins = { portalOrigin: "https://guest.review.example.test", identityOrigin: "https://guest.review.example.test:8443" };
  delete process.env.WASALX_DEV_REVIEW_ORIGIN_SUFFIX;
  assert.throws(() => devReviewAuthConfiguration(origins), /WASALX_DEV_REVIEW_ORIGIN_SUFFIX is required/);
  for (const value of ["", "   "]) {
    process.env.WASALX_DEV_REVIEW_ORIGIN_SUFFIX = value;
    assert.throws(() => devReviewAuthConfiguration(origins), /WASALX_DEV_REVIEW_ORIGIN_SUFFIX is required/);
  }
  process.env.WASALX_DEV_REVIEW_ORIGIN_SUFFIX = ".review.example.test";
  assert.equal(devReviewAuthConfiguration(origins).portalOrigin, origins.portalOrigin);
  for (const host of ["guest.other.example.test", "guest.review.example.test.extra"]) {
    assert.throws(() => devReviewAuthConfiguration({ portalOrigin: `https://${host}`, identityOrigin: `https://${host}:8443` }), /matching WASALX_DEV_REVIEW_ORIGIN_SUFFIX/);
  }
  assert.throws(() => devReviewAuthConfiguration({ ...origins, portalOrigin: origins.portalOrigin.replace("https:", "http:") }));
  assert.throws(() => devReviewAuthConfiguration({ ...origins, identityOrigin: "https://other.review.example.test:8443" }), /another host/);
});

test("installer CLIs name refused host configuration before preflight or Docker", () => {
  const envFile = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const stageArgs = ["scripts/release/installer-stages.mjs", "preflight", "--env-file", envFile, "--project-name", "wasalx-live"];
  const stackArgs = ["scripts/release/installer-stack.mjs", "wasalx-live", "--full"];
  for (const [args, variable, value] of [
    [stageArgs, "WASALX_INSTALL_EXPECTED_HOSTNAME", undefined],
    [stackArgs, "WASALX_INSTALL_EXPECTED_HOSTNAME", undefined],
    [stageArgs, "WASALX_INSTALL_EXPECTED_HOSTNAME", `${os.hostname()}-wrong`],
    [stackArgs, "WASALX_INSTALL_EXPECTED_HOSTNAME", `${os.hostname()}-wrong`],
    [[...stageArgs, "--dev-review-origin", "https://guest.review.example.test", "--dev-review-identity-origin", "https://guest.review.example.test:8443"], "WASALX_DEV_REVIEW_ORIGIN_SUFFIX", undefined],
  ]) {
    const env = { ...process.env, WASALX_CANDIDATE_SHA: sha, WASALX_CANDIDATE_TREE: tree, WASALX_INSTALL_EXPECTED_HOSTNAME: os.hostname() };
    if (value === undefined) delete env[variable];
    else env[variable] = value;
    const result = spawnSync(process.execPath, ["--", ...args], { cwd: repositoryRoot, env, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`check ${variable}`));
    assert.equal(result.stdout, "");
  }
});

test("both installer CLIs admit webhook preflight skip only for non-rehearsal DEV", () => {
  const envFile = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const flag = "--dev-skip-public-webhook-preflight";
  for (const [project, extra, markers, expected] of [
    ["wasalx-stg", [], {}, /public webhook preflight skip is DEV-only/],
    ["wasalx-prod", [], {}, /public webhook preflight skip is DEV-only/],
    ["wasalx-nightly", [], {}, /public webhook preflight skip is DEV-only/],
    ["wasalx-live", ["--rehearsal-main", sha], { GITHUB_ACTIONS: "true" }, /public webhook preflight skip is DEV-only/],
    ["wasalx-live", [], { DEPLOY_ENVIRONMENT: "stg" }, /public webhook preflight skip is DEV-only/],
    ["wasalx-live", [], { WASALX_ENVIRONMENT: "production" }, /public webhook preflight skip is DEV-only/],
    ["wasalx-dev-bc3ef42", [], {}, /check WASALX_INSTALL_EXPECTED_HOSTNAME/],
    ["wasalx-live", [], {}, /check WASALX_INSTALL_EXPECTED_HOSTNAME/],
  ]) {
    const env = { ...process.env, WASALX_CANDIDATE_SHA: sha, WASALX_CANDIDATE_TREE: tree,
      WASALX_INSTALL_EXPECTED_HOSTNAME: "", DEPLOY_ENVIRONMENT: "", WASALX_ENVIRONMENT: "", ...markers };
    for (const args of [
      ["scripts/release/installer-stages.mjs", "preflight", "--env-file", envFile, "--project-name", project],
      ["scripts/release/installer-stack.mjs", project, "--full", "--env-file", envFile],
    ]) {
      const result = spawnSync(process.execPath, ["--", ...args, flag, ...extra], {
        cwd: repositoryRoot, env, encoding: "utf8", timeout: 10000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected, `${args[0]} ${project}`);
      assert.equal(result.stdout, "");
    }
  }
});

test("installer smoke forwards the DEV option and verifies the selected Compose files", async t => {
  const envFile = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const originalArgv = process.argv;
  t.after(() => { process.argv = originalArgv; });
  for (const [name, value] of Object.entries({
    WASALX_CANDIDATE_SHA: sha, WASALX_CANDIDATE_TREE: tree, WASALX_INSTALL_EXPECTED_HOSTNAME: os.hostname(),
    DOCKER_HOST: "", DOCKER_CONTEXT: "", DEPLOY_ENVIRONMENT: "", WASALX_ENVIRONMENT: "",
  })) {
    operatorEnvironment(t, name);
    process.env[name] = value;
  }
  const rendered = new Error("reached Compose config");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args) => {
    if (command === "git") return { status: 0, stdout: { HEAD: sha, "HEAD^{tree}": tree }[args[1]] ?? "" };
    assert.equal(command, "docker");
    if (args[0] === "context") return { status: 0, stdout: "default" };
    throw rendered;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const [project, skip, simulator] of [
    ["wasalx-live", false, false], ["wasalx-live", true, false], ["wasalx-dev-bc3ef42", true, false],
    ["wasalx-dev-fresh", true, true],
  ]) {
    await executeStage("smoke", { project, envFile, plan: [], model: { services: {} }, devSkipPublicWebhookPreflight: skip,
      devFreshHeld: simulator, devSimulator: simulator, command: (command, args) => { process.argv = [command, ...args]; return 0; },
    });
    await assert.rejects(verifyStack(), error => error === rendered);
    assert.deepEqual(spawn.mock.calls.at(-1).arguments.slice(0, 2), ["docker", [
      "compose", "--env-file", envFile, "--file", "compose.yaml", "--file", "compose.full.yaml",
      ...(simulator ? ["--file", "scripts/release/installer-nightly.compose.yaml", "--file", "scripts/release/installer-dev-simulator.compose.yaml"] : []),
      ...(skip ? ["--file", "scripts/release/installer-dev-skip-webhook.compose.yaml"] : []),
      "--profile", "full", "--profile", "runtime-workers", "--project-name", project, "config", "--quiet",
    ]]);
  }
});

test("fresh guest options are explicit and fail closed in both installer CLIs", () => {
  const envFile = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  for (const [project, markers, flags, expected] of [
    ["wasalx-dev-fresh", {}, ["--dev-fresh-held"], /check WASALX_INSTALL_EXPECTED_HOSTNAME/],
    ["wasalx-dev-fresh", {}, ["--dev-fresh-held", "--dev-simulator"], /check WASALX_INSTALL_EXPECTED_HOSTNAME/],
    ["wasalx-live", {}, ["--dev-fresh-held"], /fresh held and simulator options require a side-by-side DEV project/],
    ["wasalx-nightly", { GITHUB_ACTIONS: "true" }, ["--dev-fresh-held", "--dev-simulator"], /fresh held and simulator options require a side-by-side DEV project/],
    ["wasalx-prod", {}, ["--dev-fresh-held", "--dev-simulator"], /fresh held and simulator options require a side-by-side DEV project/],
    ["wasalx-dev-fresh", { DEPLOY_ENVIRONMENT: "stg" }, ["--dev-fresh-held", "--dev-simulator"], /fresh held and simulator options require a side-by-side DEV project/],
    ["wasalx-dev-fresh", {}, ["--dev-simulator"], /simulator (replacement|smoke) requires --dev-fresh-held/],
  ]) {
    const env = { ...process.env, WASALX_CANDIDATE_SHA: sha, WASALX_CANDIDATE_TREE: tree,
      WASALX_INSTALL_EXPECTED_HOSTNAME: "", DEPLOY_ENVIRONMENT: "", WASALX_ENVIRONMENT: "", ...markers };
    for (const args of [
      ["scripts/release/installer-stages.mjs", "replace", "--env-file", envFile, "--project-name", project],
      ["scripts/release/installer-stack.mjs", project, "--full", "--env-file", envFile],
    ]) {
      const result = spawnSync(process.execPath, ["--", ...args, ...flags], {
        cwd: repositoryRoot, env, encoding: "utf8", timeout: 10000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected, `${args[0]} ${project}`);
      assert.equal(result.stdout, "");
    }
  }
});

test("DEV preflight overlay only runs a local notice", async () => {
  const overlay = await readFile(new URL("../scripts/release/installer-dev-skip-webhook.compose.yaml", import.meta.url), "utf8");
  const command = ["node", "--eval", "console.log('public webhook preflight skipped by DEV option')"];
  assert.deepEqual(parse(overlay), { services: { "public-webhook-preflight": { command } } });
  const result = spawnSync(process.execPath, command.slice(1), { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "public webhook preflight skipped by DEV option\n");
});

test("installer prints a sanitized reason for a failure before the stage loop", () => {
  const path = fileURLToPath(new URL("./missing-installer-env", import.meta.url));
  const args = ["scripts/release/installer-stages.mjs", "replace", "--env-file", path,
    "--project-name", "wasalx-live", "--hosted-images", path];
  const result = spawnSync(process.execPath, ["--", ...args], { cwd: repositoryRoot, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "remote full qualification failed\nremote full qualification reason: hosted inventory hash required\n");
});

test("installer subprocess failures retain a bounded stderr tail with sensitive values redacted", () => {
  const token = "A1b2C3d4".repeat(6);
  const environment = { ...process.env, INSTALLER_TEST_SECRET: "short.+ fixture secret", INSTALLER_TEST_WORKERS: "2",
    INSTALLER_TEST_OVERLAP_PREFIX: "cache-a1", INSTALLER_TEST_OVERLAP_SUFFIX: "a1Xy9z" };
  const stderr = [
    "discarded start", "padding ".repeat(300), "invalid Compose interpolation for APP_PORT",
    `APP_PASSWORD="quoted password" ${environment.INSTALLER_TEST_SECRET} Bearer small-token ${token}`,
    "POSTGRES_PASSWORD: hunter2pass",
    "META_APP_SECRET: abcd1234",
    '{"client_secret":"abc123def","DB_TOKEN": "tok999"}',
    '{"oauth_private_key_path":"fixture-pem","login_credential":"fixture-code","db_pwd_hint":"fixture-hint"}',
    'private-key-v2="fixture-assign"',
    "overlap cache-a1Xy9z",
  ].join("\n");
  const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`;
  assert.throws(() => run(process.execPath, ["-e", script], environment), error => {
    const reason = stageFailureReason(error);
    assert.ok(Buffer.byteLength(reason) <= Buffer.byteLength(`${process.execPath} failed: `) + 2048);
    assert.match(reason, /invalid Compose interpolation for APP_PORT/u);
    assert.match(reason, /APP_PASSWORD=\[redacted\]/u);
    assert.match(reason, /private-key-v\[redacted\]=\[redacted\]/u);
    assert.match(reason, /overlap \[redacted\]$/u);
    for (const value of ["discarded start", "quoted password", environment.INSTALLER_TEST_SECRET, "small-token", token,
      "hunter2pass", "abcd1234", "abc123def", "tok999", "fixture-pem", "fixture-code", "fixture-hint", "fixture-assign"]) {
      assert.ok(!reason.includes(value), "stderr retained an unredacted fixture value");
    }
    assert.ok(reason.includes('"client_secret":[redacted],"DB_TOKEN": [redacted]'));
    return true;
  });
});

function stackFixture() {
  const candidateReference = "wasalx/portal:test";
  const thirdPartyDigest = `sha256:${"2".repeat(64)}`;
  const thirdPartyReference = `postgres:17@${thirdPartyDigest}`;
  const candidateDetails = { Id: `sha256:${"1".repeat(64)}`, RepoDigests: [], Config: {
    Labels: { "org.opencontainers.image.revision": sha, "io.wasalx.source.tree": tree },
    Healthcheck: { Test: ["CMD", "true"] },
  } };
  const thirdPartyDetails = { Id: `sha256:${"3".repeat(64)}`, RepoDigests: [`postgres@${thirdPartyDigest}`], Config: {
    Labels: {}, Healthcheck: { Test: ["CMD", "true"] },
  } };
  const compose = { services: {
    app: { image: candidateReference, build: { context: repositoryRoot, dockerfile: "Dockerfile.portal" }, restart: "unless-stopped", healthcheck: { test: ["CMD", "true"] }, depends_on: { migrate: { condition: "service_completed_successfully" } } },
    migrate: { image: candidateReference, build: { context: repositoryRoot, dockerfile: "Dockerfile.portal" }, restart: "no" },
    postgres: { image: thirdPartyReference, restart: "unless-stopped", healthcheck: { test: ["CMD", "true"] } },
  } };
  const running = (service, reference, image, health = "healthy") => ({
    service, Config: { Image: reference, Healthcheck: image.Config.Healthcheck }, Image: image.Id, RestartCount: 0,
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    State: { Status: "running", Running: true, Paused: false, ExitCode: 0, Health: { Status: health }, StartedAt: "2026-08-24T09:00:00.000Z" },
  });
  const containers = [
    running("app", candidateReference, candidateDetails),
    { service: "migrate", Config: { Image: candidateReference, Healthcheck: candidateDetails.Config.Healthcheck },
      HostConfig: { RestartPolicy: { Name: "no" } }, Image: candidateDetails.Id, RestartCount: 0,
      State: { Status: "exited", Running: false, Paused: false, ExitCode: 0, StartedAt: "2026-08-24T09:00:00.000Z" } },
    running("postgres", thirdPartyReference, thirdPartyDetails),
  ];
  return {
    compose, containers,
    imageInspections: [{ reference: candidateReference, details: candidateDetails }, { reference: thirdPartyReference, details: thirdPartyDetails }],
    catalog: { smokeImageIds: ["portal"], images: [{ id: "portal", dockerfile: "Dockerfile.portal" }, { id: "zammad", dockerfile: "infra/docker/Dockerfile.zammad" }] },
    candidateImages: [{ id: "portal", reference: candidateReference }], candidateSha: sha, candidateTree: tree, repositoryRoot,
  };
}

test("nightly stack verifies the Zammad package pinned by the signed image source", t => {
  operatorEnvironment(t, "GITHUB_ACTIONS");
  process.env.GITHUB_ACTIONS = "true";
  const sourceCommit = "c".repeat(40);
  const sourceTree = "d".repeat(40);
  const sourcePackage = "e".repeat(64);
  const candidatePackage = "f".repeat(64);
  const source = rehearsalImageSource("wasalx-nightly", sourceCommit, args => {
    if (args[0] === "rev-list") return `${sha}\n${sourceCommit}`;
    if (args[0] === "rev-parse") return sourceTree;
    assert.deepEqual(args, ["show", `${sourceCommit}:release/installer-images.json`]);
    return JSON.stringify({ tenantProvisioning: { package: { sha256: sourcePackage } } });
  });

  const fixture = stackFixture();
  fixture.catalog.tenantProvisioning = { package: { sha256: candidatePackage } };
  fixture.catalog.smokeImageIds.push("zammad");
  const reference = "wasalx/zammad:test";
  fixture.candidateImages.push({ id: "zammad", reference });
  const labels = {
    "org.opencontainers.image.revision": sourceCommit,
    "io.wasalx.source.tree": sourceTree,
    "com.wasalx.zammad.package.sha256": sourcePackage,
  };
  fixture.imageInspections[0].details.Config.Labels = { ...labels };
  fixture.imageInspections.push({ reference, details: { Id: `sha256:${"7".repeat(64)}`, Config: { Labels: labels } } });

  const observed = projectStack({ ...fixture, imageSource: source }).images.find(row => row.candidateIds.includes("zammad"));
  assert.equal(observed.packageSha256, sourcePackage);
  labels["com.wasalx.zammad.package.sha256"] = candidatePackage;
  assert.throws(() => projectStack({ ...fixture, imageSource: source }), error => {
    assert.equal(stackVerificationDiagnostic(error),
      "check=zammad-package-digest reason=image package digest differs from the source catalog pin");
    return true;
  });

  for (const details of [fixture.imageInspections[0].details, fixture.imageInspections[2].details]) {
    details.Config.Labels["org.opencontainers.image.revision"] = sha;
    details.Config.Labels["io.wasalx.source.tree"] = tree;
  }
  assert.doesNotThrow(() => projectStack(fixture));
});

test("stack smoke diagnostic identifies the assertion without private input or absolute paths", () => {
  const error = new Error("private fixture value");
  error.code = "ERR_ASSERTION";
  error.stack = "Error: private fixture value\n    at verifyStack (/private/path/scripts/release/installer-stack.mjs:123:1)";
  assert.equal(stackVerificationDiagnostic(error), "check=installer-stack.mjs:123 reason=stack assertion failed");
});

function devHeldStackFixture() {
  const fixture = stackFixture();
  const oneShots = devPreservedServices.filter((name) => !devHeldServices.includes(name) && name !== "zammad-backup");
  const names = [...new Set([...devHeldServices, ...devPreservedServices, "control-api"])];
  for (const name of names) {
    const oneShot = oneShots.includes(name);
    fixture.compose.services[name] = structuredClone(fixture.compose.services[oneShot ? "migrate" : "app"]);
    const row = structuredClone(fixture.containers[oneShot ? 1 : 0]); row.service = name;
    row.Id = String(names.indexOf(name)+1).padStart(64,"0"); row.HostConfig.ReadonlyRootfs = true;
    row.State.Pid = name === "zammad-backup" ? 100 : 0; row.State.Dead = false;
    if (devHeldServices.includes(name) || oneShot || name === "control-api") {
      row.State.Running = false; row.State.Status = "exited";
    }
    fixture.containers.push(row);
    if (oneShot) fixture.compose.services.app.depends_on[name] = { condition: "service_completed_successfully" };
  }
  for (const [index,row] of fixture.containers.entries()) row.Id ??= String(index+100).padStart(64,"0");
  const oldImageId=`sha256:${"4".repeat(64)}`;
  const oldDetails=structuredClone(fixture.imageInspections[0].details);oldDetails.Id=oldImageId;
  oldDetails.Config.Labels["org.opencontainers.image.revision"]="c".repeat(40);
  oldDetails.Config.Labels["io.wasalx.source.tree"]="d".repeat(40);
  fixture.imageInspections.push({reference:oldImageId,details:oldDetails});
  for(const row of fixture.containers.filter(row=>devPreservedServices.includes(row.service))){row.Image=oldImageId;row.Config.Image="wasalx/zammad:0.5.55";}
  fixture.activeServices = Object.keys(fixture.compose.services).sort();
  fixture.devPreimages = {
    schemaVersion:1, kind:"dev-held-install-preimages", candidateSha:sha, candidateTree:tree,
    project:"wasalx-live", machineIdSha256:"f".repeat(64), heldServices:[...devHeldServices].sort(),
    preservedServices:[...devPreservedServices].sort(),
    services:fixture.containers.map(devContainerPreimage).sort((a,b)=>a.service.localeCompare(b.service)),
    nativeSync:{tableExists:false,pending:0,unavailableCount:0,unavailableSha256:devValueDigest([])},
  };
  fixture.containers.find(row=>row.service==="control-api").State = structuredClone(fixture.containers[0].State);
  for (const name of ["connector-worker","identity-policy-activator","invitation-mailer"]) fixture.containers.find(row=>row.service===name).State.Status="created";
  return fixture;
}

test("DEV stack smoke preserves a failed held prerequisite and still refuses a non-held success-dependent", () => {
  const fixture = devHeldStackFixture();
  for (const service of Object.values(fixture.compose.services)) delete service.depends_on?.["public-webhook-preflight"];
  fixture.compose.services["waha-gows"].depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  fixture.devPreimages.heldPrerequisites = { "public-webhook-preflight": ["waha-gows"] };
  fixture.devPreimages.heldServices.push("public-webhook-preflight"); fixture.devPreimages.heldServices.sort();
  fixture.containers.find(row => row.service === "public-webhook-preflight").State.ExitCode = 1;
  fixture.devPreimages.services.find(row => row.service === "public-webhook-preflight").exitCode = 1;
  const projection = projectStack(fixture);
  assert.deepEqual(projection.heldPrerequisites, fixture.devPreimages.heldPrerequisites);
  assert.equal(projection.services.find(row => row.service === "public-webhook-preflight").exitCode, 1);
  fixture.compose.services.app.depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  assert.throws(() => projectStack(fixture), /held prerequisites changed/);
});

test("held-stack smoke accepts recorded historical restarts and refuses subsequent changes", () => {
  const fixture = devHeldStackFixture();
  const held = fixture.containers.find(row => row.service === "connector-worker");
  held.RestartCount = 1;
  fixture.devPreimages.services.find(row => row.service === held.service).restartCount = 1;
  assert.equal(projectStack(fixture).services.find(row => row.service === held.service).restartCount, 1);
  held.RestartCount = 2;
  assert.throws(() => projectStack(fixture), /restart history changed/);
});

test("held-stack smoke requires zero restarts for new held containers and non-held containers", () => {
  const fixture = devHeldStackFixture();
  const held = fixture.containers.find(row => row.service === "connector-worker");
  fixture.devPreimages.services.find(row => row.service === held.service).restartCount = 1;
  held.Id = "e".repeat(64);
  assert.doesNotThrow(() => projectStack(fixture));
  held.RestartCount = 1;
  assert.throws(() => projectStack(fixture), /restart history changed/);
  held.RestartCount = 0;
  fixture.containers.find(row => row.service === "app").RestartCount = 1;
  assert.throws(() => projectStack(fixture), /restart history changed/);
});

function freshHeldStackFixture() {
  const fixture = devHeldStackFixture();
  delete fixture.devPreimages;
  fixture.devFreshHeld = true;
  fixture.imageInspections.pop();
  for (const row of fixture.containers) {
    row.Image = fixture.imageInspections.find(({ reference }) => reference === fixture.compose.services[row.service].image).details.Id;
    row.Config.Image = fixture.compose.services[row.service].image;
    if (devHeldServices.includes(row.service) || row.service === "public-webhook-preflight") {
      row.State.Status = "created";
      row.State.StartedAt = "0001-01-01T00:00:00Z";
    }
  }
  const { services } = fixture.compose;
  for (const service of Object.values(services)) delete service.depends_on?.["public-webhook-preflight"];
  services["waha-gows"].depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  services["connector-worker"].read_only = true;
  return fixture;
}

test("fresh held smoke requires stopped holds and checks every other service normally", () => {
  const fixture = freshHeldStackFixture();
  assert.throws(() => projectStack({ ...fixture, devFreshHeld: false }), /is not running|must resume|one-shot did not exit/);
  assert.doesNotThrow(() => projectStack(fixture));
  const sender = fixture.containers.find(row => row.service === "connector-worker");
  sender.State.Running = true;
  assert.throws(() => projectStack(fixture));
  sender.State.Running = false;
  fixture.containers.find(row => row.service === "app").State.Health.Status = "unhealthy";
  assert.throws(() => projectStack(fixture), /app is unhealthy/);
  fixture.compose.services.app.depends_on["waha-gows"] = { condition: "service_healthy" };
  assert.throws(() => projectStack(fixture), /app depends on held service waha-gows/);
});

test("fresh held smoke rejects started holds and names the service", () => {
  const fixture = freshHeldStackFixture();
  for (const service of ["connector-worker", "public-webhook-preflight"]) {
    const row = fixture.containers.find(item => item.service === service);
    const created = row.State;
    for (const state of [
      { Status: "exited", StartedAt: "2026-08-24T09:00:00Z" },
      { Status: "running", Running: true, Pid: 100 },
      { Status: "paused", Running: true, Paused: true, Pid: 100 },
      { Status: "restarting", Restarting: true },
      { Status: "dead", Dead: true },
      { Status: "removing" },
    ]) {
      row.State = { ...created, ...state };
      assert.throws(() => projectStack(fixture), { message: service + " fresh hold must be in the created state" });
    }
    row.State = created;
  }
});

test("fresh held smoke checks the runtime root filesystem of a read-only service", () => {
  const fixture = freshHeldStackFixture();
  assert.doesNotThrow(() => projectStack(fixture));
  fixture.containers.find(row => row.service === "connector-worker").HostConfig.ReadonlyRootfs = false;
  assert.throws(() => projectStack(fixture), { code: "ERR_ASSERTION" });
});

test("fresh held plan refuses an incomplete hold inventory", () => {
  const { compose, activeServices } = freshHeldStackFixture();
  assert.throws(() => devFreshHeldPlan(compose, activeServices.filter(name => name !== "connector-worker")),
    /fresh DEV hold inventory is incomplete/u);
});

for (const [key, value] of [
  ["links", ["waha-gows:sender"]],
  ["volumes_from", ["waha-gows:ro"]],
  ["network_mode", "service:waha-gows"],
  ["ipc", "service:waha-gows"],
  ["pid", "service:waha-gows"],
]) {
  test("fresh held plan rejects a held dependency in " + key, () => {
    const { compose, activeServices } = freshHeldStackFixture();
    compose.services.app[key] = value;
    assert.throws(() => devFreshHeldPlan(compose, activeServices), /app depends on held service waha-gows/u);
  });
}

test("fresh held simulator smoke writes a project-scoped receipt with hold evidence", async t => {
  const directory = await mkdtemp(join(os.tmpdir(), "wasalx-held-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalArgv = process.argv;
  t.after(() => { process.argv = originalArgv; });
  const project = "wasalx-dev-fresh";
  const profiles = ["full", "runtime-workers"];
  process.argv = ["node", "installer-stack.mjs", project, "--full", "--dev-fresh-held", "--dev-simulator",
    "--env-file", join(directory, "fixture.env"), "--profile", profiles[0], "--profile", profiles[1],
    "--compose-file", "compose.yaml", "--compose-file", "compose.full.yaml"];
  for (const [name, value] of Object.entries({
    WASALX_CANDIDATE_SHA: sha, WASALX_CANDIDATE_TREE: tree, WASALX_INSTALL_EXPECTED_HOSTNAME: "fixture",
    DOCKER_HOST: "", DOCKER_CONTEXT: "", DEPLOY_ENVIRONMENT: "", WASALX_ENVIRONMENT: "",
  })) {
    operatorEnvironment(t, name);
    process.env[name] = value;
  }

  const fullCompose = parse(await readFile(new URL("../compose.full.yaml", import.meta.url), "utf8"), { merge: true, logLevel: "error" });
  const names = activeServiceNames(fullCompose, profiles);
  const { reference: image, details } = stackFixture().imageInspections[1];
  const services = Object.fromEntries(names.map(name => [name, { image }]));
  const prerequisite = "public-webhook-preflight";
  const oneShots = ["full-qualification-seed", "keycloak-bootstrap", "migrate", "minio-bootstrap",
    "runtime-role-bootstrap", "zammad-activation", "zammad-init", "zammad-package", "zammad-runtime-bootstrap"];
  const completed = { condition: "service_completed_successfully" };
  services.portal.depends_on = Object.fromEntries(oneShots.map(name => [name, completed]));
  services.portal.environment = { PORTAL_DATA_BACKEND: "control-plane", NODE_ENV: "production" };
  services["waha-gows"].depends_on = { [prerequisite]: completed };
  const held = [...devHeldServices, prerequisite].sort();
  const containers = Object.fromEntries(names.map(name => {
    const running = !held.includes(name) && !oneShots.includes(name);
    return [name, {
      Id: name, Config: { Image: image }, Image: details.Id, RestartCount: 0, HostConfig: {},
      State: { Status: running ? "running" : held.includes(name) ? "created" : "exited", Running: running,
        Pid: running ? 100 : 0, Paused: false, Dead: false, ExitCode: 0,
        StartedAt: held.includes(name) ? "0001-01-01T00:00:00Z" : "2026-08-24T09:00:00Z" },
    }];
  }));
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    let stdout;
    if (command === "git") stdout = { HEAD: sha, "HEAD^{tree}": tree }[args[1]] ?? "";
    else if (args[0] === "context") stdout = "default";
    else if (args[0] === "image") stdout = JSON.stringify([details]);
    else if (args[0] === "inspect") stdout = JSON.stringify([containers[args[1]]]);
    else if (args.includes("config")) stdout = JSON.stringify({ services });
    else if (args.includes("ps")) stdout = JSON.stringify(names.map(name => ({ ID: name, Service: name })));
    else if (args.includes("version")) stdout = "1.0.0";
    else assert.fail("Unexpected stack verification command");
    return { status: 0, stdout };
  });
  const originalReadFile = fsPromises.readFile;
  t.mock.method(fsPromises, "readFile", (path, ...args) => {
    if (path === "/etc/machine-id") return Promise.resolve("a".repeat(32));
    if (path === resolve(repositoryRoot, "release", "installer-images.json")) return Promise.resolve('{"images":[]}');
    return originalReadFile(path, ...args);
  });
  const originalRealpath = fsPromises.realpath;
  t.mock.method(fsPromises, "realpath", (path, ...args) => originalRealpath(path === resolve(repositoryRoot) ? directory : path, ...args));
  t.mock.method(os, "hostname", () => "fixture");
  t.mock.method(os, "platform", () => "linux");
  t.mock.method(os, "arch", () => "x64");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const manifest = await verifyStack();
  const path = join(directory, "output", "release-evidence", sha, "dev-fresh-held-stack-" + project + ".json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(receipt, manifest);
  assert.equal(receipt.kind, "dev-fresh-held-stack");
  assert.equal(receipt.stackProfile, "dev-fresh-held");
  assert.equal(receipt.project, project);
  assert.equal(receipt.devSimulator, true);
  assert.equal(receipt.fullLiveAcceptance, false);
  assert.deepEqual(receipt.heldServices, held);
  assert.deepEqual(receipt.heldPrerequisites, { [prerequisite]: ["waha-gows"] });
  for (const service of held) {
    const row = receipt.services.find(item => item.service === service);
    assert.equal(row.state, "created");
    assert.equal(row.startedAt, "0001-01-01T00:00:00Z");
    assert.equal(row.health, null);
  }
});
