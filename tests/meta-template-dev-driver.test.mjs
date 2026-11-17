// Source-level finite-driver regressions. These never count as installed DEV proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTemplateManifest,assertTemplateHistory,assertTemplateIntent,assertOriginalTemplateCopy} from '../scripts/release/meta-template-dev-contract.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,h='a'.repeat(64);
const manifest=()=>({mode:'happy',runId:'fixture',ownerId:id(1),p05b:{namespace:'p05b-fixture',case:'full',locale:'en',width:1440,role:'tenant_owner',actorId:id(1),sourceConnectionId:id(2),targetConnectionId:id(3),fixtureSha256:h,guestSha256:h,browserSha256:h,contractSha256:h,fixturePreparationReceiptSha256:h,disposableTenantReceiptSha256:h,sourceReviewSha256:h,uiReviewSha256:h,catalogSha256:h,flows:[{id:id(4),definitionSha256:h},{id:id(5),definitionSha256:h}],assignmentId:id(6),conversationId:id(7),selectedNames:['current_notice','pinned_notice'],targetName:'Synthetic target',runtime:{accountId:id(8),receiptId:id(9),descriptorSha256:h,transportBindingSha256:h,releaseEvidenceSha256:h,workerImageDigest:'sha256:'+h},database:{id:h,image:'sha256:'+h,service:'postgres',database:'wasalx',user:'wasalx'},dependencies:['B1','TEMPLATE_UI','ROOT_DRIVER','P07_DRIVER','P08_FINANCIAL'].map(name=>({name,sourceSha256:h,reviewSha256:h}))}});
test('template DEV mode cannot silently expand context, actor, asset or immutable fixture scope',()=>{
 assert.equal(validateTemplateManifest(manifest()).p05b.case,'full');
 for(const change of [m=>{m.mode='live';},m=>{m.p05b.role='admin';},m=>{m.p05b.actorId=id(90);},m=>{m.p05b.targetConnectionId=m.p05b.sourceConnectionId;},m=>{m.p05b.flows[1]=m.p05b.flows[0];},m=>{m.p05b.case='disconnect';m.p05b.locale='ar';},m=>{m.p05b.dependencies.pop();},m=>{m.p05b.fixturePreparationReceiptSha256='';}]){
  const m=manifest();change(m);assert.throws(()=>validateTemplateManifest(m),/P05B/u);
 }
});
test('operation correlation requires original key, action and revision, not revision growth alone',()=>{
 const intent={key:id(1),action:'RECONCILE',body:{expectedRevision:5}};
 const view={pendingAction:{requestKey:id(1),action:'RECONCILE',requestRevision:5,operationId:id(2)}};
 assert.equal(assertTemplateIntent(intent,view).operationId,id(2));
 for(const delta of [{requestKey:id(8)},{action:'COPY'},{requestRevision:6},{operationId:null}])assert.throws(()=>assertTemplateIntent(intent,{pendingAction:{...view.pendingAction,...delta}}),/CORRELATION/u);
});
test('later equivalent inventory cannot erase UNKNOWN original slot or add another provider POST',()=>{
 const original={plan:{transitionKind:'TEMPLATE_PREPARATION',executionState:'UNPREPARED',providerMigrationId:null,identitySuccessor:false},operations:[{id:id(4),observationOperationId:id(4),resultSha256:h}],checkpoints:[{id:id(1),stage:'TEMPLATE_COPY',operationId:id(2),requestSha256:h,outcome:'UNKNOWN'}],provider:{attempts:[{sequence:1,accepted:true}],targetSha256:h}};
 assertOriginalTemplateCopy(original,{outcome:'UNKNOWN'});
 assertTemplateHistory(original,{...structuredClone(original),provider:{...structuredClone(original.provider),targetSha256:'b'.repeat(64)}});
 for(const mutate of [x=>{x.provider.attempts.push({sequence:2,accepted:false});},x=>{x.checkpoints[0].outcome='SUCCEEDED';},x=>{x.operations[0].resultSha256='b'.repeat(64);},x=>{x.operations=[];}]){
  const next=structuredClone(original);mutate(next);assert.throws(()=>assertTemplateHistory(original,next),/P05B/u);
 }
});
