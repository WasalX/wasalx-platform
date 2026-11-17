import "../tests/helpers/operator-input-fixtures.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unitFiles } from "./test-unit.mjs";

const config = JSON.parse(readFileSync(new URL("./hosted-ci-config.json", import.meta.url)));
const known = JSON.parse(readFileSync(new URL("./hosted-ci-known-failures.json", import.meta.url)));

export function shardFiles(files, shard, total) {
  assert(Number.isSafeInteger(total) && total > 0, "Invalid shard count");
  assert(Number.isSafeInteger(shard) && shard >= 1 && shard <= total, "Invalid shard");
  return [...new Set(files)].sort().filter((_, index) => index % total === shard - 1);
}

export function unexpectedFailures(failures, allowed) {
  return failures.filter(file => !allowed.includes(file));
}

export function inventory(tracked) {
  // Keep the existing declared inventory and collect additional Node test files.
  const discovered = tracked.filter(file => /\.test\.(?:mjs|cjs|js|ts)$/u.test(file)
    && !file.startsWith("tests/zammad-sidebar-component/"));
  return [...new Set([...unitFiles, ...discovered])].sort();
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
  assert(["unit", "collection"].includes(mode), "Expected unit or collection");
  const tracked = execFileSync("git", ["ls-files", "-z", "tests"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const files = inventory(tracked);
  assert(files.length > 0 && files.every(file => file.startsWith("tests/") && !file.includes("..")));
  if (mode === "unit") {
    const runnable = [...unitFiles, "tests/hosted-ci.test.mjs"]
      .filter(file => !config.excludedPatterns.some(pattern => matchesGlob(file, pattern)));
    const selected = shardFiles(runnable, Number(shard), Number(total));
    assert(selected.length > 0, "Empty unit shard");
    console.log(`Unit shard ${shard}/${total}: ${selected.length} of ${runnable.length} files`);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./tests/helpers/operator-input-fixtures.mjs", "--test", "--test-concurrency=2", ...selected], { stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  // Import modules while skipping test bodies, matching the existing collection method.
  // Collection includes runtime-only files so new import errors remain visible.
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
  const unexpected = unexpectedFailures(failures, known);
  const lines = ["Collection results", `Files: ${files.length}; unexpected errors: ${unexpected.length}`,
    ...known.map(file => `${failures.includes(file) ? "KNOWN FAILURE" : "NOW PASSES"}: ${file}`),
    ...unexpected.map(file => `UNEXPECTED FAILURE: ${file}`)];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("  \n") + "\n");
  process.exitCode = unexpected.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
