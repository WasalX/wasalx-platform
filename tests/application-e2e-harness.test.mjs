import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { boundedCommand, fixtureStderr } from "./support/bounded-command.mjs";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import { runRoleSuites } from "../scripts/application-e2e-pool.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("two fixture locale lanes run every role once with disjoint ports", async () => {
  const active = new Map(); const calls = []; let peak = 0;
  const roles = ["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor"];
  await runRoleSuites(["en", "ar"], roles, 3191, async (locale, role, port) => {
    assert.ok(!active.has(port));
    active.set(port, locale); peak = Math.max(peak, active.size);
    calls.push([locale, role, port]);
    await new Promise(resolve => setTimeout(resolve, 10));
    active.delete(port);
  });
  assert.equal(peak, 4);
  assert.equal(active.size, 0);
  assert.deepEqual(calls.sort((a, b) => a[2] - b[2]), ["en", "ar"].flatMap((locale, localeIndex) =>
    roles.map((role, roleIndex) => [locale, role, 3191 + localeIndex * roles.length + roleIndex])));
});

test("parallel role launch failures settle siblings and preserve the full union", async () => {
  const completed = [];
  await assert.rejects(runRoleSuites(["en", "ar"], ["owner", "admin"], 3191, async (locale, role) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    completed.push(`${locale}/${role}`);
    if (role === "owner") throw new Error(`fixture-${locale}`);
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message).sort(), ["fixture-ar", "fixture-en"]);
    return true;
  });
  assert.deepEqual(completed.sort(), ["ar/admin", "ar/owner", "en/admin", "en/owner"]);
});

test("real platform role sessions remain serial", async () => {
  let active = 0; let peak = 0; const calls = [];
  await runRoleSuites(["en", "ar"], ["owner", "admin"], 65534, async (locale, role, port) => {
    calls.push([locale, role, port]);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
  }, false);
  assert.equal(peak, 1);
  assert.deepEqual(calls, [["en", "owner", 65534], ["en", "admin", 65535],
    ["ar", "owner", 65534], ["ar", "admin", 65535]]);
});

test("role pools reject duplicates and invalid ports before launching", async () => {
  let calls = 0;
  for (const [locales, roles, port] of [
    [["en"], ["owner", "owner"], 3191], [["en", "en"], ["owner"], 3191],
    [["en"], ["owner", "admin"], 65535], [["en"], ["owner"], 0], [["en"], ["owner"], 3.5],
    [["en", "ar"], ["owner", "admin"], 65534],
  ]) await assert.rejects(runRoleSuites(locales, roles, port, async () => { calls++; }));
  assert.equal(calls, 0);
});

test("fixture locale and role combinations have separate registry, log and artifact paths", () => {
  const env = { ...process.env, WASALX_E2E_LOCALES: "en,ar" };
  delete env.WASALX_E2E_PLATFORM_URL;
  const paths = JSON.parse(execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `const paths=[]; for(const locale of ['en','ar']) for(const role of ['tenant_owner','tenant_admin']) {
      process.env.WASALX_E2E_LOCALE=locale; process.env.WASALX_E2E_ROLE=role;
      const {default:config}=await import('./playwright.application.config.ts?'+locale+'-'+role);
      paths.push([config.webServer.env.MINIFLARE_REGISTRY_PATH,config.webServer.env.WRANGLER_LOG_PATH,
        config.outputDir,config.reporter[1][1].outputFolder]);
    } console.log(JSON.stringify(paths));`,
  ], { cwd: new URL("../", import.meta.url), encoding: "utf8", env }));
  for (let index = 0; index < 4; index++) assert.equal(new Set(paths.map(item => item[index])).size, 4);
});

