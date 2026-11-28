import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNativeCompatibilityProjectEmpty, settleNativeCompatibility } from "../tests/fixtures/native-compat-cleanup.mjs";
import { ciRuntime } from "./release/ci-browser-runtime.mjs";

export const successMarker = "WASALX_RAILS_EAGER_LOAD_PASS";

export function assertRailsLoadOutput(output) {
  assert.ok(output.split(/\r?\n/u).includes(successMarker), "Actual Rails eager-load success marker is missing");
}

export async function withRailsLoadCleanup({ run, cleanup, signals = process }) {
  let controller = new AbortController(), primaryError, cleanupDeadline;
  const cancel = (signal, budget) => {
    primaryError ??= new Error(`Native Rails check cancelled by ${signal}`);
    cleanupDeadline = Math.min(cleanupDeadline ?? Infinity, Date.now() + budget);
    controller.abort(primaryError);
  };
  const interrupt = () => cancel("SIGINT", 6000), terminate = () => cancel("SIGTERM", 2000);
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", terminate);
  try {
    try { await run(controller.signal); } catch (error) { primaryError ??= error; }
    cleanupDeadline ??= Date.now() + 60_000;
    try {
      await cleanup({ primaryError, signal: () => {
        controller = new AbortController();
        return controller.signal;
      }, remaining: () => {
        const milliseconds = cleanupDeadline - Date.now();
        assert.ok(milliseconds > 0, "Native Rails cleanup deadline exceeded");
        return milliseconds;
      } });
    } catch (error) {
      if (primaryError && !error.errors?.includes(primaryError)) {
        throw new AggregateError([primaryError, error], "Native Rails check and cleanup failed");
      }
      throw error;
    }
    if (primaryError) throw primaryError;
  } finally {
    signals.off("SIGINT", interrupt);
    signals.off("SIGTERM", terminate);
  }
}

