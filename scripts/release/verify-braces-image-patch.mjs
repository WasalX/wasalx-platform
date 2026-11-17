import assert from "node:assert/strict";
import { access, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { bracesPatchHash, verifyBracesRuntime } from "../verify-braces-patch.mjs";

const [imageReference, platform, modules = "/app/node_modules"] = process.argv.slice(2);
assert.match(imageReference ?? "", /^ghcr\.io\/wasalx\/wasalx\/[a-z-]+@sha256:[0-9a-f]{64}$/u);
assert.equal(platform, "linux/amd64");
const candidates = (await readdir(join(modules, ".pnpm")))
  .filter(name => name.startsWith("braces@"))
  .map(name => join(modules, ".pnpm", name, "node_modules/braces"));
try {
  await access(join(modules, "braces/package.json"));
  candidates.push(join(modules, "braces"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assert.ok(candidates.length > 0, "No packaged braces copy found");
const copies = new Map();
for (const candidate of candidates) {
  const root = await realpath(candidate);
  let copy = copies.get(root);
  if (!copy) {
    copy = { ...await verifyBracesRuntime(root), packageJsonPaths: [] };
    copies.set(root, copy);
  }
  copy.packageJsonPaths.push(join(candidate, "package.json"));
}
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1, status: "verified", imageReference, platform,
  patchHash: bracesPatchHash, copies: [...copies.values()],
})}\n`);
