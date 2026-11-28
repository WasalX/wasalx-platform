import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { wasalxTimeZone } from "../packages/core/src/display-time-zone.ts";

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
const bash = process.platform === "win32"
  ? [process.env.BASH, process.env.GIT_BASH, process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"), "bash"]
    .filter((candidate): candidate is string => Boolean(candidate)).find(existsSync) ?? "bash"
  : "bash";

test("foundation-postgres uses the reviewed PostgreSQL 18 base digest", async () => {
  const dockerfile = await read("Dockerfile.foundation-postgres");
  // This digest ships PostgreSQL 18.7. The image build checks the server version.
  assert.deepEqual(dockerfile.match(/^[ \t]*FROM\b.*$/gimu), [
    "FROM cgr.dev/chainguard/postgres:latest@sha256:9cc085289d7ef0174f35f2ff1e514624c3305c4a26215d8e89e3e277e3377d03",
  ]);
});

test("CI and Zammad fixture image pins match Compose", async () => {
  const { services } = parseYaml(await read("compose.yaml"));
  const { services: full } = parseYaml(await read("compose.full.yaml"), { merge: true, logLevel: "error" });
  const integration = [services.postgres.image, services.redis.image];
  const zammad = [
    full["zammad-postgresql"].image,
    full["zammad-redis"].image,
    full["zammad-memcached"].image,
  ];
  const expected = {
    ".github/workflows/ci.yml": integration,
    "scripts/release/ci-postgres-runtime.sh": [services.postgres.image],
    "tests/multitenant-e2e.test.mjs": integration,
    "scripts/check-zammad-rails-load.mjs": zammad,
    "tests/zammad-image-browser-compat.test.mjs": zammad,
    "scripts/release/installer-dev-simulator.compose.yaml": [full["keycloak-bootstrap"].image],
  };
  const imageRef = /(?:^|[\s="'\x60])((?:postgres|redis|memcached|node):\d[\w.-]*(?:@sha256:[a-f0-9]+)?)(?=[\s"',;\x60]|$)/gmu;
  for (const [path, images] of Object.entries(expected)) {
    const pins = Array.from((await read(path)).matchAll(imageRef), ([, pin]) => pin);
    assert.deepEqual(pins.sort(), [...images].sort(), path);
  }
});

test("production ingress defaults to the chart services and still honors an operator allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasalx-ingress-"));
  try {
    const fragment = join(dir, "ingress.json");
    const script = fileURLToPath(new URL("../scripts/release/render-production-ingress.mjs", import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WASALX_INGRESS_FRAGMENT: pathToFileURL(fragment).href,
      WASALX_INGRESS_ROUTER_HOST: "router.example.test",
    };
    delete env.WASALX_INGRESS_SERVICE_HOSTS;
    const run = async (hosts: string[], name: string) => {
      const output = join(dir, `${name}.json`);
      await writeFile(fragment, JSON.stringify({ ingress: hosts.map(host => ({ service: `http://${host}:3000` })) }));
      return {
        output,
        result: spawnSync(process.execPath, [script, "fixture", output], { env, encoding: "utf8", windowsHide: true }),
      };
    };
    const defaults = ["wasalx-api", "wasalx-keycloak", "wasalx-portal"];
    const accepted = await run(defaults, "default");
    assert.equal(accepted.result.status, 0, accepted.result.stderr);
    const rendered = JSON.parse(await readFile(accepted.output, "utf8"));
    assert.deepEqual(rendered.config.ingress, defaults.map(host => ({ service: `http://${host}.fixture.svc.cluster.local:3000` })));

    const rejected = await run(["custom-service"], "rejected");
    assert.equal(rejected.result.status, 1);
    assert.match(rejected.result.stderr, /Unexpected application ingress service/u);
    env.WASALX_INGRESS_SERVICE_HOSTS = "custom-service";
    const overridden = await run(["custom-service"], "override");
    assert.equal(overridden.result.status, 0, overridden.result.stderr);
    const replaced = await run([defaults[0]], "replaced");
    assert.equal(replaced.result.status, 1);
    assert.match(replaced.result.stderr, /Unexpected application ingress service/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});



test("control API image includes the shared domain matcher dependency", async () => {
  const dockerfile = await read("Dockerfile.control-api");
  assert.match(dockerfile, /COPY lib\/domain\.ts lib\/literal-matcher\.ts \.\/lib\//);
  assert.match(await read("scripts/test-unit.mjs"), /"tests\/literal-matcher\.test\.ts"/);
});

test("release assets use one bounded mirror attempt and reject corrupt bytes before fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-tool-fetch-quote'-"));
  const posix = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`) : value;
  try {
    const fixture = join(directory, "fixture");
    await writeFile(fixture, "verified release asset\n");
    const expected = createHash("sha256").update(await readFile(fixture)).digest("hex");
    const helper = posix(fileURLToPath(new URL("../scripts/release/fetch-verified-asset.sh", import.meta.url)));
    const upstream = "https://github.com/example/tool/releases/download/v1/tool.tar.gz";
    for (const scenario of ["hit", "dns", "trailing-slash", "miss", "timeout", "redirect-301", "redirect-302", "redirect-307", "redirect-308", "corrupt-mirror", "corrupt-origin", "both-down", "bad-pin"]) {
      const mirror = scenario === "dns" ? "https://mirror.example-1.test:65535" : `http://192.0.2.1:3143${scenario === "trailing-slash" ? "/" : ""}`;
      const output = join(directory, `${scenario}.archive`), trace = join(directory, `${scenario}.trace`);
      await writeFile(output, "previous verified file");
      const program = `curl() {
        local output="" url="\${!#}" proto="" redirs="" location=no writeout=""
        printf '%s\\n' "$url" >> "$FETCH_TRACE"
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --output) output="$2"; shift ;;
            --proto) proto="$2"; shift ;;
            --max-redirs) redirs="$2"; shift ;;
            --location) location=yes ;;
            --write-out) writeout="$2"; shift ;;
          esac
          shift
        done
        if [[ "$url" != "$FETCH_URL" ]]; then
          [[ "$proto" == '=http,https' && "$redirs" == 0 && "$location" == no && "$writeout" == '%{http_code}' ]] || return 99
          [[ "$FETCH_CASE" != miss && "$FETCH_CASE" != corrupt-origin && "$FETCH_CASE" != both-down ]] || return 22
          [[ "$FETCH_CASE" != timeout ]] || return 28
          if [[ "$FETCH_CASE" == redirect-* ]]; then
            cp "$FETCH_FIXTURE" "$output"
            printf '%s' "\${FETCH_CASE#redirect-}"
            return 0
          fi
        else
          [[ "$proto" == '=https' && "$location" == yes ]] || return 99
          [[ "$FETCH_CASE" != both-down ]] || return 7
        fi
        if [[ "$FETCH_CASE" == corrupt-mirror || "$FETCH_CASE" == corrupt-origin ]]; then printf corrupt > "$output";
        else cp "$FETCH_FIXTURE" "$output"; fi
        [[ "$url" == "$FETCH_URL" ]] || printf 200
      }
      export -f curl
      bash "$FETCH_HELPER" "$FETCH_URL" "$FETCH_OUTPUT" "$FETCH_PIN"`;
      const result = spawnSync(bash, ["--noprofile", "--norc", "-c", program], {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, BIN_MIRROR_BASE: mirror, FETCH_CASE: scenario, FETCH_TRACE: posix(trace), FETCH_FIXTURE: posix(fixture),
          FETCH_HELPER: helper, FETCH_URL: upstream, FETCH_OUTPUT: posix(output), FETCH_PIN: scenario === "bad-pin" ? "invalid" : expected },
      });
      const success = ["hit", "dns", "trailing-slash", "miss", "timeout"].includes(scenario) || scenario.startsWith("redirect-");
      assert.equal(result.status, success ? 0 : scenario === "both-down" ? 1 : 2, `${scenario}: ${result.stderr}`);
      assert.equal(await readFile(output, "utf8"), success ? "verified release asset\n" : "previous verified file");
      const calls = scenario === "bad-pin" ? [] : (await readFile(trace, "utf8")).trim().split("\n");
      assert.deepEqual(calls, scenario === "bad-pin" ? [] : [`${mirror.replace(/\/$/u, "")}/github.com/example/tool/releases/download/v1/tool.tar.gz`, ...(["miss", "timeout", "corrupt-origin", "both-down"].includes(scenario) || scenario.startsWith("redirect-") ? [upstream] : [])]);
    }
    assert(!(await readdir(directory)).some(name => name.includes(".pending.")), "partial downloads must be removed");
    const source = await read("scripts/release/fetch-verified-asset.sh");
    assert.match(source, /--retry 0[\s\S]*--connect-timeout 3 --max-time 8/u);
    assert.match(source, /--proto '=https' --proto-redir '=https'[\s\S]*--retry-max-time 120/u);
    assert.doesNotMatch(source, /--retry-all-errors/u);
    const infra = await read("scripts/validate-infra.sh");
    const prepare = infra.split("prepare_verified_archive() {")[1].split("prepare_pinned_provider() {")[0];
    assert(prepare.indexOf('"$checksum_url"') < prepare.indexOf("fetch-verified-asset.sh"), "Helm/Tofu metadata must come directly from upstream before mirror bytes");
    assert.doesNotMatch(infra, /TOFU_CONTAINER|archive_status/, "archive failures cannot fall back to Docker");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("release assets reject invalid mirror origins before any network or output change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-tool-mirror-format-"));
  const posix = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`) : value;
  try {
    const invalid = [
      "ftp://mirror.test", "file:///tmp/mirror", "http://", "http:///mirror.test", "http://mirror.test//", "http://mirror.test/prefix",
      "https://fixture:placeholder@api.example.test/path", "http://mirror.test?token=secret", "http://mirror.test/#fragment", "http://mirror.test\\evil",
      "http://mirror.test:0", "http://mirror.test:65536", "http://mirror.test:999999", "http://mirror.test:", "http://mirror.test:abc",
      "http://mirror.test:https://other.test", "http://mirror..test", "http://-mirror.test", "http://mirror-.test", "http://mirror.test.",
      "http://256.0.0.1", "http://127.1", "http://01.2.3.4", "http://[::1]", "http://[::1]:3143",
      " http://mirror.test", "http://mirror.test ", "http://mirror.test\n", "http://mirror.test\t", "http://mirror.test\x7f",
      `http://${"a".repeat(64)}.test`, `http://${Array(5).fill("a".repeat(51)).join(".")}`,
    ];
    const output = join(directory, "output"), trace = join(directory, "trace");
    await writeFile(output, "previous verified file");
    await writeFile(trace, "");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", `curl() { printf network >> "$FETCH_TRACE"; }
      export -f curl
      for ((index=0; index<FETCH_COUNT; index++)); do
        key="FETCH_BASE_$index"
        BIN_MIRROR_BASE="\${!key}" bash "$FETCH_HELPER" https://github.com/example/tool "$FETCH_OUTPUT" "$FETCH_PIN" 2>/dev/null
        printf '%s\\n' "$?"
      done`], {
      encoding: "utf8", timeout: 60_000, windowsHide: true,
      env: { ...process.env, FETCH_COUNT: String(invalid.length), ...Object.fromEntries(invalid.map((base, index) => [`FETCH_BASE_${index}`, base])),
        FETCH_HELPER: posix(fileURLToPath(new URL("../scripts/release/fetch-verified-asset.sh", import.meta.url))),
        FETCH_OUTPUT: posix(output), FETCH_TRACE: posix(trace), FETCH_PIN: "0".repeat(64) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), invalid.map(() => "2"));
    assert.equal(await readFile(trace, "utf8"), "", "invalid mirror configuration must not call curl");
    assert.equal(await readFile(output, "utf8"), "previous verified file");
    assert(!(await readdir(directory)).some(name => name.includes(".pending.")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("infrastructure validation keeps Docker on fullruntime and pins native cloud tools in source", async () => {
  const script = await read("scripts/validate-infra.sh");
  assert.match(script, /\.wasalx-infra-tool-cache/);
  assert.match(script, /cached infrastructure tool failed checksum verification/);
  assert.match(script, /--retry 3 --retry-delay 2 --retry-max-time 120/u);
  assert.doesNotMatch(script, /--retry-all-errors/u);
  assert.match(script, /NATIVE_INFRA=false/);
  assert.match(script, /\bdocker\s+run/);
  assert.match(script, /TOFU_IMAGE="ghcr\.io\/opentofu\/opentofu@sha256:[0-9a-f]{64}"/);
  assert.match(script, /TOFU_VERSION="1\.12\.1"/);
  assert.match(script, /PROMTOOL_VERSION="3\.13\.1"/);
  assert.match(script, /HELM_VERSION="4\.2\.0"/);
  assert.match(script, /prometheus\/prometheus\/releases\/download\/v\$\{PROMTOOL_VERSION\}\/sha256sums\.txt/);
  assert.match(script, /tofu_\$\{TOFU_VERSION\}_SHA256SUMS/);
  assert.match(script, /get\.helm\.sh\/\$\{HELM_ARCHIVE\}\.sha256sum/);
  assert.match(script, /"\$PROMTOOL" test rules tests\.yaml/);
  assert.match(script, /ci-phase-guard\.py --payload ;;/);
  assert.match(script, /missing infrastructure prerequisite: %s/);
  assert.match(script, /-lockfile=readonly/);
  assert.match(script, /provider-mirror\/registry\.opentofu\.org\/hashicorp/);
  assert.match(script, /filesystem_mirror/);
  assert.match(script, /github\.com\/opentofu\/terraform-provider-/);
  assert.match(script, /WASALX_GITHUB_RELEASE_PROXY/);
  for (const platform of [
    /Darwin:arm64[\s\S]*TOOL_OS="darwin"[\s\S]*TOOL_ARCH="arm64"/,
    /Linux:x86_64[\s\S]*TOOL_OS="linux"[\s\S]*TOOL_ARCH="amd64"/,
    /Linux:aarch64 \| Linux:arm64[\s\S]*TOOL_OS="linux"[\s\S]*TOOL_ARCH="arm64"/,
    /unsupported infrastructure validation platform/,
  ]) assert.match(script, platform);
  for (const checksum of [
    "620fd5d0fbc2d7a24ac6b420a4922e6093020358162a62fa8cbd37b2bac1d22e",
    "2d0a5babfa73604b3fefc9dab9c87f91c77fce756c2e32b294e9f1290aed26c0",
    "96eecc9f94938a0bc35b8a63d2c4a5f972395e44206620db06760b730d0471fc",
    "6512e2ab9f2fa31cbb90d9249647b5c5798f62eb1215ec44da2cdaa24e38ad25",
    "5082f98fcb3389c73339365f7df39fc6912bf2bd1a46d5f97778f441a67fd337",
    "c5c8575c4458835c2acbc3d1ed5570589b14baa2525d8fbd04295c097caf41eb",
    "28d1f1224b2a22f84c801487fad4b3bd58f94a8cb58cf9340557e787030c9703",
    "962b812371aff838d152b6ff2d56fdb7a6396f5542f48ebf73421b9721f0d103",
    "fbd8e5e0f6ad2e7d053e717739186caee4fd0cab2cf9335bfc86c292fe2a2bfe",
    "06cff265b39c437ba81f91cfa85ae91b6ae28d3112bb2273294431a3f54e8bf5",
    "1fc9af962e3632b7cd0ba27076cd9f1ced177567defe9e331ac37f5a40468575",
    "1a53dd57697dc04d243ddb81a0f70e44ab83c256f15dde173e5538120dc6a0bb",
  ]) assert.match(script, new RegExp(checksum));
  assert.match(script, /HELM_ARCHIVE="helm-v\$\{HELM_VERSION\}-\$\{HELM_TARGET\}\.tar\.gz"/);
  assert.match(script, /TOFU_ARCHIVE="tofu_\$\{TOFU_VERSION\}_\$\{HOST_PROVIDER_TARGET\}\.zip"/);
  assert.match(script, /prepare_pinned_archive/);
});

test("infrastructure validation routes runner-example fullruntime away from native tools", async () => {
  const script = await read("scripts/validate-infra.sh");
  const routing = script.match(/NATIVE_INFRA=false\nif \[\[ [\s\S]*?\nfi/u)?.[0];
  assert.ok(routing, "validate-infra.sh must define the managed cloud native route");
  for (const [runtime, route, expected] of [
    ["managed", "cloud", "true"],
    ["managed", "fullruntime", "false"],
    ["native", "fullruntime", "false"],
    ["native", "cloud", "false"],
  ] as const) {
    const result: SpawnSyncReturns<string> = spawnSync(bash, ["--noprofile", "--norc", "-c", `${routing}\nprintf '%s\\n' "$NATIVE_INFRA"`], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, WASALX_CI_RUNTIME: runtime, WASALX_CI_ROUTE: route },
    });
    assert.equal(result.status, 0, `${runtime}/${route}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), expected, `${runtime}/${route} selected the wrong infrastructure tool mode`);
  }
});

