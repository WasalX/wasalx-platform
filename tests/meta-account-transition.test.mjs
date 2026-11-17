import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {parseMetaTransitionPreviewRequest,parseMetaTransitionPreviewAction} from '../packages/core/dist/meta-account-transition-contract.js';
import {evaluateMetaTransitionPreview} from '../packages/core/dist/meta-account-transition-preview.js';
import {metaTransitionObservation,publicMetaTransitionObservation} from '../packages/core/dist/meta-account-transition-observation.js';
import {readMetaTransitionInventory} from '../services/connector-worker/dist/packages/connectors/src/meta-account-transition-read.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
import {processMetaAccountTransitionPreview} from '../services/connector-worker/dist/services/connector-worker/src/meta-account-transition-processor.js';
import {ConnectionOperationLeaseLostError} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';

const request={requestedMode:'CUSTOMER',targetCurrency:'SAR',expectedAccountRevision:1,expectedBindingRevision:1};
const facts={currency:'USD',coexistence:'ABSENT',authorizedAgent:'ABSENT',adminAuthority:'VERIFIED',providerVersion:'QUALIFIED',
  phoneInventory:'COMPLETE',externalPhoneCount:0,localScopeCurrent:true,sourceTemplatesComplete:true,managedArrangement:'UNAVAILABLE',readsAvailable:true,bindingCurrent:true};
