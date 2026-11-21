import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composePreimage, composeProfiles, resolveComposeServiceReferences, sha256 } from "../scripts/release/installer-artifacts.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fixture = name => new URL(`./fixtures/dev-live-compose/${name}`, import.meta.url);
const expectedRefusals = ["keycloak-bootstrap.compose.config-hash", "keycloak-bootstrap.network_mode"];
const referenceFields = ["network_mode", "ipc", "pid", "volumes_from"];

test("DEV preimage replay: recorded hash outcomes, modeled refusals", async t => {
  const composeFile = "compose-config.scrubbed.yaml";
  const factsFile = "container-facts.scrubbed.json";
  const [composeBytes, factsBytes, checksums] = await Promise.all([
    readFile(fixture(composeFile)), readFile(fixture(factsFile)), readFile(fixture("SHA256SUMS"), "utf8"),
  ]);
  assert.equal(checksums.trim(), `${sha256(composeBytes)}  ${composeFile}\n${sha256(factsBytes)}  ${factsFile}`);
  const live = JSON.parse(composeBytes);
  const { project, compose_version: version, containers, preflight } = JSON.parse(factsBytes);
  const candidate = JSON.parse(execFileSync("docker", ["compose", "--env-file", ".env.example",
    "--file", "compose.yaml", "--file", "compose.full.yaml",
    ...composeProfiles.flatMap(profile => ["--profile", profile]), "--project-name", project,
    "config", "--no-interpolate", "--no-env-resolution", "--format", "json"],
  { cwd: repository, env: { ...process.env, COMPOSE_PROFILES: "", PORTAL_FIXTURE_ROLE: "" },
    encoding: "utf8", timeout: 10_000, windowsHide: true }));

  const deployed = await mkdtemp(join(tmpdir(), "wasalx-dev-compose-fixture-"));
  t.after(() => rm(deployed, { recursive: true, force: true }));
  // Exercise the native private-file path using public fixture bytes in the runner's temp directory.
  if (process.platform !== "win32") t.mock.method(process, "getuid", () => 0);
  const deployedFile = join(deployed, composeFile);
  const envFile = join(deployed, "replay.env");
  await copyFile(fixture(composeFile), deployedFile);
  await writeFile(envFile, "");
  const rows = Object.values(containers).map(({ inspect }) => inspect);
  for (const [name, { inspect }] of Object.entries(containers)) {
    const labels = inspect.Config.Labels;
    assert.equal(labels["com.docker.compose.service"], name);
    assert.equal(labels["com.docker.compose.project"], project);
    labels["com.docker.compose.project.working_dir"] = deployed;
    labels["com.docker.compose.project.config_files"] = deployedFile;
    if (labels["com.docker.compose.project.environment_file"]) labels["com.docker.compose.project.environment_file"] = envFile;
  }
  const configHash = name => containers[name].inspect.Config.Labels["com.docker.compose.config-hash"];
  assert.equal(configHash(preflight.target_service), preflight.label_hash);
  assert.deepEqual(resolveComposeServiceReferences(live.services[preflight.target_service], rows, project).references,
    preflight.service_references);

  for (const model of [live, candidate]) {
    const refusals = [];
    const context = { repository, project, environment: {}, command: async (command, args) => {
      assert.equal(command, "docker");
      assert.ok(args.includes("config"));
      if (!args.includes("--hash")) return JSON.stringify(model);
      const name = args.at(-1);
      const input = JSON.parse(await readFile(args[args.lastIndexOf("--file") + 1], "utf8"));
      const expected = resolveComposeServiceReferences(live.services[name], rows, project).service;
      // Any candidate-side change to these resolved references requires a recapture, even if preflight would accept it because it renders the deployed chain.
      for (const field of referenceFields) assert.deepEqual(input.services[name][field], expected[field], `${name}.${field}`);
      // shortcut: hashes are replayed from the capture, not computed (scrubbing changes hash inputs); config-hash drift on other services is not detected until a recapture records their rerendered hashes
      const hash = name === preflight.target_service ? preflight.rerendered_hash : configHash(name);
      return `${name} ${hash}`;
    } };
    for (const [name, { inspect, image }] of Object.entries(containers)) {
      assert.ok(model.services[name], `${name} is missing from the Compose model`);
      try {
        await composePreimage(inspect, context, { Config: { Labels: image.labels } }, version, rows);
      } catch (error) {
        if (!error.rollbackFields) throw error;
        refusals.push(...error.rollbackFields);
      }
    }
    assert.deepEqual(refusals.sort(), expectedRefusals);
  }
});
