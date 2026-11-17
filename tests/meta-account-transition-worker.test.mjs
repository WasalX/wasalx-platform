import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {executeMetaAccountTransition} from '../services/connector-worker/dist/services/connector-worker/src/meta-account-transition-execution.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const appId='12025550130',token='synthetic-transition-token';
const job={id:'10000000-0000-4000-8000-000000000001',tenantId:'10000000-0000-4000-8000-000000000002',
 connectionId:'10000000-0000-4000-8000-000000000003',fencingToken:1,operationType:'EXECUTE_META_ACCOUNT_TRANSITION'};
function fixture(stage='INITIATE'){
 const context={transitionId:'10000000-0000-4000-8000-000000000004',revision:2,stage,
  sourceAccountId:'10000000-0000-4000-8000-000000000005',providerSourceAccountId:'111',targetCurrency:'EUR',
  destinationAccountId:null,providerDestinationAccountId:stage==='INITIATE'?null:'222',migrationId:stage==='INITIATE'?null:'mig_one',
  secretReference:`secret://${job.tenantId}/connections/${job.connectionId}/meta`,
  accountProof:{credentialFingerprint:hash(token),credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,
   scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})},
  appId,graphVersion:'v24.0',phoneNumberId:'333',scopeSha256:'a'.repeat(64),admissionSha256:'b'.repeat(64),evidenceMode:'SIMULATED',approvedCreditLineId:null,
  requestedMode:'CUSTOMER',financial:null,targetDependenciesCurrent:false,observers:{'10000000-0000-4000-8000-000000000006':null},scope:{bindings:[]},
  facts:{eligibility:{graphVersionQualified:true,adminAuthorityCurrent:true,variant:'STANDARD',sourceCurrency:'USD',targetCurrency:'EUR',
   endpointCurrencyQualified:true,requestedMode:'CUSTOMER',sourcePayment:'CARD',replaceCustomerCard:false,managedAuthorityCurrent:false},
   reservationCurrent:true,scopeCurrent:true,externalImpactSettled:true,drainClear:true,sourceAuthorityCurrent:true,runtimeCurrent:true,
   confirmationCurrent:true,existingStage:'NONE',initiationSettlement:'EXACT_MIGRATION_ID_ACCEPTED',observedStatus:'READY_TO_COMPLETE',
   targetVerified:true,targetPaymentReady:true,continuityVerified:true}};
 context.scope.bindings=[{id:'10000000-0000-4000-8000-000000000006',revision:1,connectionId:job.connectionId,
  sessionId:'10000000-0000-4000-8000-000000000007',phoneId:'333',appId,secretReference:context.secretReference,
  fingerprint:hash(token),providerState:{metaAccountProof:context.accountProof}}];
 const trace=[];let checkpoint;
 const store={transitionExecutionContext:async()=>context,transitionCheckpoint:async()=>checkpoint,
  resolveTransitionExecution:async()=>({mode:'SIMULATED'}),
  reserveTransitionStage:async(_job,_lease,requestedStage,requestSha)=>{trace.push(['reserve',requestedStage,requestSha]);
   if(checkpoint)return{disposition:'HISTORICAL_NO_POST',checkpointId:'cp',outcome:checkpoint.outcome};
   checkpoint={id:'cp',ownerId:context.transitionId,stage:requestedStage,outcome:'ATTEMPTED',recoveryMigrationId:null};
   return{disposition:'NEW_ATTEMPT',checkpointId:'cp',reservationToken:'private-fence'};},
  recordTransitionResponse:async(_job,_slot,outcome,result)=>{trace.push(['record',outcome,result]);
   checkpoint={...checkpoint,outcome,recoveryMigrationId:result.migrationId??null};},
  recordTransitionObservation:async(_job,_lease,value)=>{trace.push(['observe',value]);return true;},
  reconcileTransition:async()=>{trace.push(['reconcile']);return true;},finishTransition:async()=>{trace.push(['finish']);}};
 return{context,store,trace,checkpoint:()=>checkpoint,setCheckpoint:value=>{checkpoint=value;},
  secrets:{resolve:async()=>({accessToken:token})},dependencies:{readTransport:async()=>({transportBindingSha256:'c'.repeat(64)}),readRuntime:async()=>undefined}};
}
async function run(f){return executeMetaAccountTransition(job,'lease',appId,f.store,f.secrets,f.dependencies);}

