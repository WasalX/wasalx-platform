import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {executeMetaManagedFunding} from '../services/connector-worker/dist/services/connector-worker/src/meta-managed-funding.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const appId='12025550130',accountToken='synthetic-account-access-token',financialToken='synthetic-financial-access-token';
const job={id:'10000000-0000-4000-8000-000000000003',tenantId:'10000000-0000-4000-8000-000000000001',
 connectionId:'10000000-0000-4000-8000-000000000002',fencingToken:1,operationType:'VERIFY_META_BILLING'};
const metadata=scopes=>verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes,expires_at:0}},{appId,...(scopes.includes('business_management')?{purpose:'FINANCIAL'}:{})});
const context=()=>({accountId:'10000000-0000-4000-8000-000000000004',messagingAccountId:'840000000002',
 connectionSecretReference:`secret://${job.tenantId}/connections/${job.connectionId}/meta`,phoneNumberId:'840000000001',
 accountProof:{credentialFingerprint:sha(accountToken),credentialMetadata:metadata(['whatsapp_business_management','whatsapp_business_messaging'])},
 arrangementVersionId:'10000000-0000-4000-8000-000000000005',kind:'OWN_SOLUTION_PARTNER_LINE',appId,holderBusinessId:'840000000003',
 creditLineId:'840000000004',solutionId:null,receivingBusinessId:'840000000005',financialSecretReference:'secret://platform/meta/synthetic-financial',
 financialCredentialFingerprint:sha(financialToken),financialCredentialMetadata:metadata(['business_management']),
 graphVersion:'v24.0',currency:'USD',evidenceMode:'SIMULATED'});
const known={checkpointId:'10000000-0000-4000-8000-000000000006',outcome:'SUCCEEDED',
 result:{allocationConfigId:'840000000006',messagingAccountId:'840000000002'}};
const secrets={resolve:async(_reference,owner)=>({accessToken:owner.kind==='meta-connection'?accountToken:financialToken})};
const forbidden=async()=>{throw new Error('An original checkpoint must not obtain a new provider-effect slot');};
const store=(ctx,checkpoint)=>({managedFundingContext:async()=>ctx,managedFundingCheckpoint:async()=>checkpoint,
 resolveFinancialExecution:forbidden,reserveManagedFunding:forbidden,recordFinancialResponse:forbidden,recordAllocationReadback:async()=>true});

test('managed funding credential replacement is known not attempted before any HTTP',async()=>{
 const ctx=context(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Unexpected request');};
 try{await assert.rejects(()=>executeMetaManagedFunding(job,'lease',appId,store(ctx,known),
  {resolve:async(_reference,owner)=>({accessToken:owner.kind==='meta-connection'?accountToken:'synthetic-replaced-financial-token'})}),
  error=>error.code==='META_CREDIT_NOT_ATTEMPTED'&&error.outcomeKnown===true);assert.equal(calls,0);}
 finally{globalThis.fetch=original;}
});

test('an original financial UNKNOWN remains held with zero requests and no new slot',async()=>{
 const ctx=context(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Unexpected request');};
 try{await assert.rejects(()=>executeMetaManagedFunding(job,'lease',appId,store(ctx,{...known,outcome:'UNKNOWN',result:{reason:'PROVIDER_OUTCOME_UNRESOLVED'}}),secrets),
  error=>error.code==='META_CREDIT_NOT_ATTEMPTED'&&error.outcomeKnown===true);assert.equal(calls,0);}
 finally{globalThis.fetch=original;}
});

test('known attach success performs exact readback only, preserving UNVERIFIED observation payer',async()=>{
 const ctx=context(),original=globalThis.fetch,calls=[];let readback;
 globalThis.fetch=async(url,init)=>{
  const parsed=new URL(String(url));calls.push({path:parsed.pathname,method:init.method??'GET'});
  let value;
  if(parsed.pathname.endsWith('/840000000006'))value={id:'840000000006',receiving_credential:{id:'synthetic-receiving-credential'}};
  else if(parsed.pathname.endsWith('/840000000004/owning_credit_allocation_configs')){
   assert.equal(parsed.searchParams.get('receiving_business_id'),ctx.receivingBusinessId);
   value={id:'840000000006',receiving_business:{id:ctx.receivingBusinessId}};
  }else if(parsed.pathname.endsWith('/840000000002')&&parsed.searchParams.get('fields')==='id,owner_business{id}')
   value={id:ctx.messagingAccountId,owner_business:{id:ctx.receivingBusinessId}};
  else if(parsed.pathname.endsWith('/840000000002')&&parsed.searchParams.get('fields')==='primary_funding_id')
   value={id:ctx.messagingAccountId,primary_funding_id:'synthetic-receiving-credential'};
  else if(parsed.pathname.endsWith('/840000000002')&&parsed.searchParams.get('fields')==='id,currency')value={id:ctx.messagingAccountId,currency:'USD'};
  else throw new Error('Unexpected Graph read');
  return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  const repository={...store(ctx,known),recordAllocationReadback:async(_job,_lease,checkpoint,value)=>{assert.equal(checkpoint,known.checkpointId);readback=value;return true;}};
  const result=await executeMetaManagedFunding(job,'lease',appId,repository,secrets);
  assert.equal(calls.length,5);assert.ok(calls.every(v=>v.method==='GET'));
  assert.equal(readback.receivingCredential,'synthetic-receiving-credential');assert.equal(readback.receivingBusinessId,ctx.receivingBusinessId);
  assert.equal(result.funding.status,'PRESENT');assert.equal(result.funding.actualPayer,'UNVERIFIED');
  assert.equal(result.diagnostic.cardVerified,false);assert.deepEqual(known.result,{allocationConfigId:'840000000006',messagingAccountId:'840000000002'});
 }finally{globalThis.fetch=original;}
});

test('a new authority hold between known-success readbacks stops the next request without reclassification',async()=>{
 const ctx=context(),original=globalThis.fetch;let checks=0,calls=0,recorded=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({id:'840000000006',receiving_credential:{id:'synthetic-receiving-credential'}}),
  {status:200,headers:{'content-type':'application/json'}});};
 try{
  const repository={...store(ctx,known),managedFundingContext:async()=>++checks<=2?ctx:{...ctx,financialCredentialFingerprint:sha('new-approval')},
   recordAllocationReadback:async()=>{recorded++;return true;}};
  await assert.rejects(()=>executeMetaManagedFunding(job,'lease',appId,repository,secrets),
   error=>error.code==='META_CREDIT_NOT_ATTEMPTED'&&error.outcomeKnown===true);
  assert.equal(calls,1);assert.equal(recorded,0);assert.equal(known.outcome,'SUCCEEDED');
 }finally{globalThis.fetch=original;}
});

