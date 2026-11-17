import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{verifyAutomationCoverage}from'../scripts/release/automation-coverage.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){const files=new Map(),put=(p,x)=>{const b=Buffer.from(JSON.stringify(x));files.set(p,b);return{path:p,sha256:hash(b)}};const evidence=[put('result',{evidenceMode:'simulated',passed:true})],images=[{service:'api',expectedDigest:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',runningDigest:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',containerId:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}],dep=id=>({id,candidateId:'c',evidenceMode:'simulated',images,harnessOverlay:{runner:id}});const a=dep('a'),b=dep('b'),execution={id:'e',candidateId:'c',deploymentId:'a',evidenceMode:'simulated',contextId:'owner',result:'passed',evidenceStatus:'complete',startedAt:'2026-09-11T00:00:00Z',finishedAt:'2026-09-11T00:01:00Z',evidence};const data={candidates:[{id:'c',commitSha:'sha',treeSha:'tree'}],scope:{},deployments:[a,b],issues:[],journeys:[{useCases:[{tests:[{id:'t',requiredContextIds:['owner'],executions:[execution]}]}]}]};const admission=put('admission',{candidate:{sha:'sha',tree:'tree'},containers:{api:{image:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}},harnessOverlay:a.harnessOverlay});const baseline=put('baseline',data);const manifest={schemaVersion:1,evidenceMode:'simulated',candidateId:'c',candidateSha:'sha',candidateTree:'tree',baselinePath:'baseline',baselineSha256:baseline.sha256,targetDeploymentId:'b',requiredTestIds:['t'],checks:[{testId:'t',contextId:'owner',deploymentId:'a',executionId:'e',evidence}],deploymentAdmissions:[{deploymentId:'a',...admission,sourceImpactEquivalence:{reviewer:'reviewer',reason:'Same product/source; affected harness independently reviewed',source:'review.md',reviewedAt:'2026-09-11T01:00:00Z',candidateSha:'sha',candidateTree:'tree',harnessOverlay:a.harnessOverlay,targetHarnessOverlay:b.harnessOverlay,testIds:['t']}}]};return{data,manifest,files,put,run(){return verifyAutomationCoverage(data,manifest,p=>files.get(p))},rebind(){manifest.baselineSha256=put('baseline',data).sha256}}}

import {verifyAutomationBridge,generateAutomationCoverage} from '../scripts/release/automation-coverage.mjs';
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {designationTestIds} from '../scripts/release/simulation-postgres-designation-stage.mjs';

