import {requiredOperatorInput} from "./operator-input.mjs";
import assert from 'node:assert/strict';
import {generateAutomationCoverage,verifyAutomationCoverage,reviewedNonApplicable,issueAppliesToMode} from './automation-coverage.mjs';
import {verifiedDeploymentImages} from './deployment-image-verification.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { hostname } from 'node:os';
import { remoteRolesForSurface, deferredAlphaContexts } from "./journey-context-contract.mjs";

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const testsOf = data => data.journeys.flatMap(j => j.useCases.flatMap(u => u.tests));
// Callers supply one candidate/deployment/context in append order.
export function executionResult(runs) {
  const last = runs.at(-1);
  if (last?.result !== 'observed') return last?.result ?? 'not-run';
  for (const run of runs.toReversed()) {
    if (run.result === 'passed' && run.evidenceStatus === 'complete') break;
    if (run.result === 'failed' || run.result === 'unknown') return run.result;
  }
  return 'observed';
}
const check = (condition, message) => assert(condition, message);
export function evidenceMode(row) {
  const mode = row?.evidenceMode ?? 'legacy-unknown';
  check(['live', 'simulated', 'legacy-unknown'].includes(mode), 'Invalid evidence mode');
  return mode;
}
function assertOtherModesResolved(test, mode, applicableModes) {
  const issueModes = applicableModes ? new Set(applicableModes) : null;
  for (const other of new Set(test.executions.map(evidenceMode))) {
    if (other === mode || (issueModes && !issueModes.has(other))) continue;
    for (const context of new Set(test.executions.filter(e => evidenceMode(e) === other).map(e => e.contextId))) {
      const result = executionResult(test.executions.filter(e => evidenceMode(e) === other && e.contextId === context));
      check(!['failed', 'unknown'].includes(result), `${test.id}: unresolved ${other} evidence cannot be closed by ${mode}`);
    }
  }
}

export const timestamp = value => typeof value === 'string' && /(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));

export function businessViewportDefinition(test) {
  return hash(JSON.stringify({id:test.id,requirementIds:test.requirementIds,expectedResults:test.expectedResults,requiredContextIds:test.requiredContextIds}));
}
function requirementMappingChange(review, change) {
  check(review.reviewer?.trim() && review.reason?.trim() && review.source?.trim() && timestamp(review.recordedAt), 'Requirement correction needs reviewed provenance');
  for (const value of [change.before, change.after]) {
    check(value && isDeepStrictEqual(Object.keys(value), ['requirementIds']), 'Requirement correction changes behavior');
    check(Array.isArray(value.requirementIds) && value.requirementIds.length && value.requirementIds.every(id => typeof id === 'string' && id.trim()) && new Set(value.requirementIds).size === value.requirementIds.length, 'Invalid requirement correction');
  }
  const before = change.before.requirementIds, after = change.after.requirementIds;
  check(after.length > before.length && isDeepStrictEqual(after.slice(0, before.length), before), 'Requirement correction must append exact prior prefix');
  return after.slice(before.length);
}
function contractRequirements(matrix, journeyId) {
  const [capabilityId, useCaseId] = journeyId.split('/');
  const useCase = matrix.capabilities.find(c => c.id === capabilityId)?.useCases.find(u => u.id === useCaseId);
  const requirements = matrix.gateDefinitions.external['first-client-alpha-live'].assertionsByJourney?.[journeyId] ?? useCase?.browserAssertions;
  check(Array.isArray(requirements), 'Requirement correction journey missing from matrix');
  return requirements;
}
function validateRequirementMappings(data, matrix, read = readFileSync) {
  const evidence = evidenceReader(read), snapshots = new Map();
  for (const review of (data.reviews ?? []).toReversed()) {
    if (review.kind !== 'requirement-mapping-correction') continue;
    check(review.changes?.length && new Set(review.changes.map(c => c.testId)).size === review.changes.length, 'Requirement correction has no changes or duplicate targets');
    const candidate = data.candidates.find(c => c.id === review.candidateId);
    check(candidate && review.matrix?.path && /^[a-f0-9]{64}$/.test(review.matrix.sha256 ?? ''), 'Requirement correction needs exact candidate and matrix proof');
    const matrixFile = evidence(review.matrix.path);
    check(matrixFile.sha256 === review.matrix.sha256, 'Requirement matrix proof changed');
    const boundMatrix = evidenceJson(matrixFile);
    check(review.assertionEvidence?.length, 'Requirement correction needs assertion proof');
    for (const proof of review.assertionEvidence) {
      check(proof.path && proof.originalSha === candidate.commitSha && proof.originalTree === candidate.treeSha && timestamp(proof.capturedAt) && Date.parse(proof.capturedAt) <= Date.parse(review.recordedAt), 'Requirement assertion proof source or time mismatch');
      check(evidence(proof.path).sha256 === proof.sha256, 'Requirement assertion proof changed');
    }
    for (const change of review.changes) {
      const added = requirementMappingChange(review, change);
      const journey = data.journeys.find(j => j.useCases.some(u => u.tests.some(t => t.id === change.testId)));
      const test = journey?.useCases.flatMap(u => u.tests).find(t => t.id === change.testId);
      check(test && journey.id === change.journeyId && data.scope.mandatoryJourneyIds.includes(journey.id) && !(data.scope.testDeferrals ?? []).some(d => d.testIds.includes(test.id)), 'Unknown, deferred or wrong-journey requirement target');
      check(added.every(id => contractRequirements(boundMatrix, journey.id).includes(id)) && (!matrix || added.every(id => contractRequirements(matrix, journey.id).includes(id))), 'Requirement append is outside current journey contract');
      const snapshot = snapshots.get(test.id) ?? {requirementIds:test.requirementIds, recordedAt:Infinity};
      check(isDeepStrictEqual(change.after.requirementIds, snapshot.requirementIds) && Date.parse(review.recordedAt) <= snapshot.recordedAt, 'Stale requirement correction chain');
      snapshots.set(test.id, {requirementIds:change.before.requirementIds, recordedAt:Date.parse(review.recordedAt)});
    }
  }
}
// Preserve viewport approvals through reviewed reference/context corrections.
export function reviewedViewportDefinition(data, test, review, entry) {
  if (entry.definitionSha256 === businessViewportDefinition(test)) return true;
  const start = data.reviews.indexOf(review);
  if (start < 0) return false;
  let snapshot = {requirementIds:test.requirementIds, requiredContextIds:test.requiredContextIds, contextExpectations:test.contextExpectations ?? null};
  let changed = false, at = Infinity;
  for (const correction of data.reviews.slice(start + 1).toReversed()) {
    if (!['context-mapping-correction', 'requirement-mapping-correction'].includes(correction.kind)) continue;
    const changes = correction.changes?.filter(c => c.testId === test.id) ?? [];
    if (!changes.length) continue;
    if (changes.length !== 1 || !correction.reviewer?.trim() || !correction.reason?.trim() || !correction.source?.trim() || !timestamp(correction.recordedAt)) return false;
    if (Date.parse(correction.recordedAt) < Date.parse(review.recordedAt) || Date.parse(correction.recordedAt) > at) return false;
    at = Date.parse(correction.recordedAt);
    const change = changes[0];
    if (correction.kind === 'requirement-mapping-correction') {
      try { requirementMappingChange(correction, change); } catch { return false; }
      if (!isDeepStrictEqual(change.after.requirementIds, snapshot.requirementIds)) return false;
      snapshot = {...snapshot, requirementIds:change.before.requirementIds};
    } else {
      for (const value of [change.before, change.after]) {
        if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['contextExpectations','requiredContextIds'])) return false;
        if (!Array.isArray(value.requiredContextIds) || !value.requiredContextIds.length || new Set(value.requiredContextIds).size !== value.requiredContextIds.length) return false;
        if (value.requiredContextIds.some(id => !data.contexts.some(c => c.id === id))) return false;
      }
      if (!isDeepStrictEqual(change.after,{requiredContextIds:snapshot.requiredContextIds, contextExpectations:snapshot.contextExpectations}) || isDeepStrictEqual(change.before,change.after)) return false;
      snapshot = {...snapshot, ...change.before};
    }
    changed = true;
  }
  return changed && entry.definitionSha256 === businessViewportDefinition({...test, requirementIds:snapshot.requirementIds, requiredContextIds:snapshot.requiredContextIds});
}

