import "./helpers/operator-input-fixtures.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CI_ONLY_REF_SOURCE } from "../scripts/release/ci-execution-context.mjs";
import "./helpers/quality-workflow-fixture.mjs";




test("JS and Python CI-only allow-lists stay byte-for-byte aligned", async () => {
  const guard = await readFile(new URL("../scripts/release/ci-phase-guard.py", import.meta.url), "utf8");
  assert.match(guard, new RegExp(`r"${CI_ONLY_REF_SOURCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
});