function addDesignation(f){
 const safeguard=designationTestIds[0].replace(/::concurrent$/u,'::reject-second');
 f.data.journeys[0].useCases[0].tests[0].id=safeguard;f.manifest.requiredTestIds=[safeguard];f.manifest.checks[0].testId=safeguard;f.manifest.deploymentAdmissions[0].sourceImpactEquivalence.testIds=[safeguard];
 f.data.journeys[0].useCases[0].tests.push(...designationTestIds.map(id=>({id,requiredContextIds:['owner'],executions:[]})));
 f.data.scope.testDeferrals=[{releaseProfile:'first-client-alpha-live',testIds:designationTestIds,approval:{source:'fixture approval only',recordedAt:'2026-09-11T00:00:00Z'}}];
 f.data.reviews=[{kind:'test-applicability-correction',verdict:'APPROVED_WITH_REQUIRED_DATABASE_PROOF',reviewer:'fixture',source:'fixture review only',recordedAt:'2026-09-11T00:00:00Z',testIds:designationTestIds,requiredSafeguardTestId:safeguard}];
 const sourceHashes={};for(const path of ['scripts/test-postgres-integration.mjs','tests/group-designation-evidence.mjs','tests/group-designation-postgres.mjs']){const bytes=Buffer.from('fixture source\n');f.files.set(path,bytes);sourceHashes[path]=hash(bytes);}
 const sql=Buffer.from('select 1;\n'),migrations=['0001_control_plane.sql','0025_rule_governance.sql','0070_tenant_referential_integrity.sql','0156_group_designated_binding.sql'].map(name=>{f.files.set('services/control-api/migrations/'+name,sql);return {name,checksum_sha256:hash(sql)};});
 const startedAt='2026-09-11T00:00:00Z',finishedAt='2026-09-11T00:01:00Z';
 const formal=f.put('pg/postgres.json',{kind:'automated',gate:'postgres',status:'passed',exitCode:0,candidateSha:'sha',candidateTree:'tree',commands:[{argv:['pnpm','test:postgres']}],startedAt,completedAt:finishedAt,candidateState:{before:{sha:'sha',tree:'tree',clean:true},after:{sha:'sha',tree:'tree',clean:true}}});
 const proof={mode:'simulated',scope:'postgresql-invariant-only',lockOverlap:true,conflict:{code:'23505',constraint:'group_designated_binding_unique'},originalPreserved:true,independentScopes:['tenant','provider','group'],transition:['ACTIVE/PAUSED','PAUSED/PAUSED','PAUSED/ACTIVE']};
 const envelope=f.put('pg/envelope.json',{gate:{command:'pnpm test:postgres',exitCode:0,signal:null,completed:true,startedAt,finishedAt,formalManifestSha256:formal.sha256},receipt:{kind:'postgres-designation-proof',evidenceMode:'simulated',trackedWorktreeChanges:false,candidateSha:'sha',treeSha:'tree',sourceHashes,migrations,database:'isolated-fixture',results:designationTestIds.map(testId=>({testId,result:'passed',startedAt:'2026-09-11T00:00:01Z',finishedAt:'2026-09-11T00:00:02Z',proof}))}});
 const cleanup=f.put('pg/cleanup.json',{status:'PASS',database:'isolated-fixture',dropped:true,activeClientsBeforeDrop:0,envelopeSha256:envelope.sha256,formalManifestSha256:formal.sha256,finishedAt:'2026-09-11T00:01:01Z'});
 f.data.gates=[{id:'postgres',executions:[{id:'pg-execution',candidateId:'c',result:'passed',evidenceStatus:'complete',evidenceMode:'simulated',startedAt,finishedAt:'2026-09-11T00:02:00Z',evidence:[formal,envelope,cleanup].map(e=>({...e,originalSha:'sha',originalTree:'tree'}))}]}];
 f.rebind();f.manifest=generateAutomationCoverage(f.data,f.manifest,p=>f.files.get(p));
}

