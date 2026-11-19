import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAnonymousSessionQuality, mapSessionQuality, tenantSessionRoles } from '../scripts/release/simulation-session-contexts.mjs';
import {sessionQualityChecks} from "../scripts/release/simulation-session-quality-stage.mjs";
import { definitions } from '../scripts/release/simulation-session-remaining-definitions.mjs';
import { assertPlatformStoredSession } from '../scripts/release/simulation-platform-auth.mjs';
import { stageResult } from '../scripts/release/simulation-manifest.mjs';

const viewports={desktop:{width:1440,height:1000},tablet:{width:820,height:1180},mobile:{width:390,height:844}};
const sha=value=>'sha256:'+value.repeat(64),ids=definitions.map(row=>row.id);
const sourceSuffix=id=>{const value=id.split('::').at(-1);return value==='safe-error-recovery'?'degraded':value;};
const checksFor=contexts=>contexts.flatMap(contextId=>ids.map(testId=>({testId,contextId})));
const executed=tenantSessionRoles.flatMap(role=>['desktop','tablet'].map(view=>role+'-en-'+view));
function observation(contextId,suffix,result='passed'){
 const view=contextId.split('-').at(-1),owner=contextId.startsWith('tenant_owner-');
 return{testId:'navigation/source::ui-quality::'+suffix,suffix,result,proof:{suffix},contextId,tenantId:'tenant',startedAt:'2026-09-20T00:00:00Z',finishedAt:'2026-09-20T00:00:01Z',actualViewport:viewports[view],...(owner?{actorBinding:{userMatched:true,workspaceMatched:true}}:{actorRef:sha('a'),tenantRef:sha('b')})};
}
const navigation=contexts=>({evidenceMode:'simulated',namespace:'now',tenantId:'tenant',sessionObservations:contexts.flatMap(contextId=>[...new Set(ids.map(sourceSuffix))].map(suffix=>observation(contextId,suffix)))});
const anonymousInput=contexts=>({evidenceMode:'simulated',namespace:'now',tenantId:'tenant',noNewEmail:true,results:contexts.flatMap(contextId=>ids.map(id=>{const suffix=id.split('::').at(-1);return{testId:'identity-access/invitation-acceptance-and-expiry::ui-quality::'+suffix,result:suffix==='network'?'failed':'passed',contextId,actualViewport:viewports[contextId.split('-').at(-1)],actorRef:null,tenantRef:null,startedAt:'2026-09-20T00:00:00Z',finishedAt:'2026-09-20T00:00:01Z',proof:{suffix}};}))});
const map=(input,checks)=>mapSessionQuality(input,{namespace:'now',tenantId:'tenant',checks});

