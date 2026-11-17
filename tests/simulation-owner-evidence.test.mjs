import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnerEvidence,bindOwnerEvidenceRows,withOwnerEvidence} from '../scripts/release/simulation-owner-evidence.mjs';
const at='2026-10-01T00:00:00.000Z',viewport={width:1440,height:1000};
const row=(result='passed')=>({testId:'owner-leaf',contextId:'tenant_owner-en-desktop',result,startedAt:at,finishedAt:at,proof:{actualRead:200}});
function session(){const calls=[],page={evaluate:async()=> 'en',viewportSize:()=>({...viewport})};return {ownerPage:page,ownerId:'owner',tenantId:'tenant',calls,verifyOwner:async(p,id,role,tenantId)=>{calls.push({p,id,role,tenantId});return{userMatched:true,workspaceMatched:true}}};}
test('bounded owner execution retains failed outcome/windows and binds verified actual identity and viewport',async()=>{
 const s=session(),source={results:[],proofs:[{status:'readback'}]};const result=await withOwnerEvidence(s,async()=>{const now=new Date().toISOString();source.results=[row(),row('failed')].map(r=>({...r,startedAt:now,finishedAt:now}));return source;});
 assert.equal(s.calls.length,2);for(const call of s.calls){assert.equal(call.p,s.ownerPage);assert.equal(call.id,'owner');assert.equal(call.role,'tenant_owner');assert.equal(call.tenantId,'tenant');}
 assert.deepEqual(result.results.map(x=>x.result),['passed','failed']);assert(result.results.every(x=>x.startedAt===source.results[0].startedAt&&x.finishedAt===source.results[0].finishedAt&&x.proof.actorVerified));assert(result.results.every(x=>!Object.hasOwn(x,'evidenceStatus')));assert.equal(source.results[0].actorRef,undefined);assert.deepEqual(result.results[0].actualViewport,viewport);assert.equal(result.proofs[0],source.proofs[0]);
});
test('isolation owner uses actual separate actor and tenant rather than identical owner context label',async()=>{
 const s=session(),primary=await verifyOwnerEvidence(s),isolation=await verifyOwnerEvidence(s,s.ownerPage,'isolation-owner','isolation-tenant');
 const p=bindOwnerEvidenceRows([row()],primary)[0],i=bindOwnerEvidenceRows([row()],isolation)[0];assert.equal(p.contextId,i.contextId);assert.notEqual(p.actorRef,i.actorRef);assert.notEqual(p.tenantRef,i.tenantRef);assert.equal(i.verifiedContext.tenantRef,i.tenantRef);
});
test('contradictory preexisting actor, viewport, role, and malformed assertion windows fail closed',async()=>{
 const binding=await verifyOwnerEvidence(session());
 for(const modified of [{...row(),actorRef:'sha256:'+'0'.repeat(64)},{...row(),actualViewport:{width:820,height:1180}},{...row(),proof:{viewport:{width:390,height:844}}},{...row(),contextId:'agent-en-desktop'},{...row(),startedAt:'bad'}])assert.throws(()=>bindOwnerEvidenceRows([modified],binding));
});
test('unverified identity and unexpected actual document locale cannot create a binding',async()=>{
 const s=session();s.verifyOwner=async()=>({userMatched:false,workspaceMatched:true});await assert.rejects(()=>verifyOwnerEvidence(s));s.verifyOwner=async()=>({userMatched:true,workspaceMatched:true});s.ownerPage.evaluate=async()=> 'ar';await assert.rejects(()=>verifyOwnerEvidence(s));
});
test('changed viewport across single-owner operation is rejected; unexecuted upstream row remains untouched',async()=>{
 const s=session();await assert.rejects(()=>withOwnerEvidence(s,async()=>{s.ownerPage.viewportSize=()=>({width:820,height:1180});return{results:[row()]}}),/context changed/);
 const clean=session(),blocked={testId:'blocked-leaf',result:'blocked',startedAt:at,finishedAt:at,proof:{upstreamResult:'failed'}};const out=await withOwnerEvidence(clean,async()=>({results:[blocked]}));assert.equal(out.results[0],blocked);assert(!out.results[0].verifiedContext);
});

test('historical database rows are never relabeled as current owner assertions',async()=>{const s=session();await assert.rejects(()=>withOwnerEvidence(s,async()=>({proofs:[row()]})),/outside verified owner operation window/);});

test('mixed operation leaves native evidence untouched while binding current owner rows',async()=>{
 const s=session(),native={...row(),contextId:'zammad_agent-en-mobile',actualViewport:{width:390,height:844},proof:{nativeObservation:true}};
 const result=await withOwnerEvidence(s,async()=>{const now=new Date().toISOString();return{results:[{...row(),startedAt:now,finishedAt:now},native]}});
 assert(result.results[0].proof.actorVerified);assert.equal(result.results[1],native);assert(!native.verifiedContext);
});
