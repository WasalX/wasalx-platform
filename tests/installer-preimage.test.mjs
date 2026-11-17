import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertRetainedPreimage, composePreimage, composeServiceHash, resolveComposeServiceReferences, sha256, firstDifference } from "../scripts/release/installer-artifacts.mjs";
import { assertRollbackInventory, rollbackStatePath } from "../scripts/release/installer-rollback-state.mjs";
import { diagnosePreimageRerender } from "../scripts/release/diagnose-preimage-rerender.mjs";

const id = "c".repeat(64);
const imageId = `sha256:${"d".repeat(64)}`;

const retainedMounts = [
  { Destination: "/b", Source: "/srv/b", Type: "bind", RW: true },
  { Destination: "/c", Source: "/srv/c", Type: "bind", RW: false },
  { Destination: "/a", Source: "/srv/a", Type: "bind", RW: true },
];

function compareRetainedMounts(current) {
  const original = { Id: id, Image: imageId, Name: "/portal", HostConfig: {}, Mounts: retainedMounts,
    Config: { Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "portal" } } };
  const context = { project: "fixture", environment: {}, command: async (name, args) => {
    assert.equal(name, "docker");
    if (args[0] === "ps") return id;
    assert.deepEqual(args, ["inspect", id]);
    return JSON.stringify([{ ...original, Mounts: current }]);
  } };
  return assertRetainedPreimage(context, { containers: [{ id, image: imageId, inspect: original, networks: [],
    compose: { files: [], environmentFiles: [] } }] });
}

test("retained preimage accepts the same mounts in different orders", async () => {
  await assert.doesNotReject(compareRetainedMounts([retainedMounts[1], retainedMounts[2], retainedMounts[0]]));
});

test("retained preimage rejects a changed mount value", async () => {
  await assert.rejects(compareRetainedMounts([{ ...retainedMounts[0], RW: false }, ...retainedMounts.slice(1)]), /Mounts preimage changed/u);
});

test("retained preimage rejects an added or removed mount", async () => {
  for (const current of [
    [...retainedMounts, { Destination: "/d", Source: "/srv/d", Type: "bind", RW: true }],
    retainedMounts.slice(1),
  ]) await assert.rejects(compareRetainedMounts(current), /Mounts preimage changed/u);
});