test("infrastructure validation rejects a tampered cache-hit archive before copying it", async () => {
  const script = await read("scripts/validate-infra.sh");
  const start = script.indexOf("prepare_pinned_archive() {");
  const end = script.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end >= 0, "validate-infra.sh must define prepare_pinned_archive");
  const prepare = script.slice(start, end + 2);
  const root = await mkdtemp(join(tmpdir(), "wasalx-infra-cache-hit-"));
  const cache = await mkdtemp(join(root, "cache-"));
  const tools = await mkdtemp(join(root, "tools-"));
  const posix = (value: string) => process.platform === "win32"
    ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    : value;
  const filename = "tool.tar.gz";
  const expected = createHash("sha256").update("pinned bytes\n").digest("hex");
  const archive = join(cache, filename);
  const checksum = join(cache, `${filename}.sha256`);
  const trace = join(root, "curl.trace");
  try {
    await writeFile(archive, "tampered bytes\n");
    await writeFile(checksum, `${expected}  ${filename}\n`);
    await writeFile(trace, "");
    const program = `set -u
CACHE_DIR="$CACHE_DIR"
TOOLS_DIR="$TOOLS_DIR"
workspace_root="$WORKSPACE_ROOT"
curl() { printf 'network\\n' >> "$CURL_TRACE"; return 99; }
${prepare}
set +e
prepare_pinned_archive archive-url checksum-url "$FILENAME" "$EXPECTED"
status=$?
set -e
printf 'status=%s\\n' "$status"
exit "$status"`;
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", program], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        CACHE_DIR: posix(cache),
        TOOLS_DIR: posix(tools),
        WORKSPACE_ROOT: posix(fileURLToPath(new URL("..", import.meta.url))),
        CURL_TRACE: posix(trace),
        FILENAME: filename,
        EXPECTED: expected,
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(trace, "utf8"), "", "a cache hit must not fetch from the network");
    assert.equal(existsSync(archive), false, "a rejected cache entry must be removed");
    assert.equal(existsSync(checksum), false, "a rejected cache checksum must be removed");
    assert.equal(existsSync(join(tools, filename)), false, "a rejected archive must not reach TOOLS_DIR");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native promtool preserves its pinned version and the public alert fixture seal", async () => {
  const script = await read("scripts/validate-infra.sh");
  const compose = await read("compose.full.yaml");
  const version = script.match(/^PROMTOOL_VERSION="([^"]+)"/m)![1];
  assert(compose.includes(`prom/prometheus:v${version}@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893`));
  const fixture = (await read("tests/fixtures/production-backup-alerts.yaml")).replaceAll("\r\n", "\n");
  const c1Fixture = fixture.replace(/^- (rules\.yaml|application-rules\.yaml)$/gm, "- /checks/$1");
  assert.equal(createHash("sha256").update(c1Fixture).digest("hex"), "38196eee96e3b7fe5a81477515b1c12e9c6eb200be90a84581817a08c65b16bc");
});

type ComposeEnvironment = Record<string, string | number | boolean | null>;

async function readComposeEnvironments(file: string): Promise<Record<string, ComposeEnvironment>> {
  // Compose's !override tags in these files apply to fields outside environment.
  const { services } = parseYaml(await read(file), { merge: true, logLevel: "error" });
  return Object.fromEntries(Object.entries(services).map(([name, service]) => {
    const environment = (service as { environment?: ComposeEnvironment | string[] }).environment;
    return [name, Array.isArray(environment) ? Object.fromEntries(environment.map((entry) => {
      const equals = entry.indexOf("=");
      return equals === -1 ? [entry, null] : [entry.slice(0, equals), entry.slice(equals + 1)];
    })) : environment ?? {}];
  }));
}

test("Compose services only set TZ to UTC", async () => {
  const files = ["compose.yaml", "compose.full.yaml", "compose.smoke.yaml"];
  for (const file of files) {
    const services = await readComposeEnvironments(file);
    const nonUtc = Object.entries(services)
      .filter(([, environment]) => Object.hasOwn(environment, "TZ") && environment.TZ !== "UTC")
      .map(([service]) => service);
    assert.deepEqual(nonUtc, [], file);
  }
});

test("full Compose Zammad backup starts outside the nightly install window", async () => {
  const [full, source] = await Promise.all([
    readComposeEnvironments("compose.full.yaml"), read(".github/workflows/nightly-install.yml"),
  ]);
  const backup = full["zammad-backup"];
  assert.equal(backup.TZ, "UTC");
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(String(backup.BACKUP_TIME));
  assert.ok(time, "expected a UTC backup time in HH:MM format");
  const backupMinute = Number(time[1]) * 60 + Number(time[2]);

  const workflow = parseYaml(source);
  const duration = workflow.jobs["nightly-install"]["timeout-minutes"];
  assert.ok(Number.isInteger(duration) && duration > 0, "expected a nightly install job timeout");
  for (const { cron, timezone } of workflow.on.schedule) {
    assert.equal(timezone ?? "UTC", "UTC");
    const start = /^([0-5]?\d) ([01]?\d|2[0-3]) \* \* \*$/u.exec(cron);
    assert.ok(start, "expected a daily nightly install schedule");
    const startMinute = Number(start[2]) * 60 + Number(start[1]);
    const minutesPerDay = 24 * 60;
    const minutesAfterStart = (backupMinute - startMinute + minutesPerDay) % minutesPerDay;
    assert.ok(minutesAfterStart >= duration, `backup ${backup.BACKUP_TIME} overlaps nightly install (${cron}, ${duration} minutes)`);
  }
});

test("full Compose supplies the default Zammad display time zone", async () => {
  const full = await readComposeEnvironments("compose.full.yaml");
  const timeZone = full["zammad-runtime-bootstrap"].WASALX_ZAMMAD_DISPLAY_TIMEZONE;
  assert.equal(timeZone, `\${WASALX_FULL_ZAMMAD_DISPLAY_TIMEZONE:-${wasalxTimeZone}}`);
  assert.equal(full["tenant-workspace-controller"].WASALX_ZAMMAD_DISPLAY_TIMEZONE, timeZone);
});

