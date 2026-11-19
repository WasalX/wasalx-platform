import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { collectFile, collectionFiles, inventory, shardFiles } from "../scripts/hosted-ci.mjs";
import { addonSkips, skipPattern } from "../scripts/hosted-ci-policy.mjs";
import { generateBaseline } from "../scripts/generate-hosted-ci-baseline.mjs";
import baseline from "../scripts/hosted-ci-baseline.mjs";

test("shards cover each file once regardless of inventory order or duplicates", () => {
  const files = ["d", "a", "b", "c", "a"];
  const shards = [1, 2, 3].map(shard => shardFiles(files, shard, 3));
  assert.deepEqual(shards, [["a", "d"], ["b"], ["c"]]);
  assert.deepEqual(shards.flat().sort(), ["a", "b", "c", "d"]);
  assert.throws(() => shardFiles(files, 0, 3));
  assert.throws(() => shardFiles(files, 4, 3));
  assert.throws(() => shardFiles(files, 1, 0));
});

test("measured sharding spreads slow files and packs the remaining work", () => {
  const durations = { a: 10, b: 9, c: 8, d: 7, e: 6, f: 5 };
  const files = Object.keys(durations).reverse();
  const shards = [1, 2, 3].map(shard => shardFiles(files, shard, 3, durations));
  assert.deepEqual(shards, [["a", "f"], ["b", "e"], ["c", "d"]]);
});

test("collection covers new hosted files and leaves unit and runtime imports to their own gates", () => {
  const files = inventory(["tests/new.test.ts", "tests/new.test.ts", "tests/fixture.mjs"]);
  assert.equal(files.filter(file => file === "tests/new.test.ts").length, 1);
  assert(!files.includes("tests/fixture.mjs"));
  assert.deepEqual(collectionFiles(["tests/new.test.ts", "tests/dev-secret-sidecar.test.mjs", "tests/zammad-image-browser-compat.test.mjs"]), ["tests/new.test.ts"]);
});

test("collection skips test bodies, reports import errors and kills hanging imports", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-ci-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = join(directory, "valid.mjs"), invalid = join(directory, "invalid.mjs"), hanging = join(directory, "hanging.mjs");
  await writeFile(valid, "import test from 'node:test'; test('skipped body',()=>{throw new Error('BODY_EXECUTED');});\n");
  await writeFile(invalid, "throw new Error('IMPORT_FAILED');\n");
  await writeFile(hanging, "setInterval(()=>{},1000); await new Promise(()=>{});\n");
  assert.equal((await collectFile(valid)).failed, false);
  const failure = await collectFile(invalid);
  assert.equal(failure.failed, true);
  const timeout = await collectFile(hanging, 2000);
  assert.equal(timeout.failed, true);
  assert.equal(timeout.diagnostic, "Collection import timed out");
});

test("add-on exceptions bind exact entrypoints and names and disappear as inputs arrive", async t => {
  assert.equal(baseline.tests.length, 10);
  assert.equal(new Set(baseline.tests.map(entry => entry.file + "::" + entry.name)).size, 9);
  assert.deepEqual(addonSkips("tests/unlisted.test.mjs", () => false), []);
  for (const entry of baseline.tests) {
    assert.equal(entry.reason, "needs the add-on source");
    assert(addonSkips(entry.entrypoint, () => false).includes(entry));
    assert(!addonSkips(entry.entrypoint, input => input === entry.input).includes(entry));
  }
  const directory = await mkdtemp(join(tmpdir(), "hosted-addon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.mjs");
  const name = baseline.tests[0].name;
  const pattern = skipPattern([{ name }]);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = args => spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...args, file], { env, encoding: "utf8", windowsHide: true });
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name)},()=>{throw Error('ADDON_TEST_EXECUTED')});\n`);
  assert.equal(run([`--test-skip-pattern=${pattern}`]).status, 0);
  assert.equal(run([]).status, 1);
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name + " new")},()=>{throw Error('UNLISTED_FAILURE')});\n`);
  assert.equal(run([`--test-skip-pattern=${pattern}`]).status, 1);
  await writeFile(file, `import test from 'node:test'; test(${JSON.stringify(name)},()=>{throw Error('FOREIGN_FILE_FAILURE')});\n`);
  assert.equal(addonSkips(file).length, 0);
  assert.equal(run([]).status, 1);
  assert(new RegExp(skipPattern([{ name: "literal (name) [x].*" }])).test("literal (name) [x].*"));
});

test("baseline generation retains every logged failure and rejects unclassified failures", () => {
  const root = "/home/runner/work/wasalx-platform/wasalx-platform/";
  const line = (job, text) => `${job}\tstep\t${text}`;
  const failures = Array.from({ length: 10 }, (_, i) => [
    line("Unit 1/6", `test at tests/case-${i}.test.mjs:1:1`),
    line("Unit 1/6", `✖ case ${i} (0.1ms)`),
    line("Unit 1/6", `  Error: ENOENT: no such file or directory, open '${root}zammad-package/file-${i}.rb'`),
  ]).flat();
  const log = failures.join("\n");
  const generated = generateBaseline(log);
  assert.equal(generated.tests[9].name, "case 9");
  assert.equal(generated.tests[9].input, "zammad-package/file-9.rb");
  assert.throws(() => generateBaseline(log.replace("open '", "unexpected '")));
});