async function rerenderFixture(t, subject = {}) {
  if (process.platform !== "win32") t.mock.method(process, "getuid", () => 0);
  const root = await mkdtemp(join(tmpdir(), "wasalx-rerender-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate"), deployed = join(root, "deployed");
  await mkdir(candidate); await mkdir(deployed);
  const file = join(deployed, "compose.json"), model = { services: {
    subject: { image: "subject:old", ...subject }, peer: { image: "peer:old" }, other: { image: "other:old" },
  } };
  await writeFile(file, JSON.stringify(model));
  const rows = Object.keys(model.services).map((name) => ({ Id: sha256(name), Image: imageId,
    Config: { Env: ["PRIVATE_SENTINEL=never-print-this"], Labels: {
      "com.docker.compose.project": "fixture", "com.docker.compose.service": name,
      "com.docker.compose.project.working_dir": deployed, "com.docker.compose.project.config_files": file,
      "com.docker.compose.version": "2.40.3", "com.docker.compose.config-hash": "" } },
    HostConfig: {}, Mounts: [], State: { Running: false }, NetworkSettings: { Networks: {} } }));
  const hashFiles = [], calls = [];
  const context = { repository: candidate, project: "fixture", environment: {}, command: async (_command, args) => {
    calls.push(args);
    if (args[0] === "ps") return rows.map((row) => row.Id).join(" ");
    if (args[0] === "inspect") return JSON.stringify(rows);
    if (args[0] === "image") return JSON.stringify([{ Id: imageId, Config: {} }]);
    if (args[1] === "version") return "2.40.3+ds1-0ubuntu1~24.04.1";
    if (args.includes("--hash")) {
      const path = args[args.lastIndexOf("--file") + 1]; hashFiles.push(path);
      assert.equal(isWithinFixture(candidate, path), false);
      if (process.platform !== "win32") assert.equal((await fsPromises.stat(path)).mode & 0o777, 0o600);
      const rendered = JSON.parse(await readFile(path, "utf8"));
      assert.deepEqual(rendered.services.other, model.services.other);
      assert.ok(!args.includes("--no-interpolate") && args.includes("--no-normalize") && args.includes("--no-consistency"));
      return `${args.at(-1)} ${sha256(JSON.stringify(rendered.services[args.at(-1)]))}`;
    }
    assert.ok(args.includes("config"));
    return JSON.stringify(model);
  } };
  return { context, rows, model, file, hashFiles, calls };
}
const isWithinFixture = (parent, path) => !relative(parent, path).startsWith("..");

for (const field of ["network_mode", "ipc", "pid"]) test(`Compose preimage resolves ${field} service references before hashing`, async (t) => {
  const { context, rows, model, hashFiles } = await rerenderFixture(t, { [field]: "service:peer" });
  const expected = { ...model.services.subject, [field]: `container:${sha256("peer")}` };
  rows[0].Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify(expected));
  const preimage = await composePreimage(rows[0], context, { Config: {} }, "2.40.3+ds1-0ubuntu1~24.04.1", rows);
  assert.deepEqual(preimage.serviceReferences[field], { service: "peer", containerId: sha256("peer") });
  assert.equal(preimage.rendered.services.subject[field], "service:peer");
  for (const path of hashFiles) await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("Compose preimage resolves volumes_from service names, external containers and suffixes", async (t) => {
  const { context, rows, model } = await rerenderFixture(t, { volumes_from: ["peer:ro", "peer:rw", "container:external:ro"] });
  const expected = { ...model.services.subject, volumes_from: [sha256("peer"), sha256("peer"), "external"] };
  rows[0].Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify(expected));
  const preimage = await composePreimage(rows[0], context, { Config: {} }, "2.40.3", rows);
  assert.equal(preimage.serviceReferences["volumes_from.0"].service, "peer");
  assert.equal(preimage.serviceReferences["volumes_from.1"].containerId, sha256("peer"));
  assert.equal(preimage.serviceReferences["volumes_from.2"], undefined);
});

test("Compose volumes_from treats a service literally named service as a service name", () => {
  const row = { Id: id, Config: { Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "service" } } };
  assert.deepEqual(resolveComposeServiceReferences({ volumes_from: ["service:ro"] }, [row], "fixture").service.volumes_from, [id]);
});

for (const field of ["network_mode", "ipc", "pid", "volumes_from"]) test(`Compose preimage refuses missing or foreign ${field} service references`, async (t) => {
  const { context, rows } = await rerenderFixture(t, { [field]: field === "volumes_from" ? ["peer:ro"] : "service:peer" });
  for (const census of [rows.filter((row) => row !== rows[1]), rows.map((row, i) => i === 1 ? {
    ...row, Config: { ...row.Config, Labels: { ...row.Config.Labels, "com.docker.compose.project": "foreign" } },
  } : row)]) await assert.rejects(composePreimage(rows[0], context, { Config: {} }, "2.40.3", census), /owned census/u);
});

test("Compose hash leaves other services and the source model unchanged and removes private files on refusal", async (t) => {
  const { context, rows, model, hashFiles } = await rerenderFixture(t, { network_mode: "service:peer" });
  const before = structuredClone(model);
  const compose = { rendered: model, arguments_: ["compose", "--project-name", "fixture"], environment: {} };
  assert.equal((await composeServiceHash(context, compose, "other", rows)).hash, sha256(JSON.stringify(model.services.other)));
  const command = context.command;
  context.command = async (...args) => { await command(...args); throw new Error("synthetic hash failure"); };
  await assert.rejects(composeServiceHash(context, compose, "subject", rows), /synthetic hash failure/u);
  assert.deepEqual(model, before);
  for (const path of hashFiles) await assert.rejects(readFile(path), { code: "ENOENT" });
});

for (const [field, value] of [["models", { assistant: {} }], ["use_api_socket", true]]) {
  test(`Compose preimage explicitly refuses ${field} runtime injection`, async (t) => {
    const { context, rows } = await rerenderFixture(t, { [field]: value });
    await assert.rejects(composePreimage(rows[0], context, { Config: {} }, "2.40.3", rows), new RegExp(field, "u"));
  });
}