test("qualification commands distinguish exit failures from cancelled or unavailable processes", async () => {
  const ready = await boundedCommand(process.execPath, ["-e", "process.stdout.write('ready')"]);
  assert.equal(ready.code, 0);
  assert.equal(ready.stdout, "ready");
  assert.equal(fixtureStderr(ready.stderr), "");
  assert.equal(ready.output, ready.stdout + ready.stderr, "raw command diagnostics remain available");
  assert.equal((await boundedCommand(process.execPath, ["-e", "process.exit(7)"])).code, 7);
  await assert.rejects(boundedCommand("wasalx-missing-test-executable", []), { code: "ENOENT" });
  let childPid;
  await assert.rejects(boundedCommand(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], { timeout: 1_000 }), error => {
    childPid = Number(error.stdout?.trim());
    return error.killed === true;
  });
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("filtered harness runs finish provider TLS setup before fixture cleanup", async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await boundedCommand(process.execPath, [
    "--experimental-strip-types", "--test", "--test-reporter=tap",
    "--test-name-pattern=^role pools reject duplicates and invalid ports before launching$",
    "tests/application-e2e-harness.test.mjs",
  ], { cwd: new URL("../", import.meta.url), timeout: 15000, env });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ok 1 - role pools reject duplicates and invalid ports before launching/u);
  assert.match(result.output, /# pass 1\b/u);
});

test("browser suites never automatically repeat an unclassified failure", () => {
  for (const ci of [undefined, "true"]) {
    const env = { ...process.env };
    if (ci) env.CI = ci;
    else delete env.CI;
    const retries = JSON.parse(execFileSync(process.execPath, [
      "--experimental-strip-types", "--input-type=module", "-e",
      "import app from './playwright.application.config.ts'; import stories from './playwright.storybook.config.ts'; console.log(JSON.stringify([app.retries,stories.retries]));",
    ], { cwd: new URL("../", import.meta.url), encoding: "utf8", env, timeout: 15_000, windowsHide: true }));
    assert.deepEqual(retries, [0, 0]);
  }
});



