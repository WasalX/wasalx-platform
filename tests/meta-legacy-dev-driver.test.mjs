import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLegacyOriginal,assertLegacyIntent,assertLegacySuccessor,assertLegacyPreserved,assertLegacyPrivacy,assertLegacyContinuation,legacyExpectedBody,sha,legacyMode} from '../scripts/release/meta-legacy-dev-contract.mjs';
const id=n=>'77000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash='a'.repeat(64);
const row=()=>({provider:{evidenceClass:'simulated-provider-legacy-migration',claim:'SYNTHETIC_LEGACY_SAME_PHONE',attempts:[{sequence:1}]},checkpoints:[{stage:'LEGACY_REGISTER',original_operation_id:id(1),request_sha256:hash,outcome:'UNKNOWN'}]});
test('original UNKNOWN never becomes success from target appearance or another control call',()=>{
 const actual=row();assertLegacyOriginal(actual,{outcome:'UNKNOWN'});assert.throws(()=>assertLegacyOriginal(actual,{outcome:'SUCCEEDED'}));
 assert.throws(()=>assertLegacyOriginal({...actual,provider:{...actual.provider,attempts:[{},{}]}},{outcome:'UNKNOWN'}));
 assert.throws(()=>assertLegacyOriginal({...actual,checkpoints:[]},{outcome:'UNKNOWN'}));
 assert.equal(legacyMode('disconnect'),'DISCONNECT');assert.equal(legacyMode('malformed'),'MALFORMED');assert.equal(legacyMode('register-loss'),'ACCEPT');
});
test('local original-key action correlation does not accept newer or foreign operations',()=>{
 const original={key:id(1),action:'REGISTER',body:{expectedRevision:3}},pendingAction={operationId:id(2),requestKey:id(1),action:'REGISTER',requestRevision:3};
 assertLegacyIntent(original,{pendingAction});for(const patch of [{requestKey:id(8)},{action:'OBSERVE'},{requestRevision:4},{operationId:null}])assert.throws(()=>assertLegacyIntent(original,{pendingAction:{...pendingAction,...patch}}));
});
test('typed known-success successor requires held paused lineage and no copied activation',()=>{
 const m={p05b:{sourceConnectionId:id(3)},p05bLegacy:{sourceBindingId:id(4),sourceSessionId:id(5),targetAccountId:id(6)}};
 const actual={...row(),plan:{id:id(7),transition_kind:'LEGACY_PHONE',legacy_state:'RECONCILED_PAUSED',execution_state:'RECONCILED_PAUSED',identity_claim:'SAME_GRAPH_PHONE_LEGACY_SUCCESSOR',legacy_readback_operation_id:id(8),legacy_authorization_operation_id:id(9)},checkpoints:[{...row().checkpoints[0],outcome:'SUCCEEDED'}],bindings:[{id:id(4),state:'RETIRED',provider_session_id:id(5),phone_number_id:'12345'},{id:id(10),connection_id:id(3),state:'HELD',account_id:id(6),predecessor_binding_id:id(4),account_transition_id:id(7),template_mapping_operation_id:id(8),provider_session_id:id(11),phone_number_id:'12345'}],sessions:[{id:id(5),ownership_state:'RETIRED'},{id:id(11),ownership_state:'ACTIVE',state:'PAUSED'}],connection:{state:'PAUSED'},reservations:[{released_at:'2026-10-08T00:00:00Z',release_reason:'VERIFIED_SUCCESSOR'},{released_at:'2026-10-08T00:00:00Z',release_reason:'VERIFIED_SUCCESSOR'}],operations:[{id:id(8),state:'SUCCEEDED',identityStatus:'SETTLED',targetAssetCount:1,authorizationOperationId:id(9)}]};
 assert.equal(assertLegacySuccessor(actual,m).id,id(10));
 for(const patch of [{connection:{state:'WORKING'}},{reservations:[{released_at:null}]},{checkpoints:row().checkpoints},{sessions:[{id:id(5),ownership_state:'ACTIVE'}]}])assert.throws(()=>assertLegacySuccessor({...actual,...patch},m));
});
test('old immutable definition, template observations and history remain exact',()=>{
 const before={effects:{receiptCount:1,mediaCount:0,subscribed:true,sha256:hash},history:{message_links:{count:1,sha256:hash}},template:{flows:[{id:id(1),definitionSha256:hash,state:'ACTIVE'}],operations:[{id:id(2),observationOperationId:id(2)}],checkpoints:[]}};
 const after=structuredClone(before);after.template.flows[0].state='RETIRED';assertLegacyPreserved(before,after);
 const sent=structuredClone(after);sent.effects.receiptCount++;assert.throws(()=>assertLegacyPreserved(before,sent));
 after.template.flows[0].definitionSha256='b'.repeat(64);assert.throws(()=>assertLegacyPreserved(before,after));
});

