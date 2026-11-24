import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureDevInstallPreimages, releaseDevHeld, executeStage } from "../scripts/release/installer-stages.mjs";
import { devHeldServices, devHeldPrerequisites, devPreservedServices, devColdResidents, devValueDigest, assertDevInstallPreimages } from "../scripts/release/installer-stack.mjs";
import { artifactPath, preimagePath, sha256 } from "../scripts/release/installer-artifacts.mjs";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const imageId = `sha256:${"d".repeat(64)}`;

function heldPrerequisiteFixture(t) {
  const originalReadFile = fsPromises.readFile;
  t.mock.method(fsPromises, "readFile", (path, ...args) => path === "/etc/machine-id"
    ? Promise.resolve(Buffer.from("synthetic-machine")) : originalReadFile(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const oneShots = devPreservedServices.filter(name => !devHeldServices.includes(name) && name !== "zammad-backup");
  const names = [...new Set([...devHeldServices, ...devPreservedServices, ...devColdResidents, "control-api", "portal"])];
  const model = { services: Object.fromEntries(names.map(name => [name, { image: `synthetic@${imageId}` }])) };
  model.services.portal.depends_on = Object.fromEntries(oneShots.filter(name => name !== "public-webhook-preflight")
    .map(name => [name, { condition: "service_completed_successfully" }]));
  model.services["waha-gows"].depends_on = { "public-webhook-preflight": { condition: "service_completed_successfully" } };
  const rows = names.map((name, index) => {
    const running = !oneShots.includes(name) && !devHeldServices.includes(name) && name !== "control-api";
    return { Id: String(index + 1).padStart(64, "0"), Image: imageId, RestartCount: 0,
      Config: { Image: "retained", Labels: { "com.docker.compose.project": "wasalx-live", "com.docker.compose.service": name } },
      HostConfig: { ReadonlyRootfs: true }, Mounts: [], State: { Status: running ? "running" : "exited", Running: running,
        Pid: running ? 100 : 0, ExitCode: name === "public-webhook-preflight" ? 1 : 0,
        Paused: false, Dead: false, Restarting: false, OOMKilled: false, Error: "", StartedAt: null } };
  });
  const calls = [], row = name => rows.find(item => item.Config.Labels["com.docker.compose.service"] === name);
  const context = { candidateSha: sha, candidateTree: tree, project: "wasalx-live", model,
    environment: { SYNTHETIC: "same-environment" }, composeArguments: ["compose", "--project-name", "wasalx-live"],
    command: async (name, args, environment) => {
      assert.equal(name, "docker"); assert.equal(environment, context.environment);
      calls.push(args);
      if (args[0] === "ps") return rows.map(item => item.Id).join(" ");
      if (args[0] === "inspect") return JSON.stringify(rows);
      if (args[0] === "image") return JSON.stringify([{ Id: imageId }]);
      if (args[0] === "exec") return "";
      assert.deepEqual(args.slice(0, 3), context.composeArguments);
      assert.ok(args.includes("--no-deps") && args.includes("--no-build") && args.includes("never"));
      const current = row(args.at(-1));
      current.RestartCount = 0;
      if (args.includes("--exit-code-from")) {
        current.State.ExitCode = context.prerequisiteExit ?? 0;
        return current.State.ExitCode;
      }
      current.State = { ...current.State, Running: true, Status: "running", Pid: 200, Health: { Status: context.health ?? "healthy" } };
      return 0;
    } };
  return { context, rows, row, calls };
}

test("DEV all-held prerequisite admits its failed preimage and records the dependent", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  const record = await captureDevInstallPreimages(context);
  assert.deepEqual(record.heldPrerequisites, { "public-webhook-preflight": ["waha-gows"] });
  assert.ok(record.heldServices.includes("public-webhook-preflight"));
  assert.equal(row("public-webhook-preflight").State.ExitCode, 1);
  assert.ok(calls.every(args => !args.includes("up")));
  const changed = structuredClone(record); changed.heldPrerequisites = {};
  assert.throws(() => assertDevInstallPreimages(changed, { ...context, activeServices: Object.keys(context.model.services).sort(),
    machineIdSha256: record.machineIdSha256 }), /held prerequisites changed/);
});

test("DEV cold hold admits only the classified failed prerequisite without executing it", async t => {
  const { context, rows, calls } = heldPrerequisiteFixture(t);
  for (const row of rows) row.State = { ...row.State, Status: "exited", Running: false, Pid: 0 };
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.admissionMode, "cold-held");
  assert.deepEqual(record.heldPrerequisites, { "public-webhook-preflight": ["waha-gows"] });
  assert.ok(calls.every(args => !args.includes("up") && !args.includes("exec")));
});

