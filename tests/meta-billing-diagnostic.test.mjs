import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {metaBillingDiagnosticBinding,metaBillingDiagnosticFromResponses,metaBillingDiagnosticProofCurrent,publicMetaBillingDiagnostic} from '../packages/core/dist/meta-billing-diagnostic.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {ConnectionOperationProcessor} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js';
import {ConnectionOperationLeaseLostError} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';

const appId='123456789',wabaId='987654321',phoneId='123123123',token='synthetic-diagnostic-token';
function job(){
 const tenantId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID(),secretReference=`secret://${tenantId}/connections/${connectionId}/meta`;
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,providerSessionId:sessionId,phoneNumberId:phoneId,wabaId,
  secretReference,credentialFingerprint:createHash('sha256').update(token).digest('hex'),operationId:randomUUID(),fencingToken:1,
  graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,
   scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const providerSession={id:sessionId,opaqueSessionId:phoneId,state:'PAUSED',fencingToken:7,providerStateData:{wabaId,metaAccountProof:proof}};
 return {id:randomUUID(),tenantId,connectionId,operationType:'VERIFY_META_BILLING',provider:'META',connectionState:'PAUSED',connectionSecretReference:secretReference,
  providerSession,attempts:1,maxAttempts:8,fencingToken:2,payload:{metaBillingDiagnostic:metaBillingDiagnosticBinding(secretReference,providerSession,appId)}};
}

test('Meta funding presence does not assert payer/card/title and public result contains no finance identifiers',()=>{
 for(const [funding,expected]of [[{id:wabaId,primary_funding_id:'opaque-finance-id'},'PRESENT'],[{id:wabaId},'NONE']]){
  const result=metaBillingDiagnosticFromResponses(wabaId,{id:wabaId,owner_business:{id:'777777777',name:'private-owner-name'}},funding);
  assert.equal(result.paymentMethod,expected);assert.equal(result.accountOwner,'REPORTED');
  assert.equal(result.actualPayer,'UNVERIFIED');assert.equal(result.customerOwnership,'UNVERIFIED');assert.equal(result.cardVerified,false);
  const dto=publicMetaBillingDiagnostic({...result,token,primary_funding_id:'hidden'});
  for(const forbidden of ['opaque-finance-id','777777777','private-owner-name','hidden',token,'responseSha256'])assert.ok(!JSON.stringify(dto).includes(forbidden));
 }
});
test('Malformed/wrong-account funding is unavailable, never interpreted as no payment method',()=>{
 for(const value of [null,[],{id:'wrong'},{primary_funding_id:null},{primary_funding_id:123},{primary_funding_id:{id:'123'}}])
  assert.equal(metaBillingDiagnosticFromResponses(wabaId,{},value).paymentMethod,'UNAVAILABLE');
 assert.equal(publicMetaBillingDiagnostic({paymentMethod:'PRESENT',actualPayer:'CUSTOMER'}),null);
});
test('Diagnostic admission binding is JSONB-order independent and changes with credential, session, app or lifecycle',()=>{
 const input=job(),first=input.payload.metaBillingDiagnostic;
 const reordered={...input.providerSession,providerStateData:{metaAccountProof:{...input.providerSession.providerStateData.metaAccountProof},wabaId}};
 assert.deepEqual(metaBillingDiagnosticBinding(input.connectionSecretReference,reordered,appId),first);
 for(const changed of [metaBillingDiagnosticBinding('secret://other',reordered,appId),metaBillingDiagnosticBinding(input.connectionSecretReference,{...reordered,id:randomUUID()},appId),
  metaBillingDiagnosticBinding(input.connectionSecretReference,reordered,'999'),metaBillingDiagnosticBinding(input.connectionSecretReference,{...reordered,providerStateData:{...reordered.providerStateData,metaLifecycle:null}},appId)])
  assert.notDeepEqual(changed,first);
});
test('Readback authority rejects expired/copied/malformed proof without claiming legacy ownership',()=>{
 const input=job(),binding=input.payload.metaBillingDiagnostic,proof=input.providerSession.providerStateData.metaAccountProof;
 assert.equal(metaBillingDiagnosticProofCurrent(binding,proof,input),true);
 for(const changed of [undefined,null,{...proof,tenantId:randomUUID()},{...proof,connectionId:randomUUID()},
  {...proof,credentialMetadata:null},{...proof,credentialMetadata:{...proof.credentialMetadata,expiresAt:Math.floor(Date.now()/1000)-1}}])
  assert.equal(metaBillingDiagnosticProofCurrent(binding,changed,input),false);
});

