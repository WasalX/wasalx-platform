import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifiedDeploymentImages} from './deployment-image-verification.mjs';
import {designationTestIds,validateDesignationReceipt} from './simulation-postgres-designation-stage.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceDigest=bytes=>digest(Buffer.from(bytes).toString('utf8').replaceAll('\r\n','\n'));
const exact=(actual,expected,label)=>assert.deepEqual([...actual].sort(),[...expected].sort(),label);
export function issueAppliesToMode(issue,mode) {
  return mode==='legacy-unknown'||issue.applicableEvidenceModes===undefined||issue.applicableEvidenceModes.includes(mode);
}
const designationSources=['scripts/test-postgres-integration.mjs','tests/group-designation-evidence.mjs','tests/group-designation-postgres.mjs'];
const designationSourcePath=path=>designationSources.includes(path)||/^services\/control-api\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/u.test(path);
function postgresDesignationObligation(data,candidate,readEvidence) {
  const deferrals=(data.scope.testDeferrals??[]).filter(d=>d.testIds.some(id=>designationTestIds.includes(id)));
  if(!deferrals.length)return null;
  assert.equal(deferrals.length,1);const deferral=deferrals[0];exact(deferral.testIds,designationTestIds,'Designation deferral scope changed');
  assert.equal(deferral.releaseProfile,'first-client-alpha-live');assert(deferral.approval?.source&&Number.isFinite(Date.parse(deferral.approval.recordedAt)));
  const review=data.reviews?.find(r=>r.kind==='test-applicability-correction'&&r.verdict==='APPROVED_WITH_REQUIRED_DATABASE_PROOF'&&r.testIds?.some(id=>designationTestIds.includes(id)));
  assert(review?.reviewer&&review.source&&Number.isFinite(Date.parse(review.recordedAt)));exact(review.testIds,designationTestIds,'Designation review scope changed');
  const safeguard=designationTestIds[0].replace(/::concurrent$/u,'::reject-second');assert.equal(review.requiredSafeguardTestId,safeguard);
  assert(!data.scope.testDeferrals.some(d=>d.testIds.includes(safeguard)),'Owner safeguard must remain applicable');
  const gate=data.gates?.find(g=>g.id==='postgres')?.executions.filter(e=>e.candidateId===candidate.id).at(-1);
  assert(gate?.result==='passed'&&gate.evidenceStatus==='complete'&&gate.evidenceMode==='simulated','Exact candidate PostgreSQL gate required');
  const load=name=>{const refs=gate.evidence.filter(e=>e.path.endsWith('/'+name));assert.equal(refs.length,1,'Missing/duplicate PostgreSQL '+name);const ref=refs[0];assert.equal(ref.originalSha,candidate.commitSha);assert.equal(ref.originalTree,candidate.treeSha);const bytes=readEvidence(ref.path);assert.equal(digest(bytes),ref.sha256,'Changed PostgreSQL evidence');return {ref:{path:ref.path,sha256:ref.sha256},value:JSON.parse(bytes)};};
  const formal=load('postgres.json'),envelope=load('envelope.json'),cleanup=load('cleanup.json');const f=formal.value,e=envelope.value,c=cleanup.value;
  assert.equal(f.kind,'automated');assert.equal(f.gate,'postgres');assert.equal(f.status,'passed');assert.equal(f.exitCode,0);assert.equal(f.candidateSha,candidate.commitSha);assert.equal(f.candidateTree,candidate.treeSha);
  assert.deepEqual(f.commands,[{argv:['pnpm','test:postgres']}]);
  for(const state of [f.candidateState?.before,f.candidateState?.after]){assert.equal(state?.sha,candidate.commitSha);assert.equal(state?.tree,candidate.treeSha);assert.equal(state?.clean,true);}
  assert.equal(e.gate.formalManifestSha256,formal.ref.sha256);assert.equal(f.startedAt,e.gate.startedAt);assert.equal(f.completedAt,e.gate.finishedAt);assert.equal(gate.startedAt,e.gate.startedAt);
  assert.equal(c.status,'PASS');assert.equal(c.dropped,true);assert.equal(c.activeClientsBeforeDrop,0);assert.equal(c.database,e.receipt.database);assert.equal(c.envelopeSha256,envelope.ref.sha256);assert.equal(c.formalManifestSha256,formal.ref.sha256);
  assert(Date.parse(e.gate.finishedAt)<=Date.parse(c.finishedAt)&&Date.parse(c.finishedAt)<=Date.parse(gate.finishedAt),'PostgreSQL cleanup interval mismatch');
  exact(Object.keys(e.receipt.sourceHashes),designationSources,'Designation source scope changed');
  const sources=designationSources.map(path=>({path,sha256:sourceDigest(readEvidence(path))}));
  for(const name of ['0001_control_plane.sql','0025_rule_governance.sql','0070_tenant_referential_integrity.sql','0156_group_designated_binding.sql'])assert(e.receipt.migrations.some(row=>row.name===name),'Missing designation prerequisite migration: '+name);
  const migrations=e.receipt.migrations.map(row=>{const path='services/control-api/migrations/'+row.name;assert(designationSourcePath(path),'Invalid migration path');const sha256=sourceDigest(readEvidence(path));assert.equal(sha256,row.checksum_sha256,'Changed PostgreSQL migration');sources.push({path,sha256});return {name:row.name,checksum_sha256:sha256};});
  assert.equal(new Set(migrations.map(m=>m.name)).size,migrations.length,'Duplicate migration');
  const results=validateDesignationReceipt(e,{sha:candidate.commitSha,tree:candidate.treeSha,sourceHashes:Object.fromEntries(sources.slice(0,designationSources.length).map(s=>[s.path,s.sha256])),migrations});
  return {gateExecutionId:gate.id,candidateSha:candidate.commitSha,candidateTree:candidate.treeSha,evidenceMode:'simulated',executionBoundary:'postgresql-invariant-only; no browser actor or viewport',evidence:[formal.ref,envelope.ref,cleanup.ref],sources,results:results.map(r=>({testId:r.testId,result:r.result,startedAt:r.startedAt,finishedAt:r.finishedAt,proofSha256:digest(JSON.stringify(r.proof))}))};
}
// Insert in the existing tracker; callers first run validate + validateContract.
// readEvidence returns original bytes. Never accepts an unverified parsed object.
export function verifyAutomationCoverage(data, manifest, readEvidence) {
  assert.equal(manifest.evidenceMode,'simulated');
  assert.equal(manifest.schemaVersion,1);
  const candidate=data.candidates.find(c=>c.id===manifest.candidateId);assert(candidate);assert.equal(manifest.candidateSha,candidate.commitSha);assert.equal(manifest.candidateTree,candidate.treeSha);
  assert.equal(manifest.baselineSha256,digest(readEvidence(manifest.baselinePath)));
  assert.deepEqual(JSON.parse(readEvidence(manifest.baselinePath)),data);
  const deferred=new Set((data.scope.testDeferrals??[]).flatMap(d=>d.testIds));
  const deferredContexts=new Set(data.scope.portalMobileDeferral?.contextIds??[]);
  const notApplicable=reviewedNonApplicable(data,readEvidence);
  const excluded=new Set(notApplicable.map(r=>r.testId));
  const tests=data.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).filter(t=>!deferred.has(t.id)&&!excluded.has(t.id));
  assert.deepEqual(manifest.notApplicableTests??[],notApplicable,'Applicability dispositions changed');
  exact(manifest.requiredTestIds,tests.map(t=>t.id),'Required tests changed');
  assert.equal(new Set(manifest.requiredTestIds).size,tests.length);
  const designation=postgresDesignationObligation(data,candidate,readEvidence);
  assert.deepEqual(manifest.gateBackedAssertions??null,designation?{postgresDesignation:designation}:null,'Gate-backed designation evidence differs');
  if(designation){assert(manifest.requiredTestIds.includes(designationTestIds[0].replace(/::concurrent$/u,'::reject-second')),'Owner safeguard missing');assert(designationTestIds.every(id=>!manifest.requiredTestIds.includes(id)),'Database/browser obligation overlap');}
  const expected=tests.flatMap(t=>t.requiredContextIds.filter(c=>!deferredContexts.has(c)).map(c=>`${t.id}|${c}`));
  exact(manifest.checks.map(c=>`${c.testId}|${c.contextId}`),expected,'Missing/duplicate applicable assertion context');
  const deployments=new Map(data.deployments.map(d=>[d.id,d]));
  const admissions=new Map(manifest.deploymentAdmissions.map(a=>[a.deploymentId,a]));
  assert.equal(admissions.size,manifest.deploymentAdmissions.length);
  exact(admissions.keys(),new Set(manifest.checks.map(c=>c.deploymentId)),'Unused/missing admission');
  const target=deployments.get(manifest.targetDeploymentId);assert(target&&target.candidateId===candidate.id&&target.evidenceMode==='simulated');
  const images=d=>verifiedDeploymentImages(data,d,readEvidence);
  const productImages=d=>images(d).map(i=>[i.service,i.runningDigest]).sort((a,b)=>a[0].localeCompare(b[0]));
  for(const admission of admissions.values()) {
    const d=deployments.get(admission.deploymentId);assert(d&&d.candidateId===candidate.id&&d.evidenceMode==='simulated');
    assert.deepEqual(productImages(d),productImages(target),'Product images differ; new qualification required');
    const bytes=readEvidence(admission.path);assert.equal(digest(bytes),admission.sha256);
    const proof=JSON.parse(bytes);assert.equal(proof.candidate.sha,manifest.candidateSha);assert.equal(proof.candidate.tree,manifest.candidateTree);
    for(const image of images(d)){assert.equal(proof.containers[image.service].image,image.runningDigest);assert.equal(proof.containers[image.service].id,image.containerId);assert.equal(image.runningDigest,image.expectedDigest);}
    assert.deepEqual(proof.harnessOverlay,d.harnessOverlay);
    if(d.id!==target.id){
      const eq=admission.sourceImpactEquivalence;assert(eq?.reviewer&&eq.reason&&eq.source&&Number.isFinite(Date.parse(eq.reviewedAt)));
      assert.equal(eq.candidateSha,manifest.candidateSha);assert.equal(eq.candidateTree,manifest.candidateTree);
      assert.deepEqual(eq.harnessOverlay,d.harnessOverlay);assert.deepEqual(eq.targetHarnessOverlay,target.harnessOverlay);
      exact(eq.testIds,new Set(manifest.checks.filter(c=>c.deploymentId===d.id).map(c=>c.testId)),'Equivalence scope differs');
    }
  }
  for(const check of manifest.checks){
    const t=tests.find(t=>t.id===check.testId);
    const runs=t.executions.filter(e=>e.candidateId===candidate.id&&e.evidenceMode==='simulated'&&e.contextId===check.contextId);
    const e=runs.find(e=>e.id===check.executionId);assert(e&&e.deploymentId===check.deploymentId);
    assert.equal(e.result,'passed');assert.equal(e.evidenceStatus,'complete');assert(e.startedAt&&e.finishedAt);
    // A cherry-picked earlier pass cannot hide a later failure or ambiguous outcome.
    assert(!runs.slice(runs.indexOf(e)+1).some(r=>['failed','unknown'].includes(r.result)),'Later unresolved failure');
    assert(!data.issues.some(i=>!['closed','verified','deferred'].includes(i.status)&&i.blocksAcceptance!==false&&issueAppliesToMode(i,manifest.evidenceMode)&&(!(i.affectedTestIds?.length)||i.affectedTestIds.includes(t.id))),'Unresolved acceptance issue');
    exact(check.evidence.map(p=>p.path+':'+p.sha256),e.evidence.map(p=>p.path+':'+p.sha256),'Execution evidence differs');
    for(const proof of check.evidence)assert.equal(digest(readEvidence(proof.path)),proof.sha256,'Changed evidence');
  }
  return {evidenceMode:'simulated',qualification:'automation-only',requiredTests:tests.length,requiredChecks:expected.length,passedChecks:expected.length,mandatoryDatabaseAssertions:designation?.results.length??0,totalMandatoryAssertions:tests.length+(designation?.results.length??0),liveAcceptance:false};
}