test("application E2E harness is role-complete, bounded, fixture-only, and artifact-safe", async () => {
  const [config, runner, spec, arabicSpec, layout, app] = await Promise.all([
    read("playwright.application.config.ts"),
    read("scripts/run-application-e2e.mjs"),
    read("tests/e2e/application.spec.ts"),
    read("tests/e2e/arabic.spec.ts"),
    read("app/layout.tsx"),
    readTenantPortalSource(),
  ]);

  for (const role of ["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor"]) {
    assert.match(config + runner + spec, new RegExp(role));
  }
  assert.match(config, /PORTAL_DATA_BACKEND:\s*"fixture"/u);
  assert.match(config, /PORTAL_FIXTURE_ROLE:\s*role/u);
  assert.match(config, /webServer/u);
  assert.match(config, /vinext\/dist\/cli\.js start -p/u);
  assert.doesNotMatch(config, /vinext\/dist\/cli\.js dev -p/u);
  assert.match(runner, /Building the production portal for application E2E/u);
  assert.match(runner, /\["run", "build"\]/u);
  assert.match(config, /mobile-390/u);
  assert.match(config, /tablet-820/u);
  assert.match(config, /WASALX_E2E_LOCALE/u);
  assert.match(runner, /WASALX_E2E_LOCALES/u);
  assert.match(arabicSpec, /lang", "ar"/u);
  assert.match(arabicSpec, /dir", "rtl"/u);
  assert.match(arabicSpec, /AxeBuilder/u);
  assert.match(config, /output[\s\S]*playwright[\s\S]*application/u);
  assert.match(config, /trace:\s*"retain-on-failure"/u);
  assert.doesNotMatch(runner, /\bnpx\b/u);
  assert.match(spec, /AxeBuilder/u);
  assert.match(spec, /Shift\+Tab/u);
  assert.match(spec, /Meta\+K/u);
  assert.match(spec, /view=cases&ticket=10382/u);
  assert.match(spec, /view=cases&ticket=10381/u);
  assert.match(spec, /PopStateEvent\("popstate"/u);
  assert.match(spec, /Retry same request/u);
  assert.match(spec, /page\.goBack\(\)/u);
  assert.match(spec, /temporarily unavailable/u);
  assert.match(layout, /icons:\s*\{\s*icon:\s*"\/favicon\.svg\?v=wx-1"\s*\}/u);
  assert.match(app, /className="settings-grid"/u);
  assert.match(app, /role="status"/u);
  assert.match(app, /aria-live="polite"/u);
  assert.match(app, /aria-busy="true"/u);
  assert.match(app, /aria-label=\{t\("tenant\.settings\.loading"\)\}/u);
});

// Included by both existing unit and E2E harness commands.
import "./simulation-manifest.test.mjs";
import "./simulation-stage-fixtures.test.mjs";
import "./simulation-provider-stages.test.mjs";





import "./simulation-email-fixtures.test.mjs";
import "./simulation-email-stages.test.mjs";

import "./direct-dispatch-fence.test.mjs";
import "./simulation-direct-capabilities.test.mjs";

import "./simulation-email-review-regression.test.mjs";

import "./owned-work-settlement.test.mjs";

import "./simulation-meta-producer.test.mjs";

import "./simulation-session-producer.test.mjs";

import "./selected-simulation-manifest.test.mjs";

import "./simulation-shared-readonly.test.mjs";

import "./simulation-direct-quality.test.mjs";

import "./simulation-session-rotation.test.mjs";

import "./simulation-rule-stages.test.mjs";
import "./simulation-rule-input-stage.test.mjs";

import "./simulation-review-fixture.test.mjs";
import "./simulation-remaining-quality.test.mjs";

import "./simulation-connection-quality.test.mjs";

import "./simulation-identity-recovery.test.mjs";

test("Playwright runner retains its isolated transport contract", () => {
  execFileSync(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"), ["tests/playwright-runner.test.py"], {encoding: "utf8", timeout: 10000, windowsHide: true});
});

import "./simulation-native-group.test.mjs";

import "./simulation-sender-stage.test.mjs";

import "./simulation-team-numbers.test.mjs";

import "./simulation-native-grants.test.mjs";

import "./simulation-navigation-quality.test.mjs";
import "./selected-simulation-reviewed-selection.test.mjs";
import "./simulation-diagnostic-instrumentation.test.mjs";
import "./simulation-direct-completed-adoption.test.mjs";
import "./simulation-direct-continuation.test.mjs";
import "./simulation-full-suite-mappings.test.mjs";
import "./simulation-group-spare.test.mjs";
import "./simulation-invitation-retry.test.mjs";
import "./simulation-meta-completed-adoption.test.mjs";
import "./simulation-postgres-designation-stage.test.mjs";
import "./simulation-q04-adoption.test.mjs";
import "./simulation-q05u-adoption.test.mjs";
import "./simulation-q05z-adoption.test.mjs";
import "./simulation-q06a-adoption.test.mjs";
import "./simulation-q06w-adoption.test.mjs";
import "./simulation-q076-adoption.test.mjs";
import "./simulation-q083-continuation.test.mjs";
import "./simulation-q085-continuation.test.mjs";
import "./simulation-rule-preview.test.mjs";
import "./simulation-team-stages.test.mjs";

import "./simulation-routing-quality.test.mjs";

import "./simulation-direct-derived.test.mjs";

import "./simulation-native-business.test.mjs";

import "./simulation-native-email-quality.test.mjs";

import "./simulation-workflow-business.test.mjs";

import "./workflow-quality-sequence.test.mjs";

import "./simulation-cases-business.test.mjs";

test("isolated mail permits only the primary and derived isolation recipient",()=>{execFileSync(process.env.PYTHON??(process.platform==="win32"?"python":"python3"),["tests/simulation-invitation-recipients.test.py"],{encoding:"utf8",timeout:10000,windowsHide:true});});

import "./simulation-security-admission.test.mjs";

import "./simulation-group-rule-quality.test.mjs";
import "./simulation-group-rule-role-contexts.test.mjs";

import "./simulation-native-bookkeeping-policy.test.mjs";

import "./simulation-team-quality.test.mjs";
import "./simulation-team-observation-selection.test.mjs";
import "./direct-derived-reload.test.mjs";

import "./simulation-navigation.test.mjs";



import "./simulation-group-rule-derived.test.mjs";

import "./simulation-navigation-width.test.mjs";

import "./simulation-native-quality-admission.test.mjs";

import "./simulation-session-quality.test.mjs";

import "./simulation-invitation-remaining.test.mjs";

import "./meta-choice-current.test.mjs";

import "./simulation-rule-immutable.test.mjs";

import "./simulation-native-remaining.test.mjs";




import "./simulation-lifecycle-bootstrap.test.mjs";

import "./simulation-platform-enrollment.test.mjs";

import "./handoff-articles.test.mjs";

import "./simulation-lifecycle.test.mjs";

import "./simulation-platform-quality.test.mjs";

import "./meta-open-window.test.mjs";

import "./simulation-lifecycle-census.test.mjs";

import "./simulation-sender-identity-boundary.test.mjs";

import "./waha-simulation-discovery-catalogue.test.mjs";

import "./simulation-native-history.test.mjs";

import "./unread-settlement.test.mjs";
import "./meta-media-integrity.test.mjs";

import "./simulation-command-stage.test.mjs";

import "./cases-current.test.mjs";

import "./group-designation-evidence.test.mjs";
import "./group-designation-cleanup.test.mjs";

// Provider-boundary regressions are mandatory; unit gate already built the actual adapters.
import "./meta-simulation-capability.test.mjs";
import "./meta-simulation-faults.test.mjs";
import "./meta-simulation-subscription.test.mjs";
import "./meta-simulation-signup.test.mjs";
import "./meta-simulation-routing.test.mjs";
import "./simulation-meta-signup-stage.test.mjs";
import "./smtp-simulation-server.test.mjs";
import "./smtp-simulation-tls.test.mjs";
import "./waha-simulation-adapter.test.mjs";
import "./waha-simulation-control.test.mjs";
import "./waha-simulation-echo.test.mjs";
import "./waha-simulation-expansion.test.mjs";
import "./waha-simulation-inbound-clock.test.mjs";
import "./waha-simulation-inbound-media.test.mjs";
import "./waha-simulation-independent-contract.test.mjs";
import "./waha-simulation-ingress-receipt.test.mjs";
import "./waha-simulation-installed-contract.test.mjs";
import "./waha-simulation-media.test.mjs";
import "./waha-simulation-mutations.test.mjs";
import "./waha-simulation-nickname-mentions-adapter.test.mjs";
import "./waha-simulation-nickname-mentions.test.mjs";
import "./waha-simulation-persistence.test.mjs";
import "./waha-simulation-qr.test.mjs";
import "./waha-simulation-roster.test.mjs";
import "./waha-simulation-scoped-arm.test.mjs";
import "./waha-simulation-server.test.mjs";
import "./waha-simulation-session-status.test.mjs";
import "./waha-simulation-webhook.test.mjs";
import "./waha-simulation-worker-health.test.mjs";
import "./waha-test-recipient-scope.test.mjs";
import "./meta-test-recipient-scope.test.mjs";
import "./meta-test-recipient-link.test.mjs";
import "./meta-test-phone-policy.test.mjs";
import "./meta-pinned-adapter.test.mjs";
import "./meta-terminal.test.mjs";
import "./native-routing-ui.test.ts";
import "./client-routing-availability.test.ts";
import "./native-account-observation-ui.test.ts";
import "./pinned-current.test.mjs";
import "./safe-retry.test.mjs";
import "./simulation-final-meta-config.test.mjs";
import "./simulation-pinned-contexts.test.mjs";



test("every provider simulator regression is imported by the required harness",async()=>{
 const {readdir}=await import('node:fs/promises');const names=(await readdir(new URL('./',import.meta.url))).filter(name=>/^(waha|smtp|meta)-simulation.*\.test\.mjs$/.test(name));
 const source=await readFile(new URL('./application-e2e-harness.test.mjs',import.meta.url),'utf8');
 const imported=new Set([...source.matchAll(/import\s+["']\.\/([^"']+)["']/g)].map(match=>match[1]));
 for(const name of names)assert(imported.has(name),'Provider simulator regression is outside required gate: '+name);
});

import "./group-workspace-receipts.test.mjs";
import "./meta-number-release-intent.test.ts";
import "./meta-number-release-portal.test.ts";
import "./meta-number-release.test.mjs";

import "./bundled-editor-security.test.mjs";

// Seven serial Node probes each allow 10s; reserve 10s for Python and durable fixture I/O.


import "./simulation-gows-receipt-owner-ui.test.mjs";
import "./simulation-import-rows.test.mjs";
import "./simulation-tenant-evidence.test.mjs";

// Keep shared preparation identity/late-overlay regressions in the required unit harness.


import "./simulation-invitation-mail-diagnostic.test.mjs";



