import assert from 'node:assert/strict';
import {closeSync, fsyncSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {applicableAutomationObligations} from './automation-coverage.mjs';
import {validate, validateContract} from './alpha-test-baseline.mjs';
import {simulationEvidenceBound} from './simulation-full-suite-mappings.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = ({testId, contextId}) => JSON.stringify([testId, contextId]);
const exact = (actual, expected, message) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);

function validateQualificationNamespaceBinding(before, deployment, admission, terminal) {
  if (deployment.manifestSha256 === undefined || deployment.manifestSha256 === admission.manifest.sha256) return;
  const binding = before.reviews.find((review) =>
    review.kind === 'qualification-namespace-binding-review' &&
    review.candidateId === admission.candidateId &&
    review.deploymentId === admission.deploymentId &&
    review.namespace === admission.namespace &&
    review.binding?.runtimeDeploymentId === admission.deploymentId &&
    review.binding?.runtimeApplicationCandidateId === admission.candidateId &&
    review.binding?.qualificationToolingCandidateId === review.toolingCandidateId &&
    review.binding?.manifestSha256 === admission.manifest.sha256 &&
    review.binding?.preflightSha256 === terminal.preflightSha256 &&
    review.binding?.dispatchSha256 === terminal.dispatchSha256 &&
    ['admitted-active', 'admitted-terminal'].includes(review.binding?.status)
  );
  assert(binding, 'Deployment manifest drift requires exact qualification namespace binding');
  const tooling = before.candidates.find((candidate) => candidate.id === binding.toolingCandidateId);
  assert.equal(tooling?.commitSha, admission.toolingSha, 'Qualification namespace tooling mismatch');
  const evidenceShas = new Set((binding.evidence ?? []).map((proof) => proof.sha256));
  assert(evidenceShas.has(admission.manifest.sha256), 'Qualification namespace manifest proof missing');
  assert(evidenceShas.has(binding.binding.admissionSha256), 'Qualification namespace admission proof missing');
  assert(evidenceShas.has(binding.binding.dispatchSha256), 'Qualification namespace dispatch proof missing');
}


const allow = (value, keys) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert(Object.keys(value).every(k => keys.includes(k)), 'Unexpected input field');
};
const evidenceKeys = ['path','sha256','originalSha','originalTree','capturedAt'];
export function validateTerminal(admission, review, rows, read = readFileSync, expectedScope = 'full-suite') {
  allow(admission, ['baselineSha256','manifest','candidateId','deploymentId','candidateSha','candidateTree','toolingSha','namespace','terminal']);
  allow(review, ['id','reviewer','reason','source','recordedAt']);
  allow(admission.terminal, evidenceKeys);
  allow(admission.manifest, evidenceKeys);
  const bytes = read(admission.terminal.path);
  assert.equal(hash(bytes), admission.terminal.sha256, 'Terminal receipt changed');
  const terminal = JSON.parse(bytes);
  allow(terminal, ['status','exitCode','signal','manifestSha256','applicationSha','applicationTree','toolingSha','namespace','evidenceMode','deploymentId','scope','runnerSha256','preflightSha256','dispatchSha256','startedAt','finishedAt']);
  assert.equal(terminal.status, 'terminal', 'Terminal state required');
  assert(Number.isInteger(terminal.exitCode) && terminal.exitCode >= 0);
  assert.equal(terminal.signal, null, 'Interrupted run requires reconciliation');
  assert(['full-suite', 'selected-vertical'].includes(expectedScope), 'Unsupported result import scope');
  for (const [field, expected] of Object.entries({manifestSha256:admission.manifest.sha256, applicationSha:admission.candidateSha, applicationTree:admission.candidateTree, toolingSha:admission.toolingSha, namespace:admission.namespace, evidenceMode:'simulated', scope:expectedScope, deploymentId:admission.deploymentId})) assert.equal(terminal[field], expected, 'Terminal identity mismatch: '+field);
  assert.match(admission.toolingSha, /^[a-f0-9]{40}$/);
  assert(Number.isFinite(Date.parse(terminal.startedAt)) && Number.isFinite(Date.parse(terminal.finishedAt)) && Date.parse(terminal.startedAt) <= Date.parse(terminal.finishedAt));
  assert(Date.parse(review.recordedAt) >= Date.parse(terminal.finishedAt), 'Review precedes terminal receipt');
  for (const {row} of rows) {
    assert(Date.parse(terminal.finishedAt) >= Date.parse(row.finishedAt), 'Result after terminal');
    assert(Date.parse(review.recordedAt) >= Date.parse(row.finishedAt), 'Review precedes result');
  }
  return terminal;
}