async function run(t,{guards=['CURRENT'],status=200,leaseLost=false}={}){
 const input=job(),calls={guards:0,http:[],complete:[],fail:[],secrets:0};
 const repository={claim:async()=>[input],guardMetaBillingDiagnostic:async()=>{if(leaseLost)throw new ConnectionOperationLeaseLostError();return guards[Math.min(calls.guards++,guards.length-1)];},
  completeMetaBillingDiagnostic:async(_job,_lease,_app,result)=>calls.complete.push(result),failMetaBillingDiagnostic:async(_job,_lease,failure)=>calls.fail.push(failure),
  acquireProviderSessionLease:async()=>assert.fail('diagnostics must not acquire provider ownership'),renewLeases:async()=>assert.fail('no lifecycle renewal'),
  complete:async()=>assert.fail('no lifecycle completion'),fail:async()=>assert.fail('no lifecycle failure')};
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 globalThis.fetch=async(url,init)=>{calls.http.push({url:String(url),method:init.method});
  const fields=new URL(String(url)).searchParams.get('fields');
  assert.ok(['id,owner_business{id}','primary_funding_id','id,currency'].includes(fields));
  const value=status!==200?{error:{code:190,message:'secret provider error'}}:
   fields==='id,owner_business{id}'?{id:wabaId,owner_business:{id:'777777777'}}:
   fields==='primary_funding_id'?{id:wabaId,primary_funding_id:'finance-private'}:{id:wabaId,currency:'USD'};
  return new Response(JSON.stringify(value),{status});};
 const processor=new ConnectionOperationProcessor(repository,{resolve:async()=>{calls.secrets++;return {accessToken:token};}},{metaAppId:appId,metaGraphVersion:'v24.0',publicWebhookBaseUrl:'https://hooks.example.test'});
 const result=await processor.drainTenant(input.tenantId);return{calls,result,input};
}
test('PAUSED diagnostic uses exact owner, funding and optional currency GETs without lifecycle mutation',async t=>{
 const {calls,result}=await run(t);assert.equal(result.succeeded,1);assert.equal(calls.http.length,3);assert.ok(calls.http.every(x=>x.method==='GET'));
 assert.deepEqual(calls.http.map(x=>new URL(x.url).pathname),[`/v24.0/${wabaId}`,`/v24.0/${wabaId}`,`/v24.0/${wabaId}`]);
 assert.deepEqual(calls.http.map(x=>new URL(x.url).searchParams.get('fields')),['id,owner_business{id}','primary_funding_id','id,currency']);
 assert.equal(calls.complete[0].paymentMethod,'PRESENT');assert.equal(calls.fail.length,0);
});
test('Held/revoked diagnostic resolves no secret and performs no provider request',async t=>{
 const {calls}=await run(t,{guards:['HELD']});assert.equal(calls.secrets,0);assert.equal(calls.http.length,0);assert.equal(calls.complete[0].reason,'ACCESS_HELD');
});
test('New negative between reads blocks the next credentialed GET',async t=>{
 const {calls}=await run(t,{guards:['CURRENT','CURRENT','HELD']});assert.equal(calls.http.length,1);assert.equal(calls.complete[0].reason,'ACCESS_HELD');
});
test('New negative before optional currency read blocks that request without lifecycle mutation',async t=>{
 const {calls}=await run(t,{guards:['CURRENT','CURRENT','CURRENT','HELD']});
 assert.equal(calls.http.length,2);assert.deepEqual(calls.http.map(x=>new URL(x.url).searchParams.get('fields')),['id,owner_business{id}','primary_funding_id']);
 assert.equal(calls.complete[0].reason,'ACCESS_HELD');assert.equal(calls.fail.length,0);
});
test('Read authentication failure uses operation-only fail and never downgrades PAUSED',async t=>{
 const {calls,result}=await run(t,{status:401});assert.equal(result.failedTerminal,1);assert.equal(calls.fail.length,1);assert.equal(calls.fail[0].connectionState,'PAUSED');
 assert.ok(!JSON.stringify(calls.fail).includes('secret provider error'));
});
test('Lost diagnostic lease admits no credential/request or finalization',async t=>{
 const {calls,result}=await run(t,{leaseLost:true});assert.equal(result.leaseLost,1);assert.equal(calls.secrets,0);assert.deepEqual(calls.complete,[]);assert.deepEqual(calls.fail,[]);
});
test('Adapter owner permission denial is optional but guards are never swallowed',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;const fields=[];
 globalThis.fetch=async url=>{fields.push(new URL(String(url)).searchParams.get('fields'));return new Response(JSON.stringify(++calls===1?{error:{code:200,message:'forbidden'}}:{}),{status:calls===1?403:200});};
 const adapter=new MetaGroupsAdapter({accessToken:token,graphVersion:'v24.0',phoneNumberIdFor:()=>phoneId,wabaIdFor:()=>wabaId});
 assert.equal((await adapter.billingDiagnostic(wabaId)).paymentMethod,'NONE');assert.equal(calls,3);
 assert.deepEqual(fields,['id,owner_business{id}','primary_funding_id','id,currency']);
 const held=new MetaGroupsAdapter({accessToken:token,graphVersion:'v24.0',phoneNumberIdFor:()=>phoneId,wabaIdFor:()=>wabaId,beforeRequest:async()=>{throw new Error('held');}});
 await assert.rejects(()=>held.billingDiagnostic(wabaId),/held/);assert.equal(calls,3);
});