// Used by existing remote session/journey contract functions, only for reviewed alpha selection.
export function criticalLiveSelection(gate, allJourneys, allowedContextIds) {
  const selected=gate.criticalLiveSelection;if(!selected)return null;
  assert.equal(selected.status,'approved');assert(selected.approval?.source&&selected.approval.reviewer&&Number.isFinite(Date.parse(selected.approval.recordedAt)));
  assert(Array.isArray(selected.journeys)&&selected.journeys.length>0,'Empty live selection');assert.equal(new Set(selected.journeys.map(j=>j.id)).size,selected.journeys.length);
  for(const row of selected.journeys){const original=allJourneys.find(j=>j.id===row.id);assert(original);assert(row.assertions.length&&row.contextIds.length);assert.equal(new Set(row.contextIds).size,row.contextIds.length);assert(Array.isArray(original.allowedContextIds)&&original.allowedContextIds.length,'Original journey context contract missing');for(const id of row.contextIds){assert(allowedContextIds.includes(id));assert(original.allowedContextIds.includes(id),'Context not allowed for original journey');}assert.equal(new Set(row.assertions).size,row.assertions.length);for(const id of row.assertions)assert(original.assertions.includes(id));}
  return selected;
}




export async function verifyAutomationBridge(binding, {candidateSha,candidateTree,readRepository,artifactDigest,validateBaseline}) {
  assert.deepEqual(Object.keys(binding??{}).sort(),['digest','governanceManifest','path']);
  const root=`output/release-evidence/${candidateSha}/`;
  assert.equal(binding.path,root+'automation-coverage.json');
  assert.deepEqual(Object.keys(binding.governanceManifest??{}).sort(),['digest','path']);
  assert.equal(binding.governanceManifest.path,root+'governance.json');
  const govBytes=await readRepository(binding.governanceManifest.path);assert.equal('sha256:'+digest(govBytes),binding.governanceManifest.digest,'Governance digest changed');
  const gov=JSON.parse(govBytes);assert.equal(gov.kind,'automated');assert.equal(gov.gate,'governance');assert.equal(gov.status,'passed');assert.equal(gov.candidateSha,candidateSha);assert.equal(gov.candidateTree,candidateTree);
  const refs=gov.supportingArtifacts.filter(a=>a.path===binding.path);assert.equal(refs.length,1,'Missing/duplicate governance coverage artifact');assert.deepEqual(refs[0],await artifactDigest(binding.path));
  const bytes=await readRepository(binding.path);assert.equal('sha256:'+digest(bytes),binding.digest,'Coverage digest changed');
  const coverage=JSON.parse(bytes);assert.equal(coverage.evidenceMode,'simulated');assert.equal(coverage.candidateSha,candidateSha);assert.equal(coverage.candidateTree,candidateTree);
  const files=new Map([[coverage.baselinePath,await readRepository(coverage.baselinePath)]]);const data=JSON.parse(files.get(coverage.baselinePath));
  const designation=coverage.gateBackedAssertions?.postgresDesignation;
  if(designation){const gate=data.gates?.find(g=>g.id==='postgres')?.executions.filter(e=>e.candidateId===coverage.candidateId).at(-1);for(const proof of designation.evidence)assert(gate?.evidence.some(e=>e.path===proof.path&&e.sha256===proof.sha256),'Unadmitted PostgreSQL evidence path');for(const source of designation.sources)assert(designationSourcePath(source.path),'Unadmitted PostgreSQL source path');for(const path of new Set([...designation.evidence,...designation.sources].map(e=>e.path)))files.set(path,await readRepository(path));}
  for(const path of new Set([...(coverage.notApplicableTests??[]).map(a=>a.source.path),...coverage.deploymentAdmissions.map(a=>a.path),...coverage.checks.flatMap(c=>c.evidence.map(e=>e.path))]))files.set(path,await readRepository(path));
  await validateBaseline(data);
  return verifyAutomationCoverage(data,coverage,path=>{assert(files.has(path),'Unadmitted evidence path');return files.get(path)});
}

