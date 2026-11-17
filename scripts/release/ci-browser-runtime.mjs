import {requiredOperatorInput} from "./operator-input.mjs";
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, statSync, statfsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { ciExecutionContext, validateManagedIdentity } from "./ci-execution-context.mjs";

export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";
export const ALLOWED_GATES = new Set(["visual", "browser,browser-en", "multitenant"]);
const SHA = /^[a-f0-9]{40}$/u;
const SAFE_JOB = /^[A-Za-z0-9_.-]+$/u;
const MINIMUM_FREE_BYTES = 12 * 1024 ** 3;
const PASSTHROUGH = [
  "WASALX_CI_RUNTIME", "WASALX_CI_WORKFLOW_RUNTIME", "WASALX_CI_SCOPE", "WASALX_CI_ROUTE", "WASALX_CI_SELECTOR",
  "CI", "GITHUB_ACTIONS", "GITHUB_SHA", "GITHUB_JOB", "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKSPACE", "RUNNER_OS",
  "WASALX_CANDIDATE_TREE", "WASALX_REQUIRE_VISUAL",
  "WASALX_E2E_SHARD",
  "WASALX_E2E_BASELINE_COUNTS",
  "WASALX_E2E_AGGREGATE",
];

export function ciRuntime(env = process.env) {
  const mode = env.WASALX_CI_RUNTIME ?? "native";
  const scope = env.WASALX_CI_SCOPE ?? "full";
  assert(["full", "repository-only"].includes(scope), "Unknown CI qualification scope");
  assert(["native", "managed"].includes(mode), "Unknown CI runtime");
  if (scope === "repository-only") {
    assert.equal(mode, "managed", "repository-only qualification requires managed runtime");
    assert.equal(env.GITHUB_JOB, "repository", "repository-only qualification excludes other payloads");
  }
  if (mode === "native") return mode;
  assert.equal(env.WASALX_CI_WORKFLOW_RUNTIME, scope === "repository-only" ? "managed" : "native", "managed repository identity differs from the workflow runtime selection");
  assert.equal(env.GITHUB_ACTIONS, "true");
  validateManagedIdentity(env);
  assert.equal(env.RUNNER_ENVIRONMENT, "self-hosted");
  assert(["repository", "postgres", "browser-shards", "browser", "infrastructure", "docker-smoke"].includes(env.GITHUB_JOB), "managed runtime excludes optional native and release jobs");
  assert.equal(env.WASALX_CI_CPU_TRIAL_LIVE, "false", "managed runtime excludes native qualification");
  assert(!env.WASALX_CI_APPLICATION_CPUS, "managed runtime excludes CPU trials");
  return mode;
}

export function admitManagedPayload(env = process.env, dockerPhase = false) {
  if (ciRuntime(env) === "native") return null;
  return JSON.parse(checked("python3", [fileURLToPath(new URL("./ci-phase-guard.py", import.meta.url)), "--payload", ...(dockerPhase ? ["--docker-phase"] : [])], { env }));
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command} was interrupted by ${result.signal}`);
  assert.equal(result.status, 0, `${command} failed: ${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").trim();
}

function inside(root, target, label) {
  const rel = relative(root, target);
  assert(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel), `${label} must be inside ${root}`);
}

export function validateInvocation(argv) {
  assert.equal(argv.length, 7, "Expected one exact release-evidence browser gate command");
  assert.deepEqual(argv.slice(0, 4), ["node", requiredOperatorInput("WASALX_RELEASE_EVIDENCE_SCRIPT"), "run", "--gate"]);
  assert(ALLOWED_GATES.has(argv[4]), `Unsupported isolated browser gate: ${argv[4]}`);
  assert.equal(argv[5], "--candidate-sha");
  assert.match(argv[6], SHA, "candidate SHA must be an exact lowercase Git SHA");
  return { gate: argv[4], candidateSha: argv[6] };
}

export function containerName(env) {
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/u, "GITHUB_RUN_ID is required");
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/u, "GITHUB_RUN_ATTEMPT is required");
  assert.match(env.GITHUB_JOB ?? "", SAFE_JOB, "GITHUB_JOB is required");
  const shard = env.WASALX_E2E_SHARD;
  if (shard !== undefined) assert.match(shard, /^[1-3]\/3$/u);
  return `wasalx-ci-browser-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}${shard ? `-${shard[0]}` : ""}`.slice(0, 120);
}

