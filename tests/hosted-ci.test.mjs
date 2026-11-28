import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { collectFile, collectionFiles, inventory, isTestFile, shardFiles } from "../scripts/hosted-ci.mjs";
import { selectUnitFiles } from "../scripts/affected-unit-tests.mjs";
import { unitAddonSources, validateUnitAddonInputs } from "../scripts/fetch-zammad-addon.mjs";
import { unitAllowlist, unitFiles } from "../scripts/test-unit.mjs";
import { reportTimingsWithQuarantine, validateQuarantine } from "../scripts/hosted-ci-timing-reporter.mjs";
import { parsePostgresShardArgs, postgresScenarioGroups, verifyPostgresReports } from "../scripts/postgres-scenario-registry.mjs";
import { discoverBrowserCases } from "../scripts/release/browser-shards.mjs";
import { journeyCapturePaths } from "./e2e/journey-captures.mjs";
import { operatorCaseProgress } from "./support/operator-case-progress.mjs";
import { cleanupKeycloakIdentity } from "./support/hosted-keycloak-cleanup.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFile(join(repository, file), "utf8");
const cosignAction = "./.github/actions/cosign";
const commands = text => text.split(/\n|&&|;/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
const words = text => Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|([^\s"'()]+)/gu),
  ([, doubleQuoted, singleQuoted, bare]) => doubleQuoted ?? singleQuoted ?? bare);

function runsFile(text, file, option) {
  return commands(text).some(command => {
    let w = words(command);
    if (w[0] === "sudo") w = w.slice(1);
    const [exe, ...args] = w;
    if (!["node", "python", "python3", "ruby", "bash"].includes(exe) || (option && !args.includes(option))) return false;
    const paths = args.map(arg => arg.replace(/^\.\//u, ""));
    if (args.includes("unittest") && args.includes("discover")) {
      return paths[args.indexOf("-s") + 1] === posix.dirname(file) && paths[args.indexOf("-p") + 1] === posix.basename(file);
    }
    return exe === "node" && args.includes("--test") ? paths.includes(file) : paths.find(arg => !arg.startsWith("-")) === file;
  });
}

test("test quarantine expires at midnight UTC and annotates failures only", async () => {
  for (const { file } of validateQuarantine()) assert(unitFiles.includes(file), file + " is not a unit test file");

  const file = "tests/hosted-ci.test.mjs";
  const known = { file, name: "example failure", owner: "test maintainer", expiresOn: "2030-01-02" };
  const entries = validateQuarantine([known], "2030-01-01");
  assert.throws(() => validateQuarantine(entries, "2030-01-02"), /expired on 2030-01-02/u);
  assert.throws(() => validateQuarantine([{ ...known, expiresOn: "2030-02-30" }], "2030-01-01"), /valid UTC expiry/u);
  assert.throws(() => validateQuarantine([{ ...known, owner: "" }], "2030-01-01"), /requires a file, test name and owner/u);
  const data = { file: join(process.cwd(), file), name: known.name };
  const reports = await Array.fromAsync(reportTimingsWithQuarantine([
    { type: "test:pass", data },
    { type: "test:fail", data: { ...data, name: "other failure" } },
    { type: "test:fail", data },
  ], entries));
  assert.deepEqual(reports, ["KNOWN TEST FAILURE " + JSON.stringify(known) + "\n"]);
});

test("hosted CLI reporters preserve an unquarantined test failure", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { error, status, stdout, stderr } = spawnSync(process.execPath, [
    "--test", "--test-reporter=spec", "--test-reporter=./scripts/hosted-ci-timing-reporter.mjs",
    "--test-reporter-destination=stdout", "--test-reporter-destination=stdout",
    "tests/fixtures/hosted-ci-reporter-failure.mjs",
  ], { cwd: repository, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (error) throw error;
  assert.doesNotMatch(stderr, /entries\.find is not a function/u);
  assert.equal(status, 1, stderr);
  assert.match(stdout, /Error: intentional reporter fixture failure/u);
  assert.match(stdout, /^UNIT_TIMING /mu);
});

test("runner ownership recognizes a bare sudo interpreter", () => {
  const file = "scripts/example.sh";
  assert(runsFile(`sudo bash ${file}`, file));
  assert(!runsFile(`sudo apt-get ${file}`, file));
  assert(!runsFile(`sudo -u x bash ${file}`, file));
});

function referencesFile(source, file) {
  return source.includes(`"${file}"`) || source.includes(`'${file}'`);
}

function hostedApplicationOwns(file, fixtureSpecs) {
  if (file.endsWith("-operator.spec.ts")) return false;
  return (file === "tests/e2e/arabic.spec.ts" || fixtureSpecs.get("en").has(file))
    && (file === "tests/e2e/application.spec.ts" || fixtureSpecs.get("ar").has(file));
}

test("application ownership rejects a shared spec moved out of hosted fixture mode", () => {
  const shared = "tests/e2e/meta-cost-statements.spec.ts";
  const english = "tests/e2e/application.spec.ts";
  const arabic = "tests/e2e/arabic.spec.ts";
  const fixtureSpecs = new Map([["en", new Set([english, shared])], ["ar", new Set([arabic, shared])]]);
  assert(hostedApplicationOwns(english, fixtureSpecs));
  assert(hostedApplicationOwns(arabic, fixtureSpecs));
  assert(hostedApplicationOwns(shared, fixtureSpecs));
  fixtureSpecs.get("ar").delete(shared);
  assert(!hostedApplicationOwns(shared, fixtureSpecs), "a shared spec must be selected in Arabic too");
  fixtureSpecs.get("en").delete(shared);
  assert(!hostedApplicationOwns(shared, fixtureSpecs), "a platform-only spec has no hosted fixture owner");
});

const tofuFile = file => /^infra\/terraform\/tests\/[^/]+\.tftest\.(?:hcl|json)$/u.test(file);
const postgresFile = file => /^tests\/.*(?:-postgres(?:-check)?|-real-schema-check)\.mjs$/u.test(file);

function runWorkflowScript(script, env, cwd) {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  return spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
}

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
  const jobs = {
    ...workflowJobs.get(".github/workflows/ci.yml"),
    ...workflowJobs.get(".github/workflows/nightly-install.yml"),
    ...workflowJobs.get(".github/workflows/privacy.yml"),
  };
  const runText = job => (job.steps ?? []).map(step => step.run ?? "").join("\n");
  const ciCommands = [...workflowJobs.values()].flatMap(workflow => Object.values(workflow).map(runText)).join("\n");
  const ciScripts = new Set(commands(ciCommands).map(command => {
    const [exe, action, script] = words(command);
    return exe === "pnpm" && (action === "run" ? script : action);
  }).filter(script => script && Object.hasOwn(scripts, script)));
  const runnerNames = [...Object.keys(jobs), ...ciScripts];
  const runnerText = runner => {
    const job = jobs[runner];
    if (!job) return scripts[runner] ?? "";
    const calledJobs = workflowJobs.get(job.uses?.replace(/^\.\//u, ""));
    return calledJobs ? Object.values(calledJobs).map(runText).join("\n") : runText(job);
  };
  assert(runsFile(runnerText("checks"), "scripts/hosted-ci.mjs", "unit"), "The unit inventory must run in CI");

  const unitWrappers = await Promise.all(["tests/application-e2e-harness.test.mjs", "tests/ci-phase-admission.test.mjs",
    "tests/simulation-native-isolation.test.mjs"].filter(file => units.has(file)).map(read));
  const postgresHarness = "scripts/test-postgres-integration.mjs";
  const postgresSource = await read(postgresHarness);
  const postgresImports = new Set();
  if (runsFile(runnerText("integration"), postgresHarness, "--shard")) {
    postgresImports.add(postgresHarness);
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
  const operatorRunner = await read("tests/hosted-platform-operator.mjs");
  const identityRunner = await read("tests/hosted-keycloak-identity.mjs");
  const applicationMatrix = jobs["application-e2e"].strategy.matrix;
  const ownerSuites = applicationMatrix.suite.filter(suite => suite.roles === "tenant_owner");
  const fixtureSpecs = new Map(applicationMatrix.locale.map(locale => {
    const argv = ["pnpm", "test:e2e"];
    const env = { WASALX_E2E_LOCALES: locale, WASALX_E2E_ROLES: "tenant_owner",
      WASALX_E2E_PLATFORM_URL: "", WASALX_E2E_OWNER_PART: "" };
    const cases = discoverBrowserCases({ argv, env });
    const splitCases = ownerSuites.flatMap(suite => discoverBrowserCases({
      argv, env: { ...env, WASALX_E2E_OWNER_PART: suite.owner_part },
    }));
    assert.deepEqual(splitCases.sort((a, b) => a.id.localeCompare(b.id, "en")), cases,
      `Owner shards must run every ${locale} case exactly once`);
    return [locale, new Set(cases.filter(row => row.expectedStatus !== "skipped").map(row => posix.join("tests/e2e", row.file)))];
  }));
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
      case "integration":
        return postgresImports.has(file) || (postgresImports.has(postgresHarness)
          && file === "tests/postgres-load-recovery.test.mjs"
          && postgresSource.includes('process.execPath,["--test","tests/postgres-load-recovery.test.mjs"]'));
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
      case "application-e2e":
        return runsFile(command, "scripts/run-application-e2e.mjs")
          && referencesFile(applicationRunner, "playwright.application.config.ts")
          && referencesFile(application, "./tests/e2e") && hostedApplicationOwns(file, fixtureSpecs);
      case "platform-operator-e2e":
        return runsFile(command, "tests/hosted-platform-operator.mjs")
          && referencesFile(operatorRunner, "playwright.application.config.ts")
          && referencesFile(application, "./tests/e2e") && posix.dirname(file) === "tests/e2e"
          && referencesFile(operatorRunner, posix.basename(file)) && referencesFile(application, posix.basename(file));
      case "test:e2e":
        return runsFile(command, "scripts/run-application-e2e.mjs")
          && referencesFile(applicationRunner, "playwright.application.config.ts")
          && referencesFile(application, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(application, posix.basename(file));
      case "keycloak-identity":
        return runsFile(command, "tests/hosted-keycloak-identity.mjs")
          && referencesFile(identityRunner, "playwright.identity.config.ts") && referencesFile(identity, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(identity, posix.basename(file));
      case "storybook":
        return referencesFile(storybookRunner, "playwright.storybook.config.ts")
          && referencesFile(storybook, "./tests/visual")
          && commands(command).some(line =>
            runsFile(line, "scripts/storybook-visual-regression.mjs", "--require-browser")
            && (words(line).includes(file) || (words(line).includes("tests/visual/inbox-synthetic.spec.ts")
              && referencesFile(visualHarness, file))));
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

test("CI job timeouts are covered by the measured limits", async () => {
  const workflow = ".github/workflows/ci.yml";
  const { jobs } = parse(await read(workflow));
  const timing = JSON.parse(await read(".github/ci-timings.json"));
  assert.equal(timing.workflow, workflow);
  assert.deepEqual(Object.keys(timing.jobs).sort(), Object.keys(jobs).sort());
  const images = JSON.parse(await read("scripts/release/product-images.json")).map(({ image }) => image);
  const { locale, suite } = jobs["application-e2e"].strategy.matrix;
  const matrixLegs = {
    checks: jobs.checks.strategy.matrix.include.map(({ name }) => name),
    "full-unit": jobs["full-unit"].strategy.matrix.include.map(({ name }) => name),
    integration: jobs.integration.strategy.matrix.shard.map(String),
    "application-e2e": suite.flatMap(({ roles, owner_part }) =>
      locale.map(language => [language, roles, owner_part].filter(Boolean).join(", "))),
    "platform-operator-e2e": jobs["platform-operator-e2e"].strategy.matrix.locale,
    images,
    "pr-images": images,
  };
  const measuredP95 = ({ p95_minutes: p95, runs }, id) => {
    assert(Number.isFinite(p95) && p95 > 0, id);
    assert(Number.isInteger(runs) && runs >= 5, id);
    return p95;
  };
  for (const [id, job] of Object.entries(jobs)) {
    const record = timing.jobs[id];
    let p95 = measuredP95(record, id);
    if (job.uses) {
      assert.equal(job.uses, "./" + record.workflow, id);
      continue;
    }
    const legs = matrixLegs[id];
    assert.equal(Boolean(job.strategy?.matrix), Boolean(legs), id);
    if (legs) {
      assert.deepEqual(Object.keys(record.legs).sort(), [...legs].sort(), id);
      p95 = Math.max(...legs.map(leg => measuredP95(record.legs[leg], id + "/" + leg)));
      assert.equal(record.p95_minutes, p95, id);
    }
    // The ci-gate timing sample predates the verdict verifier's API calls.
    const timeout = id === "ci-gate" ? 3 : Math.ceil(p95 * 1.25);
    assert.equal(job["timeout-minutes"], timeout, id);
  }

  const { publish } = timing.jobs;
  assert.equal(publish.workflow, ".github/workflows/branch-image.yml");
  const release = parse(await read(publish.workflow)).jobs.publish;
  assert.deepEqual(Object.keys(publish.image_legs).sort(), [...release.strategy.matrix.image].sort());
  for (const [leg, sample] of Object.entries(publish.image_legs)) measuredP95(sample, "publish/" + leg);
  const image = "connector-worker";
  const p95 = publish.image_legs[image].p95_minutes;
  const matrixP95 = publish.p95_minutes;
  assert(Number.isFinite(matrixP95) && Number.isFinite(p95) && p95 > 0 && p95 <= matrixP95);
  assert(release.strategy.matrix.image.includes(image));
  const connectorTimeout = Math.ceil(p95 * 1.25);
  const matrixTimeout = Math.ceil(matrixP95 * 1.25);
  assert.equal(
    release["timeout-minutes"],
    "${{ matrix.image == '" + image + "' && " + connectorTimeout + " || " + matrixTimeout + " }}",
  );
  assert.match((await read("DELIVERY.md")).split("\n").find(line => line.startsWith("| §4/§8 ")), /main image publication matrix/u);
});

test("Storybook selects UI changes and unknown diffs", async (t) => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const selection = jobs.changes.steps.find(step => step.id === "storybook");
  assert.equal(selection.if, undefined);
  assert.equal(selection.env.BASE, "${{ steps.selector-base.outputs.sha }}");
  assert.equal(jobs.storybook.needs, "changes");
  assert.match(jobs.storybook.if, /github\.event_name != 'push'/u);
  assert.match(jobs.storybook.if, /needs\.changes\.result != 'success' \|\| needs\.changes\.outputs\.storybook != 'false'/u);
  assert.match(jobs.storybook.if, /github\.event_name == 'workflow_dispatch'/u);
  assert(jobs.storybook.steps.some(({ run }) =>
    run && runsFile(run, "scripts/storybook-visual-regression.mjs", "--update-snapshots=none")
    && words(run).includes("tests/visual/storybook-ci.spec.ts")
    && words(run).includes("tests/visual/design-system.spec.ts")));
  assert(jobs["ci-gate"].needs.includes("storybook"));
  const [gateStep] = jobs["ci-gate"].steps;
  assert.equal(gateStep.env.STORYBOOK_NEEDED, "${{ needs.changes.outputs.storybook }}");
  assert.equal(gateStep.env.STORYBOOK, "${{ needs.storybook.result }}");

  const directory = await mkdtemp(join(tmpdir(), "storybook-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");

  const base = "a".repeat(40);
  for (const [baseRef, status, expected] of [[base, 0, "false"], [base, 1, "true"], [base, 128, "true"], ["", 0, "true"]]) {
    await writeFile(output, "");
    const result = runWorkflowScript(
      `git() { case " $* " in *" app/ "*) return "$DIFF_STATUS";; *) return 0;; esac; }\n${selection.run}`,
      { BASE: baseRef, DIFF_STATUS: String(status), GITHUB_OUTPUT: output.replaceAll("\\", "/") },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `needed=${expected}`);
  }
});

test("installer portal follows the combined diff without trimming the queue image matrix", async t => {
  const { jobs: { changes } } = parse(await read(".github/workflows/ci.yml"));
  const baseStep = changes.steps.find(step => step.id === "selector-base");
  const matrixStep = changes.steps.find(step => step.id === "matrix");
  assert.equal(baseStep.env.BASE, "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.merge_group.base_sha }}");
  assert.equal(matrixStep.env.BASE, "${{ steps.selector-base.outputs.sha }}");
  const directory = await mkdtemp(join(tmpdir(), "queue-installer-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output").replaceAll("\\", "/");
  const base = "a".repeat(40);
  const catalog = JSON.stringify({ include: [{ image: "portal" }, { image: "zammad" }] });
  const mock = String.raw`
git() {
  case "$*" in
    "merge-base --is-ancestor $BASE HEAD") return "$ANCESTOR_STATUS" ;;
    "diff --quiet --no-ext-diff --no-renames $BASE HEAD -- "*)
      [[ "$*" == *"scripts/release/installer-stages.mjs"* ]] || exit 99
      return "$DIFF_STATUS" ;;
    *) exit 99 ;;
  esac
}
python3() {
  case "$*" in
    "scripts/release/images-by-digest.py matrix") printf '%s\n' "$CATALOG" ;;
    "scripts/release/images-by-digest.py matrix --base-sha $BASE") printf '%s\n' "$AFFECTED" ;;
    *) exit 99 ;;
  esac
}
`;
  const check = async (run, env) => {
    await writeFile(output, "");
    const result = runWorkflowScript(mock + run, { BASE: base, GITHUB_OUTPUT: output, ...env });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return await readFile(output, "utf8");
  };
  assert.equal(await check(baseStep.run, { ANCESTOR_STATUS: "0" }), "sha=" + base + "\n");
  assert.equal(await check(baseStep.run, { ANCESTOR_STATUS: "1" }), "");
  for (const [affected, diff, baseRef, needed] of [
    [[], "0", base, false],
    [[{ image: "portal" }], "0", base, true],
    [[], "1", base, true],
    [[], "128", base, true],
    [[], "0", "", true],
  ]) {
    const result = await check(matrixStep.run, {
      EVENT: "merge_group", BASE: baseRef, DIFF_STATUS: diff, CATALOG: catalog,
      AFFECTED: JSON.stringify({ include: affected }),
    });
    assert(result.split("\n").includes("matrix=" + catalog));
    assert(result.split("\n").includes("images=true"));
    assert(result.split("\n").includes("installer-portal=" + needed));
  }
});

test("TypeScript comparison runs as an advisory job on affected PRs", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const job = jobs["typescript-comparison"];
  const selection = jobs.changes.steps.find(step => step.id === "typescript-comparison");
  assert.equal(jobs.changes.outputs["typescript-comparison"], "${{ steps.typescript-comparison.outputs.needed }}");
  assert.equal(selection.if, "github.event_name == 'pull_request'");
  assert.equal(selection.env.BASE, "${{ steps.selector-base.outputs.sha }}");
  assert.equal(job.needs, "changes");
  assert.equal(job.if, "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.typescript-comparison != 'false' }}");
  assert.equal(job.strategy, undefined);
  assert(!jobs["ci-gate"].needs.includes("typescript-comparison"));
  const checkouts = job.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkouts.map(step => step.with.path), ["candidate", "baseline"]);
  assert.equal(checkouts[1].with.ref, "${{ github.event.pull_request.base.sha }}");
  const unit = job.steps.find(step => step.name === "Run the unit suite on TypeScript 7 output");
  assert.equal(unit.if, "${{ !cancelled() && steps.compare.outputs.emit == 'different' }}");
  assert.equal(unit["working-directory"], "candidate");
  assert(unit.run.includes("node scripts/test-unit.mjs"));

  const directory = await mkdtemp(join(tmpdir(), "typescript-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, windowsHide: true });
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--quiet", "--allow-empty", "-m", "Base");
  const output = join(directory, "selection").replaceAll("\\", "/");
  for (const [file, needed] of [[null, true], ["README.md", false], ["compiler.ts", true], ["pnpm-lock.yaml", true]]) {
    if (file) {
      await writeFile(join(directory, file), "fixture\n");
      git("add", "--", file);
      git("commit", "--quiet", "-m", "Change one input");
    }
    await writeFile(output, "");
    const base = file ? git("rev-parse", "HEAD^1").toString().trim() : "";
    const result = runWorkflowScript(selection.run, { BASE: base, GITHUB_OUTPUT: output }, directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `needed=${needed}`, file ?? "unavailable base");
  }
});

test("nightly install is report-only, read-only and runs on schedule, dispatch and RC tags", async () => {
  const path = ".github/workflows/nightly-install.yml";
  const { on, permissions, jobs } = parse(await read(path));
  const job = jobs["nightly-install"];
  assert.equal(job["continue-on-error"], undefined);
  assert.deepEqual(on, {
    schedule: [{ cron: "17 2 * * *" }],
    workflow_dispatch: {
      inputs: { commit: { description: "Exact published main commit SHA (optional)", type: "string", required: false } },
    },
    push: { tags: ["v*-rc.*"] },
  });
  assert.match(job.if, /\(github\.event_name == 'push' && github\.ref_type == 'tag'\)/u);
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u);
  assert.deepEqual(permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const actions = job.steps.filter(step => step.uses);
  const { runs } = parse(await read(cosignAction + "/action.yml"));
  const remoteActions = actions.flatMap(step => step.uses === cosignAction
    ? runs.steps.filter(nested => nested.uses) : [step]);
  assert(remoteActions.every(step => /@[0-9a-f]{40}$/u.test(step.uses)));
  assert.equal(actions.find(step => step.uses.startsWith("actions/checkout@")).with["persist-credentials"], false);
  assert(!JSON.stringify(job).includes("secrets."));
  assert(job.steps.some(step => step.if?.startsWith("always()")));
  assert(!parse(await read(".github/workflows/ci.yml")).jobs["ci-gate"].needs.includes("nightly-install"));
  const rehearsal = await read("scripts/release/installer-nightly.sh");
  const probe = await read("scripts/dev-install/probe.mjs");
  assert.match(rehearsal, /phase native-preflight [^]*phase probe-scan 5m sudo -H env "PATH=\$PATH" node scripts\/dev-install\/probe\.mjs [^]*--held-services ''[^]*\.services == \.expected_services[^]*\.rerendered_hashes == \.expected_services[^]*phase configured-reinstall/u);
  assert.match(probe, /const active = activeServiceNames\(model, composeProfiles\);[^]*expected_services: active\.length/u);
  for (const source of [probe, rehearsal, await read(path)]) {
    assert.doesNotMatch(source, /\b37\b/u);
  }
});

test("nightly census confirmation accepts matching counts from the rehearsal", async t => {
  const { jobs } = parse(await read(".github/workflows/nightly-install.yml"));
  const confirmation = jobs["nightly-install"].steps.find(step => step.name === "Confirm census PASS");
  assert.equal(confirmation.env.COMMIT, "${{ steps.publication.outputs.commit }}");
  const directory = await mkdtemp(join(tmpdir(), "nightly-census-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = join(directory, "wasalx-nightly", "diagnostics");
  await mkdir(diagnostics, { recursive: true });
  const log = join(diagnostics, "phases.log");
  const [commit, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
    cwd: repository, encoding: "utf8", windowsHide: true,
  }).trim().split(/\s+/u);
  for (const [services, hashes, status] of [[12, 12, 0], [38, 38, 0], [38, 37, 1], [0, 0, 1]]) {
    await writeFile(log, `installer=${commit} tree=${tree} images=${commit}\nprobe-scan services=${services} rerendered_hashes=${hashes} census=PASS\n`);
    const result = runWorkflowScript(confirmation.run, { COMMIT: commit, RUNNER_TEMP: directory }, repository);
    assert.equal(result.status, status, result.error?.message ?? result.stderr);
  }
});

test("nightly registry probe reports blocked only for a TCP rejection", async () => {
  const rehearsal = await read("scripts/release/installer-nightly.sh");
  assert.match(rehearsal, /phase registry-egress 30s bash -euo pipefail -c 'block_registry_egress; verify_registry_egress'/u);
  const verify = rehearsal.match(/^verify_registry_egress\(\) \{\r?\n[^]*?^\}/mu)?.[0];
  assert.ok(verify);
  const results = [
    [1, "dial tcp 192.0.2.1:443: connect: connection refused", 0, ""],
    [0, "", 1, "public pull succeeded after the block"],
    [1, "manifest unknown", 1, "public pull failed without a TCP rejection (exit=1)"],
    [124, "", 1, "public pull failed without a TCP rejection (exit=124)"],
  ];
  for (const [status, output, expected, reason] of results) {
    const result = runWorkflowScript(`${verify}
      timeout() {
        [[ "$*" == '15s docker pull fixture@sha256:test' ]] || return 125
        printf '%s\\n' "$PULL_OUTPUT" >&2
        return "$PULL_STATUS"
      }
      verify_registry_egress
    `, { registry_image: "fixture@sha256:test", PULL_STATUS: String(status), PULL_OUTPUT: output }, repository);
    assert.equal(result.status, expected, result.error?.message ?? result.stderr);
    assert.equal(result.stdout.trim(), expected === 0 ? "public-registry-egress=blocked" : "");
    assert.equal(result.stderr.trim(), reason ? `registry-egress reason: ${reason}` : "");
  }
});

test("nightly installer refuses an invalid runner with a command, status and reason", () => {
  const result = runWorkflowScript("bash scripts/release/installer-nightly.sh", { GITHUB_ACTIONS: "false" }, repository);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /command=bash scripts\/release\/installer-nightly\.sh exit=1 reason=requires a GitHub-hosted Actions runner/u);
});

test("nightly smoke surfaces the redacted verifier reason and keeps raw output private", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nightly-smoke-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = await read("scripts/release/installer-nightly.sh");
  const phase = script.match(/^phase\(\) \{\n[\s\S]*?^\}/mu)?.[0];
  assert.ok(phase, "nightly phase is missing");
  const diagnostic = "exact stack verification reason: check=zammad-package-digest reason=image package digest differs from the source catalog pin";
  const result = runWorkflowScript(`
work=$PWD
diagnostics=$PWD
failure() { printf 'exit=%s reason=%s\\n' "$1" "$3" >&2; }
timeout() { printf '%s\\n' 'private captured input' "$DIAGNOSTIC"; return 1; }
${phase}
phase fresh-smoke 3m node scripts/release/installer-stages.mjs smoke
`, { DIAGNOSTIC: diagnostic }, directory);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), `exit=1 reason=${diagnostic}`);
  assert.equal((await readFile(join(directory, "installer.log"), "utf8")).trim(), diagnostic);
});

test("nightly installer uses the active full Compose mirror without a second digest pin", async () => {
  const full = parse(await read("compose.full.yaml"), { logLevel: "silent" });
  const nightly = parse(await read("scripts/release/installer-nightly.compose.yaml"), { logLevel: "silent" });
  const rehearsal = await read("scripts/release/installer-nightly.sh");
  assert.match(rehearsal, /mirrors=\$\(python3 -B scripts\/release\/installer-mirror-images\.py references\)/u);

  const python = process.platform === "win32" ? "python" : "python3";
  const references = execFileSync(python, ["-B", "scripts/release/installer-mirror-images.py", "references"], {
    cwd: repository, encoding: "utf8", timeout: 10_000,
  });
  const rows = JSON.parse(references);
  const inventory = full["x-object-storage-mirrors"];
  assert.deepEqual(Object.keys(inventory).sort(), ["minio", "minio-bootstrap"]);
  const sources = Object.entries(inventory).map(([service, row], index) => {
    assert.equal(nightly.services[service], undefined);
    const image = full.services[service].image;
    const source = image.replace(/:[^/:]+(?=@)/u, "");
    const digest = source.split("@")[1];
    assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(rows[index], { source, mirror: `${row.mirror}@${digest}` });
    return image;
  });
  assert.equal(rows.length, sources.length);

  const registry = "127.0.0.1:5007";
  const ordinary = `docker.io/library/redis@sha256:${"d".repeat(64)}`;
  const staging = rehearsal.match(/node --input-type=module -e '([^']+)' "\$registry" "\$mirrors"/u);
  assert.ok(staging, "missing the nightly registry plan");
  const plan = (catalog, input) => spawnSync(process.execPath, ["--input-type=module", "-e", staging[1], registry, catalog], {
    cwd: repository, input: input.join("\n"), encoding: "utf8", timeout: 5_000,
  });
  const result = plan(references, [...sources, ordinary]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [...rows.map(row => row.mirror), ordinary].map(reference => {
    const digest = reference.split("@")[1];
    return `${reference} ${registry}/staged/${digest.slice(7)}@${digest}`;
  }));

  const missing = plan(JSON.stringify([{ source: rows[0].source }, ...rows.slice(1)]), [...sources, ordinary]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /Missing mirror for /u);
  assert.equal(missing.stdout, "");

  const absent = plan(references, [...sources.slice(1), ordinary]);
  assert.equal(absent.status, 1, absent.stderr);
  assert.match(absent.stderr, /Inventory source absent from resolved images/u);
  assert.equal(absent.stdout, "");
});

test("nightly binds qualification to a complete main publication", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nightly-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { cwd: directory, encoding: "utf8", windowsHide: true };
  const git = (...args) => execFileSync("git", args, options).trim();
  const now = Date.UTC(2026, 10, 26, 12);
  const gitAt = (time, ...args) => {
    const date = new Date(time).toISOString();
    return execFileSync("git", args, {
      ...options, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();
  };
  git("init", "--quiet", "--template=", "--initial-branch=candidate");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const catalog = "scripts/release/product-images.json";
  await mkdir(join(directory, "scripts", "release"), { recursive: true });
  await writeFile(join(directory, catalog), '[{"image":"zammad"}]');
  git("add", "--", catalog);
  for (const [i, ageSeconds] of [86_401, 86_400, 180, 120, 60].entries()) {
    gitAt(now - ageSeconds * 1000, "commit", "--quiet", "--allow-empty", "-m", "fixture " + i);
  }
  const tree = git("rev-parse", "HEAD^{tree}");
  const parent = git("rev-parse", "HEAD");
  await writeFile(join(directory, catalog), '[{"image":"unpublished"}]');
  git("add", "--", catalog);
  gitAt(now, "commit", "--quiet", "-m", "unpublished catalog");
  const side = gitAt(now, "commit-tree", tree, "-p", parent, "-m", "side branch");
  const base = gitAt(now, "commit-tree", tree, "-p", parent, "-p", side, "-m", "base merge");
  const dispatchHead = git("rev-parse", "HEAD");
  const commits = git("rev-list", "--first-parent", base).split(/\r?\n/u);
  const tag = "v0.0.0-rc.1";
  git("tag", "-a", tag, base, "-m", "fixture tag");
  git("update-ref", "refs/heads/main", base);
  git("remote", "add", "origin", ".");
  const { jobs } = parse(await read(".github/workflows/nightly-install.yml"));
  const publication = jobs["nightly-install"].steps.find(step => step.id === "publication");
  await writeFile(join(directory, "scripts", "release", "image-manifest.sh"), await read("scripts/release/image-manifest.sh"));
  const ghFixture = String.raw`
date() {
  [[ "$*" == "-u +%s" ]] || return 2
  printf '%s\n' "$NOW"
}
install() {
  [[ "$1 $2 $3" == '-d -m 0700' ]] && mkdir -p "$4"
}
gh() {
  case "$1 $2" in
    "api repos/$GITHUB_REPOSITORY/compare/$BASE...main") echo ahead ;;
    'run list')
      [[ "$*" == *"--workflow ci.yml --branch main --event push --commit "*"--status success --limit 1"* ]] || return 2
      while [[ "$1" != --commit ]]; do shift; done
      printf '%s\n' "$2" >> lookups
      case "$2" in
        "$LOOKUP_ERROR") return 17 ;;
        "$READY") echo 101 ;;
        "$INCOMPLETE") echo 102 ;;
        "$EXPIRED") echo 103 ;;
        "$NO_JOB") echo 104 ;;
      esac
      ;;
    'run view') if [[ "$3" == 104 ]]; then echo 0; else echo 1; fi ;;
    "api repos/$GITHUB_REPOSITORY/actions/runs/103/artifacts?name=images-manifest") echo 0 ;;
    "api repos/$GITHUB_REPOSITORY/actions/runs/"*"/artifacts?name=images-manifest") echo 1 ;;
    'run download')
      local commit=$READY images='{"zammad":{}}' pending='{}' complete=true
      [[ "$3" != 102 ]] || { commit=$INCOMPLETE; images='{}'; pending='{"zammad":{}}'; complete=false; }
      [[ "$INVALID" != true ]] || commit=$SIDE
      local downloaded_run=$3
      while [[ "$1" != --dir ]]; do shift; done
      [[ ! -e "$2/images-manifest.json" && ! -e "$2/images-manifest-attempt.json" ]] || return 18
      printf '%s\n' "$downloaded_run" > "$2/images-manifest-attempt.json"
      printf '{"schemaVersion":1,"repository":"%s","platform":"linux/amd64","commit":"%s","tree":"%s","images":%s,"pending":%s,"publicationComplete":%s}\n' \
        "$GITHUB_REPOSITORY" "$commit" "$(git rev-parse "$commit^{tree}")" "$images" "$pending" "$complete" > "$2/images-manifest.json"
      ;;
    *) return 2 ;;
  esac
}
`;
  const blocked = reason => `BLOCKED: Exact main publication for ${base} is unavailable (${reason}).`;
  const exact = `Exact main publication ${base} is complete (run 101).`;
  const latest = (commit, skipped) => `Selected main publication ${commit} (run 101), skipped ${skipped} newer commits.`;
  const noRecent = "BLOCKED: No complete green main publication from the last 24 hours (searched up to 50 first-parent main commits).";
  const cases = [
    ...["schedule", "workflow_dispatch"].flatMap(event => [
      { event, ready: base, selected: base, lookups: [base], summary: latest(base, 0) },
      { event, ready: commits[1], selected: commits[1], lookups: commits.slice(0, 2), summary: latest(commits[1], 1) },
      { event, ready: commits[4], incomplete: commits[1], expired: commits[2], noJob: commits[3],
        selected: commits[4], lookups: commits.slice(0, 5), summary: latest(commits[4], 4) },
      { event, ready: side, lookups: commits.slice(0, 5), summary: noRecent },
      { event, ready: commits[1], lookupError: base, lookups: [base], status: 17 },
      { event, ready: commits[5], lookups: commits.slice(0, 5), summary: noRecent },
    ]),
    ...[
      { ready: base, selected: base, lookups: [base], summary: exact },
      { ready: commits[1], lookups: [base], summary: blocked("no green main CI push run") },
      { ready: commits[1], incomplete: base, lookups: [base], summary: blocked("images-manifest is incomplete") },
      { ready: commits[1], expired: base, lookups: [base], summary: blocked("no available images-manifest artifact") },
      { ready: commits[1], noJob: base, lookups: [base], summary: blocked("no successful Image digest manifest job") },
      { ready: base, invalid: true, lookups: [base], status: 5, reason: "Invalid nightly publication manifest" },
    ].map(scenario => ({ event: "workflow_dispatch", input: base, ...scenario })),
    { event: "push", ready: base, selected: base, lookups: [base] },
    { event: "push", ready: commits[1], lookups: [base], reason: "No green main CI push run for the commit" },
  ];
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const { ready, selected, incomplete = "", expired = "", noJob = "", lookupError = "", invalid = false,
    event, input = "", lookups, status = selected ? 0 : 1, reason, summary = "" } of cases) {
    const head = event === "workflow_dispatch" ? dispatchHead : base;
    const tagPush = event === "push";
    git("checkout", "--quiet", "--detach", head);
    await rm(join(directory, "wasalx-nightly"), { recursive: true, force: true });
    await writeFile(join(directory, "lookups"), "");
    await writeFile(join(directory, "publication-output"), "");
    await writeFile(join(directory, "publication-summary"), "");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-euo", "pipefail", "-c", ghFixture + publication.run], {
      ...options, timeout: 10_000, env: {
        ...process.env, GITHUB_REPOSITORY: "fixture/nightly", BASE: base, SIDE: side, READY: ready, INCOMPLETE: incomplete,
        EXPIRED: expired, NO_JOB: noJob, LOOKUP_ERROR: lookupError, INVALID: String(invalid),
        GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: tagPush ? "tag" : "branch",
        GITHUB_REF: tagPush ? `refs/tags/${tag}`
          : event === "workflow_dispatch" ? "refs/heads/candidate" : "refs/heads/main",
        DISPATCH_COMMIT: input, NOW: String(now / 1000),
        GITHUB_OUTPUT: "publication-output", GITHUB_STEP_SUMMARY: "publication-summary", RUNNER_TEMP: ".",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${event}\n${result.stdout}${result.stderr}`);
    assert.equal(git("rev-parse", "HEAD"), selected ?? head);
    assert.equal((await readFile(join(directory, "publication-output"), "utf8")).trim(), selected ? `commit=${selected}` : "");
    if (reason) assert.ok((result.stdout + result.stderr).includes(reason), result.stderr);
    assert.equal((await readFile(join(directory, "publication-summary"), "utf8")).trim(), summary);
    if (summary.startsWith("BLOCKED")) assert.ok(result.stderr.includes(`::error::${summary}`), result.stderr);
    if (selected) {
      const manifest = join(directory, "wasalx-nightly", "images-manifest.json");
      assert.equal(JSON.parse(await readFile(manifest, "utf8")).commit, selected);
      assert.equal((await readFile(join(directory, "wasalx-nightly", "images-manifest-attempt.json"), "utf8")).trim(), "101");
    }
    assert.deepEqual((await readFile(join(directory, "lookups"), "utf8")).trim().split(/\r?\n/u), lookups);
  }
});

test("object-storage mirrors publish only on main and qualify through read-only CI", async () => {
  const publisher = parse(await read(".github/workflows/mirror-images.yml"));
  const { mirror } = publisher.jobs;
  const inputs = [
    "compose.full.yaml",
    ".github/workflows/mirror-images.yml",
    "scripts/release/installer-mirror-images.py",
    "scripts/release/image_registry_retry.py",
  ];
  assert.deepEqual(publisher.on, { push: { branches: ["main"], paths: inputs } });
  assert.deepEqual(publisher.permissions, {});
  assert.deepEqual(Object.keys(publisher.jobs), ["mirror"]);
  assert.deepEqual(mirror.permissions, { contents: "read", packages: "write" });
  assert.equal(mirror.if,
    "github.event_name == 'push' && github.repository == 'WasalX/wasalx-platform' && github.ref == 'refs/heads/main'");
  assert.equal(mirror["runs-on"], "ubuntu-24.04");
  const actions = mirror.steps.filter(step => step.uses);
  assert(actions.every(step => /@[0-9a-f]{40}$/u.test(step.uses)));
  assert.equal(actions.find(step => step.uses.startsWith("actions/checkout@")).with["persist-credentials"], false);
  assert.equal(actions.find(step => step.uses.startsWith("docker/login-action@")).with.password, "${{ github.token }}");
  assert(!JSON.stringify(mirror).includes("secrets."));
  assert.match(mirror.steps.find(step => step.run).run, /^python3 -B scripts\/release\/installer-mirror-images\.py publish/u);

  const ci = parse(await read(".github/workflows/ci.yml"));
  const { changes, "ci-gate": gate } = ci.jobs;
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.equal(changes.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  assert(gate.needs.includes("changes"));
  const step = changes.steps.find(row => row.name === "Verify active installer object-storage mirrors");
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.deepEqual(step.env, {
    BASE: "${{ steps.selector-base.outputs.sha }}",
    DOCKER_CONFIG: "${{ runner.temp }}/public-mirror-docker",
  });
  for (const input of inputs) assert(step.run.includes(input));
  assert.match(step.run, /timeout 40s python3/u);
  const sha = "a".repeat(40);
  for (const [base, diff, verify, called, status] of [
    ["HEAD^1", 0, 0, false, 0],
    ["HEAD^1", 1, 0, true, 0],
    [sha, 1, 1, true, 1],
    ["", 0, 0, false, 2],
  ]) {
    const result = runWorkflowScript(`
git() {
  case "$1" in
    diff) return "$DIFF" ;;
    rev-parse)
      [[ "$2" == --verify && "$3" == "$BASE^{commit}" && -n "$BASE" ]] || return 2
      echo "$SHA"
      ;;
    *) return 99 ;;
  esac
}
timeout() {
  [[ "$1" == 40s ]] || return 98
  shift
  "$@"
}
python3() {
  [[ "$1 $2 $3 $4" == '-B scripts/release/installer-mirror-images.py verify --base' && "$5" == "$SHA" ]]
  echo verified
  return "$VERIFY"
}
${step.run}`, { BASE: base, DIFF: diff, VERIFY: verify, SHA: sha });
    assert.equal(result.status, status, result.error?.message ?? result.stderr);
    assert.equal(result.stdout.includes("verified"), called);
  }

  const delivery = await read("DELIVERY.md");
  assert.match(delivery, /set(?:ting)? the service's `staged` reference in the \[full Compose inventory\]/u);
  assert.doesNotMatch(delivery, /manual \[image mirror workflow\]/u);
  const dependabot = await read(".github/dependabot.yml");
  assert.doesNotMatch(dependabot, /manual ghcr\.io\/wasalx mirror dispatch/u);
});

test("workflow lint requires verified tools, both embedded diagnostics, and clean workflows", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const job = jobs["workflow-lint"];
  const seed = jobs["seed-caches"];
  const cache = job.steps.find(step => step.uses?.startsWith("actions/cache@"));
  const prepare = job.steps.find(step => step.name === "Prepare pinned actionlint");
  const step = job.steps.find(step => step.name === "Lint workflows with actionlint");
  assert.equal(job.if, "github.event_name != 'push'");
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.deepEqual(cache.with, {
    path: "${{ runner.temp }}/actionlint-release.tar.gz",
    key: "actionlint-${{ env.ACTIONLINT_SHA256 }}-${{ env.ACTIONLINT_URL }}",
    "restore-keys": "actionlint-${{ env.ACTIONLINT_SHA256 }}",
  });
  assert.deepEqual(seed.env, job.env);
  const seedCache = seed.steps.findIndex(step => step.with?.path === cache.with.path);
  assert(seedCache >= 0);
  assert.deepEqual(seed.steps.slice(seedCache, seedCache + 2), [cache, prepare]);
  assert(job.steps.indexOf(cache) < job.steps.indexOf(prepare));
  assert(job.steps.indexOf(prepare) < job.steps.indexOf(step));
  assert.equal(prepare.if, undefined);
  assert.equal(prepare["continue-on-error"], undefined);

  const directory = await mkdtemp(join(tmpdir(), "ci-workflow-lint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "tool"), [
    "#!/usr/bin/env bash",
    "set -eu",
    'case "${0##*/}" in',
    '  shellcheck) printf "version: %s\\n" "$SHELLCHECK_VERSION" ;;',
    '  pyflakes) printf "%s Python 3.12.3 on Linux\\n" "$PYFLAKES_VERSION" ;;',
    '  python) [[ "$*" == "-m pip --isolated install --disable-pip-version-check --no-index --no-deps "*.whl && -f "$8" ]] ;;',
    '  actionlint)',
    '    if [[ "$1" == -version ]]; then echo "actionlint $ACTIONLINT_VERSION"; exit 0; fi',
    '    [[ "$1" == -shellcheck=*/shellcheck && -x "${1#-shellcheck=}" ]] || exit 99',
    '    [[ "$2" == -pyflakes=*/pyflakes && -x "${2#-pyflakes=}" ]] || exit 99',
    '    if [[ $# == 2 ]]; then exit "$REAL_STATUS"; fi',
    '    [[ $# == 3 && -f "$3" ]] || exit 99',
    '    if [[ "$MISSING" != shellcheck ]]; then echo "SC2086: quoting [shellcheck]"; fi',
    "    if [[ \"$MISSING\" != pyflakes ]]; then echo \"undefined name 'missing_name' [pyflakes]\"; fi",
    '    exit "$FIXTURE_STATUS" ;;',
    '  *) exit 99 ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const archivePath = join(directory, "actionlint-release.tar.gz");
  const release = "actionlint release fixture";
  const pinnedTools = { ...job.env, ...step.env };
  const sha256 = createHash("sha256").update(release).digest("hex");
  const mocks = String.raw`
bash() {
  [[ "$1" == scripts/release/fetch-verified-asset.sh && "$2" == https://* && "$4" =~ ^[a-f0-9]{64}$ ]] || exit 99
  if [[ "$2" == "$FAIL_DOWNLOAD" ]]; then return 2; fi
  printf '%s' "$RELEASE_CONTENTS" > "$3"
}
tar() {
  [[ "$1" == -xzf && -f "$2" && "$3" == -C ]] || exit 99
  mkdir -p "$(dirname "$4/$5")"
  cp tool "$4/$5"
}
python3() {
  [[ "$1" == -m && "$2" == venv ]] || exit 99
  mkdir -p "$3/bin"
  cp tool "$3/bin/python"
  cp tool "$3/bin/pyflakes"
}
`;
  for (const [name, overrides, expected, cachedArchive] of [
    ["clean", {}, 0],
    ["valid cached actionlint", { FAIL_DOWNLOAD: pinnedTools.ACTIONLINT_URL }, 0, release],
    ["corrupt cached actionlint", { FAIL_DOWNLOAD: pinnedTools.ACTIONLINT_URL }, 1, "corrupt"],
    ...["ACTIONLINT_URL", "SHELLCHECK_URL", "PYFLAKES_URL"].map(key => [key, { FAIL_DOWNLOAD: pinnedTools[key] }, 2]),
    ["wrong actionlint", { ACTIONLINT_VERSION: "1.17.0" }, 1],
    ["wrong ShellCheck", { SHELLCHECK_VERSION: "0.10.0" }, 1],
    ["wrong Pyflakes", { PYFLAKES_VERSION: "3.3.0" }, 1],
    ["missing ShellCheck diagnostic", { MISSING: "shellcheck" }, 1],
    ["missing Pyflakes diagnostic", { MISSING: "pyflakes" }, 1],
    ["fixture accepted", { FIXTURE_STATUS: "0" }, 1],
    ["fixture execution error", { FIXTURE_STATUS: "3" }, 1],
    ["real finding", { REAL_STATUS: "1" }, 1],
  ]) {
    await rm(archivePath, { force: true });
    if (cachedArchive !== undefined) await writeFile(archivePath, cachedArchive);
    const result = runWorkflowScript(mocks + prepare.run + "\n" + step.run, {
      ...pinnedTools,
      RUNNER_TEMP: directory.replaceAll("\\", "/"),
      TMPDIR: directory,
      ACTIONLINT_SHA256: sha256,
      RELEASE_CONTENTS: release,
      FAIL_DOWNLOAD: "", ACTIONLINT_VERSION: "1.17.1", SHELLCHECK_VERSION: "0.11.0", PYFLAKES_VERSION: "3.4.0",
      MISSING: "", FIXTURE_STATUS: "1", REAL_STATUS: "0",
      ...overrides,
    }, directory);
    assert.ifError(result.error);
    assert.equal(result.status, expected, name + "\n" + result.stdout + result.stderr);
    assert.equal(result.stdout.includes("Workflow lint passed with zero findings."), expected === 0, name);
  }
});

test("CI gates integration and infrastructure and runs portal integration files serially", async () => {
  const { on, jobs } = parse(await read(".github/workflows/ci.yml"));
  const { integration, "integration-coverage": coverage, "portal-integration": portal,
    "ci-gate": gate, "dev-install-dryrun": dryrun } = jobs;
  assert(Object.hasOwn(on, "workflow_dispatch"));
  assert(Object.hasOwn(on, "merge_group"));
  assert.deepEqual(on.push.branches, ["main"]);
  assert.equal(integration.needs, "changes");
  assert.equal(integration.if, "${{ !cancelled() && (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.integration != 'false'))) }}");
  assert.deepEqual(portal.needs, ["changes", "portal-browser-build"]);
  assert.match(portal.if, /needs\.portal-browser-build\.result == 'success'/u);
  assert.match(portal.if, /needs\.changes\.outputs\.integration != 'false'/u);
  assert.equal(coverage.needs, "integration");
  assert.deepEqual(integration.strategy, { "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
  assert.match(integration.services.postgres.options, /--tmpfs /u);
  assert(coverage.steps.some(step => runsFile(step.run ?? "", "scripts/postgres-scenario-registry.mjs")));
  assert(integration.steps.some(step => runsFile(step.run ?? "", "scripts/test-postgres-integration.mjs", "--shard")));
  assert.deepEqual(integration.permissions, { contents: "read" });
  assert.match(integration.services.postgres.image, /^postgres:[^@]+@sha256:[a-f0-9]{64}$/u);
  const devPreflightFile = "tests/installer-dev-recreatability.test.mjs";
  const devPreflightSteps = jobs.checks.steps.filter(step => runsFile(step.run ?? "", devPreflightFile));
  assert.equal(devPreflightSteps.length, 1);
  assert.equal(devPreflightSteps[0].if, "matrix.mode == 'unit' && matrix.shard == 1");
  assert(!unitFiles.includes(devPreflightFile));
  assert(!portal.steps.some(step => runsFile(step.run ?? "", devPreflightFile)));
  const shardStep = jobs.checks.steps.find(step => runsFile(step.run ?? "", "scripts/hosted-ci.mjs", "unit"));
  assert(jobs.checks.steps.indexOf(devPreflightSteps[0]) < jobs.checks.steps.indexOf(shardStep));
  const dryrunFile = "scripts/dev-install/test_dryrun.py";
  assert(portal.steps.some(step => step.if === "github.event_name != 'pull_request'" && runsFile(step.run ?? "", dryrunFile, "--container")));
  assert(dryrun.steps.some(step => !step.if && runsFile(step.run ?? "", dryrunFile, "--container")));
  assert.equal(dryrun.needs, "changes");
  assert.equal(dryrun.if, "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.dev-install != 'false' }}");
  const portalIntegration = portal.steps.find(step => step.name === "Test portal and tenant integration");
  assert.match(portalIntegration?.run, /^node --test --test-concurrency=1 /u);
  assert.deepEqual(portalIntegration.env, { WASALX_E2E_CONTROL_PORT: "14101", WASALX_E2E_PORTAL_PORT: "14102" });
  for (const job of ["integration", "portal-integration", "integration-coverage"]) assert(gate.needs.includes(job));
  assert(gate.needs.includes("dev-install-dryrun"));
  const [gateStep] = gate.steps;
  assert(gate.needs.includes("workflow-lint"));
  assert(gate.needs.includes("privacy"));
  assert(!on.pull_request.types.includes("edited"));
  const metadataWorkflow = parse(await read(".github/workflows/privacy.yml"));
  assert.deepEqual(metadataWorkflow.on.pull_request.types, ["edited"]);
  assert.deepEqual(metadataWorkflow.concurrency, {
    group: "privacy-${{ github.run_id }}",
    "cancel-in-progress": false,
  });
  assert.equal(jobs.privacy.uses, "./.github/workflows/privacy.yml");
  assert.equal(gateStep.env.PRIVACY, "${{ needs.privacy.result }}");
  assert.equal(gateStep.env.WORKFLOW_LINT, "${{ needs.workflow-lint.result }}");
  assert.equal(gateStep.env.INTEGRATION_NEEDED, "${{ needs.changes.outputs.integration }}");
  assert.equal(gateStep.env.INTEGRATION, "${{ needs.integration.result }}");
  assert.equal(gateStep.env.PORTAL_INTEGRATION, "${{ needs.portal-integration.result }}");
  assert.equal(gateStep.env.APPLICATION_NEEDED, "${{ needs.changes.outputs.application-e2e }}");
  assert.equal(gateStep.env.APPLICATION_E2E, "${{ needs.application-e2e.result }}");
  assert.equal(gateStep.env.PLATFORM_OPERATOR_E2E, "${{ needs.platform-operator-e2e.result }}");
  assert.equal(gateStep.env.INTEGRATION_COVERAGE, "${{ needs.integration-coverage.result }}");
  assert.equal(gateStep.env.DEV_INSTALL_NEEDED, "${{ needs.changes.outputs.dev-install }}");
  assert.equal(gateStep.env.DEV_INSTALL, "${{ needs.dev-install-dryrun.result }}");
  assert(gate.needs.includes("installer-portal"));
  assert.equal(gateStep.env.INSTALLER_PORTAL_NEEDED, "${{ needs.changes.outputs.installer-portal }}");
  assert.equal(gateStep.env.INSTALLER_PORTAL, "${{ needs.installer-portal.result }}");
  for (const job of [jobs.changes, jobs.checks]) {
    assert.equal(job.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  }
});

test("privacy CI enforces the PR opener rule with redacted output", async () => {
  const metadata = parse(await read(".github/workflows/privacy.yml"));
  assert(Object.hasOwn(metadata.on, "workflow_call"));
  assert.deepEqual(metadata.on.pull_request.types, ["edited"]);
  const { steps } = metadata.jobs["privacy-scan"];
  const mask = steps.find(step => step.name === "Mask the pull request opener");
  const check = steps.find(step => step.name === "Require an allowed pull request opener");
  assert(mask && check && steps.indexOf(mask) < steps.indexOf(check));
  assert.equal(mask.if, "github.event_name == 'pull_request'");
  assert.equal(check.if, "github.event_name == 'pull_request'");
  assert.equal(check.env.PR_OPENER, "${{ github.event.pull_request.user.login }}");
  const defaultList = "tree-publisher[bot],dependabot[bot]";
  assert.equal(check.env.PR_OPENER_ALLOWLIST, "${{ vars.PR_OPENER_ALLOWLIST || '" + defaultList + "' }}");
  for (const [login, allowlist, status] of [
    ["tree-publisher[bot]", defaultList, 0],
    ["dependabot[bot]", defaultList, 0],
    ["fixture-app[bot]", "another-app[bot], fixture-app[bot]\nexample-app[bot]", 0],
    ["tree-publisherb", defaultList, 1],
    ["tree-publisher[bot]", "fixture-app[bot]", 1],
    ["", defaultList, 1],
  ]) {
    const result = runWorkflowScript(check.run, { PR_OPENER: login, PR_OPENER_ALLOWLIST: allowlist });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.equal(result.stdout.trim(), status ? "::error::PR opener allowlist rule failed." : "");
    assert.equal(result.stderr, "");
  }
});

test("Application browser CI shards roles and locales and reuses the portal build", async (t) => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const application = jobs["application-e2e"];
  const portal = jobs["portal-integration"];
  const build = jobs["portal-browser-build"];
  const selection = jobs.changes.steps.find(step => step.id === "application-e2e");
  const operator = jobs["platform-operator-e2e"];
  assert(jobs["ci-gate"].needs.includes("application-e2e"));
  assert(jobs["ci-gate"].needs.includes("platform-operator-e2e"));
  assert.deepEqual(operator.needs, application.needs);
  assert.equal(operator.if, application.if);
  assert.deepEqual(operator.strategy.matrix.locale, application.strategy.matrix.locale);
  assert(!operator.steps.some(step => step.uses?.startsWith("actions/upload-artifact@")));
  assert(operator.steps.some(step => runsFile(step.run ?? "", "tests/hosted-platform-operator.mjs")));
  assert.equal(selection.if, "github.event_name == 'pull_request'");
  assert.equal(jobs.changes.outputs["application-e2e"], "${{ steps.application-e2e.outputs.needed }}");
  assert.match(application.if, /needs\.changes\.outputs\.application-e2e != 'false'/u);
  assert.deepEqual(application.needs, ["changes", "portal-browser-build"]);
  assert.deepEqual(application.strategy.matrix.locale, ["en", "ar"]);
  assert.deepEqual(application.strategy.matrix.suite.map(({ roles, owner_part }) => [roles, owner_part]), [
    ["tenant_owner", "desktop"], ["tenant_owner", "mobile-tablet"],
    ["tenant_admin,supervisor", undefined], ["agent,auditor", undefined],
  ]);
  assert(build.steps.some(step => step.run === "pnpm run build"));
  const run = application.steps.find(step => runsFile(step.run ?? "", "scripts/run-application-e2e.mjs"));
  assert.deepEqual(run.env, {
    WASALX_E2E_SKIP_BUILD: "1",
    WASALX_E2E_LOCALES: "${{ matrix.locale }}",
    WASALX_E2E_ROLES: "${{ matrix.suite.roles }}",
    WASALX_E2E_OWNER_PART: "${{ matrix.suite.owner_part }}",
  });
  const artifact = build.steps.find(step => step.uses?.startsWith("actions/upload-artifact@")).with.name;
  for (const job of [portal, application]) {
    assert.deepEqual(job.env, build.env);
    assert.equal(job.steps.find(step => step.uses?.startsWith("actions/download-artifact@")).with.name, artifact);
  }

  const directory = await mkdtemp(join(tmpdir(), "application-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  for (const [status, expected] of [[0, "false"], [1, "true"], [128, "true"]]) {
    await writeFile(output, "");
    const result = runWorkflowScript(
      `git() { case " $* " in *" app/ "*|*" tests/e2e/ "*) return "$DIFF_STATUS";; *) return 99;; esac; }\n${selection.run}`,
      { DIFF_STATUS: String(status), GITHUB_OUTPUT: output },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `needed=${expected}`);
  }
});

test("Hosted operator diagnostics retain only allowed step labels and bounded observations", () => {
  const testCase = { annotations: [
    { type: "wasalx-operator:authorityStatus", description: "200" },
    { type: "wasalx-operator:authorityStatus", description: "403" },
    { type: "wasalx-operator:lostResponseStatus", description: "502" },
    { type: "wasalx-operator:lostResponseStatus", description: "503" },
    { type: "wasalx-operator:matchedLostResponseConsole", description: "0" },
    { type: "wasalx-operator:checkedCostEffects", description: "64" },
    { type: "wasalx-operator:checkedCostEffects", description: "101" },
    { type: "wasalx-operator:pendingExpectedConsole", description: "1" },
    { type: "wasalx-operator:unexpectedConsole", description: "0" },
    { type: "wasalx-operator:unexpectedConsole", description: "Raw console message" },
    { type: "wasalx-operator:transitionReads", description: "12345" },
    { type: "wasalx-operator:unregistered-count", description: "4" },
  ] };
  const completed = { title: "Verify lost transition response", duration: 7 };
  const inFlight = { title: "Check transition console", duration: -1 };
  assert.deepEqual(operatorCaseProgress(testCase, {
    steps: [completed, { title: "Unknown nested step", duration: 2 }, inFlight],
  }), {
    lastCompletedStep: completed.title,
    terminalStep: inFlight.title,
    observations: { authorityStatus: 403, lostResponseStatus: 502, matchedLostResponseConsole: 0,
      checkedCostEffects: 64, pendingExpectedConsole: 1, unexpectedConsole: 0 },
  });
  const cost = { title: "Select first-page cost effects", duration: -1 };
  assert.equal(operatorCaseProgress({}, { steps: [cost] }).terminalStep, cost.title);
  assert.equal(operatorCaseProgress({}, {
    steps: [completed, { title: inFlight.title, duration: 2, error: { message: "Raw details" } }],
  }).terminalStep, inFlight.title);
});

test("Hosted Keycloak identity job builds the project image and requires the isolated cases", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const job = jobs["keycloak-identity"];
  assert.equal(job.needs, "changes");
  assert.match(job.if, /needs\.changes\.outputs\.keycloak-identity != 'false'/u);
  assert.equal(jobs.changes.outputs["keycloak-identity"], "${{ steps.keycloak-identity.outputs.needed }}");
  const run = job.steps.find(step => runsFile(step.run ?? "", "tests/hosted-keycloak-identity.mjs"));
  assert.match(run.run, /docker build --file Dockerfile\.foundation-keycloak/u);
  assert(!job.steps.some(step => step.uses?.startsWith("actions/upload-artifact@")));
  const gate = jobs["ci-gate"];
  assert(gate.needs.includes("keycloak-identity"));
  assert.equal(gate.steps[0].env.KEYCLOAK_IDENTITY, "${{ needs.keycloak-identity.result }}");
  assert.equal(gate.steps[0].env.KEYCLOAK_IDENTITY_NEEDED, "${{ needs.changes.outputs.keycloak-identity }}");
});

test("Hosted Keycloak cleanup verifies the prebuilt tag and attempts other resources after a failure", async () => {
  const image = "wasalx/ci-keycloak:1-1";
  const container = "wasalx-ci-keycloak-1-1";
  let tagged = true;
  let imageChecks = 0;
  const docker = async (...args) => {
    if (args[0] === "ps") {
      assert.deepEqual(args, ["ps", "-aq", "--filter", "name=^/" + container + "$"]);
      return "owned-container";
    }
    if (args[0] === "rm") {
      assert.deepEqual(args, ["rm", "-f", container]);
      throw new Error("Container removal failed");
    }
    if (args[1] === "ls") {
      assert.deepEqual(args, ["image", "ls", "-q", image]);
      imageChecks++;
      return tagged ? "owned-image" : "";
    }
    assert.deepEqual(args, ["image", "rm", image]);
    tagged = false;
  };
  const failures = await cleanupKeycloakIdentity({
    docker, image, container, callback: { listening: false }, scratch: "owned-fixtures",
    removeScratch: async () => { throw new Error("Fixture removal failed"); },
  });
  assert.deepEqual(failures, ["container", "fixtures"]);
  assert.equal(tagged, false);
  assert.equal(imageChecks, 2);
  assert.deepEqual(await cleanupKeycloakIdentity({
    docker: async () => "", image, container, callback: { listening: false },
  }), []);
});

test("Hosted browser jobs retain Playwright diagnostics on failure or cancellation", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const diagnostics = {
    "application-e2e": {
      name: "application-e2e-${{ matrix.locale }}-${{ matrix.suite.roles }}${{ matrix.suite.owner_part && format('-{0}', matrix.suite.owner_part) || '' }}",
      paths: ["output/playwright/application*/*/report/**", "output/playwright/application*/*/results/**"],
    },
  };
  for (const [job, { name, paths }] of Object.entries(diagnostics)) {
    const upload = jobs[job].steps.find(step =>
      step.uses?.startsWith("actions/upload-artifact@") && step.if === "failure() || cancelled()");
    assert(upload, job);
    assert.equal(upload.with.name, name, job);
    assert.deepEqual(upload.with.path.trim().split("\n"), paths, job);
    assert.equal(upload.with["retention-days"], 7, job);
  }
});

test("Storybook and Zammad publish failure evidence only", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const zammad = parse(await read(".github/workflows/zammad-compatibility.yml"));
  for (const [job, name, paths] of [
    [jobs.storybook, "storybook-audit", ["test-results/storybook", "output/playwright/design-system", "output/playwright/inbox/synthetic"]],
    [zammad.jobs.compatibility, "zammad-compatibility-failure", ["output/zammad-compat/*/native-mobile-public-failure.json"]],
  ]) {
    const uploads = job.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(uploads.length, 1, name);
    assert.equal(uploads[0].if, "failure()", name);
    assert.equal(uploads[0].with.name, name);
    assert.deepEqual(uploads[0].with.path.trim().split("\n"), paths);
    assert.equal(uploads[0].with["retention-days"], 7);
  }
});

test("Public child traces omit browser data and preserve failure locations", () => {
  execFileSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-c", `
import io, json, runpy
from zipfile import ZipFile

raw, output = io.BytesIO(), io.BytesIO()
marker = "OMIT_PRIVATE_TRACE_DATA"
with ZipFile(raw, "w") as archive:
    events = [
        {"type": "context-options", "options": {"storageState": marker}},
        {"type": "before", "callId": "call@1", "method": "fill", "params": {"value": marker}},
        {"type": "after", "callId": "call@1", "error": {"message": marker}},
        {"type": "console", "text": marker},
    ]
    archive.writestr("trace.trace", "\\n".join(map(json.dumps, events)))
    archive.writestr("trace.network", marker)
    archive.writestr("resources/body", marker)
    archive.writestr("trace.stacks", json.dumps({
        "files": [f"/{marker}/tests/inbox-browser.mjs", f"/{marker}/elsewhere.js"],
        "stacks": [[1, [[0, 23, 4, marker], [1, 10, 8, marker]]]],
    }))
runpy.run_path("tests/helpers/public-browser-trace.py")["public_trace"](raw, output)
with ZipFile(output) as archive:
    assert set(archive.namelist()) == {"trace.trace", "trace.stacks"}
    assert not any(marker.encode() in archive.read(name) for name in archive.namelist())
    events = [json.loads(line) for line in archive.read("trace.trace").splitlines()]
    assert [event["type"] for event in events] == ["context-options", "before", "after"]
    assert events[1]["method"] == "fill" and events[2]["error"]["name"] == "Error"
    assert json.loads(archive.read("trace.stacks")) == {
        "files": ["tests/inbox-browser.mjs", ""], "stacks": [[1, [[0, 23, 4, ""]]]],
    }
`], { cwd: repository, windowsHide: true });
});

test("Successful owner fixture shards retain every named journey PNG", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const steps = jobs["application-e2e"].steps;
  const journeys = steps.find(step => step.name === "Test application fixtures");
  const verify = steps.find(step => step.id === "journey-captures");
  const uploads = steps.filter(step =>
    step.uses?.startsWith("actions/upload-artifact@") && step.if !== "failure() || cancelled()");
  assert.equal(uploads.length, 1);
  const [upload] = uploads;
  const ownerSuccess = "success() && matrix.suite.roles == 'tenant_owner'";
  assert(journeys);
  assert(verify);
  assert.equal(verify.if, ownerSuccess);
  assert.equal(upload.if, ownerSuccess);
  assert(steps.indexOf(verify) > steps.indexOf(journeys));
  assert(steps.indexOf(upload) > steps.indexOf(verify));
  assert.equal(upload.with.name, "application-journey-captures-${{ matrix.locale }}-${{ matrix.suite.owner_part }}");
  assert.equal(upload.with.path, "${{ steps.journey-captures.outputs.paths }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 7);
  assert.deepEqual(verify.env, {
    CAPTURE_LOCALE: "${{ matrix.locale }}",
    CAPTURE_VIEWPORT: "${{ matrix.suite.owner_part == 'desktop' && 'desktop' || 'mobile-390' }}",
  });

  const directory = await mkdtemp(join(tmpdir(), "journey-captures-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = "tests/e2e/journey-captures.mjs";
  await mkdir(join(directory, posix.dirname(script)), { recursive: true });
  await writeFile(join(directory, script), await read(script));

  for (const locale of ["en", "ar"]) {
    const viewports = ["desktop", "mobile-390"];
    const allPaths = journeyCapturePaths(locale);
    assert.deepEqual(viewports.flatMap(viewport => journeyCapturePaths(locale, viewport)).sort(), allPaths.sort());
    assert.equal(new Set(allPaths).size, allPaths.length);
    for (const viewport of viewports) {
      const paths = journeyCapturePaths(locale, viewport);
      assert(paths.length > 1);
      for (const path of paths) {
        await mkdir(join(directory, posix.dirname(path)), { recursive: true });
        await writeFile(join(directory, path), "synthetic capture");
      }

      const output = join(directory, "outputs");
      const env = { CAPTURE_LOCALE: locale, CAPTURE_VIEWPORT: viewport, GITHUB_OUTPUT: output };
      const complete = runWorkflowScript(verify.run, env, directory);
      assert.equal(complete.status, 0, complete.stderr);
      assert.equal(await readFile(output, "utf8"), `paths<<CAPTURES\n${paths.join("\n")}\nCAPTURES\n`);

      const [first] = paths;
      await rename(join(directory, first), join(directory, first.replace(/\.png$/u, "-renamed.png")));
      await rm(output);
      const partial = runWorkflowScript(verify.run, env, directory);
      assert.equal(partial.status, 1, partial.stderr);
      assert(partial.stderr.includes(first), partial.stderr);
      await assert.rejects(readFile(output), { code: "ENOENT" });
    }
  }
});

test("critical review uses the base policy and checks PR and queue verdicts", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const gate = jobs["ci-gate"];
  const step = gate.steps.find(row => row.name === "Require the critical-path review verdict");
  assert.deepEqual(gate.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(step.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(step.env.REVIEW_BASE, "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}");
  assert.equal(step["continue-on-error"], undefined);

  const directory = await mkdtemp(join(tmpdir(), "wasalx-critical-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "responses.json");
  const eventPath = join(directory, "event.json");
  await writeFile(join(directory, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'test "$1" = api',
    "shift",
    'if [[ "$1" == graphql ]]; then',
    '  endpoint="graphql:${!#}"',
    'elif [[ "${2:-}" == --jq ]]; then',
    '  jq -e --arg key "$1" \'.[$key]\' "$REVIEW_FIXTURE" | jq -r "$3"',
    '  exit',
    'else',
    '  endpoint="${!#}"',
    'fi',
    'jq -er --arg key "$endpoint" \'.[$key]\' "$REVIEW_FIXTURE"',
  ].join("\n"), { mode: 0o755 });

  const [base, head, reviewed, candidate, headTree, reviewedTree, blob, otherBlob] =
    Array.from("abcdef01", char => char.repeat(40));
  const repo = "example/fixture";
  const origin = "repos/" + repo;
  const policyPath = ".github/critical-paths.json";
  const installed = ["critical-paths.json", "critical-review.py"].map(name => ({ type: "file", name }));
  const baseDirectory = origin + "/contents/.github?ref=" + base;
  const candidateDirectory = origin + "/contents/.github?ref=" + candidate;
  const policy = JSON.parse(await read(policyPath));
  const script = await read(".github/critical-review.py");
  const [reviewer] = policy.reviewerAccountIds;
  assert.equal(reviewer, 357558349);

  const filename = "services/control-api/src/webhook-ingress.controller.ts";
  const changed = { filename, status: "modified" };
  const docs = { filename: "README.md", status: "modified" };
  const verdict = (body, id = reviewer) => ({ id: 1, user: { id }, body });
  const go = verdict("VERDICT: GO " + head);
  const priorGo = verdict("VERDICT: GO " + reviewed);
  const noGo = verdict("VERDICT: NO_GO " + reviewed);
  const file = (sha, mode = "100644") => ({ path: filename, type: "blob", mode, sha });
  const tree = (sha, entries) => ({ sha, tree: entries, truncated: false });

  const run = async ({
    files = [changed], comments = [[go]], current = [file(blob)], earlier = current,
    queue = false, badRef = false, staleEntry = false, failure, override = {}, expected,
  }) => {
    const number = queue ? 205 : 104;
    const ref = queue
      ? "refs/heads/gh-readonly-queue/main/" + (badRef ? "group-" : "pr-") + number + "-" + head
      : "refs/pull/" + number + "/merge";
    const pr = { number, state: "open", head: { sha: head }, base: { sha: base }, changed_files: files.length };
    const group = { base_ref: "refs/heads/main", base_sha: base, head_sha: candidate, head_ref: ref };
    const pull = origin + "/pulls/" + number;
    const commentsEndpoint = origin + "/issues/" + number + "/comments?per_page=100";
    const responses = {
      [baseDirectory]: installed,
      [origin + "/contents/" + policyPath + "?ref=" + base]: policy,
      [origin + "/contents/.github/critical-review.py?ref=" + base]: script,
      [pull]: pr,
      [pull + "/files?per_page=100"]: [files],
      [commentsEndpoint]: comments,
      [origin + "/git/commits/" + head]: { sha: head, tree: { sha: headTree } },
      [origin + "/git/commits/" + reviewed]: { sha: reviewed, tree: { sha: reviewedTree } },
      [origin + "/git/trees/" + headTree + "?recursive=1"]: tree(headTree, current),
      [origin + "/git/trees/" + reviewedTree + "?recursive=1"]: tree(reviewedTree, earlier),
      "graphql:number=205": {
        data: { repository: { pullRequest: {
          headRefOid: head,
          mergeQueueEntry: { baseCommit: { oid: base }, headCommit: { oid: staleEntry ? head : candidate } },
        } } },
      },
      ...override,
    };
    if (failure === "files") delete responses[pull + "/files?per_page=100"];
    if (failure === "comments") delete responses[commentsEndpoint];
    if (failure === "commit") delete responses[origin + "/git/commits/" + reviewed];
    if (failure === "snapshot") responses[pull].changed_files += 1;
    await writeFile(fixture, JSON.stringify(responses));
    await writeFile(eventPath, JSON.stringify(queue ? { merge_group: group } : { pull_request: pr }));
    const result = runWorkflowScript(step.run, {
      PATH: directory + ":" + process.env.PATH, REVIEW_FIXTURE: fixture, RUNNER_TEMP: directory,
      REVIEW_BASE: base, GITHUB_REPOSITORY: repo, GITHUB_REF: ref, GITHUB_SHA: candidate,
      GITHUB_EVENT_NAME: queue ? "merge_group" : "pull_request", GITHUB_EVENT_PATH: eventPath,
    }, directory);
    assert.ifError(result.error);
    assert.equal(result.status, expected instanceof RegExp ? 1 : expected ?? 0, result.stdout + result.stderr);
    if (expected instanceof RegExp) assert.match(result.stderr, expected);
    return result.stdout;
  };

  const missing = /needs a VERDICT: GO/u;
  const stale = /changed critical paths/u;
  const malformed = /malformed verdict/u;
  const apiError = /Critical review gate failed/u;
  const cases = [
    ["docs only with no comment API call", { files: [docs], failure: "comments" }],
    ["webhook ingress change missing a verdict", { comments: [], expected: missing }],
    ["Zammad internal ticket context change missing a verdict", {
      files: [{ filename: "services/control-api/src/zammad-internal.controller.ts", status: "modified" }],
      comments: [], expected: missing,
    }],
    ["verdict from an unlisted account", { comments: [[verdict(go.body, reviewer + 1)]], expected: missing }],
    ["GO on the exact PR head", {}],
    ["GO followed by a noncritical edit", { comments: [[priorGo]], files: [changed, docs] }],
    ["newest verdict is NO_GO", { comments: [[go], [noGo]], expected: /NO_GO/u }],
    ["new GO supersedes a NO_GO", { comments: [[noGo], [go]] }],
    ["newer non-verdict comment is ignored", { comments: [[go], [verdict("Review notes only")]] }],
    ["newer untrusted verdict is ignored", { comments: [[go], [verdict(noGo.body, reviewer + 1)]] }],
    ["an abbreviated SHA fails over an older GO", { comments: [[go], [verdict("VERDICT: GO abc")]], expected: malformed }],
    ["two verdict lines in one comment", { comments: [[verdict(go.body + "\n" + noGo.body)]], expected: malformed }],
    ["a change after a GO", { comments: [[priorGo]], earlier: [file(otherBlob)], expected: stale }],
    ["a file mode change after a GO", { comments: [[priorGo]], earlier: [file(blob, "100755")], expected: stale }],
    ["a deletion after a GO", { comments: [[priorGo]], current: [], earlier: [file(blob)], expected: stale }],
    ["a deletion already covered by a GO", { comments: [[priorGo]], current: [], earlier: [] }],
    ["a critical path renamed out of scope", {
      files: [{ ...docs, status: "renamed", previous_filename: filename }], comments: [], expected: missing,
    }],
    ["a proposed path list cannot remove its own review", {
      files: [{ filename: policyPath, status: "modified" }], comments: [], expected: missing,
      override: { [origin + "/contents/" + policyPath + "?ref=" + head]: { ...policy, classes: {} } },
    }],
    ["failed files API call", { failure: "files", expected: apiError }],
    ["failed comments API call", { failure: "comments", expected: apiError }],
    ["unavailable reviewed commit", { comments: [[priorGo]], failure: "commit", expected: apiError }],
    ["truncated commit tree", {
      comments: [[priorGo]], expected: /complete tree/u,
      override: { [origin + "/git/trees/" + reviewedTree + "?recursive=1"]: { ...tree(reviewedTree, []), truncated: true } },
    }],
    ["incomplete file snapshot", { failure: "snapshot", expected: /snapshot is incomplete/u }],
    ["queue entry selects its own PR and head", { queue: true }],
    ["docs-only queue entry ignores earlier entries", { queue: true, files: [docs], failure: "comments" }],
    ["unresolvable queue ref", { queue: true, badRef: true, expected: /Merge-group ref/u }],
    ["stale queue entry", { queue: true, staleEntry: true, expected: /merge-group candidate/u }],
    ["incomplete base installation fails closed", { override: { [baseDirectory]: installed.slice(0, 1) }, expected: 1 }],
  ];
  for (const [name, input] of cases) await t.test(name, () => run(input));

  for (const criticalPath of [
    "services/control-api/src/meta-deletion.service.ts",
    "app/api/meta-deletion/status/route.ts",
    "services/control-api/src/invitation-token.service.ts",
    "services/control-api/src/native-membership.controller.ts",
    "app/api/invitations/accept/start/route.ts",
    "app/api/team/invitations/route.ts",
    "packages/core/src/direct-keep-open.ts",
    "services/connector-worker/src/main.ts",
    "services/connector-worker/src/meta-account-transition-execution-repository.ts",
    "services/connector-worker/src/meta-account-transition-execution.ts",
    "services/connector-worker/src/meta-account-transition-processor.ts",
    "services/connector-worker/src/meta-account-transition-target.ts",
    "services/connector-worker/src/meta-legacy-migration-repository.ts",
    "services/connector-worker/src/meta-legacy-migration.ts",
    "services/connector-worker/src/meta-managed-funding.ts",
    "services/connector-worker/src/meta-template-preparation-repository.ts",
    "services/connector-worker/src/meta-template-preparation.ts",
    "services/connector-worker/src/routing-sync-processor.ts",
    "services/connector-worker/src/waha-worker-registry.ts",
    "services/control-api/src/health.controller.ts",
    "services/control-api/src/meta-managed-approval.service.ts",
    "services/control-api/src/tenant-health.controller.ts",
    "services/control-api/src/waha-workers.controller.ts",
    "package.json",
  ]) {
    await t.test(criticalPath + " requires a verdict", () => run({
      files: [{ filename: criticalPath, status: "modified" }], comments: [], expected: missing,
    }));
  }
  await t.test("a lockfile-only update passes without a verdict", () => run({
    files: [{ filename: "pnpm-lock.yaml", status: "modified" }], failure: "comments",
  }));

  await t.test("the first installation requires both files and manual workflow review", async () => {
    const override = { [baseDirectory]: [], [candidateDirectory]: installed };
    const output = await run({ override });
    assert.match(output, /^Python 3\./mu);
    assert.match(output, /requires manual workflow review/u);
    await run({ override: { ...override, [candidateDirectory]: installed.slice(0, 1) }, expected: 1 });
  });
});

test("CI gate requires each event's jobs and rejects unplanned skips, failures, and cancellations", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const { "ci-gate": gate, checks } = jobs;
  const [{ run, env }] = gate.steps;
  const lint = checks.steps.find(step => step.name === "Lint");
  assert(gate.needs.includes("checks"));
  assert.equal(env.CHECKS, "${{ needs.checks.result }}");
  assert.equal(checks.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  assert(checks.strategy.matrix.include.some(row => row.mode === "lint"));
  assert.equal(checks["continue-on-error"], undefined);
  assert.equal(lint.if, "matrix.mode == 'lint'");
  assert.equal(lint["continue-on-error"], undefined);
  const injectedLint = runWorkflowScript(`
pnpm() {
  [[ "$1 $2" == "run lint" ]] || return 99
  return 17
}
${lint.run}`, {});
  assert.ifError(injectedLint.error);
  assert.equal(injectedLint.status, 17, injectedLint.stderr);

  const directory = await mkdtemp(join(tmpdir(), "ci-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const pr = {
    EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success", IMAGES_NEEDED: "false", IMAGES: "skipped",
    INTEGRATION_NEEDED: "true", INTEGRATION: "success", PORTAL_INTEGRATION: "success",
    INTEGRATION_COVERAGE: "success", INFRA_NEEDED: "true", INFRA: "success",
    DEV_INSTALL_NEEDED: "true", DEV_INSTALL: "success", STORYBOOK_NEEDED: "true", STORYBOOK: "success",
    ZAMMAD_NEEDED: "true", ZAMMAD_COMPATIBILITY: "success",
    INSTALLER_PORTAL_NEEDED: "true", INSTALLER_PORTAL: "success",
    APPLICATION_NEEDED: "true", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success",
  };
  const unselected = {
    ...pr, INTEGRATION_NEEDED: "false", INTEGRATION: "skipped", PORTAL_INTEGRATION: "skipped",
    INTEGRATION_COVERAGE: "skipped", INFRA_NEEDED: "false", INFRA: "skipped",
    DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped", STORYBOOK_NEEDED: "false", STORYBOOK: "skipped",
    ZAMMAD_NEEDED: "false", ZAMMAD_COMPATIBILITY: "skipped",
    INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
    APPLICATION_NEEDED: "false", APPLICATION_E2E: "skipped", PLATFORM_OPERATOR_E2E: "skipped", KEYCLOAK_IDENTITY_NEEDED: "false", KEYCLOAK_IDENTITY: "skipped",
  };
  const queue = {
    ...pr, EVENT: "merge_group", REVIEW: "skipped", IMAGES_NEEDED: "true", IMAGES: "success",
    INTEGRATION_NEEDED: "", INFRA_NEEDED: "", DEV_INSTALL_NEEDED: "", DEV_INSTALL: "skipped", STORYBOOK_NEEDED: "", APPLICATION_NEEDED: "",
    ZAMMAD_NEEDED: "",
  };
  const dispatch = { ...queue, EVENT: "workflow_dispatch", CHANGES: "skipped", CHECKS: "skipped", FULL_UNIT: "success",
    IMAGES: "skipped", INSTALLER_PORTAL_NEEDED: "", INSTALLER_PORTAL: "skipped", INFRA: "skipped", PRIVACY: "skipped" };

  const operatorOnly = { ...pr, KEYCLOAK_IDENTITY_NEEDED: "false", KEYCLOAK_IDENTITY: "skipped" };
  const keycloakOnly = { ...unselected, KEYCLOAK_IDENTITY_NEEDED: "true", KEYCLOAK_IDENTITY: "success" };

  for (const [lane, result, override, expected] of [
    ["PR with selected jobs", pr, {}, 0],
    ["PR with unselected jobs", unselected, {}, 0],
    ["PR with Keycloak unselected and operator selected", operatorOnly, {}, 0],
    ["PR with Keycloak unselected and operator failing", operatorOnly, { PLATFORM_OPERATOR_E2E: "failure" }, 1],
    ["PR with Keycloak unselected and operator result missing", operatorOnly, { PLATFORM_OPERATOR_E2E: "" }, 1],
    ["PR with operator unselected and Keycloak selected", keycloakOnly, {}, 0],
    ["PR with operator unselected and Keycloak failing", keycloakOnly, { KEYCLOAK_IDENTITY: "failure" }, 1],
    ["PR with operator unselected and Keycloak result missing", keycloakOnly, { KEYCLOAK_IDENTITY: "" }, 1],
    ["PR with a failed signed-in operator shard", pr, { PLATFORM_OPERATOR_E2E: "failure" }, 1],
    ["PR with selected signed-in operator skipped", pr, { PLATFORM_OPERATOR_E2E: "skipped" }, 1],
    ["PR with a failed Keycloak identity job", pr, { KEYCLOAK_IDENTITY: "failure" }, 1],
    ["PR with Keycloak identity skipped without selection evidence", unselected, { KEYCLOAK_IDENTITY_NEEDED: "" }, 1],
    ["merge queue with Keycloak identity skipped", queue, { KEYCLOAK_IDENTITY: "skipped" }, 1],
    ["PR with a failed application shard", pr, { APPLICATION_E2E: "failure" }, 1],
    ["PR with a cancelled application shard", pr, { APPLICATION_E2E: "cancelled" }, 1],
    ["PR with application skipped without selection evidence", unselected, { APPLICATION_NEEDED: "" }, 1],
    ["merge queue with application skipped", queue, { APPLICATION_E2E: "skipped" }, 1],
    ["PR with a failed Storybook audit", pr, { STORYBOOK: "failure" }, 1],
    ["PR with selected Storybook skipped", pr, { STORYBOOK: "skipped" }, 1],
    ["PR with a cancelled Storybook audit", unselected, { STORYBOOK: "cancelled" }, 1],
    ["PR with Storybook skipped without selection evidence", unselected, { STORYBOOK_NEEDED: "" }, 1],
    ["PR without a recorded skip reason", unselected, { INTEGRATION_NEEDED: "" }, 1],
    ["PR with selected images passing", pr, { IMAGES_NEEDED: "true", IMAGES: "success" }, 0],
    ["PR with selected images failing", pr, { IMAGES_NEEDED: "true", IMAGES: "failure" }, 1],
    ["PR with selected images cancelled", pr, { IMAGES_NEEDED: "true", IMAGES: "cancelled" }, 1],
    ["PR with selected images skipped", pr, { IMAGES_NEEDED: "true", IMAGES: "skipped" }, 1],
    ["PR with missing image selection", pr, { IMAGES_NEEDED: "", IMAGES: "skipped" }, 1],
    ["PR with failed unselected images", pr, { IMAGES: "failure" }, 1],
    ["PR with failed Zammad compatibility", pr, { ZAMMAD_COMPATIBILITY: "failure" }, 1],
    ["PR with cancelled Zammad compatibility", pr, { ZAMMAD_COMPATIBILITY: "cancelled" }, 1],
    ["PR with missing Zammad selection", unselected, { ZAMMAD_NEEDED: "" }, 1],
    ["PR with a selected Zammad job skipped", pr, { ZAMMAD_COMPATIBILITY: "skipped" }, 1],
    ["PR with a privacy finding", pr, { PRIVACY: "failure" }, 1],
    ["PR with a skipped privacy scan", pr, { PRIVACY: "skipped" }, 1],
    ["merge queue with a cancelled privacy scan", queue, { PRIVACY: "cancelled" }, 1],
    ["merge queue with a failed privacy scan", queue, { PRIVACY: "failure" }, 1],
    ["PR with new workflow lint findings", pr, { WORKFLOW_LINT: "failure" }, 1],
    ["PR with workflow lint skipped", pr, { WORKFLOW_LINT: "skipped" }, 1],
    ["PR with installer portal build failing", pr, { INSTALLER_PORTAL: "failure" }, 1],
    ["PR with installer portal build skipped despite selection", pr, { INSTALLER_PORTAL: "skipped" }, 1],
    ["PR with no installer portal selection evidence", unselected, { INSTALLER_PORTAL_NEEDED: "" }, 1],
    ["merge queue", queue, {}, 0],
    ["merge queue with Storybook skipped", queue, { STORYBOOK: "skipped" }, 1],
    ["merge queue with failed images", queue, { IMAGES: "failure" }, 1],
    ["merge queue with an injected lint failure", queue, { CHECKS: injectedLint.status === 0 ? "success" : "failure" }, 1],
    ["merge queue with cancelled checks", queue, { CHECKS: "cancelled" }, 1],
    ["merge queue with skipped checks", queue, { CHECKS: "skipped" }, 1],
    ["merge queue with missing checks result", queue, { CHECKS: "" }, 1],
    ["manual dispatch with failed units", dispatch, { FULL_UNIT: "failure" }, 1],
    ["manual dispatch with cancelled units", dispatch, { FULL_UNIT: "cancelled" }, 1],
    ["merge queue with failed integration", queue, { INTEGRATION: "failure" }, 1],
    ["merge queue with failed Zammad compatibility", queue, { ZAMMAD_COMPATIBILITY: "failure" }, 1],
    ["merge queue with skipped infrastructure", queue, { INFRA: "skipped" }, 1],
    ["merge queue with cancelled selection", queue, { CHANGES: "cancelled" }, 1],
    ["merge queue with Zammad compatibility skipped without an applicable diff", queue, { ZAMMAD_COMPATIBILITY: "skipped" }, 1],
    ["merge queue with selected Zammad compatibility skipped", queue, { ZAMMAD_NEEDED: "true", ZAMMAD_COMPATIBILITY: "skipped" }, 1],
    ["merge queue without affected Zammad paths", queue, { ZAMMAD_NEEDED: "false", ZAMMAD_COMPATIBILITY: "skipped" }, 0],
    ["merge queue missing the installer portal build", queue, { INSTALLER_PORTAL_NEEDED: "true", INSTALLER_PORTAL: "skipped" }, 1],
    ["merge queue with missing installer selection", queue, { INSTALLER_PORTAL_NEEDED: "", INSTALLER_PORTAL: "skipped" }, 1],
    ["merge queue with optional checks outside the diff", queue, {
      INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
      STORYBOOK_NEEDED: "false", STORYBOOK: "skipped", INFRA_NEEDED: "false", INFRA: "skipped",
    }, 0],
    ["manual dispatch", dispatch, {}, 0],
    ["manual dispatch with Storybook skipped", dispatch, { STORYBOOK: "skipped" }, 1],
    ["manual dispatch with skipped units", dispatch, { FULL_UNIT: "skipped" }, 1],
    ["manual dispatch with cancelled infrastructure", dispatch, { INFRA: "cancelled" }, 1],
  ]) {
    const execution = runWorkflowScript(run, { ...result, ...override, GITHUB_STEP_SUMMARY: summary });
    assert.ifError(execution.error);
    assert.equal(execution.status, expected, `${lane}: ${execution.stderr}`);
  }
  assert.match(await readFile(summary, "utf8"), /Event workflow_dispatch ran both full unit shards/u);
});

test("browser jobs restore the pinned Playwright Chromium build before downloading it", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const path = "${{ github.workspace }}/.wrangler/ci-chromium";
  const onMiss = "steps.chromium-cache.outputs.cache-hit != 'true'";
  for (const id of ["storybook", "portal-browser-build", "keycloak-identity", "seed-caches"]) {
    const job = jobs[id];
    const restoreIndex = job.steps.findIndex(step => step.id === "chromium-cache");
    assert(restoreIndex > 0, id);
    const [version, restore, install] = job.steps.slice(restoreIndex - 1, restoreIndex + 2);
    assert.equal(version.id, "playwright-version", id);
    assert.match(version.run, /require\('@playwright\/test\/package\.json'\)\.version/u, id);
    assert.match(restore.uses, /^actions\/cache\/restore@[a-f0-9]{40}$/u, id);
    assert.deepEqual(restore.with, {
      path,
      key: "playwright-chromium-no-shell-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-version.outputs.version }}",
    }, id);
    assert.equal(install.if, onMiss, id);
    assert.equal(install.env.PLAYWRIGHT_BROWSERS_PATH, path, id);
    assert.equal(install.run, "pnpm exec playwright install --no-shell chromium", id);
    if (id !== "seed-caches") assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, path, id);
  }
  const seed = jobs["seed-caches"].steps;
  const save = seed[seed.findIndex(step => step.name === "Install Playwright Chromium") + 1];
  assert.match(save.uses, /^actions\/cache\/save@[a-f0-9]{40}$/u);
  assert.equal(save.if, onMiss);
  assert.deepEqual(save.with, { path, key: "${{ steps.chromium-cache.outputs.cache-primary-key }}" });

  for (const [id, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.with?.path?.includes(".wrangler/ci-chromium")) continue;
      if (step.uses?.startsWith("actions/cache/restore@")) {
        assert.equal(step.env?.SEGMENT_DOWNLOAD_TIMEOUT_MINS, "1", id);
      }
      if (id !== "seed-caches") assert(!/^actions\/cache(?:\/save)?@/u.test(step.uses ?? ""), id);
    }
  }
});

test("main pushes only publish and seed caches", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const mainPush = "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'WasalX/wasalx-platform'";
  const pushJobs = Object.keys(jobs).filter(id => jobs[id].if?.includes(mainPush));
  assert.deepEqual(pushJobs.sort(), ["publish", "seed-caches"]);
  const dependencyGuards = {
    "portal-integration": "needs.portal-browser-build.result == 'success'",
    "application-e2e": "needs.portal-browser-build.result == 'success'",
    "platform-operator-e2e": "needs.portal-browser-build.result == 'success'",
    "integration-coverage": "needs.integration.result != 'skipped'",
    "installer-portal": "needs.changes.outputs.installer-portal == 'true'",
  };
  for (const [id, job] of Object.entries(jobs)) {
    if (pushJobs.includes(id)) continue;
    assert.doesNotMatch(job.if, /github\.event_name == 'push'/u, id);
    if (dependencyGuards[id]) assert(job.if.includes(dependencyGuards[id]), id);
    else assert.match(job.if, /github\.event_name (?:!= 'push'|== '(?:pull_request|merge_group|workflow_dispatch)')/u, id);
  }

  const seed = jobs["seed-caches"];
  assert.equal(seed.if, mainPush);
  assert.equal(seed["continue-on-error"], true);
  assert.equal(seed.needs, undefined);
  assert.equal(jobs.publish.needs, undefined);
  assert(!jobs["ci-gate"].needs.includes("seed-caches"));
  const pnpmActions = seed.steps.filter(step => step.uses === "./.github/actions/ci-pnpm");
  const dependencyKey = "${{ steps.pnpm.outputs.dependency-key }}";
  assert.equal(pnpmActions[0].id, "pnpm");
  assert.deepEqual(pnpmActions.map(step => step.with), [
    { "seed-dependencies": "true" },
    { task: "build", "dependency-key": dependencyKey, "force-build": "true" },
    { task: "save-build", "dependency-key": dependencyKey },
  ]);
  const lint = "pnpm run lint --cache --cache-strategy content --cache-location .git/hosted-eslint-cache";
  const prepare = jobs["workflow-lint"].steps.find(step => step.name === "Prepare pinned actionlint");
  const sourceRuntime = seed.steps.find(step => step.id === "source-hook-runtime");
  const sourceInstall = seed.steps.find(step => step.name === "Install source hook environments");
  const playwrightVersion = jobs.storybook.steps.find(step => step.id === "playwright-version");
  const chromiumInstall = jobs.storybook.steps.find(step => step.name === "Install Playwright Chromium");
  assert.deepEqual(seed.steps.flatMap(step => step.run ?? []), [
    lint, prepare.run, sourceRuntime.run, sourceInstall.run, playwrightVersion.run, chromiumInstall.run,
  ]);
  const eslintSave = seed.steps.find(step => step.uses?.startsWith("actions/cache/save@")
    && step.with.path === ".git/hosted-eslint-cache");
  assert.equal(eslintSave.if, "steps.eslint-cache.outputs.cache-hit != 'true'");
  assert.deepEqual(eslintSave.with, {
    path: ".git/hosted-eslint-cache", key: "${{ steps.eslint-cache.outputs.cache-primary-key }}",
  });
  const lintIndex = seed.steps.findIndex(step => step.run === lint);
  assert(lintIndex >= 0);
  assert(lintIndex < seed.steps.indexOf(eslintSave));
});

test("CI restores pnpm caches and builds cleanly in the merge queue", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const actionPath = "./.github/actions/ci-pnpm";
  const action = parse(await read(".github/actions/ci-pnpm/action.yml"));

  for (const job of [jobs.checks, jobs.integration]) {
    assert.equal(job.steps.find(step => step.id === "pnpm")?.uses, actionPath);
  }
  const eslintRestore = jobs.checks.steps.find(step => step.id === "eslint-cache");
  assert.match(eslintRestore.uses, /^actions\/cache\/restore@/u);
  assert.equal(eslintRestore.with["fail-on-cache-miss"], undefined);
  const modules = action.runs.steps.find(step => step.id === "modules");
  const store = action.runs.steps.find(step => step.id === "store");
  const comparisonStore = jobs["typescript-comparison"].steps.find(step => step.with?.path === "${{ env.PNPM_STORE_PATH }}");
  for (const step of [modules, store, comparisonStore]) {
    assert.match(step.uses, /^actions\/cache\/restore@/u);
    assert.equal(step.env?.SEGMENT_DOWNLOAD_TIMEOUT_MINS, "1", step.id ?? step.with.path);
  }
  assert(action.runs.steps.indexOf(modules) < action.runs.steps.indexOf(store));
  assert(store?.if.includes("steps.modules.outputs.cache-hit != 'true'"));
  assert.equal(modules.with.key, "${{ steps.pnpm.outputs.dependency-key }}");
  assert(!Object.hasOwn(modules.with, "restore-keys"), "Workspace modules require an exact dependency key");

  const keyStep = action.runs.steps.find(step => step.id === "pnpm");
  assert.deepEqual(keyStep.env, {
    MODULES_HASH: "${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package.json', 'patches/**', '.npmrc') }}",
    RUNNER_PLATFORM: "${{ runner.os }}-${{ runner.arch }}",
  });
  const directory = await mkdtemp(join(tmpdir(), "wasalx-cache-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyScript = 'corepack() { :; }\npnpm() { echo store; }\nnode() { echo "$NODE_VERSION"; }\n' + keyStep.run;
  for (const [index, platform, version, hash] of [
    [1, "Linux-X64", "v24.13.1", "hash1"],
    [2, "Linux-ARM64", "v24.13.1", "hash1"],
    [3, "Linux-X64", "v24.13.2", "hash1"],
    [4, "Linux-X64", "v24.13.1", "hash2"],
  ]) {
    const output = join(directory, String(index)).replaceAll("\\", "/");
    const result = runWorkflowScript(keyScript, {
      GITHUB_OUTPUT: output, MODULES_HASH: hash, RUNNER_PLATFORM: platform, NODE_VERSION: version,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), "store=store\n" +
      `dependency-key=pnpm-modules-v1-${platform}-${version}-${hash}`);
  }

  const mainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  const saveSteps = action.runs.steps.filter(step => step.uses?.startsWith("actions/cache/save@"));
  assert.equal(saveSteps.length, 3);
  for (const step of saveSteps) {
    assert(step.if.includes(mainOnly));
    assert(step.if.includes("github.repository == 'WasalX/wasalx-platform'"));
  }

  const build = jobs.checks.steps.find(step => step.with?.task === "build");
  assert.equal(build?.with["force-build"], "${{ github.event_name == 'merge_group' && matrix.mode == 'typecheck' }}");
  for (const job of [jobs.integration, jobs["portal-integration"]]) {
    const build = job.steps.find(step => step.uses === actionPath && step.with?.task === "build");
    assert.equal(build?.with["force-build"], "true");
  }
  const restore = action.runs.steps.find(step => step.id === "services");
  assert(restore?.if.includes("inputs.force-build != 'true'"));
  assert(restore.if.includes("github.event_name == 'merge_group'"));
  assert(restore.if.includes("github.event_name == 'pull_request'"));
  assert.equal(restore.with.key, "${{ steps.build-key.outputs.key }}");
  assert.equal(restore.with["restore-keys"], "${{ github.event_name == 'pull_request' && steps.build-key.outputs.prefix || '' }}");
  assert.equal(action.runs.steps.find(step => step.id === "build-key").env.BUILD_CONFIG,
    "${{ hashFiles('tsconfig.json', 'services/*/tsconfig*.json', 'packages/*/tsconfig*.json', 'scripts/build-services.mjs', '.gitattributes') }}");
  assert.equal(action.runs.steps.find(step => step.name === "Report service build cache hit").if,
    "always() && inputs.task == 'build'");

  const commands = name => 'pnpm() { printf "%s\\n" "$*"; }\n' + action.runs.steps.find(step => step.name === name).run;
  const install = 'rm() { echo "cleanup $*"; }\n' + commands("Install workspace dependencies");
  for (const [hit, lines] of [
    ["true", ["install --frozen-lockfile --offline"]],
    ["false", ["cleanup -rf -- node_modules services/*/node_modules packages/*/node_modules",
      "install --frozen-lockfile --fetch-retries=2"]],
    ["", ["cleanup -rf -- node_modules services/*/node_modules packages/*/node_modules",
      "install --frozen-lockfile --fetch-retries=2"]],
  ]) {
    const result = runWorkflowScript("set -f\n" + install, { MODULES_HIT: hit });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), lines);
  }
  for (const [force, exact, matched, suffix] of [
    ["true", "", "", " --force"],
    ["false", "true", "main-key", " --build"],
    ["false", "", "", " --build"],
    ["false", "false", "main-key", " --incremental"],
  ]) {
    const result = runWorkflowScript(commands("Build services"), {
      FORCE_BUILD: force, EXACT_BUILD: exact, MATCHED_BUILD: matched,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `run build:services${suffix}`);
  }
});

test("signing, promotion and nightly workflows use the same Cosign pin", async () => {
  const pinPath = "scripts/release/cosign-pin.json";
  const pin = JSON.parse(await read(pinPath));
  assert.match(pin.version, /^v\d+\.\d+\.\d+$/u);
  assert.match(pin.linuxAmd64Sha256, /^[0-9a-f]{64}$/u);

  const installJobs = {
    "branch-image": ["publish"],
    release: ["stg", "prod"],
    "nightly-install": ["nightly-install"],
    "zammad-compatibility": [],
  };
  for (const [workflow, expectedJobs] of Object.entries(installJobs)) {
    const { jobs } = parse(await read(`.github/workflows/${workflow}.yml`));
    for (const [job, { steps = [] }] of Object.entries(jobs)) {
      const installs = steps.filter(step => step.uses === cosignAction || step.uses?.startsWith("sigstore/cosign-installer@"));
      assert.deepEqual(installs.map(step => step.uses), expectedJobs.includes(job) ? [cosignAction] : [], `${workflow}/${job}`);
    }
  }

  const { runs } = parse(await read(`${cosignAction}/action.yml`));
  const [version, install, verify] = runs.steps;
  assert.match(version.run, /jq -er '.version' scripts\/release\/cosign-pin\.json/u);
  assert.equal(install.with["cosign-release"], "${{ steps.pin.outputs.version }}");
  assert.match(install.uses, /^sigstore\/cosign-installer@[0-9a-f]{40}$/u);
  for (const script of [verify.run, await read("scripts/release/promote-tag.sh")]) {
    assert.match(script, /jq -er '.linuxAmd64Sha256' scripts\/release\/cosign-pin\.json/u);
    assert.match(script, /sha256sum --check --strict/u);
  }
  assert.match(await read("scripts/dev-install/pull-verify.mjs"),
    /assert\.equal\(hash\.digest\("hex"\), cosignPin\.linuxAmd64Sha256/u);
});

test("PR image results gate affected changes while the merge queue requires the full image matrix", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const branch = parse(await read(".github/workflows/branch-image.yml")).jobs;
  const { images, "pr-images": prImages, "pr-image-results": report, "ci-gate": gate, publish } = jobs;
  assert.equal(gate.if, "always() && github.event_name != 'push'");
  assert(gate.needs.includes("images"));
  assert(gate.needs.includes("pr-images"));
  assert(!gate.needs.includes("pr-image-results"));
  assert.deepEqual(images.needs, ["changes"]);
  assert.deepEqual(prImages.needs, images.needs);
  assert.equal(images.if, "${{ !cancelled() && github.event_name == 'merge_group' && needs.changes.outputs.images == 'true' }}");
  assert.equal(prImages.if, "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.images == 'true' }}");
  assert.equal(images.strategy["max-parallel"], 21);
  assert.deepEqual(prImages.strategy, { ...images.strategy, "max-parallel": 8 });
  assert.equal(prImages.steps, images.steps);
  const imageBuilder = images.steps.find(step => step.uses?.startsWith("docker/setup-buildx-action@"));
  const publisherBuilder = branch.publish.steps.find(step => step.uses?.startsWith("docker/setup-buildx-action@"));
  assert.equal(imageBuilder.uses, publisherBuilder.uses);
  assert.equal(imageBuilder.with.version, publisherBuilder.with.version);
  assert.equal(imageBuilder.with["cache-binary"], true);
  assert.equal(publisherBuilder.with["cache-binary"], false);
  assert.equal(imageBuilder.with.cleanup, false);
  assert.equal(images["continue-on-error"], undefined);
  assert.equal(prImages["continue-on-error"], undefined);
  assert.equal(report.if, "always() && github.event_name == 'pull_request'");
  assert.equal(report.needs, "pr-images");
  assert.equal(report.steps[0].env.IMAGES, "${{ needs.pr-images.result }}");
  assert.equal(gate.steps[0].env.IMAGES, "${{ github.event_name == 'pull_request' && needs.pr-images.result || needs.images.result }}");
  assert.equal(gate.steps[0].env.IMAGES_NEEDED, "${{ needs.changes.outputs.images }}");
  assert.equal(publish.needs, undefined);
  assert.equal(branch.publish.needs, "queue");
  assert.equal(branch.queue.permissions.actions, "read");
  assert.equal(publish.permissions.actions, "read");
  const build = images.steps.find(step => step.name === "Build and inspect without publication");
  assert.equal(build.run, 'python3 scripts/release/images-by-digest.py build --cache read --image "$IMAGE" --output "records/$IMAGE.json"');
  assert.equal(publish.if, "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'WasalX/wasalx-platform' }}");
  assert.equal(publish.uses, "./.github/workflows/branch-image.yml");
  for (const id of ["workflow-lint", "portal-browser-build", "keycloak-identity", "zammad-compatibility"]) {
    assert.match(jobs[id].if, /github\.event_name != 'push'/u, id);
  }
  assert.equal(jobs.privacy.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  assert.deepEqual(publish.concurrency, { group: "release-${{ github.sha }}", "cancel-in-progress": false });
  assert.equal(branch.publish.strategy["max-parallel"], 21);
  assert.equal(branch.manifest.needs, "publish");
  assert.equal(branch.manifest.concurrency, undefined);
  assert.equal(branch.aliases, undefined);

  const directory = await mkdtemp(join(tmpdir(), "wasalx-ci-image-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const imageResult of ["success", "failure", "skipped", "cancelled"]) {
    const summary = join(directory, imageResult).replaceAll("\\", "/");
    const reportResult = runWorkflowScript(report.steps[0].run, { IMAGES: imageResult, GITHUB_STEP_SUMMARY: summary });
    assert.equal(reportResult.status, ["success", "skipped"].includes(imageResult) ? 0 : 1, reportResult.stderr);
    assert.equal((await readFile(summary, "utf8")).trim(), `PR image builds: ${imageResult}`);
    if (imageResult === "failure") assert.match(reportResult.stdout, /::error::PR image builds: failure/u);

    const result = runWorkflowScript(gate.steps[0].run, {
      EVENT: "merge_group", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "skipped",
      IMAGES_NEEDED: "true", IMAGES: imageResult, INTEGRATION: "success", PORTAL_INTEGRATION: "success",
      INTEGRATION_COVERAGE: "success", DEV_INSTALL: "skipped", INFRA: "success",
      ZAMMAD_COMPATIBILITY: "success",
      INSTALLER_PORTAL_NEEDED: "true", INSTALLER_PORTAL: "success",
    });
    assert.equal(result.status, imageResult === "success" ? 0 : 1, `merge_group/${imageResult}: ${result.stderr}`);
  }
  const summary = join(directory, "gate").replaceAll("\\", "/");
  const result = runWorkflowScript(gate.steps[0].run, {
    EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success",
    IMAGES_NEEDED: "false", IMAGES: "skipped", INTEGRATION_NEEDED: "false", INTEGRATION: "skipped",
    PORTAL_INTEGRATION: "skipped", INTEGRATION_COVERAGE: "skipped", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
    INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
    INFRA_NEEDED: "false", INFRA: "skipped", GITHUB_STEP_SUMMARY: summary,
    ZAMMAD_COMPATIBILITY: "success",
  });
  assert.equal(result.status, 0, result.stderr);
  assert((await readFile(summary, "utf8")).includes(report.name));
});

test("main publication requires a successful queue gate for the exact commit", async t => {
  const { jobs } = parse(await read(".github/workflows/branch-image.yml"));
  const script = jobs.queue.steps.find(step => step.id === "source").run;
  const directory = await mkdtemp(join(tmpdir(), "ci-queue-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md").replaceAll("\\", "/");
  const sha = "a".repeat(40);
  const repo = "WasalX/wasalx-platform";
  const row = { id: 123, run_attempt: 2, event: "merge_group", path: ".github/workflows/ci.yml",
    head_sha: sha, head_repository: { full_name: repo }, head_branch: "gh-readonly-queue/main/pr-1" };
  const gate = { name: "ci-gate", status: "completed", conclusion: "success" };
  const mock = String.raw`
gh() {
  case "$*" in
    *"/actions/workflows/ci.yml/runs -f event=merge_group -f head_sha=$GITHUB_SHA "*) printf '%s\n' "$RUNS" ;;
    "api --paginate --slurp repos/$GITHUB_REPOSITORY/actions/runs/123/attempts/2/jobs?per_page=100")
      printf '%s\n' "$JOB_PAGES" ;;
    "api repos/$GITHUB_REPOSITORY/actions/runs/123/attempts/2/jobs?per_page=100")
      jq '.[0]' <<< "$JOB_PAGES" ;;
    *) return 99 ;;
  esac
}
`;
  const otherJobs = Array.from({ length: 100 }, (_, index) => ({ name: `Build image ${index}` }));
  for (const [candidate, pages, expected] of [
    [row, [[gate]], true],
    [row, [otherJobs, [gate]], true],
    [row, [[gate, ...otherJobs.slice(1)], [gate]], false],
    [null, [[gate]], false],
    [row, [[]], false],
    [{ ...row, head_sha: "b".repeat(40) }, [[gate]], false],
    [{ ...row, event: "pull_request" }, [[gate]], false],
    [{ ...row, head_branch: "gh-readonly-queue/other/pr-1" }, [[gate]], false],
    [row, [[{ ...gate, conclusion: "failure" }]], false],
    [row, [[{ ...gate, status: "in_progress" }]], false],
  ]) {
    await writeFile(summary, "");
    const result = runWorkflowScript(mock + script, {
      GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GITHUB_STEP_SUMMARY: summary,
      RUNS: JSON.stringify({ total_count: candidate ? 1 : 0, workflow_runs: candidate ? [candidate] : [] }),
      JOB_PAGES: JSON.stringify(pages.map(jobs => ({ total_count: pages.flat().length, jobs }))),
    });
    assert.ifError(result.error);
    assert.equal(result.status === 0, expected, result.stderr);
    assert.equal(await readFile(summary, "utf8"), expected ? `Queue ci-gate passed for ${sha} in run 123 (attempt 2).\n` : "");
  }
});

test("main alias updates report independently and use the exact successful CI attempt's manifest", async t => {
  const workflow = parse(await read(".github/workflows/main-image-aliases.yml"));
  const { aliases } = workflow.jobs;
  assert.deepEqual(workflow.on, { workflow_run: { workflows: ["ci"], types: ["completed"], branches: ["main"] } });
  assert.match(aliases.if, /github\.repository == 'WasalX\/wasalx-platform'/u);
  assert.match(aliases.if, /head_repository\.full_name == github\.repository/u);
  assert.match(aliases.if, /path == '\.github\/workflows\/ci\.yml'/u);
  assert.match(aliases.if, /event == 'push'/u);
  assert.match(aliases.if, /head_branch == 'main'/u);
  assert.match(aliases.if, /conclusion == 'success'/u);
  assert.deepEqual(aliases.concurrency, { group: "release-main", queue: "max" });
  assert.equal(aliases["continue-on-error"], undefined);
  assert.deepEqual(aliases.steps.find(step => step.uses?.startsWith("actions/checkout@")).with,
    { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false });
  const resolve = aliases.steps.find(step => step.id === "artifact");
  const download = aliases.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(download.with,
    { "artifact-ids": "${{ steps.artifact.outputs.id }}", path: "${{ runner.temp }}/publication",
      "github-token": "${{ github.token }}", "run-id": "${{ github.event.workflow_run.id }}" });
  const validate = aliases.steps.find(step => step.id === "publication");
  assert.equal(validate.run,
    'python3 scripts/release/advance-main-image-aliases.py --validate-only "$RUNNER_TEMP/publication/images-manifest.json"');
  assert(aliases.steps.indexOf(resolve) < aliases.steps.indexOf(download));
  assert(aliases.steps.indexOf(download) < aliases.steps.indexOf(validate));
  assert.deepEqual(aliases.steps.slice(aliases.steps.indexOf(validate) + 1).map(step => step.if),
    Array(3).fill("steps.publication.outputs.ready == 'true'"));
  assert.equal(aliases.steps.at(-1).run,
    'python3 scripts/release/advance-main-image-aliases.py "$RUNNER_TEMP/publication/images-manifest.json"');
  assert.equal(aliases.steps.at(-1)["continue-on-error"], undefined);

  const { manifest } = parse(await read(".github/workflows/branch-image.yml")).jobs;
  const report = manifest.steps.find(step => step.id === "complete").run;
  const bind = manifest.steps.find(step => step.name === "Bind manifest bytes to this publishing attempt");
  const upload = manifest.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "images-manifest");
  assert.deepEqual(upload.with.path.trim().split("\n"), ["images-manifest.json", "images-manifest-attempt.json"]);
  assert(manifest.steps.indexOf(bind) < manifest.steps.indexOf(upload));
  const directory = await mkdtemp(join(tmpdir(), "wasalx-publication-outcome-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  for (const publicationComplete of [true, false]) {
    const summary = join(directory, String(publicationComplete));
    const output = summary + ".output";
    const manifestPath = join(directory, "images-manifest.json");
    const raw = JSON.stringify({ commit, publicationComplete }, null, 2) + "\n";
    await writeFile(manifestPath, raw);
    const binding = runWorkflowScript(bind.run, { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }, directory);
    assert.equal(binding.status, 0, binding.stderr);
    assert.equal(await readFile(manifestPath, "utf8"), raw);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "images-manifest-attempt.json"), "utf8")), {
      runId: "123", runAttempt: "2", manifestSha256: "sha256:" + createHash("sha256").update(raw).digest("hex"),
    });
    const result = runWorkflowScript(report, {
      GITHUB_SHA: commit, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
    }, directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `complete=${publicationComplete}`);
    assert.equal((await readFile(summary, "utf8")).trim(),
      `Immutable image publication complete for \`${commit}\`: ${publicationComplete}`);
  }
  const wrongSource = runWorkflowScript(report, {
    GITHUB_SHA: "b".repeat(40), GITHUB_OUTPUT: join(directory, "wrong.output"),
    GITHUB_STEP_SUMMARY: join(directory, "wrong.summary"),
  }, directory);
  assert.notEqual(wrongSource.status, 0);

  const output = join(directory, "artifact.output");
  const available = { id: 412, name: "images-manifest", expired: false };
  for (const artifacts of [[], [available], [available, { ...available, id: 413 }], [{ ...available, expired: true }]]) {
    await writeFile(output, "");
    const result = runWorkflowScript(`gh() {
      [[ "$*" == 'api repos/WasalX/wasalx-platform/actions/runs/123/artifacts?name=images-manifest' ]] || return 1
      printf '%s' "$ARTIFACTS"
    }\n${resolve.run}`, {
      SOURCE_RUN: "123", GITHUB_REPOSITORY: "WasalX/wasalx-platform", GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(directory, "artifact.summary"),
      ARTIFACTS: JSON.stringify({ total_count: artifacts.length, artifacts }),
    }, directory);
    const accepted = artifacts.length === 1 && !artifacts[0].expired;
    assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    assert.equal(await readFile(output, "utf8"), accepted ? "id=412\n" : "");
  }
});