export function generateAutomationCoverage(data, plan, readEvidence) {
  const deferred=new Set((data.scope.testDeferrals??[]).flatMap(d=>d.testIds));const contexts=new Set(data.scope.portalMobileDeferral?.contextIds??[]);
  const notApplicable=reviewedNonApplicable(data,readEvidence);
  const excluded=new Set(notApplicable.map(r=>r.testId));
  const tests=data.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).filter(t=>!deferred.has(t.id)&&!excluded.has(t.id));
  const checks=tests.flatMap(t=>t.requiredContextIds.filter(c=>!contexts.has(c)).map(contextId=>{
    const runs=t.executions.filter(e=>e.candidateId===plan.candidateId&&e.evidenceMode==='simulated'&&e.contextId===contextId);
    const e=runs.findLast(e=>e.result!=='observed');assert(e&&e.result==='passed'&&e.evidenceStatus==='complete',`Incomplete ${t.id}/${contextId}`);
    return {testId:t.id,contextId,executionId:e.id,deploymentId:e.deploymentId,evidence:e.evidence.map(({path,sha256})=>({path,sha256}))};
  }));
  const candidate=data.candidates.find(c=>c.id===plan.candidateId);assert(candidate);const designation=postgresDesignationObligation(data,candidate,readEvidence);
  const manifest={...plan,notApplicableTests:notApplicable,schemaVersion:1,evidenceMode:'simulated',requiredTestIds:tests.map(t=>t.id),checks,...(designation?{gateBackedAssertions:{postgresDesignation:designation}}:{})};
  verifyAutomationCoverage(data,manifest,readEvidence);return manifest;
}

