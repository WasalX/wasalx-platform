import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {metaAccountFundingProof,parseMetaBillingSnapshot} from '../packages/core/dist/meta-account-policy.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {ProviderError} from '../services/connector-worker/dist/packages/connectors/src/types.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {DeliveryProcessor} from '../services/connector-worker/dist/services/connector-worker/src/processor.js';
import {ConnectionOperationProcessor} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';

test('Private funding proof observes only same-account facts, never verified customer or payer',()=>{
 const now=new Date('2026-10-07T00:00:00.000Z');
 const {diagnostic,funding}=metaAccountFundingProof('123',{id:'123',owner_business:{id:'456'}},{id:'123',primary_funding_id:'opaque'},now);
 assert.equal(funding.primaryFundingId,'opaque');assert.equal(funding.observedOwnerBusinessId,'456');assert.equal(funding.actualPayer,'UNVERIFIED');
 assert.equal(funding.expiresAt,'2026-10-07T00:15:00.000Z');assert.equal(diagnostic.customerOwnership,'UNVERIFIED');
 assert.equal(metaAccountFundingProof('123',{},{}).funding.status,'NONE');
 for(const input of [null,[],{id:'999'},{primary_funding_id:null},{primary_funding_id:{id:'123'}}])
  assert.equal(metaAccountFundingProof('123',{},input).funding.status,'UNAVAILABLE');
 assert.equal(metaAccountFundingProof('123',{id:'999',owner_business:{id:'456'}},{}).funding.observedOwnerBusinessId,null);
});

function snapshot(){return{schemaVersion:1,claim:'ACCOUNT_POLICY_BOUND',tenantId:randomUUID(),connectionId:randomUUID(),accountId:randomUUID(),providerAccountId:'123',identifierKind:'MESSAGING_ACCOUNT_ID',bindingId:randomUUID(),bindingRevision:1,accountAuthorityRevision:2,policyVersionId:randomUUID(),mode:'CUSTOMER',actualPayer:'UNVERIFIED',fundingResponseSha256:'a'.repeat(64),fundingObservedAt:new Date().toISOString()};}
test('Birth attribution keeps legacy unknown and rejects manufactured payer/generation/account',()=>{
 assert.deepEqual(parseMetaBillingSnapshot({schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'}),{schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'});
 const valid=snapshot();assert.deepEqual(parseMetaBillingSnapshot(valid),valid);
 for(const value of [null,{...valid,mode:'MANAGED'},{...valid,actualPayer:'CUSTOMER'},{...valid,bindingRevision:0},{...valid,providerAccountId:'phone'},
  {...valid,accountAuthorityRevision:Number.MAX_SAFE_INTEGER+1},{...valid,identifierKind:'WABA_ID'}])assert.throws(()=>parseMetaBillingSnapshot(value));
});

test('Every message format carries explicit account; only final Messages HTTP stamps admission',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const events=[];
 globalThis.fetch=async(url,init)=>{const path=new URL(url).pathname;events.push({kind:'http',path,body:typeof init.body==='string'?JSON.parse(init.body):null});
  return new Response(JSON.stringify(path.endsWith('/media')?{id:'media1'}:{messages:[{id:'wamid.1'}]}));};
 const adapter=new MetaGroupsAdapter({accessToken:'synthetic-policy-access-token',graphVersion:'v24.0',phoneNumberIdFor:()=> '555',beforeRequest:async()=>events.push({kind:'guard'}),
  beforeMessageSend:async(hash,phoneNumberId)=>events.push({kind:'admission',hash,phoneNumberId})});
 const input={connectionId:'c',groupId:'12025550106',recipientType:'DIRECT',text:'hello',idempotencyKey:'key',messagingAccountId:'123'};
 const uploaded=await adapter.prepareMedia({...input,media:{filename:'example.png',mimeType:'image/png',bytes:new Uint8Array([1])}});
 assert.equal(uploaded.providerMediaId,'media1');assert.equal(events.filter(x=>x.kind==='admission').length,0);
 for(const variant of [{},{recipientType:'GROUP',groupId:'group-id'}, {template:{name:'approved',languageCode:'en',bodyParameters:[]}},
  {location:{latitude:0,longitude:0}}, {choices:{options:[{id:'one',label:'One'}]}}, {media:{filename:'example.png',mimeType:'image/png',bytes:new Uint8Array([1]),providerMediaId:'media1'}}]) {
  events.length=0;await adapter.send({...input,...variant});assert.deepEqual(events.map(x=>x.kind),['guard','admission','http']);
  assert.equal(events[1].phoneNumberId,'555');assert.equal(new URL('https://graph.facebook.com'+events[2].path).pathname,'/v24.0/555/messages');
  assert.equal(events[2].body.messaging_account_id,'123');assert.equal(events[1].hash,createHash('sha256').update(JSON.stringify(events[2].body)).digest('hex'));
 }
 events.length=0;await adapter.send({...input,messagingAccountId:undefined});assert.ok(!Object.hasOwn(events[2].body,'messaging_account_id'));
});

test('Funding denial before final HTTP is known not attempted, with no provider call or replay',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('{}');};
 const adapter=new MetaGroupsAdapter({accessToken:'synthetic-policy-access-token',graphVersion:'v24.0',phoneNumberIdFor:()=> '555',
  beforeMessageSend:async()=>{throw new ProviderError('Payment review required',false,'META_BILLING_SEND_HELD',undefined,true);}});
 await assert.rejects(()=>adapter.send({connectionId:'c',groupId:'12025550106',recipientType:'DIRECT',text:'hello',idempotencyKey:'key',messagingAccountId:'123'}),error=>error.outcomeKnown===true&&error.code==='META_BILLING_SEND_HELD');
 assert.equal(calls,0);
});