test('session mapping follows exact selected checks and keeps selected mobile not executed',()=>{
 const selected=checksFor([...executed,'tenant_owner-en-mobile','agent-en-mobile']),{results,notExecuted}=map(navigation(executed),selected);
 assert.equal(results.length,executed.length*ids.length);
 assert.deepEqual([...new Set(notExecuted.map(row=>row.contextId))].sort(),['agent-en-mobile','tenant_owner-en-mobile']);assert.equal(notExecuted.length,2*ids.length);
 assert(results.every(row=>row.actualViewport.width===(row.contextId.endsWith('-tablet')?820:1440)));
 assert.equal(stageResult({testIds:ids,checks:selected},{results}).status,'incomplete');
});
test('observed mobile maps at its actual viewport; unselected observations make no claim',()=>{
 const {results,notExecuted}=map(navigation([...executed,'agent-en-mobile']),checksFor(['agent-en-mobile']));
 assert.deepEqual([...new Set(results.map(row=>row.contextId))],['agent-en-mobile']);assert(results.every(row=>row.actualViewport.width===390));assert.equal(notExecuted.length,0);
 assert.deepEqual(stageResult({testIds:ids,checks:checksFor(['agent-en-mobile'])},{results}),{status:'passed',counts:{passed:ids.length,failed:0,blocked:0,unknown:0},missing:[]});
});
test('failed source rows remain failed and sibling contexts still map',()=>{
 const input=navigation(executed),failed=input.sessionObservations.find(row=>row.contextId==='agent-en-tablet'&&row.suffix==='keyboard-focus');failed.result='failed';failed.proof={errorClass:'AssertionError',messageSha256:'a'.repeat(64)};
 const {results}=map(input,checksFor(executed)),projected=results.find(row=>row.contextId==='agent-en-tablet'&&row.testId.endsWith('::keyboard-focus'));
 assert.equal(projected.result,'failed');assert.deepEqual(projected.proof,failed.proof);assert.equal(stageResult({testIds:ids,checks:checksFor(executed)},{results}).status,'failed');
});
test('mixed identity, wrong viewport, unknown, duplicate or absent selected checks fail closed',()=>{
 const bad=navigation(executed);bad.sessionObservations.find(row=>row.contextId==='agent-en-desktop').actorRef='raw';assert.throws(()=>map(bad,checksFor(['agent-en-desktop'])));
 const wide=navigation(['agent-en-mobile']);for(const row of wide.sessionObservations)row.actualViewport=viewports.desktop;assert.throws(()=>map(wide,checksFor(['agent-en-mobile'])));
 assert.throws(()=>map(navigation(executed),[{testId:'other::x',contextId:'agent-en-desktop'}]),/Unexpected session check/);
 const dup=checksFor(['agent-en-desktop']);assert.throws(()=>map(navigation(executed),[...dup,dup[0]]),/Duplicate/);
 assert.throws(()=>map(navigation(executed),undefined),/Exact selected session checks required/);
});
test('anonymous rows reuse exact allocated invitation observations including mobile and never synthesize absent ones',()=>{
 const selected=checksFor(['anonymous-en-desktop','anonymous-en-mobile','anonymous-en-tablet']),{results,notExecuted}=mapAnonymousSessionQuality(anonymousInput(['anonymous-en-desktop','anonymous-en-mobile']),{namespace:'now',tenantId:'tenant',checks:selected});
 assert.equal(results.length,2*ids.length);assert(results.every(row=>row.actorRef===null&&row.tenantRef===null&&row.supportingSourceTestIds.length===1));
 assert.deepEqual(results.filter(row=>row.contextId==='anonymous-en-mobile').map(row=>row.actualViewport.width),Array(ids.length).fill(390));
 assert.equal(results.find(row=>row.testId.endsWith('::network')).result,'failed');assert.deepEqual([...new Set(notExecuted.map(row=>row.contextId))],['anonymous-en-tablet']);
 assert.throws(()=>mapAnonymousSessionQuality({...anonymousInput(['anonymous-en-desktop']),noNewEmail:false},{namespace:'now',tenantId:'tenant',checks:checksFor(['anonymous-en-desktop'])}));
 const leaked=anonymousInput(['anonymous-en-desktop']);leaked.results[0].actorRef=sha('a');assert.throws(()=>mapAnonymousSessionQuality(leaked,{namespace:'now',tenantId:'tenant',checks:checksFor(['anonymous-en-desktop'])}));
});
test('session stage without contextual checks keeps the original owner-desktop obligation',()=>{
 assert.deepEqual(sessionQualityChecks(undefined),ids.map(testId=>({testId,contextId:'tenant_owner-en-desktop'})));const selected=checksFor(['agent-en-mobile']);assert.equal(sessionQualityChecks(selected),selected);
});
test('platform identity proof requires the browser stored-session subject',()=>{const expected='11111111-1111-4111-8111-111111111111',proof=assertPlatformStoredSession(JSON.stringify({subject:expected,accessToken:'private'}),expected);assert.equal(proof.role,'platform_operator');assert.equal(proof.realm,'wasalx-platform');assert.equal(proof.tenantRef,null);assert.throws(()=>assertPlatformStoredSession(JSON.stringify({subject:'22222222-2222-4222-8222-222222222222'}),expected),/subject mismatch/);});