function signedFixture(change=()=>{}){const f=fixture(),root='output/release-evidence/sha/',coveragePath=root+'automation-coverage.json',govPath=root+'governance.json';change(f);const coverage=f.put(coveragePath,f.manifest);const artifact={path:coveragePath,digest:'sha256:'+coverage.sha256,files:1,bytes:f.files.get(coveragePath).length};const gov={kind:'automated',gate:'governance',status:'passed',candidateSha:'sha',candidateTree:'tree',supportingArtifacts:[artifact]};return{f,artifact,gov,coveragePath,govPath,async check(mutateGov=()=>{},mutateBinding=()=>{}){mutateGov(gov);const g=f.put(govPath,gov);const binding={path:coveragePath,digest:'sha256:'+coverage.sha256,governanceManifest:{path:govPath,digest:'sha256:'+g.sha256}};mutateBinding(binding);const bytes=Buffer.from(JSON.stringify({automationCoverage:binding}));const keys=generateKeyPairSync('ed25519'),signature=sign(null,bytes,keys.privateKey);assert(verify(null,bytes,keys.publicKey,signature));const authenticated=JSON.parse(bytes);return verifyAutomationBridge(authenticated.automationCoverage,{candidateSha:'sha',candidateTree:'tree',readRepository:async p=>f.files.get(p),artifactDigest:async()=>artifact,validateBaseline:()=>{}})}}}
test('signed observation binding reaches complete automation union',async()=>assert.equal((await signedFixture().check()).liveAcceptance,false));
test('signed binding rejects missing governance coverage attachment',async()=>assert.rejects(signedFixture().check(g=>g.supportingArtifacts=[]),/Missing\/duplicate/));
test('signed binding rejects duplicate governance coverage attachment',async()=>assert.rejects(signedFixture().check(g=>g.supportingArtifacts.push(g.supportingArtifacts[0])),/Missing\/duplicate/));
test('signed binding rejects mismatched coverage digest',async()=>assert.rejects(signedFixture().check(()=>{},b=>b.digest='sha256:'+'0'.repeat(64)),/Coverage digest/));
test('signed binding rejects coverage relabeled live',async()=>assert.rejects(signedFixture(f=>f.manifest.evidenceMode='live').check()));
test('signed binding rejects changed governance digest',async()=>assert.rejects(signedFixture().check(()=>{},b=>b.governanceManifest.digest='sha256:'+'0'.repeat(64)),/Governance digest/));
test('generation enumerates complete checks and rejects incomplete context',()=>{const f=fixture(),plan={...f.manifest};delete plan.checks;delete plan.requiredTestIds;assert.equal(generateAutomationCoverage(f.data,plan,p=>f.files.get(p)).checks.length,1);f.data.journeys[0].useCases[0].tests[0].executions=[];f.rebind();plan.baselineSha256=f.manifest.baselineSha256;assert.throws(()=>generateAutomationCoverage(f.data,plan,p=>f.files.get(p)),/Incomplete/)});

function addAbsentCollection(f){
 const t={id:'form::ui-quality::empty',requirementIds:['r'],steps:['Inspect'],expectedResults:['Collection empty'],requiredContextIds:['owner'],executions:[]};
 const source=f.put('form-source',{kind:'terminal-form'});t.applicability={status:'reviewed-not-applicable',reason:'Terminal form has no collection',reviewId:'applicability',source};
 f.data.reviews=[{id:'applicability',kind:'test-applicability-review',reviewer:'auditor',recordedAt:'2026-09-12T00:00:00Z',reason:'Source semantics',changes:[{testId:t.id,status:t.applicability.status,reason:t.applicability.reason,source,definitionSha256:hash(JSON.stringify({id:t.id,requirementIds:t.requirementIds,steps:t.steps,expectedResults:t.expectedResults}))}]}];
 f.data.journeys[0].useCases[0].tests.push(t);f.rebind();
 f.manifest=generateAutomationCoverage(f.data,f.manifest,p=>f.files.get(p));
}
test('generated signed coverage admits reviewed source and keeps N/A separate from passed checks',async()=>{
 const s=signedFixture(addAbsentCollection);assert.deepEqual(s.f.manifest.requiredTestIds,['t']);assert.equal(s.f.manifest.checks.length,1);assert.equal(s.f.manifest.notApplicableTests.length,1);
 assert.equal((await s.check()).requiredTests,1);
 s.f.files.set('form-source',Buffer.from('changed'));await assert.rejects(s.check(),/Changed applicability source/);
});
test('generated coverage rejects a deferred/N/A overlap',()=>{const f=fixture();addAbsentCollection(f);f.data.scope.testDeferrals=[{testIds:['form::ui-quality::empty']}];f.rebind();assert.throws(()=>generateAutomationCoverage(f.data,f.manifest,p=>f.files.get(p)),/overlap/)});

