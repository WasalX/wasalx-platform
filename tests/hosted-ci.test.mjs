import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { collectFile, collectionFiles, inventory, isTestFile, shardFiles } from "../scripts/hosted-ci.mjs";
import { unitAllowlist, unitFiles } from "../scripts/test-unit.mjs";
import { addonSkips, skipPattern } from "../scripts/hosted-ci-policy.mjs";
import { generateBaseline } from "../scripts/generate-hosted-ci-baseline.mjs";
import baseline from "../scripts/hosted-ci-baseline.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFile(join(repository, file), "utf8");
const commands = text => text.split(/\n|&&|;/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
const words = text => Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|([^\s"'()]+)/gu),
  ([, doubleQuoted, singleQuoted, bare]) => doubleQuoted ?? singleQuoted ?? bare);

function runsFile(text, file, option) {
  return commands(text).some(command => {
    const [exe, ...args] = words(command);
    if (!["node", "python", "python3", "ruby", "bash"].includes(exe) || (option && !args.includes(option))) return false;
    const paths = args.map(arg => arg.replace(/^\.\//u, ""));
    if (args.includes("unittest") && args.includes("discover")) {
      return paths[args.indexOf("-s") + 1] === posix.dirname(file) && paths[args.indexOf("-p") + 1] === posix.basename(file);
    }
    return exe === "node" && args.includes("--test") ? paths.includes(file) : paths.find(arg => !arg.startsWith("-")) === file;
  });
}

function referencesFile(source, file) {
  return source.includes(`"${file}"`) || source.includes(`'${file}'`);
}

const tofuFile = file => /^infra\/terraform\/tests\/[^/]+\.tftest\.(?:hcl|json)$/u.test(file);
const postgresFile = file => /^tests\/.*(?:-postgres(?:-check)?|-real-schema-check)\.mjs$/u.test(file);

test("tracked tests belong to a named CI runner or the test allowlist", async () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "tests", "infra/terraform/tests", "scripts", ".github/workflows",
    ":(glob)**/*.test.*", ":(glob)**/*.rb", ":(glob)**/*.py", ":(glob)**/*.bats",
    ":(glob)**/test_*.sh", ":(glob)**/test-*.sh", ":(glob)**/*_test.sh", ":(glob)**/*-test.sh"], {
    cwd: repository, encoding: "utf8", windowsHide: true,
  }).split("\0").filter(Boolean);
  const trackedSet = new Set(tracked);
  const testFiles = new Set(tracked.filter(file =>
    /(?:^|\/)[^/]+\.test\.[^/]+$/u.test(file) || tofuFile(file) || postgresFile(file)
    || /(?:^|\/)(?:test[-_][^/]+|[^/]+[-_]test)\.(?:py|rb|sh)$|\.bats$/u.test(file)
    || /^tests\/.*(?:\.spec\.[^/]+|(?:-native|-integration|-scenario|_spec)\.rb|-browser\.mjs)$/u.test(file)
    || /^scripts\/test-(?:.+\.sh|postgres-integration\.mjs)$/u.test(file)));
  // Some executable test files predate the naming conventions.
  for (const file of tracked.filter(file => /\.(?:py|rb)$/u.test(file) && !testFiles.has(file))) {
    if (/\bunittest\.TestCase\b|\bfrom unittest import .*\bTestCase\b|\b(?:(?:MiniTest|Minitest)::(?:Test|Spec)|Test::Unit::TestCase)\b|\brequire\s+["'](?:minitest\/autorun|test\/unit)["']/u.test(await read(file))) {
      testFiles.add(file);
    }
  }

  const units = new Set(unitFiles);
  const { scripts } = JSON.parse(await read("package.json"));
  const workflows = tracked.filter(file => file.startsWith(".github/workflows/") && /\.ya?ml$/u.test(file));
  const workflowJobs = new Map(await Promise.all(workflows.map(async file =>
    [file, parse(await read(file)).jobs])));
  const jobs = { ...workflowJobs.get(".github/workflows/ci.yml"), ...workflowJobs.get(".github/workflows/nightly-install.yml") };
  const runText = job => (job.steps ?? []).map(step => step.run ?? "").join("\n");
  const ciCommands = [...workflowJobs.values()].flatMap(workflow => Object.values(workflow).map(runText)).join("\n");
  const ciScripts = new Set(commands(ciCommands).map(command => {
    const [exe, action, script] = words(command);
    return exe === "pnpm" && (action === "run" ? script : action);
  }).filter(script => script && Object.hasOwn(scripts, script)));
  const runnerNames = [...Object.keys(jobs), ...ciScripts];
  const runnerText = runner => Object.hasOwn(jobs, runner) ? runText(jobs[runner])
    : Object.hasOwn(scripts, runner) ? scripts[runner] : "";
  assert(runsFile(runnerText("checks"), "scripts/hosted-ci.mjs", "unit"), "The unit inventory must run in CI");

  const unitWrappers = await Promise.all(["tests/application-e2e-harness.test.mjs", "tests/ci-phase-admission.test.mjs",
    "tests/simulation-native-isolation.test.mjs"].filter(file => units.has(file)).map(read));
  const postgresImports = new Set();
  if (runsFile(runnerText("test:postgres"), "scripts/test-postgres-integration.mjs")) {
    postgresImports.add("scripts/test-postgres-integration.mjs");
    for (const entry of postgresImports) {
      for (const [, relative] of (await read(entry)).matchAll(/^import\s+(?:[^;]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gmu)) {
        const dependency = posix.join(posix.dirname(entry), relative);
        if (dependency.startsWith("tests/") && trackedSet.has(dependency)) postgresImports.add(dependency);
      }
    }
  }
  const [validation, zammadImage, zammadBrowser, application, identity, storybook, visualHarness, storybookRunner, applicationRunner] =
    await Promise.all(["scripts/validate-infra.sh", "infra/docker/Dockerfile.zammad", "tests/zammad-image-browser-compat.test.mjs",
      "playwright.application.config.ts", "playwright.identity.config.ts", "playwright.storybook.config.ts",
      "tests/visual/inbox-synthetic.spec.ts", "scripts/storybook-visual-regression.mjs", "scripts/run-application-e2e.mjs"].map(read));
  const runsTofu = /^\s+"\$\{TOFU\[@\]\}" -chdir=infra\/terraform test -no-color$/mu.test(validation)
    && /^run_terraform_tests$/mu.test(validation);

  function runnerRuns(runner, file) {
    const command = runnerText(runner);
    if (runsFile(command, file)) return true;
    switch (runner) {
      case "checks":
        return file.endsWith(".py") && unitWrappers.some(source =>
          referencesFile(source, file) || referencesFile(source, file.replace(/^tests\//u, "./")));
      case "infra-validate":
        return commands(command).includes("bash scripts/validate-infra.sh")
          && (runsFile(validation, file) || (runsTofu && tofuFile(file)));
      case "test:postgres":
        return postgresImports.has(file);
      case "images": {
        const copiedPath = `/tmp/${posix.basename(file)}`;
        return runsFile(command, "scripts/release/images-by-digest.py", "build")
          && zammadImage.split(/\r?\n/u).some(line => line.startsWith("COPY ") && line.endsWith(` ${file} ${copiedPath}`))
          && zammadImage.includes(`RUN bundle exec ruby ${copiedPath} `);
      }
      case "test:unit":
        return isTestFile(file) && runsFile(command, "scripts/test-unit.mjs");
      case "zammad:compat:browser":
        return runsFile(command, "tests/zammad-image-browser-compat.test.mjs")
          && (referencesFile(zammadBrowser, file)
            || (posix.dirname(file) === "tests" && referencesFile(zammadBrowser, posix.basename(file))));
      case "test:e2e":
        return runsFile(command, "scripts/run-application-e2e.mjs")
          && referencesFile(applicationRunner, "playwright.application.config.ts")
          && referencesFile(application, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(application, posix.basename(file));
      case "playwright.identity.config.ts":
        return referencesFile(identity, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(identity, posix.basename(file));
      case "test:visual":
        return runsFile(command, "scripts/storybook-visual-regression.mjs")
          && referencesFile(storybookRunner, "playwright.storybook.config.ts")
          && referencesFile(storybook, "./tests/visual")
          && ((posix.dirname(file) === "tests/visual" && /\.spec\.[cm]?[jt]sx?$/u.test(file)) || referencesFile(visualHarness, file));
      default:
        return false;
    }
  }

  const ciRuns = file => units.has(file) || runnerNames.some(runner => runnerRuns(runner, file));
  const missing = [...testFiles].filter(file => !ciRuns(file) && !Object.hasOwn(unitAllowlist, file));
  const stale = Object.entries(unitAllowlist).filter(([file, { reason }]) =>
    !testFiles.has(file) || units.has(file) || (/^not run in CI:/u.test(reason) && ciRuns(file))).map(([file]) => file);
  const invalid = Object.entries(unitAllowlist).filter(([file, { runner, reason }]) => {
    if (typeof runner !== "string" || typeof reason !== "string" || !reason.trim() || /[\r\n]/u.test(reason)) return true;
    if (runnerNames.includes(runner)) return /^not run in CI:/u.test(reason.trimStart()) || !runnerRuns(runner, file);
    return !/^not run in CI: \S/u.test(reason) || !(runnerRuns(runner, file) || runsFile(runner, file));
  }).map(([file]) => file);
  assert.deepEqual({ missing, stale, invalid }, { missing: [], stale: [], invalid: [] });
});

test("nightly install is report-only, read-only and fails open on PR diff errors", async () => {
  const path = ".github/workflows/nightly-install.yml";
  const { on, permissions, jobs } = parse(await read(path));
  const job = jobs["nightly-install"];
  assert.deepEqual(on, {
    schedule: [{ cron: "30 3 * * *" }],
    workflow_dispatch: null,
    pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
  });
  assert.deepEqual(permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const actions = job.steps.filter(step => step.uses);
  assert(actions.every(step => /@[0-9a-f]{40}$/u.test(step.uses)));
  assert.equal(actions.find(step => step.uses.startsWith("actions/checkout@")).with["persist-credentials"], false);
  assert(!JSON.stringify(job).includes("secrets."));
  const changes = job.steps.find(step => step.id === "changes").run;
  assert.match(changes, /needed=true\nif git diff --quiet[^]*; then\n {2}needed=false\nfi/u);
  for (const input of ["scripts/release/installer-*", "compose*.yaml", path, "release/installer-images.json",
    "scripts/release/compose-stage-lock.mjs", "scripts/release/compose-stage-config.json", "scripts/release/simulation-rails-json.mjs",
    "scripts/installer-evidence.mjs", "infra/docker/full/**"]) assert(changes.includes(input));
  assert(job.steps.some(step => step.if?.startsWith("always()")));
  assert(!parse(await read(".github/workflows/ci.yml")).jobs["ci-gate"].needs.includes("nightly-install"));
});

test("nightly MinIO mirrors retain the full installer content digests", async () => {
  const loadServices = async file => parse(await read(file), { logLevel: "silent" }).services;
  const [full, nightly] = await Promise.all([
    loadServices("compose.full.yaml"),
    loadServices("scripts/release/installer-nightly.compose.yaml"),
  ]);
  for (const [service, repositoryName] of [["minio", "minio"], ["minio-bootstrap", "mc"]]) {
    const [repository, digest] = nightly[service].image.split("@");
    assert.equal(repository, `ghcr.io/wasalx/${repositoryName}`);
    assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(digest, full[service].image.split("@")[1]);
  }
});

test("MinIO mirror is dispatch-only on main and verifies the raw manifest digest", async t => {
  const { on, permissions, jobs } = parse(await read(".github/workflows/mirror-images.yml"));
  const { mirror } = jobs;
  assert.deepEqual(on, { workflow_dispatch: null });
  assert.deepEqual(permissions, {});
  assert.deepEqual(Object.keys(jobs), ["mirror"]);
  assert.deepEqual(mirror.permissions, { contents: "read", packages: "write" });
  assert.equal(mirror.if, "github.repository == 'WasalX/wasalx-platform' && github.ref == 'refs/heads/main'");
  assert.equal(mirror["runs-on"], "ubuntu-24.04");
  const actions = mirror.steps.filter(step => step.uses);
  assert(actions.every(step => /@[0-9a-f]{40}$/u.test(step.uses)));
  assert.equal(actions.find(step => step.uses.startsWith("actions/checkout@")).with["persist-credentials"], false);
  assert.equal(actions.find(step => step.uses.startsWith("docker/login-action@")).with.password, "${{ github.token }}");
  assert(!JSON.stringify(mirror).includes("secrets."));

  const copy = mirror.steps.find(step => step.run);
  assert.equal(copy.shell, "bash");
  const index = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { digest: `sha256:${"a".repeat(64)}`, platform: { architecture: "amd64", os: "linux" } },
    { digest: `sha256:${"b".repeat(64)}`, platform: { architecture: "arm64", os: "linux" } },
  ] }, null, 2);
  const manifest = '{"schemaVersion":2, "mediaType":"application/vnd.oci.image.manifest.v1+json", "layers":[]}';
  const digest = raw => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "wasalx-minio-mirror-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "compose.full.yaml"), `services:
  minio:
    image: quay.io/minio/minio:release@${digest(index)}
  minio-bootstrap:
    image: quay.io/minio/mc:release@${digest(manifest)}
`);

  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const [scenario, expectedStatus] of [
    ["quay", 0], ["fallback", 0], ["source-mismatch", 1], ["mirror-mismatch", 1], ["inspect-failure", 7],
  ]) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `docker() {
  [[ "$1 $2" == 'buildx imagetools' ]] || exit 98
  local reference="\${!#}"
  case "$3:$reference" in
    create:quay.io/minio/*@sha256:*|create:ghcr.io/netvark/*@sha256:*)
      [[ "$4 $5" == '--prefer-index=false --tag' ]] || exit 98
      echo "Copy $reference"
      [[ "$SCENARIO" != fallback || "$reference" == ghcr.io/netvark/* ]]
      ;;
    inspect:ghcr.io/wasalx/*:sha256-*|inspect:*@sha256:*)
      [[ "$# $4" == '5 --raw' ]] || exit 98
      case "$reference:$SCENARIO" in
        ghcr.io/wasalx/*:mirror-mismatch|*@sha256:*:source-mismatch) printf '%s' wrong; return ;;
      esac
      case "$reference" in
        */minio[@:]*) printf '%s' "$RAW_INDEX" ;;
        */mc[@:]*) printf '%s' "$RAW_MANIFEST" ;;
        *) exit 98 ;;
      esac
      if [[ "$SCENARIO" == inspect-failure ]]; then return 7; fi
      ;;
    *) exit 98 ;;
  esac
}
${copy.run}`], {
      cwd: directory, env: { ...process.env, SCENARIO: scenario, RAW_INDEX: index, RAW_MANIFEST: manifest },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, expectedStatus, result.error?.message ?? result.stdout);
    assert.equal(result.stdout.includes("Copy ghcr.io/netvark/"), scenario === "fallback");
    if (expectedStatus === 0) {
      assert(result.stdout.includes(`Verified ghcr.io/wasalx/minio@${digest(index)}`));
      assert(result.stdout.includes(`Verified ghcr.io/wasalx/mc@${digest(manifest)}`));
    } else if (expectedStatus === 1) {
      assert.match(result.stdout, /::error::Digest mismatch/u);
    }
  }
});

test("CI gates integration and infrastructure and runs portal integration files serially", async () => {
  const { on, jobs } = parse(await read(".github/workflows/ci.yml"));
  const { integration, "ci-gate": gate, "dev-install-dryrun": dryrun } = jobs;
  assert(Object.hasOwn(on, "workflow_dispatch"));
  assert(Object.hasOwn(on, "merge_group"));
  assert.deepEqual(on.push.branches, ["main"]);
  assert.equal(integration.if, "github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')");
  assert.equal(integration["timeout-minutes"], 25);
  assert.deepEqual(integration.permissions, { contents: "read" });
  assert.match(integration.services.postgres.image, /^postgres:[^@]+@sha256:[a-f0-9]{64}$/u);
  const devPreflightFile = "tests/installer-dev-recreatability.test.mjs";
  const devPreflight = jobs.checks.steps.find(step => runsFile(step.run ?? "", devPreflightFile));
  assert.equal(devPreflight?.if, "github.event_name == 'pull_request' && matrix.mode == 'unit' && matrix.shard == 1");
  assert(integration.steps.some(step => !step.if && runsFile(step.run ?? "", devPreflightFile)));
  const dryrunFile = "scripts/dev-install/test_dryrun.py";
  assert(integration.steps.some(step => !step.if && runsFile(step.run ?? "", dryrunFile, "--container")));
  assert(dryrun.steps.some(step => !step.if && runsFile(step.run ?? "", dryrunFile, "--container")));
  assert.equal(dryrun.needs, "changes");
  assert.equal(dryrun.if, "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.dev-install != 'false' }}");
  const portalIntegration = integration.steps.find(step => step.name === "Test portal and tenant integration");
  assert.match(portalIntegration?.run, /^node --test --test-concurrency=1 /u);
  assert(gate.needs.includes("integration"));
  assert(gate.needs.includes("dev-install-dryrun"));
  const [gateStep] = gate.steps;
  assert.equal(gateStep.env.INTEGRATION, "${{ needs.integration.result }}");
  assert.equal(gateStep.env.DEV_INSTALL_NEEDED, "${{ needs.changes.outputs.dev-install }}");
  assert.equal(gateStep.env.DEV_INSTALL, "${{ needs.dev-install-dryrun.result }}");
  assert.equal(gateStep.run, `test "$CHANGES" = success && test "$CHECKS" = success || exit 1
case "$EVENT:$REVIEW:$IMAGES_NEEDED:$IMAGES:$INTEGRATION" in
  pull_request:success:false:skipped:skipped|pull_request:success:true:success:skipped) ;;
  merge_group:skipped:false:skipped:success|merge_group:skipped:true:success:success) ;;
  *) exit 1 ;;
esac
case "$EVENT:$DEV_INSTALL_NEEDED:$DEV_INSTALL" in
  pull_request:*:success|pull_request:false:skipped|merge_group:*:skipped) ;;
  *) exit 1 ;;
