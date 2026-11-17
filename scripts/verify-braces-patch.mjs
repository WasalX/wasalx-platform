import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Runtime diff from micromatch/braces PR 72, commit
// 28d440b5dd449dbf1fe6f3506cf94ecca4d02660, applied to npm 3.0.3.
// Retain 3.0.3's quote parsing; do not import unrelated upstream changes.
// Remove after an upstream fixed release.
export const bracesPatchHash = "cecdb90ea3f216ffb13f31d757e9e26239b040179ba9235326e1a6041cb3b055";
export const bracesRuntimeHashes = {
  "lib/compile.js": "b651f7715e6db8942ce61d3394357b4d81c8ece88240aa31a458ea1165edd195",
  "lib/constants.js": "f9fb688959232eee3e6ad7906a5b0e3234815db49ee857ef86983d65b917dc7c",
  "lib/expand.js": "7ea3e14c2b2b256ef244fd3d83b8fcaa20aa2232b4e6d768c3bb6ab567f66cf5",
  "lib/parse.js": "72aabaadaa555cdfbd07fbd7c7f743373e4dc8eec04a97550cc57bbeec30eb6c",
  "lib/stringify.js": "49dc2d8bafa74f34715a18a845bcb82ce66caaf3bab4cf117998e06b1f9a50a9",
};
export const bracesPaths = [
  ".>vinext>vite-plugin-commonjs>vite-plugin-dynamic-import>fast-glob>micromatch>braces",
  ".>@next/eslint-plugin-next>fast-glob>micromatch>braces",
];
export const sha256 = value => createHash("sha256").update(value).digest("hex");

export async function verifyBracesRuntime(packageRoot) {
  const root = await realpath(packageRoot);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "braces");
  assert.equal(pkg.version, "3.0.3");
  for (const [file, hash] of Object.entries(bracesRuntimeHashes)) {
    assert.equal(sha256(await readFile(join(root, file))), hash, `Unverified braces runtime: ${file}`);
  }
  const require = createRequire(join(root, "package.json"));
  const braces = require(root);
  assert.deepEqual(braces.expand("a{b,c}"), ["ab", "ac"]);
  assert.throws(() => braces("{".repeat(101) + "a" + "}".repeat(101)), /exceeds max depth/);
  let ast = { type: "text", value: "a" };
  for (let i = 0; i < 101; i++) ast = { type: "paren", nodes: [ast] };
  for (const method of ["compile", "expand", "stringify"]) {
    assert.throws(() => braces[method](structuredClone(ast)), /AST depth .*exceeds max depth/);
  }
  return { root, name: pkg.name, version: pkg.version, files: bracesRuntimeHashes, behavior: "verified" };
}

export async function verifyBracesPatch() {
  const roots = new Set();
  for (const path of bracesPaths) {
    const names = path.split(">").slice(1);
    let require = createRequire(import.meta.resolve(names[0]));
    let entry;
    for (const name of names.slice(1)) {
      entry = require.resolve(name);
      require = createRequire(entry);
    }
    const root = await realpath(dirname(entry));
    if (roots.has(root)) continue;
    roots.add(root);
    await verifyBracesRuntime(root);
  }
  return roots.size;
}