test("optional PR lanes run on diff errors and gate their applicable checks", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const { "infra-validate": job, "ci-gate": gate, changes } = jobs;
  const [gateStep] = gate.steps;
  assert(!Object.hasOwn(jobs, "terraform-test"));
  assert.equal(job.needs, "changes");
  assert.equal(job.if, "${{ !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'merge_group') && (needs.changes.result != 'success' || needs.changes.outputs.infra != 'false') }}");
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
  assert.equal(changes.outputs.integration, "${{ steps.integration.outputs.needed }}");
  assert.equal(changes.outputs.zammad, "${{ steps.zammad.outputs.needed }}");
  const paths = [
    "infra/helm/", "infra/terraform/", ":(glob)scripts/validate-*", "scripts/release/fetch-verified-asset.sh",
    "compose.full.yaml", "tests/fixtures/production-backup-alerts.yaml", "tests/secret-adapter-readiness.test.rb",
    "docs/runbooks/alert-response.md", "infra/docker/full/prometheus/alerts.yaml", ".github/workflows/ci.yml",
  ].join(" ");
  const directory = await mkdtemp(join(tmpdir(), "wasalx-infra-validate-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "gate-summary").replaceAll("\\", "/");
  for (const [id, diffPaths] of [
    ["infra", paths],
    ["dev-install", ["scripts/dev-install/", "scripts/release/installer-stages.mjs",
      "scripts/release/installer-stack.mjs", "scripts/release/compose-stage-lock.mjs",
      "scripts/release/compose-stage-config.json", "scripts/release/image_registry_retry.py",
      ".github/workflows/ci.yml"].join(" ")],
    ["integration", [".github/workflows/ci.yml", "scripts/test-postgres-integration.mjs",
      "scripts/postgres-scenario-registry.mjs", "services/control-api/", "services/connector-worker/", "packages/", "infra/docker/postgres/",
      "infra/docker/full/postgres/", ":(glob)tests/*postgres*.mjs", "tests/meta-routing-fixture.mjs",
      "tests/group-designation-evidence.mjs", "tests/fixtures/", "tests/helpers/", "tests/support/",
      "app/auth/", "app/platform/auth/", "app/api/health/", "app/WasalXApp.tsx", "lib/request-auth.ts",
      ":(glob)lib/*portal-session*.ts", ":(glob)lib/*oidc*.ts", "infra/docker/full/keycloak/bootstrap-user.mjs",
      "scripts/run-application-e2e.mjs", "scripts/release/ci-browser-runtime.mjs", "playwright.application.config.ts",
      "tests/multitenant-e2e.test.mjs", "tests/platform-invitation-e2e.test.mjs", "tests/portal-security-headers.test.mjs",
      "tests/rendered-html.test.mjs", "tests/app-first-load-js-budget.json"].join(" ")],
    ["zammad", [
      "compose.full.yaml", ".dockerignore", "infra/docker/Dockerfile.zammad", "infra/docker/full/zammad/",
      "zammad-addon.json", "zammad-package/", "build/zammad/", "release/installer-images.json",
      ":(glob)scripts/*zammad*", ":(glob)scripts/contracts/*mailbox*", "scripts/release/operator-input.mjs",
      "app/AttachmentFilePicker.tsx", "app/Inbox.tsx", "app/TicketInbox.tsx", "app/GroupInbox.tsx", "app/api/inbox/attachment/", "lib/i18n/",
      "tests/zammad-image-browser-compat.test.mjs", "tests/fixtures/", "tests/helpers/", "tests/support/", ":(glob)tests/**/*.rb",
      "services/control-api/", "services/connector-worker/", "packages/", "lib/domain.ts", "lib/literal-matcher.ts",
      "scripts/build-services.mjs", "tsconfig.json", ":(glob)services/*/tsconfig*.json", ".gitattributes",
      "tests/outbound-media.test.mjs", "tests/simulation-portal-reply-browser.test.mjs",
      "tests/zammad-sidebar-component-harness.test.mjs",
      "scripts/release/simulation-portal-reply-browser.mjs",
      ":(glob)**/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/",
      ".github/actions/ci-pnpm/", ".github/workflows/ci.yml", ".github/workflows/zammad-compatibility.yml",
    ].join(" ")],
  ]) {
    const detector = changes.steps.find(step => step.id === id);
    assert.equal(detector.if, id === "infra" || id === "zammad" ? undefined : "github.event_name == 'pull_request'");
    const usesSharedBase = id === "infra" || id === "zammad";
    if (usesSharedBase) assert.equal(detector.env.BASE, "${{ steps.selector-base.outputs.sha }}");
    const cases = [["HEAD^1", 0, false], ["HEAD^1", 1, true], ["HEAD^1", 128, true]];
    if (usesSharedBase) cases.push(["", 0, true]);
    for (const [baseRef, status, needed] of cases) {
      const outputFile = join(directory, `${id}-${baseRef ? status : "empty"}`);
      const result = runWorkflowScript(`git() {
  test "$*" = "diff --quiet --no-ext-diff --no-renames HEAD^1 HEAD -- $DIFF_PATHS" || exit 99
  return "$DIFF_STATUS"
}
${detector.run}`, {
        GITHUB_OUTPUT: outputFile.replaceAll("\\", "/"), DIFF_PATHS: diffPaths, DIFF_STATUS: String(status), BASE: baseRef,
      });
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
    ["merge_group", "false", "skipped", 0],
    ["merge_group", "true", "skipped", 1],
    ["merge_group", "", "skipped", 1],
    ["merge_group", "", "failure", 1],
  ]) {
    const pr = event === "pull_request";
    const result = runWorkflowScript(gateStep.run, {
      EVENT: event, CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: pr ? "success" : "skipped",
      IMAGES_NEEDED: pr ? "false" : "true", IMAGES: pr ? "skipped" : "success", INTEGRATION_NEEDED: "false",
      INTEGRATION: pr ? "skipped" : "success", PORTAL_INTEGRATION: pr ? "skipped" : "success",
      INTEGRATION_COVERAGE: pr ? "skipped" : "success",
      DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
      INSTALLER_PORTAL_NEEDED: pr ? "false" : "true", INSTALLER_PORTAL: pr ? "skipped" : "success",
      INFRA_NEEDED: needed, INFRA: jobResult, GITHUB_STEP_SUMMARY: summary,
      ZAMMAD_COMPATIBILITY: "success",
    });
    assert.equal(result.status, status, `${event}/${needed}/${jobResult}: ${result.error?.message ?? result.stderr}`);
  }
  for (const [needed, jobResult, status] of [
    ["true", "success", 0], ["false", "skipped", 0], ["true", "skipped", 1], ["", "skipped", 1],
    ["true", "failure", 1], ["true", "cancelled", 1],
  ]) {
    const result = runWorkflowScript(gateStep.run, {
      EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success",
      IMAGES_NEEDED: "false", IMAGES: "skipped", INTEGRATION_NEEDED: "false",
      INTEGRATION: "skipped", PORTAL_INTEGRATION: "skipped", INTEGRATION_COVERAGE: "skipped",
      DEV_INSTALL_NEEDED: needed, DEV_INSTALL: jobResult, INFRA_NEEDED: "false", INFRA: "skipped",
      ZAMMAD_COMPATIBILITY: "success",
      INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, status, `dev-install/${needed}/${jobResult}: ${result.error?.message ?? result.stderr}`);
  }
  for (const [event, needed, postgres, portal, coverage, status] of [
    ["pull_request", "true", "success", "success", "success", 0],
    ["pull_request", "true", "skipped", "skipped", "skipped", 1],
    ["pull_request", "", "skipped", "skipped", "skipped", 1],
    ["merge_group", "", "success", "success", "success", 0],
    ["merge_group", "", "failure", "success", "success", 1],
    ["merge_group", "", "success", "skipped", "success", 1],
    ["merge_group", "", "success", "success", "skipped", 1],
  ]) {
    const pr = event === "pull_request";
    const result = runWorkflowScript(gateStep.run, {
      EVENT: event, CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", PLATFORM_OPERATOR_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: pr ? "success" : "skipped",
      IMAGES_NEEDED: pr ? "false" : "true", IMAGES: pr ? "skipped" : "success", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
      INSTALLER_PORTAL_NEEDED: pr ? "false" : "true", INSTALLER_PORTAL: pr ? "skipped" : "success",
      INFRA_NEEDED: "true", INFRA: "success", INTEGRATION_NEEDED: needed, GITHUB_STEP_SUMMARY: summary,
      INTEGRATION: postgres, PORTAL_INTEGRATION: portal, INTEGRATION_COVERAGE: coverage,
      ZAMMAD_COMPATIBILITY: "success",
    });
    assert.equal(result.status, status, [event, needed, postgres, portal, coverage].join("/"));
  }
});

test("Zammad compatibility selects changes to outbound dependencies and service build inputs", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const { run, env } = jobs.changes.steps.find(step => step.id === "zammad");
  const selector = jobs.changes.steps.find(step => step.id === "selector-base");
  assert.equal(env.BASE, "${{ steps.selector-base.outputs.sha }}");
  assert.equal(selector.env.BASE, "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.merge_group.base_sha }}");
  const directory = await mkdtemp(join(tmpdir(), "zammad-compatibility-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: directory, encoding: "utf8", windowsHide: true,
  });
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "Base");
  const base = git("rev-parse", "HEAD").trim();
  const output = join(directory, "selection");
  const runSelector = async (script, baseRef) => {
    await writeFile(output, "");
    const result = runWorkflowScript(script, { BASE: baseRef, GITHUB_OUTPUT: output.replaceAll("\\", "/") }, directory);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return (await readFile(output, "utf8")).trim();
  };
  const selected = async baseRef => {
    const resolved = await runSelector(selector.run, baseRef);
    return runSelector(run, resolved.replace(/^sha=/u, ""));
  };
  for (const [path, expected] of [
    ["services/control-api/src/ticket-reply-target.ts", true],
    ["services/connector-worker/src/media-runtime.ts", true],
    ["packages/core/src/outbound-text.ts", true],
    ["lib/domain.ts", true],
    ["lib/literal-matcher.ts", true],
    ["scripts/build-services.mjs", true],
    ["tsconfig.json", true],
    ["services/invitation-mailer/tsconfig.json", true],
    ["app/AttachmentFilePicker.tsx", true],
    ["app/TicketInbox.tsx", true],
    ["app/api/inbox/attachment/route.ts", true],
    ["lib/i18n/messages/ar/cases.ts", true],
    ["tests/simulation-portal-reply-browser.test.mjs", true],
    ["tests/zammad-sidebar-component-harness.test.mjs", true],
    ["tests/support/ci-fixture-network.mjs", true],
    ["docs/release.md", false],
  ]) {
    await mkdir(join(directory, posix.dirname(path)), { recursive: true });
    await writeFile(join(directory, path), "fixture\n");
    git("add", "--", path);
    git("commit", "--quiet", "-m", "Change one input");
    assert.equal(await selected("HEAD^1"), 'needed=' + expected, path);
  }
  assert.equal(await selected(base), "needed=true", "the group includes affected changes before its final commit");
  assert.equal(await selected(git("rev-parse", "HEAD^1").trim()), "needed=false", "a docs-only group skips compatibility");
  assert.equal(await selected(""), "needed=true", "a missing base cannot skip compatibility");
  assert.equal(await selected("0".repeat(40)), "needed=true", "an unresolvable base cannot skip compatibility");
  const nonAncestor = git("commit-tree", git("rev-parse", "HEAD^{tree}").trim(), "-p", base, "-m", "Other branch").trim();
  git("diff", "--quiet", nonAncestor, "HEAD");
  assert.equal(await selected(nonAncestor), "needed=true", "a clean diff against a non-ancestor cannot skip compatibility");
});

