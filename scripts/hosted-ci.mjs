import "../tests/helpers/operator-input-fixtures.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { matchesGlob, relative, resolve } from "node:path";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { pathToFileURL } from "node:url";
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

async function main() {
  const [mode, shard, total] = process.argv.slice(2);
  assert(["unit", "collection"].includes(mode), "Expected unit or collection");
  const tracked = execFileSync("git", ["ls-files", "-z", "tests"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const files = inventory(tracked);
  assert(files.length > 0 && files.every(file => file.startsWith("tests/") && !file.includes("..")));
  if (mode === "unit") {
    const runnable = files.filter(file => !config.excludedPatterns.some(pattern => matchesGlob(file, pattern)));
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
  const failures = [];
  const stream = run({ files, concurrency: 4, testNamePatterns: [/(?!) /u],
    execArgv: ["--experimental-strip-types", "--import", "./tests/helpers/operator-input-fixtures.mjs"], timeout: 45_000 });
  stream.on("test:fail", data => failures.push(relative(process.cwd(), resolve(data.file ?? data.name)).replaceAll("\\", "/")));
  for await (const chunk of stream.compose(tap)) process.stdout.write(chunk);
  const unexpected = unexpectedFailures(failures, known);
  const lines = ["Collection results", `Files: ${files.length}; unexpected errors: ${unexpected.length}`,
    ...known.map(file => `${failures.includes(file) ? "KNOWN FAILURE" : "NOW PASSES"}: ${file}`),
    ...unexpected.map(file => `UNEXPECTED FAILURE: ${file}`)];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("  \n") + "\n");
  process.exitCode = unexpected.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