async function docker(args, signal, timeout) {
  signal.throwIfAborted();
  let child, timer, timedOut;
  // Compose spawns a CLI plugin; cancel its owned process group before settling Docker resources.
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") timedOut ??= error; }
  };
  try {
    return await new Promise((resolveCommand, reject) => {
      child = execFile("docker", args, { encoding: "utf8", detached: true, signal,
        killSignal: "SIGKILL", maxBuffer: 32 * 1024 ** 2 }, (error, stdout, stderr) => {
        if (error) kill();
        const failure = signal.aborted ? signal.reason : timedOut ?? error;
        if (failure) { failure.stdout = stdout; failure.stderr = stderr; reject(failure); }
        else resolveCommand(stdout.trim());
      });
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      timer = setTimeout(() => { timedOut = new Error("Native Rails Docker command timed out"); kill(); }, timeout);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
}

export function railsLoadModel(image, baseImage) {
  assert.match(image, /^wasalx\/rails-load:[a-f0-9-]{36}$/u);
  assert.match(baseImage, /^ghcr\.io\/zammad\/zammad@sha256:[a-f0-9]{64}$/u);
  const environment = {
    MEMCACHE_SERVERS: "zammad-memcached:11211", POSTGRESQL_DB: "zammad_production",
    POSTGRESQL_HOST: "zammad-postgresql", POSTGRESQL_USER: "zammad", POSTGRESQL_PASS: "rails-load-fixture",
    POSTGRESQL_PORT: "5432", RAILS_CHECK_PENDING_MIGRATIONS: "false", RAILS_ENV: "production",
    TMP: "/opt/zammad/tmp/wasalx", REDIS_URL: "redis://zammad-redis:6379", ELASTICSEARCH_ENABLED: "false",
    ZAMMAD_HTTP_TYPE: "http", ZAMMAD_FQDN: "rails-load.wasalx.invalid",
    WASALX_CONTROL_URL: "http://127.0.0.1:9", WASALX_PORTAL_URL: "https://portal.rails-load.wasalx.invalid",
    WASALX_TENANT_ID: "00000000-0000-4000-8000-000000000001",
    WASALX_ZAMMAD_INSTANCE_ID: "00000000-0000-4000-8000-000000000003",
    WASALX_SERVICE_JWT_SECRET: "wasalx-rails-load-synthetic-jwt-key",
  };
  const cap = (memory, cpus) => ({ mem_limit: memory, memswap_limit: memory, cpus, stop_grace_period: "1s" });
  const application = {
    image, environment, ...cap("4g", 2), user: "1000:1000", read_only: true,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    tmpfs: ["/opt/zammad/tmp:rw,size=512m,mode=2777,uid=0,gid=1000"],
    volumes: ["zammad-storage:/opt/zammad/storage", "zammad-backup:/var/tmp/zammad"],
  };
  return {
    services: {
      "zammad-postgresql": {
        image: "postgres:17.12-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73",
        ...cap("1g", 1), tmpfs: ["/var/lib/postgresql/data"],
        environment: { POSTGRES_DB: "zammad_production", POSTGRES_USER: "zammad", POSTGRES_PASSWORD: "rails-load-fixture" },
        command: ["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
        healthcheck: { test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U zammad -d zammad_production"], interval: "2s", timeout: "3s", retries: 30 },
      },
      "zammad-redis": {
        image: "redis:8.12-alpine@sha256:5af80107c1eeecb484a2269b80a26d12bfa6521787da4663bd9f19f60a163483",
        ...cap("256m", 0.5), tmpfs: ["/data"],
        healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: "2s", timeout: "3s", retries: 30 },
      },
      "zammad-memcached": {
        image: "memcached:1.6.45-alpine@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d",
        ...cap("256m", 0.5),
        healthcheck: { test: ["CMD", "nc", "-z", "127.0.0.1", "11211"], interval: "2s", timeout: "3s", retries: 30 },
      },
      "zammad-init": { ...application, image: baseImage, user: "0:0", command: ["zammad-init"] },
      "zammad-load": {
        ...application, command: ["bundle", "exec", "rails", "runner", `Rails.application.eager_load!; puts '${successMarker}'`],
      },
    },
    networks: { default: { internal: true } },
    volumes: { "zammad-storage": {}, "zammad-backup": {} },
  };
}

async function main() {
  if (ciRuntime() === "managed") {
    execFileSync("python3", ["scripts/release/ci-phase-guard.py", "--payload", "--docker-phase"], { stdio: "inherit" });
  }
  assert.equal(process.platform, "linux", "Native Rails boot runs only in the admitted Linux CI fixture");
  const uuid = randomUUID(), project = `wasalx-zammad-${uuid}`, image = `wasalx/rails-load:${uuid}`;
  const directory = await mkdtemp(join(tmpdir(), "wasalx-rails-load-"));
  const evidence = resolve("output/release-evidence/native-rails-load");
  await mkdir(evidence, { recursive: true });
  const deadline = Date.now() + 15 * 60_000;
  const command = (args, timeout = 60_000) => execFileSync("docker", args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 ** 2,
  }).trim();
  const composeArgs = (...args) => ["compose", "--project-directory", directory, "--project-name", project,
    "--file", join(directory, "compose.yaml"), ...args];
  const metadata = JSON.parse(await readFile("zammad-package/package-source.json", "utf8"));
  const manifest = JSON.parse(await readFile(`build/zammad/wasalx-${metadata.version}.manifest.json`, "utf8"));
  const dockerfile = await readFile("infra/docker/Dockerfile.zammad", "utf8");
  const baseImage = /^ARG ZAMMAD_BASE_IMAGE=(\S+)$/mu.exec(dockerfile)?.[1];
  const model = railsLoadModel(image, baseImage);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Cold boot requires a clean candidate");
  if (process.env.GITHUB_SHA) assert.equal(sourceSha, process.env.GITHUB_SHA);
  await writeFile(join(directory, "compose.yaml"), JSON.stringify(model));
  assertNativeCompatibilityProjectEmpty({ project, command });
  let imageId;
  await withRailsLoadCleanup({ run: async signal => {
    const run = args => docker(args, signal, Math.max(1, deadline - Date.now()));
    console.log("Building the verified current package-source target (no frontend asset build)");
    await run(["build", "--target", "package-source", "--file", "infra/docker/Dockerfile.zammad", "--tag", image,
      "--build-arg", `WASALX_PACKAGE_VERSION=${metadata.version}`, "--build-arg", `WASALX_PACKAGE_SHA256=${manifest.package.sha256}`, "."]);
    imageId = await run(["image", "inspect", "--format", "{{.Id}}", image]);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/u);
    await run(composeArgs("up", "--detach", "--wait", "zammad-postgresql", "zammad-redis", "zammad-memcached"));
    console.log("Initializing the isolated disposable base schema");
    const initialization = await run(composeArgs("run", "--rm", "--no-deps", "--no-TTY", "zammad-init"));
    await writeFile(join(evidence, "initialization.log"), initialization);
    console.log("Booting current production Rails and explicitly eager loading all application code");
    const output = await run(composeArgs("run", "--rm", "--no-deps", "--no-TTY", "zammad-load"));
    await writeFile(join(evidence, "rails-load.log"), output);
    assertRailsLoadOutput(output);
  }, cleanup: async ({ primaryError, remaining, signal }) => {
    const cleanupCommand = args => docker(args, signal(), remaining());
    const failures = [];
    if (primaryError) {
      try { await writeFile(join(evidence, "failure.log"),
        [primaryError.stack, primaryError.stdout, primaryError.stderr].filter(Boolean).join("\n")); }
      catch (error) { failures.push(error); }
    }
    try {
      await settleNativeCompatibility({ project, directory, runnerConnected: false,
        closeBrowser: async () => {}, closeFixture: async () => {}, command: cleanupCommand, primaryError,
        removeWorkspace: () => rm(directory, { recursive: true }),
        writeDiagnostics: value => writeFile(join(evidence, "cleanup.json"), JSON.stringify(value, null, 2)),
      });
    } catch (error) { failures.push(error); }
    try {
      const ids = await cleanupCommand(["image", "ls", "--quiet", "--filter", `reference=${image}`]);
      if (ids) await cleanupCommand(["image", "rm", image]);
      assert.equal(await cleanupCommand(["image", "ls", "--quiet", "--filter", `reference=${image}`]), "", "Owned image residue remains");
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Native Rails fixture settlement failed");
  } });
  const result = { state: "PASS", project, imageId,
    sourceSha, sourceTree, packageVersion: metadata.version, packageSha256: manifest.package.sha256, actualRailsEagerLoad: true,
    safeMode: false, ownedResourcesSettled: true, observedAt: new Date().toISOString() };
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(successMarker);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