test("DEV mixed success-dependents retain the exit-zero requirement", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  context.model.services.portal.depends_on["public-webhook-preflight"] = { condition: "service_completed_successfully" };
  await assert.rejects(captureDevInstallPreimages(context), /public-webhook-preflight existing one-shot failed/);
  row("public-webhook-preflight").State.ExitCode = 0;
  const record = await captureDevInstallPreimages(context);
  assert.deepEqual(record.heldPrerequisites, {});
  assert.ok(!record.heldServices.includes("public-webhook-preflight"));
});

test("DEV no-dependent one-shots retain their existing preserved exit-zero treatment", async t => {
  const { context, row, rows } = heldPrerequisiteFixture(t);
  delete context.model.services["waha-gows"].depends_on;
  assert.deepEqual(devHeldPrerequisites(context.model, Object.keys(context.model.services)), {});
  for (const item of rows) item.State = { ...item.State, Status: "exited", Running: false, Pid: 0 };
  await assert.rejects(captureDevInstallPreimages(context), /public-webhook-preflight stopped lifecycle requires review/);
  row("public-webhook-preflight").State.ExitCode = 143;
  await assert.rejects(captureDevInstallPreimages(context));
  row("public-webhook-preflight").State.ExitCode = 0;
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.admissionMode, "cold-held");
  assert.deepEqual(record.heldPrerequisites, {});
});

for (const exitCode of [0, 1]) test(`DEV held release reruns prerequisite once: exit ${exitCode}`, async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  const record = await captureDevInstallPreimages(context);
  context.prerequisiteExit = exitCode;
  row("waha-gows").Config.Healthcheck = { Test: ["CMD", "true"] };
  if (exitCode) await assert.rejects(releaseDevHeld(context, record, "waha-gows"), /public-webhook-preflight phase failed/);
  else assert.equal(await releaseDevHeld(context, record, "waha-gows"), 0);
  const up = calls.filter(args => args.includes("up"));
  assert.equal(up.filter(args => args.at(-1) === "public-webhook-preflight").length, 1);
  assert.ok(up[0].includes("--abort-on-container-exit") && up[0].includes("--exit-code-from"));
  assert.equal(row("waha-gows").State.Running, exitCode === 0);
  assert.equal(up.length, exitCode ? 1 : 2);
  if (!exitCode) assert.ok(up[1].includes("--detach") && up[1].includes("--wait"));
});

test("DEV held release refuses unrecorded services, altered prerequisites, cold mode and unhealthy startup", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  const record = await captureDevInstallPreimages(context);
  await assert.rejects(releaseDevHeld(context, record, "portal"), /not a recorded held sender/);
  await assert.rejects(releaseDevHeld(context, { ...record, heldPrerequisites: {} }, "waha-gows"), /held prerequisites changed/);
  await assert.rejects(releaseDevHeld(context, { ...record, admissionMode: "cold-held" }, "waha-gows"), /cold held release/);
  assert.ok(calls.every(args => !args.includes("up")));
  row("waha-gows").Config.Healthcheck = { Test: ["CMD", "true"] };
  context.health = "unhealthy";
  await assert.rejects(releaseDevHeld(context, record, "waha-gows"));
});