test('API diagnostics reject caller-selected account/payer before database or provider calls',async()=>{
 const controller=new ConnectionsController({withTenant:async()=>assert.fail('invalid diagnostic body must not reach DB')});
 for(const body of [{wabaId},{payer:'MANAGED'},null,[]])await assert.rejects(()=>controller.requestMetaBillingDiagnostic({},randomUUID(),'key',body),/do not accept/);
});
test('API operation replay is immutable and foreign/different-kind key fails closed',async()=>{
 const input=job(),request={id:'diagnostic-request',principal:{tenantId:input.tenantId,userId:randomUUID(),role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
 let replay={id:input.id,tenant_id:input.tenantId,connection_id:input.connectionId,operation_type:'VERIFY_META_BILLING',state:'SUCCEEDED',attempts:1,created_at:new Date(),payload:input.payload};
 const db={withTenant:async(tenant,fn)=>{assert.equal(tenant,input.tenantId);return fn({query:async(sql)=>{
  if(sql.includes('privileged_reauth_minutes'))return{rows:[{privileged_reauth_minutes:15}]};
  if(sql.includes('FROM connections'))return{rows:[{id:input.connectionId,name:'Diagnostic',provider:'META',state:'PAUSED',secret_reference:input.connectionSecretReference}]};
  if(sql.includes('FROM connection_operations'))return{rows:[replay]};
  assert.fail(`replay must not recapture binding or write: ${sql}`);
 }});}};
 const controller=new ConnectionsController(db,{}, {wakeConnection:async()=>assert.fail('terminal replay must not wake')});
 assert.equal((await controller.requestMetaBillingDiagnostic(request,input.connectionId,'existing-key',{})).duplicate,true);
 replay={...replay,connection_id:randomUUID()};await assert.rejects(()=>controller.requestMetaBillingDiagnostic(request,input.connectionId,'existing-key',{}),/another operation/);
});
