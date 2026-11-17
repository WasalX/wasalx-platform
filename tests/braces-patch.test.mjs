import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bracesPatchHash, bracesPaths, sha256, verifyBracesPatch } from "../scripts/verify-braces-patch.mjs";

let require = createRequire(import.meta.resolve("@next/eslint-plugin-next"));
for (const name of ["fast-glob", "micromatch"]) require = createRequire(require.resolve(name));
const braces = require("braces");
const pattern = depth => "{".repeat(depth) + "a,b" + "}".repeat(depth);

test("both dependency chains resolve verified patched runtime files", async () => {
  assert.equal(await verifyBracesPatch(), 1);
});

test("bounded strings preserve ordinary patterns and reject excessive combined nesting", () => {
  assert.deepEqual(braces.expand("a{b,c}{1..2}"), ["ab1", "ab2", "ac1", "ac2"]);
  for (const method of ["parse", "compile", "expand", "stringify"]) {
    assert.doesNotThrow(() => braces[method](pattern(100)));
    for (const options of [{}, { maxDepth: Infinity }, { maxDepth: 1000 }]) {
      assert.throws(() => braces[method](pattern(101), options), /exceeds max depth/);
    }
    assert.throws(() => braces[method](pattern(2), { maxDepth: 1.5 }), /exceeds max depth/);
  }
  assert.throws(() => braces.parse("({".repeat(51) + "x" + "})".repeat(51)), /exceeds max depth/);
  assert.throws(() => braces.parse("(".repeat(101) + "x" + ")".repeat(101)), /exceeds max depth/);
  assert.equal(braces.stringify(braces.parse("{a,b", { escapeInvalid: true }), { escapeInvalid: true }), "{a,b");
  const micromatch = require("./index.js");
  assert.deepEqual(micromatch(["src/a.js", "src/b.ts", "src/c.css"], "src/*.{js,ts}"), ["src/a.js", "src/b.ts"]);
});

test("direct AST walkers reject excessive depth and parent cycles", () => {
  let ast = { type: "text", value: "x" };
  for (let depth = 0; depth < 101; depth++) ast = { type: "paren", nodes: [ast] };
  for (const method of ["compile", "expand", "stringify"]) {
    assert.throws(() => braces[method](structuredClone(ast)), /AST depth .*exceeds max depth/);
  }
  const node = { type: "paren", nodes: [] };
  node.parent = node;
  assert.throws(() => braces.expand(node), /parent chain contains a cycle/);
  node.parent = { type: "paren", nodes: [], parent: node };
  assert.throws(() => braces.expand(node), /parent chain contains a cycle/);
});

test("audit accepts only exact verified braces findings and fails closed on missing proof", async () => {
  const source = (await readFile(new URL("../scripts/audit-dependencies.mjs", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gmu, "").replaceAll("import.meta.url", "auditUrl");
  const auditUrl = new URL("../scripts/audit-dependencies.mjs", import.meta.url).href;
  for (const mode of ["patched", "module", "version", "path", "advisory", "empty-findings", "empty-paths", "missing-patch", "tampered-patch", "unbound-lock", "verifier-failed"]) {
    const advisory = { severity: "high", title: "braces depth", module_name: "braces", github_advisory_id: "GHSA-vfj7-8cjw-p6xm", findings: [{ version: "3.0.3", paths: [...bracesPaths] }] };
    if (mode === "module") advisory.module_name = "other";
    if (mode === "version") advisory.findings[0].version = "3.0.2";
    if (mode === "path") advisory.findings[0].paths.push(".>unexpected>braces");
    if (mode === "advisory") advisory.github_advisory_id = "GHSA-other";
    if (mode === "empty-findings") advisory.findings = [];
    if (mode === "empty-paths") advisory.findings[0].paths = [];
    const stdout = [];
    const execution = runInNewContext(`(async () => {${source}})()`, {
      URL, auditUrl, bracesPatchHash, bracesPaths, sha256,
      readFile: async (url, encoding) => {
        if (String(url).endsWith("braces@3.0.3.patch")) {
          if (mode === "missing-patch") throw new Error("missing patch");
          if (mode === "tampered-patch") return Buffer.from("tampered");
        }
        const content = await readFile(url, encoding);
        return mode === "unbound-lock" && String(url).endsWith("pnpm-lock.yaml") ? content.replaceAll(bracesPatchHash, "bad") : content;
      },
      verifyBracesPatch: async () => { if (mode === "verifier-failed") throw new Error("unverified installed runtime"); return verifyBracesPatch(); },
      spawnSync: () => ({ status: 1, stdout: JSON.stringify({ advisories: { finding: advisory } }) }),
      process: { platform: "linux", stdout: { write: value => stdout.push(value) }, stderr: { write: () => {} }, exit: () => { throw new Error("rejected advisory"); } },
    });
    if (mode === "patched") { await execution; assert.equal(JSON.parse(stdout.join("")).high_or_critical_unresolved, 0); }
    else await assert.rejects(execution, /rejected advisory|missing patch|missing or unbound|unverified installed runtime/);
  }
});
