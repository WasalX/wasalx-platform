import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {projectStageImportRows} from '../scripts/release/simulation-import-rows.mjs';
import {applyRetainedFixtures} from '../scripts/release/build-selected-simulation-manifest.mjs';
import {selectExactResults} from '../scripts/release/full-suite-result-importer.mjs';
import {validateExecutionViewport} from '../scripts/release/alpha-test-baseline.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ownerRef = 'sha256:' + sha('owner-42');
const tenantRef = 'sha256:' + sha('tenant-7');
const viewport = {width: 1440, height: 1000};
const stamp = '2026-09-30T20:00:00.000Z';

function setup(role = 'tenant_owner') {
  const contextId = role + '-en-desktop';
  const testId = 'journey/usecase::assertion::01';
  const stage = {id: 'exact-stage', checks: [{testId, contextId}], testIds: [testId]};
  const candidate = {id: 'candidate', commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40)};
  const deployment = {id: 'deployment', candidateId: candidate.id, status: 'verified'};
  const manifest = {evidenceMode: 'simulated', application: {sha: candidate.commitSha, tree: candidate.treeSha}, deploymentId: deployment.id, scenarios: [stage]};
  const catalog = {candidates: [candidate], deployments: [deployment], contexts: [{id: contextId, role, locale: 'en', viewport}]};
  const nativeActor = role === 'zammad_agent' ? {id: 42, roles: [2]} : undefined;
  const actorRef = role === 'anonymous' ? null : role === 'zammad_agent' ? 'sha256:' + sha('zammad:42') : ownerRef;
  const rowTenant = ['anonymous', 'platform_operator'].includes(role) ? null : tenantRef;
  const verifiedContext = {role, locale: 'en', actorRef, tenantRef: rowTenant, viewport, ...(nativeActor ? {nativeActor} : {})};
  const raw = {testId, contextId, result: 'passed', startedAt: stamp, finishedAt: stamp, proof: {assertion: true, actorVerified: true}, actorRef, tenantRef: rowTenant, actualViewport: viewport, verifiedContext};
  return {stage, manifest, catalog, raw};
}

test('actual producer row is hash-bound on disk and baseline viewport validates copied bytes', () => {
  const {stage, manifest, catalog, raw} = setup();
  const parent = resolve('output');
  mkdirSync(parent, {recursive: true});
  const dir = mkdtempSync(join(parent, 'simulation-import-test-'));
  assert(dir.startsWith(parent + '\\') || dir.startsWith(parent + '/'));
  try {
    const path = relative(process.cwd(), join(dir, 'row.json')).replaceAll('\\', '/');
    assert.equal(isAbsolute(path), false);
    const projected = projectStageImportRows({stage, fixture: {results: [raw]}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => path});
    assert.equal(projected.gaps.length, 0);
    const artifact = projected.artifacts[0];
    assert.equal(artifact.row.evidenceStatus, 'complete');
    assert.equal(artifact.row.actualViewport.sourceEvidencePath, path);
    writeFileSync(resolve(path), artifact.bytes, {flag: 'wx', mode: 0o600});
    const selected = selectExactResults(manifest, [artifact.selection]);
    assert.deepEqual(selected[0].row, artifact.row);
    validateExecutionViewport(catalog, {id: raw.testId, expectedResults: []}, {...selected[0].row, evidence: [artifact.selection.artifact]});
    assert.equal(sha(readFileSync(resolve(path))), artifact.selection.artifact.sha256);
  } finally {rmSync(dir, {recursive: true});}
});

test('passed behavior without verified actor becomes an explicit unknown evidence gap', () => {
  const {stage, manifest, catalog, raw} = setup();
  delete raw.verifiedContext;
  const projected = projectStageImportRows({stage, fixture: {results: [raw]}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => 'output/gap.json'});
  assert.equal(projected.artifacts[0].row.result, 'unknown');
  assert.equal(projected.artifacts[0].row.evidenceStatus, 'incomplete');
  assert.equal(projected.artifacts[0].row.proof.originalResult, 'passed');
  assert(projected.gaps[0].missing.includes('verified-context-binding'));
});

test('bootstrap admin cannot satisfy native agent proof', () => {
  const {stage, manifest, catalog, raw} = setup('zammad_agent');
  raw.verifiedContext.nativeActor.roles = [1, 2];
  const projected = projectStageImportRows({stage, fixture: {results: [raw]}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => 'output/native-gap.json'});
  assert.equal(projected.artifacts[0].row.result, 'unknown');
  assert(projected.gaps[0].missing.includes('native-agent-not-bootstrap-admin'));
});

test('explicitly cookie-free anonymous binding can be complete without actor digests', () => {
  const {stage, manifest, catalog, raw} = setup('anonymous');
  const projected = projectStageImportRows({stage, fixture: {results: [raw]}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => 'output/anonymous.json'});
  assert.equal(projected.artifacts[0].row.result, 'passed');
  assert.equal(projected.artifacts[0].row.evidenceStatus, 'complete');
  assert.equal(projected.artifacts[0].row.actorRef, null);
});

