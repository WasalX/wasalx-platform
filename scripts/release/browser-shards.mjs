import {requiredOperatorInput} from "./operator-input.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { ciExecutionContext, validateCiEvidence } from "./ci-execution-context.mjs";

export const browserShardCount = 3;
export const browserDigest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export function browserShard(value) {
  if (value === undefined) return null;
  assert.match(value, /^[1-3]\/3$/u, "browser shard must be 1/3, 2/3 or 3/3");
  return Number(value[0]);
}

export function browserShardArguments(environment) {
  const shard = browserShard(environment.WASALX_E2E_SHARD);
  if (shard === null) return [];
  assert(!environment.WASALX_E2E_PLATFORM_URL, "sharding requires isolated fixture servers");
  const contexts = browserContexts({ argv: ["pnpm", "test:e2e"], env: environment });
  const context = contexts.findIndex(({ locale, role }) => locale === environment.WASALX_E2E_LOCALE && role === environment.WASALX_E2E_ROLE);
  assert(context >= 0, "browser shard requires a canonical locale/role context");
  // Rotate expensive desktop groups across jobs while preserving each serial group.
  return [`--shard=${(shard - 1 + context) % browserShardCount + 1}/${browserShardCount}`];
}

export function browserContexts(command) {
  assert.deepEqual(command.argv, ["pnpm", "test:e2e"]);
  const roles = command.env.WASALX_E2E_ROLES.split(",");
  const locales = command.env.WASALX_E2E_LOCALES.split(",");
  assert(roles.length && locales.length && new Set(roles).size === roles.length && new Set(locales).size === locales.length);
  return locales.flatMap(locale => roles.map(role => ({ locale, role })));
}

export function browserShardPlan(command) {
  const contexts = browserContexts(command);
  return { version: 1, count: browserShardCount, contexts,
    parts: [1, 2, 3].map(shard => ({ shard, selections: contexts.map(({ locale, role }) =>
      browserShardArguments({ ...command.env, WASALX_E2E_SHARD: `${shard}/3`,
        WASALX_E2E_LOCALE: locale, WASALX_E2E_ROLE: role })) })) };
}

export function browserReportPath(shard, locale, role) {
  assert([0, 1, 2, 3].includes(shard));
  assert(["en", "ar"].includes(locale));
  assert(/^[a-z_]+$/u.test(role));
  return `output/playwright/application/${locale}/${shard === 0 ? "baseline" : `shard-${shard}`}/${role}.json`;
}

export function listedBrowserCases(report, context) {
  assert.deepEqual(report.errors, [], "Playwright discovery failed");
  const cases = [];
  const visit = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      cases.push({ id: `${context.locale}/${context.role}/${spec.id}`, file: spec.file,
        project: test.projectName, title: spec.title, expectedStatus: test.expectedStatus });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  assert(cases.length > 0, "empty browser test inventory");
  return cases.sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function discoverBrowserCases(command, shard) {
  return browserContexts(command).flatMap(context => {
    const environment = { ...process.env, ...command.env, WASALX_E2E_LOCALE: context.locale,
      WASALX_E2E_ROLE: context.role, WASALX_E2E_SHARD: shard ? `${shard}/3` : undefined };
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test",
      "--config", "playwright.application.config.ts", "--list", "--reporter=json",
      ...browserShardArguments(environment)], {
      env: environment,
      encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `browser discovery failed: ${result.stderr}`);
    return listedBrowserCases(JSON.parse(result.stdout), context);
  });
}

export function validateBrowserPartition(baseline, reports) {
  const expected = new Map(baseline.map(row => [row.id, row]));
  assert(expected.size > 0 && expected.size === baseline.length, "empty or duplicate baseline inventory");
  const seen = new Set();
  const totals = { total: 0, passed: 0, skipped: 0 };
  for (const report of reports) {
    assert.equal(report.status, "passed", "failed or cancelled browser part");
    assert(report.cases.length > 0, "empty browser part");
    for (const row of report.cases) {
      assert(!seen.has(row.id), "overlapping browser parts");
      const original = expected.get(row.id);
      assert(original, "unknown browser test");
      for (const key of ["file", "project", "title"]) assert.equal(row[key], original[key], `changed browser ${key}`);
      assert(["expected", "skipped"].includes(row.outcome), "browser test did not satisfy its existing expectation");
      assert.equal(row.status, row.outcome === "skipped" ? "skipped" : row.expectedStatus, "browser result contradicts its expectation");
      assert.equal(row.attempts, 1, "missing or repeated browser test execution");
      seen.add(row.id);
      totals.total++;
      totals[row.status === "skipped" ? "skipped" : "passed"]++;
    }
  }
  assert.equal(seen.size, expected.size, "missing browser tests");
  return totals;
}

