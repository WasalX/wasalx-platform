import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

const moduleFile = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const sourcePath = /^(?:app\/|lib\/|(?:packages|services)\/[^/]+\/src\/)/u;
const sharedPath = /(?:^|\/)[^/]*(?:config|fixture)[^/]*(?:\/|$)|\.d\.[cm]?ts$/iu;
const builtins = new Set(["assert", "assert/strict", "buffer", "crypto", "events", "os", "path", "stream", "test", "url", "util"]);
const indirectLoaders = new Set(["Function", "binding", "dlopen", "eval", "getBuiltinModule", "mainModule", "require"]);

function importsFrom(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const imports = [];
  let opaque = source.parseDiagnostics.length > 0;
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) imports.push(argument.text);
      else opaque = true;
    } else if (ts.isImportEqualsDeclaration(node) || (ts.isIdentifier(node) && indirectLoaders.has(node.text))) {
      opaque = true;
    } else if ((ts.isMetaProperty(node) && node.parent?.name?.text === "resolve")
      || (ts.isPropertyAccessExpression(node) && node.name.text === "module")) {
      opaque = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, opaque };
}

function reachable(seeds, dependents) {
  const reached = new Set(seeds);
  for (const file of reached) {
    for (const importer of dependents.get(file) ?? []) reached.add(importer);
  }
  return reached;
}

export function selectUnitFiles(unitFiles, { event = process.env.GITHUB_EVENT_NAME, cwd = process.cwd() } = {}) {
  const full = reason => ({ files: unitFiles, reason });
  if (event !== "pull_request") return full("full suite for this event");
  try {
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const parents = git("rev-list", "--parents", "-1", "HEAD").trim().split(" ");
    if (parents.length !== 3) return full("PR merge base unavailable");
    const diff = git("diff", "--name-status", "--no-ext-diff", "--no-renames", "-z", parents[1], "HEAD", "--").split("\0");
    diff.pop();
    if (diff.length === 0 || diff.length % 2 !== 0) return full("empty or unreadable PR diff");

    const tests = new Set(unitFiles);
    const changed = new Set();
    for (let index = 0; index < diff.length; index += 2) {
      const [status, file] = [diff[index], diff[index + 1]];
      if (status !== "M" || sharedPath.test(file) || !(tests.has(file) || (sourcePath.test(file) && moduleFile.test(file)))) {
        return full("PR diff includes shared, non-source or structural changes");
      }
      changed.add(file);
    }

    const tracked = new Set(git("ls-files", "-z").split("\0"));
    const sources = new Set(unitFiles);
    const dependents = new Map();
    const opaque = new Set();
    for (const file of sources) {
      if (!tracked.has(file) || !lstatSync(join(cwd, file)).isFile()) return full("tracked module unavailable");
      const module = importsFrom(file, readFileSync(join(cwd, file), "utf8"));
      if (module.opaque) opaque.add(file);
      for (const specifier of module.imports) {
        if (builtins.has(specifier?.replace(/^node:/u, ""))) continue;
        const dependency = specifier?.startsWith(".") && posix.join(posix.dirname(file), specifier);
        if (!dependency || !moduleFile.test(dependency) || !tracked.has(dependency)) {
          // Generated outputs, packages, file reads and runtime resolution stay in the suite.
          opaque.add(file);
          continue;
        }
        sources.add(dependency);
        if (!dependents.has(dependency)) dependents.set(dependency, new Set());
        dependents.get(dependency).add(file);
      }
    }
    if ([...changed].some(file => !sources.has(file))) return full("changed module has no proven test reachability");
    const affected = reachable(changed, dependents);
    const uncertain = reachable(opaque, dependents);
    return { files: unitFiles.filter(file => affected.has(file) || uncertain.has(file)), reason: "affected graph and uncertain importers" };
  } catch (error) {
    return full("could not construct import graph (" + (error.code ?? error.name) + ")");
  }
}