test("Zammad compatibility gates CI and reuses the same job on the nightly schedule", async () => {
  const workflow = ".github/workflows/zammad-compatibility.yml";
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const nightly = parse(await read(".github/workflows/nightly-install.yml"));
  const compatibility = parse(await read(workflow));
  const job = jobs["zammad-compatibility"];
  assert.equal(job.needs, "changes");
  assert.equal(job.if, "${{ !cancelled() && github.event_name != 'push' && (github.event_name == 'workflow_dispatch' || needs.changes.result != 'success' || needs.changes.outputs.zammad != 'false') }}");
  assert.equal(job.uses, `./${workflow}`);
  assert(jobs["ci-gate"].needs.includes("zammad-compatibility"));
  assert.equal(jobs["ci-gate"].steps[0].env.ZAMMAD_COMPATIBILITY, "${{ needs.zammad-compatibility.result }}");
  assert.equal(jobs["ci-gate"].steps[0].env.ZAMMAD_NEEDED, "${{ needs.changes.outputs.zammad }}");
  assert(nightly.on.schedule.length > 0);
  assert.equal(nightly.jobs["zammad-compatibility"].uses, job.uses);
  assert.match(nightly.jobs["zammad-compatibility"].if, /github\.event_name == 'schedule'/u);
  assert(Object.hasOwn(compatibility.on, "workflow_call"));
  assert.deepEqual(compatibility.permissions, { contents: "read" });
  assert.equal(compatibility.jobs.compatibility["runs-on"], "ubuntu-24.04");
  const steps = compatibility.jobs.compatibility.steps;
  const fetch = steps.findIndex(step => /^pnpm run zammad:fetch$/mu.test(step.run ?? ""));
  const install = steps.findIndex(step => step["working-directory"] === ".zammad-addon/tests/zammad-sidebar-component"
    && step.run === "pnpm install --frozen-lockfile");
  const harness = steps.findIndex(step => runsFile(step.run ?? "", "tests/zammad-sidebar-component-harness.test.mjs"));
  assert(fetch >= 0 && fetch < install && install < harness);
  const manifest = JSON.parse(await read("infra/docker/full/zammad/typecheck-upstream.json"));
  const dockerfile = (await read("infra/docker/Dockerfile.zammad")).replaceAll("\r\n", "\n");
  assert.match(manifest.revision, /^[a-f0-9]{40}$/u);
  assert(dockerfile.includes("FROM scratch AS typecheck-source\nADD https://github.com/zammad/zammad.git#"
    + manifest.revision + ":app/frontend /app/frontend/"));
  const typecheck = dockerfile.split(/^RUN /mu).find(run => run.includes("pnpm lint:ts"));
  assert(dockerfile.includes("COPY --chown=1000:1000 --from=typecheck-source / /tmp/typecheck-upstream/"));
  assert.match(typecheck, /prepare-zammad-typecheck\.mjs restore \/opt\/zammad \/tmp\/typecheck-upstream\.json \/tmp\/typecheck-upstream [\s\S]+rm -rf \/tmp\/typecheck-upstream[\s\S]+pnpm lint:ts[\s\S]+prepare-zammad-typecheck\.mjs remove/u);
});