export function shardIdentity(candidateSha, candidateTree, command, environment = process.env) {
  const shard = browserShard(environment.WASALX_E2E_SHARD);
  assert(shard !== null, "missing browser shard");
  const identity = { candidateSha, candidateTree, shard, count: browserShardCount,
    workflow: environment.GITHUB_WORKFLOW_REF, job: environment.GITHUB_JOB ?? "browser-shards",
    runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT };
  if (environment.GITHUB_ACTIONS === "true") {
    assert.equal(identity.job, "browser-shards");
    assert.equal(environment.GITHUB_SHA, candidateSha);
    assert(identity.workflow?.includes(("/" + requiredOperatorInput("WASALX_QUALITY_WORKFLOW_PATH") + "@")));
    assert(/^[1-9][0-9]*$/u.test(identity.runId) && /^[1-9][0-9]*$/u.test(identity.runAttempt));
  }
  const plan = browserShardPlan(command);
  return { ...identity, executionContext: ciExecutionContext(environment), inputDigest: browserDigest({ candidateTree, command }),
    mappingVersion: plan.version, mappingDigest: browserDigest(plan),
    contextOrder: plan.contexts.map(({ locale, role }) => `${locale}/${role}`) };
}

export async function readBrowserReports(shard, command) {
  return Promise.all(browserContexts(command).map(async ({ locale, role }) => {
    const path = browserReportPath(shard, locale, role);
    const report = JSON.parse(await readFile(path, "utf8"));
    validateReportSelection(report, shard, { locale, role }, command);
    return { path, report };
  }));
}

function validateReportSelection(report, shard, { locale, role }, command) {
  assert.equal(report.shard, shard);
  assert.equal(report.locale, locale);
  assert.equal(report.role, role);
  assert.deepEqual(report.selection, browserShardArguments({ ...command.env, WASALX_E2E_SHARD: `${shard}/3`,
    WASALX_E2E_LOCALE: locale, WASALX_E2E_ROLE: role }));
}

export function validateShardReceipt(receipt, identity) {
  validateCiEvidence(receipt, "browser-shards");
  assert.deepEqual(receipt.executionContext, identity.executionContext, "browser shard CI context differs");
  assert.equal(receipt.kind, "browser-shard");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.exitCode, 0);
  for (const [key, value] of Object.entries(identity)) assert.deepEqual(receipt.partition[key], value, `browser shard ${key} differs`);
  assert.deepEqual(receipt.candidateState.before, { sha: identity.candidateSha, tree: identity.candidateTree, clean: true });
  assert.deepEqual(receipt.candidateState.after, receipt.candidateState.before);
}

export async function verifyBrowserPartition(manifest, command, readJson) {
  const partition = manifest.browserPartition;
  assert.equal(partition.count, browserShardCount);
  assert.equal(partition.inputDigest, browserDigest({ candidateTree: manifest.candidateTree, command }));
  const plan = browserShardPlan(command);
  assert.equal(partition.mappingVersion, plan.version);
  assert.equal(partition.mappingDigest, browserDigest(plan));
  assert.equal(partition.inventoryPath, "output/playwright/application/shard-inventory.json");
  const inventory = await readJson(partition.inventoryPath);
  assert.equal(browserDigest(inventory), partition.inventoryDigest, "browser inventory changed");
  assert.equal(inventory.candidateSha, manifest.candidateSha);
  assert.equal(inventory.candidateTree, manifest.candidateTree);
  assert.deepEqual(partition.receipts, inventory.receipts);
  assert.deepEqual(partition.receipts.map(item => item.shard), [1, 2, 3], "missing or duplicate browser shard");
  const reports = [];
  for (const item of partition.receipts) {
    assert.equal(item.path, `output/release-evidence/${manifest.candidateSha}/browser-shards/${item.shard}.json`);
    const receipt = await readJson(item.path);
    assert.equal(browserDigest(receipt), item.digest, "browser receipt changed");
    validateShardReceipt(receipt, shardIdentity(manifest.candidateSha, manifest.candidateTree, command, {
      WASALX_CI_RUNTIME: manifest.executionContext.WASALX_CI_RUNTIME, WASALX_CI_SCOPE: manifest.executionContext.scope,
      WASALX_CI_ROUTE: manifest.executionContext.route, WASALX_CI_SELECTOR: JSON.stringify(manifest.executionContext.selector),
      WASALX_E2E_SHARD: `${item.shard}/3`, GITHUB_WORKFLOW_REF: partition.workflow,
      GITHUB_RUN_ID: partition.runId, GITHUB_RUN_ATTEMPT: partition.runAttempt, GITHUB_JOB: "browser-shards" }));
    const paths = browserContexts(command).map(({ locale, role }) => browserReportPath(item.shard, locale, role));
    assert.deepEqual(receipt.partition.reports.map(row => row.path), paths);
    for (const [index, row] of receipt.partition.reports.entries()) {
      const report = await readJson(row.path);
      assert.equal(browserDigest(report), row.digest, "browser execution report changed");
      validateReportSelection(report, item.shard, browserContexts(command)[index], command);
      reports.push(report);
    }
  }
  assert.deepEqual(validateBrowserPartition(inventory.baseline, reports), partition.counts);
  assert.deepEqual(inventory.counts, partition.counts);
}