// One immutable byte snapshot per file per validation; never reused across calls.
function evidenceReader(read) {
  const files = new Map();
  return path => {
    if (!files.has(path)) {
      const bytes = read(path);
      files.set(path, { bytes, sha256: hash(bytes) });
    }
    return files.get(path);
  };
}
function evidenceJson(file) {
  if (!Object.hasOwn(file, 'json')) file.json = JSON.parse(file.bytes);
  return file.json;
}

export function validateExecutionViewport(data, test, execution, read = readFileSync, evidence = evidenceReader(read)) {
  const kind=execution.coverageKind ?? 'canonical-context';
  check(['canonical-context','business'].includes(kind), 'Invalid coverage kind');
  const actual=execution.actualViewport;
  if (!actual) { check(kind!=='business','Business evidence needs actual viewport'); return; }
  check(Number.isSafeInteger(actual.width)&&actual.width>0&&Number.isSafeInteger(actual.height)&&actual.height>0,'Invalid actual viewport');
  const context=data.contexts.find(c=>c.id===execution.contextId);
  check(context,'Viewport evidence needs context');
  const proof=execution.evidence.find(p=>p.path===actual.sourceEvidencePath);
  check(proof&&evidence(proof.path).sha256===proof.sha256,'Viewport evidence missing or changed');
  const binding=evidenceJson(evidence(proof.path));
  check(binding.viewport?.width===actual.width&&binding.viewport?.height===actual.height&&binding.role===context.role&&binding.locale===context.locale&&binding.actorRef===execution.actorRef&&binding.tenantRef===execution.tenantRef,'Viewport binding mismatch');
  if(kind==='canonical-context') {
    check(context.viewport?.width===actual.width&&context.viewport?.height===actual.height,'Canonical viewport mismatch');return;
  }
  check(!/ui-quality|responsive|keyboard|focus|contrast|zoom|layout/i.test(test.id+' '+test.expectedResults.join(' ')),'Layout assertions cannot use business viewport');
  const review=data.reviews.find(r=>r.id===execution.viewportReviewId&&r.kind==='business-viewport-applicability');
  check(review?.reviewer?.trim()&&review.reason?.trim()&&review.source?.trim()&&timestamp(review.recordedAt),'Business viewport requires review');
  const entry=review.tests?.find(t=>t.testId===test.id);
  check(entry && reviewedViewportDefinition(data,test,review,entry) && entry.executionIds?.includes(execution.id),'Unreviewed business viewport execution/definition');
}

const unique = (rows, label) => {
  check(Array.isArray(rows), `${label}: array required`);
  const ids = rows.map(row => row.id);
  check(ids.every(id => typeof id === 'string' && id.length), `${label}: ID required`);
  check(new Set(ids).size === ids.length, `${label}: duplicate ID`);
  return new Set(ids);
};

const sameSource = (a,b) => a?.commitSha === b?.commitSha && a?.treeSha === b?.treeSha;

function verifyProof(proof, candidate, read) {
  check(proof?.path && /^[a-f0-9]{64}$/.test(proof.sha256) && timestamp(proof.capturedAt), 'Prerequisite evidence metadata missing');
  check(proof.originalSha === candidate.commitSha && proof.originalTree === candidate.treeSha, 'Prerequisite evidence source mismatch');
  check(hash(read(proof.path)) === proof.sha256, 'Prerequisite evidence bytes changed');
}

function validatePrerequisiteResolution(data, issue, read) {
  const repair = issue.repairs.at(-1), resolution = issue.resolutions?.at(-1);
  check(issue.affectedTestIds.length === 0 && issue.type !== 'evidence-gap', 'Prerequisite closure cannot replace journey/evidence-gap verification');
  check(resolution?.kind === 'prerequisite' && resolution.description?.trim() && timestamp(resolution.recordedAt), 'Prerequisite resolution required');
  check(resolution.repairId === repair.id && resolution.candidateId === repair.candidateId && resolution.deploymentId === repair.deploymentId, 'Prerequisite repair binding mismatch');
  const candidate = data.candidates.find(c => c.id === repair.candidateId);
  const gateIds = issue.affectedGateIds;
  check(Array.isArray(gateIds) && gateIds.length && new Set(gateIds).size === gateIds.length, 'Prerequisite gate scope required');
  const references = resolution.gateExecutions;
  check(Array.isArray(references) && references.length === gateIds.length, 'Prerequisite gate executions missing');
  assert.deepEqual(references.map(r => r.gateId).sort(), [...gateIds].sort(), 'Prerequisite gate scope differs');
  let verifiedAt = Date.parse(repair.appliedAt);
  for (const reference of references) {
    const gate = data.gates.find(g => g.id === reference.gateId);
    check(gate, 'Unknown prerequisite gate');
    const execution = gate.executions.filter(e => sameSource(data.candidates.find(c => c.id === e.candidateId), candidate)).at(-1);
    check(execution?.id === reference.executionId && execution.result === 'passed' && execution.evidenceStatus === 'complete', 'Prerequisite needs latest complete gate pass');
    check(timestamp(execution.startedAt) && timestamp(execution.finishedAt) && Date.parse(execution.startedAt) >= Date.parse(repair.appliedAt) && Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt), 'Prerequisite gate predates repair or has invalid time');
    check(execution.evidence?.length, 'Prerequisite gate evidence required');
    for (const proof of execution.evidence) {
      verifyProof(proof,candidate,read);
      check(Date.parse(proof.capturedAt) >= Date.parse(execution.startedAt), 'Prerequisite gate uses pre-execution evidence');
      verifiedAt = Math.max(verifiedAt,Date.parse(proof.capturedAt));
    }
    verifiedAt = Math.max(verifiedAt, Date.parse(execution.finishedAt));
  }
  check(resolution.evidence?.length, 'Prerequisite resolution evidence required');
  for (const proof of resolution.evidence) {
    verifyProof(proof,candidate,read);
    check(Date.parse(proof.capturedAt) <= Date.parse(resolution.recordedAt), 'Prerequisite resolution precedes evidence');
    verifiedAt = Math.max(verifiedAt,Date.parse(proof.capturedAt));
  }
  if (['infrastructure','configuration'].includes(repair.kind)) {
    const proof = resolution.operationalVerification;
    check(proof && resolution.evidence.some(e => isDeepStrictEqual(e,proof)), 'Operational verification evidence missing');
    const operation = JSON.parse(read(proof.path));
    check(operation.kind === 'operational-prerequisite-verification' && operation.status === 'PASS' && operation.actualRuntime === true && operation.mocked === false, 'Operational prerequisite needs actual verification');
    check(operation.candidateSha === candidate.commitSha && operation.candidateTree === candidate.treeSha && operation.resource === repair.resource, 'Operational resource/source mismatch');
    check(timestamp(operation.installedAt) && timestamp(operation.startedAt) && timestamp(operation.finishedAt), 'Operational verification times required');
    check(Date.parse(operation.installedAt) >= Date.parse(repair.appliedAt) && Date.parse(operation.startedAt) >= Date.parse(operation.installedAt) && Date.parse(operation.finishedAt) >= Date.parse(operation.startedAt) && Date.parse(proof.capturedAt) >= Date.parse(operation.finishedAt), 'Operational verification precedes installation');
    verifiedAt = Math.max(verifiedAt,Date.parse(operation.finishedAt));
  }
  const review = data.reviews.find(r => r.id === resolution.reviewId);
  check(review?.kind === 'prerequisite-issue-verification' && review.verdict === 'PASS' && review.reviewer?.trim() && review.reviewer !== issue.owner && review.reason?.trim() && review.source?.trim() && timestamp(review.recordedAt), 'Independent prerequisite review required');
  check(review.issueId === issue.id && review.repairId === repair.id && review.candidateId === repair.candidateId, 'Prerequisite review binding mismatch');
  assert.deepEqual(review.gateExecutions,resolution.gateExecutions,'Prerequisite review gate references differ');
  assert.deepEqual(review.evidence,resolution.evidence,'Prerequisite review evidence differs');
  check(Date.parse(review.recordedAt) >= verifiedAt && Date.parse(resolution.recordedAt) >= Date.parse(review.recordedAt), 'Prerequisite review/resolution precedes verification');
}