test("PostgreSQL coverage requires an exact report from every shard", async t => {
  assert.deepEqual(parsePostgresShardArgs(["--shard", "3/4", "--report", "report.json"]), { shard: 3, report: "report.json" });
  for (const selection of ["0/4", "5/4", "1/3", "1/4x"]) assert.throws(() => parsePostgresShardArgs(["--shard", selection]));
  const directory = await mkdtemp(join(tmpdir(), "postgres-scenario-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = (index, scenarios) => writeFile(join(directory, "postgres-shard-" + index + ".json"),
    JSON.stringify({ shard: index, scenarios }));
  for (const [index, names] of postgresScenarioGroups.entries()) await report(index + 1, names);
  assert.equal(await verifyPostgresReports(directory), postgresScenarioGroups.flat().length);
  const [first, second] = postgresScenarioGroups;
  await report(1, first.slice(1));
  await assert.rejects(verifyPostgresReports(directory), /coverage in PostgreSQL shard 1/u);
  await report(1, [...first, first[0]]);
  await assert.rejects(verifyPostgresReports(directory), /coverage in PostgreSQL shard 1/u);
  await report(1, [...first.slice(1), second[0]]);
  await assert.rejects(verifyPostgresReports(directory), /coverage in PostgreSQL shard 1/u);
  await rm(join(directory, "postgres-shard-1.json"));
  await assert.rejects(verifyPostgresReports(directory), /one report from each PostgreSQL shard/u);
});

test("PR unit selection catches a hidden transitive regression and falls back on shared inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-unit-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    ...args], { cwd: directory, encoding: "utf8", windowsHide: true }).trim();
  const [affected, dynamic, unrelated] = ["tests/affected.test.mjs", "tests/dynamic.test.mjs", "tests/unrelated.test.mjs"];
  const all = [affected, dynamic, unrelated];
  const files = {
    "lib/leaf.mjs": "export const answer = 42;\n",
    "lib/public.mjs": "export { answer } from './leaf.mjs';\n",
    "lib/unreached.mjs": "export const unused = 42;\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": "{}\n",
    ".github/workflows/ci.yml": "name: fixture\n",
    "tests/fixtures/shared.mjs": "export const fixture = true;\n",
    [affected]: "import assert from 'node:assert/strict'; import test from 'node:test'; "
      + "import { answer } from '../lib/public.mjs'; test('hidden transitive regression', () => assert.equal(answer, 42));\n",
    [dynamic]: "const path = '../lib/leaf.mjs'; await import(path);\n",
    [unrelated]: "import test from 'node:test'; test('unrelated test', () => {});\n",
  };
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(directory, posix.dirname(file)), { recursive: true });
    await writeFile(join(directory, file), contents);
  }
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const select = event => selectUnitFiles(all, { event, cwd: directory });
  assert.match(select("pull_request").reason, /merge base unavailable/u);

  function mergeFixture() {
    git("add", ".");
    const tree = git("write-tree");
    const head = git("commit-tree", tree, "-p", base, "-m", "feature");
    git("update-ref", "HEAD", git("commit-tree", tree, "-p", base, "-p", head, "-m", "PR test merge"));
  }

  await writeFile(join(directory, "lib/leaf.mjs"), "export const answer = 41;\n");
  mergeFixture();
  assert.deepEqual(select("pull_request").files, [affected, dynamic]);
  assert.deepEqual([1, 2].flatMap(shard => shardFiles(select("pull_request").files, shard, 2)).sort(), [affected, dynamic]);
  for (const event of ["push", "merge_group", "workflow_dispatch", "release"]) {
    assert.deepEqual(select(event).files, all);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const red = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...select("pull_request").files],
    { cwd: directory, env, encoding: "utf8", windowsHide: true });
  assert.equal(red.status, 1, red.error?.message ?? red.stderr);
  assert.match(red.stdout, /not ok \d+ - hidden transitive regression/u);
  assert.doesNotMatch(red.stdout, /unrelated test/u);

  await writeFile(join(directory, "lib/leaf.mjs"), files["lib/leaf.mjs"]);
  for (const file of ["pnpm-lock.yaml", "tsconfig.json", ".github/workflows/ci.yml", "tests/fixtures/shared.mjs", "lib/unreached.mjs"]) {
    await writeFile(join(directory, file), files[file] + "\n");
    mergeFixture();
    assert.deepEqual(select("pull_request").files, all, file);
    await writeFile(join(directory, file), files[file]);
  }

  await writeFile(join(directory, "lib/added.mjs"), "export const added = true;\n");
  mergeFixture();
  assert.equal(git("diff", "--name-status", base, "HEAD"), "A\tlib/added.mjs");
  const addition = select("pull_request");
  assert.deepEqual(addition.files, all);
  assert.match(addition.reason, /structural changes/u);

  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const fullUnit = jobs["full-unit"];
  assert.equal(fullUnit.name, "Full ${{ matrix.name }}");
  assert.equal(fullUnit.if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(fullUnit.strategy.matrix.include, jobs.checks.strategy.matrix.include.filter(row => row.mode === "unit"));
  assert.deepEqual(fullUnit.steps, jobs.checks.steps);
  assert.match(jobs.checks.steps[0].with["fetch-depth"], /github\.event_name == 'pull_request' && matrix\.mode == 'unit' && '2'/u);
  assert(jobs["ci-gate"].needs.includes("full-unit"));
});