function privacyRows(){
 const common={state:'SUCCEEDED',key:id(40),actorType:'USER',actorId:id(41),payloadSha256:hash,resultSha256:'b'.repeat(64),resultWasNull:false};
 const before={...row(),effects:{receiptCount:0,mediaCount:0,sha256:hash},template:{privacy:[]},privacyEvidence:{scopeSha256:'c'.repeat(64),scopeRedacted:false,scopeRetainedSha256:null,operations:[{...common,id:id(42),kind:'legacy'},{...common,id:id(43),kind:'authorization',authSha256:'d'.repeat(64)}]}};
 const after=structuredClone(before);after.template.privacy=[{id:id(44),state:'RUNNING',stage:'LOCAL'}];after.privacyEvidence.scopeRedacted=true;after.privacyEvidence.scopeRetainedSha256=before.privacyEvidence.scopeSha256;
 Object.assign(after.privacyEvidence.operations[0],{payloadRedacted:true,payloadRetainedSha256:hash,resultRedacted:true,resultRetainedSha256:'b'.repeat(64)});
 Object.assign(after.privacyEvidence.operations[1],{authRedacted:true,authRetainedSha256:'d'.repeat(64)});return{before,after};
}
test('known privacy requires every exact historical operation and original content digest',()=>{
 const {before,after}=privacyRows();assertLegacyPrivacy(before,after);
 for(const change of [x=>x.privacyEvidence.operations.pop(),x=>x.privacyEvidence.operations[0].payloadRetainedSha256='0'.repeat(64),x=>x.privacyEvidence.operations[1].actorId=id(90),x=>x.privacyEvidence.operations[1].authRedacted=false,x=>x.checkpoints=[]]){const bad=structuredClone(after);change(bad);assert.throws(()=>assertLegacyPrivacy(before,bad));}
});
test('unresolved registration privacy keeps all original bytes and cannot claim erased',()=>{
 const {before}=privacyRows(),after=structuredClone(before);after.template.privacy=[{id:id(50),state:'FAILED_TERMINAL',stage:'LOCAL',errorCode:'PRIVACY_EXTERNAL_EFFECT_UNRESOLVED'}];assertLegacyPrivacy(before,after,{unknown:true});
 const changed=structuredClone(after);changed.privacyEvidence.operations[0].payloadSha256='0'.repeat(64);assert.throws(()=>assertLegacyPrivacy(before,changed,{unknown:true}));
 const falseSuccess=structuredClone(after);falseSuccess.template.privacy[0].state='SUCCEEDED';assert.throws(()=>assertLegacyPrivacy(before,falseSuccess,{unknown:true}));
});
test('continuation needs a fresh admitted target read, actual send and retained old history',()=>{
 const m={p05b:{flows:[{id:id(1)}]},p05bLegacy:{planId:id(2),successorBindingId:id(3),continuation:{recipient:'15550001000',templateName:'synthetic_update',languageCode:'en',bodyParameters:['Synthetic continuation']}}};
 const base={...row(),plan:{legacy_readback_operation_id:id(4)},template:{flows:[{id:id(1),definitionSha256:hash}],checkpoints:[]},effects:{receiptCount:1,mediaCount:0},historyMembers:{message_links:[{id:id(5),sha256:hash}]}};
 const bodySha=sha(JSON.stringify(legacyExpectedBody(m))),inbound={timestamp:1800000000};
 const after={...structuredClone(base),provider:{...base.provider,targetAccountId:'10001'},connection:{state:'WORKING'},bindings:[{id:id(3),state:'ACTIVE'}],effects:{receiptCount:2,mediaCount:0},continuation:{delivery:{id:id(6),attempt_id:id(7),state:'SENT',attempts:1,lease_id:null,external_message_id:'wamid.SIM0001',meta_template_admission:{claim:'CURRENT_INHERITED_TEMPLATE',bindingId:id(3),transitionId:id(2),mappingOperationId:id(4),deliveryId:id(6),attemptId:id(7),attemptNumber:1,inventoryResponseSha256:hash,contextSha256:hash,semanticSha256:hash,requestSha256:bodySha,observedAt:new Date(inbound.timestamp*1000+1).toISOString()}},templateReads:[{account:'10001',at:inbound.timestamp*1000+1}],receipts:[{id:'wamid.SIM0001',bodySha256:bodySha}],handoff:{state:'SUCCEEDED',flow_version_id:id(1)}}};
 assertLegacyContinuation(base,after,m,inbound);
 for(const change of [x=>x.continuation.templateReads=[],x=>x.continuation.delivery.meta_template_admission.bindingId=id(9),x=>x.continuation.receipts[0].bodySha256='f'.repeat(64),x=>x.historyMembers.message_links=[],x=>x.continuation.handoff=null]){const bad=structuredClone(after);change(bad);assert.throws(()=>assertLegacyContinuation(base,bad,m,inbound));}
});
