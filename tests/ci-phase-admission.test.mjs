import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { fixtureEnvironment, qualityRunner, qualityJobName, qualityCloud, qualityFullRuntime, qualityControl } from "./helpers/quality-workflow-fixture.mjs";


test("filesystem admission denies unsafe phase starts and preserves owned PostgreSQL cleanup", () => {
  for (const path of ["tests/ci-phase-guard.py", "tests/ci-postgres-runtime.py"]) {
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", [path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});