function composeConnectionHosts(key: string, value: string): string[] {
  const connectionKey = /_(?:URL|DSN|HOST)$|^(?:PGHOST|MEMCACHE_SERVERS|ZAMMAD_FQDN)$/u.test(key);
  // Keep credentials and ports opaque. Inspect literal defaults only at endpoint or host positions.
  const defaults = new Map<string, string>();
  const interpolation = /(?<!\$)\$\{[A-Za-z_]\w*(?:(:?[-+?])([^{}]*))?\}/gu;
  while (interpolation.test(value)) {
    interpolation.lastIndex = 0;
    value = value.replace(interpolation, (_match, operator = "", fallback = "") => {
      const token = `\0${defaults.size}\0`;
      defaults.set(token, /[+-]$/u.test(operator) ? fallback : "");
      return token;
    });
  }

  function hosts(endpoint: string, expectHost: boolean): string[] {
    endpoint = endpoint.trim();
    if (!endpoint || (key.startsWith("ALLOW_") && /^(?:true|false)$/u.test(endpoint))) return [];
    const fallback = defaults.get(endpoint);
    if (fallback !== undefined) return hosts(fallback, expectHost);
    const endpoints = endpoint.split(/,\s*(?=(?:jdbc:)?[a-z][\w+.-]*:\/\/)/iu);
    if (endpoints.length > 1) return endpoints.flatMap((entry) => hosts(entry, expectHost));
    const connections = /(?:jdbc:)?([a-z][\w+.-]*):\/\/([^\s"'<>\\/?#{}()]*)|(\0\d+\0)/giu;
    const result: string[] = [];
    let sawUrl = false;
    for (const [, scheme, authority, variable] of endpoint.matchAll(connections)) {
      if (variable) {
        const embeddedDefault = defaults.get(variable);
        if (embeddedDefault !== undefined) result.push(...hosts(embeddedDefault, false));
      } else {
        sawUrl = true;
        // Secret-store references and local file URLs have no network host.
        if (/^secret$/iu.test(scheme) || (/^file$/iu.test(scheme) && !authority)) continue;
        result.push(...authorityHosts(authority.slice(authority.lastIndexOf("@") + 1)));
      }
    }
    if (sawUrl || !expectHost) return result;
    const dsnHost = /(?:^|\s)host=(?:'([^']+)'|(\S+))/u.exec(endpoint);
    return authorityHosts(dsnHost?.[1] ?? dsnHost?.[2] ?? endpoint);
  }

  function authorityHosts(authority: string): string[] {
    return authority.split(",").flatMap((entry) => {
      const host = /^(\[[^\]]+\]|[^:\s/?#]+)(?::(?:\d+|\0\d+\0))?$/u.exec(entry.trim())?.[1];
      if (!host) return ["(invalid or missing host)"];
      const hostDefault = defaults.get(host);
      return hostDefault === undefined ? [host.toLowerCase()] : hosts(hostDefault, true);
    });
  }

  return hosts(value, connectionKey);
}

test("Compose host scanning finds URLs embedded in interpolated JSON", () => {
  assert.deepEqual(composeConnectionHosts("WAHA_WORKERS_JSON", '${WAHA_WORKERS_JSON:-[{"baseUrl":"http://waha-gows:3000"}]}'), ["waha-gows"]);
  assert.deepEqual(composeConnectionHosts("DEV_SECRET_STORE_JSON", '{"secret://platform/provider":{"url":"${PROVIDER_URL:-https://scrubbed.example.test/api}"}}'), ["scrubbed.example.test"]);
  assert.deepEqual(composeConnectionHosts("DATABASE_URL", "postgresql://app:${PASSWORD:-https://dummy.example.test}@postgres/db"), ["postgres"]);
});

test("Compose connection hosts resolve in the base file, full override and merged stack", async () => {
  const [base, full] = await Promise.all([readComposeEnvironments("compose.yaml"), readComposeEnvironments("compose.full.yaml")]);
  const merged = Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(full)])]
    .map((service) => [service, { ...base[service], ...full[service] }]));
  const externalHosts = new Map([
    ["identity.local", "Developer OIDC issuer outside Compose DNS"],
    ["email-provider.invalid", "Fail-closed developer default until an invitation provider is supplied"],
    ["kubernetes.default.svc", "Kubernetes API DNS in the optional provisioning profile"],
    ["workspace-provider.platform.svc.cluster.local", "Kubernetes workspace provider DNS in the optional provisioning profile"],
  ]);
  const baseOnlyHosts = new Map([
    // fast stack has no WAHA on purpose; the full stack overrides it to waha-gows
    ["waha", ["control-api.WAHA_ADMIN_BASE_URL", "connector-worker.WAHA_BASE_URL"]],
  ]);
  // The issuer, login, redirect, canonical Zammad hostname and portal link all identify public endpoints.
  const browserKey = /_ORIGIN$|(?:^|_)PUBLIC_|^(?:KC_HOSTNAME|ALLOWED_ORIGINS|ZAMMAD_FQDN|WASALX_PORTAL_URL|IDENTITY_POLICY_ATTESTATION_ISSUER|(?:PLATFORM_OPERATOR_)?OIDC_(?:ISSUER|AUTHORIZATION_ENDPOINT|(?:INVITATION_)?REDIRECT_URI))$/u;
  const invalid: string[] = [];
  for (const [file, environments, services] of [
    ["compose.yaml", base, base],
    // The installer loads the override after the base. Check its raw values against both sets of service declarations.
    ["compose.full.yaml", full, merged],
    ["merged Compose", merged, merged],
  ] as const) {
    for (const [service, environment] of Object.entries(environments)) {
      for (const [key, value] of Object.entries(environment)) {
        if (value === null) continue;
        for (const host of composeConnectionHosts(key, String(value))) {
          if (service === "jaeger" && key === "JAEGER_LISTEN_HOST" && host === "0.0.0.0") continue; // Listener bind address.
          if (file === "compose.yaml" && baseOnlyHosts.get(host)?.includes(`${service}.${key}`)) continue;
          if ((host === "localhost" || host === "127.0.0.1") && browserKey.test(key)) continue;
          if (!Object.hasOwn(services, host) && !externalHosts.has(host)) invalid.push(`${file}: ${service}.${key} -> ${host}`);
        }
      }
    }
  }
  assert.deepEqual(invalid, [], "Compose connection hosts must name a service, use an interpolation or have a documented exception");

  const keycloakDatabaseUrl = full.keycloak.KC_DB_URL;
  assert.ok(typeof keycloakDatabaseUrl === "string");
  assert.match(keycloakDatabaseUrl, /^jdbc:postgresql:\/\//u);
  const keycloakDatabase = new URL(keycloakDatabaseUrl.replace(/^jdbc:/u, ""));
  assert.equal(keycloakDatabase.hostname, "keycloak-postgresql");
  assert.equal(keycloakDatabase.pathname, `/${full["keycloak-postgresql"].POSTGRES_DB}`);
});

test("full Compose exposes bootstrap identity overrides with the public fixture defaults", async () => {
  const [full, example] = await Promise.all([readComposeEnvironments("compose.full.yaml"), read(".env.example")]);
  assert.equal(full["keycloak-bootstrap"].WASALX_KEYCLOAK_BOOTSTRAP_MODE, "${WASALX_KEYCLOAK_BOOTSTRAP_MODE-reconcile}");
  const defaults = {
    "keycloak-bootstrap": {
      QUALIFICATION_OWNER_USERNAME: "example.owner",
      ISOLATION_OWNER_USERNAME: "example.isolation",
      PLATFORM_OPERATOR_USERNAME: "example.platform",
    },
    "zammad-runtime-bootstrap": {
      ZAMMAD_BOOTSTRAP_EMAIL: "fixture-0003@example.test",
      ZAMMAD_BOOTSTRAP_PREVIOUS_EMAIL: "fixture-0004@example.test",
      ZAMMAD_AGENT_EMAIL: "fixture-0005@example.test",
    },
  };
  for (const [service, identities] of Object.entries(defaults)) {
    for (const [key, fallback] of Object.entries(identities)) {
      assert.equal(full[service][`WASALX_${key}`], `\${WASALX_FULL_${key}:-${fallback}}`);
      assert.ok(example.split(/\r?\n/u).includes(`# WASALX_FULL_${key}=${fallback}`));
    }
  }
});