test("release-held stage requires digest-bound DEV preimages before any Compose execution", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  context.plan = []; context.service = "waha-gows";
  const record = await captureDevInstallPreimages(context);
  await assert.rejects(executeStage("release-held", context), /requires bound DEV preimages/);
  const root = await mkdtemp(join(tmpdir(), "wasalx-held-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  context.devPreimagesFile = join(root, "preimages.json");
  const bytes = Buffer.from(JSON.stringify(record)); await writeFile(context.devPreimagesFile, bytes);
  context.devPreimagesSha256 = "0".repeat(64);
  await assert.rejects(executeStage("release-held", context), /DEV preimage file changed/);
  assert.ok(calls.every(args => !args.includes("up")));
  context.devPreimagesSha256 = sha256(bytes);
  assert.equal(await executeStage("release-held", context), 0);
  assert.equal(row("waha-gows").State.Running, true);
});

test("replacement refuses valid DEV preimages older than 60 seconds", async t => {
  const { context, calls } = heldPrerequisiteFixture(t);
  const root = await mkdtemp(join(tmpdir(), "wasalx-stale-preimage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await captureDevInstallPreimages(context);
  t.mock.method(Date, "now", () => Date.parse(record.observedAt) + 60_001);
  const bytes = JSON.stringify(record);
  Object.assign(context, { plan: [], drained: true, repository: join(root, "source"), directory: join(root, "source"),
    privateDirectory: join(root, "private"), devPreimagesFile: join(root, "preimages.json"), devPreimagesSha256: sha256(bytes) });
  await mkdir(context.directory);
  await writeFile(context.devPreimagesFile, bytes);
  calls.length = 0;
  await assert.rejects(executeStage("replace", context), /DEV mutation requires fresh action-time preimages/u);
  assert.ok(calls.every(args => args[0] === "image" && args[1] === "inspect"));
});

test("fresh DEV replace creates holds without starting them and refuses a previously used project", async t => {
  const root = await mkdtemp(join(tmpdir(), "wasalx-fresh-held-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = "wasalx-dev-fresh";
  const composeArguments = ["compose", "--project-name", project];
  const webhook = "public-webhook-preflight";
  const service = { image: `synthetic@${imageId}` };
  const model = { services: {
    portal: service, [webhook]: service, ...Object.fromEntries(devHeldServices.map(name => [name, { ...service }])),
  }, volumes: { data: { name: `${project}_data` } }, networks: { core: { name: `${project}_core` } } };
  model.services["waha-gows"].depends_on = { [webhook]: { condition: "service_completed_successfully" } };
  const host = { id: "fixture", name: "fixture", dataRoot: root };
  const calls = [];
  const context = { candidateSha: sha, candidateTree: tree, project, composeArguments, model,
    buildContextSha256: "a".repeat(64), catalogSha256: "b".repeat(64), plan: [], drained: true, devFreshHeld: true,
    directory: join(root, "source"), repository: join(root, "source"), privateDirectory: join(root, "private"),
    command: (command, args) => {
      assert.equal(command, "docker");
      calls.push(args);
      if (args[0] === "info") return JSON.stringify({ ID: host.id, Name: host.name, DockerRootDir: host.dataRoot });
      if (args[0] === "ps" || args.includes("--quiet")) return args[0] === context.retained ? "retained" : "";
      if (args[0] === "volume") return context.retained === "volume-name" ? `${project}_data` : "";
      if (args[0] === "network") return context.retained === "network-name" ? `${project}_core` : "";
      if (args[0] === "inspect") return JSON.stringify([{ Id: "1".repeat(64), Image: imageId,
        Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "portal" } },
        State: { Running: true, ExitCode: 0 },
      }]);
      if (args[0] === "image") return JSON.stringify([{ Id: imageId }]);
      if (args[0] === "compose") return 0;
      assert.fail(`unexpected docker command: ${args.join(" ")}`);
    },
  };
  await mkdir(context.directory); await mkdir(context.privateDirectory);
  const transactionId = "fixture";
  const snapshot = JSON.stringify({ schemaVersion: 1, kind: "compose-replacement-preimage", transactionId,
    candidateSha: sha, candidateTree: tree, project, host, containers: [], buildTags: [],
  });
  await writeFile(preimagePath(context), snapshot);
  await writeFile(artifactPath(context), JSON.stringify({
    schemaVersion: 1, kind: "compose-candidate-artifacts", state: "PASS", candidateSha: sha, candidateTree: tree, project,
    buildContextSha256: context.buildContextSha256, catalogSha256: context.catalogSha256,
    buildContextAlgorithm: "sha256-git-archive-tar-v1", modelSha256: devValueDigest(model), plan: [], images: [],
    preimage: { sha256: sha256(snapshot), transactionId },
  }));
  const up = () => calls.filter(args => args.includes("up"));
  for (const resource of ["ps", "volume", "network", "volume-name", "network-name"]) {
    context.retained = resource;
    await assert.rejects(executeStage("replace", context), /preimage container inventory changed|fresh held project must have no/);
    assert.deepEqual(up(), []);
  }
  context.retained = undefined;
  await assert.rejects(executeStage("replace", { ...context, retryReviewed: true }), /fresh held replacement cannot retry/);
  assert.deepEqual(up(), []);
  assert.equal(await executeStage("replace", context), 0);
  assert.deepEqual(up(), [
    [...composeArguments, "up", "--no-build", "--pull", "never", "--wait", "portal"],
    [...composeArguments, "up", "--no-build", "--pull", "never", "--no-start", "--no-deps", ...[...devHeldServices, webhook].sort()],
  ]);
});

test("held installation records historical restarts without requiring active health", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  row("waha-gows").RestartCount = 1;
  row("waha-gows").Config.Healthcheck = { Test: ["CMD", "true"] };
  row("waha-gows").State.Health = { Status: "unhealthy" };
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.services.find(({ service }) => service === "waha-gows").restartCount, 1);
  assert.equal(row("waha-gows").State.Running, false);
});

test("non-held installation still refuses historical restarts", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  row("portal").RestartCount = 1;
  await assert.rejects(captureDevInstallPreimages(context), /existing DEV restart history requires review/);
});

test("held release resets a sender's recorded historical restarts on start", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  row("waha-gows").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  assert.equal(await releaseDevHeld(context, record, "waha-gows"), 0);
  assert.equal(row("waha-gows").State.Running, true);
  assert.equal(row("waha-gows").RestartCount, 0);
});

