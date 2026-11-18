import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Vinext's image-size reads the PNG fixture dimensions", async () => {
  const requireFromVinext = createRequire(import.meta.resolve("vinext"));
  const { imageSize } = requireFromVinext("image-size");
  const image = await readFile(new URL("./fixtures/native-group/image.png", import.meta.url));
  const { width, height, type } = imageSize(image);
  assert.deepEqual({ width, height, type }, { width: 64, height: 64, type: "png" });
});

test("release admission rejects the retired image-size VEX exception", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "wasalx-image-size-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scan = join(directory, "scan.json");
  const ignoredMatches = [
    ["GHSA-w3rx-r6r6-pgpr", "CVE-2025-71330"],
    ["GHSA-5p2g-fcmc-qvqq", "CVE-2025-71329"],
  ].map(([id, alias]) => ({
    artifact: { name: "image-size", version: "2.0.2" },
    vulnerability: { id, severity: "High" },
    relatedVulnerabilities: [{ id: alias }],
    appliedIgnoreRules: [{
      namespace: "vex",
      "vex-status": "not_affected",
      "vex-justification": "inline_mitigations_already_exist",
    }],
  }));
  await writeFile(scan, JSON.stringify({ matches: [], ignoredMatches }));
  const contract = fileURLToPath(new URL("../scripts/release/artifact-contract.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [contract, "validate-vulnerability-scan", "--id", "portal", "--file", scan], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /suppresses an unapproved package or vulnerability/u);
});
