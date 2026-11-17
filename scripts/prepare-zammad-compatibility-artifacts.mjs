#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(repository, "zammad-package/compatibility-artifacts.json"), "utf8"));
const arguments_ = process.argv.slice(2);
const outputOption = arguments_.indexOf("--output-root");
assert.ok(outputOption >= 0 && arguments_[outputOption + 1], "--output-root is required");
const outputRoot = resolve(arguments_[outputOption + 1]);
const requested = arguments_.filter((_, index) => index !== outputOption && index !== outputOption + 1);
const versions = requested.length > 0 ? requested : Object.keys(manifest.artifacts);

await mkdir(outputRoot, { recursive: true });
const outputRootDetails = await lstat(outputRoot);
assert.ok(outputRootDetails.isDirectory() && !outputRootDetails.isSymbolicLink(), "compatibility output root must be a regular directory");

for (const version of versions) {
  const artifact = manifest.artifacts[version];
  assert.ok(artifact, `unknown compatibility package version: ${version}`);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(artifact.mode, "100644");
  assert.equal(artifact.path, `build/zammad/wasalx-${version}.zpm`);
  const filename = basename(artifact.path);
  assert.equal(filename, artifact.path.split("/").at(-1), "compatibility artifact filename is invalid");
  const output = resolve(outputRoot, filename);

  const bytes = await readFile(resolve(repository, artifact.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, `sanitized compatibility fixture digest changed: ${version}`);

  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  await chmod(output, 0o644);
}
