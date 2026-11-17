import assert from 'node:assert/strict';import test from 'node:test';
import {PrivacyProcessor} from '../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js';
const tenantId='10000000-0000-4000-8000-000000000001';
const job=()=>({id:'30000000-0000-4000-8000-000000000001',tenantId,requestId:'20000000-0000-4000-8000-000000000001',jobType:'DELETE',scopeType:'PARTICIPANT',scopeValue:'synthetic-participant',disposition:'DELETE_TICKETS',state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:4,zammadBaseUrl:'https://zammad.example.test',zammadPrivacySecretReference:'secret://synthetic/privacy',unmatchedDiagnosticHours:24,exportTtlHours:24});

test('pending finance review produces attention before external deletion and cannot fall through generic completion',async()=>{
 const current=job(),calls=[];let failure;
 const repository={expireHolds:async()=>0,ensureMaintenanceJob:async()=>null,claim:async()=>[current],discover:async()=>({FINANCE_SOURCE_REVIEW:1}),
  hasPendingFinanceReview:async()=>true,targets:async()=>{calls.push('targets');return[];},finalize:async()=>assert.fail('must not finalize'),
  complete:async()=>assert.fail('must not complete'),fail:async(_job,_lease,value)=>{failure=value;return true;}};
 const processor=new PrivacyProcessor(repository,{resolve:async()=>assert.fail('no secret needed')},{put:async()=>assert.fail('no upload'),delete:async()=>assert.fail('no delete')});
 const result=await processor.drainTenant(tenantId);assert.equal(result.failedTerminal,1);assert.equal(failure.code,'FINANCE_SOURCE_REVIEW_REQUIRED');assert.equal(failure.retryable,false);assert.deepEqual(calls,[]);
});

test('financial original cleanup uses its exact tenant/version key and durable begin/delete/complete order',async()=>{
 for(const foreign of [false,true]){
  const current=job(),sourceId='40000000-0000-4000-8000-000000000001',calls=[];let failure;
  const key='tenants/'+(foreign?'10000000-0000-4000-8000-000000000099':tenantId)+'/meta-cost-sources/'+sourceId+'/'+'a'.repeat(64)+'.bin';
  const repository={expireHolds:async()=>0,ensureMaintenanceJob:async()=>null,claim:async()=>[current],discover:async()=>({META_COST_SOURCE:1}),hasPendingFinanceReview:async()=>false,
   targets:async()=>[{id:'source-target',type:'META_COST_SOURCE',targetId:sourceId,state:'PENDING',objectKey:key}],beginTargetExternal:async()=>calls.push('begin'),
   markTargetExternal:async()=>calls.push('external-complete'),hasPendingExternalTargets:async()=>false,finalize:async()=>{calls.push('finalize');return{metaCostSourcesPurged:1};},
   complete:async()=>{calls.push('complete');return true;},fail:async(_job,_lease,value)=>{failure=value;return true;}};
  const processor=new PrivacyProcessor(repository,{resolve:async()=>assert.fail('no secret needed')},{put:async()=>assert.fail('no upload'),delete:async value=>{assert.equal(value,key);calls.push('delete');}});
  const result=await processor.drainTenant(tenantId);
  if(foreign){assert.equal(result.failedTerminal,1);assert.equal(failure.code,'PRIVACY_OBJECT_KEY_INVALID');assert.deepEqual(calls,[]);}
  else{assert.equal(result.succeeded,1);assert.deepEqual(calls,['begin','delete','external-complete','finalize','complete']);}
 }
});
