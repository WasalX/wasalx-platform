import {platformRequest} from '../lib/platform-client.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {isMetaTransitionExecutionView,metaTransitionIntentKey,metaTransitionIntentSettled,metaTransitionPendingActionMatches,parseMetaTransitionIntent,type MetaTransitionIntent} from '../lib/meta-transition-intent.ts';
import type {MetaTransitionExecutionView} from '../packages/core/src/meta-account-transition-contract.ts';

const operationId='33000000-0000-4000-8000-000000000009';
const intent:MetaTransitionIntent={schemaVersion:1,action:'INITIATE',requestRevision:4,previewSha256:'a'.repeat(64),key:'33000000-0000-4000-8000-000000000008',operationId:null};
const view=():MetaTransitionExecutionView=>({revision:7,state:'INITIATED',previewSha256:'a'.repeat(64),requestedMode:'CUSTOMER',sourceCurrency:'USD',targetCurrency:'SAR',impactConnectionCount:1,terms:null,renewals:[],completionApprovalRequired:false,
  actions:{initiate:false,complete:false,observe:true,reconcile:false,cancel:false},reasons:[],providerStatus:'INITIATED',history:[{stage:'INITIATE',outcome:'SUCCEEDED',attemptedAt:'2026-10-08T10:00:00Z'}],
  observedAt:'2026-10-08T10:00:00Z',pendingAction:{operationId,action:'INITIATE',state:'SUCCEEDED',requestRevision:4,requestKey:intent.key}});

test('transition uncertainty survives serialization without secrets or changed scope',()=>{
  assert.deepEqual(parseMetaTransitionIntent(JSON.stringify(intent)),intent);
  assert.equal(parseMetaTransitionIntent(null),null);
  assert.notEqual(metaTransitionIntentKey('a','one'),metaTransitionIntentKey('b','one'));
  assert.notEqual(metaTransitionIntentKey('a','one'),metaTransitionIntentKey('a','two'));
  for(const value of ['{',JSON.stringify({...intent,schemaVersion:2}),JSON.stringify({...intent,requestRevision:'4'}),JSON.stringify({...intent,previewSha256:'bad'}),
    JSON.stringify({...intent,key:'reusable-name'}),JSON.stringify({...intent,operationId:'bad'}),JSON.stringify({...intent,token:'must-not-be-retained'}),'x'.repeat(1025)])
    assert.throws(()=>parseMetaTransitionIntent(value),/META_TRANSITION_INTENT_UNAVAILABLE/u);
});
test('only the same immutable request revision and action terminal result settles uncertainty',()=>{
  assert.equal(metaTransitionIntentSettled(intent,view()),true);
  for(const state of ['FAILED_TERMINAL','CANCELLED'] as const)assert.equal(metaTransitionIntentSettled(intent,{...view(),pendingAction:{...view().pendingAction!,state}}),true);
  for(const pendingAction of [null,{...view().pendingAction!,state:'QUEUED'},{...view().pendingAction!,state:'RUNNING'},
    {...view().pendingAction!,action:'COMPLETE'},{...view().pendingAction!,requestRevision:5},
    {...view().pendingAction!,requestKey:'33000000-0000-4000-8000-000000000099'}])
    assert.equal(metaTransitionIntentSettled(intent,{...view(),revision:99,pendingAction}),false);
  assert.equal(metaTransitionIntentSettled({...intent,operationId},view()),true);
  assert.equal(metaTransitionIntentSettled({...intent,operationId:'33000000-0000-4000-8000-000000000099'},view()),false);
});
test('explicit no-effect resolution and GET share exact original-operation validation',()=>{
  const action=view().pendingAction!;
  for(const state of ['QUEUED','RUNNING','SUCCEEDED','FAILED_TERMINAL','CANCELLED'] as const)
    assert.equal(metaTransitionPendingActionMatches(intent,{...action,state}),true);
  for(const value of [null,{}, {...action,operationId:undefined},{...action,action:'COMPLETE'},{...action,requestRevision:5},
    {...action,state:'UNKNOWN_RAW_PROVIDER_VALUE'},{...action,operationId:'bad'},
    {...action,requestKey:undefined},{...action,requestKey:'bad'},{...action,requestKey:'33000000-0000-4000-8000-000000000099'}])
    assert.equal(metaTransitionPendingActionMatches(intent,value),false);
  assert.equal(metaTransitionPendingActionMatches({...intent,operationId:'33000000-0000-4000-8000-000000000099'},action),false);
});
test('malformed terminal projections never clear a pending provider action',()=>{
  for(const change of [{pendingAction:{action:'INITIATE',requestRevision:4,state:'SUCCEEDED'}},{pendingAction:{...view().pendingAction!,operationId:'not-a-persisted-id'}},
    {revision:'7'},{previewSha256:'arbitrary'},{actions:{initiate:true}},{providerStatus:'raw upstream text'},
    {history:[{stage:'INITIATE',outcome:'SUCCEEDED',attemptedAt:'unparsed'}]},{observedAt:'invalid'},
    {impactConnectionCount:-1},{state:'WORKING'},{requestedMode:'APPROVED_CARDHOLDER'},{targetCurrency:'sar'},{sourceCurrency:['USD']}]){
    assert.equal(isMetaTransitionExecutionView({...view(),...change}),false);
    assert.equal(metaTransitionIntentSettled(intent,{...view(),...change}),false);
  }
  assert.equal(isMetaTransitionExecutionView({...view(),reasons:['FUTURE_SAFE_REASON']}),true); // Displayed through the localized fallback only.
});
test('managed target terms use the existing bounded document contract',()=>{
  const documentText='Target account terms\nشروط الحساب المستهدف';
  const terms={documentText,documentSha256:createHash('sha256').update(documentText).digest('hex'),version:'2026-10.1'};
  assert.equal(isMetaTransitionExecutionView({...view(),requestedMode:'WASALX_MANAGED',terms}),true);
  assert.equal(isMetaTransitionExecutionView({...view(),requestedMode:'WASALX_MANAGED',terms:null}),true); // Readable held state; UI denies INITIATE.
  for(const change of [undefined,{}, {...terms,documentText:''},{...terms,documentText:'ع'.repeat(16_385)},
    {...terms,documentSha256:'B'.repeat(64)},{...terms,version:'terms <script>'},{...terms,version:'v'.repeat(129)}])
    assert.equal(isMetaTransitionExecutionView({...view(),terms:change}),false);
});