test("release-held accepts recorded count 1 when Docker reports 0 after start", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  context.plan = []; context.service = "waha-gows";
  row("waha-gows").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.services.find(({ service }) => service === "waha-gows").restartCount, 1);
  const containerId = row("waha-gows").Id;
  const root = await mkdtemp(join(tmpdir(), "wasalx-held-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  context.devPreimagesFile = join(root, "preimages.json");
  const bytes = Buffer.from(JSON.stringify(record)); await writeFile(context.devPreimagesFile, bytes);
  context.devPreimagesSha256 = sha256(bytes);
  assert.equal(await executeStage("release-held", context), 0);
  assert.equal(row("waha-gows").Id, containerId);
  assert.equal(row("waha-gows").State.Running, true);
  assert.equal(row("waha-gows").RestartCount, 0);
});

test("held release refuses changed sender restart history before prerequisites execute", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  row("waha-gows").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  row("waha-gows").RestartCount = 2;
  await assert.rejects(releaseDevHeld(context, record, "waha-gows"), /waha-gows held restart history changed/);
  assert.ok(calls.every(args => !args.includes("up")));
  assert.equal(row("waha-gows").State.Running, false);
});

test("held release also binds prerequisite restart history", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  row("public-webhook-preflight").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  row("public-webhook-preflight").RestartCount = 2;
  await assert.rejects(releaseDevHeld(context, record, "waha-gows"), /public-webhook-preflight held restart history changed/);
  assert.ok(calls.every(args => !args.includes("up")));
});

test("held release resets a prerequisite's recorded restart count on start", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  row("public-webhook-preflight").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  assert.equal(await releaseDevHeld(context, record, "waha-gows"), 0);
  assert.equal(row("public-webhook-preflight").RestartCount, 0);
});

for (const restartCount of [0, 1, 2]) test(`held startup ${restartCount ? `refuses ${restartCount} restarts on the same container` : "requires zero restarts on a new container"}`, async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  row("waha-gows").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  const command = context.command;
  context.command = async (...args) => {
    const result = await command(...args);
    if (args[1].includes("up") && args[1].at(-1) === "waha-gows") {
      if (!restartCount) row("waha-gows").Id = "e".repeat(64);
      row("waha-gows").RestartCount = restartCount;
    }
    return result;
  };
  if (!restartCount) assert.equal(await releaseDevHeld(context, record, "waha-gows"), 0);
  else await assert.rejects(releaseDevHeld(context, record, "waha-gows"), /restarted during its phase/);
});

test("held restart records require a non-negative integer and keep non-held records strict", async t => {
  const { context, row, calls } = heldPrerequisiteFixture(t);
  const record = await captureDevInstallPreimages(context);
  for (const restartCount of [undefined, -1, 1.5, "1"]) {
    const changed = structuredClone(record);
    changed.services.find(({ service }) => service === "waha-gows").restartCount = restartCount;
    await assert.rejects(releaseDevHeld(context, changed, "waha-gows"), /held restart history unavailable/);
  }
  const changed = structuredClone(record);
  changed.services.find(({ service }) => service === "portal").restartCount = 1;
  await assert.rejects(releaseDevHeld(context, changed, "waha-gows"), /non-held restart history requires review/);
  assert.ok(calls.every(args => !args.includes("up")));
  assert.equal(row("waha-gows").State.Running, false);
});

test("historical held restarts retain stopped-state and unsafe-lifecycle refusals", async t => {
  const { context, row } = heldPrerequisiteFixture(t);
  const held = row("waha-gows"); held.RestartCount = 1;
  const state = structuredClone(held.State);
  for (const change of [{ Running: true, Status: "running", Pid: 100 }, { Paused: true }, { Dead: true }, { Restarting: true }]) {
    held.State = { ...state, ...change };
    await assert.rejects(captureDevInstallPreimages(context));
  }
  held.State = state;
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.services.find(({ service }) => service === "waha-gows").restartCount, 1);
});

test("non-held health remains mandatory while cold holds retain restart history", async t => {
  const { context, row, rows } = heldPrerequisiteFixture(t);
  row("zammad-backup").Config.Healthcheck = { Test: ["CMD", "true"] };
  row("zammad-backup").State.Health = { Status: "unhealthy" };
  await assert.rejects(captureDevInstallPreimages(context), /existing DEV prerequisite is unhealthy/);
  for (const item of rows) item.State = { ...item.State, Status: "exited", Running: false, Pid: 0 };
  row("waha-gows").RestartCount = 1;
  const record = await captureDevInstallPreimages(context);
  assert.equal(record.admissionMode, "cold-held");
  assert.equal(record.services.find(({ service }) => service === "waha-gows").restartCount, 1);
  await assert.rejects(releaseDevHeld(context, record, "waha-gows"), /cold held release requires separate review/);
});