export function applicationCpuLimit(env, now = new Date()) {
  const trial = env.WASALX_CI_APPLICATION_CPUS;
  if (trial === undefined || trial === "") return 6;
  assert(["4", "5", "6"].includes(trial), "CPU trial accepts only 4, 5 or 6 CPUs");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "CPU trial is manual-only");
  assert.match(env.GITHUB_SHA ?? "", SHA);
  assert.equal(env.WASALX_CI_CPU_TRIAL_SHA, env.GITHUB_SHA, "CPU trial must bind the exact dispatched SHA");
  assert.equal(env.WASALX_CI_CPU_TRIAL_LIVE, "false", "CPU trial cannot qualify live release bindings");
  assert.match(env.GITHUB_REF ?? "", /^refs\/heads\/(?!main$).+/u, "CPU trial requires a non-main branch");
  const hour = now.getUTCHours();
  assert(Number.isInteger(hour) && (hour < 12 || hour >= 16), "CPU trial cannot start 12:00-16:00Z; protect the 14:00-16:00Z SSD window");
  return Number(trial);
}

export function dockerArguments({ argv, env, workspace, nodeRoot, pnpmRoot, name, dockerSocket, dockerCli, daemonNcpu, now = new Date() }) {
  assert(Number.isSafeInteger(daemonNcpu) && daemonNcpu > 0, "Docker NCPU must be a positive integer");
  const application = argv[4] === "browser,browser-en";
  const requestedCpus = application ? applicationCpuLimit(env, now) : 4;
  if (application && env.WASALX_CI_APPLICATION_CPUS) assert(daemonNcpu >= requestedCpus, "CPU trial requires the requested Docker CPU count");
  const fixtures = argv[4] === "multitenant";
  if (fixtures) {
    assert.equal(dockerSocket, `/run/user/${process.getuid()}/docker.sock`, "only the current CI user socket may cross");
    assert.equal(dockerCli, "/usr/bin/docker", "use the installed Docker CLI");
  }
  const passed = PASSTHROUGH.filter(key => env[key] !== undefined).flatMap(key => ["-e", `${key}=${env[key]}`]);
  return [
    "run", "--rm", "--init", "--name", name, "--pull", "never",
    "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", String(application ? Math.min(requestedCpus, daemonNcpu) : 4), "--memory", "8g", "--pids-limit", "1024", "--shm-size", "1g",
    "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=2g",
    "--mount", `type=bind,src=${workspace},dst=${workspace}`,
    "--mount", `type=bind,src=${nodeRoot},dst=${nodeRoot},readonly`,
    "--mount", `type=bind,src=${pnpmRoot},dst=${pnpmRoot},readonly`,
    "-e", "HOME=/tmp/wasalx-ci-browser",
    "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "-e", `PATH=${join(nodeRoot, "bin")}:${join(pnpmRoot, "node_modules", ".bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", `GIT_CONFIG_VALUE_0=${workspace}`,
    "-e", "WASALX_CI_BROWSER_INSIDE=1",
    ...(fixtures ? [
      "--mount", `type=bind,src=${dockerSocket},dst=${dockerSocket}`,
      "--mount", `type=bind,src=${dockerCli},dst=${dockerCli},readonly`,
      "-e", `DOCKER_HOST=unix://${dockerSocket}`,
      "-e", `WASALX_CI_FIXTURE_NETWORK=${name}`,
    ] : []),
    ...passed,
    "--workdir", workspace, "--entrypoint", process.execPath, PLAYWRIGHT_IMAGE,
    join(workspace, "scripts", "release", "ci-browser-runtime.mjs"), "--inside", ...argv,
  ];
}

export function cpuSnapshot(root = "/sys/fs/cgroup") {
  const read = name => {
    try { return readFileSync(join(root, name), "utf8").trim(); } catch { return undefined; }
  };
  const limit = read("cpu.max");
  const rows = new Map((read("cpu.stat") ?? "").split("\n").map(line => line.trim().split(/\s+/u)));
  const counter = key => /^\d+$/u.test(rows.get(key) ?? "") && Number.isSafeInteger(Number(rows.get(key))) ? Number(rows.get(key)) : null;
  return {
    cpuMax: /^(?:max|[1-9][0-9]*) [1-9][0-9]*$/u.test(limit ?? "") ? limit : null,
    usageUsec: counter("usage_usec"), periods: counter("nr_periods"),
    throttledPeriods: counter("nr_throttled"), throttledUsec: counter("throttled_usec"),
  };
}