export function validate(data, read = readFileSync, readApplicability) {
  validateRequirementMappings(data, null, read);
  const evidence = evidenceReader(read);
  read = path => evidence(path).bytes;
  const deploymentsVerified = new Map();
  const images = deployment => {
    if (!deploymentsVerified.has(deployment)) deploymentsVerified.set(deployment, verifiedDeploymentImages(data, deployment, read));
    return deploymentsVerified.get(deployment);
  };
  check(data.schemaVersion === 1, 'Unsupported schema version');
  check(timestamp(data.updatedAt), 'updatedAt must be UTC');
  const candidates = unique(data.candidates, 'candidates');
  const deployments = unique(data.deployments, 'deployments');
  const contexts = unique(data.contexts, 'contexts');
  const journeys = unique(data.journeys, 'journeys');
  const tests = testsOf(data);
  const deferredContexts = deferredAlphaContexts(data.scope);
  const testIds = unique(tests, 'tests');
  unique(data.journeys.flatMap(j => j.useCases), 'use cases');
  unique(data.issues, 'issues');
  unique(data.gates, 'gates');
  check(Array.isArray(data.reviews), 'reviews required');
  const deferredIds = new Set();
  unique(data.scope.testDeferrals ?? [], 'test deferrals');
  for (const deferral of data.scope.testDeferrals ?? []) {
    check(deferral.releaseProfile === 'first-client-alpha-live' && deferral.reason?.trim()
      && deferral.approval?.source?.trim() && timestamp(deferral.approval?.recordedAt), 'Invalid approved test deferral');
    check(Array.isArray(deferral.testIds) && deferral.testIds.length, 'Deferral test IDs required');
    for (const id of deferral.testIds) {
      check(testIds.has(id) && !deferredIds.has(id), `Unknown or duplicate deferred test ${id}`);
      deferredIds.add(id);
    }
  }
  for (const id of data.scope.mandatoryJourneyIds) check(journeys.has(id), `Missing journey ${id}`);
  for (const c of data.candidates) check(/^[a-f0-9]{40}$/.test(c.commitSha) && /^[a-f0-9]{40}$/.test(c.treeSha), `Invalid source identity ${c.id}`);
  for (const review of data.reviews.filter(row => row.kind === 'deployment-image-verification-correction')) {
    check(deployments.has(review.deploymentId), `Unknown corrected deployment ${review.deploymentId}`);
  }
  for (const d of data.deployments) {
    evidenceMode(d);
    check(candidates.has(d.candidateId), `Unknown deployment candidate ${d.id}`);
    if (data.reviews.some(row => row.kind === 'deployment-image-verification-correction' && row.deploymentId === d.id)) {
      images(d);
    }
  }
  for (const issue of data.issues) {
    if (issue.applicableEvidenceModes !== undefined) {
      check(Array.isArray(issue.applicableEvidenceModes) && issue.applicableEvidenceModes.length > 0 && new Set(issue.applicableEvidenceModes).size === issue.applicableEvidenceModes.length && issue.applicableEvidenceModes.every(mode => ['live', 'simulated'].includes(mode)), `Invalid issue evidence modes ${issue.id}`);
      const review = data.reviews.findLast(r => r.kind === 'issue-mode-applicability-correction' && r.issueId === issue.id);
      check(review?.reason?.trim() && review.reviewer?.trim() && timestamp(review.recordedAt) && review.evidence?.length && isDeepStrictEqual(review.after, issue.applicableEvidenceModes), `Issue modes need evidence review ${issue.id}`);
      for (const proof of review.evidence) check(evidence(proof.path).sha256 === proof.sha256 && timestamp(proof.capturedAt), `Issue mode correction needs immutable evidence ${issue.id}`);
    }
    check(['defect', 'blocker', 'evidence-gap'].includes(issue.type), `Invalid issue type ${issue.id}`);
    check(['open', 'collected', 'investigating', 'planned', 'fixed', 'verified', 'closed', 'blocked', 'deferred'].includes(issue.status), `Invalid issue status ${issue.id}`);
    for (const id of issue.affectedTestIds) check(testIds.has(id), `Unknown issue test ${id}`);
    if (issue.affectedGateIds !== undefined) {
      check(Array.isArray(issue.affectedGateIds) && issue.affectedGateIds.length && new Set(issue.affectedGateIds).size === issue.affectedGateIds.length, `Invalid issue gate scope ${issue.id}`);
      for (const id of issue.affectedGateIds) check(data.gates.some(g => g.id === id), `Unknown issue gate ${id}`);
      const review = data.reviews.findLast(r => r.kind === 'issue-gate-scope-correction' && r.issueId === issue.id);
      check(review?.reviewer?.trim() && review.reason?.trim() && timestamp(review.recordedAt) && isDeepStrictEqual(review.after,issue.affectedGateIds), `Issue gate scope needs review ${issue.id}`);
    }
    unique(issue.repairs ?? [], `repairs ${issue.id}`);
    unique(issue.resolutions ?? [], `resolutions ${issue.id}`);
    for (const repair of issue.repairs ?? []) {
      check(repair.waveId?.trim() && repair.description?.trim() && timestamp(repair.recordedAt) && timestamp(repair.appliedAt), `Repair receipt required ${issue.id}`);
      check(['source', 'configuration', 'infrastructure', 'evidence'].includes(repair.kind) && candidates.has(repair.candidateId), `Repair candidate required ${issue.id}`);
      const repairCandidate = data.candidates.find(c => c.id === repair.candidateId);
      check(Date.parse(repair.appliedAt) <= Date.parse(repair.recordedAt), `Repair recorded before application ${issue.id}`);
      check(repair.kind !== 'source' || repair.changedFiles?.length, `Repair changed files required ${issue.id}`);
      check(repair.kind === 'source' || repair.resource?.trim(), `Repair resource required ${issue.id}`);
      check(Array.isArray(repair.evidence) && repair.evidence.length, `Repair evidence required ${issue.id}`);
      for (const proof of repair.evidence) {
        check(proof.originalSha === repairCandidate.commitSha && proof.originalTree === repairCandidate.treeSha && timestamp(proof.capturedAt), `Repair evidence candidate mismatch ${issue.id}`);
        check(proof.path && /^[a-f0-9]{64}$/.test(proof.sha256) && hash(read(proof.path)) === proof.sha256, `Repair evidence changed ${issue.id}`);
      }
      check(repair.focusedChecks?.length && repair.focusedChecks.every(c => c.command?.trim() && ['passed', 'failed', 'blocked', 'not-run'].includes(c.result) && (c.result === 'not-run' ? c.reason?.trim() : repair.evidence.some(p => p.path === c.evidencePath))), `Repair focused checks required ${issue.id}`);
      if (repair.deploymentId !== null) {
        const deployment = data.deployments.find(d => d.id === repair.deploymentId);
        check(deployment?.candidateId === repair.candidateId && deployment.status === 'verified' && timestamp(repair.deployedAt), `Repair deployment mismatch ${issue.id}`);
        check(Date.parse(repair.deployedAt) >= Date.parse(repair.appliedAt), `Repair deployment precedes fix ${issue.id}`);
      }
    }
    if (['fixed', 'verified', 'closed'].includes(issue.status)) check(issue.repairs?.length, `Fixed issue needs repair receipt ${issue.id}`);
  }
  reviewedNonApplicable(data,readApplicability ?? read);
  const executions = [];
  for (const t of tests) {
    for (const field of ['title', 'nextAction']) check(typeof t[field] === 'string' && t[field].length, `${t.id}: ${field} required`);
    for (const field of ['requirementIds', 'preconditions', 'steps', 'expectedResults', 'requiredContextIds']) check(Array.isArray(t[field]) && t[field].length, `${t.id}: ${field} required`);
    for (const id of t.requiredContextIds) check(contexts.has(id), `Unknown context ${id}`);
    check(Array.isArray(t.executions), `${t.id}: executions required`);
    for (const e of t.executions) {
      executions.push(e);
      const mode = evidenceMode(e);
      const deployment = data.deployments.find(d => d.id === e.deploymentId);
      if (deployment) check(deployment.candidateId === e.candidateId && evidenceMode(deployment) === mode, `${e.id}: deployment candidate/evidence mode mismatch`);
      check(['observed', 'passed', 'failed', 'blocked', 'unknown'].includes(e.result), `${e.id}: invalid result`);
      check(['complete', 'incomplete'].includes(e.evidenceStatus), `${e.id}: invalid evidence status`);
      check(e.candidateId === null || candidates.has(e.candidateId), `${e.id}: unknown candidate`);
      check(e.deploymentId === null || deployments.has(e.deploymentId), `${e.id}: unknown deployment`);
      check(e.contextId === null || contexts.has(e.contextId), `${e.id}: unknown context`);
      for (const field of ['startedAt', 'finishedAt']) check(e[field] === null || timestamp(e[field]), `${e.id}: invalid ${field}`);
      if (e.startedAt && e.finishedAt) check(Date.parse(e.startedAt) <= Date.parse(e.finishedAt), `${e.id}: reversed time`);
      check(Array.isArray(e.evidence), `${e.id}: evidence array required`);
      validateExecutionViewport(data,t,e,read,evidence);
      if (e.result === 'passed') {
        check(e.candidateId && e.deploymentId && e.contextId && e.startedAt && e.finishedAt, `${e.id}: pass missing identity/time`);
        check(e.evidenceStatus === 'complete' && e.evidence.length, `${e.id}: pass missing complete evidence`);
        const d = data.deployments.find(row => row.id === e.deploymentId);
        const candidate = data.candidates.find(row => row.id === e.candidateId);
        const context = data.contexts.find(row => row.id === e.contextId);
        const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
        if (context.role === 'anonymous') check(e.actorRef === null && e.tenantRef === null, `${e.id}: anonymous must have no actor/tenant`);
        else {
          check(digest(e.actorRef), `${e.id}: missing actual actor digest`);
          check(context.role === 'platform_operator' ? e.tenantRef === null : digest(e.tenantRef), `${e.id}: invalid tenant binding`);
        }
        check(d.candidateId === e.candidateId && d.status === 'verified' && timestamp(d.verifiedAt), `${e.id}: deployment not verified`);
        check(images(d).length, `${e.id}: unverified images`);
        let modeManifest = false;
        for (const proof of e.evidence) {
          check(proof.path && timestamp(proof.capturedAt) && /^[a-f0-9]{64}$/.test(proof.sha256) && proof.originalSha === candidate.commitSha && proof.originalTree === candidate.treeSha, `${e.id}: incomplete/mismatched evidence metadata`);
          const artifact = evidence(proof.path);
          check(artifact.sha256 === proof.sha256, `${e.id}: evidence bytes changed`);
          if (proof.path.endsWith('.json')) {
            const manifest = evidenceJson(artifact);
            if (Object.hasOwn(manifest, 'evidenceMode')) {
              check(evidenceMode(manifest) === mode, `${e.id}: evidence manifest mode mismatch`);
              modeManifest = true;
            }
          }
        }
        if (mode === 'simulated') check(modeManifest, `${e.id}: simulated pass needs an explicit scenario manifest`);
      }
    }
  }
  unique(executions, 'executions');
  for (const issue of data.issues.filter(i => ['closed', 'verified'].includes(i.status))) {
    const repair = issue.repairs.at(-1), resolution = issue.resolutions?.at(-1);
    if (resolution?.kind === 'prerequisite') {
      validatePrerequisiteResolution(data,issue,read);
      continue;
    }
    check(issue.applicableEvidenceModes === undefined || issue.applicableEvidenceModes.includes(evidenceMode(data.deployments.find(d => d.id === repair.deploymentId))), `Issue closure evidence mode mismatch ${issue.id}`);
    check(resolution?.description?.trim() && timestamp(resolution.recordedAt) && resolution.repairId === repair.id && repair.deploymentId && resolution.candidateId === repair.candidateId && resolution.deploymentId === repair.deploymentId, `Issue closure needs deployed repair ${issue.id}`);
    check(issue.affectedTestIds.length && resolution.executionIds?.length, `Issue closure needs affected verification ${issue.id}`);
    const required = issue.affectedTestIds.filter(id => !deferredIds.has(id));
    check(required.some(id => tests.find(t => t.id === id).requiredContextIds.some(context => !deferredContexts.has(context))), `Deferred-only issue must remain deferred ${issue.id}`);
    for (const id of required) {
      const t = tests.find(t => t.id === id);
      assertOtherModesResolved(t, evidenceMode(data.deployments.find(d => d.id === repair.deploymentId)), issue.applicableEvidenceModes);
      for (const contextId of t.requiredContextIds.filter(id => !deferredContexts.has(id))) {
        const last = t.executions.filter(e => e.candidateId === repair.candidateId && e.deploymentId === repair.deploymentId && e.contextId === contextId).at(-1);
        check(last?.result === 'passed' && last.evidenceStatus === 'complete' && resolution.executionIds.includes(last.id), `Issue closure missing latest affected pass ${issue.id}/${id}/${contextId}`);
        check(Date.parse(last.startedAt) >= Date.parse(repair.deployedAt), `Issue closure uses pre-fix pass ${issue.id}`);
        check(Date.parse(resolution.recordedAt) >= Date.parse(last.finishedAt), `Issue closure precedes verification ${issue.id}`);
      }
    }
  }
  for (const gate of data.gates) {
    unique(gate.executions, `gate executions ${gate.id}`);
    for (const e of gate.executions) {
      check(candidates.has(e.candidateId), `Unknown gate candidate ${gate.id}`);
      check(['passed', 'failed', 'blocked', 'observed', 'unknown'].includes(e.result), `Invalid gate result ${gate.id}`);
      if (e.result === 'passed') check(timestamp(e.startedAt) && timestamp(e.finishedAt) && e.evidenceStatus === 'complete' && e.evidence?.length, `Gate pass missing proof ${gate.id}`);
    }
  }
  return data;
}

