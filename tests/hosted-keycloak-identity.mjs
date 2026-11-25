import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execute = promisify(execFile);
const image = process.argv[2];
assert.match(image, /^wasalx\/ci-keycloak:[0-9]+-[0-9]+$/u);
const container = image.replace("wasalx/ci-keycloak:", "wasalx-ci-keycloak-");
const callbackOrigin = "http://127.0.0.1:4173";
const realmName = "signin-review";
const realmPath = "infra/docker/full/keycloak/wasalx-realm.json";
const scratch = await mkdtemp(join(tmpdir(), "wasalx-identity-e2e-"));
let callbacks = 0;
const callback = createServer((request, response) => {
  if (request.method !== "GET" || !new URL(request.url, callbackOrigin).searchParams.has("code")) {
    response.writeHead(404).end();
    return;
  }
  callbacks++;
  response.writeHead(200, { "cache-control": "no-store" }).end();
});
const docker = async (...args) => (await execute("docker", args)).stdout.trim();

async function runCases(env) {
  const execution = await execute(process.execPath, [
    "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.identity.config.ts",
    "--reporter=json", "--output", join(scratch, "results"),
  ], { env, maxBuffer: 16 * 1024 * 1024 }).catch(error => error);
  const report = JSON.parse(execution.stdout);
  const cases = report.suites.flatMap(suite => suite.specs).flatMap(spec => spec.tests.map(test => ({ spec, test })));
  let executed = 0;
  let passed = 0;
  for (const { spec, test } of cases) {
    const [first] = test.results;
    if (first && !["skipped", "interrupted"].includes(first.status)) executed++;
    if (test.expectedStatus === "passed" && test.results.length === 1 && first?.status === "passed") passed++;
    console.log(JSON.stringify({ case: spec.title, line: first?.error?.location?.line ?? spec.line,
      status: first?.status ?? "unreported", durationMs: first?.duration }));
  }
  console.log(JSON.stringify({ expected: 3, executed, passed, authorizationCallbacks: callbacks }));
  assert.equal(report.errors.length, 0);
  assert.equal(cases.length, 3);
  assert.equal(executed, 3);
  assert.equal(passed, 3);
  assert.equal(callbacks, 2);
  assert.equal(execution.code, undefined);
}