test('Account preview request cannot select provider accounts, solutions, credit lines or authority',()=>{
  assert.deepEqual(parseMetaTransitionPreviewRequest(request),request);
  for(const value of [null,[],{...request,targetCurrency:'sar'},{...request,targetCurrency:['SAR']},{...request,expectedBindingRevision:'1'},
    {...request,expectedAccountRevision:0},{...request,accountId:'123'},{...request,extended_credit_id:'123'},{...request,canExecute:true},
    {...request,requestedMode:'MANAGED'}])assert.throws(()=>parseMetaTransitionPreviewRequest(value));
  for(const value of [{expectedRevision:0},{expectedRevision:1,canCancel:true},null])assert.throws(()=>parseMetaTransitionPreviewAction(value));
});
test('Both payer modes remain previews; same-hierarchy new-model currency eligibility is not blanket denied',()=>{
  assert.deepEqual(evaluateMetaTransitionPreview(request,facts),{state:'PREVIEW',reasons:[],canExecute:false});
  const managed=evaluateMetaTransitionPreview({...request,requestedMode:'WASALX_MANAGED'},facts);
  assert.deepEqual(managed.reasons,['MANAGED_ARRANGEMENT_UNAVAILABLE']);assert.equal(managed.canExecute,false);
  assert.deepEqual(evaluateMetaTransitionPreview({...request,requestedMode:'WASALX_MANAGED'},{...facts,managedArrangement:'CURRENT'}),{state:'PREVIEW',reasons:[],canExecute:false});
  assert.ok(evaluateMetaTransitionPreview(request,{...facts,currency:'SAR'}).reasons.includes('SAME_CURRENCY_TRANSITION_UNSUPPORTED'));
  assert.ok(evaluateMetaTransitionPreview(request,{...facts,coexistence:'PRESENT'}).reasons.includes('COEXISTENCE_UNSUPPORTED'));
  assert.ok(evaluateMetaTransitionPreview(request,{...facts,authorizedAgent:'PRESENT'}).reasons.includes('AUTHORIZED_AGENT_UNSUPPORTED'));
  const unknown=evaluateMetaTransitionPreview(request,{...facts,coexistence:'UNVERIFIED',authorizedAgent:'UNVERIFIED',providerVersion:'UNQUALIFIED',sourceTemplatesComplete:false});
  assert.deepEqual(unknown.reasons,['ACCOUNT_VARIANT_UNVERIFIED','PROVIDER_VERSION_UNQUALIFIED','TEMPLATE_INVENTORY_INCOMPLETE']);
});
test('Bounded read carries only same-edge cursors and never follows provider URLs',async()=>{
  const calls=[];const result=await readMetaTransitionInventory('123',async(path,query)=>{calls.push({path,query});
    if(path==='/123')return{id:'123',currency:'USD'};
    if(path==='/123/message_templates')return{data:[]};
    return query.after?{data:[{id:'2'}]}:{data:[{id:'1'}],paging:{next:'https://foreign.invalid/with-private-token',cursors:{after:'next-cursor'}}};});
  assert.deepEqual(result,{sourceAccountId:'123',currency:'USD',phoneIds:['1','2'],phonesComplete:true,templatesComplete:true,templates:[]});
  assert.deepEqual(calls.map(c=>c.path),['/123','/123/phone_numbers','/123/phone_numbers','/123/message_templates']);assert.equal(calls[2].query.after,'next-cursor');
  await assert.rejects(()=>readMetaTransitionInventory('123',async()=>({id:'foreign'})),/MISMATCH/);
  for(const page of [{data:[{id:'1'},{id:'1'}]},{data:[{id:1}]},{data:[],paging:{next:'untrusted',cursors:{after:''}}},{data:[],paging:[]}]){
    const incomplete=await readMetaTransitionInventory('123',async path=>path==='/123'?{id:'123'}:path.endsWith('/message_templates')?{data:[]}:page);assert.equal(incomplete.phonesComplete,false);
  }
  let pages=0;const cycling=await readMetaTransitionInventory('123',async path=>path==='/123'?{id:'123'}:path.endsWith('/message_templates')?{data:[]}:{data:[{id:String(++pages)}],paging:{next:'untrusted',cursors:{after:'same'}}});
  assert.equal(cycling.phonesComplete,false);assert.equal(pages,2);
});
test('Production adapter inventory performs GET only through configured Meta origin and before-request admission',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});const events=[];
  globalThis.fetch=async(raw,init)=>{const url=new URL(raw);events.push(['http',url.origin,url.pathname,init.method]);
   if(url.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:'456'}]});
   if(url.pathname.endsWith('/message_templates'))return Response.json(url.searchParams.has('after')?{data:[]}:
    {data:[{id:'12',name:'order_update',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Private body'}]}],paging:{next:'https://foreign.invalid/?secret=no-follow',cursors:{after:'next'}}});
   return Response.json({id:'123',currency:'USD'});};
  const adapter=new MetaGroupsAdapter({accessToken:'synthetic-preview-token',graphVersion:'v24.0',phoneNumberIdFor:()=> '456',beforeRequest:async()=>events.push(['guard'])});
  const inventory=await adapter.transitionPreviewInventory('123');assert.equal(inventory.templatesComplete,true);assert.equal(inventory.templates.length,1);
  assert.deepEqual(events.map(e=>e[0]),['guard','http','guard','http','guard','http','guard','http']);
  assert.ok(events.filter(e=>e[0]==='http').every(e=>e[1]==='https://graph.facebook.com'&&e[3]==='GET'));
  assert.ok(events.every(e=>!JSON.stringify(e).includes('synthetic-preview-token')));
});
test('Unavailable observations are whitelisted, reject malformed time and never expose private facts',()=>{
  const value=metaTransitionObservation(request,null,null,new Date('2026-10-08T00:00:00Z'));
  const safe=publicMetaTransitionObservation({...value,token:'private',scope:{secretReference:'private'}});
  assert.deepEqual(safe,value);assert.equal(safe.canExecute,false);assert.equal(safe.current.actualPayer,'UNVERIFIED');
  for(const patch of [{expiresAt:'invalid'},{expiresAt:value.observedAt},{canExecute:true},{reasons:['UNKNOWN_FUTURE']},
    {current:{...value.current,actualPayer:'CUSTOMER'}}])assert.equal(publicMetaTransitionObservation({...value,...patch}),null);
});
test('Stale preview guard resolves no token and completes a held read without lifecycle application',async()=>{
  const job={id:randomUUID()},frame={context:null,current:false,revision:1,request};let completed;
  const result=await processMetaAccountTransitionPreview(job,'lease',{guardMetaTransitionPreview:async()=>frame,
    completeMetaTransitionPreview:async(_j,_l,_a,observation)=>{completed=observation;}},async()=>assert.fail('No secret lookup on stale context'),'app','v24.0');
  assert.equal(result,'succeeded');assert.equal(completed.state,'BLOCKED');assert.ok(completed.reasons.includes('CURRENT_BINDING_CHANGED'));
});
test('Losing the original operation lease does not create a replacement preview or retry',async()=>{
  let completed=0;const result=await processMetaAccountTransitionPreview({},'old',{guardMetaTransitionPreview:async()=>{throw new ConnectionOperationLeaseLostError();},
    completeMetaTransitionPreview:async()=>{completed++;}},async()=>assert.fail('No token after lost lease'),'app','v24.0');
  assert.equal(result,'lease-lost');assert.equal(completed,0);
});

test('A changed admission between actual template pages stops HTTP and completes one safe unavailable preview',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const token='synthetic-pagination-token',appId='12025550130',events=[];let guards=0,completions=0,completed;
 const proof={graphVersion:'v24.0',credentialFingerprint:createHash('sha256').update(token).digest('hex'),
  credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const context={providerAccountId:'123',scopeSha256:'a'.repeat(64),session:{opaqueSessionId:'456',providerStateData:{metaAccountProof:proof}},
  declaredMode:'CUSTOMER',phoneIds:['456'],scope:[],templateDependencies:[],metaFlowDependencies:[]};
 globalThis.fetch=async(raw,init)=>{const url=new URL(raw);events.push({path:url.pathname,after:url.searchParams.get('after'),method:init.method});
  if(url.pathname.endsWith('/message_templates')){assert.equal(url.searchParams.has('after'),false,'Revoked page two must never reach transport');return Response.json({data:[],paging:{next:'https://foreign.invalid/private',cursors:{after:'next'}}});}
  return Response.json(url.pathname.endsWith('/phone_numbers')?{data:[{id:'456'}]}:{id:'123',currency:'USD'});
 };
 const result=await processMetaAccountTransitionPreview({id:randomUUID()},'lease',{
  guardMetaTransitionPreview:async()=>({request,current:true,revision:1,context:++guards===5?null:context}),
  completeMetaTransitionPreview:async(_job,_lease,_app,value)=>{completions++;completed=value;},
 },async()=>token,appId,'v24.0');
 assert.equal(result,'succeeded');assert.equal(guards,5);assert.equal(events.length,3);assert.equal(completions,1);
 assert.ok(events.every(event=>event.method==='GET'&&event.after===null));
 assert.equal(completed.state,'BLOCKED');assert.equal(completed.impact.sourceTemplateCount,null);assert.equal(completed.canExecute,false);
 assert.ok(completed.reasons.includes('PROVIDER_READ_UNAVAILABLE'));assert.equal(JSON.stringify(completed).includes(token),false);
});
