import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const identityRunner = await read("tests/hosted-keycloak-identity.mjs");
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
  const runnerText = runner => Object.hasOwn(jobs, runner) ? runText(jobs[runner])
    : Object.hasOwn(scripts, runner) ? scripts[runner] : "";
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
  const fixtureSpecs = new Map(jobs["application-e2e"].strategy.matrix.locale.map(locale => {
    const cases = discoverBrowserCases({ argv: ["pnpm", "test:e2e"], env: {
      WASALX_E2E_LOCALES: locale, WASALX_E2E_ROLES: "tenant_owner", WASALX_E2E_PLATFORM_URL: "",
    } });
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

test("Storybook selects UI changes and unknown diffs", async (t) => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const selection = jobs.changes.steps.find(step => step.id === "storybook");
  assert.equal(selection.if, "github.event_name == 'pull_request'");
  assert.equal(jobs.storybook.needs, "changes");
  assert.match(jobs.storybook.if, /github\.event_name == 'push'/u);
  assert.match(jobs.storybook.if, /github\.event_name == 'pull_request' && needs\.changes\.outputs\.storybook != 'false'/u);
  assert.match(jobs.storybook.if, /github\.event_name == 'merge_group'/u);
  assert.match(jobs.storybook.if, /github\.event_name == 'workflow_dispatch'/u);
  assert(jobs["ci-gate"].needs.includes("storybook"));
  const [gateStep] = jobs["ci-gate"].steps;
  assert.equal(gateStep.env.STORYBOOK_NEEDED, "${{ needs.changes.outputs.storybook }}");
  assert.equal(gateStep.env.STORYBOOK, "${{ needs.storybook.result }}");

  const directory = await mkdtemp(join(tmpdir(), "storybook-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");

  for (const [status, expected] of [[0, "false"], [1, "true"], [128, "true"]]) {
    await writeFile(output, "");
    const result = runWorkflowScript(
      `git() { case " $* " in *" app/ "*) return "$DIFF_STATUS";; *) return 0;; esac; }\n${selection.run}`,
      { DIFF_STATUS: String(status), GITHUB_OUTPUT: output },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `needed=${expected}`);
  }
});

test("nightly install is report-only, read-only and fails open on PR diff errors", async () => {
  const path = ".github/workflows/nightly-install.yml";
  const { on, permissions, concurrency, jobs } = parse(await read(path));
  const job = jobs["nightly-install"];
  assert.equal(job["continue-on-error"], undefined);
  assert.deepEqual(on, {
    schedule: [{ cron: "17 2 * * *" }],
    workflow_dispatch: null,
    pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    push: { tags: ["v*-rc.*"] },
  });
  assert.match(job.if, /\(github\.event_name == 'push' && github\.ref_type == 'tag'\)/u);
  assert.deepEqual(concurrency, {
    group: "nightly-${{ github.event.pull_request.number || github.run_id }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
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
  const changeSelection = job.steps.find(step => step.id === "changes");
  assert.equal(changeSelection.if, "github.event_name == 'pull_request'");
  const changes = changeSelection.run;
  assert.match(changes, /needed=true\nif git diff --quiet[^]*; then\n {2}needed=false\nfi/u);
  for (const input of ["scripts/release/installer-*", "scripts/dev-install/**", "compose*.yaml", path, "release/installer-images.json",
    "scripts/release/compose-stage-lock.mjs", "scripts/release/compose-stage-config.json", "scripts/release/simulation-rails-json.mjs",
    "scripts/installer-evidence.mjs", "infra/docker/full/**"]) assert(changes.includes(input));
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

test("PR installer skips only when the publication migration tree differs", async t => {
  const { jobs } = parse(await read(".github/workflows/nightly-install.yml"));
  const steps = jobs["nightly-install"].steps;
  const changes = steps.find(step => step.id === "changes");
  const check = steps.find(step => step.id === "migration-check");
  const rehearsal = steps.find(step => step.name === "Rehearse full installation and controlled recreation");
  assert.equal(check.if, "github.event_name == 'pull_request' && steps.changes.outputs.needed != 'false'");
  assert.equal(check.env.PUBLICATION_COMMIT, "${{ steps.publication.outputs.commit }}");
  assert.equal(rehearsal.if, "steps.changes.outputs.needed != 'false' && steps.migration-check.outputs.skip != 'true'");
  assert.equal(rehearsal["continue-on-error"], undefined);

  const directory = await mkdtemp(join(tmpdir(), "nightly-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const migrations = "services/control-api/migrations";
  const updated = `${migrations}/0001_updated.sql`;
  const removed = `${migrations}/0002_removed.sql`;
  const added = `${migrations}/0003_added.sql`;
  await mkdir(join(directory, migrations), { recursive: true });
  await writeFile(join(directory, updated), "SELECT 1;\n");
  await writeFile(join(directory, removed), "SELECT 2;\n");
  git("add", "--", migrations);
  git("commit", "--quiet", "-m", "Published migrations");
  const publication = git("rev-parse", "HEAD");
  await writeFile(join(directory, updated), "SELECT 3;\n");
  await writeFile(join(directory, added), "SELECT 4;\n");
  git("rm", "--quiet", "--", removed);
  git("add", "--", migrations);
  git("commit", "--quiet", "-m", "Change migrations");
  assert.equal(runWorkflowScript(changes.run, { GITHUB_OUTPUT: "selection" }, directory).status, 0);
  assert.equal((await readFile(join(directory, "selection"), "utf8")).trim(), "needed=true");

  const matching = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "Unrelated candidate commit");
  for (const [commit, status, skip] of [[publication, 0, true], [matching, 0, false], ["missing-commit", 128, false]]) {
    const summaryFile = join(directory, "summary");
    const outputFile = join(directory, "output");
    await writeFile(summaryFile, "");
    await writeFile(outputFile, "");
    const result = runWorkflowScript(check.run, {
      PUBLICATION_COMMIT: commit, GITHUB_OUTPUT: "output", GITHUB_STEP_SUMMARY: "summary",
    }, directory);
    assert.equal(result.status, status, result.error?.message ?? result.stderr);
    assert.equal((await readFile(outputFile, "utf8")).trim(), skip ? "skip=true" : "");
    const summary = await readFile(summaryFile, "utf8");
    assert.equal(result.stdout, summary);
    assert.equal(summary, skip
      ? `Installer rehearsal skipped: PR changes migrations; main publication cannot represent them\n\n\`\`\`\n${[updated, removed, added].join("\n")}\n\`\`\`\n`
      : "");
  }
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

test("nightly requires the exact main publication for qualification and labels PR image fixtures", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nightly-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { cwd: directory, encoding: "utf8", windowsHide: true };
  const git = (...args) => execFileSync("git", args, options).trim();
  git("init", "--quiet", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  for (let i = 0; i < 6; i += 1) {
    git("commit", "--quiet", "--allow-empty", "-m", "fixture " + i);
  }
  const tree = git("rev-parse", "HEAD^{tree}");
  const parent = git("rev-parse", "HEAD^1");
  const side = git("commit-tree", tree, "-p", parent, "-m", "side branch");
  const base = git("commit-tree", tree, "-p", parent, "-p", side, "-m", "base merge");
  const prHead = git("commit-tree", tree, "-p", parent, "-m", "PR head");
  const prMerge = git("commit-tree", tree, "-p", base, "-p", prHead, "-m", "PR merge");
  const commits = git("rev-list", "--first-parent", base).split(/\r?\n/u);
  const tag = "v0.0.0-rc.1";
  git("tag", "-a", tag, base, "-m", "fixture tag");
  git("remote", "add", "origin", ".");
  const { jobs } = parse(await read(".github/workflows/nightly-install.yml"));
  const publication = jobs["nightly-install"].steps.find(step => step.id === "publication");
  await mkdir(join(directory, "scripts", "release"), { recursive: true });
  await writeFile(join(directory, "scripts", "release", "product-images.json"), '[{"image":"zammad"}]');
  await writeFile(join(directory, "scripts", "release", "image-manifest.sh"), await read("scripts/release/image-manifest.sh"));
  const ghFixture = String.raw`
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
  const fixture = commit => `PR signed-image fixture uses main publication ${commit} (run 101, PR base ${base}).`;
  const fallback = `${fixture(commits[4])} The PR base has no complete green publication.`;
  const blocked = reason => `BLOCKED: Exact main publication for ${base} is unavailable (${reason}).`;
  const cases = [
    { ready: base, selected: base, lookups: [base], summary: fixture(base) },
    { ready: commits[4], incomplete: commits[1], expired: commits[2], noJob: commits[3],
      selected: commits[4], lookups: commits.slice(0, 5), summary: fallback, warning: fallback },
    { ready: commits[5], lookups: commits.slice(0, 5), reason: "No complete green main publication" },
    { ready: side, lookups: commits.slice(0, 5), reason: "No complete green main publication" },
    { ready: commits[1], lookupError: base, lookups: commits.slice(0, 1), status: 17 },
    { ready: commits[1], invalid: true, lookups: commits.slice(0, 2), status: 5, reason: "Invalid nightly publication manifest" },
    ...["schedule", "workflow_dispatch"].flatMap(event => [
      { event, ready: base, selected: base, lookups: [base], summary: `Exact main publication ${base} is complete (run 101).` },
      { event, ready: commits[1], lookups: [base], summary: blocked("no green main CI push run") },
      { event, ready: commits[1], incomplete: base, lookups: [base], summary: blocked("images-manifest is incomplete") },
    ]),
    { event: "schedule", ready: commits[1], expired: base, lookups: [base], summary: blocked("no available images-manifest artifact") },
    { event: "schedule", ready: commits[1], noJob: base, lookups: [base], summary: blocked("no successful Image digest manifest job") },
    { event: "workflow_dispatch", ready: base, invalid: true, lookups: [base], status: 5, reason: "Invalid nightly publication manifest" },
    { event: "push", ready: base, selected: base, lookups: [base] },
    { event: "push", ready: commits[1], lookups: [base], reason: "No green main CI push run for the commit" },
  ];
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const { ready, selected, incomplete = "", expired = "", noJob = "", lookupError = "", invalid = false,
    event = "pull_request", lookups, status = selected ? 0 : 1, reason, summary = "", warning } of cases) {
    const head = event === "pull_request" ? prMerge : base;
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
        GITHUB_REF: tagPush ? `refs/tags/${tag}` : event === "pull_request" ? "refs/pull/1/merge" : "refs/heads/main",
        GITHUB_SHA: head, GITHUB_OUTPUT: "publication-output", GITHUB_STEP_SUMMARY: "publication-summary", RUNNER_TEMP: ".",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${event}\n${result.stdout}${result.stderr}`);
    assert.equal((await readFile(join(directory, "publication-output"), "utf8")).trim(), selected ? `commit=${selected}` : "");
    if (reason) assert.ok((result.stdout + result.stderr).includes(reason), result.stderr);
    const annotations = result.stderr.split(/\r?\n/u).filter(line => line.startsWith("::warning::"));
    assert.deepEqual(annotations, warning ? [`::warning::${warning}`] : []);
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

test("workflow lint fails on any actionlint finding or download verification failure", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const job = jobs["workflow-lint"];
  const step = job.steps.find(step => step.run);
  assert.equal(job.if, undefined);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);

  const directory = await mkdtemp(join(tmpdir(), "ci-workflow-lint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [download, lint, expected] of [[0, 0, 0], [0, 1, 1], [2, 0, 2]]) {
    const result = runWorkflowScript(`
mktemp() { pwd; }
bash() {
  [[ "$1" == scripts/release/fetch-verified-asset.sh && "$2" == https://* && "$4" =~ ^[a-f0-9]{64}$ ]] || exit 99
  return "$DOWNLOAD_STATUS"
}
tar() {
  printf '#!/usr/bin/env bash\\nexit %s\\n' "$LINT_STATUS" > "$4/actionlint"
  chmod +x "$4/actionlint"
}
${step.run}`, { ...step.env, DOWNLOAD_STATUS: String(download), LINT_STATUS: String(lint) }, directory);
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
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
  assert.equal(integration.if, "${{ !cancelled() && (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.integration != 'false'))) }}");
  assert.deepEqual(portal.needs, ["changes", "portal-browser-build"]);
  assert.match(portal.if, /needs\.portal-browser-build\.result == 'success'/u);
  assert.match(portal.if, /needs\.changes\.outputs\.integration != 'false'/u);
  assert.equal(coverage.needs, "integration");
  assert.deepEqual(integration.strategy, { "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
  assert.match(integration.services.postgres.options, /--tmpfs /u);
  assert(coverage.steps.some(step => runsFile(step.run ?? "", "scripts/postgres-scenario-registry.mjs")));
  assert(integration.steps.some(step => runsFile(step.run ?? "", "scripts/test-postgres-integration.mjs", "--shard")));
  assert.equal(integration["timeout-minutes"], 25);
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

test("Application browser CI shards roles and locales and reuses the portal build", async (t) => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const application = jobs["application-e2e"];
  const portal = jobs["portal-integration"];
  const build = jobs["portal-browser-build"];
  const selection = jobs.changes.steps.find(step => step.id === "application-e2e");
  assert(jobs["ci-gate"].needs.includes("application-e2e"));
  assert.equal(selection.if, "github.event_name == 'pull_request'");
  assert.equal(jobs.changes.outputs["application-e2e"], "${{ steps.application-e2e.outputs.needed }}");
  assert.match(application.if, /needs\.changes\.outputs\.application-e2e != 'false'/u);
  assert.deepEqual(application.needs, ["changes", "portal-browser-build"]);
  assert.deepEqual(application.strategy.matrix.locale, ["en", "ar"]);
  assert.deepEqual(application.strategy.matrix.roles.flatMap(roles => roles.split(",")),
    ["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor"]);
  assert(build.steps.some(step => step.run === "pnpm run build"));
  const run = application.steps.find(step => runsFile(step.run ?? "", "scripts/run-application-e2e.mjs"));
  assert.deepEqual(run.env, {
    WASALX_E2E_SKIP_BUILD: "1",
    WASALX_E2E_LOCALES: "${{ matrix.locale }}",
    WASALX_E2E_ROLES: "${{ matrix.roles }}",
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

test("Hosted browser jobs retain Playwright diagnostics on failure or cancellation", async () => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const diagnostics = {
    "application-e2e": {
      name: "application-e2e-${{ matrix.locale }}-${{ matrix.roles }}",
      paths: ["output/playwright/application*/*/report/**", "output/playwright/application*/*/results/**"],
    },
    storybook: {
      name: "storybook-audit",
      paths: ["test-results/storybook", "output/playwright/design-system", "output/playwright/inbox/synthetic"],
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

test("CI gate requires each event's jobs and rejects unplanned skips, failures, and cancellations", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const [{ run }] = jobs["ci-gate"].steps;
  const directory = await mkdtemp(join(tmpdir(), "ci-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const pr = {
    EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success", IMAGES: "skipped",
    INTEGRATION_NEEDED: "true", INTEGRATION: "success", PORTAL_INTEGRATION: "success",
    INTEGRATION_COVERAGE: "success", INFRA_NEEDED: "true", INFRA: "success",
    DEV_INSTALL_NEEDED: "true", DEV_INSTALL: "success", STORYBOOK_NEEDED: "true", STORYBOOK: "success",
    ZAMMAD_NEEDED: "true", ZAMMAD_COMPATIBILITY: "success",
    INSTALLER_PORTAL_NEEDED: "true", INSTALLER_PORTAL: "success",
    APPLICATION_NEEDED: "true", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success",
  };
  const unselected = {
    ...pr, INTEGRATION_NEEDED: "false", INTEGRATION: "skipped", PORTAL_INTEGRATION: "skipped",
    INTEGRATION_COVERAGE: "skipped", INFRA_NEEDED: "false", INFRA: "skipped",
    DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped", STORYBOOK_NEEDED: "false", STORYBOOK: "skipped",
    ZAMMAD_NEEDED: "false", ZAMMAD_COMPATIBILITY: "skipped",
    INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
    APPLICATION_NEEDED: "false", APPLICATION_E2E: "skipped", KEYCLOAK_IDENTITY_NEEDED: "false", KEYCLOAK_IDENTITY: "skipped",
  };
  const queue = {
    ...pr, EVENT: "merge_group", REVIEW: "skipped", IMAGES: "success",
    INTEGRATION_NEEDED: "", INFRA_NEEDED: "", DEV_INSTALL_NEEDED: "", DEV_INSTALL: "skipped", STORYBOOK_NEEDED: "", APPLICATION_NEEDED: "",
    ZAMMAD_NEEDED: "",
  };
  const push = { ...queue, EVENT: "push", CHANGES: "skipped", CHECKS: "skipped", FULL_UNIT: "success", IMAGES: "skipped",
    INSTALLER_PORTAL_NEEDED: "", INSTALLER_PORTAL: "skipped" };
  const dispatch = { ...push, EVENT: "workflow_dispatch", INFRA: "skipped", PRIVACY: "skipped" };

  for (const [lane, result, override, expected] of [
    ["PR with selected jobs", pr, {}, 0],
    ["PR with unselected jobs", unselected, {}, 0],
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
    ["PR with cancelled queue images", pr, { IMAGES: "cancelled" }, 1],
    ["PR with failed Zammad compatibility", pr, { ZAMMAD_COMPATIBILITY: "failure" }, 1],
    ["PR with cancelled Zammad compatibility", pr, { ZAMMAD_COMPATIBILITY: "cancelled" }, 1],
    ["PR with missing Zammad selection", unselected, { ZAMMAD_NEEDED: "" }, 1],
    ["PR with a selected Zammad job skipped", pr, { ZAMMAD_COMPATIBILITY: "skipped" }, 1],
    ["PR with a privacy finding", pr, { PRIVACY: "failure" }, 1],
    ["PR with a skipped privacy scan", pr, { PRIVACY: "skipped" }, 1],
    ["merge queue with a cancelled privacy scan", queue, { PRIVACY: "cancelled" }, 1],
    ["main push with a failed privacy scan", push, { PRIVACY: "failure" }, 1],
    ["PR with new workflow lint findings", pr, { WORKFLOW_LINT: "failure" }, 1],
    ["PR with workflow lint skipped", pr, { WORKFLOW_LINT: "skipped" }, 1],
    ["PR with installer portal build failing", pr, { INSTALLER_PORTAL: "failure" }, 1],
    ["PR with installer portal build skipped despite selection", pr, { INSTALLER_PORTAL: "skipped" }, 1],
    ["PR with no installer portal selection evidence", unselected, { INSTALLER_PORTAL_NEEDED: "" }, 1],
    ["merge queue", queue, {}, 0],
    ["merge queue with Storybook skipped", queue, { STORYBOOK: "skipped" }, 1],
    ["merge queue with failed images", queue, { IMAGES: "failure" }, 1],
    ["merge queue with Zammad compatibility skipped", queue, { ZAMMAD_COMPATIBILITY: "skipped" }, 1],
    ["merge queue missing the installer portal build", queue, { INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped" }, 1],
    ["main push", push, {}, 0],
    ["main push with Storybook skipped", push, { STORYBOOK: "skipped" }, 1],
    ["main push with skipped units", push, { FULL_UNIT: "skipped" }, 1],
    ["main push with failed units", push, { FULL_UNIT: "failure" }, 1],
    ["main push with cancelled units", push, { FULL_UNIT: "cancelled" }, 1],
    ["main push with failed integration", push, { INTEGRATION: "failure" }, 1],
    ["main push with failed Zammad compatibility", push, { ZAMMAD_COMPATIBILITY: "failure" }, 1],
    ["main push with skipped infrastructure", push, { INFRA: "skipped" }, 1],
    ["main push with cancelled selection", push, { CHANGES: "cancelled" }, 1],
    ["manual dispatch", dispatch, {}, 0],
    ["manual dispatch with Storybook skipped", dispatch, { STORYBOOK: "skipped" }, 1],
    ["manual dispatch with skipped units", dispatch, { FULL_UNIT: "skipped" }, 1],
    ["manual dispatch with cancelled infrastructure", dispatch, { INFRA: "cancelled" }, 1],
  ]) {
    const execution = runWorkflowScript(run, { ...result, ...override, GITHUB_STEP_SUMMARY: summary });
    assert.ifError(execution.error);
    assert.equal(execution.status, expected, `${lane}: ${execution.stderr}`);
  }
  assert.match(await readFile(summary, "utf8"), /Event push ran both full unit shards/u);
});

test("CI seeds pnpm caches on main and builds cleanly in the merge queue", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const actionPath = "./.github/actions/ci-pnpm";
  const action = parse(await read(".github/actions/ci-pnpm/action.yml"));

  for (const job of [jobs.checks, jobs["lint-on-push"], jobs.integration]) {
    assert.equal(job.steps.find(step => step.id === "pnpm")?.uses, actionPath);
  }
  const modules = action.runs.steps.find(step => step.id === "modules");
  const store = action.runs.steps.find(step => step.id === "store");
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

test("PR image results are advisory while the merge queue requires the full image matrix", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const branch = parse(await read(".github/workflows/branch-image.yml")).jobs;
  const { images, "pr-images": prImages, "pr-image-results": report, "ci-gate": gate, publish } = jobs;
  assert.equal(gate.if, "always()");
  assert(gate.needs.includes("images"));
  assert(!gate.needs.includes("pr-images"));
  assert(!gate.needs.includes("pr-image-results"));
  assert.deepEqual(images.needs, ["changes"]);
  assert.deepEqual(prImages.needs, images.needs);
  assert.equal(images.if, "${{ !cancelled() && github.event_name == 'merge_group' && needs.changes.outputs.images == 'true' }}");
  assert.equal(prImages.if, "${{ !cancelled() && github.event_name == 'pull_request' && needs.changes.outputs.images == 'true' }}");
  assert.equal(images.strategy["max-parallel"], 21);
  assert.deepEqual(prImages.strategy, { ...images.strategy, "max-parallel": 8 });
  assert.equal(prImages.steps, images.steps);
  assert.equal(images["continue-on-error"], undefined);
  assert.equal(prImages["continue-on-error"], undefined);
  assert.equal(report.if, "always() && github.event_name == 'pull_request'");
  assert.equal(report.needs, "pr-images");
  assert.equal(report.steps[0].env.IMAGES, "${{ needs.pr-images.result }}");
  assert.equal(gate.steps[0].env.IMAGES, "${{ needs.images.result }}");
  assert.equal(publish.needs, "lint-on-push");
  assert.equal(publish.if, "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'WasalX/wasalx-platform' }}");
  assert.equal(publish.uses, "./.github/workflows/branch-image.yml");
  assert.deepEqual(publish.concurrency, { group: "release-${{ github.sha }}", "cancel-in-progress": false });
  assert.equal(branch.publish.strategy["max-parallel"], 21);
  assert.equal(branch.manifest.needs, "publish");
  assert.equal(branch.manifest.concurrency, undefined);
  assert.equal(branch.aliases, undefined);

  const directory = await mkdtemp(join(tmpdir(), "wasalx-ci-image-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const imageResult of ["success", "failure", "skipped", "cancelled"]) {
    const summary = join(directory, imageResult).replaceAll("\\", "/");
    const advisory = runWorkflowScript(report.steps[0].run, { IMAGES: imageResult, GITHUB_STEP_SUMMARY: summary });
    assert.equal(advisory.status, ["success", "skipped"].includes(imageResult) ? 0 : 1, advisory.stderr);
    assert.equal((await readFile(summary, "utf8")).trim(), `PR image builds (advisory): ${imageResult}`);
    if (imageResult === "failure") assert.match(advisory.stdout, /::warning::Advisory PR image builds: failure/u);

    const result = runWorkflowScript(gate.steps[0].run, {
      EVENT: "merge_group", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "skipped",
      IMAGES: imageResult, INTEGRATION: "success", PORTAL_INTEGRATION: "success",
      INTEGRATION_COVERAGE: "success", DEV_INSTALL: "skipped", INFRA: "success",
      ZAMMAD_COMPATIBILITY: "success",
      INSTALLER_PORTAL_NEEDED: "true", INSTALLER_PORTAL: "success",
    });
    assert.equal(result.status, imageResult === "success" ? 0 : 1, `merge_group/${imageResult}: ${result.stderr}`);
  }
  const summary = join(directory, "gate").replaceAll("\\", "/");
  const result = runWorkflowScript(gate.steps[0].run, {
    EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success",
    IMAGES: "skipped", INTEGRATION_NEEDED: "false", INTEGRATION: "skipped",
    PORTAL_INTEGRATION: "skipped", INTEGRATION_COVERAGE: "skipped", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
    INSTALLER_PORTAL_NEEDED: "false", INSTALLER_PORTAL: "skipped",
    INFRA_NEEDED: "false", INFRA: "skipped", GITHUB_STEP_SUMMARY: summary,
    ZAMMAD_COMPATIBILITY: "success",
  });
  assert.equal(result.status, 0, result.stderr);
  assert((await readFile(summary, "utf8")).includes(report.name));
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
  assert.equal(changes.outputs.integration, "${{ steps.integration.outputs.needed }}");
  assert.equal(changes.outputs.zammad, "${{ steps.zammad.outputs.needed }}");
  const paths = [
    "infra/helm/", "infra/terraform/", ":(glob)scripts/validate-*", "scripts/release/fetch-verified-asset.sh",
    "compose.full.yaml", "tests/fixtures/production-backup-alerts.yaml", "tests/secret-adapter-readiness.test.rb",
    ".github/workflows/ci.yml",
  ].join(" ");
  const directory = await mkdtemp(join(tmpdir(), "wasalx-infra-validate-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "gate-summary").replaceAll("\\", "/");
  for (const [id, diffPaths] of [
    ["infra", paths],
    ["dev-install", ["scripts/dev-install/", "scripts/release/installer-stages.mjs",
      "scripts/release/installer-stack.mjs", "scripts/release/compose-stage-lock.mjs",
      "scripts/release/compose-stage-config.json", ".github/workflows/ci.yml"].join(" ")],
    ["integration", [".github/workflows/ci.yml", "scripts/test-postgres-integration.mjs",
      "scripts/postgres-scenario-registry.mjs", ":(glob)tests/*postgres*.mjs",
      "tests/rendered-html.test.mjs", "tests/app-first-load-js-budget.json"].join(" ")],
    ["zammad", [
      "compose.full.yaml", ".dockerignore", "infra/docker/Dockerfile.zammad", "infra/docker/full/zammad/",
      "zammad-addon.json", "zammad-package/", "build/zammad/", "release/installer-images.json",
      ":(glob)scripts/*zammad*", ":(glob)scripts/contracts/*mailbox*", "scripts/release/operator-input.mjs",
      "tests/zammad-image-browser-compat.test.mjs", "tests/fixtures/native-compat-cleanup.mjs", ":(glob)tests/**/*.rb",
      "services/control-api/", "services/connector-worker/", "packages/", "lib/domain.ts", "lib/literal-matcher.ts",
      "scripts/build-services.mjs", "tsconfig.json", ":(glob)services/*/tsconfig*.json", ".gitattributes",
      "tests/outbound-media.test.mjs", "tests/helpers/operator-input-fixtures.mjs",
      ":(glob)**/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/",
      ".github/actions/ci-pnpm/", ".github/workflows/ci.yml", ".github/workflows/zammad-compatibility.yml",
    ].join(" ")],
  ]) {
    const detector = changes.steps.find(step => step.id === id);
    assert.equal(detector.if, "github.event_name == 'pull_request'");
    for (const [status, needed] of [[0, false], [1, true], [128, true]]) {
      const outputFile = join(directory, `${id}-${status}`);
      const result = runWorkflowScript(`git() {
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
    const result = runWorkflowScript(gateStep.run, {
      EVENT: event, CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: pr ? "success" : "skipped",
      IMAGES: pr ? "skipped" : "success", INTEGRATION_NEEDED: "false",
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
      EVENT: "pull_request", CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: "success",
      IMAGES: "skipped", INTEGRATION_NEEDED: "false",
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
      EVENT: event, CHANGES: "success", PRIVACY: "success", WORKFLOW_LINT: "success", STORYBOOK: "success", APPLICATION_E2E: "success", KEYCLOAK_IDENTITY: "success", CHECKS: "success", FULL_UNIT: "skipped", REVIEW: pr ? "success" : "skipped",
      IMAGES: pr ? "skipped" : "success", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
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
  const { run } = jobs.changes.steps.find(step => step.id === "zammad");
  const directory = await mkdtemp(join(tmpdir(), "zammad-compatibility-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: directory, encoding: "utf8", windowsHide: true,
  });
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "Base");
  const output = join(directory, "selection");
  for (const [path, expected] of [
    ["services/control-api/src/ticket-reply-target.ts", true],
    ["services/connector-worker/src/media-runtime.ts", true],
    ["packages/core/src/outbound-text.ts", true],
    ["lib/domain.ts", true],
    ["lib/literal-matcher.ts", true],
    ["scripts/build-services.mjs", true],
    ["tsconfig.json", true],
    ["services/invitation-mailer/tsconfig.json", true],
    ["docs/release.md", false],
  ]) {
    await mkdir(join(directory, posix.dirname(path)), { recursive: true });
    await writeFile(join(directory, path), "fixture\n");
    git("add", "--", path);
    git("commit", "--quiet", "-m", "Change one input");
    await writeFile(output, "");
    const result = runWorkflowScript(run, { GITHUB_OUTPUT: output.replaceAll("\\", "/") }, directory);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal((await readFile(output, "utf8")).trim(), `needed=${expected}`, path);
  }
});

test("Zammad compatibility gates CI and reuses the same job on the nightly schedule", async () => {
  const workflow = ".github/workflows/zammad-compatibility.yml";
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const nightly = parse(await read(".github/workflows/nightly-install.yml"));
  const compatibility = parse(await read(workflow));
  const job = jobs["zammad-compatibility"];
  assert.equal(job.needs, "changes");
  assert.equal(job.if, "${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.zammad != 'false') }}");
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
  assert.equal(fullUnit.if, "github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
  assert.deepEqual(fullUnit.strategy.matrix.include, jobs.checks.strategy.matrix.include.filter(row => row.mode === "unit"));
  assert.deepEqual(fullUnit.steps, jobs.checks.steps);
  assert.match(jobs.checks.steps[0].with["fetch-depth"], /github\.event_name == 'pull_request' && matrix\.mode == 'unit' && '2'/u);
  assert(jobs["ci-gate"].needs.includes("full-unit"));
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
