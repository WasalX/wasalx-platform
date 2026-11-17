import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {MetaManagedApprovalService} from '../services/control-api/dist/meta-managed-approval.service.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

const appId='12025550130',token='synthetic-financial-token';
const operator={subject:'synthetic-operator',roles:['platform_operator']};
const input=()=>({tenantId:randomUUID(),accountId:randomUUID(),familyId:null,kind:'OWN_SOLUTION_PARTNER_LINE',holderBusinessId:'100001',creditLineId:'100002',solutionId:null,
 receivingBusinessId:'100003',requestedCurrency:'USD',commercialTermsVersionId:randomUUID(),approvalSha256:'a'.repeat(64),expiresAt:new Date(Date.now()+60_000).toISOString()});
const context={appId,phoneNumberId:'100004',bindingId:randomUUID(),bindingRevision:1,authorityRevision:2,proofSha256:'b'.repeat(64)};
const configured=async fn=>{const keys=['META_APP_ID','META_GRAPH_VERSION','META_FINANCIAL_SECRET_REFERENCE','META_APP_SECRET_REFERENCE'];const previous=keys.map(k=>process.env[k]);
 Object.assign(process.env,{META_APP_ID:appId,META_GRAPH_VERSION:'v24.0',META_FINANCIAL_SECRET_REFERENCE:'secret://platform/meta/financial',META_APP_SECRET_REFERENCE:'secret://platform/meta/app'});
 try{await fn();}finally{keys.forEach((k,i)=>previous[i]===undefined?delete process.env[k]:process.env[k]=previous[i]);}};

test('managed approval inspects configured financial credential with business-management purpose and server pins',()=>configured(async()=>{
 let approved,calls=0;
 const metadata=verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['business_management'],expires_at:0}},{appId,purpose:'FINANCIAL'});
 const service=new MetaManagedApprovalService({metaManagedApprovalContext:async()=>context,approveMetaSimulatedArrangement:async value=>{approved=value;return{arrangementVersionId:randomUUID(),evidenceMode:'SIMULATED'};}},
  {resolveFinancialAccessToken:async()=>token},{create:(subject,phone,beforeRequest)=>({verifyCredentialMetadata:async(id,appSecret,purpose)=>{assert.equal(subject,token);assert.equal(phone,context.phoneNumberId);assert.equal(id,appId);assert.equal(appSecret,'synthetic-app-secret');assert.equal(purpose,'FINANCIAL');await beforeRequest();calls++;return metadata;}})},
  {resolveHmac:async(ref,owner)=>{assert.equal(ref,process.env.META_APP_SECRET_REFERENCE);assert.deepEqual(owner,{kind:'exact',expectedReference:ref});return'synthetic-app-secret';}});
 const result=await service.approveSimulated(input(),operator,'request-one');assert.equal(result.evidenceMode,'SIMULATED');assert.equal(calls,1);
 assert.equal(approved.financialCredentialFingerprint,createHash('sha256').update(token).digest('hex'));assert.equal(approved.financialSecretReference,process.env.META_FINANCIAL_SECRET_REFERENCE);
 assert.deepEqual(approved.admission,context);assert.deepEqual(approved.financialCredentialMetadata,metadata);assert.equal(approved.evidenceMode,'SIMULATED');
 assert.ok(!JSON.stringify(result).includes(token));
}));

test('tenant/operator payload cannot choose live mode, app, financial credential or metadata',()=>configured(async()=>{
 let sideEffects=0;const service=new MetaManagedApprovalService({metaManagedApprovalContext:async()=>{sideEffects++;return context;}},{},{},{});
 for(const [key,value] of [['evidenceMode','LIVE'],['financialSecretReference','secret://foreign/finance'],['financialCredentialMetadata',{}],['appId','20000']])
  await assert.rejects(()=>service.approveSimulated({...input(),[key]:value},operator,'forged'),/invalid/i);
 assert.equal(sideEffects,0);
}));

test('authority changed during credential diagnostic stops approval before durable write',()=>configured(async()=>{
 let reads=0,writes=0;
 const service=new MetaManagedApprovalService({metaManagedApprovalContext:async()=>({...context,authorityRevision:++reads}),approveMetaSimulatedArrangement:async()=>{writes++;}},
  {resolveFinancialAccessToken:async()=>token},{create:(_token,_phone,guard)=>({verifyCredentialMetadata:async()=>{await guard();throw new Error('unreachable');}})},
  {resolveHmac:async()=>'synthetic-app-secret'});
 await assert.rejects(()=>service.approveSimulated(input(),operator,'drift'),/changed/i);assert.equal(writes,0);
}));

test('financial scope verification failure creates no arrangement or effect',()=>configured(async()=>{
 let writes=0;const service=new MetaManagedApprovalService({metaManagedApprovalContext:async()=>context,approveMetaSimulatedArrangement:async()=>{writes++;}},
  {resolveFinancialAccessToken:async()=>token},{create:()=>({verifyCredentialMetadata:async()=>verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management'],expires_at:0}},{appId,purpose:'FINANCIAL'})})},
  {resolveHmac:async()=>'synthetic-app-secret'});
 await assert.rejects(()=>service.approveSimulated(input(),operator,'wrong-scope'));assert.equal(writes,0);
}));