test('malformed timestamps and absent exact rows remain incomplete', () => {
  const {stage, manifest, catalog, raw} = setup();
  raw.startedAt = 'not-a-date';
  const bad = projectStageImportRows({stage, fixture: {results: [raw]}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => 'output/time-gap.json'});
  assert.equal(bad.artifacts[0].row.result, 'unknown');
  assert(bad.gaps[0].missing.includes('timestamps'));
  const absent = projectStageImportRows({stage, fixture: {}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, artifactPathFor: () => 'output/absent.json'});
  assert.equal(absent.artifacts[0].row.result, 'unknown');
  assert.deepEqual(absent.gaps[0].missing, ['result-row']);
  const blocked = projectStageImportRows({stage, fixture: {}, manifest, catalog, stageWindow: {collectionStartedAt: stamp, startedAt: stamp, finishedAt: stamp}, missingResult: 'blocked', artifactPathFor: () => 'output/dependency-blocked.json'});
  assert.equal(blocked.artifacts[0].row.result, 'blocked');
  assert.deepEqual(blocked.gaps[0].missing, ['dependency-blocked']);
});


test('collection window accepts earlier same-run observations and downgrades retained prior-run results', () => {
  const {stage, manifest, catalog, raw} = setup();
  const collectionStartedAt = '2026-09-30T19:00:00.000Z';
  const stageWindow = {collectionStartedAt, startedAt: '2026-09-30T21:00:00.000Z', finishedAt: '2026-09-30T22:00:00.000Z'};
  assert.throws(()=>projectStageImportRows({stage,fixture:{results:[raw]},manifest,catalog,stageWindow:{...stageWindow,collectionStartedAt:stageWindow.finishedAt},artifactPathFor:()=> 'output/invalid-window.json'}),/collection window/);
  const sameRun = projectStageImportRows({stage, fixture:{results:[raw]}, manifest, catalog, stageWindow, artifactPathFor:()=> 'output/same-run.json'});
  assert.equal(sameRun.artifacts[0].row.result, 'passed');
  const retained = structuredClone(raw);retained.result='failed';retained.startedAt='2026-09-30T18:00:00.000Z';retained.finishedAt='2026-09-30T18:01:00.000Z';retained.candidateId='source-candidate';retained.deploymentId='source-deployment';
  catalog.candidates.push({id:'source-candidate'});catalog.deployments.push({id:'source-deployment'});
  const stale = projectStageImportRows({stage, fixture:{results:[retained]}, manifest, catalog, stageWindow, artifactPathFor:()=> 'output/retained-prior-run.json'});
  assert.equal(stale.artifacts[0].row.result, 'unknown');
  assert.deepEqual([stale.artifacts[0].row.startedAt,stale.artifacts[0].row.finishedAt],[stageWindow.startedAt,stageWindow.finishedAt]);
  assert.equal(stale.artifacts[0].row.actorRef,null);assert.equal(stale.artifacts[0].row.tenantRef,null);assert.equal(stale.artifacts[0].row.actualViewport,undefined);
  assert.deepEqual(stale.artifacts[0].row.proof,{originalObservation:{result:'failed',startedAt:retained.startedAt,finishedAt:retained.finishedAt,actorRef:retained.actorRef,tenantRef:retained.tenantRef,candidateId:'source-candidate',deploymentId:'source-deployment'},missingEvidence:['outside-collection-window']});
  assert.equal(JSON.parse(stale.artifacts[0].bytes).role,undefined);
  assert.deepEqual(stale.gaps[0].missing, ['outside-collection-window']);
  const canary='PRIVATE_CANARY@example.invalid',malformed={...retained,actorRef:canary,tenantRef:canary,candidateId:canary,deploymentId:canary,result:canary},safe=projectStageImportRows({stage,fixture:{results:[malformed]},manifest,catalog,stageWindow,artifactPathFor:()=> 'output/malformed-retained.json'}).artifacts[0];
  assert(!safe.bytes.toString().includes(canary));assert.deepEqual(safe.row.proof.originalObservation,{result:'unknown',startedAt:retained.startedAt,finishedAt:retained.finishedAt,actorRef:null,tenantRef:null,candidateId:null,deploymentId:null});
  const stages=()=>[
    {id:'group',module:'group',export:'group',produces:'group',testIds:[],supporting:true,config:{}},
    {id:'team-roles',module:'roles',export:'roles',produces:'teamAccess',testIds:[],supporting:true,config:{}},
    {id:'quality',module:'quality',export:'quality',requires:['teamAccess'],produces:'quality',testIds:['connections/disconnect-reconnect-and-secret-retirement::ui-quality::console'],config:{}}
  ];
  const entry=id=>({path:`scenario-prior01/fixture-${id}.json`,sha256:'a'.repeat(64),expectedFixture:id==='group'?'group':'teamAccess',sourceStage:id});
  const staleRoles={schemaVersion:1,sourceNamespace:'prior01',rerunStageIds:[],stages:{group:entry('group'),'team-roles':entry('team-roles')}};
  assert.throws(()=>applyRetainedFixtures(stages(),staleRoles),/fresh team-roles wave/);
  const freshRoles={...staleRoles,stages:{group:entry('group')},rerunStageIds:['team-roles']};
  const selected=stages();applyRetainedFixtures(selected,freshRoles);assert.equal(selected[1].export,'roles');
});