function cpuEvidence(phase, values) {
  process.stdout.write(`Browser CPU evidence ${JSON.stringify({ phase, at: new Date().toISOString(), ...values })}\n`);
}

async function loopbackPreflight() {
  assert.equal(process.version, "v22.23.4", "isolated browser gate requires the qualified Node runtime");
  assert.equal(checked("pnpm", ["--version"]), "11.16.0", "isolated browser gate requires the packageManager pnpm version");
  const require = createRequire(join(process.cwd(), "package.json"));
  assert.equal(require("@playwright/test/package.json").version, "1.62.1", "Playwright package version changed");
  const { chromium } = await import("@playwright/test");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("wasalx-loopback-ready");
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  let browser;
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load", timeout: 15_000 });
    assert.equal(await page.textContent("body"), "wasalx-loopback-ready");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
}

async function runInside(argv, env) {
  assert.equal(env.WASALX_CI_BROWSER_INSIDE, "1", "inside mode is container-only");
  validateInvocation(argv);
  const startedAt = performance.now();
  const shard = env.WASALX_E2E_SHARD ?? null;
  cpuEvidence("start", { shard, ...cpuSnapshot() });
  let result;
  try {
    await loopbackPreflight();
    const child = spawn(process.execPath, argv.slice(1), { stdio: "inherit", env });
    result = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
  } finally {
    cpuEvidence("exit", { shard, wallTimeMs: Math.max(0, Math.round(performance.now() - startedAt)), ...cpuSnapshot() });
  }
  if (result.signal) process.kill(process.pid, result.signal);
  return result.code ?? 1;
}

export function rootlessDataRoot(info) {
  assert(info.SecurityOptions?.includes("name=rootless"), "browser isolation requires the dedicated rootless Docker daemon");
  assert(isAbsolute(info.DockerRootDir ?? ""), "rootless Docker data root must be absolute");
  return resolve(info.DockerRootDir);
}

export function admitCloudBrowser(env, info) {
  if (env.WASALX_CI_ROUTE !== "cloud") return;
  const context = ciExecutionContext(env);
  assert(["browser", "browser-shards"].includes(context.job), "Cloud browser daemon probe belongs to another job");
  rootlessDataRoot(info);
  assert(Number.isSafeInteger(info.NCPU) && info.NCPU >= 6 && Number.isSafeInteger(info.MemTotal)
    && info.MemTotal >= 15 * 1024 ** 3, "Cloud browser daemon probe requires a 6 CPU / 16 GiB VM");
}

function rootlessDocker() {
  const info = JSON.parse(checked("docker", ["info", "--format", "{{json .}}"]));
  assert(Number.isSafeInteger(info.NCPU) && info.NCPU > 0, "Docker NCPU must be a positive integer");
  return { dockerRootDir: rootlessDataRoot(info), daemonNcpu: info.NCPU, info };
}

