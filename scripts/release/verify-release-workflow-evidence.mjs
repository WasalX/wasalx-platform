import {requiredOperatorInput} from "./operator-input.mjs";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentWorkflowRun, evidenceRepository, verifyWorkflowGate } from './workflow-evidence.mjs';

// The caller must first verify the signed aggregate and its artifact contract.
export function verifyReleaseWorkflowEvidence(directory, release, dependencies, currentRun) {
  assert.equal(release.sourceRepository, evidenceRepository, 'UNVERIFIED: release repository differs');
  assert.match(release.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(release.sourceTree, /^[a-f0-9]{40}$/u);
  let producer;
  const manifestMembers = [];
  for (const gate of ['sbom', 'signing', 'attestation']) {
    const bytes = readFileSync(join(directory, `${gate}.json`));
    const manifest = JSON.parse(bytes);
    manifestMembers.push({ path: `${gate}.json`, bytes });
    assert.equal(manifest.kind, 'automated');
    assert.equal(manifest.gate, gate);
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.exitCode, 0);
    assert.equal(manifest.candidateSha, release.sourceRevision);
    assert.equal(manifest.candidateTree, release.sourceTree);
    assert.equal(manifest.workflowRun?.workflowRef?.split('@')[1], release.sourceRef);
    if (producer) assert.deepEqual(manifest.workflowRun, producer.workflowRun, 'UNVERIFIED: release producer differs');
    else producer = manifest;
  }
  verifyWorkflowGate(producer, { workflow: requiredOperatorInput("WASALX_RELEASE_WORKFLOW_PATH"),
    workflowCallers: [requiredOperatorInput("WASALX_QUALITY_WORKFLOW_PATH")] }, dependencies, { manifestMembers, currentRun });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, active, ...extra] = process.argv.slice(2);
    assert.ok(directory && !extra.length && (active === undefined || active === '--current-run'));
    const manifest = JSON.parse(readFileSync(join(directory, 'wasalx-release-manifest.json'), 'utf8'));
    verifyReleaseWorkflowEvidence(directory, manifest.release, undefined, active ? currentWorkflowRun() : undefined);
    process.stdout.write('Release workflow evidence verified via GitHub API\n');
  } catch {
    process.stderr.write('UNVERIFIED: release workflow evidence was not independently verified\n');
    process.exitCode = 1;
  }
}