test("source style checks added and renamed source files", async t => {
  const { env, jobs } = parse(await read(".github/workflows/ci.yml"));
  const step = jobs.checks.steps.find(step => step.name === "Check added source style");
  assert.equal(step.if, "matrix.mode == 'lint'");
  assert.equal(step.env.STYLE_BASE, "${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.merge_group.base_sha }}");
  assert.equal(jobs.checks.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");

  const directory = await mkdtemp(join(tmpdir(), "source-style-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
  const write = async (path, content) => {
    await mkdir(join(directory, posix.dirname(path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  const commit = () => {
    git("add", "--all");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Fixture");
  };
  git("init", "--quiet");
  git("config", "diff.renames", "true");
  await write(".pre-commit-config.yaml", await read(".pre-commit-config.yaml"));
  await write("scripts/filter-source-files.rb", await read("scripts/filter-source-files.rb"));
  await write("existing.ts", "export const version = 1;\n");
  await write("original.txt", "#!/bin/sh\nprintf 'renamed file with identical contents\\n'\n");
  commit();

  const selected = [
    "button component.tsx", "style.css", "worker.py", "test.rb", "view.sql", "deploy.sh",
    "deploy.ash", "deploy.dash", "deploy.ksh", "deploy.mksh", "deploy.cbsd", "deploy.TCSH", "Gemfile",
    "scripts/hosted-ci-baseline.mjs",
  ];
  for (const path of [...selected, "README.md", "next-env.d.ts", "cloudflare-env.d.ts",
    "services/control-api/migrations/000_fixture.SQL"]) {
    await write(path, "fixture\n");
  }
  if (process.platform !== "win32") {
    await write("entrypoint", "#!/bin/dash\nexit 0\n");
    await chmod(join(directory, "entrypoint"), 0o755);
    await symlink("view.sql", join(directory, "linked.sql"));
    selected.push("entrypoint");
  }
  await write("existing.ts", "export const version = 2;\n");
  await rename(join(directory, "original.txt"), join(directory, "renamed.sh"));
  commit();
  assert.match(git("diff", "--name-status", "HEAD^1", "HEAD"), /^R100\toriginal\.txt\trenamed\.sh$/mu);

  await write(".git/bin/pipx", "#!/usr/bin/env bash\n"
    + 'while [[ "$1" != --files && $# -gt 0 ]]; do shift; done\n'
    + 'shift || exit 1\nprintf "%s\\0" "$@"\n');
  await chmod(join(directory, ".git/bin/pipx"), 0o755);
  const run = 'export PATH="$PWD/.git/bin:$PATH"\n' + step.run;
  const execute = STYLE_BASE => runWorkflowScript(run, { PRE_COMMIT_VERSION: env.PRE_COMMIT_VERSION, STYLE_BASE }, directory);
  const result = execute("HEAD^1");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").filter(Boolean).sort(), [...selected, "renamed.sh"].sort());
  const empty = execute("HEAD");
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  assert.equal(execute("invalid-base").status, 128);
});

test("source hook environments use the same runtime-specific key and save only on main", async t => {
  const { env, jobs } = parse(await read(".github/workflows/ci.yml"));
  const seed = jobs["seed-caches"].steps;
  const checks = jobs.checks.steps;
  const runtime = steps => steps.find(step => step.id === "source-hook-runtime");
  const restore = steps => steps.find(step => step.id === "source-hooks-cache");
  const lintRestore = restore(checks);
  const seedRestore = restore(seed);
  assert.match(env.PRE_COMMIT_VERSION, /^\d+\.\d+\.\d+$/u);
  assert.equal(runtime(checks).run, runtime(seed).run);
  assert.equal(runtime(checks).if, "matrix.mode == 'lint'");
  assert.equal(lintRestore.if, "matrix.mode == 'lint'");
  assert.match(lintRestore.uses, /^actions\/cache\/restore@/u);
  assert.equal(lintRestore.uses, seedRestore.uses);
  assert.deepEqual(lintRestore.with, seedRestore.with);
  assert.equal(lintRestore.with.key, "pre-commit-${{ runner.os }}-${{ runner.arch }}-${{ steps.source-hook-runtime.outputs.versions }}-${{ env.PRE_COMMIT_VERSION }}-${{ hashFiles('.pre-commit-config.yaml', '.rubocop.yml') }}");
  assert.equal(lintRestore.with["restore-keys"], undefined);
  assert(!checks.some(step => step.uses?.startsWith("actions/cache/save@") && step.with?.path === lintRestore.with.path));

  const install = seed.find(step => step.name === "Install source hook environments");
  const save = seed.find(step => step.with?.path === lintRestore.with.path && step.uses?.startsWith("actions/cache/save@"));
  assert.equal(install.if, "steps.source-hooks-cache.outputs.cache-hit != 'true'");
  assert.match(install.run, /pipx run --python python3 .* pre-commit install-hooks/u);
  assert.equal(save.if, install.if);
  assert(seed.indexOf(seedRestore) < seed.indexOf(install) && seed.indexOf(install) < seed.indexOf(save));
  assert.equal(save.with.key, "${{ steps.source-hooks-cache.outputs.cache-primary-key }}");

  const directory = await mkdtemp(join(tmpdir(), "source-hook-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output").replaceAll("\\", "/");
  const mocks = "node() { echo v24.13.1; }\npython3() { echo 3.12.3; }\nruby() { echo 3.2.3; }\n";
  const result = runWorkflowScript(mocks + runtime(checks).run, { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(output, "utf8")).trim(), "versions=node-v24.13.1-python-3.12.3-ruby-3.2.3");
});

test("source gate settings are critical and pending RuboCop cops are enabled", async () => {
  const path = ".github/critical-paths.json";
  const policy = JSON.parse(await read(path));
  const critical = policy.classes["repo-settings-branch-protection-and-release-gates"];
  for (const name of [".pre-commit-config.yaml", ".rubocop.yml", "eslint.config.*", ".gitignore",
    "package.json", "prettier.config.*", "stylelint.config.*", ".prettierignore", ".stylelintignore"]) {
    assert(critical.includes(name), name);
  }
  for (const file of ["AGENTS.md", "DELIVERY.md"]) assert((await read(file)).includes("(" + path + ")"), file);
  assert.equal(parse(await read(".rubocop.yml")).AllCops.NewCops, "enable");
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

test("unit runners fail before launching tests when a staged add-on input is missing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-addon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingFixture = "tests/portal-upload-expiry-test.rb";
  const archive = "build/zammad/wasalx-1.2.3.zpm";
  const stage = async file => {
    await mkdir(join(directory, posix.dirname(file)), { recursive: true });
    await writeFile(join(directory, file), "fixture");
  };
  await writeFile(join(directory, "zammad-addon.json"), JSON.stringify({ packageVersion: "1.2.3" }));
  await Promise.all(unitAddonSources.filter(file => file !== missingFixture).map(stage));
  const options = { cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true };
  for (const missing of [missingFixture, archive]) {
    for (const [file, ...args] of [["hosted-ci.mjs", "unit", "1", "2"], ["test-unit.mjs"]]) {
      const result = spawnSync(process.execPath, [join(repository, "scripts", file), ...args], options);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Missing required Zammad add-on inputs/u);
      assert(result.stderr.includes(missing), result.stderr);
      assert.equal(result.stdout, "");
    }
    await stage(missing);
  }
  assert.doesNotThrow(() => validateUnitAddonInputs(directory));
});

test("full unit shards cover the unit inventory, including the add-on fixture consumers", () => {
  const covered = [1, 2].flatMap(shard => shardFiles(unitFiles, shard, 2));
  assert.deepEqual(covered.sort(), [...new Set(unitFiles)].sort());
  for (const file of ["workspace-binary", "simulation-native-group", "application-e2e-harness",
    "zammad-agent-context", "portal-workspace", "workspace-configurator"]) {
    assert(covered.includes(`tests/${file}.test.mjs`), file);
  }
});