test('transition commits exact request checkpoint before POST and records accepted response without automatic observation or completion',async()=>{
 const f=fixture(),original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(f.trace[0][0],'reserve');f.trace.push(['http',String(url),init.method]);
  assert.equal(String(url),'https://graph.facebook.com/v24.0/111/set_payment_method_migration_intent');
  assert.deepEqual(JSON.parse(init.body),{currency:'EUR'});
  return Response.json({migration_id:'mig_one',migration_status:'INITIATED'});};
 try{await run(f);assert.deepEqual(f.trace.map(v=>v[0]),['reserve','http','record']);
  assert.equal(f.trace[2][1],'SUCCEEDED');assert.equal(f.checkpoint().recoveryMigrationId,'mig_one');}
 finally{globalThis.fetch=original;}
});

test('timeout retains UNKNOWN original slot; a replacement invocation cannot dispatch another POST',async()=>{
 const f=fixture(),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error('synthetic network loss');};
 try{await assert.rejects(()=>run(f));assert.equal(f.checkpoint().outcome,'UNKNOWN');
  await assert.rejects(()=>run(f));assert.equal(requests,1);assert.equal(f.trace.filter(v=>v[0]==='reserve').length,1);}
 finally{globalThis.fetch=original;}
});

test('malformed mutation preserves only captured recovery ID and does not infer settlement from an explicit target read',async()=>{
 const f=fixture(),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;return Response.json({migration_id:'mig_one',migration_status:'NEW_UNKNOWN_STATUS'});};
 try{await assert.rejects(()=>run(f));assert.equal(f.checkpoint().outcome,'UNKNOWN');
  assert.deepEqual(f.trace.at(-1),['record','UNKNOWN',{reason:'PROVIDER_OUTCOME_UNRESOLVED',migrationId:'mig_one'}]);
  f.context.stage='OBSERVE';f.context.migrationId='mig_one';
  globalThis.fetch=async(_url,init)=>{assert.equal(init.method,'GET');requests++;
   return Response.json({id:'mig_one',status:'IN_PROGRESS'});};
  await run(f);assert.equal(f.checkpoint().outcome,'UNKNOWN');assert.equal(requests,2);
  assert.equal(f.trace.filter(v=>v[0]==='reserve').length,1);assert.equal(f.trace.at(-1)[0],'observe');}
 finally{globalThis.fetch=original;}
});

test('known response persistence failure never rewrites it to UNKNOWN or retries provider mutation',async()=>{
 const f=fixture(),original=globalThis.fetch;let requests=0,recordCalls=0;
 globalThis.fetch=async()=>{requests++;return Response.json({migration_id:'mig_one',migration_status:'INITIATED'});};
 f.store.recordTransitionResponse=async(_job,_slot,outcome)=>{recordCalls++;assert.equal(outcome,'SUCCEEDED');throw new Error('synthetic DB uncertainty');};
 try{await assert.rejects(()=>run(f));assert.equal(f.checkpoint().outcome,'ATTEMPTED');
  await assert.rejects(()=>run(f));assert.equal(requests,1);assert.equal(recordCalls,1);}
 finally{globalThis.fetch=original;}
});