test('renewal projection is scoped display data and never settles an original uncertain action',()=>{
  const source={connectionId:'12000000-0000-4000-8000-000000000093',name:'Source <account>',canPrepare:true,access:'ORIGINAL'};
  assert.equal(isMetaTransitionExecutionView({...view(),renewals:[source],completionApprovalRequired:true}),true);
  for(const change of [{renewals:undefined},{renewals:{}},{renewals:[source,source]},
    {renewals:[{...source,connectionId:'provider-id'}]},{renewals:[{...source,canPrepare:'true'}]},
    {renewals:[{...source,name:{html:'<b>'}}]},{renewals:[{...source,access:'VERIFIED_READY'}]},
    {completionApprovalRequired:undefined},{completionApprovalRequired:'false'}])
    assert.equal(isMetaTransitionExecutionView({...view(),...change}),false);
  for(const pendingAction of [null,{...view().pendingAction!,state:'RUNNING'},
    {...view().pendingAction!,requestKey:'33000000-0000-4000-8000-000000000099'}])
    assert.equal(metaTransitionIntentSettled(intent,{...view(),revision:100,renewals:[{...source,access:'RENEWED'}],
      completionApprovalRequired:false,actions:{...view().actions,complete:true},pendingAction}),false);
});


test('the shared platform client keeps transition recovery scope distinct from sibling commands',async()=>{
  const original=globalThis.fetch,calls:Array<{url:string;headers:Headers;body:string|undefined}>=[];
  globalThis.fetch=async(input,init)=>{
    calls.push({url:String(input),headers:new Headers(init?.headers),body:typeof init?.body==='string'?init.body:undefined});
    return Response.json({accepted:true});
  };
  try{
    const operator={csrfToken:'synthetic-csrf',recoveryScope:'separate-platform-recovery'},tenant='12000000-0000-4000-8000-000000000093';
    const path=`operations/tenants/${tenant}/meta/account-transitions/${operationId}/review/completion`;
    await platformRequest(operator,path,{method:'POST',body:{confirmed:true},idempotencyKey:intent.key});
    assert.equal(calls[0]?.headers.get('x-wasalx-platform-recovery-scope'),operator.recoveryScope);
    assert.equal(calls[0]?.headers.get('x-wasalx-platform-csrf'),operator.csrfToken);
    assert.equal(calls[0]?.headers.get('idempotency-key'),intent.key);
    assert.equal(calls[0]?.body,JSON.stringify({confirmed:true}));
    await platformRequest(operator,`meta-costs/tenants/${tenant}/statements`,{method:'POST',body:{confirmed:true}});
    assert.equal(calls[1]?.headers.get('x-wasalx-platform-recovery-scope'),null);
    await platformRequest({csrfToken:operator.csrfToken},path);
    assert.equal(calls[2]?.headers.get('x-wasalx-platform-recovery-scope'),null,'Missing scope remains missing; server admission decides authorization');
  }finally{globalThis.fetch=original;}
});