export function sharedJourneyContextReferences(data, journey, deferredTestIds, deferredContexts) {
  const local = new Map(journey.useCases.flatMap(u=>u.tests).map(t=>[t.id,t]));
  const all = new Map(data.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).map(t=>[t.id,t]));
  const contexts = new Set(), seen = new Set(), reviews = data.reviews ?? [];
  for (let reviewIndex = reviews.length - 1; reviewIndex >= 0; reviewIndex--) {
    const review = reviews[reviewIndex];
    if (review.kind !== 'context-mapping-correction') continue;
    for (const change of review.changes ?? []) {
      const source = local.get(change.testId);
      if (!source || deferredTestIds.has(source.id) || seen.has(source.id)) continue;
      seen.add(source.id);
      const refs = change.obligationMapping?.sharedContextReferences;
      if (refs === undefined) continue;
      check(isDeepStrictEqual(change.after, {requiredContextIds:source.requiredContextIds,contextExpectations:source.contextExpectations ?? null}), 'Stale shared context correction');
      check(review.reviewer?.trim() && review.source?.trim() && review.reason?.trim() && timestamp(review.recordedAt), 'Shared context requires reviewed provenance');
      check(Array.isArray(refs) && refs.length, 'Shared context references required');
      const removedContexts = new Set(change.before.requiredContextIds.filter(id => !change.after.requiredContextIds.includes(id)));
      let priorSnapshot = change.before;
      for (let priorIndex = reviewIndex - 1; priorIndex >= 0; priorIndex--) {
        const priorReview = reviews[priorIndex];
        if (priorReview.kind !== 'context-mapping-correction') continue;
        const priorChanges = (priorReview.changes ?? []).filter(candidate => candidate.testId === source.id);
        if (!priorChanges.length) continue;
        if (priorChanges.length !== 1 || !isDeepStrictEqual(priorChanges[0].after, priorSnapshot)) break;
        priorSnapshot = priorChanges[0].before;
        for (const id of priorSnapshot.requiredContextIds) if (!change.after.requiredContextIds.includes(id)) removedContexts.add(id);
      }
      for (const ref of refs) {
        check(removedContexts.has(ref.contextId), 'Shared context was not removed by reviewed correction chain');
        check(ref.source?.trim() && ref.expectation?.trim() && ['permission','layout','shared-ui'].includes(ref.kind), 'Shared context semantic scope missing');
        const target = all.get(ref.targetTestId);
        check(target && target.id !== source.id && !deferredTestIds.has(target.id), 'Shared context target missing or deferred');
        if ((data.scope?.approvedLimitations ?? []).some(limit => limit.testIds.includes(target.id) && limit.contextIds.includes(ref.targetContextId))) continue;
        check(ref.targetContextId === ref.contextId && target.requiredContextIds.includes(ref.targetContextId) && !deferredContexts.has(ref.contextId), 'Shared context target context missing or incorrect');
        contexts.add(ref.contextId);
      }
    }
  }
  return [...contexts];
}