test("Keycloak bootstrap preserves existing state in read-only mode and reconciles matching identities in setup mode", async (t) => {
  const ownerId = "10000000-0000-4000-8000-000000000001";
  const isolationId = "isolation-id";
  const operatorId = "10000000-0000-4000-8000-000000000002";
  const isolationEmail = "isolation@fixture.example.edu";
  const tenantUsers = "/admin/realms/wasalx/users";
  const platformUsers = "/admin/realms/wasalx-platform/users";
  const ownerPath = `${tenantUsers}/${ownerId}`;
  const isolationPath = `${tenantUsers}/${isolationId}`;
  const operatorPath = `${platformUsers}/${operatorId}`;
  const preserve = "preserve-existing";
  const invalidMode = /WASALX_KEYCLOAK_BOOTSTRAP_MODE must be reconcile or preserve-existing/u;
  const scenarios = [
    { name: "the default owner matches and the missing isolation user is created" },
    { name: "all three overrides are trimmed, lowercased, and used", overrides: true, existingIsolation: "custom.isolation" },
    { name: "a seeded owner mismatch prevents every write", existingOwner: "custom.owner", error: "QUALIFICATION_OWNER" },
    { name: "an isolation email match with a different username prevents every write", existingIsolation: "custom.isolation", error: "ISOLATION_OWNER" },
    { name: "platform mismatch prevents every write", existingOperator: "custom.platform", error: "PLATFORM_OPERATOR" },
    { name: "invalid reconcile configuration fails before login", smtpHost: "example.test",
      configError: /Keycloak SMTP configuration must be complete/u },
    { name: "invalid reconcile origin fails before login", portalOrigin: "malformed-origin",
      configError: /^Error: WASALX_PORTAL_PUBLIC_ORIGIN is invalid$/u },
    { name: "unsupported bootstrap mode fails before login", mode: "unknown", configError: invalidMode },
    { name: "empty bootstrap mode fails before login", mode: "", configError: invalidMode },
    { name: "preserve requires the administrator username", mode: preserve, missingAdmin: "KEYCLOAK_ADMIN",
      configError: /KEYCLOAK_ADMIN is required/u },
    { name: "preserve requires the administrator password", mode: preserve, missingAdmin: "KEYCLOAK_ADMIN_PASSWORD",
      configError: /KEYCLOAK_ADMIN_PASSWORD is required/u },
    { name: "preserve verifies both realms, configured users and all clients", mode: preserve, existingIsolation: "example.isolation" },
    { name: "preserve fails closed on a lookup error", mode: preserve, realmStatus: 503, preserveError: /wasalx realm lookup/u },
    { name: "preserve refuses a missing required isolation owner", mode: preserve, preserveError: /seeded isolation user is missing/u },
    { name: "preserve refuses an ambiguous user lookup", mode: preserve, ambiguousUser: true, preserveError: /user lookup was ambiguous/u },
    { name: "preserve refuses a missing seeded owner", mode: preserve, missingSeed: ownerPath,
      preserveError: /seeded user is missing for wasalx(?:\n|$)/u },
    { name: "preserve refuses a missing seeded operator", mode: preserve, missingSeed: operatorPath,
      existingIsolation: "example.isolation", preserveError: /seeded user is missing for wasalx-platform/u },
    { name: "preserve refuses a mismatched seeded username", mode: preserve, existingOwner: "custom.owner",
      preserveError: /existing user has a different username.*WASALX_QUALIFICATION_OWNER_USERNAME/u },
    { name: "preserve refuses an ambiguous client lookup", mode: preserve, existingIsolation: "example.isolation",
      clientCount: 2, preserveError: /client lookup was ambiguous/u },
    { name: "preserve refuses a missing client", mode: preserve, existingIsolation: "example.isolation",
      clientCount: 0, preserveError: /seeded client is missing/u },
    { name: "preserve refuses an unexpected client ID", mode: preserve, existingIsolation: "example.isolation",
      wrongClient: true, preserveError: /client lookup returned an unexpected client/u },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const owner = scenario.overrides ? "custom.owner" : "example.owner";
      const isolation = scenario.overrides ? "custom.isolation" : "example.isolation";
      const operator = scenario.overrides ? "custom.platform" : "example.platform";
      const env = {
        KEYCLOAK_ADMIN: scenario.missingAdmin === "KEYCLOAK_ADMIN" ? undefined : "synthetic-admin",
        KEYCLOAK_ADMIN_PASSWORD: scenario.missingAdmin === "KEYCLOAK_ADMIN_PASSWORD" ? undefined : "synthetic-admin-password",
        KEYCLOAK_BASE_URL: "http://127.0.0.1:8080",
        WASALX_KEYCLOAK_BOOTSTRAP_MODE: scenario.mode,
        WASALX_QUALIFICATION_OWNER_PASSWORD: scenario.mode ? undefined : "synthetic-owner-password",
        WASALX_ISOLATION_OWNER_PASSWORD: scenario.mode ? undefined : "synthetic-isolation-password",
        WASALX_PLATFORM_OPERATOR_PASSWORD: scenario.mode ? undefined : "synthetic-operator-password",
        WASALX_QUALIFICATION_OWNER_EMAIL: "",
        WASALX_ISOLATION_OWNER_EMAIL: isolationEmail,
        WASALX_KEYCLOAK_SMTP_HOST: scenario.smtpHost ?? "",
        WASALX_KEYCLOAK_SMTP_PORT: "",
        WASALX_KEYCLOAK_SMTP_FROM: "",
        WASALX_KEYCLOAK_SMTP_USER: "",
        WASALX_KEYCLOAK_SMTP_PASSWORD: "",
        WASALX_PORTAL_PUBLIC_ORIGIN: scenario.portalOrigin,
        WASALX_ZAMMAD_PUBLIC_ORIGIN: undefined,
        WASALX_QUALIFICATION_OWNER_USERNAME: scenario.overrides ? ` ${owner.toUpperCase()} ` : undefined,
        WASALX_ISOLATION_OWNER_USERNAME: scenario.overrides ? ` ${isolation.toUpperCase()} ` : undefined,
        WASALX_PLATFORM_OPERATOR_USERNAME: scenario.overrides ? ` ${operator.toUpperCase()} ` : undefined,
      };
      for (const [key, value] of Object.entries(env)) {
        const previous = process.env[key];
        subtest.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const users = new Map<string, { id: string; username: string; email?: string; requiredActions?: string[] }>([
        [ownerPath, { id: ownerId, username: scenario.existingOwner ?? owner }],
        [operatorPath, { id: operatorId, username: scenario.existingOperator ?? operator }],
      ]);
      if (scenario.existingIsolation) {
        users.set(isolationPath, { id: isolationId, username: scenario.existingIsolation, email: isolationEmail });
      }
      if (scenario.missingSeed) users.delete(scenario.missingSeed);
      const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
      const adminRequests: { method: string; path: string; clientId: string | null }[] = [];
      const lookedUpUsernames = new Set<string>();
      const mockFetch = subtest.mock.method(globalThis, "fetch", (input: string, init?: RequestInit) => {
        const { pathname: path, searchParams } = new URL(input);
        const method = init?.method ?? "GET";
        if (path === "/realms/master/protocol/openid-connect/token") {
          assert.equal(method, "POST");
          return Response.json({ access_token: "synthetic-token".repeat(3) });
        }
        adminRequests.push({ method, path, clientId: searchParams.get("clientId") });
        if (scenario.mode && method !== "GET") return new Response(null, { status: 403 });
        if (method !== "GET") {
          const body = JSON.parse(String(init?.body));
          writes.push({ method, path, body });
          if (method === "POST" && path === tenantUsers) users.set(isolationPath, { ...body, id: isolationId });
          return new Response(null, { status: method === "POST" ? 201 : 204 });
        }
        if (path === "/admin/realms/wasalx" || path === "/admin/realms/wasalx-platform") {
          return scenario.realmStatus
            ? new Response("synthetic private error payload", { status: scenario.realmStatus })
            : Response.json({ realm: path.split("/").at(-1) });
        }
        if (path.endsWith("/clients")) {
          const clientId = scenario.wrongClient ? "unrelated-client" : searchParams.get("clientId");
          return Response.json(Array.from({ length: scenario.clientCount ?? (scenario.mode ? 1 : 0) },
            (_, index) => ({ id: `client-${index}`, clientId })));
        }
        if (path.endsWith("/credentials")) return Response.json([]);
        if (path === tenantUsers || path === platformUsers) {
          if (scenario.ambiguousUser) return Response.json([{ id: "first" }, { id: "second" }]);
          const field = searchParams.has("email") ? "email" : "username";
          const value = searchParams.get(field);
          if (field === "username" && value !== null) lookedUpUsernames.add(value);
          return Response.json([...users.entries()]
            .filter(([key, user]) => key.startsWith(`${path}/`) && user[field] === value)
            .map(([, user]) => user));
        }
        return users.has(path) ? Response.json(users.get(path)) : new Response(null, { status: 404 });
      });
      const errors: string[] = [];
      const stderr = subtest.mock.method(process.stderr, "write", (message: string) => {
        errors.push(message);
        return true;
      });
      const script = new URL("../infra/docker/full/keycloak/bootstrap-user.mjs", import.meta.url);
      script.searchParams.set("scenario", scenario.name);
      const previousExitCode = process.exitCode;
      let exitCode;
      try {
        if (scenario.configError) {
          await assert.rejects(import(script.href), scenario.configError);
          assert.equal(mockFetch.mock.callCount(), 0);
          return;
        }
        await import(script.href);
        exitCode = process.exitCode;
      } finally {
        stderr.mock.restore();
        process.exitCode = previousExitCode;
      }
      if (scenario.mode) {
        assert.ok(adminRequests.length > 0);
        assert.ok(adminRequests.every(({ method, path }) => method === "GET" && path.startsWith("/admin/realms/")));
        assert.doesNotMatch(errors.join(""), /synthetic private error payload/u);
        if (scenario.preserveError) {
          assert.equal(exitCode, 1);
          assert.match(errors.join(""), scenario.preserveError);
        } else {
          assert.deepEqual(errors, []);
          assert.equal(exitCode, previousExitCode);
          assert.deepEqual(adminRequests.map(({ path, clientId }) => clientId ?? path).sort(), [
            "/admin/realms/wasalx", "/admin/realms/wasalx-platform", ownerPath, tenantUsers, operatorPath,
            "wasalx-portal", "wasalx-00000000000040008000000000000001", "wasalx-platform-portal",
          ].sort());
        }
        return;
      }
      if (scenario.error) {
        assert.equal(exitCode, 1);
        assert.match(errors.join(""), new RegExp(`existing user has a different username.*WASALX_${scenario.error}_USERNAME`, "u"));
        assert.deepEqual(writes, []);
        return;
      }
      assert.deepEqual(errors, []);
      assert.equal(exitCode, previousExitCode);
      assert.deepEqual(lookedUpUsernames, new Set([owner, isolation, operator]));
      const expectedProfile = { emailVerified: true, enabled: true, lastName: "Owner" };
      assert.deepEqual(writes.find(({ path }) => path === ownerPath), {
        method: "PUT", path: ownerPath,
        body: { id: ownerId, email: "fixture-0006@example.test", ...expectedProfile, firstName: "Qualification" },
      });
      assert.deepEqual(writes.find(({ path }) => path === (scenario.existingIsolation ? isolationPath : tenantUsers)), {
        method: scenario.existingIsolation ? "PUT" : "POST",
        path: scenario.existingIsolation ? isolationPath : tenantUsers,
        body: {
          email: isolationEmail, ...expectedProfile, firstName: "Isolation",
          ...(scenario.existingIsolation ? {} : { username: isolation, requiredActions: ["CONFIGURE_TOTP"] }),
        },
      });
      assert.deepEqual(writes.filter(({ path }) => path.endsWith("/reset-password")).map(({ path }) => path),
        [ownerPath, isolationPath, operatorPath].map((path) => `${path}/reset-password`));
      const totpPaths = scenario.existingIsolation ? [ownerPath, isolationPath, operatorPath] : [ownerPath, operatorPath];
      assert.deepEqual(writes.filter(({ method, body }) => method === "PUT" && body.requiredActions), totpPaths
        .map((path) => ({ method: "PUT", path, body: { requiredActions: ["CONFIGURE_TOTP"] } })));
      assert.ok(writes.every(({ method, body }) => method !== "PUT" || !Object.hasOwn(body, "username")));
    });
  }
});

