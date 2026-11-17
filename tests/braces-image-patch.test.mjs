import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bracesPatchHash, bracesRuntimeHashes, verifyBracesRuntime } from "../scripts/verify-braces-patch.mjs";

const exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});
const wrapper = new URL("../scripts/release/verify-braces-image-patch.mjs", import.meta.url);
const contract = new URL("../scripts/release/artifact-contract.mjs", import.meta.url);
const imageReference = `ghcr.io/wasalx/wasalx/control-api@sha256:${"a".repeat(64)}`;
const platform = "linux/amd64";
const packageRoot = "/app/node_modules/.pnpm/braces@3.0.3/node_modules/braces";
let require = createRequire(import.meta.resolve("@next/eslint-plugin-next"));
for (const name of ["fast-glob", "micromatch"]) require = createRequire(require.resolve(name));
const installed = dirname(require.resolve("braces"));
const run = (file, ...args) => exec(process.execPath, [fileURLToPath(file), ...args], { timeout: 15000 });

test("image discovery verifies every copy and deduplicates real package roots", async context => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-braces-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, ".pnpm/braces@3.0.3/node_modules");
  await mkdir(parent, { recursive: true });
  await symlink(installed, join(parent, "braces"), "junction");
  await symlink(installed, join(directory, "braces"), "junction");
  const proof = JSON.parse((await run(wrapper, imageReference, platform, directory)).stdout);
  assert.equal(proof.copies.length, 1);
  assert.equal(proof.copies[0].packageJsonPaths.length, 2);
  assert.deepEqual(proof.copies[0].files, bracesRuntimeHashes);
  const bad = join(directory, ".pnpm/braces@unexpected/node_modules/braces");
  await cp(installed, bad, { recursive: true });
  await writeFile(join(bad, "lib/parse.js"), "unpatched");
  await assert.rejects(verifyBracesRuntime(bad), /Unverified braces runtime/u);
  await assert.rejects(run(wrapper, imageReference, platform, directory), /Unverified braces runtime/u);
});

test("image vulnerability admission rejects unbound, tampered and incomplete braces mitigation", async context => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-braces-vex-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scanPath = join(directory, "control-api.amd64.vulnerabilities.json");
  const proofPath = join(directory, "control-api.amd64.braces-patch.json");
  const originalProof = {
    schemaVersion: 1, status: "verified", imageReference, platform, patchHash: bracesPatchHash,
    copies: [{ root: packageRoot, name: "braces", version: "3.0.3", files: bracesRuntimeHashes,
      behavior: "verified", packageJsonPaths: [`${packageRoot}/package.json`] }],
  };
  const originalScan = {
    source: { target: { userInput: imageReference } }, matches: [],
    ignoredMatches: [{
      vulnerability: { id: "GHSA-vfj7-8cjw-p6xm", severity: "High" },
      relatedVulnerabilities: [{ id: "CVE-2026-93687" }],
      artifact: { name: "braces", version: "3.0.3", locations: [{ path: `${packageRoot}/package.json` }] },
      appliedIgnoreRules: [{ namespace: "vex", "vex-status": "not_affected", "vex-justification": "inline_mitigations_already_exist" }],
    }],
  };
  const cases = {
    verified: () => {},
    "wrong-digest": (proof) => { proof.imageReference = imageReference.replace(/a$/u, "b"); },
    "wrong-platform": (proof) => { proof.platform = "linux/arm64"; },
    "wrong-patch": (proof) => { proof.patchHash = "b".repeat(64); },
    "wrong-file": (proof) => { proof.copies[0].files["lib/parse.js"] = "b".repeat(64); },
    "missing-copy": (proof) => { proof.copies = []; },
    "wrong-version": (_, scan) => { scan.ignoredMatches[0].artifact.version = "3.0.2"; },
    "other-advisory": (_, scan) => { scan.ignoredMatches[0].vulnerability.id = "GHSA-other"; },
    "missing-alias": (_, scan) => { scan.ignoredMatches[0].relatedVulnerabilities = []; },
    "extra-copy": (_, scan) => { scan.ignoredMatches[0].artifact.locations.push({ path: "/app/node_modules/other/node_modules/braces/package.json" }); },
    "missing-location": (_, scan) => { scan.ignoredMatches[0].artifact.locations = []; },
    "other-image": (_, scan) => { scan.source.target.userInput = imageReference.replace("control-api", "portal"); },
    "unrelated-high": (_, scan) => { scan.matches.push({ vulnerability: { id: "CVE-other", severity: "High" } }); },
    "missing-proof": () => {},
  };
  for (const [name, change] of Object.entries(cases)) {
    const proof = structuredClone(originalProof), scan = structuredClone(originalScan);
    change(proof, scan);
    await writeFile(scanPath, JSON.stringify(scan));
    await writeFile(proofPath, JSON.stringify(proof));
    const args = ["validate-vulnerability-scan", "--id", "control-api", "--file", scanPath,
      "--image-reference", imageReference, "--platform", platform];
    if (name !== "missing-proof") args.push("--braces-patch", proofPath);
    if (name === "verified") assert.equal(JSON.parse((await run(contract, ...args)).stdout).status, "verified");
    else await assert.rejects(run(contract, ...args), undefined, name);
  }
  const vex = JSON.parse(await readFile(new URL("../security/vex/braces-3.0.3.openvex.json", import.meta.url)));
  assert.equal(vex.statements.length, 1);
  assert.deepEqual(vex.statements[0].vulnerability.aliases, ["CVE-2026-93687"]);
});
