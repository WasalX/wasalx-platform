#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composePreimage, inspectOwned } from "./installer-artifacts.mjs";
import { devContainerPreimage } from "./installer-stack.mjs";
import { run } from "./installer-stages.mjs";

export async function diagnosePreimageRerender(context, write = (line) => process.stdout.write(`${line}\n`)) {
  const rows = await inspectOwned(context);
  assert.ok(rows.length, "owned census is empty");
  const version = await context.command("docker", ["compose", "version", "--short"], context.environment);
  const results = [];
  for (const row of rows) {
    const service = row.Config.Labels["com.docker.compose.service"];
    assert.match(service, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u, "invalid service label");
    try {
      const images = JSON.parse(await context.command("docker", ["image", "inspect", row.Image], context.environment));
      assert.equal(images[0]?.Id, row.Image, "image preimage unavailable");
      await composePreimage(row, context, images[0], version, rows);
      results.push({ service, state: "MATCH" });
    } catch (error) {
      const fields = error.rollbackFields ?? [];
      const families = ["network_mode", "ipc", "pid", "volumes_from", "env_file", "models", "use_api_socket", "version"]
        .filter((family) => fields.some((field) => field.split(".").includes(family)));
      results.push({ service, state: "MISMATCH", family: families.join(",") || "compose.inputs-or-environment" });
    }
  }
  assert.deepEqual((await inspectOwned(context)).map(devContainerPreimage), rows.map(devContainerPreimage), "owned census changed during diagnosis");
  for (const result of results) write(`${result.service} ${result.state}${result.family ? ` suspected=${result.family}` : ""}`);
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [projectFlag, project, repositoryFlag, repository, ...extra] = process.argv.slice(2);
    assert.ok(projectFlag === "--project-name" && /^[a-z0-9][a-z0-9_-]*$/u.test(project ?? "") &&
      repositoryFlag === "--repository" && repository && !extra.length,
    "usage: node scripts/release/diagnose-preimage-rerender.mjs --project-name <project> --repository <candidate-repository>");
    if (process.platform !== "win32") assert.equal(process.getuid(), 0, "root is required for private hash inputs");
    const results = await diagnosePreimageRerender({ project, repository: resolve(repository), environment: process.env, command: run });
    process.exitCode = results.some(({ state }) => state !== "MATCH") ? 1 : 0;
  } catch {
    process.stderr.write("preimage re-render diagnosis refused; check arguments, access and census stability (no capture state written)\n");
    process.exitCode = 1;
  }
}
