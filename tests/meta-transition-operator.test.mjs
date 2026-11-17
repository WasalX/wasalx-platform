import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMetaTransitionOperatorRequest} from '../packages/core/dist/meta-transition-operator-contract.js';
const base={expectedRevision:1,expectedReviewSha256:'a'.repeat(64),evidenceSha256:'b'.repeat(64),confirmed:true};
test('operator review parser separates evidence inputs from derived account authority',()=>{
 assert.deepEqual(parseMetaTransitionOperatorRequest('PREREQUISITES',{...base,sourcePayment:'CARD'}),{...base,sourcePayment:'CARD'});
 assert.deepEqual(parseMetaTransitionOperatorRequest('TARGET',{...base,templateEvidenceSha256:'c'.repeat(64),flowEvidenceSha256:'d'.repeat(64)}),
  {...base,templateEvidenceSha256:'c'.repeat(64),flowEvidenceSha256:'d'.repeat(64)});
 assert.deepEqual(parseMetaTransitionOperatorRequest('COMPLETION',base),base);
 for(const body of [{...base,providerAccountId:'123'},{...base,observerOperationId:'123'},{...base,expiresAt:'future'},
  {...base,confirmed:'true'},{...base,expectedRevision:1.1},{...base,expectedRevision:'1'},{...base,evidenceSha256:'A'.repeat(64)},null,[]]){
  assert.equal(parseMetaTransitionOperatorRequest('COMPLETION',body),null);
 }
 assert.equal(parseMetaTransitionOperatorRequest('PREREQUISITES',base),null);
 assert.equal(parseMetaTransitionOperatorRequest('TARGET',base),null);
});
test('managed target receiver and terms are explicit and bounded without caller line or app IDs',()=>{
 const managed={arrangementVersionId:'10000000-0000-4000-8000-000000000001',targetReceivingBusinessId:'123456789',targetTermsDocumentText:'Reviewed target terms',targetTermsVersion:'v1'};
 const input={...base,sourcePayment:'LINE',managed};assert.deepEqual(parseMetaTransitionOperatorRequest('PREREQUISITES',input),input);
 const mixed={...input,managed:{...managed,arrangementVersionId:'AbCdEf12-aBcD-4AbC-8DeF-aBcDeF123456'}};
 assert.deepEqual(parseMetaTransitionOperatorRequest('PREREQUISITES',mixed),mixed,'Exact submitted UUID case remains in the original intent');
 assert.equal(parseMetaTransitionOperatorRequest('PREREQUISITES',{...mixed,managed:{...mixed.managed,arrangementVersionId:'AbCdEf12-aBcD-4AbC-8DeF-aBcDeF12345!'}}),null);
 for(const change of [{targetTermsDocumentText:''},{targetTermsDocumentText:'ع'.repeat(16385)},{targetTermsVersion:'a b'},
  {targetReceivingBusinessId:'+123'},{arrangementVersionId:'another'},{creditLineId:'123'}]){
  assert.equal(parseMetaTransitionOperatorRequest('PREREQUISITES',{...input,managed:{...managed,...change}}),null);
 }
 assert.equal(parseMetaTransitionOperatorRequest('TARGET',{...base,managed,templateEvidenceSha256:'c'.repeat(64),flowEvidenceSha256:'d'.repeat(64)}),null);
});