test('context drift during runtime resolution prevents slot and HTTP; no generic known rejection may manufacture a new attempt',async()=>{
 const f=fixture(),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;assert.fail('stale transition request');};
 f.store.resolveTransitionExecution=async()=>{f.store.transitionExecutionContext=async()=>({...f.context,admissionSha256:'d'.repeat(64)});return{mode:'SIMULATED'};};
 try{await assert.rejects(()=>run(f));assert.equal(requests,0);assert.equal(f.trace.length,0);}
 finally{globalThis.fetch=original;}
});

test('COMPLETE uses existing captured migration only; original completed slot is read-only on replacement',async()=>{
 const f=fixture('COMPLETE'),original=globalThis.fetch;const methods=[];
 globalThis.fetch=async(url,init)=>{methods.push(init.method);
  assert.equal(String(url),init.method==='POST'?'https://graph.facebook.com/v24.0/mig_one/resume_migration':'https://graph.facebook.com/v24.0/mig_one');
  assert.equal(init.body,undefined);return Response.json(init.method==='POST'
   ?{id:'mig_one',status:'COMPLETED',destination_waba:{id:'222',currency:'EUR'}}:{id:'mig_one',status:'IN_PROGRESS'});};
 try{await run(f);await run(f);assert.deepEqual(methods,['POST','GET']);
  assert.equal(f.trace.filter(v=>v[0]==='reserve').length,1);assert.equal(f.trace.at(-1)[0],'observe');}
 finally{globalThis.fetch=original;}
});

test('local reconciliation dispatch never resolves transport or makes provider calls',async()=>{
 const f=fixture('RECONCILE'),original=globalThis.fetch;
 globalThis.fetch=async()=>assert.fail('local reconciliation cannot call provider');
 f.dependencies.readTransport=async()=>assert.fail('local reconciliation cannot acquire provider execution');
 try{await run(f);assert.deepEqual(f.trace,[['reconcile']]);assert.equal(f.checkpoint(),undefined);}
 finally{globalThis.fetch=original;}
});

test('known provider completion remains recorded with unavailable target proof after a failed independent GET',async()=>{
 const f=fixture('OBSERVE'),original=globalThis.fetch;const requests=[];
 f.context.providerDestinationAccountId='22222';f.context.phoneNumberId='33333';f.context.scope.bindings[0].phoneId='33333';
 globalThis.fetch=async(url,init)=>{requests.push([new URL(url).pathname,init.method]);assert.equal(init.method,'GET');
  if(new URL(url).pathname==='/v24.0/mig_one')return Response.json({id:'mig_one',status:'COMPLETED',destination_waba:{id:'22222',currency:'EUR'}});
  return Response.json({error:{message:'synthetic inaccessible target',type:'OAuthException',code:10}},{status:403});};
 try{await run(f);assert.deepEqual(requests,[['/v24.0/mig_one','GET'],['/v24.0/22222/phone_numbers','GET']]);const observed=f.trace.at(-1)[1];
  assert.equal(observed.status,'COMPLETED');assert.deepEqual(observed.targetAssets,[]);
  assert.equal(observed.fundingProof,null);assert.deepEqual(observed.targetReadiness,
   {assets:'UNAVAILABLE',payment:'UNAVAILABLE',templates:'UNAVAILABLE',continuity:'UNAVAILABLE'});
  assert.equal(f.trace.filter(item=>item[0]==='reserve').length,0);}
 finally{globalThis.fetch=original;}
});

test('a lost lease during target read never persists the known migration as a current observation',async()=>{
 const f=fixture('OBSERVE'),original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;f.store.transitionExecutionContext=async()=>{throw new Error('synthetic lease changed');};
  return Response.json({id:'mig_one',status:'COMPLETED',destination_waba:{id:'222',currency:'EUR'}});};
 try{await assert.rejects(()=>run(f));assert.equal(requests,1);assert.equal(f.trace.length,0);}
 finally{globalThis.fetch=original;}
});

