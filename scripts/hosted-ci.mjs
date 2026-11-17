import "../tests/helpers/operator-input-fixtures.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unitFiles, unitFileTimings } from "./test-unit.mjs";
import { addonSkips, lintRatchet, skipPattern } from "./hosted-ci-policy.mjs";

const config = JSON.parse(readFileSync(new URL("./hosted-ci-config.json", import.meta.url)));
const timings = JSON.parse(readFileSync(new URL("./hosted-ci-timings.json", import.meta.url)));

const unitTimings = { ...timings.filesMs, ...unitFileTimings };

export function shardFiles(files, shard, total, durations = unitTimings) {
  assert(Number.isSafeInteger(total) && total > 0, "Invalid shard count");
  assert(Number.isSafeInteger(shard) && shard >= 1 && shard <= total, "Invalid shard");
  const weight = file => durations[file] ?? timings.defaultMs;
  const shards = Array.from({ length: total }, () => ({ files: [], duration: 0 }));
  for (const file of [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"))) {
    const next = shards.reduce((lightest, candidate) => candidate.duration < lightest.duration ? candidate : lightest);
    next.files.push(file);
    next.duration += weight(file);
  }
  return shards[shard - 1].files;
}

export function inventory(tracked) {
  // Keep the existing declared inventory and collect additional Node test files.
  const discovered = tracked.filter(file => /\.test\.(?:mjs|cjs|js|ts)$/u.test(file)
    && !file.startsWith("tests/zammad-sidebar-component/"));
  return [...new Set([...unitFiles, ...discovered])].sort();
}

export function collectionFiles(tracked) {
  // Unit shards already prove their imports; collect the additional hosted scope.
  return inventory(tracked).filter(file => !unitFiles.includes(file)
    && !config.excludedPatterns.some(pattern => matchesGlob(file, pattern)));
}

export async function collectFile(file, timeout = 45_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--import", "./tests/helpers/operator-input-fixtures.mjs",
      "--test", "--test-reporter=tap", "--experimental-test-isolation=none", "--test-name-pattern=(?!)", file],
    { env, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return { file, failed: false };
  } catch (error) {
    return { file, failed: true, diagnostic: error.killed ? "Collection import timed out" : (error.stderr || error.stdout || error.message).slice(-8000) };
  }
}

async function main() {
  const [mode, shard, total] = process.argv.slice(2);
  assert(["lint", "unit", "collection"].includes(mode), "Expected lint, unit or collection");
  if (mode === "lint") {
    const report = ".git/hosted-lint.json";
    rmSync(report, { force: true });
    const result = spawnSync("pnpm", ["run", "lint", "--cache", "--cache-strategy", "content",
      "--cache-location", ".git/hosted-eslint-cache", "--format", "json", "--output-file", report], { stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    assert(result.status === 0 || result.status === 1, "ESLint failed to execute");
    const current = lintRatchet(JSON.parse(readFileSync(report, "utf8")));
    assert.equal(result.status, current.count ? 1 : 0, "Lint exit status disagrees with its report");
    const lines = [`Lint errors: ${current.count}; recorded: ${current.recorded}`, ...current.regressions];
    if (current.decreased) lines.push("Lint improved: lower the recorded numbers in scripts/hosted-ci-baseline.mjs to the current file/rule counts.");
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("  \n") + "\n");
    process.exitCode = current.regressions.length ? 1 : 0;
    return;
  }
  const tracked = execFileSync("git", ["ls-files", "-z", "tests"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const files = mode === "collection" ? collectionFiles(tracked) : inventory(tracked);
  assert(files.length > 0 && files.every(file => file.startsWith("tests/") && !file.includes("..")));
  if (mode === "unit") {
    const runnable = [...unitFiles, "tests/hosted-ci.test.mjs"]
      .filter(file => !config.excludedPatterns.some(pattern => matchesGlob(file, pattern)));
    const selected = shardFiles(runnable, Number(shard), Number(total));
    assert(selected.length > 0, "Empty unit shard");
    console.log(`Unit shard ${shard}/${total}: ${selected.length} of ${runnable.length} files`);
    const skipped = selected.map(file => ({ file, entries: addonSkips(file) })).filter(batch => batch.entries.length);
    const ordinary = selected.filter(file => !skipped.some(batch => batch.file === file));
    const batches = [{ files: ordinary, entries: [] }, ...skipped.map(batch => ({ files: [batch.file], entries: batch.entries }))];
    const reporters = process.env.GITHUB_ACTIONS === "true" ? [
      "--test-reporter=spec", "--test-reporter=./scripts/hosted-ci-timing-reporter.mjs",
      "--test-reporter-destination=stdout", "--test-reporter-destination=stdout",
    ] : [];
    for (const { files, entries } of batches) {
      if (!files.length) continue;
      const lines = entries.map(entry => `SKIP: ${entry.file} :: ${entry.name}: ${entry.reason} (missing ${entry.input}; entrypoint ${files[0]})`);
      console.log(lines.join("\n"));
      if (process.env.GITHUB_STEP_SUMMARY && lines.length) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("  \n") + "\n");
      const pattern = entries.length ? [`--test-skip-pattern=${skipPattern(entries)}`] : [];
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./tests/helpers/operator-input-fixtures.mjs", "--test", "--test-concurrency=4", ...reporters, ...pattern, ...files], { stdio: "inherit", windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exitCode = result.status ?? 1;
    }
    return;
  }
  // Import modules while skipping test bodies, matching the existing collection method.
  // The test runner's test timeout does not bound a hanging module import.
  const failures = [];
  for (let offset = 0; offset < files.length; offset += 4) {
    const results = await Promise.all(files.slice(offset, offset + 4).map(file => collectFile(file)));
    for (const result of results) {
      console.log(`${result.failed ? "COLLECTION FAILURE" : "COLLECTED"}: ${result.file}`);
      if (result.failed) {
        failures.push(result.file);
        console.error(result.diagnostic);
      }
    }
  }
  const lines = ["Collection results (unit imports are checked by the unit shards)", `Additional files: ${files.length}; errors: ${failures.length}`,
    ...failures.map(file => `UNEXPECTED FAILURE: ${file}`)];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("  \n") + "\n");
  process.exitCode = failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
