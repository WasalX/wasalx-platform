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
import { unitAllowlist, unitFiles } from "../scripts/test-unit.mjs";
import { addonSkips, skipPattern } from "../scripts/hosted-ci-policy.mjs";
import { generateBaseline } from "../scripts/generate-hosted-ci-baseline.mjs";
import baseline from "../scripts/hosted-ci-baseline.mjs";
import { parsePostgresShardArgs, postgresScenarioGroups, verifyPostgresReports } from "../scripts/postgres-scenario-registry.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFile(join(repository, file), "utf8");
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

test("runner ownership recognizes a bare sudo interpreter", () => {
  const file = "scripts/example.sh";
  assert(runsFile(`sudo bash ${file}`, file));
  assert(!runsFile(`sudo apt-get ${file}`, file));
  assert(!runsFile(`sudo -u x bash ${file}`, file));
});

function referencesFile(source, file) {
  return source.includes(`"${file}"`) || source.includes(`'${file}'`);
}

const tofuFile = file => /^infra\/terraform\/tests\/[^/]+\.tftest\.(?:hcl|json)$/u.test(file);
const postgresFile = file => /^tests\/.*(?:-postgres(?:-check)?|-real-schema-check)\.mjs$/u.test(file);

function runWorkflowScript(script, env) {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  return spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000, windowsHide: true,
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
      case "test:e2e":
        return runsFile(command, "scripts/run-application-e2e.mjs")
          && referencesFile(applicationRunner, "playwright.application.config.ts")
          && referencesFile(application, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(application, posix.basename(file));
      case "playwright.identity.config.ts":
        return referencesFile(identity, "./tests/e2e")
          && posix.dirname(file) === "tests/e2e" && referencesFile(identity, posix.basename(file));
      case "storybook":
        return referencesFile(storybookRunner, "playwright.storybook.config.ts")
          && referencesFile(storybook, "./tests/visual")
          && commands(command).some(line =>
            runsFile(line, "scripts/storybook-visual-regression.mjs", "--require-browser") && words(line).includes(file));
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
  assert(!jobs["ci-gate"].needs.includes("storybook"));

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
  assert(actions.every(step => /@[0-9a-f]{40}$/u.test(step.uses)));
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
  assert.match(rehearsal, /phase native-preflight [^]*phase probe-scan 5m sudo -H env "PATH=\$PATH" node scripts\/dev-install\/probe\.mjs [^]*--held-services ''[^]*\.census == "PASS" and \.services == 37 and \.rerendered_hashes == \.services[^]*phase configured-reinstall/u);
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

test("nightly selects the newest complete publication within five first-parent commits and requires an exact publication on tags", async t => {
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
  const commits = git("rev-list", "--first-parent", base).split(/\r?\n/u);
  const tag = "v0.0.0-rc.1";
  git("tag", "-a", tag, base, "-m", "fixture tag");
  git("checkout", "--quiet", "--detach", base);
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
      [[ "$INVALID" != true ]] || commit=$BASE
      while [[ "$1" != --dir ]]; do shift; done
      printf '{"schemaVersion":1,"repository":"%s","platform":"linux/amd64","commit":"%s","tree":"%s","images":%s,"pending":%s,"publicationComplete":%s}\n' \
        "$GITHUB_REPOSITORY" "$commit" "$(git rev-parse "$commit^{tree}")" "$images" "$pending" "$complete" > "$2/images-manifest.json"
      ;;
    *) return 2 ;;
  esac
}
`;
  const cases = [
    { ready: base, selected: base, lookups: commits.slice(0, 1), reason: "requested base has a complete publication" },
    { ready: commits[4], incomplete: commits[1], expired: commits[2], noJob: commits[3],
      selected: commits[4], lookups: commits.slice(0, 5) },
    { ready: commits[5], lookups: commits.slice(0, 5), reason: "No complete green main publication" },
    { ready: side, lookups: commits.slice(0, 5), reason: "No complete green main publication" },
    { ready: commits[1], lookupError: base, lookups: commits.slice(0, 1), status: 17 },
    { ready: commits[1], invalid: true, lookups: commits.slice(0, 2), status: 5, reason: "Invalid nightly publication manifest" },
    { ready: base, exact: true, selected: base, lookups: commits.slice(0, 1) },
    { ready: commits[1], exact: true, lookups: commits.slice(0, 1), reason: "No green main CI push run for the commit" },
  ];
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const { ready, selected, incomplete = "", expired = "", noJob = "", lookupError = "", invalid = false,
    exact = false, lookups, status = selected ? 0 : 1, reason } of cases) {
    await writeFile(join(directory, "lookups"), "");
    await writeFile(join(directory, "publication-output"), "");
    await writeFile(join(directory, "publication-summary"), "");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-euo", "pipefail", "-c", ghFixture + publication.run], {
      ...options, timeout: 10_000, env: {
        ...process.env, GITHUB_REPOSITORY: "fixture/nightly", BASE: base, READY: ready, INCOMPLETE: incomplete,
        EXPIRED: expired, NO_JOB: noJob, LOOKUP_ERROR: lookupError, INVALID: String(invalid),
        GITHUB_EVENT_NAME: exact ? "push" : "schedule", GITHUB_REF_TYPE: exact ? "tag" : "branch",
        GITHUB_REF: exact ? `refs/tags/${tag}` : "refs/heads/main",
        GITHUB_SHA: base, GITHUB_OUTPUT: "publication-output", GITHUB_STEP_SUMMARY: "publication-summary", RUNNER_TEMP: ".",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal((await readFile(join(directory, "publication-output"), "utf8")).trim(), selected ? `commit=${selected}` : "");
    if (reason) assert.ok((result.stdout + result.stderr).includes(reason), result.stderr);
    const warning = selected && selected !== base
      ? `Nightly images come from ${selected} (run 101) because requested base ${base} has no complete green publication.`
      : "";
    const annotations = result.stderr.split(/\r?\n/u).filter(line => line.startsWith("::warning::"));
    assert.deepEqual(annotations, warning ? [`::warning::${warning}`] : []);
    assert.equal((await readFile(join(directory, "publication-summary"), "utf8")).trim(), warning);
    if (selected) {
      const manifest = join(directory, "wasalx-nightly", "images-manifest.json");
      assert.equal(JSON.parse(await readFile(manifest, "utf8")).commit, selected);
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

test("CI gates integration and infrastructure and runs portal integration files serially", async () => {
  const { on, jobs } = parse(await read(".github/workflows/ci.yml"));
  const { integration, "integration-coverage": coverage, "portal-integration": portal,
    "ci-gate": gate, "dev-install-dryrun": dryrun } = jobs;
  assert(Object.hasOwn(on, "workflow_dispatch"));
  assert(Object.hasOwn(on, "merge_group"));
  assert.deepEqual(on.push.branches, ["main"]);
  assert.equal(integration.needs, "changes");
  assert.equal(integration.if, "${{ !cancelled() && (github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.integration != 'false'))) }}");
  assert.equal(portal.needs, "changes");
  assert.equal(portal.if, integration.if);
  assert.equal(coverage.needs, "integration");
  assert.deepEqual(integration.strategy, { "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
  assert.match(integration.services.postgres.options, /--tmpfs /u);
  assert(coverage.steps.some(step => runsFile(step.run ?? "", "scripts/postgres-scenario-registry.mjs")));
  assert(integration.steps.some(step => runsFile(step.run ?? "", "scripts/test-postgres-integration.mjs", "--shard")));
  assert.equal(integration["timeout-minutes"], 25);
  assert.deepEqual(integration.permissions, { contents: "read" });
  assert.match(integration.services.postgres.image, /^postgres:[^@]+@sha256:[a-f0-9]{64}$/u);
  const devPreflightFile = "tests/installer-dev-recreatability.test.mjs";
  const devPreflight = jobs.checks.steps.find(step => runsFile(step.run ?? "", devPreflightFile));
  assert.equal(devPreflight?.if, "github.event_name == 'pull_request' && matrix.mode == 'unit' && matrix.shard == 1");
  assert(portal.steps.some(step => !step.if && runsFile(step.run ?? "", devPreflightFile)));
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
  assert.equal(gateStep.env.INTEGRATION_NEEDED, "${{ needs.changes.outputs.integration }}");
  assert.equal(gateStep.env.INTEGRATION, "${{ needs.integration.result }}");
  assert.equal(gateStep.env.PORTAL_INTEGRATION, "${{ needs.portal-integration.result }}");
  assert.equal(gateStep.env.INTEGRATION_COVERAGE, "${{ needs.integration-coverage.result }}");
  assert.equal(gateStep.env.DEV_INSTALL_NEEDED, "${{ needs.changes.outputs.dev-install }}");
  assert.equal(gateStep.env.DEV_INSTALL, "${{ needs.dev-install-dryrun.result }}");
  for (const job of [jobs.changes, jobs.checks]) {
    assert.equal(job.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  }
});

test("CI gate requires each event's jobs and rejects unplanned skips, failures, and cancellations", async t => {
  const { jobs } = parse(await read(".github/workflows/ci.yml"));
  const [{ run }] = jobs["ci-gate"].steps;
  const directory = await mkdtemp(join(tmpdir(), "ci-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const pr = {
    EVENT: "pull_request", CHANGES: "success", CHECKS: "success", REVIEW: "success", IMAGES: "skipped",
    INTEGRATION_NEEDED: "true", INTEGRATION: "success", PORTAL_INTEGRATION: "success",
    INTEGRATION_COVERAGE: "success", INFRA_NEEDED: "true", INFRA: "success",
    DEV_INSTALL_NEEDED: "true", DEV_INSTALL: "success",
  };
  const unselected = {
    ...pr, INTEGRATION_NEEDED: "false", INTEGRATION: "skipped", PORTAL_INTEGRATION: "skipped",
    INTEGRATION_COVERAGE: "skipped", INFRA_NEEDED: "false", INFRA: "skipped",
    DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
  };
  const queue = {
    ...pr, EVENT: "merge_group", REVIEW: "skipped", IMAGES: "success",
    INTEGRATION_NEEDED: "", INFRA_NEEDED: "", DEV_INSTALL_NEEDED: "", DEV_INSTALL: "skipped",
  };
  const push = { ...queue, EVENT: "push", CHANGES: "skipped", CHECKS: "skipped", IMAGES: "skipped" };
  const dispatch = { ...push, EVENT: "workflow_dispatch", INFRA: "skipped" };

  for (const [lane, result, override, expected] of [
    ["PR with selected jobs", pr, {}, 0],
    ["PR with unselected jobs", unselected, {}, 0],
    ["PR without a recorded skip reason", unselected, { INTEGRATION_NEEDED: "" }, 1],
    ["PR with cancelled queue images", pr, { IMAGES: "cancelled" }, 1],
    ["merge queue", queue, {}, 0],
    ["merge queue with failed images", queue, { IMAGES: "failure" }, 1],
    ["main push", push, {}, 0],
    ["main push with failed integration", push, { INTEGRATION: "failure" }, 1],
    ["main push with skipped infrastructure", push, { INFRA: "skipped" }, 1],
    ["main push with cancelled selection", push, { CHANGES: "cancelled" }, 1],
    ["manual dispatch", dispatch, {}, 0],
    ["manual dispatch with cancelled infrastructure", dispatch, { INFRA: "cancelled" }, 1],
  ]) {
    const execution = runWorkflowScript(run, { ...result, ...override, GITHUB_STEP_SUMMARY: summary });
    assert.ifError(execution.error);
    assert.equal(execution.status, expected, `${lane}: ${execution.stderr}`);
  }
  assert.match(await readFile(summary, "utf8"), /Event push skips PR and merge queue jobs/u);
});

test("CI seeds pnpm caches on main and builds cleanly in the merge queue", async () => {
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
  assert.match(restore.with["restore-keys"], /github\.event_name == 'pull_request'/u);

  const commands = name => 'pnpm() { printf "%s\\n" "$*"; }\n' + action.runs.steps.find(step => step.name === name).run;
  for (const [hit, flags] of [["true", "--offline"], ["", "--fetch-retries=2"]]) {
    const result = runWorkflowScript(commands("Install workspace dependencies"), { MODULES_HIT: hit });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `install --frozen-lockfile ${flags}`);
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
  assert.equal(branch.aliases.needs, "manifest");
  assert.deepEqual(branch.aliases.concurrency, { group: "release-main", queue: "max" });

  const directory = await mkdtemp(join(tmpdir(), "wasalx-ci-image-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const imageResult of ["success", "failure", "skipped", "cancelled"]) {
    const summary = join(directory, imageResult).replaceAll("\\", "/");
    const advisory = runWorkflowScript(report.steps[0].run, { IMAGES: imageResult, GITHUB_STEP_SUMMARY: summary });
    assert.equal(advisory.status, ["success", "skipped"].includes(imageResult) ? 0 : 1, advisory.stderr);
    assert.equal((await readFile(summary, "utf8")).trim(), `PR image builds (advisory): ${imageResult}`);
    if (imageResult === "failure") assert.match(advisory.stdout, /::warning::Advisory PR image builds: failure/u);

    const result = runWorkflowScript(gate.steps[0].run, {
      EVENT: "merge_group", CHANGES: "success", CHECKS: "success", REVIEW: "skipped",
      IMAGES: imageResult, INTEGRATION: "success", PORTAL_INTEGRATION: "success",
      INTEGRATION_COVERAGE: "success", DEV_INSTALL: "skipped", INFRA: "success",
    });
    assert.equal(result.status, imageResult === "success" ? 0 : 1, `merge_group/${imageResult}: ${result.stderr}`);
  }
  const summary = join(directory, "gate").replaceAll("\\", "/");
  const result = runWorkflowScript(gate.steps[0].run, {
    EVENT: "pull_request", CHANGES: "success", CHECKS: "success", REVIEW: "success",
    IMAGES: "skipped", INTEGRATION_NEEDED: "false", INTEGRATION: "skipped",
    PORTAL_INTEGRATION: "skipped", INTEGRATION_COVERAGE: "skipped", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
    INFRA_NEEDED: "false", INFRA: "skipped", GITHUB_STEP_SUMMARY: summary,
  });
  assert.equal(result.status, 0, result.stderr);
  assert((await readFile(summary, "utf8")).includes(report.name));
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
      "scripts/postgres-scenario-registry.mjs", ":(glob)tests/*postgres*.mjs"].join(" ")],
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
      EVENT: event, CHANGES: "success", CHECKS: "success", REVIEW: pr ? "success" : "skipped",
      IMAGES: pr ? "skipped" : "success", INTEGRATION_NEEDED: "false",
      INTEGRATION: pr ? "skipped" : "success", PORTAL_INTEGRATION: pr ? "skipped" : "success",
      INTEGRATION_COVERAGE: pr ? "skipped" : "success",
      DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
      INFRA_NEEDED: needed, INFRA: jobResult, GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, status, `${event}/${needed}/${jobResult}: ${result.error?.message ?? result.stderr}`);
  }
  for (const [needed, jobResult, status] of [
    ["true", "success", 0], ["false", "skipped", 0], ["true", "skipped", 1], ["", "skipped", 1],
    ["true", "failure", 1], ["true", "cancelled", 1],
  ]) {
    const result = runWorkflowScript(gateStep.run, {
      EVENT: "pull_request", CHANGES: "success", CHECKS: "success", REVIEW: "success",
      IMAGES: "skipped", INTEGRATION_NEEDED: "false",
      INTEGRATION: "skipped", PORTAL_INTEGRATION: "skipped", INTEGRATION_COVERAGE: "skipped",
      DEV_INSTALL_NEEDED: needed, DEV_INSTALL: jobResult, INFRA_NEEDED: "false", INFRA: "skipped",
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
      EVENT: event, CHANGES: "success", CHECKS: "success", REVIEW: pr ? "success" : "skipped",
      IMAGES: pr ? "skipped" : "success", DEV_INSTALL_NEEDED: "false", DEV_INSTALL: "skipped",
      INFRA_NEEDED: "true", INFRA: "success", INTEGRATION_NEEDED: needed, GITHUB_STEP_SUMMARY: summary,
      INTEGRATION: postgres, PORTAL_INTEGRATION: portal, INTEGRATION_COVERAGE: coverage,
    });
    assert.equal(result.status, status, [event, needed, postgres, portal, coverage].join("/"));
  }
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
