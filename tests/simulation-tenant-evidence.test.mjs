import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyTenantEvidence,bindTenantEvidenceRows} from '../scripts/release/simulation-owner-evidence.mjs';
import {runDirectConversationQuality,qualityIds} from '../scripts/release/simulation-direct-quality.mjs';
import {mergeBusinessPermissionRows,groupPermissionId,groupRuleRoleContextIds} from '../scripts/release/simulation-group-rule-role-contexts.mjs';
const hash=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const viewport={width:1440,height:1000};
const page=()=>({evaluate:async()=> 'en',viewportSize:()=>viewport});
const session={verifyOwner:async(p,id,role,tenant)=>{assert.equal(id,'product-user');assert.equal(tenant,'tenant');assert(['tenant_owner','tenant_admin','supervisor','agent','auditor'].includes(role));return{userMatched:true,workspaceMatched:true}}};
const row=role=>({testId:'test',contextId:role+'-en-desktop',result:'failed',startedAt:'2026-09-30T00:00:00Z',finishedAt:'2026-09-30T00:00:01Z',proof:{assertionFailed:true}});
test('all five tenant roles bind actual admitted identity, locale and viewport without changing failed outcomes',async()=>{
 for(const role of ['tenant_owner','tenant_admin','supervisor','agent','auditor']){
  const binding=await verifyTenantEvidence(session,page(),'product-user',role,'tenant','verified-subject');
  assert.equal(binding.actorRef,hash('verified-subject'));assert.equal(binding.tenantRef,hash('tenant'));assert.deepEqual(binding.viewport,viewport);
  const original=row(role),bound=bindTenantEvidenceRows([original],binding)[0];assert.equal(bound.result,'failed');assert.equal(bound.evidenceStatus,undefined);assert.equal(bound.startedAt,original.startedAt);assert.equal(bound.finishedAt,original.finishedAt);assert.equal(bound.proof.actorVerified,true);assert.equal(original.actorRef,undefined);
 }
});
test('role evidence rejects absent or contradictory identity, locale, viewport, context and time',async()=>{
 await assert.rejects(verifyTenantEvidence({...session,verifyOwner:async()=>({userMatched:false,workspaceMatched:true})},page(),'product-user','agent','tenant'));
 await assert.rejects(verifyTenantEvidence(session,{...page(),evaluate:async()=> 'ar'},'product-user','agent','tenant'));
 await assert.rejects(verifyTenantEvidence(session,page(),'product-user','platform_operator','tenant'));
 const binding=await verifyTenantEvidence(session,page(),'product-user','agent','tenant');
 for(const alter of [r=>r.contextId='tenant_admin-en-desktop',r=>r.actualViewport={width:820,height:1180},r=>r.actorRef=hash('different'),r=>r.startedAt='invalid',r=>r.finishedAt='2026-09-29T00:00:00Z']){const r=row('agent');alter(r);assert.throws(()=>bindTenantEvidenceRows([r],binding));}
});
test('direct quality retains failed assertion rows with the actual role at both observed viewports',async()=>{
 let actual=viewport;const p={viewportSize:()=>actual,setViewportSize:async v=>{actual=v},evaluate:async(fn,arg)=>arg?{items:[]}:'en',route:async()=>{},unroute:async()=>{},goto:async()=>{},getByRole:()=>({click:async()=>{}}),locator:()=>({waitFor:async()=>{}}),setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{}};
 const results=await runDirectConversationQuality({page:p,origin:'http://owned',checkpoint:async()=>{},verifyOwner:p=>verifyTenantEvidence(session,p,'product-user','agent','tenant','verified-subject'),readEffects:async()=>({effects:0}),output:'ignored',conversationId:'11111111-1111-4111-8111-111111111111',testIds:qualityIds().slice(0,8),role:'agent'});
 assert.equal(results.results.length,16);for(const r of results.results){assert.equal(r.result,'failed');assert.equal(r.actorRef,hash('verified-subject'));assert.equal(r.verifiedContext.role,'agent');assert.deepEqual(r.actualViewport,r.viewport);assert.equal(r.proof.actorVerified,true);assert.equal(r.evidenceStatus,undefined);}assert.deepEqual([...new Set(results.results.map(r=>r.actualViewport.width))],[1440,820]);assert.deepEqual(actual,viewport);
});
test('direct quality restores its incoming viewport after a failed provider-effect check without losing rows',async()=>{
 let actual={width:1280,height:900},reads=0;const incoming=actual,emitted=[],effectFailure=new Error('synthetic effect read failure');
 const p={viewportSize:()=>actual,setViewportSize:async v=>{actual=v},evaluate:async(fn,arg)=>arg?{items:[]}:'en',route:async()=>{},unroute:async()=>{},goto:async()=>{},getByRole:()=>({click:async()=>{}}),locator:()=>({waitFor:async()=>{}}),setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{}};
 await assert.rejects(runDirectConversationQuality({page:p,origin:'http://owned',checkpoint:async row=>{if(row.phase==='direct-quality')emitted.push(row);},verifyOwner:async()=>true,readEffects:async()=>{if(++reads===2)throw effectFailure;return{effects:0};},output:'ignored',conversationId:'11111111-1111-4111-8111-111111111111',testIds:qualityIds().slice(0,8)}),error=>error===effectFailure);
 assert.equal(reads,2);assert.equal(emitted.length,16);assert.deepEqual([...new Set(emitted.map(r=>r.viewport.width))],[1440,820]);assert.deepEqual(actual,incoming);
});
test('direct quality preserves observation and cleanup failures while attempting viewport restoration',async()=>{
 const incoming={width:1280,height:900},observation=new Error('observation'),unroute=new Error('unroute'),restore=new Error('restore');let actual=incoming,restorationAttempted=false;
 const p={viewportSize:()=>actual,setViewportSize:async value=>{if(value===incoming){restorationAttempted=true;throw restore;}actual=value;},route:async()=>{},unroute:async()=>{throw unroute;},setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{}};
 await assert.rejects(runDirectConversationQuality({page:p,origin:'http://owned',checkpoint:async()=>{},verifyOwner:async()=>{throw observation;},readEffects:async()=>({effects:0}),output:'ignored',conversationId:'11111111-1111-4111-8111-111111111111',testIds:qualityIds().slice(0,8)}),error=>{assert(error instanceof AggregateError);assert.deepEqual(error.errors,[observation,unroute,restore]);return true;});
 assert.equal(restorationAttempted,true);
});
test('combined business and permission proof requires both source actor verifications',()=>{
 const permission=groupRuleRoleContextIds.map(contextId=>({testId:groupPermissionId,contextId,result:'passed',startedAt:'2026-09-30T00:00:00Z',finishedAt:'2026-09-30T00:00:01Z',actorRef:hash('owner'),tenantRef:hash('tenant'),proof:{actorVerified:true}})),business={...permission[0],proof:{actorVerified:true,business:true}};
 assert.equal(mergeBusinessPermissionRows(business,permission,groupPermissionId)[0].proof.actorVerified,true);
 assert.equal(mergeBusinessPermissionRows({...business,proof:{business:true}},permission,groupPermissionId)[0].proof.actorVerified,false);assert.throws(()=>mergeBusinessPermissionRows({...business,actorRef:hash('different')},permission,groupPermissionId),/Composite owner actors differ/);
});