test('A successful media upload followed by a funding hold retains its reference and sends no Messages request',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let uploads=0,messages=0,admissions=0,held=false;
 globalThis.fetch=async url=>{if(new URL(url).pathname.endsWith('/media')){uploads++;return Response.json({id:'retained-media'});}messages++;return Response.json({messages:[{id:'unexpected'}]});};
 const adapter=new MetaGroupsAdapter({accessToken:'synthetic-policy-access-token',graphVersion:'v24.0',phoneNumberIdFor:()=> '555',
  beforeMessageSend:async()=>{if(held)throw new ProviderError('Funding observation became unavailable',false,'META_BILLING_SEND_HELD',undefined,true);admissions++;}});
 const input={connectionId:'c',groupId:'12025550106',recipientType:'DIRECT',text:'Synthetic prepared media',idempotencyKey:'prepared',messagingAccountId:'123',media:{filename:'example.png',mimeType:'image/png',bytes:new Uint8Array([1])}};
 const prepared=await adapter.prepareMedia(input);assert.equal(prepared.providerMediaId,'retained-media');held=true;
 const ready={...input,media:{...input.media,providerMediaId:prepared.providerMediaId}};
 for(let index=0;index<2;index++)await assert.rejects(()=>adapter.send(ready),e=>e.outcomeKnown===true&&e.code==='META_BILLING_SEND_HELD');
 assert.equal(ready.media.providerMediaId,'retained-media');assert.equal(uploads,1);assert.equal(messages,0);assert.equal(admissions,0);
});

test('Customer declaration refuses managed/account/approval overrides before admission',async()=>{
 const controller=new ConnectionsController({withTenant:async()=>assert.fail('invalid policy body must not reach DB')});
 for(const body of [null,[],{mode:'MANAGED',expectedRevision:0},{mode:'CUSTOMER',expectedRevision:-1},{mode:'CUSTOMER',expectedRevision:0,wabaId:'123'},
  {mode:'CUSTOMER',expectedRevision:0,sendReady:true}])await assert.rejects(()=>controller.requestMetaBillingPolicy({},randomUUID(),'key',body),error=>error.getStatus()===400);
});

test('An enrolled funding GET failure settles one unavailable observation, never a lifecycle retry',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let failed,http=0;
 const appId='12025550130',token='synthetic-funding-token';
 globalThis.fetch=async()=>{http++;return Response.json({error:{code:4,message:'private provider details'}},{status:429});};
 const job={id:randomUUID(),tenantId:randomUUID(),connectionId:randomUUID(),operationType:'VERIFY_META_BILLING',provider:'META',connectionState:'PAUSED',connectionSecretReference:'synthetic',attempts:1,maxAttempts:8,
   payload:{metaBillingDiagnostic:{wabaId:'12345'},metaAccountPolicy:{accountId:randomUUID()}},providerSession:{id:randomUUID(),opaqueSessionId:'555',providerStateData:{wabaId:'12345',metaAccountProof:{graphVersion:'v24.0',credentialFingerprint:createHash('sha256').update(token).digest('hex'),
     credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})}}}};
 const repository={claim:async()=>[job],guardMetaBillingDiagnostic:async()=> 'CURRENT',failMetaBillingDiagnostic:async(_job,_lease,failure,appId)=>{failed={failure,appId};},
   complete:async()=>assert.fail('No lifecycle completion'),fail:async()=>assert.fail('No lifecycle failure')};
 const result=await new ConnectionOperationProcessor(repository,{resolve:async()=>({accessToken:token})},{metaAppId:appId,metaGraphVersion:'v24.0',publicWebhookBaseUrl:'https://hooks.example.test'}).drainTenant(job.tenantId);
 assert.equal(result.failedTerminal,1);assert.equal(result.failedRetryable,0);assert.equal(http,2);assert.equal(failed.appId,appId);assert.equal(failed.failure.connectionState,'PAUSED');
 assert.ok(!JSON.stringify(failed).includes('private provider details'));
});

test('A failed final database admission is known unattempted, not an uncertain message HTTP',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let fetches=0,failed;
 globalThis.fetch=async()=>{fetches++;return Response.json({messages:[{id:'unexpected'}]});};
 const delivery={id:randomUUID(),tenantId:randomUUID(),connectionId:randomUUID(),provider:'meta',recipientType:'GROUP',groupId:'synthetic-group',
  sessionId:'555',connectionSecretReference:'synthetic',contentType:'text/plain',text:'Synthetic admission',idempotencyKey:'one',attempts:1,
  metaCredentialContext:{providerSessionId:randomUUID(),phoneNumberId:'555',wabaId:null,proof:null},metaBillingSnapshot:{schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'}};
 const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],claimStatuses:async()=>[],beginSend:async()=>true,
  assertMetaDeliveryContextCurrent:async()=>{},admitMetaMessageRequest:async()=>{throw new Error('Database interrupted before HTTP');},
  complete:async()=>assert.fail('No provider success'),outcomeUnknown:async()=>assert.fail('Nothing was dispatched'),
  fail:async(_job,_lease,retryable,_error,_at,_manual,code)=>{failed={retryable,code};}};
 await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:'synthetic-policy-access-token'})},{metaGraphVersion:'v24.0'}).drainTenant(delivery.tenantId);
 assert.equal(fetches,0);assert.deepEqual(failed,{retryable:true,code:'META_MESSAGE_ADMISSION_UNAVAILABLE'});
});