esac
test "$INFRA" = success || {
  test "$EVENT" = pull_request && test "$INFRA_NEEDED" = false && test "$INFRA" = skipped
}
`);
  for (const job of [jobs.changes, jobs.checks]) {
    assert.equal(job.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  }
});

test("optional PR lanes run on diff errors and gate their applicable checks", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const { "infra-validate": job, "ci-gate": gate, changes } = jobs;
  const [gateStep] = gate.steps;
  assert(!Object.hasOwn(jobs, "terraform-test"));
  assert.equal(job.needs, "changes");
  assert.equal(job.if, "${{ !cancelled() && (github.event_name == 'merge_group' || (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.infra != 'false'))) }}");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.deepEqual(job.steps.slice(-2).map(({ run, if: condition }) => [run, condition]), [
    ["bash scripts/validate-infra.sh", undefined],
    ["bash scripts/validate-infra.sh --terraform-test-only", undefined],
  ]);
  assert(gate.needs.includes("infra-validate"));
  assert.equal(gateStep.env.INFRA, "${{ needs.infra-validate.result }}");
  assert.equal(gateStep.env.INFRA_NEEDED, "${{ needs.changes.outputs.infra }}");
  assert.equal(changes.outputs.infra, "${{ steps.infra.outputs.needed }}");
  assert.equal(changes.outputs["dev-install"], "${{ steps.dev-install.outputs.needed }}");
  const paths = [
    "infra/helm/", "infra/terraform/", ":(glob)scripts/validate-*", "scripts/release/fetch-verified-asset.sh",
    "compose.full.yaml", "tests/fixtures/production-backup-alerts.yaml", "tests/secret-adapter-readiness.test.rb",
    ".github/workflows/ci.yml",
  ].join(" ");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const run = (script, env) => spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  const directory = await mkdtemp(join(tmpdir(), "wasalx-infra-validate-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [id, diffPaths] of [
    ["infra", paths],
    ["dev-install", ["scripts/dev-install/", "scripts/release/installer-stages.mjs",
      "scripts/release/installer-stack.mjs", "scripts/release/compose-stage-lock.mjs",
      "scripts/release/compose-stage-config.json", ".github/workflows/ci.yml"].join(" ")],
  ]) {
    const detector = changes.steps.find(step => step.id === id);
    assert.equal(detector.if, "github.event_name == 'pull_request'");
    for (const [status, needed] of [[0, false], [1, true], [128, true]]) {
      const outputFile = join(directory, `${id}-${status}`);
      const result = run(`git() {
  test "$*" = "diff --quiet --no-ext-diff --no-renames HEAD^1 HEAD -- $DIFF_PATHS" || exit 99
  return "$DIFF_STATUS"
}
${detector.run}`, { GITHUB_OUTPUT: outputFile.replaceAll("\\", "/"), DIFF_PATHS: diffPaths, DIFF_STATUS: String(status) });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal((await readFile(outputFile, "utf8")).trim(), `needed=${needed}`);
    }
  }
  for (const [event, needed, jobResult, status] of [
    ["pull_request", "true", "success", 0],
    ["pull_request", "false", "skipped", 0],
    ["pull_request", "", "skipped", 1],
    ["pull_request", "true", "skipped", 1],
    ["pull_request", "false", "failure", 1],
    ["pull_request", "false", "cancelled", 1],
    ["merge_group", "", "success", 0],
    ["merge_group", "false", "skipped", 1],
    ["merge_group", "", "failure", 1],
  ]) {
    const pr = event === "pull_request";
    const result = run(gateStep.run, {
      EVENT: event, CHANGES: "success", CHECKS: "success", REVIEW: pr ? "success" : "skipped",
      IMAGES_NEEDED: "false", IMAGES: "skipped", INTEGRATION: pr ? "skipped" : "success",
      DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
      INFRA_NEEDED: needed, INFRA: jobResult,
    });
    assert.equal(result.status, status, `${event}/${needed}/${jobResult}: ${result.error?.message ?? result.stderr}`);
  }
  for (const [needed, jobResult, status] of [
    ["true", "success", 0], ["false", "skipped", 0], ["true", "skipped", 1], ["", "skipped", 1],
    ["true", "failure", 1], ["true", "cancelled", 1],
  ]) {
    const result = run(gateStep.run, {
      EVENT: "pull_request", CHANGES: "success", CHECKS: "success", REVIEW: "success",
      IMAGES_NEEDED: "false", IMAGES: "skipped", INTEGRATION: "skipped",
      DEV_INSTALL_NEEDED: needed, DEV_INSTALL: jobResult, INFRA_NEEDED: "false", INFRA: "skipped",
    });
    assert.equal(result.status, status, `dev-install/${needed}/${jobResult}: ${result.error?.message ?? result.stderr}`);
  }
});

test("shards cover each file once regardless of inventory order or duplicates", () => {
  const files = ["d", "a", "b", "c", "a"];
  const shards = [1, 2, 3].map(shard => shardFiles(files, shard, 3));
  assert.deepEqual(shards, [["a", "d"], ["b"], ["c"]]);
  assert.deepEqual(shards.flat().sort(), ["a", "b", "c", "d"]);
  assert.throws(() => shardFiles(files, 0, 3));
  assert.throws(() => shardFiles(files, 4, 3));
  assert.throws(() => shardFiles(files, 1, 0));
});

test("measured sharding spreads slow files and packs the remaining work", () => {
  const durations = { a: 10, b: 9, c: 8, d: 7, e: 6, f: 5 };
  const files = Object.keys(durations).reverse();
  const shards = [1, 2, 3].map(shard => shardFiles(files, shard, 3, durations));
  assert.deepEqual(shards, [["a", "f"], ["b", "e"], ["c", "d"]]);
});

test("collection includes allowlisted imports and discovers nested test extensions", () => {
  const nested = ["tests/nested/new.test.mts", "tests/nested/new.test.cts", "tests/nested/new.test.tsx"];
  const files = inventory([...nested, nested[0], "tests/fixture.mjs", "tests/zammad-sidebar-component/view.test.tsx"]);
  assert.equal(files.filter(file => nested.includes(file)).length, nested.length);
  assert(!files.includes("tests/fixture.mjs"));
  assert(!files.includes("tests/zammad-sidebar-component/view.test.tsx"));
  const allowlisted = ["tests/installer-preimage.test.mjs", "tests/storybook-static-contract.test.mjs"];
  const excluded = [
    "tests/dev-secret-sidecar.test.mjs", "tests/visual/renderer.test.mjs", "tests/zammad-image-browser-compat.test.mjs",
    "tests/portal-security-headers.test.mjs", "tests/rendered-html.test.mjs",
  ];
  assert.deepEqual(collectionFiles([...allowlisted, ...excluded]), allowlisted);
});

test("collection succeeds when there are no additional files to collect", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-empty-collection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { cwd: directory, env: { ...process.env, GITHUB_STEP_SUMMARY: "" }, encoding: "utf8", windowsHide: true };
  execFileSync("git", ["init", "--quiet"], options);
  const script = fileURLToPath(new URL("../scripts/hosted-ci.mjs", import.meta.url));
  assert.match(execFileSync(process.execPath, [script, "collection"], options), /^no additional files to collect$/mu);
});

test("collection skips test bodies, reports import errors and kills hanging imports", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-ci-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = join(directory, "valid.mjs"), invalid = join(directory, "invalid.mjs"), hanging = join(directory, "hanging.mjs");
  const body = join(directory, "body-ran");
  await writeFile(valid, "import { writeFileSync } from 'node:fs'; import test from 'node:test'; "
    + "test('skipped body', () => writeFileSync(" + JSON.stringify(body) + ", 'ran'));\n");
  await writeFile(invalid, "throw new Error('IMPORT_FAILED');\n");
  await writeFile(hanging, "setInterval(()=>{},1000); await new Promise(()=>{});\n");
  assert.equal((await collectFile(valid)).failed, false);
  await assert.rejects(readFile(body), { code: "ENOENT" });
  const failure = await collectFile(invalid);
  assert.equal(failure.failed, true);
  const timeout = await collectFile(hanging, 2000);
  assert.equal(timeout.failed, true);
  assert.equal(timeout.diagnostic, "Collection import timed out");
});

test("add-on exceptions bind exact entrypoints and names and disappear as inputs arrive", async t => {
  assert.equal(baseline.tests.length, 10);
  assert.equal(new Set(baseline.tests.map(entry => entry.file + "::" + entry.name)).size, 9);
  assert.deepEqual(addonSkips("tests/unlisted.test.mjs", () => false), []);
  for (const entry of baseline.tests) {
    assert.equal(entry.reason, "needs the add-on source");
    assert(addonSkips(entry.entrypoint, () => false).includes(entry));
    assert(!addonSkips(entry.entrypoint, input => input === entry.input).includes(entry));
  }
  const directory = await mkdtemp(join(tmpdir(), "hosted-addon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.mjs");
  const name = baseline.tests[0].name;
  const pattern = skipPattern([{ name }]);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = args => spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...args, file], { env, encoding: "utf8", windowsHide: true });
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name)},()=>{throw Error('ADDON_TEST_EXECUTED')});\n`);
  assert.equal(run([`--test-skip-pattern=${pattern}`]).status, 0);
  assert.equal(run([]).status, 1);
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name + " new")},()=>{throw Error('UNLISTED_FAILURE')});\n`);
  assert.equal(run([`--test-skip-pattern=${pattern}`]).status, 1);
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name)},()=>{throw Error('FOREIGN_FILE_FAILURE')});\n`);
  assert.equal(addonSkips(file).length, 0);
  assert.equal(run([]).status, 1);
  assert(new RegExp(skipPattern([{ name: "literal (name) [x].*" }])).test("literal (name) [x].*"));
});

test("baseline generation retains every logged failure and rejects unclassified failures", () => {
  const root = "/home/runner/work/wasalx-platform/wasalx-platform/";
  const line = (job, text) => `${job}\tstep\t${text}`;
  const failures = Array.from({ length: 10 }, (_, i) => [
    line("Unit 1/6", `test at tests/case-${i}.test.mjs:1:1`),
    line("Unit 1/6", `✖ case ${i} (0.1ms)`),
    line("Unit 1/6", `  Error: ENOENT: no such file or directory, open '${root}zammad-package/file-${i}.rb'`),
  ]).flat();
  const log = failures.join("\n");
  const generated = generateBaseline(log);
  assert.equal(generated.tests[9].name, "case 9");
  assert.equal(generated.tests[9].input, "zammad-package/file-9.rb");
  assert.throws(() => generateBaseline(log.replace("open '", "unexpected '")));
});