let imageId;
let containerId;
let phase = "image identity";
try {
  const [id, commit, tree] = (await docker("image", "inspect", "--format",
    '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "io.wasalx.source.tree"}}', image)).split(" ");
  imageId = id;
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(commit, process.env.GITHUB_SHA);
  assert.equal(tree, (await execute("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim());
  const realmBlob = (await execute("git", ["rev-parse", "HEAD:" + realmPath])).stdout.trim();
  console.log(JSON.stringify({ commit, tree, imageId, realm: realmName, realmBlob }));

  phase = "realm fixtures";
  const realm = JSON.parse(await readFile(realmPath, "utf8"));
  const client = realm.clients.find(entry => entry.clientId === "wasalx-portal");
  assert(client);
  realm.realm = realmName;
  realm.resetPasswordAllowed = true;
  realm.clients = [{ ...client, redirectUris: [callbackOrigin + "/"], webOrigins: [callbackOrigin],
    attributes: { "pkce.code.challenge.method": client.attributes["pkce.code.challenge.method"] } }];
  const actors = Object.fromEntries(["en", "ar"].map(locale => [locale, {
    username: "signin-" + locale,
    password: "Qa9!" + randomBytes(24).toString("hex"),
    secret: randomBytes(32).toString("hex"),
  }]));
  realm.users = Object.entries(actors).map(([locale, actor]) => ({
    username: actor.username, enabled: true, emailVerified: true,
    email: actor.username + "@example.test", firstName: "Synthetic", lastName: "Identity",
    attributes: { locale: [locale] },
    credentials: [
      { type: "password", value: actor.password, temporary: false },
      { type: "otp", secretData: JSON.stringify({ value: actor.secret }),
        credentialData: JSON.stringify({ type: realm.otpPolicyType, algorithm: realm.otpPolicyAlgorithm,
          digits: realm.otpPolicyDigits, period: realm.otpPolicyPeriod, counter: realm.otpPolicyInitialCounter }) },
    ],
  }));
  const fixturesPath = join(scratch, "actors.json");
  const realmFile = join(scratch, realmName + "-realm.json");
  await writeFile(fixturesPath, JSON.stringify(actors), { mode: 0o600, flag: "wx" });
  // Docker's non-root user needs read access to the bind-mounted file; the host directory is private.
  await writeFile(realmFile, JSON.stringify(realm), { mode: 0o644, flag: "wx" });
  callback.listen(4173, "127.0.0.1");
  await once(callback, "listening");

  phase = "Keycloak container launch";
  const mount = (source, target) => ["--mount", "type=bind,source=" + resolve(source) + ",target=" + target + ",readonly"];
  const theme = "/opt/keycloak/themes/wasalx";
  containerId = await docker("run", "--detach", "--init", "--name", container,
    "--log-driver", "local", "--publish", "127.0.0.1::8080",
    "--env", "WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST=[]",
    "--env", "WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED=true",
    "--env", "WASALX_PORTAL_PUBLIC_ORIGIN=" + callbackOrigin,
    ...mount(realmFile, "/opt/keycloak/data/import/" + realmName + "-realm.json"),
    ...mount("infra/docker/full/keycloak/themes/wasalx", theme),
    ...mount("app/fonts", theme + "/login/resources/fonts"),
    ...mount("public", theme + "/login/resources/shared"),
    imageId, "start-dev", "--db=dev-mem", "--import-realm",
    "--spi-email-sender--provider=wasalx-fenced", "--spi-email-template--provider=wasalx-fenced");
  assert.match(containerId, /^[0-9a-f]{64}$/u);
  phase = "Keycloak loopback port";
  const published = await docker("port", containerId, "8080/tcp");
  assert.match(published, /^127\.0\.0\.1:[0-9]+$/u);
  const origin = "http://" + published;
  const issuer = origin + "/realms/" + realmName;
  phase = "Keycloak realm readiness";
  const deadline = Date.now() + 90_000;
  let discovered;
  while (Date.now() < deadline) {
    assert.equal(await docker("inspect", "--format", "{{.State.Running}}", containerId), "true");
    const response = await fetch(issuer + "/.well-known/openid-configuration", {
      redirect: "error", signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (response?.ok) {
      discovered = await response.json();
      break;
    }
    await new Promise(done => setTimeout(done, 500));
  }
  assert.equal(discovered?.issuer, issuer);
  console.log("Disposable loopback realm discovery passed");

  phase = "registered cases";
  await runCases({ ...process.env, WASALX_AUTH_TEST_ORIGIN: origin,
    WASALX_AUTH_TEST_FIXTURES: fixturesPath, WASALX_AUTH_TEST_BROWSER_PATH: chromium.executablePath() });
} catch (error) {
  console.error("Identity browser job failed during " + phase + " (" + error.name + ")");
  if (containerId && phase !== "registered cases") {
    const state = await docker("inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", containerId).catch(() => "");
    if (/^(?:created|running|exited|dead) [0-9]+$/u.test(state)) console.error("Keycloak container state: " + state);
    const logs = await execute("docker", ["logs", "--tail", "160", containerId]).catch(() => ({ stdout: "", stderr: "" }));
    const privateLog = logs.stdout + logs.stderr;
    const diagnostics = [
      [/Failed to import|failed to import|Error while importing/iu, "realm-import"],
      [/AccessDeniedException|Permission denied/iu, "filesystem-permissions"],
      [/BindException|Address already in use/iu, "address-in-use"],
      [/Unable to start HTTP server|Failed to start server/iu, "server-start"],
      [/Unrecognized option|Unknown option/iu, "unsupported-option"],
    ];
    const reported = diagnostics.filter(([pattern]) => pattern.test(privateLog)).map(([, label]) => label);
    const classes = [...new Set(privateLog.match(/\b(?:java|org\.keycloak|io\.quarkus)\.[a-z.]+\.[A-Z][A-Za-z]+(?:Exception|Error)\b/gu))];
    console.error(JSON.stringify({ diagnostics: reported, exceptionClasses: classes }));
  }
  process.exitCode = 1;
} finally {
  if (callback.listening) {
    callback.close();
    await once(callback, "close");
  }
  await rm(scratch, { recursive: true, force: true });
  try {
    const containerFilter = ["ps", "-aq", "--filter", "name=^/" + container + "$"];
    if (await docker(...containerFilter)) await docker("rm", "-f", container);
    assert.equal(await docker(...containerFilter), "");
    assert.equal(callback.listening, false);
    await assert.rejects(lstat(scratch), { code: "ENOENT" });
    if (imageId) {
      await docker("image", "rm", image);
      assert.equal(await docker("image", "ls", "-q", image), "");
    }
    console.log("Cleanup verified: Keycloak container, fixture directory, loopback callback, and image tag removed");
  } catch {
    console.error("Identity fixture cleanup failed");
    process.exitCode = 1;
  }
}
