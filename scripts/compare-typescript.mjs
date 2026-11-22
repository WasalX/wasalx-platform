import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const tools = resolve(process.argv[2]);
const workspaceRequire = createRequire(resolve("package.json"));
const toolsRequire = createRequire(join(tools, "package.json"));
const legacy = workspaceRequire("typescript");
const native = toolsRequire("typescript-native");
const parserCompiler = "typescript-eslint-compiler";
const legacyPackage = workspaceRequire.resolve("typescript/package.json");
const legacyCli = join(dirname(legacyPackage), "bin", "tsc");
const nativeCli = join(dirname(toolsRequire.resolve("typescript-native/package.json")), "bin", "tsc");
const fixture = fileURLToPath(new URL("./fixtures/typescript-diagnostics/tsconfig.json", import.meta.url));
const pnpm = process.platform === "win32" ? "cmd.exe" : "pnpm";
const buildArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd run build:services"] : ["run", "build:services"];

function report(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function compile(cli, args) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args, "--pretty", "false"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  const seconds = Number(((performance.now() - start) / 1000).toFixed(3));
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Compiler interrupted: ${result.signal}`);
  assert.equal(result.stderr.trim(), "", "Unexpected compiler stderr");
  const diagnostics = result.stdout.replaceAll("\r\n", "\n").trim().split(/\n(?=\S)/u).filter(Boolean).sort();
  assert(diagnostics.every(line => /^(?:.+\(\d+,\d+\): )?error TS\d+: /u.test(line)), result.stdout);
  assert.equal(result.status === 0, diagnostics.length === 0, result.stdout);
  return { seconds, diagnostics };
}

function build(version) {
  const start = performance.now();
  execFileSync(pnpm, buildArgs, { stdio: "inherit", windowsHide: true });
  report(`TypeScript ${version} build:services wall time: ${((performance.now() - start) / 1000).toFixed(3)} s`);
}

function emitManifest(directories) {
  const manifest = {};
  for (const directory of directories.filter(existsSync)) {
    for (const file of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (file.isDirectory()) continue;
      assert(file.isFile(), `Unexpected non-file in compiler output: ${file.name}`);
      const path = join(file.parentPath, file.name);
      manifest[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  assert(Object.keys(manifest).length > 0, "build:services produced no files");
  return manifest;
}

function compareEmit(outputs, legacyEmit) {
  for (const directory of outputs.filter(existsSync)) rmSync(directory, { recursive: true });
  // Swap the shared CLI entry in this checkout. The package API and workspace build commands stay intact.
  const backup = `${legacyCli}.original`;
  assert(!existsSync(backup), "Compiler CLI backup already exists");
  renameSync(legacyCli, backup);
  try {
    writeFileSync(legacyCli, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(nativeCli).href)});\n`, { flag: "wx", mode: 0o755 });
    assert.equal(execFileSync(process.execPath, [legacyCli, "--version"], { encoding: "utf8" }).trim(), `Version ${native.version}`);
    build(native.version);
  } catch (error) {
    report("Service emit: TypeScript 7 build failed. Byte comparison and unit suite are unavailable.");
    throw error;
  } finally {
    rmSync(legacyCli, { force: true });
    renameSync(backup, legacyCli);
  }
  const nativeEmit = emitManifest(outputs);
  const files = new Set([...Object.keys(legacyEmit), ...Object.keys(nativeEmit)]);
  const differences = [...files].filter(path => legacyEmit[path] !== nativeEmit[path]).sort();
  report(`Service emit: ${differences.length === 0 ? `byte-identical (${files.size} files)` : `${differences.length} differing files; run the unit suite on the TypeScript 7 emit`}.`);
  if (differences.length) console.log(differences.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `emit=${differences.length ? "different" : "identical"}\n`);
}