test("direct Helm production installs reject development defaults and incomplete runtime dependencies", async () => {
  const schema = JSON.parse(
    await read("infra/helm/wasalx/values.schema.json"),
  );
  const fixture = await read("infra/helm/wasalx/ci/production-values.yaml");
  const script = await read("scripts/validate-infra.sh");
  const productionBase = schema.allOf.find(
    (rule: { if?: { properties?: { environment?: { const?: string } } } }) =>
      rule.if?.properties?.environment?.const === "production",
  ).then.properties;
  const standard = schema.allOf.find(
    (rule: { if?: { properties?: { deploymentProfile?: { const?: string } } } }) =>
      rule.if?.properties?.deploymentProfile?.const === "standard",
  ).then.properties;
  const assisted = schema.allOf.find(
    (rule: { if?: { properties?: { deploymentProfile?: { const?: string } } } }) =>
      rule.if?.properties?.deploymentProfile?.const === "assisted-alpha",
  ).then.properties;
  const production = { ...productionBase, ...standard };

  assert.match(
    schema.definitions.productionValue.not.pattern,
    /example\|placeholder[\s\S]*localhost[\s\S]*127/,
  );
  for (const component of [
    "controlPlaneBackup",
    "managedWaha",
    "workspaceProvider",
    "provisioner",
  ]) {
    assert.equal(production[component].properties.enabled.const, true);
    if (component === "workspaceProvider" || component === "provisioner") {
      assert.equal(assisted[component].properties.enabled.const, false);
    }
  }
  assert.equal(assisted.controlPlaneBackup, undefined);
  assert.equal(production.managedWaha.properties.gows.properties.enabled.const, true);
  assert.equal(production.portalCookieSecure.const, "true");
  assert.equal(production.observability.properties.enabled.const, true);
  assert.equal(
    production.observability.properties.prometheusRule.properties.enabled.const,
    true,
  );
  assert.deepEqual(
    production.controlApiUrl.anyOf,
    [{ pattern: "^https://" }, { const: "http://wasalx-api:3001" }],
  );
  assert.equal(
    production.provisioner.properties.controller.properties.admissionPolicy
      .properties.enabled.const,
    true,
  );

  for (const property of [
    "allowedEgressCidrs",
    "portalAllowedEgressCidrs",
    "apiAllowedEgressCidrs",
    "workerAllowedEgressCidrs",
    "invitationMailerAllowedEgressCidrs",
    "identityPolicyAllowedEgressCidrs",
  ]) {
    assert.equal(production[property].minItems, 1);
  }
  assert.equal(production.managedWaha.properties.allowedEgressCidrs.minItems, 1);
  assert.equal(production.controlPlaneBackup.properties.allowedEgressCidrs.minItems, 1);
  assert.equal(production.workspaceProvider.properties.allowedEgressCidrs.minItems, 1);
  assert.equal(production.provisioner.properties.allowedEgressCidrs.minItems, 1);
  assert.equal(
    production.provisioner.properties.controller.properties.allowedEgressCidrs
      .minItems,
    1,
  );

  const productionText = JSON.stringify(production);
  for (const image of [
    "portal",
    "api",
    "worker",
    "invitationMailer",
    "identityPolicyActivator",
    "migration",
    "controlPlaneBackup",
    "workspaceProvider",
    "provisioner",
  ]) assert.match(productionText, new RegExp(`\\"${image}\\"[\\s\\S]*?@sha256`));
  assert.match(productionText, /gows[\s\S]*@sha256/);
  for (const image of [
    "configuratorImage",
    "nginxImage",
    "redisImage",
    "memcachedImage",
  ]) assert.match(productionText, new RegExp(`${image}[\\s\\S]*?@sha256`));
  assert.equal(
    production.provisioner.properties.controller.properties.zammadImages
      .minProperties,
    1,
  );

  assert.doesNotMatch(
    fixture,
    /(?:example|placeholder|changeme|replace[-_]?me|localhost|127\.0\.0\.1|:dev|:latest)/iu,
  );
  const forbiddenProductionValue = new RegExp(schema.definitions.productionValue.not.pattern.replace(/^\(\?i\)/u, ""), "i");
  function assertProductionUrls(value: unknown) {
    if (typeof value === "string" && /^https?:\/\//u.test(value)) assert.doesNotMatch(value, forbiddenProductionValue);
    else if (value && typeof value === "object") for (const child of Object.values(value)) assertProductionUrls(child);
  }
  assertProductionUrls(parseYaml(fixture));
  assert.match(script, /PRODUCTION_VALUES_FILE="infra\/helm\/wasalx\/ci\/production-values\.yaml"/u);
  assert.match(script, /^assisted_alpha_backup_values=\(--set deploymentProfile=assisted-alpha --set workspaceProvider\.enabled=false --set provisioner\.enabled=false\)$/mu);
  assert.match(script, /^assisted_alpha_values=\("\$\{assisted_alpha_backup_values\[@\]\}" --set controlPlaneBackup\.enabled=false\)$/mu);
  assert.match(script, /backup_profile_args=\("\$\{assisted_alpha_backup_values\[@\]\}"\)/u);
  assert.match(script, /^ruby scripts\/validate-migration-render\.rb "\$TOOLS_DIR\/rendered-production\.yaml" standard$/mu);
  assert.match(script, /^ruby scripts\/validate-migration-render\.rb "\$TOOLS_DIR\/rendered-assisted-alpha\.yaml" assisted-alpha$/mu);
  assert.doesNotMatch(script, /WASALX_(?:ASSISTED_PROFILE_VALUES|PRODUCTION_MIGRATION_CHECK)/u);
  assert.match(script, /assisted alpha unexpectedly enabled deferred component/u);
  assert.match(script, /if "\$HELM" lint infra\/helm\/wasalx --set environment=production/u);
  assert.match(script, /production Helm defaults unexpectedly passed the fail-closed schema/u);
  for (const invalidCase of [
    "example-origin",
    "local-origin",
    "insecure-cookie",
    "observability-disabled",
    "alerts-disabled",
    "external-plain-http-api",
    "example-kms",
    "local-kms",
    "backup-disabled",
    "provider-disabled",
    "provisioner-disabled",
    "controller-policy-disabled",
    "managed-waha-disabled",
    "managed-gows-disabled",
    "mutable-image",
    "empty-egress",
  ]) assert.match(script, new RegExp(`expect_production_lint_failure ${invalidCase}`));
});

test("Docker smoke preserves the failure and captures diagnostics before destructive cleanup", async () => {
  const script = await read("scripts/test-docker-stack.sh");
  const cleanup = script.match(/cleanup\(\) \{[\s\S]*?\n\}\ntrap cleanup EXIT/u)?.[0];
  assert.ok(cleanup);
  assert.match(cleanup, /docker inspect --format '\{\{json \.State\}\}'/u);
  assert.doesNotMatch(cleanup, /\.Config|\.Env/u);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const [status, diagnosticsFail] of [[42, false], [42, true], [0, false]] as const) {
    const result: SpawnSyncReturns<string> = spawnSync(bash, ["--noprofile", "--norc", "-c", `
set -euo pipefail
exec 3>&2
compose=(docker compose --project-name synthetic-smoke)
provisioner_image=synthetic-provisioner
controller_image=synthetic-controller
provider_image=synthetic-provider
configurator_image=synthetic-configurator
timeout() { test "$1" = 15s; shift; "$@"; }
docker() {
  printf 'CALL %s\\n' "$*" >&3
  case "$*" in
    *down*|*"image rm"*) return 19 ;;
    *) ${diagnosticsFail ? "return 23" : "true"} ;;
  esac
  if [[ "$*" == *"ps --all --quiet postgres" ]]; then printf 'synthetic-pg\\n'; fi
}
${cleanup}
exit ${status}
`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, /down --volumes --remove-orphans/u);
    if (status) {
      assert.match(result.stderr, /capturing PostgreSQL diagnostics/u);
      assert.ok(result.stderr.indexOf("logs --no-color --tail 200 postgres") < result.stderr.indexOf("down --volumes"));
      if (!diagnosticsFail) assert.match(result.stderr, /inspect --format.*synthetic-pg/u);
    } else {
      assert.doesNotMatch(result.stderr, /logs --no-color|inspect --format/u);
    }
  }
});

test("workspace configurator resolves the repository-pinned pnpm and fails on tool drift", async () => {
  const root = JSON.parse(await read("package.json"));
  const configurator = JSON.parse(await read("services/workspace-configurator/package.json"));
  assert.equal(configurator.packageManager, root.packageManager);
  const version = root.packageManager.split("@")[1];
  assert.ok((await read("Dockerfile.workspace-configurator")).includes(`test "$(pnpm --version)" = "${version}"`));
});

test("Docker smoke fails before BuildKit when host disk is unsafe", async () => {
  const script = await read("scripts/test-docker-stack.sh");
  assert.match(script, /export DOCKER_BUILDKIT=1/);
  assert.match(script, /docker buildx version/);
  assert.match(script, /refusing an incompatible legacy build/);
  assert.match(script, /WASALX_DOCKER_SMOKE_MIN_FREE_BYTES:-10737418240/);
  assert.match(script, /df -Pk "\$repository"/);
  assert.match(script, /available_bytes < minimum_free_bytes/);
  assert.match(script, /Free disk space or explicitly lower WASALX_DOCKER_SMOKE_MIN_FREE_BYTES/);
  assert.ok(
    script.indexOf("available_bytes < minimum_free_bytes") <
      script.indexOf('"${compose[@]}" build'),
    "the resource guard must run before any image build",
  );
  assert.ok(
    script.indexOf("docker buildx version") <
      script.indexOf('"${compose[@]}" build'),
    "the BuildKit guard must run before any image build",
  );
  const dockerignore = await read(".dockerignore");
  const ignored = new Set(dockerignore.split(/\r?\n/u));
  for (const generated of [".pnpm-store", "output", "storybook-static", "test-results", "**/.terraform"]) {
    assert.ok(ignored.has(generated), `Docker context includes generated path: ${generated}`);
  }
});

test("Helm workloads have rollout, health, secret, migration, and disruption controls", async () => {
  const workloads = await read("infra/helm/wasalx/templates/workloads.yaml");
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const availability = await read("infra/helm/wasalx/templates/availability.yaml");
  assert.match(workloads, /maxUnavailable: 0/);
  assert.match(workloads, /readinessProbe/);
  assert.match(workloads, /livenessProbe/);
  assert.match(workloads, /startupProbe/);
  assert.match(workloads, /secretRef/);
  assert.match(workloads, /readOnlyRootFilesystem: true/);
  assert.match(workloads, /name: PUBLIC_WEBHOOK_BASE_URL\s+valueFrom: \{ configMapKeyRef: \{ name: wasalx-runtime, key: PUBLIC_WEBHOOK_BASE_URL \} \}/);
  assert.match(config, /OIDC_PRIVILEGED_ACR_VALUES: \{\{ required "oidc\.privilegedAcrValues must name a production-issued assurance context"/);
  assert.match(config, /OIDC_PRIVILEGED_MFA_AMR_VALUES: \{\{ required "oidc\.privilegedMfaAmrValues is required"/);
  assert.match(config, /pre-install,pre-upgrade/);
  assert.match(config, /name: "wasalx-migrate-[\s\S]*?backoffLimit: 0/);
  assert.match(availability, /kind: PodDisruptionBudget/);
  assert.match(availability, /kind: HorizontalPodAutoscaler/);
});

test("Helm renders a fail-closed control-plane logical backup producer", async () => {
  const [backup, network, values] = await Promise.all([
    read("infra/helm/wasalx/templates/control-plane-backup.yaml"),
    read("infra/helm/wasalx/templates/networkpolicy.yaml"),
    read("infra/helm/wasalx/values.yaml"),
  ]);
  const schema = JSON.parse(await read("infra/helm/wasalx/values.schema.json"));
  for (const contract of [
    /kind: CronJob/,
    /concurrencyPolicy: Forbid/,
    /activeDeadlineSeconds: 3300/,
    /args: \["control-backup"\]/,
    /OBJECT_STORAGE_PREFIX, value: "control-plane\/"/,
    /automountServiceAccountToken: false/,
    /readOnlyRootFilesystem: true/,
    /capabilities: \{ drop: \["ALL"\] \}/,
    /persistentVolumeClaim: \{ claimName: wasalx-control-backup-staging \}/,
    /secretKeyRef: \{ name:/,
  ]) assert.match(backup, contract);
  assert.doesNotMatch(backup, /BACKUP_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY).*value:/);
  assert.doesNotMatch(backup, /envFrom:|(?:startup|readiness|liveness)Probe:/);
  assert.match(network, /name: wasalx-control-backup-egress/);
  assert.match(values, /controlPlaneBackup:[\s\S]*enabled: false/);
  const configured = schema.properties.controlPlaneBackup;
  assert.equal(configured.additionalProperties, false);
  assert.deepEqual(configured.properties.s3.required, [
    "endpoint", "region", "bucket", "lifecycleRuleId", "provider",
  ]);
  assert.equal(configured.properties.s3.properties.endpoint.pattern, "^https://");
  assert.match(configured.properties.s3.properties.kmsKeyReference.pattern, /arn:/);
  assert.deepEqual(configured.properties.s3.allOf[0].then.required, ["ageRecipient"]);
  assert.deepEqual(configured.properties.s3.allOf[0].else.required, ["kmsKeyReference"]);
  assert.equal(configured.allOf[0].then.properties.allowedEgressCidrs, undefined);
  assert.match(backup, /NODE_EXTRA_CA_CERTS, value: \/backup-ca\/ca.crt/);
  assert.match(backup, /BACKUP_CA_CERT_FILE, value: \/backup-ca\/ca.crt/);
  assert.match(network, /wasalx\.io\/foundation: "true"[\s\S]*port: 5432[\s\S]*port: 9000/);
  assert.match(configured.allOf[0].then.properties.image.pattern, /sha256/);
});

test("Helm can own persistent, private, drain-safe GOWS and NOWEB pools", async () => {
  const [chart, managed, rolloutGate, workloads, config, network, values, validation, verifier] = await Promise.all([
    read("infra/helm/wasalx/Chart.yaml"),
    read("infra/helm/wasalx/templates/managed-waha.yaml"),
    read("infra/helm/wasalx/templates/waha-rollout-gate.yaml"),
    read("infra/helm/wasalx/templates/workloads.yaml"),
    read("infra/helm/wasalx/templates/config.yaml"),
    read("infra/helm/wasalx/templates/networkpolicy.yaml"),
    read("infra/helm/wasalx/values.yaml"),
    read("scripts/validate-infra.sh"),
    read("scripts/validate-managed-waha-render.rb"),
  ]);
  const schema = JSON.parse(
    await read("infra/helm/wasalx/values.schema.json"),
  );

  for (const contract of [
    /kind: StatefulSet/,
    /kind: Service/,
    /clusterIP: None/,
    /volumeClaimTemplates:/,
    /mountPath: \/app\/\.sessions/,
    /persistentVolumeClaimRetentionPolicy: \{ whenDeleted: Retain, whenScaled: Retain \}/,
    /updateStrategy: \{ type: OnDelete \}/,
    /kind: PodDisruptionBudget/,
    /minAvailable: 1/,
    /helm\.sh\/resource-policy: keep/,
    /argocd\.argoproj\.io\/sync-options: Prune=false/,
    /kustomize\.toolkit\.fluxcd\.io\/prune: disabled/,
    /startupProbe:/,
    /readinessProbe:/,
    /livenessProbe:/,
    /automountServiceAccountToken: false/,
    /secretKeyRef: \{ name: \{\{ \$credentialSecretName \| quote \}\}, key: WAHA_API_KEY \}/,
    /WAHA_WORKER_RESTART_SESSIONS/,
    /WAHA_LOG_LEVEL, value: warn/,
    /WAHA_HTTP_LOG_LEVEL, value: warn/,
    /WAHA_API_KEY_EXCLUDE_PATH, value: health/,
    /WHATSAPP_API_KEY_EXCLUDE_PATH, value: health/,
    /WAHA_WORKERS_JSON: \{\{ toJson \$workers \| quote \}\}/,
    /wasalx\.io\/scope: connector-worker-only/,
  ]) assert.match(managed, contract);

  assert.match(values, /managedWaha:[\s\S]*gows:[\s\S]*noweb:/);
  assert.match(chart, /kubeVersion: ">=1\.30\.0-0"/);
  assert.match(values, /runAsNonRoot: true/);
  assert.match(values, /healthProbeTimeoutSeconds: 20/);
  assert.match(values, /credentialSecretNames: \[\]/);
  assert.match(values, /secretReferences: \[\]/);
  assert.match(workloads, /secretKeyRef: \{ name: wasalx-managed-waha-registry, key: WAHA_WORKERS_JSON \}/);
  assert.match(workloads, /Backward-compatible external-worker\/development fallback/);
  for (const name of [
    "WAHA_WORKER_PROBE_TIMEOUT_MS",
    "WAHA_DELIVERY_MAX_ATTEMPTS",
    "META_DELIVERY_MAX_ATTEMPTS",
    "ZAMMAD_STATUS_MAX_ATTEMPTS",
  ]) assert.match(workloads, new RegExp(`${name}, value:`));
  assert.doesNotMatch(config, /WAHA_(?:BASE_URL|ADMIN_BASE_URL|ADMIN_SECRET_REFERENCE):/);
  assert.match(network, /name: wasalx-managed-waha-default-deny/);
  assert.match(network, /name: wasalx-managed-waha-private-ingress/);
  assert.match(network, /name: wasalx-managed-waha-egress/);
  assert.match(network, /name: wasalx-waha-rollout-gate/);
  assert.match(network, /name: wasalx-waha-rollout-gate[\s\S]*helm\.sh\/hook-weight: "-5"[\s\S]*argocd\.argoproj\.io\/hook: PreSync/);
  assert.match(network, /app\.kubernetes\.io\/name: wasalx-worker, wasalx\.io\/plane: control/);
  assert.match(network, /app\.kubernetes\.io\/name: wasalx-api, wasalx\.io\/plane: control/);
  assert.match(network, /QR, pairing-code, and passkey actions are proxied by the authenticated/);
  assert.match(validation, /ci\/managed-waha-values\.yaml/);
  assert.match(validation, /validate-managed-waha-render\.rb/);
  assert.match(verifier, /registry\/StatefulSet cardinality mismatch/);
  assert.match(verifier, /portal received WAHA infrastructure/);
  assert.match(verifier, /shared ConfigMap received WAHA infrastructure/);
  assert.match(verifier, /non-connector received delivery retries/);
  assert.match(verifier, /managed WAHA prune protection is incomplete/);
  for (const contract of [
    /helm\.sh\/hook: pre-install,pre-upgrade/,
    /argocd\.argoproj\.io\/hook: PreSync/,
    /WAHA_DESIRED_MANAGED_WORKERS_JSON/,
    /WAHA_ROLLOUT_GATE_DATABASE_URL/,
    /waha-rollout-preflight-bootstrap\.js/,
    /automountServiceAccountToken: false/,
  ]) assert.match(rolloutGate, contract);

  assert.ok(schema.required.includes("managedWaha"));
  assert.equal(schema.properties.managedWaha.additionalProperties, false);
  assert.deepEqual(schema.properties.managedWaha.properties.healthProbeTimeoutSeconds, {
    type: "integer",
    minimum: 5,
    maximum: 30,
  });
  assert.equal(
    schema.definitions.managedWahaEngine.properties.image.pattern,
    "^(?:|[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64})$",
  );
  assert.equal(
    schema.definitions.managedWahaEngine.allOf[0].then.properties.image.pattern,
    "^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$",
  );
  assert.equal(
    schema.definitions.managedWahaPodSecurityContext.properties.runAsNonRoot.const,
    true,
  );
  assert.equal(
    schema.definitions.managedWahaContainerSecurityContext.properties.allowPrivilegeEscalation.const,
    false,
  );
  assert.equal(
    schema.definitions.managedWahaContainerSecurityContext.properties.capabilities.properties.drop.contains.const,
    "ALL",
  );
  assert.ok(schema.required.includes("connectorRetries"));
  assert.deepEqual(schema.properties.connectorRetries.properties.wahaWorkerProbeTimeoutMs, {
    type: "integer",
    minimum: 1000,
    maximum: 30000,
  });
  for (const retry of ["wahaDeliveryMaxAttempts", "metaDeliveryMaxAttempts", "zammadStatusMaxAttempts"].map(
    (name) => schema.properties.connectorRetries.properties[name],
  ) as Array<{ minimum: number; maximum: number }>) {
    assert.deepEqual(
      { minimum: retry.minimum, maximum: retry.maximum },
      { minimum: 1, maximum: 25 },
    );
  }
});

test("Helm networking is deny-by-default and selects controller-owned tenant pods", async () => {
  const network = await read("infra/helm/wasalx/templates/networkpolicy.yaml");
  assert.match(network, /name: wasalx-control-default-deny/);
  assert.match(network, /wasalx\.io\/plane: control/);
  assert.match(network, /name: wasalx-portal-traffic/);
  assert.match(network, /name: wasalx-api-traffic/);
  assert.equal((network.match(/app\.kubernetes\.io\/managed-by: wasalx-workspace-controller, wasalx\.io\/plane: tenant/g) ?? []).length, 3);
  assert.doesNotMatch(network, /app\.kubernetes\.io\/name: zammad, wasalx\.io\/plane: tenant/);
  assert.match(network, /name: wasalx-worker-egress/);
  assert.match(network, /name: wasalx-worker-egress[\s\S]*policyTypes: \[Ingress, Egress\][\s\S]*app\.kubernetes\.io\/name: wasalx-portal[\s\S]*port: 8080/);
  assert.match(network, /name: wasalx-invitation-mailer-traffic/);
  assert.match(network, /name: wasalx-identity-policy-activator-traffic/);
  assert.match(network, /port: 53/);
  assert.match(network, /ipBlock/);
  assert.doesNotMatch(
    network,
    /podSelector: \{ matchLabels: \{ app\.kubernetes\.io\/part-of: wasalx \} \}/,
  );
  assert.doesNotMatch(network, /egress:\s*\{\}/);
});

test("Terraform delegates tenant workspaces to the fenced CR/controller topology", async () => {
  const versions = await read("infra/terraform/versions.tf");
  const root = await read("infra/terraform/main.tf");
  const variables = await read("infra/terraform/variables.tf");
  const crd = await read(
    "infra/helm/wasalx/crds/platform.wasalx.io_tenantworkspaces.yaml",
  );
  const controller = await read(
    "services/tenant-provisioner/src/controller/resources.ts",
  );
  const schema = JSON.parse(
    await read("infra/helm/wasalx/values.schema.json"),
  );

  assert.doesNotMatch(versions, /hashicorp\/random/);
  assert.doesNotMatch(
    root,
    /module\s+"tenant"|resource\s+"kubernetes_deployment"/,
  );
  assert.doesNotMatch(variables, /tenant_profiles|:latest"\s*\}/);
  assert.match(
    root,
    /removed\s*\{[\s\S]*from\s*=\s*module\.tenant[\s\S]*destroy\s*=\s*false/,
  );
  await assert.rejects(
    () => read("infra/terraform/modules/tenant-workspace/main.tf"),
    { code: "ENOENT" },
  );
  for (const value of [
    "DedicatedDatabaseAndRole",
    "DedicatedNamespaceAndCredential",
    "DedicatedPrefixAndCredential",
    "database_secret_reference",
    "search_secret_reference",
    "storage_secret_reference",
    "oidc_secret_reference",
  ]) assert.match(crd, new RegExp(value));
  for (const value of [
    "zammad-railsserver",
    "zammad-websocket",
    "zammad-scheduler",
    "PersistentVolumeClaim",
    "PodDisruptionBudget",
    "NetworkPolicy",
    "CronJob",
    "ownerReferences",
  ]) assert.match(controller, new RegExp(value));
  const enabled = schema.properties.provisioner.allOf[0].then.properties;
  assert.equal(enabled.image.pattern, "@sha256:[a-f0-9]{64}$");
  assert.equal(enabled.controller.properties.image.pattern, "@sha256:[a-f0-9]{64}$");
  assert.equal(enabled.controller.properties.zammadImages.minProperties, 1);
  const production = schema.allOf.find(
    (rule: { if?: { properties?: { environment?: { const?: string }, deploymentProfile?: unknown } } }) =>
      rule.if?.properties?.environment?.const === "production" &&
      rule.if.properties.deploymentProfile === undefined,
  ).then.properties;
  assert.equal(
    production.invitationMailer.properties.image.pattern,
    "^[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$",
  );
  assert.equal(
    production.identityPolicyActivator.properties.image.pattern,
    "^[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$",
  );
});

test("all WasalX deployables have pinned, non-root, health-checked container images", async () => {
  const runtimeImage = /^FROM[ \t]+cgr\.dev\/chainguard\/wolfi-base:latest@sha256:([a-f0-9]{64})(?:[ \t]+AS[ \t]+([\w.-]+))?[ \t]*\r?$/m;
  const releaseDockerfiles = [
    "Dockerfile.portal",
    "Dockerfile.control-api",
    "Dockerfile.connector-worker",
    "Dockerfile.secret-sidecar",
    "Dockerfile.invitation-mailer",
    "Dockerfile.identity-policy-activator",
    "Dockerfile.tenant-provisioner",
    "Dockerfile.tenant-workspace-controller",
    "Dockerfile.workspace-provider",
    "Dockerfile.workspace-configurator",
  ];
  for (const file of releaseDockerfiles.slice(0, 8)) {
    const dockerfile = await read(file);
    assert.match(
      dockerfile,
      /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/,
    );
    assert.match(dockerfile, /USER 65532:65532/);
    assert.match(dockerfile, /HEALTHCHECK/);
    assert.doesNotMatch(dockerfile, /FROM\s+[^\n]*:latest(?!@sha256:[a-f0-9]{64}\b)/);
  }
  let runtimeDigest: string | undefined;
  for (const file of [...releaseDockerfiles.slice(0, 9), "Dockerfile.production-secret-sidecar"]) {
    const dockerfile = await read(file);
    const digest = dockerfile.match(runtimeImage)?.[1];
    assert.ok(digest, `${file} must pin the Wolfi runtime image by SHA-256 digest`);
    runtimeDigest ??= digest;
    assert.equal(digest, runtimeDigest, `${file} must use the shared Wolfi runtime digest`);
    assert.match(dockerfile, /ENV PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
    assert.match(dockerfile, /USER 65532:65532/);
  }
  const invitationMailer = await read("Dockerfile.invitation-mailer");
  assert.match(invitationMailer, /HEALTHCHECK --interval=20s --timeout=45s --start-period=60s --retries=3/);
  const configurator = await read("Dockerfile.workspace-configurator");
  assert.match(configurator, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  const configuratorRuntime = configurator.match(runtimeImage);
  assert.equal(configuratorRuntime?.[1], runtimeDigest, "Dockerfile.workspace-configurator must use the shared Wolfi runtime digest");
  assert.equal(configuratorRuntime?.[2], "runtime", "Dockerfile.workspace-configurator must use the runtime stage alias");
  assert.match(configurator, /libstdc\+\+=16\.2\.0-r1/);
  assert.match(configurator, /postgresql-18-client=18\.6-r2/);
  assert.match(configurator, /zlib=1\.3\.1-r51/);
  assert.match(configurator, /USER 1000:1000/);
  assert.match(configurator, /ENTRYPOINT \["node","dist\/bootstrap\.js"\]/);
  assert.doesNotMatch(configurator, /apt-get|FROM\s+[^\n]*:latest(?!@sha256:[a-f0-9]{64}\b)/);
  for (const file of releaseDockerfiles) {
    const dockerfile = await read(file);
    assert.match(dockerfile,/ARG WASALX_CANDIDATE_SHA=unfrozen/u,file);
    assert.match(dockerfile,/ARG WASALX_CANDIDATE_TREE=unfrozen/u,file);
    assert.match(dockerfile,/org\.opencontainers\.image\.revision="\$\{WASALX_CANDIDATE_SHA\}"/u,file);
    assert.match(dockerfile,/io\.wasalx\.source\.tree="\$\{WASALX_CANDIDATE_TREE\}"/u,file);
  }
  const compose = await read("compose.yaml");
  assert.match(compose, /migrate:/);
  assert.match(compose, /runtime-role-bootstrap:/);
  assert.match(compose, /sync-runtime-roles\.sh/);
  const roleBootstrapConfig = compose.match(/ {2}runtime-role-bootstrap:\r?\n([\s\S]*?)\r?\n\r?\n {2}migrate:/)?.[1] ?? "";
  assert.match(
    roleBootstrapConfig,
    /migrate: \{ condition: service_completed_successfully \}/,
  );
  assert.match(
    compose,
    /runtime-role-bootstrap: \{ condition: service_completed_successfully \}/,
  );
  assert.match(compose, /wasalx_connector_worker_runtime/);
  assert.match(compose, /WASALX_CONNECTOR_WORKER_DB_PASSWORD/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /internal: true/);
  assert.match(compose, /no-new-privileges:true/);
  const postgres = compose.match(/ {2}postgres:\r?\n([\s\S]*?)\r?\n\r?\n {2}redis:/)?.[1] ?? "";
  assert.match(postgres, /cat \/proc\/1\/comm/);
  assert.match(postgres, /pg_isready -U wasalx -d wasalx/);
  const secretSidecar = compose.match(/ {2}secret-sidecar:\r?\n([\s\S]*?)\r?\n\r?\n {2}# Reconcile/)?.[1] ?? "";
  assert.match(secretSidecar, /healthcheck:/);
  assert.match(secretSidecar, /timeout: 10s/);
  assert.match(secretSidecar, /start_period: 30s/);
  assert.match(secretSidecar, /retries: 5/);
  const portal = compose.match(/ {2}portal:\r?\n([\s\S]*?)\r?\n\r?\nnetworks:/)?.[1] ?? "";
  assert.match(portal, /healthcheck:/);
  assert.match(portal, /timeout: 10s/);
  assert.match(portal, /start_period: 60s/);
  assert.match(portal, /retries: 5/);
  const controlApi = compose.match(/ {2}control-api:\r?\n([\s\S]*?)\r?\n {2}connector-worker:/)?.[1] ?? "";
  const connectorWorker = compose.match(/ {2}connector-worker:\r?\n([\s\S]*?)\r?\n {2}# These hardened runtimes/)?.[1] ?? "";
  assert.match(controlApi, /healthcheck:/);
  assert.match(controlApi, /timeout: 10s/);
  assert.match(controlApi, /start_period: 60s/);
  assert.match(controlApi, /retries: 5/);
  assert.match(controlApi, /META_GRAPH_VERSION: v24\.0/);
  assert.match(controlApi, /META_APP_ID: \$\{META_APP_ID:-\}/);
  assert.match(connectorWorker, /META_APP_ID: \$\{META_APP_ID:-\}/);
  assert.match(controlApi, /WAHA_ADMIN_BASE_URL: http:\/\/waha:3000/);
  assert.match(connectorWorker, /DATABASE_URL: postgresql:\/\/wasalx_connector_worker_runtime:/);
  assert.match(
    connectorWorker,
    /WAHA_ADMIN_SECRET_REFERENCE: secret:\/\/platform\/waha-admin/,
  );
  assert.match(connectorWorker, /WAHA_BASE_URL: http:\/\/waha:3000/);
  assert.doesNotMatch(compose, /waha\.private/);
  const roleBootstrap = await read("infra/docker/postgres/init-app-role.sh");
  for (const role of [
    "wasalx_runtime",
    "wasalx_connector_worker_runtime",
    "wasalx_secret_cleanup_runtime",
    "wasalx_provisioning_runtime",
    "wasalx_support_runtime",
    "wasalx_waha_registry_runtime",
    "wasalx_waha_operator_runtime",
    "wasalx_waha_rollout_gate_runtime",
    "wasalx_invitation_mailer_runtime",
    "wasalx_identity_policy_runtime",
    "wasalx_metering_ingest_runtime",
    "wasalx_platform_operations_runtime",
  ]) {
    assert.match(roleBootstrap, new RegExp(`ALTER ROLE ${role} LOGIN PASSWORD`));
  }
  assert.match(roleBootstrap, /while \[ "\$attempt" -le 10 \]/);
  assert.match(roleBootstrap, /Runtime database role reconciliation failed after 10 attempts/);
  assert.match(compose, /DEV_SECRET_STORE_JSON: \$\{DEV_SECRET_STORE_JSON:-\{\}\}/);
});

test("Dockerfiles pin the Node base image at most once", async () => {
  const files = spawnSync("git", ["ls-files", "-z", "--", ":(glob)**/Dockerfile*"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });
  assert.ifError(files.error);
  assert.equal(files.status, 0, files.stderr);
  const dockerfiles = files.stdout.split("\0").filter(Boolean);
  assert.ok(dockerfiles.includes("Dockerfile.portal"), "Dockerfile discovery must include the repository root");
  const nodePin = /(?<![\w.-])node(?::[\w.-]+)?@sha256:[a-f0-9]{64}\b/giu;
  for (const file of dockerfiles) {
    const dockerfile = (await read(file)).replace(/^[ \t]*#.*$/gm, "");
    const pins = dockerfile.match(nodePin) ?? [];
    assert.ok(pins.length <= 1, `${file} has ${pins.length} Node base pins: ${pins.join(", ")}`);
  }
});

test("Docker dependency stages coalesce safely and keep pnpm trust checks enabled", async () => {
  assert.doesNotMatch(await read("Dockerfile.connector-worker"), /^#\s*syntax=/m);
  const backendDockerfiles = [
    "Dockerfile.control-api",
    "Dockerfile.connector-worker",
    "Dockerfile.invitation-mailer",
    "Dockerfile.identity-policy-activator",
    "Dockerfile.tenant-provisioner",
    "Dockerfile.tenant-workspace-controller",
  ];
  const dockerfiles = await Promise.all(backendDockerfiles.map(read));
  const dependencyStages = dockerfiles.map((dockerfile) =>
    dockerfile.slice(dockerfile.indexOf("FROM "), dockerfile.indexOf("FROM dependencies AS build")),
  );

  const portalStage = await read("Dockerfile.portal");
  assert.equal(dependencyStages[0], portalStage.slice(portalStage.indexOf("FROM "), portalStage.indexOf("FROM dependencies AS ")));

  for (const dependencyStage of dependencyStages) {
    assert.equal(dependencyStage, dependencyStages[0]);
    assert.match(dependencyStage, /pnpm install --frozen-lockfile --prefer-offline/);
    assert.match(dependencyStage, /sharing=locked/);
    assert.match(
      dependencyStage,
      /id=wasalx-pnpm-v11,target=\/pnpm\/store,sharing=locked/,
    );
    assert.match(
      dependencyStage,
      /id=pnpm-metadata,target=\/pnpm\/cache,sharing=locked/,
    );
    assert.doesNotMatch(dependencyStage, /--filter\b/u);
    assert.doesNotMatch(dependencyStage, /--no-verify-store-integrity|--ignore-scripts/);
  }

  for (const dockerfile of [await read("Dockerfile.portal"), ...dockerfiles]) {
    assert.match(
      dockerfile,
      /pnpm --prefer-offline --filter .* deploy --prod --legacy/,
    );
    assert.match(dockerfile, /ENV XDG_CACHE_HOME=\/pnpm\/cache/);
    assert.match(
      dockerfile,
      /find \/[^\s]+\/node_modules\/\.pnpm -path '\*\/node_modules\/@wasalx\/observability'/,
    );
    assert.match(
      dockerfile,
      /node -e "[^"]*import\('@wasalx\/observability\/node'\)/,
    );
    assert.doesNotMatch(
      dockerfile,
      /cp -R packages\/observability\/dist packages\/observability\/package\.json/,
    );
    assert.doesNotMatch(dockerfile, /minimum-release-age=0/);
  }

  const portalDockerfile = await read("Dockerfile.portal");
  assert.match(portalDockerfile, /^ENV ROLLDOWN_WORKER_THREADS=1$/m);
  assert.doesNotMatch(portalDockerfile, /COPY \. \./);
  assert.match(portalDockerfile, /COPY packages\/core\/package\.json \.\/packages\/core\/package\.json/);
  for (const directory of ["app", "build", "db", "lib", "packages", "public", "worker"]) {
    assert.match(portalDockerfile, new RegExp(`COPY ${directory} \\.\\/${directory}`));
  }
  assert.match(
    portalDockerfile,
    /CMD \["node","--import=@wasalx\/observability\/node-register","node_modules\/vinext\/dist\/cli\.js","start"\]/,
  );
  assert.doesNotMatch(portalDockerfile, /"node_modules\/\.bin\/vinext"/);

  const pnpmConfig = await read("infra/docker/pnpm.npmrc");
  assert.match(pnpmConfig, /^network-concurrency=4$/m);
  assert.match(pnpmConfig, /^maxsockets=4$/m);
  assert.match(pnpmConfig, /^cache-dir=\/pnpm\/cache$/m);
  assert.match(pnpmConfig, /^fetch-retries=2$/m);
  assert.match(pnpmConfig, /^fetch-timeout=60000$/m);
  assert.doesNotMatch(pnpmConfig, /verify-store-integrity=false|ignore-scripts=true/);

  const workspace = await read("pnpm-workspace.yaml");
  assert.match(workspace, /allowBuilds:/);
  assert.match(workspace, /^ {2}'vinext>image-size': 2\.0\.3$/m);
});

test("Docker smoke may reuse only a complete, explicitly verified local image set", async () => {
  const smoke = await read("scripts/test-docker-stack.sh");
  assert.match(smoke, /WASALX_DOCKER_SMOKE_SKIP_BUILD/);
  for (const image of [
    "wasalx/portal:local",
    "wasalx/control-api:local",
    "wasalx/connector-worker:local",
    "wasalx/dev-secret-sidecar:local",
    "wasalx/invitation-mailer:local",
    "wasalx/identity-policy-activator:local",
    "wasalx/tenant-provisioner:local",
    "wasalx/tenant-workspace-controller:local",
    "wasalx/workspace-provider:local",
    "wasalx/workspace-configurator:local",
  ]) {
    assert.match(smoke, new RegExp(image.replace("/", "\\/").replace(":", "\\:")));
  }
  assert.match(smoke, /docker image inspect "\$image"/);
  assert.match(smoke, /Required prebuilt image is missing/);
  assert.match(smoke, /for service in portal control-api connector-worker secret-sidecar invitation-mailer identity-policy-activator/);
  assert.match(smoke, /compose=\(docker compose --file compose\.yaml --file compose\.smoke\.yaml --project-name "\$project"\)/u);
  assert.match(smoke, /"\$\{compose\[@\]\}" build[\s\S]*--build-arg "WASALX_CANDIDATE_SHA=\$\{WASALX_CANDIDATE_SHA\}"[\s\S]*--build-arg "WASALX_CANDIDATE_TREE=\$\{WASALX_CANDIDATE_TREE\}" "\$service"/u);
  assert.doesNotMatch(smoke, /build portal control-api connector-worker/);
  for (const dockerfile of [
    "Dockerfile.tenant-provisioner",
    "Dockerfile.tenant-workspace-controller",
    "Dockerfile.workspace-provider",
    "Dockerfile.workspace-configurator",
  ]) {
    assert.match(smoke, new RegExp(`docker build "\\$\\{build_args\\[@\\]\\}" --file ${dockerfile.replaceAll(".", "\\.")}`));
  }
  assert.match(smoke,/node "\$\{WASALX_STACK_VERIFY_SCRIPT:\?Set WASALX_STACK_VERIFY_SCRIPT\}" "\$project" [\\\s]+--compose-file compose\.yaml --compose-file compose\.smoke\.yaml/u);
  assert.match(smoke, /<title>Operational overview · WasalX<\/title>/);
  assert.match(smoke, /Operational overview/);
  assert.doesNotMatch(smoke, /Operations control plane/);
});





test("Helm explicitly leaves invitation mail unrestricted in staging and production", async () => {
  const workloads = await read("infra/helm/wasalx/templates/workloads.yaml");
  assert.match(workloads, /\{\{- if and \(eq \$name "invitation-mailer"\) \(has \$root\.Values\.environment \(list "staging" "production"\)\) \}\}\s+- \{ name: WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST, value: "\*" \}\s+\{\{- end \}\}/u);
});

test("Helm and Terraform keep workload, migration, and secret-cleanup credentials isolated", async () => {
  const workloads = await read("infra/helm/wasalx/templates/workloads.yaml");
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const values = await read("infra/helm/wasalx/values.yaml");
  const root = await read("infra/terraform/main.tf");
  assert.match(workloads, /\$service\.secretName/);
  assert.match(workloads, /api\.cleanupSecretName is required/);
  assert.match(config, /migration\.secretName is required/);
  assert.match(values, /secretName: wasalx-portal-secrets/);
  assert.match(values, /secretName: wasalx-api-secrets/);
  assert.match(values, /cleanupSecretName: wasalx-secret-cleanup-secrets/);
  assert.match(values, /secretName: wasalx-worker-secrets/);
  assert.match(values, /secretName: wasalx-invitation-mailer-secrets/);
  assert.match(values, /secretName: wasalx-identity-policy-activator-secrets/);
  assert.match(values, /secretName: wasalx-migration-secrets/);
  assert.match(values, /PLATFORM_PORTAL_SESSION_SECRET as distinct values/);
  assert.match(values, /METERING_SERVICE_JWT_SECRET must also be distinct/);
  for (const apiCredential of [
    "PROVISIONING_DATABASE_URL",
    "SUPPORT_ACCESS_DATABASE_URL",
    "WAHA_OPERATOR_DATABASE_URL",
  ]) assert.match(values, new RegExp(apiCredential));
  for (const workerCredential of [
    "WAHA_REGISTRY_DATABASE_URL",
    "WAHA_WORKERS_JSON",
  ]) assert.match(values, new RegExp(workerCredential));
  assert.doesNotMatch(workloads, /Values\.existingSecret/);
  assert.doesNotMatch(config, /Values\.existingSecret/);
  for (const variable of [
    "portal_secret_name",
    "control_api_secret_name",
    "connector_worker_secret_name",
    "invitation_mailer_secret_name",
    "identity_policy_activator_secret_name",
    "migration_secret_name",
    "secret_cleanup_secret_name",
  ]) assert.match(root, new RegExp(`var\\.${variable}`));
});

test("Helm exposes bounded platform OIDC and metering runtime configuration", async () => {
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const schema = JSON.parse(
    await read("infra/helm/wasalx/values.schema.json"),
  );
  for (const name of [
    "PLATFORM_OPERATOR_OIDC_ISSUER",
    "PLATFORM_OPERATOR_OIDC_AUDIENCE",
    "PLATFORM_OPERATOR_OIDC_JWKS_URI",
    "PLATFORM_OPERATOR_OIDC_CLIENT_ID",
    "PLATFORM_OPERATOR_OIDC_REDIRECT_URI",
    "PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS",
    "OIDC_PRIVILEGED_ACR_VALUES",
    "OIDC_PRIVILEGED_MFA_AMR_VALUES",
    "METERING_CATCHUP_PERIODS_PER_TICK",
    "METERING_RECONCILE_INTERVAL_MS",
  ]) assert.match(config, new RegExp(`${name}:`));
  assert.deepEqual(schema.properties.platformOperatorOidc.required, [
    "issuer",
    "audience",
    "jwksUri",
    "clientId",
    "redirectUri",
    "maxAuthAgeSeconds",
  ]);
  assert.deepEqual(schema.properties.metering.required, [
    "catchupPeriodsPerTick",
    "reconcileIntervalMs",
  ]);
  assert.ok(schema.properties.oidc.required.includes("privilegedAcrValues"));
  assert.ok(schema.properties.oidc.required.includes("privilegedMfaAmrValues"));
  assert.match(
    schema.properties.oidc.properties.privilegedAcrValues.not.pattern,
    /example\|placeholder/,
  );
  assert.equal(
    schema.properties.platformOperatorOidc.properties.redirectUri.pattern,
    "^https://",
  );
});

test("tenant Zammad signing keys remain per-instance and never enter the control-plane ConfigMap", async () => {
  const controller = await read(
    "services/tenant-provisioner/src/controller/resources.ts",
  );
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const values = await read("infra/helm/wasalx/values.yaml");
  assert.match(
    controller,
    /secretProperty\("WASALX_SERVICE_JWT_SECRET",[\s\S]*?"jwt_secret"\)/,
  );
  assert.match(
    controller,
    /secretProperty\("WASALX_ZAMMAD_INSTANCE_ID",[\s\S]*?"instance_id"\)/,
  );
  assert.match(
    controller,
    /secretEnv\("WASALX_SERVICE_JWT_SECRET", secretName, "WASALX_SERVICE_JWT_SECRET"\)/,
  );
  assert.match(controller, /WASALX_TENANT_ID/);
  assert.match(controller, /WASALX_CONTROL_URL/);
  assert.match(controller, /WASALX_PORTAL_URL/);
  assert.doesNotMatch(config, /ZAMMAD_SERVICE_JWT_SECRET/);
  assert.doesNotMatch(config, /WASALX_SERVICE_JWT_SECRET/);
  assert.doesNotMatch(values, /ZAMMAD_SERVICE_JWT_SECRET/);
});

test("Helm media runtime exposes only non-secret locations and requires credentials in the worker Secret", async () => {
  const config = await read("infra/helm/wasalx/templates/config.yaml");
  const values = await read("infra/helm/wasalx/values.yaml");
  const schema = JSON.parse(
    await read("infra/helm/wasalx/values.schema.json"),
  );

  for (const name of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_SERVER_SIDE_ENCRYPTION",
    "S3_KMS_KEY_ID",
    "CLAMAV_HOST",
    "CLAMAV_PORT",
  ]) assert.match(config, new RegExp(`${name}:`));
  assert.doesNotMatch(config, /^\s*S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY):/m);
  assert.ok(schema.required.includes("media"));
  assert.deepEqual(schema.properties.media.properties.s3.required, [
    "endpoint",
    "region",
    "bucket",
    "serverSideEncryption",
    "kmsKeyId",
  ]);
  assert.equal(schema.properties.media.properties.s3.properties.endpoint.pattern, "^https://");
  assert.deepEqual(schema.properties.media.properties.s3.properties.serverSideEncryption.enum, [
    "AES256",
    "aws:kms",
    "MANAGED",
  ]);
  assert.equal(schema.properties.media.properties.s3.then.properties.kmsKeyId.minLength, 1);
  assert.equal(schema.properties.media.properties.s3.else.properties.kmsKeyId.const, "");
  assert.deepEqual(schema.properties.media.properties.clamav.required, [
    "host",
    "port",
  ]);
  assert.equal(schema.properties.media.properties.s3.additionalProperties, false);
  assert.match(values, /host: "clamav\.security\.svc\.cluster\.local"/);
  
  
});
