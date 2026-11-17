import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitManagedPayload, ciRuntime } from "./ci-browser-runtime.mjs";

export const RUBY_PREPARATION_JOBS = Object.freeze(["repository", "infrastructure"]);

export function assertRubyPreparationJob(job) {
  assert(RUBY_PREPARATION_JOBS.includes(job), "Ruby preparation requires an admitted repository or infrastructure job");
  return job;
}

const digest = value => createHash("sha256").update(value).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const execute = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", windowsHide: true, ...options })?.trim() ?? "";
const implementation = digest(readFileSync(fileURLToPath(import.meta.url)));
const libyaml = { version: "0.2.5", url: "https://github.com/yaml/libyaml/releases/download/0.2.5/yaml-0.2.5.tar.gz",
  sha256: "c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4" };
const libffi = { version: "3.4.7", url: "https://github.com/libffi/libffi/releases/download/v3.4.7/libffi-3.4.7.tar.gz",
  sha256: "138607dee268bdecf374adf9144c00e839e38541f75f24a1fcf18b78fda48b2d" };
const nativeProbe = `#include <openssl/ssl.h>
#include <yaml.h>
#include <gmp.h>
#include <zlib.h>
#include <crypt.h>
#include <math.h>
#include <ffi.h>
int main(void) {
  SSL_CTX *ctx = SSL_CTX_new(TLS_method());
  yaml_parser_t parser; mpz_t number;
  ffi_cif cif;
  volatile double angle = 0.5;
  if (!ctx || !yaml_parser_initialize(&parser) || !zlibVersion() || !crypt("wasalx-probe", "$6$wasalx-probe$")) return 1;
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 0, &ffi_type_void, NULL) != FFI_OK) return 1;
  if (!isfinite(sin(angle))) return 1;
  mpz_init(number); mpz_clear(number); yaml_parser_delete(&parser); SSL_CTX_free(ctx);
  return 0;
}
`;

const nativeHeaders = [
  ["openssl", "openssl/ssl.h"], ["yaml", "yaml.h"], ["gmp", "gmp.h"], ["zlib", "zlib.h"], ["crypt", "crypt.h"], ["ffi", "ffi.h"],
];
const nativeLibraries = ["ssl", "crypto", "yaml", "gmp", "z", "crypt", "m", "ffi"];

