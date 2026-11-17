import "./helpers/operator-input-fixtures.mjs";
process.env.WASALX_RELEASE_EVIDENCE_SCRIPT = "fixture-release-evidence.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { ALLOWED_GATES, PLAYWRIGHT_IMAGE, applicationCpuLimit, ciRuntime, containerName, cpuSnapshot, dockerArguments, rootlessDataRoot, validateInvocation } from "../scripts/release/ci-browser-runtime.mjs";
import { managedEnvironment } from "./helpers/quality-workflow-fixture.mjs";
import { fixtureStderr } from "./support/bounded-command.mjs";

test("fake Docker keeps Node warnings outside its exact error protocol", t => {
  const root = mkdtempSync(join(tmpdir(), "wasalx-fake-docker-warnings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warnings = join(root, "warnings.log");
  // Hermetic child: runner proxy settings make Node emit its own startup UNDICI-EHPA warning ahead of the fixture's.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:https?_proxy|no_proxy|all_proxy|node_use_env_proxy)$/iu.test(key)));
  const result = spawnSync(process.execPath, ["--redirect-warnings", warnings, "-e",
    "process.emitWarning('EnvHttpProxyAgent is experimental, expect them to change at any time.', {code:'UNDICI-EHPA'}); process.stderr.write('Error: No such object: owned-id'); process.exitCode=1;"],
  { encoding: "utf8", windowsHide: true, env });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Error: No such object: owned-id");
  assert.equal(fixtureStderr(readFileSync(warnings, "utf8")), "");
  assert.equal(fixtureStderr("(node:1) [UNKNOWN] Warning: unexpected\n"), "(node:1) [UNKNOWN] Warning: unexpected\n");
});

test("managed runtime is explicit exact owner dispatch and cannot impersonate native qualification", () => {
  assert.equal(ciRuntime({}), "native");
  assert.equal(ciRuntime(managedEnvironment), "managed");
  const ciOnlySha = "b".repeat(40);
  assert.equal(ciRuntime({ ...managedEnvironment, GITHUB_REF: "refs/heads/wasalx/ci-only-r3", GITHUB_WORKFLOW_REF: ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@refs/heads/wasalx/ci-only-r3"), GITHUB_SHA: ciOnlySha, WASALX_CI_RUNTIME_SHA: ciOnlySha, WASALX_CI_EVIDENCE_MODE: "non-qualifying-ci-only" }), "managed");
  assert.equal(ciRuntime({ ...managedEnvironment, WASALX_CI_SCOPE: "repository-only", WASALX_CI_WORKFLOW_RUNTIME: "managed" }), "managed");
  for (const change of [{ WASALX_CI_SCOPE: "unknown" }, { WASALX_CI_RUNTIME: "native", WASALX_CI_SCOPE: "repository-only" },
    { WASALX_CI_SCOPE: "repository-only", GITHUB_JOB: "browser" }]) {
    assert.throws(() => ciRuntime({ ...managedEnvironment, ...change }));
  }
  for (const change of [{ WASALX_CI_RUNTIME: "unknown" }, { WASALX_CI_RUNTIME: "" },
    { WASALX_CI_WORKFLOW_RUNTIME: "managed" }, { WASALX_CI_WORKFLOW_RUNTIME: undefined },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "merge_group" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REPOSITORY: "foreign/repo" }, { GITHUB_REF: "refs/heads/dev" }, { GITHUB_REF_PROTECTED: "true" },
    { GITHUB_WORKFLOW_REF: ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@refs/heads/main") },
    { WASALX_CI_RUNTIME_SHA: "b".repeat(40) }, { WASALX_CI_CPU_TRIAL_LIVE: "true" },
    { WASALX_CI_APPLICATION_CPUS: "4" }, { RUNNER_ENVIRONMENT: "github-hosted" },
    { GITHUB_JOB: "zammad-compatibility" }, { GITHUB_JOB: "local-release-ready" }, { GITHUB_JOB: "publish-images" }]) {
    assert.throws(() => ciRuntime({ ...managedEnvironment, ...change }));
  }
});


const sha = "a".repeat(40);
const command = gate => ["node", "fixture-release-evidence.mjs", "run", "--gate", gate, "--candidate-sha", sha];
const env = {
  CI: "true", GITHUB_ACTIONS: "true", GITHUB_SHA: sha, GITHUB_JOB: "browser",
  GITHUB_WORKFLOW_REF: ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@refs/pull/90/merge"),
  GITHUB_RUN_ID: "35440262112", GITHUB_RUN_ATTEMPT: "3", GITHUB_WORKSPACE: "/work/WasalX",
  RUNNER_OS: "Linux", WASALX_CANDIDATE_TREE: "b".repeat(40), GH_TOKEN: "must-not-cross",
};

test("CI browser runtime admits only exact local gates in a rootless offline container", () => {
  const dockerRoot = resolve("rootless-docker");
  assert.equal(rootlessDataRoot({ SecurityOptions: ["name=rootless"], DockerRootDir: dockerRoot }), dockerRoot);
  assert.throws(() => rootlessDataRoot({ SecurityOptions: ["name=seccomp"], DockerRootDir: "/var/lib/docker" }), /dedicated rootless/u);
  assert.deepEqual([...ALLOWED_GATES], ["visual", "browser,browser-en", "multitenant"]);
  for (const gate of ALLOWED_GATES) assert.deepEqual(validateInvocation(command(gate)), { gate, candidateSha: sha });
  for (const invalid of ["design-system", "browser", "docker-smoke"]) {
    assert.throws(() => validateInvocation(command(invalid)), /Unsupported isolated browser gate/u);
  }
  assert.throws(() => validateInvocation(command("browser")), /Unsupported isolated browser gate: browser/u,
    "manual unsharded browser invocation must fail clearly");
  assert.throws(() => validateInvocation([...command("visual"), "extra"]), /one exact/u);
  assert.throws(() => validateInvocation(command("visual").with(6, "A".repeat(40))), /lowercase Git SHA/u);

  const name = containerName(env);
  const args = dockerArguments({
    argv: command("browser,browser-en"), env, workspace: "/work/WasalX",
    nodeRoot: "/runner/node/22.23.4/x64", pnpmRoot: "/runner/setup-pnpm", name, daemonNcpu: 8,
  });
  assert.match(PLAYWRIGHT_IMAGE, /^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(args.slice(0, 8), ["run", "--rm", "--init", "--name", name, "--pull", "never", "--network"]);
  assert(args.includes("none"));
  assert(args.includes("ALL"));
  assert(args.includes("no-new-privileges"));
  assert.equal(args[args.indexOf("--cpus") + 1], "6");
  for (const value of ["8g", "1024", "1g"]) assert(args.includes(value));
  assert(args.includes("type=bind,src=/work/WasalX,dst=/work/WasalX"));
  assert(args.includes("type=bind,src=/runner/node/22.23.4/x64,dst=/runner/node/22.23.4/x64,readonly"));
  assert(args.includes("type=bind,src=/runner/setup-pnpm,dst=/runner/setup-pnpm,readonly"));
  assert(args.includes(PLAYWRIGHT_IMAGE));
  assert(args.includes("GIT_CONFIG_KEY_0=safe.directory"));
  assert(args.includes("WASALX_CI_BROWSER_INSIDE=1"));
  assert(!args.some(value => value.includes("docker.sock") || value.includes("GH_TOKEN") || value.includes("must-not-cross")));
  assert(!args.includes("host"));
  assert.deepEqual(args.slice(-7), command("browser,browser-en"));
});

test("application CPU sizing preserves visual and preflight limits", () => {
  for (const [gate, cpus] of [["browser,browser-en", "6"], ["visual", "4"], [null, "4"]]) {
    const args = dockerArguments({
      argv: gate ? command(gate) : [], env, workspace: "/work/WasalX",
      nodeRoot: "/runner/node/22.23.4/x64", pnpmRoot: "/runner/setup-pnpm", name: containerName(env), daemonNcpu: 8,
    });
    assert.equal(args[args.indexOf("--cpus") + 1], cpus);
    for (const [option, value] of [["--memory", "8g"], ["--pids-limit", "1024"], ["--shm-size", "1g"], ["--network", "none"]]) {
      assert.equal(args[args.indexOf(option) + 1], value);
    }
  }
});

test("application CPU sizing falls back to the Docker CPU count", () => {
  const input = { argv: command("browser,browser-en"), env, workspace: "/work/WasalX", nodeRoot: "/runner/node", pnpmRoot: "/runner/pnpm", name: containerName(env) };
  for (const [daemonNcpu, expected] of [[4, "4"], [5, "5"], [6, "6"], [40, "6"]]) {
    const args = dockerArguments({ ...input, daemonNcpu });
    assert.equal(args[args.indexOf("--cpus") + 1], expected);
  }
  for (const daemonNcpu of [undefined, 0, -1, 4.5, "4"]) assert.throws(() => dockerArguments({ ...input, daemonNcpu }), /Docker NCPU/u);
});

test("manual CPU comparisons bind one SHA, reject live qualification and protect the SSD window", () => {
  const trial = { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/ci-audit/browser-cpu",
    WASALX_CI_APPLICATION_CPUS: "4", WASALX_CI_CPU_TRIAL_SHA: sha, WASALX_CI_CPU_TRIAL_LIVE: "false" };
  const now = new Date("2026-10-25T10:00:00Z");
  assert.equal(applicationCpuLimit({}, now), 6);
  assert.equal(applicationCpuLimit({ WASALX_CI_APPLICATION_CPUS: "" }, now), 6);
  for (const cpus of ["4", "5", "6"]) assert.equal(applicationCpuLimit({ ...trial, WASALX_CI_APPLICATION_CPUS: cpus }, now), Number(cpus));
  for (const changed of [
    { WASALX_CI_APPLICATION_CPUS: "8" }, { WASALX_CI_APPLICATION_CPUS: "4.0" },
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "push" },
    { WASALX_CI_CPU_TRIAL_SHA: "b".repeat(40) }, { GITHUB_SHA: "invalid" },
    { WASALX_CI_CPU_TRIAL_LIVE: "true" }, { WASALX_CI_CPU_TRIAL_LIVE: undefined },
    { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/tags/v1" },
  ]) assert.throws(() => applicationCpuLimit({ ...trial, ...changed }, now));
  for (const time of ["11:59:59", "16:00:00"]) assert.equal(applicationCpuLimit(trial, new Date(`2026-10-25T${time}Z`)), 4);
  for (const time of ["12:00:00", "15:59:59"]) assert.throws(() => applicationCpuLimit(trial, new Date(`2026-10-25T${time}Z`)), /SSD window/u);
  assert.throws(() => applicationCpuLimit(trial, new Date("invalid")), /SSD window/u);

  const input = { argv: command("browser,browser-en"), env: trial, workspace: "/work/WasalX", nodeRoot: "/runner/node", pnpmRoot: "/runner/pnpm", name: containerName(env), daemonNcpu: 8, now };
  for (const cpus of ["4", "5", "6"]) {
    const args = dockerArguments({ ...input, env: { ...trial, WASALX_CI_APPLICATION_CPUS: cpus } });
    assert.equal(args[args.indexOf("--cpus") + 1], cpus);
    assert.equal(args[args.indexOf("--memory") + 1], "8g");
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert(!args.some(value => value.startsWith("WASALX_CI_CPU_TRIAL") || value.startsWith("WASALX_CI_APPLICATION_CPUS=")));
  }
  assert.throws(() => dockerArguments({ ...input, env: { ...trial, WASALX_CI_APPLICATION_CPUS: "6" }, daemonNcpu: 4 }), /requested Docker CPU/u);
  const visual = dockerArguments({ ...input, argv: command("visual") });
  assert.equal(visual[visual.indexOf("--cpus") + 1], "4");
});

test("CPU evidence records numeric counters and marks absent or invalid readings unknown", t => {
  const root = mkdtempSync(join(tmpdir(), "wasalx-cpu-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unknown = { cpuMax: null, usageUsec: null, periods: null, throttledPeriods: null, throttledUsec: null };
  assert.deepEqual(cpuSnapshot(root), unknown);
  writeFileSync(join(root, "cpu.max"), "600000 100000\n");
  writeFileSync(join(root, "cpu.stat"), "usage_usec 2000000\nnr_periods 30\nnr_throttled 2\nthrottled_usec 12345\nunknown_sensitive_value do-not-log\n");
  assert.deepEqual(cpuSnapshot(root), { cpuMax: "600000 100000", usageUsec: 2000000, periods: 30, throttledPeriods: 2, throttledUsec: 12345 });
  writeFileSync(join(root, "cpu.max"), "do-not-log");
  writeFileSync(join(root, "cpu.stat"), "usage_usec -1\nnr_periods NaN\nnr_throttled do-not-log\nthrottled_usec 9999999999999999999999");
  assert.deepEqual(cpuSnapshot(root), unknown);
});

test("CI browser preparation cannot cold-pull the image", () => {
  const source = readFileSync(new URL("../scripts/release/ci-browser-runtime.mjs", import.meta.url), "utf8");
  const prepare = source.split("function prepare(env) {")[1]?.split("\n}")[0];
  assert(prepare, "browser preparation must exist");
  assert(!prepare.includes('"pull"'), "browser preparation must not pull an image");
  assert(prepare.indexOf("statfsSync(dockerRootDir)") < prepare.indexOf("inspectImage()"), "free space must be checked before image admission");
});


test("database browsers share only their owned offline namespace and CI socket", async () => {
  const { fixtureNetwork, fixtureNetworkArgs } = await import("./support/ci-fixture-network.mjs");
  assert.equal(fixtureNetwork({}), null);
  assert.deepEqual(fixtureNetworkArgs(5432, 42001, {}), ["-p", "127.0.0.1:42001:5432"]);
  const scoped = { ...env, WASALX_CI_BROWSER_INSIDE: "1", WASALX_CI_FIXTURE_NETWORK: containerName(env) };
  assert.deepEqual(fixtureNetworkArgs(5432, 42001, scoped), ["--network", `container:${containerName(env)}`, "--pull", "never", "--label", `io.wasalx.ci-browser-owner=${containerName(env)}`]);
  assert.throws(() => fixtureNetwork({ ...scoped, GITHUB_ACTIONS: "false" }));
  assert.throws(() => fixtureNetwork({ ...scoped, WASALX_CI_BROWSER_INSIDE: "0" }));
  assert.throws(() => fixtureNetwork({ ...scoped, WASALX_CI_FIXTURE_NETWORK: "production" }));
  assert.throws(() => fixtureNetwork({ ...scoped, GITHUB_RUN_ID: "12" }));
  // getuid is absent on Windows; argument validation is exercised on Linux CI.
  if (process.platform === "win32") return;
  const socket = `/run/user/${process.getuid()}/docker.sock`;
  const input = { argv: command("multitenant"), env, workspace: "/work/WasalX", nodeRoot: "/runner/node", pnpmRoot: "/runner/pnpm", name: containerName(env), dockerSocket: socket, dockerCli: "/usr/bin/docker", daemonNcpu: 8 };
  const args = dockerArguments(input);
  assert.equal(args[args.indexOf("--cpus") + 1], "4");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert(args.includes(`DOCKER_HOST=unix://${socket}`));
  assert(args.includes(`WASALX_CI_FIXTURE_NETWORK=${containerName(env)}`));
  assert(!args.some(value => value.includes("GH_TOKEN") || value.includes("must-not-cross")));
  assert.throws(() => dockerArguments({ ...input, dockerSocket: "/var/run/docker.sock" }));
  assert.throws(() => dockerArguments({ ...input, dockerCli: "/tmp/docker" }));
});


// Real Bash/Node signals, with an isolated fake daemon: no Docker socket is used.
async function lifecycle(t, mode, signal) {
  const root = mkdtempSync(join(tmpdir(), "wasalx-browser-lifecycle-"));
  const statePath = join(root, "state.json");
  const actionsPath = join(root, "actions.jsonl");
  const name = containerName(env);
  const id = "c".repeat(64);
  const foreign = { id: "d".repeat(64), running: true };
  writeFileSync(statePath, JSON.stringify({ own: null, foreign }));
  writeFileSync(actionsPath, "");
  writeFileSync(join(root, "docker"), `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const mode = process.env.BROWSER_CASE;
const path = process.env.BROWSER_STATE;
const id = ${JSON.stringify(id)};
const name = ${JSON.stringify(name)};
const image = ${JSON.stringify(PLAYWRIGHT_IMAGE)};
const read = () => JSON.parse(readFileSync(path, "utf8"));
const save = state => writeFileSync(path, JSON.stringify(state));
appendFileSync(process.env.BROWSER_ACTIONS, JSON.stringify(args) + "\\n");
if (args[0] === "create") {
  assert(args.includes("--rm") && args.includes("never") && args.includes(image));
  if (mode === "create-failure") process.exit(125);
  const state = read();
  state.own = { id, running: false };
  save(state);
  if (mode === "create-pending") {
    process.stderr.write("CREATING\\n");
    watch(dirname(path), () => {});
  } else process.stdout.write(mode === "malformed-id" ? "bad-id\\n" : id + "\\n");
} else if (args[0] === "start") {
  assert.deepEqual(args, ["start", "--attach", id]);
  const state = read();
  state.own.running = true;
  save(state);
  if (mode === "auto-removed") { state.own = null; save(state); }
  if (mode === "cli-failure") process.exit(42);
  if (["auto-removed", "exit-zero-running", "stopped-retained", "wrong-name", "wrong-image", "inspect-failure", "stop-failure"].includes(mode)) process.exit(0);
  const watcher = watch(dirname(path), () => { if (!read().own?.running) { watcher.close(); process.exit(0); } });
  process.stdout.write("RUNNING\\n");
} else if (args[0] === "inspect") {
  assert.equal(args.at(-1), id);
  if (args.includes("{{json .HostConfig.NanoCpus}}")) {
    if (mode === "slow-cpu-inspect") { process.stderr.write("CPU_INSPECTING\\n"); watch(dirname(path), () => {}); }
    else { process.stdout.write(mode === "invalid-cpu-metadata" ? "0\\n" : "6000000000\\n"); process.exit(0); }
  } else {
  if (mode === "inspect-failure") { process.stderr.write("daemon unavailable\\n"); process.exit(1); }
  const state = read();
  if (!state.own) { process.stderr.write("Error: No such object: " + id + "\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify([id, mode === "wrong-name" ? "/foreign" : "/" + name, mode === "wrong-image" ? "foreign-image" : image, state.own.running]));
  }
} else if (args[0] === "stop") {
  assert.deepEqual(args, ["stop", "--time", "1", id]);
  if (mode === "stop-failure") { process.stderr.write("daemon unavailable\\n"); process.exit(1); }
  const state = read();
  if (mode === "stopped-retained") state.own.running = false;
  else state.own = null;
  save(state);
} else if (args[0] === "ps") {
  assert.deepEqual(args, ["ps", "--all", "--quiet", "--filter", "label=io.wasalx.ci-browser-owner=" + name]);
  if (mode === "slow-fixtures") watch(dirname(path), () => {});
  else process.stdout.write("e".repeat(64) + "\\n");
} else if (args[0] === "rm") {
  if (args[1] === id) {
    assert.deepEqual(args, ["rm", id]);
    const state = read(); assert.equal(state.own.running, false); state.own = null; save(state);
  } else assert.deepEqual(args, ["rm", "--force", "e".repeat(64)]);
} else assert.fail("unexpected Docker command");
`, { mode: 0o700 });
  const warnings = join(root, "warnings.log");
  const entry = join(root, "entry.mjs");
  writeFileSync(entry, `import assert from "node:assert/strict";
import { runOwnedContainer } from ${JSON.stringify(new URL("../scripts/release/ci-browser-runtime.mjs", import.meta.url).href)};
const signals = ["SIGINT", "SIGTERM"];
for (const signal of signals) process.on(signal, () => {});
const before = signals.map(signal => process.listenerCount(signal));
try { process.exitCode = await runOwnedContainer(${JSON.stringify(["run", "--rm", "--name", name, "--pull", "never", PLAYWRIGHT_IMAGE])}, ${JSON.stringify(name)}, 8); }
catch (error) { process.stderr.write(error.message + "\\n"); process.exitCode = 1; }
assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
`);
  const child = spawn("bash", ["--noprofile", "--norc", "-c", 'exec "$1" "$2"', "wasalx-browser-test", process.execPath, entry], {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --redirect-warnings=${JSON.stringify(warnings)}`, PATH: `${root}${delimiter}${process.env.PATH}`, BROWSER_CASE: mode, BROWSER_STATE: statePath, BROWSER_ACTIONS: actionsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  let ready;
  const started = new Promise(done => { ready = done; });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.includes(mode === "create-pending" ? "CREATING\n" : "RUNNING\n")) ready();
  });
  child.stderr.on("data", chunk => { stderr += chunk; if ((mode === "create-pending" && stderr.includes("CREATING\n")) || (mode === "slow-cpu-inspect" && stderr.includes("CPU_INSPECTING\n"))) ready(); });
  const exited = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, endedBy) => done({ code, signal: endedBy })); });
  let duration;
  if (signal) {
    await Promise.race([started, exited.then(result => assert.fail(`lifecycle exited before ready: ${JSON.stringify(result)} ${stderr}`))]);
    const start = performance.now();
    assert(child.kill(signal));
    await exited;
    duration = performance.now() - start;
  }
  const result = await exited;
  try { assert.equal(fixtureStderr(readFileSync(warnings, "utf8")), "", "unknown Node warning from fake Docker"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const actions = readFileSync(actionsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(state.foreign, foreign, "another job's container must remain untouched");
  return { ...result, state, actions, stderr, duration, id };
}

const native = { skip: process.platform !== "linux", timeout: 15_000 };
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`Bash-entry ${signal} settles only the owned container before fixtures`, native, async t => {
    const result = await lifecycle(t, "running", signal);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.state.own, null);
    const stop = result.actions.findIndex(args => args[0] === "stop");
    const fixtures = result.actions.findIndex(args => args[0] === "ps");
    assert(stop > 0 && fixtures > stop);
    assert.equal(result.actions.filter(args => args[0] === "stop").length, 1);
    assert.equal(result.actions.at(-1)[0], "rm");
  });
}

test("attached CLI failure settles the daemon container and preserves its exit status", native, async t => {
  const result = await lifecycle(t, "cli-failure");
  assert.equal(result.code, 42, result.stderr);
  assert.equal(result.state.own, null);
  assert(result.actions.some(args => args[0] === "stop"));
});

test("successful and auto-removed containers both finish exact-owned cleanup", native, async t => {
  for (const mode of ["exit-zero-running", "stopped-retained", "auto-removed"]) {
    const result = await lifecycle(t, mode);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.state.own, null);
    assert.equal(result.actions.filter(args => args[0] === "stop").length, mode === "auto-removed" ? 0 : 1);
  }
});

test("invalid ownership and unknown daemon state fail closed without name-based cleanup", native, async t => {
  for (const mode of ["wrong-name", "wrong-image", "inspect-failure", "malformed-id", "create-failure"]) {
    const result = await lifecycle(t, mode);
    assert.equal(result.code, 1, mode);
    assert(!result.actions.some(args => ["stop", "rm", "ps"].includes(args[0])), mode);
  }
});

test("invalid created CPU metadata settles ownership before any payload starts", native, async t => {
  const result = await lifecycle(t, "invalid-cpu-metadata");
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.state.own, null);
  assert(!result.actions.some(args => args[0] === "start"));
  assert.match(result.stderr, /Docker CPU limit is unavailable/u);
});

test("SIGTERM during CPU inspection settles the created container without starting it", native, async t => {
  const result = await lifecycle(t, "slow-cpu-inspect", "SIGTERM");
  assert.equal(result.code, 143, result.stderr);
  assert.equal(result.state.own, null);
  assert(!result.actions.some(args => args[0] === "start"));
  assert(result.duration < 2_500, `CPU-inspect cancellation took ${result.duration}ms`);
});

test("cleanup failure cannot turn a successful attached CLI into success", native, async t => {
  const result = await lifecycle(t, "stop-failure");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /settlement is unverified/u);
  assert.equal(result.state.own.running, true);
});

test("SIGTERM stops the outer container before bounded slow fixture cleanup", native, async t => {
  const result = await lifecycle(t, "slow-fixtures", "SIGTERM");
  assert.equal(result.code, 143, result.stderr);
  assert.equal(result.state.own, null);
  assert.match(result.stderr, /settlement is unverified/u);
  assert(result.duration < 2_500, `SIGTERM cleanup took ${result.duration}ms`);
});

test("cancellation during create never starts or adopts a container by name", native, async t => {
  const result = await lifecycle(t, "create-pending", "SIGINT");
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.state.own.running, false);
  assert.match(result.stderr, /full container ID was captured; settlement is unverified/u);
  assert.deepEqual(result.actions.map(args => args[0]), ["create"]);
});
