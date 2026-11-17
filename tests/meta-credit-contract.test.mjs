import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {ProviderError} from '../services/connector-worker/dist/packages/connectors/src/types.js';
const token='synthetic-financial-token-only';
function adapter(extra={}){return new MetaGroupsAdapter({accessToken:token,graphVersion:'v26.0',phoneNumberIdFor:()=> '55555',...extra});}
test('Credit attach is checkpointed at exact request, uses documented fields, and readback requires receiving credential object',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});const observed=[];
 globalThis.fetch=async(url,init)=>{const value=new URL(url);observed.push({kind:'http',method:init.method,url:value.toString()});
  assert.equal(value.searchParams.has('access_token'),false);assert.equal(init.headers.authorization,`Bearer ${token}`);
  return Response.json(value.pathname.endsWith('/whatsapp_credit_sharing_and_attach')?{allocation_config_id:'777',waba_id:'888'}:{id:'777',receiving_credential:{id:'credential.1'}});};
 const client=adapter({beforeRequest:async()=>observed.push({kind:'guard'}),beforeFinancialMutation:async sha=>observed.push({kind:'checkpoint',sha})});
 assert.deepEqual(await client.attachApprovedCreditLine('666','888','USD'),{allocationConfigId:'777',messagingAccountId:'888'});
 assert.deepEqual(observed.map(v=>v.kind),['guard','checkpoint','http']);
 assert.equal(new URL(observed[2].url).searchParams.get('waba_currency'),'USD');
 assert.equal(observed[1].sha,createHash('sha256').update(JSON.stringify({method:'POST',url:observed[2].url,body:null})).digest('hex'));
 assert.deepEqual(await client.readCreditAllocation('777'),{allocationConfigId:'777',receivingCredential:'credential.1'});
 assert.equal(observed.filter(v=>v.kind==='checkpoint').length,1);
});
test('Unapproved or freshly denied credit mutation is known not attempted and sends zero HTTP',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let http=0;globalThis.fetch=async()=>{http++;return Response.json({success:true});};
 for(const client of [adapter(),adapter({beforeFinancialMutation:async()=>{throw new ProviderError('Current funding approval held',false,'META_CREDIT_NOT_ATTEMPTED',undefined,true);}})])
  await assert.rejects(()=>client.attachApprovedCreditLine('666','888','USD'),e=>e.code==='META_CREDIT_NOT_ATTEMPTED'&&e.outcomeKnown===true);
 await assert.rejects(()=>adapter().revokeApprovedCreditAllocation('777'),e=>e.code==='META_CREDIT_NOT_ATTEMPTED'&&e.outcomeKnown===true);assert.equal(http,0);
});
test('Credit POST malformed success is UNKNOWN and cannot become a known safe retry',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let count=0;
 for(const result of [{},[],{allocation_config_id:'777',waba_id:'foreign'}]){
  globalThis.fetch=async()=>{count++;return Response.json(result);};
  await assert.rejects(()=>adapter({beforeFinancialMutation:async()=>{}}).attachApprovedCreditLine('666','888','USD'),e=>e.outcomeKnown===false);
 }
 assert.equal(count,3);
});
test('Allocation revocation requires exact holder/business record and exact DELETED business readback',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let response={id:'777',receiving_business:{id:'999'}};
 globalThis.fetch=async url=>{const value=new URL(url);assert.equal(value.searchParams.has('access_token'),false);return Response.json(response);};
 const client=adapter({beforeFinancialMutation:async()=>{}});
 assert.deepEqual(await client.readOwningCreditAllocation('666','999','777'),{allocationConfigId:'777',receivingBusinessId:'999'});
 response={id:'777',receiving_business:{id:'foreign'}};
 await assert.rejects(()=>client.readOwningCreditAllocation('666','999','777'),e=>e.outcomeKnown===true);
 response={receiving_business:{id:'999'},request_status:'DELETED'};
 assert.deepEqual(await client.readCreditAllocationRevocation('777','999'),{allocationConfigId:'777',deleted:true,requestStatus:'DELETED'});
 response={request_status:'DELETED'};await assert.rejects(()=>client.readCreditAllocationRevocation('777','999'),e=>e.outcomeKnown===true);
});

test('MPS authority belongs to the exact accepted app, not the other partner permissions',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 let selectedPermissions=['MANAGE_BILLING'],state='ACTIVE',accepted='ACCEPTED';
 globalThis.fetch=async raw=>{
  const url=new URL(String(raw));
  return Response.json(url.searchParams.get('fields')==='name,status,partners'
   ?{id:'700',name:'Synthetic MPS',status:state,partners:{data:[{partner_app:{id:'800'},status:accepted}]}}
   :{id:'700',name:'Synthetic MPS',owner_permissions:['MANAGE_BILLING'],partners:{data:[{partner_app:{id:'800'},partner_permissions:selectedPermissions}]}});
 };
 const client=adapter();
 assert.deepEqual(await client.readPartnerSolutionAuthority('700','800'),{solutionId:'700',appId:'800',state:'ACTIVE',billingPermission:'MANAGE_BILLING'});
 selectedPermissions=['MANAGE','MESSAGING'];await client.readPartnerSolutionAuthority('700','800');
 for(const permissions of [[],['MANAGE'],['MESSAGING']]){
  selectedPermissions=permissions;await assert.rejects(()=>client.readPartnerSolutionAuthority('700','800'),e=>e.outcomeKnown===true);
 }
 selectedPermissions=['MANAGE_BILLING'];accepted='PENDING';await assert.rejects(()=>client.readPartnerSolutionAuthority('700','800'));
 accepted='ACCEPTED';state='INACTIVE';await assert.rejects(()=>client.readPartnerSolutionAuthority('700','800'));
 state='ACTIVE';await assert.rejects(()=>client.readPartnerSolutionAuthority('700','801'));
});
