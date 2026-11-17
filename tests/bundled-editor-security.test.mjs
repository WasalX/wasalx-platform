import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("storybook/package.json"));
const source = await readFile(path.join(packageRoot, "dist/core-server/presets/common-preset.js"), "utf8");
const start = source.indexOf("// ../../node_modules/launch-editor/index.js");
const end = source.indexOf("// src/core-server/presets/common-preset.ts", start);
assert.ok(start >= 0 && end > start, "Review the bundled editor when Storybook changes");
const editorModule = source.slice(start, end);

function editor(platform = "win32", exists = () => true) {
  const commands = [], lookups = [], errors = [];
  const api = platform === "win32" ? path.win32 : path.posix;
  const child = { on() { return this; }, kill() { assert.fail("Unexpected existing editor termination"); } };
  const dependencies = {
    fs: { existsSync(file) { lookups.push(file); return exists(file, api); } },
    os: { release: () => "Linux" }, path: api,
    url: { fileURLToPath: file => fileURLToPath(file, { windows: platform === "win32" }) },
    child_process: {
      exec(command) { commands.push({ type: "exec", command }); return child; },
      spawn(command, args) { commands.push({ type: "spawn", command, args }); return child; },
    },
  };
  const launch = vm.runInNewContext(`${editorModule}\nrequire_launch_editor()`, {
    __commonJS: definitions => () => { const bundledModule = { exports: {} }; Object.values(definitions)[0]({}, bundledModule); return bundledModule.exports; },
    __require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
    require_picocolors: () => ({ red: value => value }),
    require_guess: () => () => [platform === "win32" ? "C:\\Program Files\\Editor\\editor.exe" : "/usr/bin/editor"],
    require_get_args: () => (_editor, file, line, column) => [`${file}:${line}${column ? `:${column}` : ""}`],
    process: { platform, env: {} }, console: { log() {} },
  }, { timeout: 1000 });
  return { commands, lookups, errors, launch: file => launch(file, undefined, (_file, error) => errors.push(error)) };
}

test("bundled Storybook editor resolves the position suffix before Windows existence checks", () => {
  const h = editor("win32", (file, api) => api.resolve(file) === "C:\\repo");
  h.launch("C:\\repo\\%INJECT%\\..:12:3");
  assert.deepEqual(h.lookups, ["C:\\repo"]);
  assert.equal(h.commands.length, 1);
  assert.doesNotMatch(h.commands[0].command, /%|INJECT/);
  assert.ok(h.commands[0].command.includes("C:\\repo:12:3"));
  const empty = editor("win32", file => file !== "");
  empty.launch(":1:1");
  assert.equal(empty.commands.length, 0);
});

test("bundled Storybook editor refuses Windows shell expansion and command separators", () => {
  for (const file of ["C:\\repo\\%INJECT%.tsx", "C:\\repo\\bad\r\ncommand.ts", "C:\\repo\\bad\ncommand.ts"]) {
    const h = editor(); h.launch(file);
    assert.equal(h.commands.length, 0, JSON.stringify(file));
    assert.equal(h.errors.length, 1);
  }
});

test("bundled Storybook editor rejects Windows network paths before filesystem access", () => {
  for (const file of ["\\\\server\\share\\file.ts:1:1", "file://server/share/file.ts"]) {
    const h = editor(); h.launch(file);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.commands, []);
    assert.match(h.errors[0], /UNC paths/);
  }
});

test("bundled Storybook editor preserves legitimate Windows positions and POSIX filenames", () => {
  const windows = editor();
  windows.launch("C:\\repo\\safe folder\\[slug]&(group).tsx:12:3");
  assert.equal(windows.commands.length, 1);
  assert.ok(windows.commands[0].command.includes("[slug]^&(group).tsx:12:3"));
  assert.deepEqual(windows.errors, []);
  const posix = editor("linux"); posix.launch("/repo/%literal%.tsx:2:4");
  assert.equal(posix.commands[0].type, "spawn");
  assert.equal(posix.commands[0].args[0], "/repo/%literal%.tsx:2:4");
  assert.deepEqual(posix.errors, []);
});