test("read-only preimage class finder visits every owned container, reports families and never mutates the stack", async (t) => {
  const { context, rows, model, calls } = await rerenderFixture(t, { network_mode: "service:peer" });
  for (const row of rows) {
    const name = row.Config.Labels["com.docker.compose.service"];
    row.Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify(name === "subject"
      ? { ...model.services.subject, network_mode: `container:${sha256("peer")}` } : model.services[name]));
  }
  const lines = [];
  assert.equal((await diagnosePreimageRerender(context, (line) => lines.push(line))).filter((r) => r.state === "MATCH").length, 3);
  rows.find((row) => row.Config.Labels["com.docker.compose.service"] === "subject").Config.Labels["com.docker.compose.config-hash"] = "changed";
  await diagnosePreimageRerender(context, (line) => lines.push(line));
  assert.ok(lines.includes("subject MISMATCH suspected=network_mode"));
  assert.ok(calls.every((args) => ["ps", "inspect", "image"].includes(args[0]) ||
    args[0] === "compose" && (args[1] === "version" || args.includes("config"))));
  assert.doesNotMatch(lines.join("\n"), /PRIVATE_SENTINEL|never-print-this/u);
});

async function nativeHashFixture(t) {
  if (process.platform !== "win32") t.mock.method(process, "getuid", () => 0);
  const root = await mkdtemp(join(tmpdir(), "wasalx-native-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "compose.json");
  const command = async (_name, args, environment) => {
    const result = spawnSync("docker", args, { env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const arguments_ = ["compose", "--project-directory", root, "--project-name", "fixture", "--profile", "full", "--file", file];
  const context = { project: "fixture", environment: process.env, command };
  return { root, file, command, arguments_, context };
}

test("Compose hash refuses non-root POSIX execution before writing private inputs", { skip: process.platform === "win32" }, async (t) => {
  t.mock.method(process, "getuid", () => 1000);
  await assert.rejects(composeServiceHash({}, {}, "subject", []), /require root/u);
});

for (const [field, extra] of [
  ["build", { build: { context: ".", args: { IGNORED: "yes" } } }],
  ["pull_policy", { pull_policy: "always" }], ["scale", { scale: 3 }],
  ["deploy.replicas", { deploy: { replicas: 3 } }],
  ["depends_on", { depends_on: { peer: { condition: "service_started", required: true } } }],
  ["profiles", { profiles: ["full"] }],
]) test(`Compose native ServiceHash normalizes ${field} without a custom hash implementation`, async (t) => {
  const { file, command, arguments_, context } = await nativeHashFixture(t);
  const model = { services: { subject: { image: "subject:old", ...extra }, peer: { image: "peer:old" } } };
  await writeFile(file, JSON.stringify(model));
  const rendered = JSON.parse(await command("docker", [...arguments_, "config", "--format", "json"], process.env));
  const actual = await composeServiceHash(context, { rendered, arguments_, environment: process.env }, "subject", []);
  delete model.services.subject[field];
  // Keep the same empty deploy object: ServiceHash clears replicas, not Deploy itself.
  if (field === "deploy.replicas") model.services.subject.deploy = {};
  await writeFile(file, JSON.stringify(model));
  const expected = await command("docker", [...arguments_, "config", "--hash", "subject"], process.env);
  assert.equal(actual.hash, expected.split(/\s+/u).at(-1));
});

test("Compose native hash preserves resolved env_file values, literal dollars and build platform", async (t) => {
  const { root, file, command, arguments_, context } = await nativeHashFixture(t);
  const envFile = join(root, "service.env");
  await writeFile(envFile, "FROM_FILE=file-value\n");
  const model = { services: { subject: { image: "subject:old", build: { context: "." }, env_file: [envFile],
    environment: { LITERAL: "literal$$cash" } } } };
  const environment = { ...process.env, DOCKER_DEFAULT_PLATFORM: "linux/amd64" };
  await writeFile(file, JSON.stringify(model));
  const rendered = JSON.parse(await command("docker", [...arguments_, "config", "--format", "json"], environment));
  assert.equal(rendered.services.subject.environment.LITERAL, "literal$$cash");
  const actual = await composeServiceHash(context, { rendered, arguments_, environment }, "subject", []);
  const unresolved = (await command("docker", [...arguments_, "config", "--hash", "subject"], environment)).split(/\s+/u).at(-1);
  assert.notEqual(actual.hash, unresolved, "create/up resolves env_file while config --hash skips it");
  delete model.services.subject.env_file;
  model.services.subject.environment.FROM_FILE = "file-value";
  await writeFile(file, JSON.stringify(model));
  const expected = (await command("docker", [...arguments_, "config", "--hash", "subject"], environment)).split(/\s+/u).at(-1);
  assert.equal(actual.hash, expected);
});

for (const optional of [false, true]) test(`Compose preimage binds ${optional ? "absent optional" : "resolved"} service env_file inputs`, async (t) => {
  const fixture = await rerenderFixture(t);
  const { context, model, rows } = fixture, path = join(context.repository, "..", "deployed", "service.env");
  if (!optional) await writeFile(path, "KEY=private-fixture\n");
  model.services.subject.env_file = [{ path, required: !optional }];
  const resolved = { image: "subject:old", ...(!optional ? { environment: { KEY: "private-fixture" } } : {}) };
  rows[0].Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify(resolved));
  const command = context.command;
  let mutate = false;
  context.command = async (name, args, environment) => {
    if (args.includes("--hash")) {
      if (mutate) await writeFile(path, "KEY=changed\n");
      return `subject ${sha256(JSON.stringify(resolved))}`;
    }
    if (args.includes("config") && !args.includes("--no-env-resolution")) return JSON.stringify({ ...model,
      services: { ...model.services, subject: resolved } });
    return command(name, args, environment);
  };
  const capture = () => composePreimage(rows[0], context, { Config: {} }, "2.40.3", rows);
  assert.deepEqual((await capture()).serviceEnvironmentFiles, [{ path, sha256: optional ? null : sha256("KEY=private-fixture\n") }]);
  mutate = true;
  await assert.rejects(capture(), /Compose input changed during capture/u);
});

test("Compose native capture retains env_file paths and refuses unresolved path interpolation", {
  skip: process.platform === "win32" ? "Windows Docker Compose needs ProgramFiles, excluded by the capture environment scrub; qualified by the Linux unit gate" : false,
}, async (t) => {
  const { root, file, command, arguments_, context } = await nativeHashFixture(t);
  context.repository = join(root, "candidate"); await mkdir(context.repository);
  const envFile = join(root, "service.env"); await writeFile(envFile, "KEY=private-fixture\n");
  await writeFile(file, JSON.stringify({ services: { subject: { image: "subject:old", environment: { KEY: "private-fixture" } } } }));
  const hash = (await command("docker", [...arguments_, "config", "--hash", "subject"], process.env)).split(/\s+/u).at(-1);
  await writeFile(file, JSON.stringify({ services: { subject: { image: "subject:old", env_file: [envFile] } } }));
  const row = { Config: { Env: [`SERVICE_ENV_FILE=${envFile}`], Labels: {
    "com.docker.compose.service": "subject", "com.docker.compose.project": "fixture",
    "com.docker.compose.version": "2.40.3", "com.docker.compose.config-hash": hash,
    "com.docker.compose.project.working_dir": root, "com.docker.compose.project.config_files": file,
  } } };
  const capture = () => composePreimage(row, context, { Config: {} }, "2.40.3", []);
  assert.deepEqual((await capture()).serviceEnvironmentFiles, [{ path: envFile, sha256: sha256("KEY=private-fixture\n") }]);
  await writeFile(file, JSON.stringify({ services: { subject: { image: "subject:old", env_file: ["${SERVICE_ENV_FILE}"] } } }));
  await assert.rejects(capture(), /cannot bind an interpolated service env_file path/u);
});

for (const [field, hostField] of [["network_mode", "NetworkMode"], ["ipc", "IpcMode"], ["pid", "PidMode"]]) {
  test(`rollback resolves ${field} after its dependency receives a new container ID`, async (t) => {
    const fixture = await rerenderFixture(t, { [field]: "service:peer" });
    const { context, model } = fixture;
    const originals = structuredClone(fixture.rows);
    for (const row of originals) {
      const name = row.Config.Labels["com.docker.compose.service"];
      row.Name = `/${name}`; row.Config.Image = model.services[name].image; row.Config.Hostname = name;
      row.Config.Env = []; row.State = { Running: false, ExitCode: 0, StartedAt: "0001-01-01T00:00:00Z" };
      if (name === "subject") row.HostConfig[hostField] = `container:${sha256("peer")}`;
      const service = name === "subject" ? { ...model.services[name], [field]: `container:${sha256("peer")}` } : model.services[name];
      row.Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify(service));
      model.services[name].hostname = name;
      row.Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify({ ...service, hostname: name }));
    }
    const snapshot = { transactionId: "transaction", buildTags: [], containers: [] };
    for (const row of originals) snapshot.containers.push({ id: row.Id, image: row.Image,
      service: row.Config.Labels["com.docker.compose.service"], running: false, inspect: row, networks: [], rootfsChanges: "",
      rollbackTag: "rollback:old", compose: await composePreimage(row, context, { Config: {} }, "2.40.3+ds1-0ubuntu1~24.04.1", originals) });
    let rows = originals.map((row) => row.Config.Labels["com.docker.compose.service"] === "other" ? structuredClone(row) : {
      ...structuredClone(row), Id: sha256(`candidate-${row.Config.Labels["com.docker.compose.service"]}`),
    });
    const hashCommand = context.command, created = [], receipts = [];
    context.directory = context.repository; context.privateDirectory = join(context.repository, "..", "private"); context.drained = true;
    context.command = async (name, args, environment) => {
      if (args.includes("--hash") || args[1] === "version") return hashCommand(name, args, environment);
      if (args[0] === "ps") return rows.map((row) => row.Id).join(" ");
      if (args[0] === "inspect") return JSON.stringify(rows);
      if (args[0] === "image") return args[1] === "ls" ? imageId : args[1] === "inspect" ? JSON.stringify([{ Id: imageId }]) : 0;
      if (args[0] === "rm") { rows = rows.filter((row) => row.Id !== args[1]); return 0; }
      if (args.includes("up")) {
        const service = args.at(-1), original = originals.find((row) => row.Config.Labels["com.docker.compose.service"] === service);
        const row = structuredClone(original); row.Id = sha256(`restored-${service}`);
        if (service === "subject") {
          const peer = rows.find((entry) => entry.Config.Labels["com.docker.compose.service"] === "peer");
          assert.equal(peer.Id, sha256("restored-peer"), "dependency must be recreated first");
          row.HostConfig[hostField] = `container:${peer.Id}`;
          row.Config.Labels["com.docker.compose.config-hash"] = sha256(JSON.stringify({ ...model.services.subject, [field]: `container:${peer.Id}` }));
        }
        rows.push(row); created.push(service); return 0;
      }
      assert.fail("unexpected rollback mutation");
    };
    const source = await readFile(new URL("../scripts/release/installer-artifacts.mjs", import.meta.url), "utf8");
    const extract = (a, b) => source.slice(source.indexOf(a), b ? source.indexOf(b) : undefined).replaceAll("export ", "");
    const rollback = runInNewContext([
      extract("async function referenceImageId(", "export async function writeArtifactState("), extract("function refuse("), ";rollbackReplacement",
    ].join("\n"), { assert, firstDifference, sha256, structuredClone, resolve, rollbackStatePath, assertRollbackInventory,
      fileDigest: async (path) => sha256(await readFile(path)),
      resolveComposeServiceReferences, composeServiceHash, preparePrivateDirectory: async () => {},
      readBoundArtifacts: async () => ({ manifest: { state: "PASS", images: [], preimage: { sha256: "binding" } }, snapshot }),
      readOptionalState: async (_context, kind) => kind === "replacement-effects" ? {} : { targets: ["subject", "peer"], containers: rows },
      inspectOwned: async () => rows, readFile, produceRollbackSafety: async () => ({ migrations: "NONE", protectedWrites: "NONE" }),
      atomicExclusiveJson: async (_path, value) => receipts.push(value),
    });
    assert.equal(await rollback(context), 0);
    assert.deepEqual(created, ["peer", "subject"]);
    const restored = rows.find((row) => row.Config.Labels["com.docker.compose.service"] === "subject");
    assert.notEqual(restored.Config.Labels["com.docker.compose.config-hash"], originals[0].Config.Labels["com.docker.compose.config-hash"]);
    assert.equal(receipts.at(-1).containers.length, 3);
  });
}
