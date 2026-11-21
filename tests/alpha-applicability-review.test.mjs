import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {reviewedNonApplicable} from '../scripts/release/automation-coverage.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fixture=()=>{const t={id:'identity::ui-quality::empty',requirementIds:['r'],steps:['Read collection'],expectedResults:['No matching records'],applicability:{status:'reviewed-not-applicable',reason:'No records collection exists',reviewId:'review',source:{path:'form.tsx',sha256:hash('form')}}};return {journeys:[{useCases:[{tests:[t]}]}],issues:[],reviews:[{id:'review',kind:'test-applicability-review',reviewer:'reviewer',recordedAt:'2026-09-12T00:00:00Z',reason:'Source semantic review',changes:[{testId:t.id,status:t.applicability.status,reason:t.applicability.reason,source:t.applicability.source,definitionSha256:hash(JSON.stringify({id:t.id,requirementIds:t.requirementIds,steps:t.steps,expectedResults:t.expectedResults}))}]}]};};
test('reviewed absent collection is separate N/A, never PASS',()=>{assert.equal(reviewedNonApplicable(fixture(),()=>Buffer.from('form'))[0].status,'not-applicable');});
test('source review ignores checkout line-ending conversion',()=>{const b=fixture(),source='first\nsecond\n';b.journeys[0].useCases[0].tests[0].applicability.source.sha256=hash(source);b.reviews[0].changes[0].source.sha256=hash(source);assert.doesNotThrow(()=>reviewedNonApplicable(b,()=>Buffer.from(source.replaceAll('\n','\r\n'))));});
for(const [name,mutate]of Object.entries({unreviewed:b=>b.reviews=[],changedDefinition:b=>b.journeys[0].useCases[0].tests[0].expectedResults=['Changed'],hiddenDefect:b=>b.issues.push({type:'defect',status:'open',affectedTestIds:['identity::ui-quality::empty']})}))test('reject '+name,()=>{const b=fixture();mutate(b);assert.throws(()=>reviewedNonApplicable(b,()=>Buffer.from('form')));});
test('changed source invalidates disposition',()=>assert.throws(()=>reviewedNonApplicable(fixture(),()=>Buffer.from('changed'))));

import {report} from '../scripts/release/alpha-test-baseline.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('actual report separates reviewed N/A and rejects double subtraction',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wasalx-applicability-'));
 try{
  const b=fixture(),t=b.journeys[0].useCases[0].tests[0],source=join(dir,'form.tsx');writeFileSync(source,'form');t.applicability.source.path=source;
  const at='2026-09-12T00:00:00Z';Object.assign(t,{title:'Empty collection',nextAction:'Reviewed',preconditions:['Source available'],requiredContextIds:['owner'],executions:[]});
  Object.assign(b,{schemaVersion:1,updatedAt:at,scope:{mandatoryJourneyIds:['j']},candidates:[{id:'c',commitSha:'a'.repeat(40),treeSha:'b'.repeat(40)}],deployments:[{id:'d',candidateId:'c',evidenceMode:'simulated'}],contexts:[{id:'owner',role:'owner'}],gates:[]});b.journeys[0].id='j';b.journeys[0].useCases[0].id='u';
  b.journeys[0].useCases[0].tests.push({...structuredClone(t),id:'applicable',applicability:undefined});
  const result=report(b,'c','d');assert.equal(result.tests,2);assert.equal(result.requiredTests,1);assert.equal(result.requiredChecks,1);assert.equal(result.notApplicableTests.length,1);assert.equal(result.counts.passed,0);assert.equal(result.counts['not-run'],1);
  b.scope.testDeferrals=[{id:'defer',releaseProfile:'first-client-alpha-live',reason:'Fixture',approval:{source:'fixture',recordedAt:at},testIds:[t.id]}];assert.throws(()=>report(b,'c','d'),/overlap/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