test('current mobile rows require actual verified mobile identity and viewport, with no desktop rebinding',async()=>{
 const mobile={width:390,height:844},mobilePage={...page(),viewportSize:()=>mobile},binding=await verifyTenantEvidence(session,mobilePage,'product-user','agent','tenant','verified-subject');
 const original={...row('agent'),contextId:'agent-en-mobile',actualViewport:mobile,proof:{assertionFailed:true,viewport:mobile}},bound=bindTenantEvidenceRows([original],binding)[0];
 assert.equal(bound.result,'failed');assert.equal(bound.actorRef,hash('verified-subject'));assert.equal(bound.tenantRef,hash('tenant'));assert.deepEqual(bound.actualViewport,mobile);assert.equal(bound.proof.actorVerified,true);
 const desktop=await verifyTenantEvidence(session,page(),'product-user','agent','tenant');assert.throws(()=>bindTenantEvidenceRows([original],desktop),/actual observed viewport/u);
 assert.throws(()=>bindTenantEvidenceRows([{...original,actualViewport:{width:390,height:800}}],binding),/Contradictory observed viewport/u);
 assert.throws(()=>bindTenantEvidenceRows([{...original,contextId:'tenant_owner-en-mobile'}],binding),/verified tenant role/u);
 assert.throws(()=>bindTenantEvidenceRows([{...original,contextId:'agent-ar-mobile'}],binding),/verified tenant role/u);
 await assert.rejects(verifyTenantEvidence({...session,verifyOwner:async()=>({userMatched:true,workspaceMatched:false})},mobilePage,'product-user','agent','tenant'));
});