function inspectImage() {
  const result = spawnSync("docker", ["image", "inspect", PLAYWRIGHT_IMAGE], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  const image = JSON.parse(result.stdout)[0];
  assert(image && image.Os === "linux" && image.Architecture === "amd64", "unexpected Playwright image platform");
  assert(image.RepoDigests?.includes(PLAYWRIGHT_IMAGE), "Playwright image digest is not locally admitted");
  return image;
}

function baseAdmission(env) {
  admitManagedPayload(env, true);
  assert.equal(process.platform, "linux", "isolated browser gates run only on the Linux quality runner");
  assert.equal(process.version, "v22.23.4", "quality runner Node version changed");
  assert.equal(env.GITHUB_ACTIONS, "true", "isolated browser runtime is CI-only");
  assert.equal(env.RUNNER_OS, "Linux", "isolated browser runtime requires the Linux runner");
  const workspace = resolve(checked("git", ["rev-parse", "--show-toplevel"]));
  assert.equal(resolve(env.GITHUB_WORKSPACE ?? ""), workspace, "GITHUB_WORKSPACE must be the exact checkout root");
  const { dockerRootDir, daemonNcpu, info } = rootlessDocker();
  admitCloudBrowser(env, info);
  const nodeRoot = dirname(dirname(process.execPath));
  const pnpmHome = resolve(env.PNPM_HOME ?? "");
  assert.equal(basename(pnpmHome), ".bin", "PNPM_HOME must be the setup-pnpm binary directory");
  assert.equal(basename(dirname(pnpmHome)), "node_modules", "PNPM_HOME layout changed");
  const pnpmRoot = dirname(dirname(pnpmHome));
  inside(nodeRoot, process.execPath, "Node executable");
  const pnpm = join(pnpmHome, "pnpm");
  inside(pnpmRoot, pnpm, "pnpm executable");
  accessSync(process.execPath, constants.X_OK);
  accessSync(pnpm, constants.X_OK);
  assert.equal(checked(pnpm, ["--version"]), "11.16.0", "quality runner pnpm version changed");
  return { workspace, nodeRoot, pnpmRoot, dockerRootDir, daemonNcpu };
}

function prepare(env) {
  const { dockerRootDir } = baseAdmission(env);
  const disk = statfsSync(dockerRootDir);
  assert(disk.bavail * disk.bsize >= MINIMUM_FREE_BYTES, "insufficient free disk for isolated browser gates");
  assert(inspectImage(), "preload the pinned Playwright image before isolated browser gates");
  return 0;
}

function removeOwnedFixtures(name, remaining) {
  const options = () => ({ timeout: remaining(), killSignal: "SIGKILL" });
  const ids = checked("docker", ["ps", "--all", "--quiet", "--filter", `label=io.wasalx.ci-browser-owner=${name}`], options());
  if (!ids) return;
  const owned = ids.split(/\s+/u);
  assert(owned.every(id => /^[a-f0-9]{12,64}$/u.test(id)), "invalid owned fixture IDs");
  checked("docker", ["rm", "--force", ...owned], options());
}

function settleOwnedContainer(id, name, budget) {
  const deadline = performance.now() + budget;
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    assert(milliseconds > 0, "browser cleanup deadline expired; settlement is unverified");
    return milliseconds;
  };
  const docker = args => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: remaining(), killSignal: "SIGKILL" });
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `docker cleanup was interrupted by ${result.signal}`);
    if (result.status === 1 && !(result.stdout ?? "").trim()
      && new RegExp(`^Error(?: response from daemon)?: No such (?:object|container): ${id}$`, "u").test((result.stderr ?? "").trim())) return null;
    assert.equal(result.status, 0, `docker cleanup failed: ${(result.stderr ?? "").trim()}`);
    return (result.stdout ?? "").trim();
  };
  const inspect = () => {
    const output = docker(["inspect", "--type", "container", "--format", "[{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json .State.Running}}]", id]);
    if (output === null) return null;
    const state = JSON.parse(output);
    assert.deepEqual(state.slice(0, 3), [id, `/${name}`, PLAYWRIGHT_IMAGE], "owned browser container identity changed");
    assert.equal(typeof state[3], "boolean", "invalid owned browser running state");
    return state[3];
  };
  // Stop the exact outer container before fixtures, within Actions' signal grace.
  let running = inspect();
  if (running === true) {
    docker(["stop", "--time", "1", id]);
    running = inspect();
  }
  assert.notEqual(running, true, "owned browser container is still running");
  if (running === false) {
    docker(["rm", id]);
    assert.equal(inspect(), null, "owned browser container removal is unverified");
  }
  removeOwnedFixtures(name, remaining);
}

