import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { tenantId, tenantName, withSignedPlatformFixture } from "./support/signed-platform-fixture.mjs";

const expected = new Map([
  ["meta-cost-operator.spec.ts", 5],
  ["meta-transition-operator.spec.ts", 5],
]);
const projects = ["desktop", "mobile-390"];

async function runRegisteredCases(locale, env, scratch) {
  const args = [
    "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.application.config.ts",
    "--reporter=json", "--trace", "off", "--output", join(scratch, "results"),
  ];
  for (const project of projects) args.push("--project", project);
  const execution = await promisify(execFile)(process.execPath, args, {
    env, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  }).catch(error => error);
  const report = JSON.parse(execution.stdout);
  const selected = new Map();
  function collect(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const key = spec.file + "/" + test.projectName;
        const cases = selected.get(key) ?? [];
        cases.push({ spec, test });
        selected.set(key, cases);
      }
    }
    for (const child of suite.suites ?? []) collect(child);
  }
  for (const suite of report.suites) collect(suite);
  const expectedCount = projects.length * [...expected.values()].reduce((total, count) => total + count, 0);
  let executed = 0;
  let passed = 0;
  for (const [key, cases] of selected) {
    for (const { spec, test } of cases) {
      const [first] = test.results;
      if (first && !["skipped", "interrupted"].includes(first.status)) executed++;
      if (test.expectedStatus === "passed" && test.results.length === 1 && first?.status === "passed") passed++;
      const status = first?.status ?? "unreported";
      const line = first?.error?.location?.line ?? spec.line;
      console.log(JSON.stringify({ locale, case: key, line, status, durationMs: first?.duration }));
    }
  }
  console.log(JSON.stringify({ locale, expected: expectedCount, executed, passed }));
  assert.equal(selected.size, expected.size * projects.length);
  for (const [file, count] of expected) {
    for (const project of projects) assert.equal(selected.get(file + "/" + project)?.length, count);
  }
  assert.equal(report.errors.length, 0);
  assert.equal(executed, expectedCount);
  assert.equal(passed, expectedCount);
  assert.equal(execution.code, undefined);
}

const locale = process.argv[2];
assert(["en", "ar"].includes(locale), "Expected en or ar");
const scratch = await mkdtemp(join(tmpdir(), "wasalx-operator-e2e-"));
let phase = "fixture";
try {
  await withSignedPlatformFixture(async ({ resources, portalOrigin, browserExecutable, signIn }) => {
    phase = "signed session and tenant read";
    const context = await resources.browser.newContext();
    const page = await context.newPage();
    await signIn(context, page);
    const cookies = (await context.cookies(portalOrigin)).filter(cookie => cookie.name === "wasalx_platform_session");
    assert.equal(cookies.length, 1);
    const statePath = join(scratch, "session.json");
    await writeFile(statePath, JSON.stringify({ cookies, origins: [] }), { flag: "wx", mode: 0o600 });
    await context.close();
    console.log("Synthetic signed OIDC session and authenticated tenant read passed");

    phase = "registered cases";
    await runRegisteredCases(locale, {
      ...process.env,
      WASALX_E2E_LOCALE: locale,
      WASALX_E2E_PLATFORM_URL: portalOrigin + "/platform#tenants",
      WASALX_E2E_PLATFORM_STORAGE_STATE: statePath,
      WASALX_E2E_PLATFORM_TENANT_ID: tenantId,
      WASALX_E2E_PLATFORM_TENANT_NAME: tenantName,
      WASALX_E2E_REUSE_SERVER: "1",
      WASALX_E2E_BROWSER_PATH: browserExecutable,
    }, scratch);
    phase = "fixture cleanup";
  });
  console.log("Synthetic platform fixture cleaned up");
} catch (error) {
  console.error("Operator browser job failed during " + phase + " (" + error.name + ")");
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