export function validateContract(data, matrix, read = readFileSync) {
  validateRequirementMappings(data, matrix, read);
  const deferredTestIds = new Set((data.scope.testDeferrals ?? []).flatMap(d => d.testIds));
  const gate = matrix.gateDefinitions.external['first-client-alpha-live'];
  assert.deepEqual(data.scope.approvedLimitations ?? [], gate.approvedLimitations ?? [], 'Approved limitations differ from profile');
  unique(data.scope.approvedLimitations ?? [], 'approved limitations');
  for (const limit of data.scope.approvedLimitations ?? []) {
    check(limit.reason?.trim() && limit.exitCriteria?.trim() && data.issues.some(i => i.id === limit.issueId) && limit.approval?.source?.trim() && timestamp(limit.approval?.recordedAt), 'Limitation requires explicit approval');
    check(limit.testIds?.length && limit.contextIds?.length, 'Limitation requires exact test/context scope');
    const review = data.reviews.find(r => r.id === limit.id && r.kind === 'context-mapping-correction');
    check(review?.changes?.length === limit.testIds.length, 'Limitation requires exact reviewed correction');
    for (const id of limit.testIds) {
      const target = testsOf(data).find(t => t.id === id);
      check(target && limit.contextIds.every(c => data.contexts.some(context => context.id === c) && !target.requiredContextIds.includes(c)), 'Limitation context remains required or is unknown');
      const change = review.changes.find(c => c.testId === id);
      check(change && change.after.requiredContextIds.length && isDeepStrictEqual(change.after.requiredContextIds, change.before.requiredContextIds.filter(c => !limit.contextIds.includes(c))) && limit.contextIds.every(c => change.before.requiredContextIds.includes(c)), 'Limitation correction exceeds approved scope');
    }
  }
  const deferred = deferredAlphaContexts(gate);
  assert.deepEqual(data.scope.portalMobileDeferral ?? null, gate.portalMobileDeferral ?? null, 'Context deferral differs from simulated profile');
  // Matches the existing remote session contract in release-evidence.mjs.
  const tenantRoles = ['tenant_owner', 'tenant_admin', 'supervisor', 'agent', 'auditor'];
  const roles = [...tenantRoles, 'anonymous', 'platform_operator', 'zammad_agent'];
  const contextIds = roles.flatMap(role => gate.locales.flatMap(locale => ['desktop', 'mobile', 'tablet'].map(size => `${role}-${locale}-${size}`)));
  check(JSON.stringify(data.contexts.map(c => c.id).sort()) === JSON.stringify(contextIds.sort()), 'Context inventory differs from release contract');
  check(JSON.stringify([...data.scope.mandatoryJourneyIds].sort()) === JSON.stringify([...gate.journeyIds].sort()), 'Mandatory journey scope differs from release contract');
  for (const id of gate.journeyIds) {
    const journey = data.journeys.find(j => j.id === id);
    const [capabilityId, useCaseId] = id.split('/');
    const useCase = matrix.capabilities.find(c => c.id === capabilityId)?.useCases.find(u => u.id === useCaseId);
    const surface = matrix.capabilities.find(c => c.id === capabilityId).surface;
    const journeyRoles = new Set(remoteRolesForSurface(surface, useCase.actorRoles));
    const expectedContexts = contextIds.filter(context => !deferred.has(context) && [...journeyRoles].some(role => context.startsWith(`${role}-`)));
    const retainedTests = journey.useCases.flatMap(u => u.tests);
    const requiredTests = retainedTests.filter(t => !deferredTestIds.has(t.id));
    const actualContexts = new Set(requiredTests.flatMap(t => t.requiredContextIds).filter(id => !deferred.has(id)));
    for(const c of sharedJourneyContextReferences(data,journey,deferredTestIds,deferred))actualContexts.add(c);
    check(JSON.stringify([...actualContexts].sort()) === JSON.stringify(expectedContexts.sort()), `Journey context coverage differs: ${id}`);
    const required = gate.assertionsByJourney?.[id] ?? useCase?.browserAssertions;
    const mapped = new Set(requiredTests.flatMap(t => t.requirementIds));
    for (const requirement of required) check(mapped.has(requirement), `Unmapped requirement ${id}/${requirement}`);
    for (const requirement of new Set(retainedTests.flatMap(t => t.requirementIds))) check(required.includes(requirement), `Unknown requirement ${id}/${requirement}`);
  }
  for (const id of matrix.qualificationProfiles['first-client-alpha-ready'].automatedGates) check(data.gates.some(g => g.id === id && g.required), `Missing required gate ${id}`);
}

export function repairProgress(data) {
  const deferredContexts = deferredAlphaContexts(data.scope);
  const deferredTests = new Set((data.scope.testDeferrals ?? []).flatMap(d => d.testIds));
  return data.issues.map(issue => {
    const repair = issue.repairs?.at(-1);
    const runs = repair ? testsOf(data).filter(t => issue.affectedTestIds.includes(t.id) && !deferredTests.has(t.id)).flatMap(t => t.requiredContextIds.filter(context => !deferredContexts.has(context)).map(context => executionResult(t.executions.filter(e => e.candidateId === repair.candidateId && e.deploymentId === repair.deploymentId && e.contextId === context && e.startedAt && Date.parse(e.startedAt) >= Date.parse(repair.deployedAt))))) : [];
    const stage = ['verified', 'closed'].includes(issue.status) ? 'verified-closed' : issue.status === 'deferred' ? 'deferred' : !repair ? 'awaiting-fix' : !repair.deploymentId ? 'implemented-pending-deployment' : runs.includes('failed') ? 'retest-failed' : 'deployed-pending-retest';
    const prerequisiteStage = repair && issue.affectedGateIds?.length && !issue.affectedTestIds.length && !['verified','closed','deferred'].includes(issue.status) ? 'implemented-pending-prerequisite-verification' : stage;
    return { issueId: issue.id, stage: prerequisiteStage, waveId: repair?.waveId ?? null, repairId: repair?.id ?? null, candidateId: repair?.candidateId ?? null, deploymentId: repair?.deploymentId ?? null, affectedTestIds: issue.affectedTestIds, affectedGateIds: issue.affectedGateIds??[], nextAction: issue.nextAction };
  });
}