function resultAt(bytes, selection) {
  if (selection.line !== undefined) {
    assert(Number.isInteger(selection.line) && selection.line >= 0);
    const line = bytes.toString().split(/\r?\n/u)[selection.line];
    assert(line?.trim(), 'Missing result line');
    return JSON.parse(line);
  }
  let row = JSON.parse(bytes);
  for (const part of selection.pointer ?? []) {
    assert(Object.hasOwn(row, part), 'Missing result pointer');
    row = row[part];
  }
  return row;
}

export function validateFullSuiteManifest(manifest, baseline, read = readFileSync) {
  assert.equal(manifest.scope, 'full-suite');
  assert.equal(manifest.evidenceMode, 'simulated');
  assert(Array.isArray(manifest.requiredTestIds));
  assert(Array.isArray(manifest.scenarios));
  const obligations = applicableAutomationObligations(baseline, read);
  exact(manifest.requiredTestIds, obligations.testIds, 'Full-suite test inventory changed');
  assert.equal(new Set(manifest.requiredTestIds).size, obligations.testIds.length);
  const checks = manifest.scenarios.flatMap((stage) => {
    assert(Array.isArray(stage.testIds) && Array.isArray(stage.checks));
    for (const check of stage.checks) {
      assert(stage.testIds.includes(check.testId), 'Context mapped outside stage tests');
    }
    return stage.checks;
  });
  exact(new Set(checks.map(key)), new Set(obligations.checks.map(key)), 'Full-suite context obligations changed');
  return obligations;
}

export function validateResultManifest(manifest, baseline, read = readFileSync) {
  if (manifest.scope === 'full-suite') return validateFullSuiteManifest(manifest, baseline, read);
  assert.equal(manifest.scope, 'selected-vertical');
  assert.equal(manifest.evidenceMode, 'simulated');
  assert(Array.isArray(manifest.requiredTestIds));
  assert(Array.isArray(manifest.scenarios));
  const obligations = applicableAutomationObligations(baseline, read);
  const obligationIds = new Set(obligations.testIds);
  assert.equal(new Set(manifest.requiredTestIds).size, manifest.requiredTestIds.length, 'Duplicate selected test ID');
  assert(manifest.requiredTestIds.every((testId) => obligationIds.has(testId)), 'Selected test is not currently applicable');
  const stageTestIds = new Set();
  const checks = manifest.scenarios.flatMap((stage) => {
    assert(Array.isArray(stage.testIds) && Array.isArray(stage.checks));
    for (const testId of stage.testIds) stageTestIds.add(testId);
    assert.equal(new Set(stage.checks.map(key)).size, stage.checks.length, 'Duplicate selected context within stage');
    for (const check of stage.checks) {
      assert(stage.testIds.includes(check.testId), 'Context mapped outside stage tests');
    }
    return stage.checks;
  });
  exact(manifest.requiredTestIds, stageTestIds, 'Selected stage test inventory changed');
  const selected = new Set(manifest.requiredTestIds);
  const expectedChecks = obligations.checks.filter(({testId}) => selected.has(testId));
  exact(new Set(checks.map(key)), new Set(expectedChecks.map(key)), 'Selected context obligations changed');
  return {testIds: manifest.requiredTestIds, checks: expectedChecks};
}