test('mandatory PostgreSQL obligations retain database boundary and exact signed evidence',async()=>{
 const s=signedFixture(addDesignation);const db=s.f.manifest.gateBackedAssertions.postgresDesignation;
 assert.deepEqual(db.results.map(r=>r.testId),designationTestIds);assert.equal(s.f.manifest.checks.length,1);
 for(const row of db.results)for(const key of ['contextId','actorRef','tenantRef','actualViewport','deploymentId'])assert(!Object.hasOwn(row,key));
 const summary=await s.check();assert.equal(summary.requiredTests,1);assert.equal(summary.requiredChecks,1);assert.equal(summary.mandatoryDatabaseAssertions,2);assert.equal(summary.totalMandatoryAssertions,3);
 s.f.files.set('pg/envelope.json',Buffer.from('{}'));await assert.rejects(s.check(),/Changed PostgreSQL evidence/);
});

test('PostgreSQL coverage fails closed on source, assertion, cleanup and candidate drift',()=>{
 for(const [name,mutate] of [
  ['source drift',f=>f.files.set('tests/group-designation-postgres.mjs',Buffer.from('changed'))],
  ['migration drift',f=>f.files.set('services/control-api/migrations/0156_group_designated_binding.sql',Buffer.from('changed'))],
  ['missing formal proof',f=>f.files.delete('pg/postgres.json')],
  ['false invariant',f=>{const p='pg/envelope.json',e=JSON.parse(f.files.get(p));e.receipt.results[0].proof.lockOverlap=false;f.data.gates[0].executions[0].evidence[1]= {...f.data.gates[0].executions[0].evidence[1],...f.put(p,e)};}],
  ['active cleanup clients',f=>{const p='pg/cleanup.json',e=JSON.parse(f.files.get(p));e.activeClientsBeforeDrop=1;f.data.gates[0].executions[0].evidence[2]={...f.data.gates[0].executions[0].evidence[2],...f.put(p,e)};}],
  ['wrong candidate',f=>{f.data.gates[0].executions[0].candidateId='other';}],
  ['changed IDs',f=>{f.data.scope.testDeferrals[0].testIds=[designationTestIds[0]];}],
  ['later gate failure',f=>{f.data.gates[0].executions.push({...f.data.gates[0].executions[0],id:'later',result:'failed'});}]
 ]){const f=fixture();addDesignation(f);mutate(f);f.manifest.baselineSha256=f.put('baseline',f.data).sha256;assert.throws(()=>verifyAutomationCoverage(f.data,f.manifest,p=>f.files.get(p)),undefined,name);}
});

test('signed PostgreSQL bridge refuses an evidence path absent from its gate',async()=>{
 const s=signedFixture(f=>{addDesignation(f);f.manifest.gateBackedAssertions.postgresDesignation.evidence[0].path='unlisted';});await assert.rejects(s.check(),/Unadmitted PostgreSQL evidence path/);
});

test('PostgreSQL generation rejects an omitted invariant or prerequisite even with valid receipt hashes',()=>{
 for(const name of ['0001_control_plane.sql','0025_rule_governance.sql','0070_tenant_referential_integrity.sql','0156_group_designated_binding.sql']){
  const f=fixture();addDesignation(f);const gate=f.data.gates[0].executions[0],envelope=JSON.parse(f.files.get('pg/envelope.json')),cleanup=JSON.parse(f.files.get('pg/cleanup.json'));
  envelope.receipt.migrations=envelope.receipt.migrations.filter(row=>row.name!==name);
  gate.evidence[1]={...gate.evidence[1],...f.put('pg/envelope.json',envelope)};cleanup.envelopeSha256=gate.evidence[1].sha256;
  gate.evidence[2]={...gate.evidence[2],...f.put('pg/cleanup.json',cleanup)};f.rebind();
  assert.throws(()=>generateAutomationCoverage(f.data,f.manifest,p=>f.files.get(p)),/Missing designation prerequisite migration/);
 }
});

test('unrelated test deferrals do not acquire a PostgreSQL obligation',()=>{
 const f=fixture();f.data.scope.testDeferrals=[{testIds:['unrelated']}];f.rebind();const manifest=generateAutomationCoverage(f.data,f.manifest,p=>f.files.get(p));assert.equal(manifest.gateBackedAssertions,undefined);
});
