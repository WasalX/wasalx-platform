import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const harness = path.join(workspace, ".zammad-addon/tests/zammad-sidebar-component");

function runNodeModule(relativeEntry, args) {
  const entry = path.join(harness, "node_modules", relativeEntry);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: harness,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result.stdout;
}

test("mounted Zammad sidebar passes interaction and accessibility contracts", () => {
  runNodeModule("vitest/vitest.mjs", [
    "run",
    "--config",
    "vitest.config.ts",
    "--maxWorkers=4",
    "--no-file-parallelism",
  ]);

  runNodeModule("typescript/bin/tsc", ["--noEmit", "--project", "tsconfig.json"]);
});