export function selectExactResults(manifest, selections, read = readFileSync) {
  const allowed = new Set(
    manifest.scenarios.flatMap((stage) =>
      stage.checks.map((check) => JSON.stringify([stage.id, check.testId, check.contextId])),
    ),
  );
  const seen = new Set();
  return selections.map((selection) => {
    allow(selection, ['stageId','artifact','line','pointer']);
    assert(!(selection.line !== undefined && selection.pointer !== undefined));
    allow(selection.artifact, evidenceKeys);
    const bytes = read(selection.artifact.path);
    assert.equal(hash(bytes), selection.artifact.sha256, 'Artifact changed');
    const row = resultAt(bytes, selection);
    allow(row, ['testId','contextId','result','evidenceStatus','candidateId','deploymentId','evidenceMode','startedAt','finishedAt','proof','actorRef','tenantRef','coverageKind','actualViewport','viewportReviewId']);
    assert(
      allowed.has(JSON.stringify([selection.stageId, row.testId, row.contextId])),
      'Explicit test/context proof required; stage mapping is not a result',
    );
    assert(['passed', 'failed', 'blocked', 'unknown'].includes(row.result));
    assert(
      row.startedAt &&
        row.finishedAt &&
        Number.isFinite(Date.parse(row.startedAt)) &&
        Date.parse(row.startedAt) <= Date.parse(row.finishedAt),
      'Durable result timestamps required',
    );
    assert(row.proof && Object.keys(row.proof).length, 'Actual assertion proof required');
    const nativeTitles = [row.proof.native?.title, row.proof.nativeSurface ? row.proof.title : undefined];
    for (const nativeTitle of nativeTitles) if (nativeTitle != null) assert(typeof nativeTitle === 'string' && /^\[redacted sha256:[a-f0-9]{64} length:[0-9]+\]$/u.test(nativeTitle), 'Private native title requires semantic redaction before import');
    if (row.actualViewport) allow(row.actualViewport, ['width','height','sourceEvidencePath']);
    for (const ref of [row.actorRef,row.tenantRef]) assert(ref==null||/^sha256:[a-f0-9]{64}$/u.test(ref),'Private actor/tenant values forbidden');
    assert.equal(row.evidenceMode, 'simulated');
    assert(row.candidateId && row.deploymentId, 'Durable result identity required');
    const resultKey = key(row);
    assert(!seen.has(resultKey), 'Conflicting/duplicate result; reconcile before import');
    seen.add(resultKey);
    if (row.result === 'passed') assert.equal(row.evidenceStatus, 'complete', 'No inferred completeness');
    return {row, artifact: selection.artifact};
  });
}

export function validateResultViewport(row, contexts) {
  const validViewport = (value) => Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0;
  if (row.result === 'passed' && row.coverageKind === 'business') {
    assert(validViewport(row.actualViewport), 'Business viewport must remain explicit for existing review validation');
  }
  const normalized = row.proof?.normalization;
  if (normalized) {
    assert(
      Object.hasOwn(normalized, 'recordedViewport'),
      'Normalized result must retain the recorded viewport',
    );
    if (row.result === 'passed' && (row.coverageKind === 'business' || row.testId.includes('::ui-quality::'))) {
      assert(validViewport(normalized.recordedViewport), 'Normalization cannot invent a missing viewport');
    }
  }
  const recorded = [
    row.actualViewport,
    row.proof?.actualViewport,
    row.proof?.viewport,
    normalized?.recordedViewport,
  ].filter(validViewport);
  if (row.result === 'passed' && row.testId.includes('::ui-quality::')) {
    assert(validViewport(row.actualViewport), 'Passing UI quality requires a recorded viewport');
  }
  if (!recorded.length) return;
  const actual = {width: recorded[0].width, height: recorded[0].height};
  for (const value of recorded.slice(1)) {
    assert.deepEqual(
      {width: value.width, height: value.height}, actual,
      'Recorded viewport sources disagree',
    );
  }
  if (row.result !== 'passed') return;
  if (row.coverageKind === 'business') {
    assert(row.actualViewport, 'Business viewport must remain explicit for existing review validation');
    return;
  }
  const context = contexts.find((value) => value.id === row.contextId);
  assert(context?.viewport, 'Result viewport needs a canonical context');
  assert.deepEqual(
    actual,
    {width: context.viewport.width, height: context.viewport.height},
    'Recorded result viewport contradicts canonical context',
  );
}

