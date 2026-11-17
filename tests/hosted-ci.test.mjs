import assert from "node:assert/strict";
import test from "node:test";
import { inventory, shardFiles, unexpectedFailures } from "../scripts/hosted-ci.mjs";

test("shards cover each file once regardless of inventory order or duplicates", () => {
  const files = ["d", "a", "b", "c", "a"];
  const shards = [1, 2, 3].map(shard => shardFiles(files, shard, 3));
  assert.deepEqual(shards, [["a", "d"], ["b"], ["c"]]);
  assert.deepEqual(shards.flat().sort(), ["a", "b", "c", "d"]);
  assert.throws(() => shardFiles(files, 0, 3));
  assert.throws(() => shardFiles(files, 4, 3));
  assert.throws(() => shardFiles(files, 1, 0));
});

test("collection allows only named failures and fails closed on every new file", () => {
  assert.deepEqual(unexpectedFailures(["known", "new"], ["known"]), ["new"]);
  assert.deepEqual(unexpectedFailures([], ["known"]), []);
  const files = inventory(["tests/new.test.ts", "tests/new.test.ts", "tests/fixture.mjs"]);
  assert.equal(files.filter(file => file === "tests/new.test.ts").length, 1);
  assert(!files.includes("tests/fixture.mjs"));
});