export function report(data, candidateId, deploymentId, requestedMode) {
  validate(data);
  return calculateReport(data, candidateId, deploymentId, requestedMode);
}

function calculateReport(data, candidateId, deploymentId, requestedMode) {
  check(candidateId && deploymentId, 'Report requires explicit candidate and deployment IDs');
  check(data.deployments.some(d => d.id === deploymentId && d.candidateId === candidateId), 'Unknown candidate/deployment pair');
  const mode = evidenceMode(data.deployments.find(d => d.id === deploymentId));
  check(requestedMode === undefined || requestedMode === mode, 'Report evidence mode/deployment mismatch');
  const counts = { passed: 0, failed: 0, blocked: 0, unknown: 0, 'evidence-incomplete': 0, 'not-run': 0 };
  const deferredTestIds = new Set((data.scope.testDeferrals ?? []).flatMap(d => d.testIds));
  const deferredContexts = deferredAlphaContexts(data.scope);
  const notApplicableTests=reviewedNonApplicable(data,readFileSync),notApplicableIds=new Set(notApplicableTests.map(r=>r.testId));
  const rows = testsOf(data).filter(t => !deferredTestIds.has(t.id)&&!notApplicableIds.has(t.id)).flatMap(t => t.requiredContextIds.filter(id => !deferredContexts.has(id)).map(contextId => {
    const runs = t.executions.filter(e => evidenceMode(e) === mode && e.candidateId === candidateId && e.deploymentId === deploymentId && e.contextId === contextId);
    // Append order is authoritative; supporting observations cannot clear failures.
    const issues = data.issues.filter(i => !['closed', 'verified', 'deferred'].includes(i.status) && i.affectedTestIds.includes(t.id) && issueAppliesToMode(i, mode));
    const result = executionResult(runs);
    let status = result === 'observed' ? 'evidence-incomplete' : result;
    if (status === 'not-run' && issues.some(i => i.type === 'blocker')) status = 'blocked';
    if (status === 'passed' && issues.some(i => i.blocksAcceptance !== false)) status = 'blocked';
    counts[status]++;
    return { testId: t.id, contextId, status, canonicalContextResult: executionResult(runs.filter(e=>e.coverageKind!=='business')), executionResult: result, issueIds: issues.map(i => i.id), nextAction: t.nextAction, contextExpectation: t.contextExpectations?.find(c => c.contextId === contextId) ?? null, requiresFreshPreflight: true, planningEligible: data.workflow?.state !== 'paused' && !issues.some(i => i.type === 'blocker') && status !== 'unknown' };
  }));
  const supportingObservations = testsOf(data).flatMap(t => t.executions).filter(e => evidenceMode(e) === mode && e.candidateId === candidateId && e.result === 'observed').length;
  const collection = testsOf(data).map(t => ({
    testId: t.id,
    supportingEvidenceMapped: t.executions.some(e => evidenceMode(e) === mode && e.candidateId === candidateId && e.evidence.length),
    issueIds: data.issues.filter(i => !['closed', 'verified', 'deferred'].includes(i.status) && i.affectedTestIds.includes(t.id) && issueAppliesToMode(i, mode)).map(i => i.id),
    nextAction: t.nextAction
  }));
  const journeyProgress = data.journeys.map(j => {
    const ids = new Set(j.useCases.flatMap(u => u.tests.map(t => t.id)));
    const checks = rows.filter(r => ids.has(r.testId));
    return { journeyId: j.id, passed: checks.filter(r => r.status === 'passed').length, required: checks.length, operationalChecksComplete: checks.length > 0 && checks.every(r => r.status === 'passed') };
  });
  const globalAcceptanceIssues = data.issues.filter(i => !['closed','verified','deferred'].includes(i.status) && i.blocksAcceptance !== false && !i.affectedTestIds.length && issueAppliesToMode(i,mode)).map(i => ({issueId:i.id,status:i.status,affectedGateIds:i.affectedGateIds??[],nextAction:i.nextAction}));
  const candidate = data.candidates.find(c => c.id === candidateId);
  const gates = data.gates.map(g => {
    const execution = g.executions.filter(e => sameSource(data.candidates.find(c => c.id === e.candidateId),candidate)).at(-1);
    return {gateId:g.id,required:g.required,result:execution?.result??'not-run',executionCandidateId:execution?.candidateId??null};
  });
  return { candidateId, deploymentId, evidenceMode: mode, countsQualification: 'operational-only', passCountScope: 'candidate-deployment-and-evidence-mode', supportingObservationScope: 'candidate-and-evidence-mode', canonicalContextPassed: rows.filter(r=>r.status==='passed'&&r.canonicalContextResult==='passed').length, deferredContexts: [...deferredContexts], notApplicableTests, requiredTests: testsOf(data).length-deferredTestIds.size-notApplicableIds.size, deferredTests: [...deferredTestIds].map(testId=>({testId,status:"deferred",planningEligible:false})), journeys: data.journeys.length, useCases: data.journeys.reduce((n, j) => n + j.useCases.length, 0), tests: testsOf(data).length, supportingObservationRecords: supportingObservations, testsWithSupportingEvidence: collection.filter(t => t.supportingEvidenceMapped).length, note: 'Supporting records may reuse the same external event; they are not independent passes or completed collection', requiredChecks: rows.length, counts, globalAcceptanceIssues, operationalPassPercent: rows.length ? Number((100 * counts.passed / rows.length).toFixed(2)) : 0, formalReleaseAcceptance: 'Not determined by this tracker; run the existing signed release verifier', gates, collection, journeyProgress, rows };
}

