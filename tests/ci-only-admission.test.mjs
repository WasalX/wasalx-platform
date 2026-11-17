import "./helpers/operator-input-fixtures.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { CI_ONLY_REF_SOURCE } from "../scripts/release/ci-execution-context.mjs";
import { fixtureEnvironment } from "./helpers/quality-workflow-fixture.mjs";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const sha = "a".repeat(40);
const ref = "refs/heads/wasalx/ci-only-stack-c2-fixes";
const workflowRef = ("WasalX/WasalX/" + process.env.WASALX_QUALITY_WORKFLOW_PATH + "@") + ref;




test("JS and Python CI-only allow-lists stay byte-for-byte aligned", async () => {
  const guard = await readFile(new URL("../scripts/release/ci-phase-guard.py", import.meta.url), "utf8");
  assert.match(guard, new RegExp(`r"${CI_ONLY_REF_SOURCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
});
