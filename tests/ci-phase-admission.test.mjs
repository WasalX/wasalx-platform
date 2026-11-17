import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import "yaml";
import "./helpers/quality-workflow-fixture.mjs";


test("filesystem admission denies unsafe phase starts and preserves owned PostgreSQL cleanup", () => {
  for (const path of ["tests/ci-phase-guard.py", "tests/ci-postgres-runtime.py"]) {
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", [path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});