export async function runOwnedContainer(args, name, daemonNcpu, requestedCpus = 4) {
  assert.equal(args[0], "run");
  let child;
  let id;
  let cancelled;
  let cleaned = false;
  let cleanupError;
  const cleanup = () => {
    if (!id || cleaned) return;
    cleaned = true;
    try { settleOwnedContainer(id, name, cancelled === "SIGTERM" ? 2_000 : 6_000); }
    catch (error) {
      cleanupError = error;
      process.stderr.write(`Browser cleanup failed; settlement is unverified: ${error.message}\n`);
    }
  };
  const cancel = signal => {
    cancelled ??= signal;
    cleanup();
    // This is only our CLI; the daemon container has its own verified cleanup.
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  let result;
  let failure;
  try {
    // Obtain immutable ownership before any container can start running.
    let output = "";
    child = spawn("docker", ["create", ...args.slice(1)], { stdio: ["ignore", "pipe", "inherit"], timeout: 10_000, killSignal: "SIGKILL" });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 256) child.kill("SIGKILL");
    });
    const created = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
    if (/^[a-f0-9]{64}$/u.test(output.trim())) id = output.trim();
    if (!cancelled) {
      assert.deepEqual(created, { code: 0, signal: null }, "docker create failed");
      assert(id, "docker create did not return a full container ID");
      let cpuOutput = "";
      child = spawn("docker", ["inspect", "--type", "container", "--format", "{{json .HostConfig.NanoCpus}}", id], { stdio: ["ignore", "pipe", "inherit"], timeout: 5_000, killSignal: "SIGKILL" });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        cpuOutput += chunk;
        if (cpuOutput.length > 64) child.kill("SIGKILL");
      });
      const inspected = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
      if (!cancelled) {
        assert.deepEqual(inspected, { code: 0, signal: null }, "Docker CPU inspection failed");
        const nanoCpus = Number(cpuOutput.trim());
        assert(Number.isSafeInteger(nanoCpus) && nanoCpus > 0, "Docker CPU limit is unavailable");
        const userRoot = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice`;
        cpuEvidence("created", {
          containerId: id, daemonNcpu, requestedCpus, shard: process.env.WASALX_E2E_SHARD ?? null, nanoCpus,
          rootlessUser: cpuSnapshot(userRoot),
          daemonService: cpuSnapshot(join(userRoot, `user@${process.getuid()}.service`, "app.slice", "docker.service")),
        });
        if (!cancelled) {
          child = spawn("docker", ["start", "--attach", id], { stdio: "inherit" });
          result = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
        }
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (cancelled && !id) process.stderr.write(`Browser creation cancelled before its full container ID was captured; settlement is unverified for ${name}. No container was started by this caller.\n`);
    cleanup();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  if (cancelled) return cancelled === "SIGINT" ? 130 : 143;
  if (failure) throw failure;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.code === 0 && cleanupError) throw cleanupError;
  return result.code ?? 1;
}

async function preflight(env) {
  const { workspace, nodeRoot, pnpmRoot, daemonNcpu } = baseAdmission(env);
  assert(inspectImage(), "Run --prepare before the isolated browser preflight");
  const name = `${containerName(env)}-preflight`.slice(0, 120);
  const args = dockerArguments({ argv: [], env, workspace, nodeRoot, pnpmRoot, name, daemonNcpu });
  args[args.length - 1] = "--inside-preflight";
  return runOwnedContainer(args, name, daemonNcpu, 4);
}

async function runOuter(argv, env) {
  const { candidateSha } = validateInvocation(argv);
  assert.equal(env.GITHUB_SHA, candidateSha, "gate candidate must equal GITHUB_SHA");
  if (env.WASALX_CANDIDATE_TREE !== undefined) assert.match(env.WASALX_CANDIDATE_TREE, SHA);
  const { workspace, nodeRoot, pnpmRoot, daemonNcpu } = baseAdmission(env);
  assert.equal(checked("git", ["rev-parse", "HEAD"]), candidateSha, "checkout HEAD differs from the requested candidate");
  if (env.WASALX_CANDIDATE_TREE) assert.equal(checked("git", ["rev-parse", "HEAD^{tree}"]), env.WASALX_CANDIDATE_TREE);
  assert(inspectImage(), "Run --prepare before isolated browser gates");

  const name = containerName(env);
  let dockerSocket;
  if (argv[4] === "multitenant") {
    dockerSocket = `/run/user/${process.getuid()}/docker.sock`;
    const socket = statSync(dockerSocket);
    assert(socket.isSocket() && socket.uid === process.getuid(), "CI Docker socket owner/type changed");
    const endpoint = env.DOCKER_HOST ?? checked("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    assert.equal(endpoint, `unix://${dockerSocket}`, "multitenant gate requires the dedicated current-user Docker socket");
  }
  const args = dockerArguments({ argv, env, workspace, nodeRoot, pnpmRoot, name, dockerSocket, dockerCli: "/usr/bin/docker", daemonNcpu });
  const requestedCpus = argv[4] === "browser,browser-en" ? applicationCpuLimit(env) : 4;
  return runOwnedContainer(args, name, daemonNcpu, requestedCpus);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === "--cpu-trial-preflight") {
    applicationCpuLimit(env);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--prepare") return prepare(env);
  if (argv.length === 1 && argv[0] === "--preflight") return preflight(env);
  if (argv.length === 1 && argv[0] === "--inside-preflight") {
    assert.equal(env.WASALX_CI_BROWSER_INSIDE, "1", "inside preflight is container-only");
    await loopbackPreflight();
    return 0;
  }
  return argv[0] === "--inside" ? runInside(argv.slice(1), env) : runOuter(argv, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