export function buildResultProposal({
  baselineBytes,
  manifestBytes,
  admission,
  selections,
  review,
  matrix,
  read = readFileSync,
}) {
  assert.equal(hash(baselineBytes), admission.baselineSha256);
  assert.equal(hash(manifestBytes), admission.manifest.sha256);
  const before = JSON.parse(baselineBytes);
  const manifest = JSON.parse(manifestBytes);
  validate(before);
  validateContract(before, matrix);
  validateResultManifest(manifest, before, read);
  const candidate = before.candidates.find((row) => row.id === admission.candidateId);
  const deployment = before.deployments.find((row) => row.id === admission.deploymentId);
  assert(candidate && deployment?.candidateId === candidate.id);
  assert.equal(deployment.evidenceMode, 'simulated');
  assert.equal(deployment.status, 'verified');
  assert.equal(admission.candidateSha, candidate.commitSha);
  assert.equal(admission.candidateTree, candidate.treeSha);
  assert.equal(manifest.namespace, admission.namespace);
  if (simulationEvidenceBound(manifest)) {
    assert.equal(manifest.application?.sha, candidate.commitSha, 'Manifest application SHA drift');
    assert.equal(manifest.application?.tree, candidate.treeSha, 'Manifest application tree drift');
    assert.equal(manifest.deploymentId, deployment.id, 'Manifest deployment drift');
  } else {
    assert.equal(manifest.application, undefined, 'Selected manifest must retain its original application binding shape');
    assert.equal(manifest.deploymentId, undefined, 'Selected manifest must retain its original deployment binding shape');
  }
  assert(
    review.id &&
      review.reviewer &&
      review.reason &&
      review.source &&
      Number.isFinite(Date.parse(review.recordedAt)),
    'Independent import review required',
  );
  const selected = selectExactResults(manifest, selections, read);
  for (const {row} of selected) validateResultViewport(row, before.contexts);
  const terminal = validateTerminal(admission, review, selected, read, manifest.scope);
  validateQualificationNamespaceBinding(before, deployment, admission, terminal);
  const after = structuredClone(before);
  const tests = after.journeys.flatMap((journey) =>
    journey.useCases.flatMap((useCase) => useCase.tests),
  );
  const imported = [];
  for (const {row, artifact} of selected) {
    assert.equal(row.candidateId, candidate.id);
    assert.equal(row.deploymentId, deployment.id);
    const target = tests.find((test) => test.id === row.testId);
    assert(target?.requiredContextIds.includes(row.contextId));
    const execution = {candidateId:row.candidateId, deploymentId:row.deploymentId, evidenceMode:row.evidenceMode, contextId:row.contextId, result:row.result, startedAt:row.startedAt, finishedAt:row.finishedAt, actorRef:row.actorRef ?? null, tenantRef:row.tenantRef ?? null};
    for (const field of ['coverageKind','actualViewport','viewportReviewId']) if (Object.hasOwn(row,field)) execution[field]=row[field];
    execution.id = `${manifest.scope}:${hash(
      JSON.stringify([admission.manifest.sha256, artifact.sha256, row.testId, row.contextId]),
    )}`;
    execution.phase = 'automated-collection';
    execution.actualResult = row.proof?.missingEvidence?.includes('result-row') ? 'No assertion returned: recorded stage failure prevented this check; see hashed stage outcome.' : row.result === 'unknown' ? 'Incomplete simulated observation; see missing evidence in the immutable result.' : 'Exact durable simulated assertion; see immutable hashed evidence.';
    execution.evidenceStatus = row.evidenceStatus ?? 'incomplete';
    execution.evidence = [artifact, admission.manifest, admission.terminal].map((proof) => {
      assert.equal(hash(read(proof.path)), proof.sha256);
      assert.equal(proof.originalSha, candidate.commitSha);
      assert.equal(proof.originalTree, candidate.treeSha);
      return proof;
    });
    assert(!target.executions.some((old) => old.id === execution.id), 'Already imported; do not duplicate');
    target.executions.push(execution);
    imported.push({testId: row.testId, execution});
  }
  const resolutionRefreshes = [];
  for (const issue of after.issues.filter((value) => ['closed', 'verified'].includes(value.status))) {
    const repair = issue.repairs.at(-1);
    const previous = issue.resolutions.at(-1);
    if (previous.kind === 'prerequisite' || repair.candidateId !== candidate.id || repair.deploymentId !== deployment.id) continue;
    const affected = imported.filter(({testId}) => issue.affectedTestIds.includes(testId));
    if (!affected.length) continue;
    assert(affected.every(({execution}) => execution.result === 'passed' && execution.evidenceStatus === 'complete'), 'Verified issue refresh requires actual complete PASS results');
    assert.notEqual(review.reviewer, issue.owner, 'Verified issue refresh requires a non-owner review');
    const executionIds = affected.map(({execution}) => execution.id);
    const resolution = {
      ...previous,
      id: `import-resolution:${hash(JSON.stringify([issue.id, previous.id, executionIds]))}`,
      recordedAt: review.recordedAt,
      description: 'Refresh latest supporting PASS bindings from this independently reviewed import; preserve the original repair, resolution and issue status.',
      reviewId: review.id,
      executionIds: [...new Set([...previous.executionIds, ...executionIds])],
      evidence: [admission.manifest, admission.terminal, ...affected.map(({execution}) => execution.evidence[0])],
    };
    issue.resolutions.push(resolution);
    resolutionRefreshes.push({issueId: issue.id, repairId: repair.id, resolutionId: resolution.id, executionIds});
  }
  after.updatedAt = review.recordedAt;
  after.reviews.push({
    ...review,
    kind: 'execution-scope-review',
    ...(resolutionRefreshes.length ? {resolutionRefreshes} : {}),
    baselineSha256: admission.baselineSha256,
    manifestSha256: admission.manifest.sha256,
    reason: `${review.reason} Only explicit durable test/context results imported; absent results unchanged.`,
  });
  validate(after);
  validateContract(after, matrix);
  return after;
}

export function writeResultProposal({baselinePath, manifestPath, planPath, matrixPath, targetPath}) {
  const plan = JSON.parse(readFileSync(planPath));
  allow(plan, ['admission','selections','review']);
  const proposal = buildResultProposal({
    baselineBytes: readFileSync(baselinePath),
    manifestBytes: readFileSync(manifestPath),
    matrix: JSON.parse(readFileSync(matrixPath)),
    admission:plan.admission, selections:plan.selections, review:plan.review,
  });
  const descriptor = openSync(targetPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(proposal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return {path: targetPath, sha256: hash(readFileSync(targetPath)), selections: plan.selections.length};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.equal(process.argv.length, 7, 'Usage: <baseline> <manifest> <plan> <matrix> <proposal>');
  process.stdout.write(`${JSON.stringify(writeResultProposal({
    baselinePath: process.argv[2],
    manifestPath: process.argv[3],
    planPath: process.argv[4],
    matrixPath: process.argv[5],
    targetPath: process.argv[6],
  }))}\n`);
}
