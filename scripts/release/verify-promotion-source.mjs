import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from 'node:path';
import { verifyReleaseWorkflowEvidence } from './verify-release-workflow-evidence.mjs';

// Source equivalence only. The deployment workflow must first verify signatures
// and protected-main qualification, then sign this receipt before consuming it.
export function verifyPromotionSource(manifest, repository, promotionRevision, cwd) {
  const release = manifest?.release;
  if (release?.profile !== "production") throw new Error("Production promotion requires a production artifact profile");
  const sha = /^[0-9a-f]{40}$/;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || release?.sourceRepository !== repository
      || !sha.test(release?.sourceRevision ?? "") || !sha.test(release?.sourceTree ?? "")
      || !sha.test(promotionRevision ?? "")) throw new Error("Missing or mismatched promotion identity");
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const buildTree = git(["rev-parse", "--verify", `${release.sourceRevision}^{tree}`]);
  const promotionTree = git(["rev-parse", "--verify", `${promotionRevision}^{tree}`]);
  if (buildTree !== release.sourceTree || promotionTree !== buildTree) {
    throw new Error("Promotion source trees differ; qualify a new build");
  }
  git(["merge-base", "--is-ancestor", release.sourceRevision, promotionRevision]);
  return { schemaVersion: 1, profile: "production", sourceRepository: repository,
    buildRevision: release.sourceRevision, sourceTree: buildTree, promotionRevision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [manifestPath, repository, promotionRevision, output, ...extra] = process.argv.slice(2);
    if (!manifestPath || !output || extra.length) throw new Error("Invalid arguments");
    const bytes = readFileSync(manifestPath);
    const receipt = verifyPromotionSource(JSON.parse(bytes), repository, promotionRevision, process.cwd());
    execFileSync(process.execPath, [fileURLToPath(new URL("./artifact-contract.mjs", import.meta.url)),
      "verify", "--manifest", manifestPath], { stdio: ["ignore", "pipe", "pipe"] });
    verifyReleaseWorkflowEvidence(dirname(manifestPath), JSON.parse(bytes).release);
    if (!bytes.equals(readFileSync(manifestPath))) throw new Error("Manifest changed during verification");
    receipt.manifestDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write("Promotion source equivalence verified; receipt requires signing.\n");
  } catch {
    process.stderr.write("Promotion rejected: verify manifest evidence, repository, ancestry, trees and unused receipt path.\n");
    process.exitCode = 1;
  }
}