export function applyProposal(file, proposalFile, expectedHash, matrix) {
  const lock = `${file}.lock`;
  const fd = openSync(lock, 'wx');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, hostname: hostname(), processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), acquiredAt: new Date().toISOString(), baselinePath: resolve(file), proposalPath: resolve(proposalFile) })}\n`);
    fsyncSync(fd);
    const bytes = readFileSync(file);
    check(hash(bytes) === expectedHash, 'Stale proposal: baseline changed');
    const beforeData = JSON.parse(bytes), afterData = JSON.parse(readFileSync(proposalFile, 'utf8'));
    assert.deepEqual(afterData.reviews.slice(0, beforeData.reviews.length), beforeData.reviews, 'Preserve review history');
    const previousSources = new Map(), consumedTransitions = new Set(), appendedReviews = afterData.reviews.slice(beforeData.reviews.length);
    const transitionRows = appendedReviews.filter(r => r.kind === 'test-applicability-review').flatMap(r => (r.changes ?? []).filter(c => c.previousSourceEvidence !== undefined));
    for (const oldTest of testsOf(beforeData)) {
      const nextTest = testsOf(afterData).find(t => t.id === oldTest.id);
      const old = oldTest.applicability, next = nextTest?.applicability;
      if (old?.status !== 'reviewed-not-applicable' || isDeepStrictEqual(old.source, next?.source)) continue;
      check(next?.status === old.status && next.source.path === old.source.path, 'Applicability transition must preserve tracked source path');
      const matches = appendedReviews.filter(r => r.id === next.reviewId && r.kind === 'test-applicability-review');
      check(matches.length === 1, 'Applicability source transition needs one appended review');
      const review = matches[0], changes = review.changes?.filter(c => c.testId === oldTest.id);
      check(review.reviewer?.trim() && review.reason?.trim() && review.source?.trim() && timestamp(review.recordedAt) && changes?.length === 1, 'Applicability source transition needs exact review');
      const change = changes[0];
      consumedTransitions.add(change);
      assert.deepEqual(change.previousApplicability, old, 'Stale applicability source transition');
      assert.deepEqual(change.source, next.source, 'Applicability transition source mismatch');
      assert.deepEqual({...next, source:old.source, reviewId:old.reviewId, reviewedAt:old.reviewedAt, reviewer:old.reviewer}, old, 'Applicability transition changes disposition');
      check(next.reviewedAt === review.recordedAt && next.reviewer === review.reviewer, 'Applicability transition reviewer mismatch');
      const proof = change.previousSourceEvidence;
      check(proof?.path && proof.path !== old.source.path && proof.sha256 === old.source.sha256, 'Applicability transition previous proof binding mismatch');
      const previousBytes = readFileSync(proof.path);
      check(hash(previousBytes) === proof.sha256, 'Applicability previous source snapshot changed');
      if (previousSources.has(old.source.path)) assert.deepEqual(previousSources.get(old.source.path), previousBytes, 'Conflicting previous applicability sources');
      previousSources.set(old.source.path, previousBytes);
    }
    check(transitionRows.length === consumedTransitions.size && transitionRows.every(c => consumedTransitions.has(c)), 'Unknown, unchanged or duplicate applicability transition');
    const before = validate(beforeData, readFileSync, path => previousSources.get(path) ?? readFileSync(path));
    // Current tracked source remains authoritative for AFTER and every future validation.
    const after = validate(afterData);
    if (matrix) validateContract(after, matrix);
    for (const old of before.gates) {
      const next = after.gates.find(g => g.id === old.id);
      check(next && JSON.stringify(next.executions.slice(0, old.executions.length)) === JSON.stringify(old.executions), `Preserve gate history ${old.id}`);
    }
    check(JSON.stringify(after.reviews.slice(0, before.reviews.length)) === JSON.stringify(before.reviews), 'Preserve review history');
    const newReviews=after.reviews.slice(before.reviews.length),proofPathView=repair=>{const paths=new Map(repair.evidence.map((proof,index)=>[proof.path,index]));check(paths.size===repair.evidence.length,`Repair evidence paths must be unique ${repair.id}`);return{...repair,evidence:repair.evidence.map(proof=>{const view={...proof};delete view.path;return view;}),focusedChecks:repair.focusedChecks.map(item=>({...item,...(item.evidencePath?{evidencePath:paths.get(item.evidencePath)}:{})}))}};

    for (const issue of after.issues.filter(i => i.affectedGateIds !== undefined && !before.issues.some(old => old.id === i.id))) {
      const review = newReviews.findLast(r => r.kind === 'issue-gate-scope-correction' && r.issueId === issue.id);
      check(review?.before === null, `New issue gate scope review must start unscoped ${issue.id}`);
    }
    for (const issue of after.issues.filter(i => i.applicableEvidenceModes !== undefined && !before.issues.some(old => old.id === i.id))) {
      const review = newReviews.findLast(r => r.kind === 'issue-mode-applicability-correction' && r.issueId === issue.id);
      check(review?.before === null, `New issue mode review must start unscoped ${issue.id}`);
    }
    for (const issue of before.issues) {
      const next = after.issues.find(i => i.id === issue.id);
      check(next, `Cannot delete issue ${issue.id}`);
      if (!isDeepStrictEqual(next.affectedGateIds, issue.affectedGateIds)) {
        const oldIds=issue.affectedGateIds??[], nextIds=next.affectedGateIds??[];
        const review=newReviews.findLast(r => r.kind === 'issue-gate-scope-correction' && r.issueId === issue.id);
        check(review?.reviewer?.trim() && review.reason?.trim() && timestamp(review.recordedAt), `Issue gate scope change needs review ${issue.id}`);
        assert.deepEqual(review.before,oldIds,'Stale issue gate scope correction');
        assert.deepEqual(review.after,nextIds,'Issue gate scope correction mismatch');
        check(oldIds.every(id => nextIds.includes(id)), `Cannot remove required issue gate verification ${issue.id}`);
      }
      if (!isDeepStrictEqual(next.applicableEvidenceModes, issue.applicableEvidenceModes)) {
        const review = newReviews.find(r => r.kind === 'issue-mode-applicability-correction' && r.issueId === issue.id);
        check(review?.reason?.trim() && review.reviewer?.trim() && timestamp(review.recordedAt) && review.evidence?.length, `Issue mode change needs evidence review ${issue.id}`);
        assert.deepEqual(review.before, issue.applicableEvidenceModes ?? null, 'Stale issue mode correction');
        assert.deepEqual(review.after, next.applicableEvidenceModes ?? null, 'Issue mode correction mismatch');
        const withoutModes = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'applicableEvidenceModes'));
        assert.deepEqual(withoutModes(next), withoutModes(issue), 'Issue mode correction must preserve issue and history');
        for (const proof of review.evidence) check(hash(readFileSync(proof.path)) === proof.sha256 && timestamp(proof.capturedAt), `Issue mode correction needs immutable evidence ${issue.id}`);
      }
      if (JSON.stringify(next.affectedTestIds) !== JSON.stringify(issue.affectedTestIds)) {
        const review = after.reviews.slice(before.reviews.length).find(r => r.kind === 'issue-scope-correction' && r.issueId === issue.id);
        check(review?.reason?.trim() && review.reviewer?.trim() && timestamp(review.recordedAt), `Issue scope change needs review ${issue.id}`);
        assert.deepEqual(review.before, issue.affectedTestIds, 'Stale issue scope correction');
        assert.deepEqual(review.after, next.affectedTestIds, 'Issue scope correction mismatch');
        const removed = issue.affectedTestIds.filter(id => !next.affectedTestIds.includes(id));
        for (const id of removed) {
          const disposition = review.removedDispositions?.find(r => r.testId === id);
          check(disposition?.reason?.trim(), `Removed issue test needs disposition ${id}`);
          if (disposition.disposition === 'unrelated') continue;
          check(disposition.disposition === 'evidence-verified' && issue.type === 'evidence-gap' && next.type === 'evidence-gap', `Evidence verification only supports evidence gaps ${id}`);
          assert.deepEqual(after.scope, before.scope, 'Evidence verification must preserve scope');
          const oldTest = testsOf(before).find(t => t.id === id), test = testsOf(after).find(t => t.id === id);
          const definition = t => Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'executions'));
          assert.deepEqual(definition(test), definition(oldTest), 'Evidence verification must preserve test definition');
          const { candidateId, deploymentId, executionIds } = disposition;
          check(after.deployments.some(d => d.id === deploymentId && d.candidateId === candidateId), 'Evidence verification requires exact candidate/deployment');
          check(!(before.scope.testDeferrals ?? []).some(d => d.testIds.includes(id)), 'Deferred test cannot be evidence verified');
          assertOtherModesResolved(test, evidenceMode(after.deployments.find(d => d.id === deploymentId)), issue.applicableEvidenceModes);
          const deferred = deferredAlphaContexts(before.scope);
          const contexts = oldTest.requiredContextIds.filter(c => !deferred.has(c));
          check(contexts.length > 0 && Array.isArray(executionIds), 'Evidence verification needs required contexts');
          const accepted = contexts.map(contextId => {
            const run = test.executions.filter(e => e.candidateId === candidateId && e.deploymentId === deploymentId && e.contextId === contextId).at(-1);
            check(run?.result === 'passed' && run.evidenceStatus === 'complete' && timestamp(run.finishedAt) && Date.parse(run.finishedAt) <= Date.parse(review.recordedAt), `Evidence verification needs latest complete pass ${id}/${contextId}`);
            return run.id;
          });
          assert.deepEqual([...executionIds].sort(), accepted.sort(), 'Evidence verification execution IDs must cover exact required contexts');
        }
      }
      const oldRepairs=issue.repairs??[],nextRepairs=(next.repairs??[]).slice(0,oldRepairs.length);check(nextRepairs.length===oldRepairs.length,`Preserve issue repairs history ${issue.id}`);for(let index=0;index<oldRepairs.length;index++){const old=oldRepairs[index],replacement=nextRepairs[index];if(JSON.stringify(replacement)===JSON.stringify(old))continue;assert.deepEqual(proofPathView(replacement),proofPathView(old),`Preserve issue repairs history ${issue.id}`);const reviews=newReviews.filter(review=>review.kind==='repair-evidence-path-correction'&&review.issueId===issue.id&&review.repairId===old.id);check(reviews.length===1&&reviews[0].reviewer?.trim()&&reviews[0].source?.trim()&&reviews[0].reason?.trim()&&timestamp(reviews[0].recordedAt),`Repair evidence path correction needs review ${issue.id}/${old.id}`);assert.deepEqual(reviews[0].before,old.evidence.map(({path,sha256})=>({path,sha256})),'Stale repair evidence path correction');assert.deepEqual(reviews[0].after,replacement.evidence.map(({path,sha256})=>({path,sha256})),'Repair evidence path correction mismatch');}
      check(JSON.stringify((next.resolutions??[]).slice(0,(issue.resolutions??[]).length))===JSON.stringify(issue.resolutions??[]),`Preserve issue resolutions history ${issue.id}`);
    }
    const oldTests = testsOf(before), newTests = testsOf(after);
    const requirementCorrected = new Set();
    for (const review of newReviews.filter(r => r.kind === 'requirement-mapping-correction')) {
      check(matrix, 'Requirement correction requires current contract');
      assert.deepEqual(JSON.parse(readFileSync(review.matrix.path)), matrix, 'Requirement correction matrix differs from current contract');
      for (const change of review.changes) {
        const old = oldTests.find(t => t.id === change.testId), next = newTests.find(t => t.id === change.testId);
        check(old && next && !requirementCorrected.has(old.id), 'Unknown or duplicate requirement correction');
        assert.deepEqual(change.before, {requirementIds:old.requirementIds}, 'Stale requirement correction');
        assert.deepEqual(change.after, {requirementIds:next.requirementIds}, 'Requirement correction does not match proposal');
        const deferred = new Set((before.scope.testDeferrals ?? []).flatMap(d => d.testIds));
        const mapped = new Set(before.journeys.find(j => j.id === change.journeyId).useCases.flatMap(u => u.tests.filter(t => !deferred.has(t.id)).flatMap(t => t.requirementIds)));
        for (const key of ['preconditions', 'steps', 'expectedResults', 'requiredContextIds', 'contextExpectations']) assert.deepEqual(next[key], old[key], 'Requirement correction must preserve behavior and context');
        check(requirementMappingChange(review, change).every(id => !mapped.has(id)), 'Requirement correction may only map missing current obligations');
        check(Date.parse(review.recordedAt) >= Date.parse(before.updatedAt), 'Requirement correction precedes baseline');
        requirementCorrected.add(old.id);
      }
    }
    const contextKeys = ['requiredContextIds', 'contextExpectations'];
    const contextSnapshot = t => Object.fromEntries(contextKeys.map(key => [key, t[key] ?? null]));
    const corrected = new Set();
    for (const review of after.reviews.slice(before.reviews.length).filter(r => r.kind === 'context-mapping-correction')) {
      check(matrix && review.reason?.trim() && review.source?.trim() && timestamp(review.recordedAt) && review.changes?.length, 'Context correction requires contract and review');
      for (const change of review.changes) {
        const old = oldTests.find(t => t.id === change.testId), next = newTests.find(t => t.id === change.testId);
        check(old && next && !corrected.has(change.testId), 'Unknown or duplicate context correction');
        assert.deepEqual(change.before, contextSnapshot(old), 'Stale context correction');
        assert.deepEqual(change.after, contextSnapshot(next), 'Context correction does not match proposal');
        check(JSON.stringify(change.before) !== JSON.stringify(change.after), 'Empty context correction');
        corrected.add(change.testId);
      }
    }
    for (const old of oldTests) {
      const next = newTests.find(t => t.id === old.id);
      check(next, `Cannot remove historical test ${old.id}`);
      check(JSON.stringify(next.executions.slice(0, old.executions.length)) === JSON.stringify(old.executions), `Cannot rewrite execution history ${old.id}`);
      if (old.executions.length) for (const key of ['requirementIds', 'preconditions', 'steps', 'expectedResults', ...contextKeys]) {
        if (corrected.has(old.id) && contextKeys.includes(key)) continue;
        if (requirementCorrected.has(old.id) && key === 'requirementIds') continue;
        check(JSON.stringify(old[key]) === JSON.stringify(next[key]), `Version changed test with a new ID: ${old.id}/${key}`);
      }
    }
    const previousExecutions = new Set(oldTests.flatMap(t => t.executions.map(e => e.id)));
    for (const e of newTests.flatMap(t => t.executions)) if (!previousExecutions.has(e.id)) check(Object.hasOwn(e, 'evidenceMode'), `New execution requires explicit evidenceMode: ${e.id}`);
    for (const d of after.deployments) if (!before.deployments.some(old => old.id === d.id)) check(Object.hasOwn(d, 'evidenceMode'), `New deployment requires explicit evidenceMode: ${d.id}`);
    for (const key of ['candidates', 'deployments', 'contexts']) for (const old of before[key]) check(after[key].some(row => JSON.stringify(row) === JSON.stringify(old)), `Preserve historical ${key}/${old.id}; append a new record`);
    const backup = `${file}.${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}.bak`;
    writeFileSync(backup, bytes, { flag: 'wx' });
    after.updatedAt = new Date().toISOString();
    writeFileSync(temporary, `${JSON.stringify(after, null, 2)}\n`, { flag: 'wx' });
    const tmpFd = openSync(temporary, 'r+');
    try { fsyncSync(tmpFd); } finally { closeSync(tmpFd); }
    renameSync(temporary, file);
    return { backup, sha256: hash(readFileSync(file)) };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') console.error(`Temporary file cleanup failed: ${error.code}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, file, arg1, arg2, mode] = process.argv.slice(2);
    check(file, 'Usage: alpha-test-baseline.mjs validate|report|repairs|apply FILE [CANDIDATE DEPLOYMENT | PROPOSAL EXPECTED_SHA256]');
    check(['validate', 'report', 'repairs', 'apply', 'coverage', 'coverage-generate'].includes(command), 'Unknown command');
    const matrix = JSON.parse(readFileSync(new URL(requiredOperatorInput("WASALX_FEATURE_MATRIX"), import.meta.url), 'utf8'));
    if (command === 'apply') console.log(JSON.stringify(applyProposal(resolve(file), resolve(arg1), arg2, matrix), null, 2));
    else {
      const bytes = readFileSync(file), data = validate(JSON.parse(bytes));
      validateContract(data, matrix);
      if (command === 'validate') console.log(JSON.stringify({ valid: true, sha256: hash(bytes), journeys: data.journeys.length, tests: testsOf(data).length }));
      else if (command === 'report') console.log(JSON.stringify({ ...calculateReport(data, arg1, arg2, mode), repairs: repairProgress(data) }, null, 2));
      else if(command==='coverage')console.log(JSON.stringify(verifyAutomationCoverage(data,JSON.parse(readFileSync(arg1)),readFileSync),null,2));
      else if(command==='coverage-generate'){const plan=JSON.parse(readFileSync(arg1));check(arg2,'Output file required');const manifest=generateAutomationCoverage(data,plan,readFileSync);writeFileSync(arg2,JSON.stringify(manifest,null,2),{flag:'wx'});const databaseAssertions=manifest.gateBackedAssertions?.postgresDesignation.results.length??0;console.log(JSON.stringify({output:arg2,requiredTests:manifest.requiredTestIds.length,mandatoryDatabaseAssertions:databaseAssertions,totalMandatoryAssertions:manifest.requiredTestIds.length+databaseAssertions}));}
      else if (command === 'repairs') console.log(JSON.stringify(repairProgress(data), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