function libyamlPin(env) {
  const pin = { version: libyaml.version, url: env.LIBYAML_SOURCE_URL ?? libyaml.url, sha256: env.LIBYAML_SOURCE_SHA256 ?? libyaml.sha256 };
  assert.match(pin.url, /^https:\/\//u); assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
  return pin;
}

function libffiPin(env) {
  const pin = { version: libffi.version, url: env.LIBFFI_SOURCE_URL ?? libffi.url, sha256: env.LIBFFI_SOURCE_SHA256 ?? libffi.sha256 };
  assert.match(pin.url, /^https:\/\//u); assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
  return pin;
}

function probeDiagnostics(run, env) {
  for (const command of [
    "dpkg-query -W -f='${Package} ${Version}\\n' '*-dev' 2>/dev/null | sort",
    "pkg-config --list-all 2>/dev/null | sort",
  ]) {
    try { run("bash", ["-c", command], { env, stdio: "inherit" }); } catch { /* diagnostics are informational */ }
  }
}

function nativeDependencyProbe(compiler, run, env, scratch) {
  probeDiagnostics(run, env);
  const missing = { headers: [], libraries: [] };
  for (const [name, header] of nativeHeaders) {
    try {
      run(compiler.path, [...env.RUBY_CFLAGS.split(" "), "-c", "-x", "c", "-", "-o", join(scratch, `probe-${name}.o`)],
        { env, input: `#include <${header}>\nint main(void){return 0;}\n` });
    } catch { missing.headers.push(`${name}(${header})`); }
  }
  for (const name of nativeLibraries) {
    try {
      run(compiler.path, [...env.RUBY_CFLAGS.split(" "), "-x", "c", "-", "-o", join(scratch, `probe-${name}`), `-l${name}`],
        { env, input: "int main(void){return 0;}\n" });
    } catch { missing.libraries.push(`-${name}`); }
  }
  return missing;
}

function owned(path) {
  const metadata = lstatSync(path);
  assert(!metadata.isSymbolicLink() && metadata.uid === (process.getuid?.() ?? 0), `Foreign or redirected Ruby path: ${path}`);
  assert.equal(realpathSync(path), resolve(path), "Ruby path must be canonical");
  return metadata;
}

function inside(root, path) {
  const part = relative(root, path);
  assert(part && !part.startsWith("..") && !isAbsolute(part), "Ruby path escaped its owned root");
}

const externalPathKeys = ["CPATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "LD_LIBRARY_PATH"];
function normalizedExternalPaths(inputs, env) {
  const roots = [["workspace", env.GITHUB_WORKSPACE], ["runner-temp", env.RUNNER_TEMP]]
    .filter(([, path]) => path).map(([name, path]) => [name, resolve(path)]);
  const normalize = value => value.split(delimiter).map(entry => {
    if (!entry || !isAbsolute(entry)) return entry.replaceAll("\\", "/");
    const path = resolve(entry);
    for (const [name, root] of roots) {
      const child = relative(root, path);
      if (child === "") return `<${name}>`;
      if (!child.startsWith("..") && !isAbsolute(child)) return `<${name}>/${child.replaceAll("\\", "/")}`;
    }
    return entry.replaceAll("\\", "/");
  }).join(delimiter);
  return Object.fromEntries(externalPathKeys.map(key => [key, normalize(inputs.externalPaths[key] ?? "")]));
}

export function rubyPins(env) {
  assert.match(env.RUBY_VERSION ?? "", /^3\.4\.\d+$/u);
  assert.match(env.RUBY_PATCHLEVEL ?? "", /^\d+$/u);
  assert.match(env.MINITEST_VERSION ?? "", /^\d+\.\d+\.\d+$/u);
  for (const key of ["RUBY_SOURCE_SHA256", "MINITEST_SHA256"]) assert.match(env[key] ?? "", /^[a-f0-9]{64}$/u, `Missing tool pin: ${key}`);
  const flags = JSON.parse(env.RUBY_CONFIGURE_FLAGS ?? "null");
  assert(Array.isArray(flags) && flags.length && flags.every(flag => ["--disable-install-doc", "--disable-shared", "--disable-yjit", "--without-baseruby"].includes(flag)), "Invalid Ruby configure flags");
  assert(flags.includes("--disable-shared") && flags.includes("--disable-yjit") && flags.includes("--without-baseruby"), "Ruby build must not borrow a host Ruby or JIT toolchain");
  assert.match(env.RUBY_CFLAGS ?? "", /^-[A-Za-z0-9]+(?: -[A-Za-z0-9]+)*$/u);
  return { version: env.RUBY_VERSION, patchlevel: Number(env.RUBY_PATCHLEVEL),
    source: { url: `https://cache.ruby-lang.org/pub/ruby/3.4/ruby-${env.RUBY_VERSION}.tar.xz`, sha256: env.RUBY_SOURCE_SHA256 },
    minitest: { version: env.MINITEST_VERSION, url: `https://rubygems.org/gems/minitest-${env.MINITEST_VERSION}.gem`, sha256: env.MINITEST_SHA256 },
    flags, cflags: env.RUBY_CFLAGS, libyaml: libyamlPin(env), libffi: libffiPin(env) };
}

function libraries(binary, run, env) {
  const output = run("ldd", [binary], { env });
  assert(!output.includes("not found"), "Ruby native library is missing");
  const paths = [...output.matchAll(/(?:^|\n)\s*(?:(\S+)\s*=>\s+)?((?:[A-Za-z]:)?\/[^\s]+)\s+\(/gmu)]
    .map(match => ({ soname: match[1] ?? basename(match[2]), path: realpathSync(match[2]) }));
  assert(paths.length || (binary.endsWith(".so") && output.trim() === "statically linked"), "Ruby native library identity is unavailable");
  return [...new Map(paths.map(value => [value.path, value])).values()].sort((left, right) => left.path.localeCompare(right.path))
    .map(value => ({ ...value, sha256: digest(readFileSync(value.path)) }));
}

function verifyToolcacheRuby(prefix, plan, env, run) {
  try {
    assert(isAbsolute(prefix)); assert.equal(realpathSync(prefix), resolve(prefix)); owned(prefix);
    const manifestPath = join(prefix, "example-runtime.json"), sidecarPath = `${manifestPath}.sha256`;
    owned(manifestPath); owned(sidecarPath);
    const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    assert.equal(readFileSync(sidecarPath, "utf8").trim().split(/\s+/u)[0], digest(manifestBytes));
    assert.equal(manifest.version, plan.inputs.pins.version); assert.equal(Number(manifest.patchlevel), plan.inputs.pins.patchlevel);
    assert.equal(manifest.sourceSha, plan.inputs.pins.source.sha256); assert.deepEqual(manifest.configureFlags, plan.inputs.pins.flags);
    assert.equal(manifest.cflags, plan.inputs.pins.cflags);
    assert.match(run(join(prefix, "bin", "ruby"), ["--version"], { env }), new RegExp(`ruby ${plan.inputs.pins.version}p${plan.inputs.pins.patchlevel}(?:\\s|$)`));
    for (const extension of ["psych", "openssl", "zlib", "fiddle"]) assert(manifest.extensions.includes(extension), `Ruby toolcache extension missing: ${extension}`);
    for (const library of ["libyaml", "openssl", "zlib", "libffi", "gmp", "crypt"]) {
      const row = manifest.libraries[library]; assert(row?.path && /^[a-f0-9]{64}$/u.test(row.sha256));
      const libraryPath = isAbsolute(row.path) ? row.path : join(prefix, row.path);
      owned(libraryPath); assert.equal(digest(readFileSync(libraryPath)), row.sha256, `Ruby toolcache library changed: ${library}`);
    }
    assert.equal(manifest.minitest.version, plan.inputs.pins.minitest.version); assert.match(manifest.minitest.path, /\.gem$/u);
    const minitestPath = isAbsolute(manifest.minitest.path) ? manifest.minitest.path : join(prefix, manifest.minitest.path);
    owned(minitestPath); assert.equal(digest(readFileSync(minitestPath)), plan.inputs.pins.minitest.sha256, "Ruby toolcache minitest changed");
    const inspection = inspectRuby({ ...plan, directory: prefix, inputs: { ...plan.inputs, minitestGemPath: minitestPath } }, env, run);
    return { prefix, manifest, minitestPath, identity: { manifestSHA256: digest(manifestBytes), treeSHA256: digest(JSON.stringify(inspection.currentTree)) } };
  } catch (error) {
    console.error(`Ruby toolcache rejected: ${error.message}`);
    return null;
  }
}

export function rubyPlan(env, run = execute, cpuUpperBound) {
  const pins = rubyPins(env), root = resolve(env.RUNNER_TEMP);
  const runtime = env.WASALX_CI_RUNTIME ?? "native";
  assert(["managed", "native"].includes(runtime), "Ruby build requires an admitted repository runtime");
  assert(Number.isFinite(cpuUpperBound) && cpuUpperBound >= 1, "Ruby build requires an admitted CPU upper bound");
  const parallelism = Math.min(availableParallelism(), Math.floor(cpuUpperBound));
  const buildJobs = env.RUBY_BUILD_JOBS ? Number(env.RUBY_BUILD_JOBS) : parallelism;
  assert((!env.RUBY_BUILD_JOBS || /^[1-9][0-9]*$/u.test(env.RUBY_BUILD_JOBS))
    && Number.isSafeInteger(buildJobs) && buildJobs > 0 && buildJobs <= parallelism, "Ruby build jobs must fit admitted CPU quota and available parallelism");
  assert(owned(root).isDirectory());
  assert(!/[\r\n]/u.test(root));
  for (const key of ["CONFIG_SITE", "RUBYOPT", "RUBYLIB"]) assert(!env[key], `Unbound Ruby build environment: ${key}`);
  assert(env.WASALX_RUBY_PREFIX, "WASALX_RUBY_PREFIX is required");
  const directory = resolve(env.WASALX_RUBY_PREFIX);
  assert(isAbsolute(directory) && !directory.split("/").includes(".."), "Ruby install prefix must be a fixed absolute path");
  inside(root, directory);
  const context = { sha: env.GITHUB_SHA, tree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: env.GITHUB_WORKSPACE, env }),
    workflow: env.GITHUB_WORKFLOW_REF, event: env.GITHUB_EVENT_NAME, scope: env.WASALX_CI_SCOPE, runtime,
    workflowSha: env.GITHUB_WORKFLOW_SHA ?? null, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB };
  for (const value of [context.sha, context.tree]) assert.match(value ?? "", /^[a-f0-9]{40}$/u);
  for (const value of [context.runId, context.attempt]) assert.match(value ?? "", /^[1-9][0-9]*$/u);
  assertRubyPreparationJob(context.job);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: env.GITHUB_WORKSPACE, env }), context.sha);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: env.GITHUB_WORKSPACE, env }), "", "Ruby tool requires a clean candidate");
  const tool = name => {
    const path = realpathSync(run("bash", ["-c", 'command -v -- "$1"', "ruby-tool", name], { env }));
    return { path, sha256: digest(readFileSync(path)), version: run(path, ["--version"], { env }) };
  };
  const compiler = tool(env.CC || "cc"), make = tool("make");
  const scratch = mkdtempSync(join(root, "wasalx-ruby-probe-"));
  let inputs, toolcache;
  try {
    const source = join(scratch, "native.c"), binary = join(scratch, "native"), headers = join(scratch, "native.i");
    writeFileSync(source, nativeProbe);
    const missing = nativeDependencyProbe(compiler, run, env, scratch);
    console.log(JSON.stringify({ rubyProbe: { compiler, make, missing } }));
    const missingYaml = missing.headers.some(value => value.startsWith("yaml(")) || missing.libraries.includes("-yaml");
    const missingFfi = missing.headers.some(value => value.startsWith("ffi(")) || missing.libraries.includes("-ffi");
    const missingOnlySupportedFallbacks = missing.headers.every(value => value.startsWith("yaml(") || value.startsWith("ffi("))
      && missing.libraries.every(value => value === "-yaml" || value === "-ffi")
      && (missing.headers.length > 0 || missing.libraries.length > 0);
    if ((missing.headers.length || missing.libraries.length) && !missingOnlySupportedFallbacks) {
      throw new Error(`Ruby native prerequisites missing: headers=${missing.headers.join(",") || "none"}; libraries=${missing.libraries.join(",") || "none"}; compiler=${compiler.path} (${compiler.version}); make=${make.path} (${make.version})`);
    }
    inputs = { pins, compiler, make, probe: missing,
      externalPaths: Object.fromEntries(["CPATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "LD_LIBRARY_PATH"].map(key => [key, env[key] ?? ""])),
      libyaml: { ...pins.libyaml, required: missingYaml }, libffi: { ...pins.libffi, required: missingFfi }, libraries: [], headersSHA256: null,
      target: run(compiler.path, ["-dumpmachine"], { env }), directory, implementation, workflow: context.workflow, buildJobs,
      fetchHelperSHA256: digest(readFileSync(fileURLToPath(new URL("./fetch-verified-asset.sh", import.meta.url)))) };
    if (!missing.headers.length && !missing.libraries.length) {
      run(compiler.path, [...pins.cflags.split(" "), source, "-o", binary, "-lssl", "-lcrypto", "-lyaml", "-lgmp", "-lz", "-lcrypt", "-lm", "-lffi"], { env });
      run(binary, [], { env });
      run(compiler.path, ["-E", "-P", "-x", "c", "-", "-o", headers], { env, input: nativeProbe });
      inputs.libraries = libraries(binary, run, env); inputs.headersSHA256 = digest(readFileSync(headers));
    }
    if (env.RUBY_TOOLCACHE_DIR) {
      toolcache = verifyToolcacheRuby(env.RUBY_TOOLCACHE_DIR, { directory: env.RUBY_TOOLCACHE_DIR, inputs }, env, run);
      if (toolcache) { inputs.toolcacheIdentity = toolcache.identity; inputs.libyaml.required = false; inputs.libffi.required = false; }
    }
    assert.match(inputs.target, /^x86_64-.*linux/u, "Ruby source build requires Linux amd64");
  } finally {
    owned(scratch); inside(root, scratch); rmSync(scratch, { recursive: true });
  }
  const cacheInputs = { installPrefix: `<runner-temp>/${relative(root, directory).replaceAll("\\", "/")}`, pins, compiler: { version: inputs.compiler.version, sha256: inputs.compiler.sha256 },
    make: { version: inputs.make.version, sha256: inputs.make.sha256 }, probe: inputs.probe, libyaml: inputs.libyaml,
    externalPaths: normalizedExternalPaths(inputs, env),
    libffi: inputs.libffi, libraries: inputs.libraries.map(({ soname, sha256 }) => ({ soname, sha256 }))
      .sort((left, right) => `${left.soname}\0${left.sha256}`.localeCompare(`${right.soname}\0${right.sha256}`)),
    headersSHA256: inputs.headersSHA256, target: inputs.target, implementation: inputs.implementation,
    workflow: inputs.workflow, buildJobs: inputs.buildJobs, fetchHelperSHA256: inputs.fetchHelperSHA256,
    toolcacheIdentity: inputs.toolcacheIdentity ?? null };
  const key = `wasalx-ruby-${digest(JSON.stringify(cacheInputs))}`;
  const claim = join(root, `wasalx-ruby-${pins.version}.owner.json`);
  const ownership = { key, directory, context };
  if (existsSync(claim)) { owned(claim); assert.deepEqual(json(claim), ownership, "Ruby prefix has another owner"); }
  else {
    assert(!existsSync(directory), "Unclaimed Ruby prefix already exists");
    writeFileSync(claim, JSON.stringify(ownership), { flag: "wx", mode: 0o600 });
  }
  return { key, directory, claim, context, inputs, cacheInputs, toolcache };
}

function tree(directory, child = "") {
  const path = join(directory, child), metadata = lstatSync(path);
  assert.equal(metadata.uid, process.getuid?.() ?? 0, "Ruby tree has foreign ownership");
  if (metadata.isSymbolicLink()) {
    inside(directory, realpathSync(path));
    return [{ path: child, mode: canonicalMode(metadata.mode), link: readlinkSync(path) }];
  }
  assert(metadata.isFile() || metadata.isDirectory(), "Ruby tree contains an unsupported object");
  assert.equal(metadata.mode & 0o7000, 0, "Ruby tree contains special permission bits");
  const row = { path: child, mode: canonicalMode(metadata.mode) };
  if (metadata.isFile()) return [{ ...row, bytes: metadata.size, sha256: digest(readFileSync(path)) }];
  return [row, ...readdirSync(path).sort().filter(name => child || name !== "build.json").flatMap(name => tree(directory, join(child, name)))];
}

// Cache archives may restore under a different umask; retain owner bits and executable intent.
function canonicalMode(mode) {
  return (mode & 0o700) | (mode & 0o111 ? 0o111 : 0);
}

export function validateRubyReadback(value, plan) {
  const { directory, inputs: { pins } } = plan;
  assert.equal(value.version, pins.version); assert.equal(value.patchlevel, pins.patchlevel);
  assert.equal(value.engine, "ruby"); assert.match(value.platform, /^x86_64-linux/u);
  assert.match(value.rubygems, /^\d+\.\d+\.\d+$/u);
  assert.equal(value.prefix, directory); assert.equal(value.executable, join(directory, "bin", "ruby"));
  assert.equal(value.configuration.CC, plan.inputs.compiler.path, "Ruby configured compiler differs");
  assert(value.configuration.configure_args.includes(`--prefix=${directory}`), "Ruby configured prefix differs");
  for (const flag of pins.flags) assert(value.configuration.configure_args.includes(flag), "Ruby configured flags differ");
  assert.equal(value.minitest.version, pins.minitest.version);
  const bundled = join(directory, "lib", "ruby", "gems", pins.version.replace(/\.\d+$/u, ".0"));
  assert.equal(value.bundledGemPath, bundled, "Ruby bundled gem directory differs");
  assert.deepEqual([...value.gemPaths].sort(), [join(directory, "gems"), bundled].sort(), "Ruby gem paths differ from the owned tool");
  for (const path of [value.rbconfig, value.minitest.path, ...value.gemPaths, ...value.nativeExtensions]) {
    inside(directory, path); assert.equal(realpathSync(path), path, "Ruby load path is redirected"); owned(path);
  }
  assert(value.nativeExtensions.length, "Ruby native extensions were not observed");
  return value;
}

const readback = `require 'json'; require 'rbconfig'; require 'openssl'; require 'psych'; require 'zlib'; require 'fiddle'; require 'minitest';
print JSON.generate({version: RUBY_VERSION, patchlevel: RUBY_PATCHLEVEL, engine: RUBY_ENGINE, platform: RUBY_PLATFORM, rubygems: Gem::VERSION,
  executable: File.realpath(RbConfig.ruby), prefix: RbConfig::CONFIG.fetch('prefix'),
  configuration: RbConfig::CONFIG.slice('configure_args', 'CC', 'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'arch', 'host', 'target', 'ruby_version'),
  rbconfig: File.realpath($LOADED_FEATURES.find { |p| p.end_with?('/rbconfig.rb') }),
  gemPaths: Gem.path.map { |p| File.realpath(p) },
  bundledGemPath: File.realpath(Gem.default_dir),
  minitest: {version: Gem.loaded_specs.fetch('minitest').version.to_s, path: File.realpath(Gem.loaded_specs.fetch('minitest').full_gem_path)},
  nativeExtensions: $LOADED_FEATURES.grep(/\\.so$/).select { |p| File.absolute_path?(p) }.map { |p| File.realpath(p) }.sort})`;
// Builtin features such as enumerator.so are listed in $LOADED_FEATURES without a path; only absolute entries are files.

function inspectRuby(plan, env, run) {
  const { directory, inputs: { pins } } = plan, executable = join(directory, "bin", "ruby");
  const minitestGem = plan.inputs.minitestGemPath ?? join(directory, "inputs", "minitest.gem");
  assert.equal(digest(readFileSync(minitestGem)), pins.minitest.sha256);
  owned(executable);
  const currentTree = tree(directory);
  const nativeLibraries = [...new Map([executable, ...currentTree.filter(entry => entry.path.endsWith(".so")).map(entry => join(directory, entry.path))]
    .flatMap(path => libraries(path, run, env)).map(value => [value.path, value])).values()];
  const ruby = validateRubyReadback(JSON.parse(run(executable, ["-e", readback], { env })), plan);
  assert.deepEqual(tree(directory), currentTree, "Ruby tool mutated during its readback");
  return { currentTree, nativeLibraries, ruby };
}

export function prepareRuby(plan, env, run = execute) {
  const { directory, claim, key, context, inputs, cacheInputs, toolcache } = plan, started = Date.now();
  owned(claim); assert.deepEqual(json(claim), { key, directory, context });
  const pins = inputs.pins, executable = join(directory, "bin", "ruby"), gemHome = join(directory, "gems");
  const gemPath = [gemHome, join(directory, "lib", "ruby", "gems", pins.version.replace(/\.\d+$/u, ".0"))].join(delimiter);
  const jobs = `-j${inputs.buildJobs}`;
  const libyamlPrefix = join(directory, "libyaml"), libffiPrefix = join(directory, "libffi");
  const prepend = (value, existing) => [value, existing].filter(Boolean).join(":"),
    buildEnv = { ...env, CC: inputs.compiler.path, MAKE: inputs.make.path, MAKEFLAGS: jobs, MFLAGS: "",
      CFLAGS: pins.cflags, CPPFLAGS: env.CPPFLAGS ?? "", LDFLAGS: env.LDFLAGS ?? "", RUBYOPT: "", RUBYLIB: "", GEM_HOME: gemHome, GEM_PATH: gemPath };
  for (const [required, prefix] of [[inputs.libyaml.required, libyamlPrefix], [inputs.libffi.required, libffiPrefix]]) if (required) {
    buildEnv.CPATH = prepend(join(prefix, "include"), buildEnv.CPATH);
    buildEnv.LIBRARY_PATH = prepend(join(prefix, "lib"), buildEnv.LIBRARY_PATH);
    buildEnv.PKG_CONFIG_PATH = prepend(join(prefix, "lib", "pkgconfig"), buildEnv.PKG_CONFIG_PATH);
    buildEnv.LD_LIBRARY_PATH = prepend(join(prefix, "lib"), buildEnv.LD_LIBRARY_PATH);
    buildEnv.CPPFLAGS = `-I${join(prefix, "include")} ${buildEnv.CPPFLAGS}`.trim();
    buildEnv.LDFLAGS = `-L${join(prefix, "lib")} ${buildEnv.LDFLAGS}`.trim();
  }
  let scratch, build, inspection, cacheFailure = null, reused = false, completed = false, cleanupAllowed = false;
  try {
    if (toolcache && !existsSync(directory)) {
      cpSync(toolcache.prefix, directory, { recursive: true, errorOnExist: true });
      const toolGem = toolcache.minitestPath, localGem = join(directory, "inputs", "minitest.gem");
      mkdirSync(dirname(localGem), { recursive: true }); cpSync(toolGem, localGem);
      mkdirSync(gemHome, { recursive: true });
      run(join(directory, "bin", "ruby"), [join(directory, "bin", "gem"), "install", "--norc", "--local", "--no-document", "--install-dir", gemHome, localGem], { env: buildEnv, stdio: "inherit" });
      const inspection = inspectRuby(plan, buildEnv, run);
      build = { schemaVersion: 1, kind: "wasalx-ruby-build", key, inputs, cacheInputs, builtBy: context, buildMilliseconds: 0,
        tree: inspection.currentTree, nativeLibraries: inspection.nativeLibraries };
      writeFileSync(join(directory, "build.json"), JSON.stringify(build), { flag: "w", mode: 0o600 });
    }
    if (existsSync(directory)) {
      owned(directory);
      if (existsSync(join(directory, "build.json"))) owned(join(directory, "build.json"));
      const restoredTree = tree(directory); // Establish ownership before any cache discard.
      cleanupAllowed = true;
      try {
        build = json(join(directory, "build.json"));
        assert.equal(build.schemaVersion, 1); assert.equal(build.kind, "wasalx-ruby-build");
        assert.equal(build.builtBy.workflow, context.workflow, "Ruby cached workflow differs"); assert.equal(build.builtBy.job, "repository");
        assert.equal(build.builtBy.runtime, context.runtime); assert.equal(build.builtBy.event, "workflow_dispatch");
        assert(Number.isSafeInteger(build.buildMilliseconds) && build.buildMilliseconds >= 0);
        assert.equal(build.key, key, "Ruby cached build inputs changed");
        assert.deepEqual(build.cacheInputs, cacheInputs); assert.deepEqual(build.tree, restoredTree, "Ruby cached tree changed");
        assert(Array.isArray(build.nativeLibraries) && build.nativeLibraries.length, "Ruby cached native closure is absent");
        for (const library of build.nativeLibraries) assert.equal(digest(readFileSync(library.path)), library.sha256, "Ruby cached native library changed");
        inspection = inspectRuby(plan, buildEnv, run);
        assert.deepEqual(inspection.nativeLibraries, build.nativeLibraries, "Ruby cached loader closure changed");
        reused = true;
      } catch (error) {
        cacheFailure = { schemaVersion: 1, kind: "ruby-cache-rejection", status: "rejected", context, cacheKey: key, reason: error.message };
        const output = resolve(env.GITHUB_WORKSPACE, "output", "release-evidence");
        owned(output);
        writeFileSync(join(output, "ruby-cache-rejection.json"), JSON.stringify(cacheFailure, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        owned(claim); assert.deepEqual(json(claim), { key, directory, context }, "Ruby cache discard lost ownership");
        owned(directory); inside(resolve(env.RUNNER_TEMP), directory); rmSync(directory, { recursive: true });
      }
    }
    if (!reused) {
      mkdirSync(directory, { mode: 0o700 });
      cleanupAllowed = true;
      mkdirSync(join(directory, "inputs"));
      scratch = mkdtempSync(join(env.RUNNER_TEMP, "wasalx-ruby-build-"));
      const archive = join(scratch, "ruby.tar.xz"), gem = join(directory, "inputs", "minitest.gem");
      const helper = fileURLToPath(new URL("./fetch-verified-asset.sh", import.meta.url));
      for (const [name, sourceName, input, prefix] of [["libyaml", "yaml", inputs.libyaml, libyamlPrefix], ["libffi", "libffi", inputs.libffi, libffiPrefix]]) if (input.required) {
        const archive = join(scratch, `${sourceName}-${input.version}.tar.gz`), sourceDirectory = `${sourceName}-${input.version}`;
        run("bash", [helper, input.url, archive, input.sha256], { env, stdio: "inherit" });
        assert.equal(digest(readFileSync(archive)), input.sha256, `${name} input failed pinned checksum verification`);
        run("python3", ["-c", "import sys,tarfile\nwith tarfile.open(sys.argv[1]) as t:\n assert all((m.name==sys.argv[3] or m.name.startswith(sys.argv[3]+'/')) and '..' not in m.name.split('/') for m in t.getmembers())\n t.extractall(sys.argv[2],filter='data')", archive, scratch, sourceDirectory], { env });
        const nativeCwd = join(scratch, sourceDirectory);
        run(join(nativeCwd, "configure"), [`--prefix=${prefix}`], { cwd: nativeCwd, env: buildEnv, stdio: "inherit" });
        run(inputs.make.path, [jobs], { cwd: nativeCwd, env: buildEnv, stdio: "inherit" });
        run(inputs.make.path, [jobs, "install"], { cwd: nativeCwd, env: buildEnv, stdio: "inherit" });
      }
      for (const [pin, path] of [[pins.source, archive], [pins.minitest, gem]]) {
        run("bash", [helper, pin.url, path, pin.sha256], { env, stdio: "inherit" });
        assert.equal(digest(readFileSync(path)), pin.sha256, "Ruby input failed pinned checksum verification");
      }
      run("python3", ["-c", "import sys,tarfile\nwith tarfile.open(sys.argv[1]) as t:\n assert all((m.name==sys.argv[3] or m.name.startswith(sys.argv[3]+'/')) and '..' not in m.name.split('/') for m in t.getmembers())\n t.extractall(sys.argv[2],filter='data')", archive, scratch, `ruby-${pins.version}`], { env });
      const cwd = join(scratch, `ruby-${pins.version}`);
      const buildStarted = Date.now();
      run(join(cwd, "configure"), [`--prefix=${directory}`, ...(inputs.libyaml.required ? [`--with-libyaml-dir=${libyamlPrefix}`] : []), ...(inputs.libffi.required ? [`--with-libffi-dir=${libffiPrefix}`] : []), ...pins.flags], { cwd, env: buildEnv, stdio: "inherit" });
      run(inputs.make.path, [jobs], { cwd, env: buildEnv, stdio: "inherit" });
      run(inputs.make.path, [jobs, "install"], { cwd, env: buildEnv, stdio: "inherit" });
      mkdirSync(gemHome, { recursive: true });
      run(executable, [join(directory, "bin", "gem"), "install", "--norc", "--local", "--no-document", "--install-dir", gemHome, gem], { env: buildEnv, stdio: "inherit" });
      build = { schemaVersion: 1, kind: "wasalx-ruby-build", key, inputs, cacheInputs, builtBy: context, buildMilliseconds: Date.now() - buildStarted };
      inspection = inspectRuby(plan, buildEnv, run);
    }
    const { currentTree, nativeLibraries, ruby } = inspection;
    if (!reused) { build.tree = currentTree; build.nativeLibraries = nativeLibraries; writeFileSync(join(directory, "build.json"), JSON.stringify(build), { flag: "wx", mode: 0o600 }); }
    const receipt = { schemaVersion: 1, kind: "ruby-tool", status: "ready", context, cacheKey: key, cacheReused: reused, cacheFailure,
      build: { inputs, builtBy: build.builtBy, buildMilliseconds: build.buildMilliseconds, treeSHA256: digest(JSON.stringify(currentTree)) },
      ruby, executableSHA256: digest(readFileSync(executable)), rbconfigSHA256: digest(readFileSync(ruby.rbconfig)), nativeLibraries,
      observations: { elapsedMilliseconds: Date.now() - started, installedBytes: currentTree.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), peakRssBytes: null, peakDiskBytes: null },
      qualification: "TOOL_AVAILABILITY_ONLY; not repository/application qualification" };
    completed = true;
    return { receipt, environment: { WASALX_RUBY_BIN: executable, GEM_HOME: gemHome, GEM_PATH: gemPath }, path: dirname(executable) };
  } finally {
    if (scratch) { owned(scratch); inside(resolve(env.RUNNER_TEMP), scratch); rmSync(scratch, { recursive: true }); }
    if (!completed) {
      owned(claim); assert.deepEqual(json(claim), { key, directory, context }, "Ruby cleanup lost ownership");
      if (cleanupAllowed && existsSync(directory)) { owned(directory); inside(resolve(env.RUNNER_TEMP), directory); rmSync(directory, { recursive: true }); }
      if (!existsSync(directory)) rmSync(claim);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(["plan", "install"].includes(process.argv[2]) && process.argv.length === 3, "Expected Ruby plan or install");
    assert(["managed", "native"].includes(ciRuntime()), "Ruby preparation requires an admitted repository runtime"); assertRubyPreparationJob(process.env.GITHUB_JOB);
    assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
    const admission = admitManagedPayload();
    const plan = rubyPlan(process.env, execute, admission?.resources?.cpuUpperBound ?? availableParallelism());
    if (process.argv[2] === "plan") appendFileSync(process.env.GITHUB_OUTPUT, `key=${plan.key}\ndirectory=${plan.directory}\n`);
    else {
      const result = prepareRuby(plan, process.env);
      const output = resolve(process.env.GITHUB_WORKSPACE, "output", "release-evidence");
      mkdirSync(output, { recursive: true });
      // Earlier repository gates own this existing, governed artifact directory.
      owned(output);
      writeFileSync(join(output, "ruby-tool.json"), JSON.stringify(result.receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      appendFileSync(process.env.GITHUB_PATH, result.path + "\n");
      for (const [key, value] of Object.entries(result.environment)) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
      console.log(JSON.stringify(result.receipt));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