test('pre-completion observation proves clone access without requiring final phone inventory or messaging health',async()=>{
 const f=fixture('OBSERVE'),original=globalThis.fetch,requests=[];
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw));requests.push(url.pathname);assert.equal(init.method,'GET');
  if(url.pathname==='/v24.0/mig_one')return Response.json({id:'mig_one',status:'READY_TO_COMPLETE',destination_waba:{id:'222',currency:'EUR'}});
  if(url.pathname==='/v24.0/222/subscribed_apps')return Response.json({data:[{whatsapp_business_api_data:{id:appId}}]});
  if(url.pathname==='/v24.0/222'&&url.searchParams.get('fields')==='id,currency')return Response.json({id:'222',currency:'EUR'});
  if(url.pathname==='/v24.0/222'&&url.searchParams.get('fields')==='id,owner_business{id}')return Response.json({id:'222',owner_business:{id:'444'}});
  if(url.pathname==='/v24.0/222'&&url.searchParams.get('fields')==='primary_funding_id')return Response.json({id:'222',primary_funding_id:'synthetic-card'});
  assert.fail('An unfinished clone must not require completed phone membership, health or registration');
 };
 try{await run(f);const observed=f.trace.at(-1)[1];assert.equal(observed.targetReadiness.assets,'CLONE_ACCESS_VERIFIED');
  assert.equal(observed.targetReadiness.continuity,'ORIGINAL_PHONE_SCOPE_RESERVED');assert.equal(observed.targetReadiness.payment,'VERIFIED');
  assert.deepEqual(observed.targetAssets,[]);assert.equal(observed.cloneAccess.observerOperationId,null);
  assert.equal(requests.some(path=>path.includes('phone_numbers')),false);assert.equal(f.trace.some(item=>item[0]==='reserve'),false);}
 finally{globalThis.fetch=original;}
});

test('captured renewed observer is used for readback and cannot silently fall back to the original reference',async()=>{
 const f=fixture('OBSERVE'),original=globalThis.fetch,newToken='synthetic-selected-observer',id=f.context.scope.bindings[0].id;
 const proof={credentialFingerprint:hash(newToken),credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,
  scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const reference=`secret://${job.tenantId}/connections/${job.connectionId}/meta/rotations/${'e'.repeat(64)}`;
 f.context.observers[id]={operationId:'10000000-0000-4000-8000-000000000008',secretReference:reference,
  credentialFingerprint:hash(newToken),accountProof:proof,observerAccountId:'111',phoneNumberId:'333',appId};
 f.context.secretReference=reference;f.context.accountProof=proof;
 const resolved=[];f.secrets.resolve=async ref=>{resolved.push(ref);assert.equal(ref,reference);return{accessToken:newToken};};
 globalThis.fetch=async(raw,init)=>{assert.equal(init.method,'GET');assert.equal(init.headers.authorization,`Bearer ${newToken}`);
  const url=new URL(String(raw));if(url.pathname==='/v24.0/mig_one')return Response.json({id:'mig_one',status:'READY_TO_COMPLETE',destination_waba:{id:'222',currency:'EUR'}});
  if(url.pathname.endsWith('/subscribed_apps'))return Response.json({data:[{whatsapp_business_api_data:{id:appId}}]});
  if(url.searchParams.get('fields')==='id,currency')return Response.json({id:'222',currency:'EUR'});
  if(url.searchParams.get('fields')==='id,owner_business{id}')return Response.json({id:'222',owner_business:{id:'444'}});
  if(url.searchParams.get('fields')==='primary_funding_id')return Response.json({id:'222',primary_funding_id:'synthetic-card'});
  assert.fail('unexpected selected observer request');};
 try{await run(f);assert.ok(resolved.length);assert.equal(f.trace.at(-1)[1].cloneAccess.observerOperationId,f.context.observers[id].operationId);
  f.secrets.resolve=async()=>{throw new Error('selected credential unavailable');};await assert.rejects(()=>run(f));
  assert.equal(f.trace.some(item=>item[0]==='reserve'),false);}
 finally{globalThis.fetch=original;}
});