assert.equal(legacy.version, "5.9.3");
assert.equal(native.version, "7.0.2");
assert.equal(execFileSync(process.execPath, [nativeCli, "--version"], { encoding: "utf8" }).trim(), `Version ${native.version}`);
assert.equal(typeof native.createSourceFile, "undefined", "Recheck the lint parser's TypeScript binding");
const alias = toolsRequire(parserCompiler);
assert.equal(alias.version, legacy.version);
assert.equal(typeof alias.createSourceFile, "function");
const parserUrl = pathToFileURL(toolsRequire.resolve(parserCompiler)).href;
let usedAlias = false;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "typescript") return nextResolve(specifier, context);
    usedAlias = true;
    return { url: parserUrl, shortCircuit: true };
  },
});
try {
  const { ast } = workspaceRequire("typescript-eslint").parser.parseForESLint("const value: number = 1;");
  assert.equal(ast.body[0].declarations[0].id.typeAnnotation.typeAnnotation.type, "TSNumberKeyword");
  assert(usedAlias, "typescript-eslint did not resolve the pinned alias");
} finally {
  hook.deregister();
}
report(`Lint parser: TypeScript ${native.version} lacks createSourceFile; typescript-eslint parsed a typed declaration with ${parserCompiler}@${alias.version}.`);

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
if (process.env.GITHUB_ACTIONS === "true") assert.equal(sha, process.env.EXPECTED_COMPARISON_SHA);
report(`Checkout: ${sha} (tree ${tree})`);

const projects = ["packages", "services"].flatMap(root => readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)));
const outputs = projects.map(project => join(project, "dist"));
assert(outputs.every(directory => !existsSync(directory)), "Use a fresh checkout without existing dist directories");
for (const project of projects) {
  const localCompiler = join(project, "node_modules", "typescript", "package.json");
  if (existsSync(localCompiler)) assert.equal(realpathSync(localCompiler), realpathSync(legacyPackage));
}

build(legacy.version);
const project = legacy.getParsedCommandLineOfConfigFile("tsconfig.json", {}, {
  ...legacy.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(diagnostic.messageText),
});
const seedArgs = ["-p", fixture, ...(project.options.noUnusedLocals ? ["--noUnusedLocals"] : [])];
const timingDirectory = mkdtempSync(join(tools, "typecheck-"));
const timings = [];
const seeds = [];
for (const [version, cli] of [[legacy.version, legacyCli], [native.version, nativeCli]]) {
  const result = compile(cli, ["--noEmit", "--tsBuildInfoFile", join(timingDirectory, `${version}.tsbuildinfo`)]);
  timings.push(result);
  report(`TypeScript ${version} typecheck wall time: ${result.seconds} s (${result.diagnostics.length} diagnostics)`);
  seeds.push(compile(cli, seedArgs).diagnostics);
}
console.log(`TS_COMPARISON_TIMINGS ${JSON.stringify({
  sha, tree, checkout: process.env.COMPARISON_TREE, run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT, ts5: timings[0].seconds, ts7: timings[1].seconds,
})}`);

const codes = seeds[0].map(line => Number(line.match(/\berror TS(\d+): /u)[1])).sort((a, b) => a - b);
const expectedCodes = project.options.noUnusedLocals ? [2314, 2322, 2741, 6133] : [2314, 2322, 2741];
const clean = timings.every(({ diagnostics }) => diagnostics.length === 0);
const seedMatches = isDeepStrictEqual(seeds[1], seeds[0]) && isDeepStrictEqual(codes, expectedCodes);
report(`Clean repository typecheck with both compilers: ${clean ? "yes" : "no"}.`);
report(seedMatches ? `Seeded diagnostics match (${codes.map(code => `TS${code}`).join(", ")}).` : "Seeded diagnostics did not match the expected set.");
if (!clean || !seedMatches) {
  for (const [index, version] of [legacy.version, native.version].entries()) {
    console.log(`TypeScript ${version} repository diagnostics:\n${timings[index].diagnostics.join("\n")}`);
    console.log(`TypeScript ${version} seeded diagnostics:\n${seeds[index].join("\n")}`);
  }
}

if (process.env.COMPARISON_TREE !== "main") compareEmit(outputs, emitManifest(outputs));

assert.deepEqual(timings[1].diagnostics, timings[0].diagnostics, "Repository TypeScript diagnostics differ");
assert.deepEqual(timings[0].diagnostics, [], "Expected a clean repository typecheck");
assert.deepEqual(seeds[1], seeds[0], "Seeded TypeScript diagnostics differ");
assert.deepEqual(codes, expectedCodes);
