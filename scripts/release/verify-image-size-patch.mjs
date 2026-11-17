#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const requireFromVinext = createRequire(process.argv[2]
  ? await realpath(process.argv[2])
  : import.meta.resolve("vinext"));
const packageRoot = resolve(dirname(requireFromVinext.resolve("image-size")), "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
assert.equal(packageJson.name, "image-size");
assert.equal(packageJson.version, "2.0.2");

for (const [file, marker] of [
  ["dist/index.cjs", "Invalid ICNS entry length"],
  ["dist/index.mjs", "Invalid ICNS entry length"],
  ["dist/types/icns.cjs", "Invalid ICNS entry length"],
  ["dist/types/icns.mjs", "Invalid ICNS entry length"],
  ["dist/types/heif.cjs", "Invalid HEIF ispe box size"],
  ["dist/types/heif.mjs", "Invalid HEIF ispe box size"],
  ["dist/types/jxl.cjs", "Invalid JXL partial stream box size"],
  ["dist/types/jxl.mjs", "Invalid JXL partial stream box size"],
]) {
  assert.match(await readFile(resolve(packageRoot, file), "utf8"), new RegExp(marker), file);
}

const input = new Uint8Array(16);
input.set(new TextEncoder().encode("icns"), 0);
new DataView(input.buffer).setUint32(4, 16, false);
input.set(new TextEncoder().encode("ic07"), 8);
new DataView(input.buffer).setUint32(12, 0, false);
assert.throws(() => requireFromVinext("image-size").imageSize(input), /Invalid ICNS entry length/u);
process.stdout.write(`${JSON.stringify({ package: "image-size", version: "2.0.2", patch: "verified" })}\n`);