test('async runtime preparation cannot dispatch with superseded context or newly expired metadata',async()=>{
 const OriginalDate=globalThis.Date,originalFetch=globalThis.fetch;
 try{
  for(const point of ['readRuntime','resolveFinancialExecution','metadataExpiry']){
   let ctx=context(),now=OriginalDate.now(),current=ctx,posts=0,reservations=0,records=0,drifts=0;
   if(point==='metadataExpiry'){
    globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
    ctx.financialCredentialMetadata=verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['business_management'],expires_at:Math.floor(now/1000)+30}}, {appId,purpose:'FINANCIAL'});
   }
   const drift=()=>{drifts++;if(point==='metadataExpiry')now+=60_000;else current={...ctx,phoneNumberId:'840000000099'};};
   globalThis.fetch=async(input,init={})=>{
    if(init.method==='POST'){posts++;assert.fail('No stale financial POST');}
    const url=new URL(String(input));
    if(url.pathname.endsWith('/extendedcredits'))return Response.json({data:[{id:ctx.creditLineId}]});
    if(url.searchParams.get('fields')==='id,owner_business{id}')return Response.json({id:ctx.messagingAccountId,owner_business:{id:ctx.receivingBusinessId}});
    if(url.searchParams.get('fields')==='primary_funding_id')return Response.json({id:ctx.messagingAccountId});
    if(url.searchParams.get('fields')==='id,currency')return Response.json({id:ctx.messagingAccountId,currency:'USD'});
    assert.fail('Unexpected preliminary read');
   };
   const repository={...store(ctx,undefined),managedFundingContext:async()=>current,
    resolveFinancialExecution:async()=>{if(point==='resolveFinancialExecution')drift();return{mode:'SIMULATED'};},
    reserveManagedFunding:async()=>{reservations++;assert.fail('No stale reservation');},recordFinancialResponse:async()=>{records++;}};
   const dependencies={readTransport:async()=>({transportBindingSha256:'1'.repeat(64)}),readRuntime:async()=>{if(point!=='resolveFinancialExecution')drift();return undefined;}};
   await assert.rejects(()=>executeMetaManagedFunding(job,'lease',appId,repository,secrets,dependencies),e=>e.code==='META_CREDIT_NOT_ATTEMPTED'&&e.outcomeKnown===true);
   assert.equal(drifts,1,`The intended ${point} boundary was reached`);
   assert.equal(posts,0);assert.equal(reservations,0);assert.equal(records,0);globalThis.Date=OriginalDate;
  }
 }finally{globalThis.Date=OriginalDate;globalThis.fetch=originalFetch;}
});
