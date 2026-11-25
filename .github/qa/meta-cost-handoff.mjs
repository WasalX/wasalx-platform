import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { axeLines, projects, title } from "./meta-cost-reporter.mjs";

export async function proveMetaCost(t, context, portalOrigin, tenantId, browserExecutable) {
  const state = await context.storageState();
  assert.ok(state.cookies.some(cookie => cookie.name === "wasalx_platform_session"), "platform session missing");
  const evidencePath = process.env.QA_META_COST_EVIDENCE;
  await appendFile(evidencePath, "platform-session-admitted\n");
  const scratch = await mkdtemp(join(tmpdir(), "wasalx-cost-proof-"));
  const statePath = join(scratch, "session.json");
  const casesPath = join(scratch, "cases.jsonl");
  try {
    await writeFile(statePath, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    for (const locale of ["en", "ar"]) {
      await t.test("Signed-in Meta cost " + locale, async () => {
        await writeFile(casesPath, "");
        const child = spawn(process.execPath, [
          "--import", new URL("./meta-cost-axe.mjs", import.meta.url).href,
          "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.application.config.ts",
          "--project", "desktop", "--project", "mobile-390", "--grep", title + "$",
          "--reporter", "./.github/qa/meta-cost-reporter.mjs", "--trace", "off",
          "--output", join(scratch, "test-output-" + locale),
        ], {
          stdio: "ignore",
          env: {
            ...process.env,
            WASALX_E2E_LOCALE: locale,
            WASALX_E2E_PLATFORM_URL: portalOrigin + "/platform#tenants",
            WASALX_E2E_PLATFORM_STORAGE_STATE: statePath,
            WASALX_E2E_PLATFORM_TENANT_ID: tenantId,
            WASALX_E2E_PLATFORM_TENANT_NAME: "Invitation Proof Workspace",
            WASALX_E2E_REUSE_SERVER: "1",
            WASALX_E2E_BROWSER_PATH: browserExecutable,
            QA_META_COST_CASES: casesPath,
          },
        });
        const [exitCode] = await once(child, "close");
        const diagnostics = (await readFile(casesPath, "utf8")).trim();
        if (diagnostics) await appendFile(evidencePath, diagnostics + "\n");
        const cases = diagnostics ? diagnostics.split("\n").map(line => JSON.parse(line)) : [];
        if (cases.length !== projects.length) await appendFile(evidencePath, locale + " case-inventory-incomplete\n");
        assert.deepEqual(cases.map(entry => entry.project).sort(), projects);
        assert.ok(cases.every(entry => entry.locale === locale));
        assert.equal(exitCode, 0, "registered Meta cost case failed");
        for (const entry of cases) {
          assert.equal(entry.status, "passed");
          if (JSON.stringify(entry.axe.map(scan => scan.line)) !== JSON.stringify(axeLines)) {
            await appendFile(evidencePath, locale + " " + entry.project + " axe-inventory-incomplete\n");
            assert.fail("expected both registered axe analyses");
          }
        }
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourcePath = "tests/platform-invitation-e2e.test.mjs";
  const source = await readFile(sourcePath, "utf8");
  const testBody = "{ timeout: 300_000 }, async () => {";
  const chrome = "  resources.browser = await chromium.launch({ executablePath: await browserPath(), headless: true });";
  const admission = "    assert.equal((await platformRead.json()).items[0].tenant_id, tenantId);";
  for (const marker of [testBody, chrome, admission]) {
    assert.equal(source.split(marker).length, 2, "signed-in launcher anchor changed");
  }
  const launcher = 'import { proveMetaCost } from "../.github/qa/meta-cost-handoff.mjs";\n' + source
    .replace(testBody, "{ timeout: 300_000 }, async (t) => {")
    .replace(chrome, "  const browserExecutable = await browserPath();\n" +
      chrome.replace("await browserPath()", "browserExecutable"))
    .replace(admission, admission + "\n    await proveMetaCost(t, context, portalOrigin, tenantId, browserExecutable);");
  await writeFile("tests/.qa-meta-cost-proof.mjs", launcher, { flag: "wx" });
}