export function reviewedNonApplicable(data,readSource) {
 const result=[];
 for(const t of data.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests))){
  const a=t.applicability;if(a?.status!=='reviewed-not-applicable')continue;
  assert(t.id.endsWith('::ui-quality::empty'),'Only reviewed absent collection states supported');
  const review=data.reviews.find(r=>r.id===a.reviewId&&r.kind==='test-applicability-review');
  assert(review?.reviewer&&review.recordedAt&&review.reason);
  const entry=review.changes?.find(c=>c.testId===t.id);
  assert(entry&&entry.status==='reviewed-not-applicable'&&entry.reason===a.reason&&a.reason.trim());
  const definitionSha256=digest(JSON.stringify({id:t.id,requirementIds:t.requirementIds,steps:t.steps,expectedResults:t.expectedResults}));
  assert.equal(entry.definitionSha256,definitionSha256,'Changed applicability definition');
  assert.deepEqual(entry.source,a.source,'Applicability source mismatch');
  assert.match(a.source.sha256,/^[a-f0-9]{64}$/);
  assert.equal(sourceDigest(readSource(a.source.path)),a.source.sha256,'Changed applicability source');
  assert(!data.issues.some(i=>i.affectedTestIds?.includes(t.id)&&['defect','blocker'].includes(i.type)&&!['closed','verified','deferred'].includes(i.status)),'Cannot hide an unresolved defect');
  assert(!(data.scope?.testDeferrals??[]).some(d=>d.testIds.includes(t.id)),'Deferred and not-applicable overlap');
  result.push({testId:t.id,status:'not-applicable',reviewId:review.id,reason:a.reason,definitionSha256,source:a.source});
 }
 return result;
}

// Admission only: required mappings, never execution or acceptance evidence.
export function applicableAutomationObligations(data, readSource) {
 const excluded=new Set(reviewedNonApplicable(data,readSource).map(r=>r.testId));
 const deferred=new Set((data.scope?.testDeferrals??[]).flatMap(d=>d.testIds));
 const contexts=new Set(data.scope?.portalMobileDeferral?.contextIds??[]);
 const tests=data.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).filter(t=>!deferred.has(t.id)&&!excluded.has(t.id));
 return {testIds:tests.map(t=>t.id),checks:tests.flatMap(t=>t.requiredContextIds.filter(c=>!contexts.has(c)).map(contextId=>({testId:t.id,contextId})))};
}
