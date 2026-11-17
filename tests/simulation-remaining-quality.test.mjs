import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnedWorkflowDraft} from '../scripts/release/simulation-workflow-draft-stage.mjs';
import {definitions} from '../scripts/release/simulation-remaining-quality-definitions.mjs';
import {definitions as covered} from '../scripts/release/simulation-shared-readonly-definitions.mjs';
test('owned draft intent precedes clone and immutable source readback is preserved',async()=>{
 const sourceId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',events=[];const source={id:sourceId,state:'ACTIVE',definition:{name:'Existing',nodes:[]}};let draft;
 const request=async(path,method='GET',body,step)=>{if(method==='POST'){assert.equal(events[0].phase,'workflow-draft-producer-intent');assert.equal(path,`/api/bot-flows/${sourceId}/clone`);assert.equal(step,'quality-owned-draft');draft={id,state:'DRAFT',version:3,definition:body};return draft;}return path.endsWith(sourceId)?structuredClone(source):draft;};
 const result=await createOwnedWorkflowDraft({request,checkpoint:async e=>events.push(e),sourceId,namespace:'fresh',tenantId:'tenant'});assert.equal(result.draftVersionId,id);assert.equal(result.namespace,'fresh');assert.equal(source.definition.name,'Existing');assert.equal(events.at(-1).phase,'workflow-draft-produced');
});
test('uncertain clone does not retry or create another draft',async()=>{
 let posts=0;const request=async(_,method='GET')=>{if(method==='POST'){posts++;throw Error('Timeout');}return{state:'ACTIVE',definition:{name:'Existing'}};};
 await assert.rejects(createOwnedWorkflowDraft({request,checkpoint:async()=>{},sourceId:'11111111-1111-4111-8111-111111111111',namespace:'fresh',tenantId:'tenant'}),/Timeout/);assert.equal(posts,1);
});
test('25 definitions extend existing13 without duplicate requirements',()=>{assert.equal(definitions.length,25);assert.equal(covered.length,13);const ids=[...definitions,...covered].map(t=>t.id);assert.equal(new Set(ids).size,38);assert(definitions.every(t=>t.expectedResults.length));});
import {waitForExactGet} from '../scripts/release/simulation-remaining-quality.mjs';
import {blockedWorkflowLifecycle} from '../scripts/release/simulation-remaining-quality-stage.mjs';
import {readFileSync} from 'node:fs';
test('exact GET timeout is removed after success and timeout',async()=>{let cleared=0;const token={};await waitForExactGet(Promise.resolve(),{setTimer:()=>token,clearTimer:t=>{assert.equal(t,token);cleared++;}});assert.equal(cleared,1);await assert.rejects(waitForExactGet(new Promise(()=>{}),{timeoutMs:1}),/Exact GET not observed/);});
test('single25-check consumer owns fixture setup and verifies retained UNKNOWN in finally',()=>{const s=readFileSync('scripts/release/simulation-remaining-quality-stage.mjs','utf8');assert(s.includes('await workflowDraftStage(session,args)'));assert(s.includes("session.operatorSurface==='portal'?portalUnknownReviewFixtureStage:unknownReviewFixtureStage"));assert(s.includes('finally {await guard.verifyReadOnly();}'));const b=readFileSync('scripts/release/build-selected-simulation-manifest.mjs','utf8');assert(!b.includes("add('workflow-draft'"));assert(b.indexOf("add('email-teardown'")<b.indexOf("add('remaining-quality'"));});
test('failed workflow view blocks all dependent lifecycle leaves without running writes',async()=>{const checkpoints=[],result=await blockedWorkflowLifecycle({tenantId:'tenant',checkpoint:async row=>checkpoints.push(row)},'q06v','view-01');assert.equal(result.proofs.length,3);assert(result.proofs.every(x=>x.result==='blocked'&&x.proof.dependencyTestId==='view-01'));assert.equal(checkpoints.length,3);});

test('remaining keyboard check records ordered phases and only an allowlisted failure boundary',()=>{
 const source=readFileSync(new URL('../scripts/release/simulation-remaining-quality.mjs',import.meta.url),'utf8');
 const phases=['restore-normal-page','read-studio-catalog','find-retained-draft','open-draft','wait-review-trigger','resolve-trigger','reach-trigger-by-tab','activate-trigger-with-enter','wait-dialog','assert-dialog-order','assert-visible-focus','escape-dialog','wait-dialog-hidden','verify-trigger-focus-return'];
 const positions=phases.map(phase=>source.indexOf("keyboardPhase='"+phase+"'"));assert(positions.every(position=>position>=0),'Missing keyboard phase');assert.deepEqual([...positions].sort((a,b)=>a-b),positions,'Keyboard phases out of order');
 assert(source.includes("()=>({diagnosticPhase:keyboardPhase,diagnosticBoundary:'simulation-remaining-quality:keyboard-focus'})"));
 assert(source.includes("...privateErrorSummary(e,new Map()),...diagnostic()"));assert(!source.includes('messageSha256:digest(e.message)'));
});
