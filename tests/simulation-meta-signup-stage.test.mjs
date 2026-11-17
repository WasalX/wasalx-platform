import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {inspect} from 'node:util';
import {assertFreshSignup,assertFreshCoexistence,assertSignupOutcome,runFiniteSignup,runFiniteCoexistence,signupModes,validateSignupStageConfig} from '../scripts/release/simulation-meta-signup-stage.mjs';

const attemptId='00000000-0000-4000-8000-000000000001',connectionId='00000000-0000-4000-8000-000000000002',operationId='00000000-0000-4000-8000-000000000003';
const challenge='C'.repeat(43),code='D'.repeat(43),digest=createHash('sha256').update(code).digest('hex');
function fixture(mode,{lostExchange=false,immediateTerminal=false}={}){
 const effects=[],checkpoints=[],expected={appId:'100000000024003',configId:'100000000024006',displayPhoneNumber:'15555550200'};
 const provider={evidenceClass:'simulated-provider-signup',binding:{phoneId:'100000000024001',wabaId:'100000000024002'},phoneStatus:'PENDING',code:null,exchangeReceipts:[],registration:null,registrationAttempts:0,armedFault:null,faultEvents:[]};
 let view={attemptId,revision:1,status:'AWAITING_AUTHORIZATION',challenge,readiness:{authorization:'PENDING',number:'PENDING',subscription:'PENDING',messaging:'UNKNOWN',payment:{requestedPayer:'CUSTOMER',status:'UNKNOWN',paymentMethodVerified:false}}};
 const control=async(method,path,body)=>{
  if(method==='GET'){assert.equal(path,'/signup');return structuredClone(provider);}
  effects.push(path);
  if(path==='/signup/code'){assert.equal(provider.code,null);provider.code={sha256:digest,consumedAt:null};return{code,expiresAt:Date.now()+30000};}
  assert.equal(path,'/signup/fault');assert.equal(provider.armedFault,null);
  if(body.phase==='exchange')assert(provider.code&&provider.code.consumedAt===null);
  provider.armedFault=body;return{armed:true};
 };
 const request=async(path,method='GET',body)=>{
  if(method==='GET')return path.endsWith('/capabilities')?{enabled:true,payerModes:['CUSTOMER'],sdk:{appId:expected.appId,configId:expected.configId,graphVersion:'v24.0'}}:structuredClone(view);
  effects.push(path);
  if(path.endsWith('/attempts')){assert.equal(body.payerMode,'CUSTOMER');return structuredClone(view);}
  if(path.endsWith('/exchange')){
   assert.equal(body.code,code);assert.equal(body.challenge,challenge);assert.equal(body.expectedRevision,1);
   const acceptedAt=Date.now();provider.code.consumedAt=acceptedAt;provider.exchangeReceipts.push({sequence:1,codeSha256:digest,acceptedAt});
   if(provider.armedFault){provider.faultEvents.push({...provider.armedFault,outcome:'ACCEPTED_DISCONNECTED'});provider.armedFault=null;}
   view={...view,challenge:undefined,revision:3,status:mode==='exchange-unknown'?'OUTCOME_UNKNOWN':'SELECTION_REQUIRED',reasonCode:mode==='exchange-unknown'?'META_SIGNUP_EXCHANGE_UNKNOWN':undefined,selectionRevision:1,choices:[{choiceId:'opaque-choice',mode:'STANDARD',numberState:'REGISTRATION_REQUIRED',selectable:true,displayPhoneNumber:expected.displayPhoneNumber}]};
   if(lostExchange)throw Error('Browser outcome unavailable');return structuredClone(view);
  }
  assert(path.endsWith('/select'));assert.deepEqual(body,{expectedRevision:3,selectionRevision:1,choiceId:'opaque-choice'});
  provider.registrationAttempts++;provider.registration={acceptedAt:Date.now(),pinSha256:'private-pin-hash'};provider.phoneStatus='CONNECTED';
  if(provider.armedFault){provider.faultEvents.push({...provider.armedFault,outcome:'ACCEPTED_DISCONNECTED'});provider.armedFault=null;}
  view={...view,revision:5,connectionId,operationId,status:mode==='happy'?'COMPLETED':'OUTCOME_UNKNOWN',reasonCode:mode==='happy'?undefined:'META_SIGNUP_REGISTRATION_UNKNOWN',readiness:{...view.readiness,authorization:'VERIFIED',...(mode==='happy'?{number:'REGISTERED',subscription:'CONFIRMED',messaging:'AVAILABLE'}:{})}};
  return{...structuredClone(view),status:immediateTerminal?view.status:'PROVISIONING'};
 };
 const observe=async current=>({attempt:{id:attemptId,status:current.status,reason_code:current.reasonCode,connection_id:current.connectionId??null,operation_id:current.operationId??null,exchange_claimed:true,credential_stored:mode!=='exchange-unknown',registration_claimed:mode!=='exchange-unknown'},
  operations:current.operationId?[{id:operationId,connection_id:connectionId,operation_type:'PROVISION',state:mode==='happy'?'SUCCEEDED':'FAILED_TERMINAL',attempts:1,lease_id:null,error_code:current.reasonCode,signup_ready:mode==='happy'}]:[],
  connection:current.connectionId?{id:connectionId,state:mode==='happy'?'WORKING':'ACTION_REQUIRED',session_state:'WORKING',ownership_state:'ACTIVE',phone_id:provider.binding.phoneId,waba_id:provider.binding.wabaId,signup_attempt_id:attemptId,route_state:'ACTIVE'}:null});
 return{mode,namespace:'signup-case',expected,request,control,observe,poll:async(read,accept)=>{const result=await read();assert(accept(result));return result;},checkpoint:async row=>checkpoints.push(row),effects,checkpoints,provider,get view(){return view;}};
}

for(const mode of signupModes.filter(mode=>!mode.startsWith('coex-')))test(`finite signup ${mode} uses one code and preserves terminal effect history`,async()=>{
 const f=fixture(mode),proof=await runFiniteSignup(f);
 assert.equal(proof.status,mode==='happy'?'COMPLETED':'OUTCOME_UNKNOWN');
 assert.equal(f.effects.filter(path=>path.endsWith('/exchange')).length,1);
 assert.equal(f.effects.filter(path=>path==='/signup/code').length,1);
 assert.equal(f.effects.filter(path=>path.endsWith('/select')).length,mode==='exchange-unknown'?0:1);
 assert.equal(proof.registrationAttempts,mode==='exchange-unknown'?0:1);
 const evidence=JSON.stringify({proof,checkpoints:f.checkpoints});
 for(const secret of [challenge,code,digest,'private-pin-hash'])assert(!evidence.includes(secret));
 const before=f.effects.length;await assert.rejects(runFiniteSignup(f));assert.equal(f.effects.length,before,'Consumed provider context cannot restart');
});

test('browser exchange outcome failure stops immediately without reissuing or selecting',async()=>{
 const f=fixture('happy',{lostExchange:true});await assert.rejects(runFiniteSignup(f),/Browser outcome unavailable/);
 assert.equal(f.provider.exchangeReceipts.length,1);assert.equal(f.provider.registrationAttempts,0);
 assert.equal(f.effects.filter(path=>path.endsWith('/exchange')).length,1);assert(!f.effects.some(path=>path.endsWith('/select')));
});

test('worker completion before selection returns is read back without another operation',async()=>{
 const f=fixture('happy',{immediateTerminal:true});const proof=await runFiniteSignup(f);
 assert.equal(proof.status,'COMPLETED');assert.equal(f.effects.filter(path=>path.endsWith('/select')).length,1);
});

test('unknown is not accepted as a successful registration or replay-free proof',async()=>{
 const f=fixture('registration-unknown');await runFiniteSignup(f);const db=await f.observe(f.view);
 assert.throws(()=>assertSignupOutcome('happy',f.view,f.provider,db));
 assert.throws(()=>assertSignupOutcome(f.mode,f.view,{...f.provider,registrationAttempts:2},db));
 assert.throws(()=>assertSignupOutcome(f.mode,f.view,{...f.provider,code:{}},db));
 assert.throws(()=>assertSignupOutcome(f.mode,f.view,f.provider,{...db,operations:[{...db.operations[0],state:'FAILED_RETRYABLE'}]}));
 assert.throws(()=>assertSignupOutcome(f.mode,f.view,f.provider,{...db,operations:[{...db.operations[0],lease_id:operationId}]}));
});

test('stage refuses unknown modes, unbound catalog IDs and previously issued code',()=>{
 assert.throws(()=>validateSignupStageConfig({mode:'all',testId:'reviewed'}));
 assert.throws(()=>validateSignupStageConfig({mode:'happy'}));
 assert.doesNotThrow(()=>validateSignupStageConfig({mode:'happy',testId:'reviewed'}));
 const f=fixture('happy');assertFreshSignup(f.provider);
 assert.throws(()=>assertFreshSignup({...f.provider,code:{sha256:digest,consumedAt:null}}));
});

test('unexpected registration after unknown exchange does not expose private registration data',async()=>{
 const marker='SYNTHETIC_PRIVATE:PIN_HASH:MUST_NOT_ESCAPE',f=fixture('exchange-unknown');
 await runFiniteSignup(f);const db=await f.observe(f.view);
 assert.throws(()=>assertSignupOutcome(f.mode,f.view,{...f.provider,registration:{acceptedAt:Date.now(),pinSha256:marker}},db),error=>{
  const serialized=error.message+'\n'+error.stack+'\n'+JSON.stringify(error,Object.getOwnPropertyNames(error))+'\n'+inspect(error)+'\n'+JSON.stringify(f.checkpoints);
  for(const secret of [marker,challenge,code,digest])assert(!serialized.includes(secret));
  assert.equal(error.cause,undefined);assert.equal(error.message,'Unexpected signup registration after unknown exchange');return true;
 });
});

for(const fault of ['challenge','code','binding'])test(`signup ${fault} rejection serializes no private value`,async()=>{
 const marker='SYNTHETIC_PRIVATE:'+fault+':MUST_NOT_ESCAPE',f=fixture('happy');
 const request=f.request,control=f.control;
 f.request=async(path,method,body)=>{
  const result=await request(path,method,body);
  return fault==='challenge'&&method==='POST'&&path.endsWith('/attempts')?{...result,challenge:marker}:result;
 };
 f.control=async(method,path,body)=>{
  const result=await control(method,path,body);
  if(fault==='code'&&path==='/signup/code')return{...result,code:marker};
  if(fault==='binding'&&method==='GET'&&result.registration)return{...result,binding:{...result.binding,credentialSha256:marker}};
  return result;
 };
 await assert.rejects(runFiniteSignup(f),error=>{
  const serialized=error.message+'\n'+error.stack+'\n'+JSON.stringify(error,Object.getOwnPropertyNames(error))+'\n'+inspect(error)+'\n'+JSON.stringify(f.checkpoints);
  for(const secret of [marker,challenge,code,digest,'private-pin-hash'])assert(!serialized.includes(secret));
  assert.equal(error.cause,undefined);assert.match(error.message,/Signup (challenge|code|provider binding)/u);return true;
 });
 if(fault!=='binding')assert(!f.effects.some(path=>path.endsWith('/exchange')),'Malformed secret must fail before exchange');
});

function coexistenceFixture(mode,{fault,providerExpiry=false}={}){
 const expected={configId:'100000000024006',businessAppConfigId:'100000000024007'},customer='12025550173',businessPhone='15555550200';
 const provider={evidenceClass:'simulated-provider-signup',binding:{mode},phoneStatus:'CONNECTED',code:null,exchangeReceipts:[],registration:null,registrationAttempts:0,armedFault:null,faultEvents:[],sync:{attempts:[],requests:{contacts:null,history:null}}};
 const effects=[],checkpoints=[],messages=new Map(),pendingMedia=new Map(),contacts=[],chunks=new Set();let renewal=false,uiReads=0,faultInjected=false;
 const ordinaryEffects={normalized_messages:0,message_links:0,bot_conversations:0,delivery_outbox:0,participant_identities:0,meta_direct_identity_aliases:0};
 let view,context,stopped=false,deleted=false,connection={state:'WORKING'};
 const receipt=(kind,outcome)=>{provider.sync.attempts.push({kind});provider.sync.requests[kind]={requestId:'SIMSYNC-'+kind,outcome};};
 const summary=()=>({revision:context.revision,contactsRequest:context.contacts_request.state,historyRequest:context.history_request.state,historyObservation:context.history_observation});
 const control=async(method,path,body)=>{
  if(method==='GET')return structuredClone(provider);effects.push(path);
  if(path==='/signup/code'){assert(body.renewal===undefined||renewal);provider.code={consumedAt:null};return{code,expiresAt:Date.now()+30000};}
  assert.equal(path,'/signup/sync-release');const r=provider.sync.requests[body.kind];assert.equal(r.outcome,'HOLD');r.outcome='RELEASED';context[body.kind+'_request'].state='ACCEPTED';
  if(body.kind==='contacts'){receipt('history','HOLD');context.history_request.state='CLAIMED';}return{released:true};
 };
 const request=async(path,method='GET',body)=>{
  if(method==='GET'){
   if(path.startsWith('/api/privacy/requests/'))return{state:'SUCCEEDED'};
   if(path.endsWith('/capabilities'))return{enabled:true,businessAppEnabled:true};
   if(path.endsWith('/meta/coexistence'))return summary();
   if(path.endsWith('/contacts'))return{items:contacts.length?[{threadId:'a'.repeat(64),phone:customer}]:[]};
   if(path.endsWith('/messages'))return{items:[...messages.values()].map(row=>({source:row.source}))};
   return structuredClone(view);
  }
  effects.push(path);
  if(path==='/api/privacy/requests'){assert.deepEqual(body,{requestType:'DELETE',scopeType:'PARTICIPANT',scopeValue:customer,confirmation:'DELETE'});deleted=true;messages.clear();contacts.length=0;return{id:'00000000-0000-4000-8000-000000000005'};}
  if(path.endsWith('/consent')){assert.equal(body.expectedRevision,context.revision);stopped=true;context.revision++;return{...summary(),consent:{history:false,contacts:false,echoes:false}};}
  if(path.endsWith('/pause')){connection={state:'PAUSED'};return{accepted:true};}
  if(path.endsWith('/attempts')){
   renewal=!!body.targetConnectionId;
   if(renewal){assert.equal(body.variant,undefined);assert.equal(body.coexistenceConsent,undefined);}
   else assert.deepEqual(body.coexistenceConsent,{version:'2026-10-07',contacts:mode!=='coex-history-declined',history:true,echoes:true});
   view={attemptId:renewal?'00000000-0000-4000-8000-000000000004':attemptId,revision:1,status:'AWAITING_AUTHORIZATION',challenge,
    sdk:renewal?{configId:expected.configId}:{configId:expected.businessAppConfigId,extras:{featureType:'whatsapp_business_app_onboarding'}},...(renewal?{target:{mode:'COEXISTENCE'}}:{})};
  }else if(path.endsWith('/exchange')){
   assert.equal(body.code,code);provider.code.consumedAt=Date.now();provider.exchangeReceipts.push({sequence:provider.exchangeReceipts.length+1});
   view={...view,revision:2,status:'SELECTION_REQUIRED',selectionRevision:1,choices:[{choiceId:'coex-choice',mode:'COEXISTENCE',numberState:'REGISTERED',selectable:true}]};
  }else{
   assert(path.endsWith('/select'));assert.equal(body.registrationPin,undefined);
   view={...view,revision:3,status:'COMPLETED',connectionId,...(renewal?{outcome:'ACCESS_RENEWED_PAUSED'}:{})};
   if(renewal){context={...context,credential_fingerprint:'new-fingerprint',revision:context.revision+1};return structuredClone(view);}
   const unknown=['coex-contacts-unknown','coex-renewal'].includes(mode),expired=mode==='coex-expired',held=mode==='coex-success';
   context={id:'context-fixture',revision:1,credential_fingerprint:'original-fingerprint',contacts_request:{state:mode==='coex-history-declined'?'NOT_REQUESTED':expired?'EXPIRED':unknown?'UNKNOWN':held?'CLAIMED':'ACCEPTED'},
    history_request:{state:expired?'EXPIRED':unknown?'HELD_CONTACTS_UNKNOWN':held?'QUEUED':'ACCEPTED'},history_observation:'WAITING',processed_chunks:0};
   if(!expired){if(mode!=='coex-history-declined')receipt('contacts',unknown?'DISCONNECT':held?'HOLD':'ACCEPT');if(!unknown&&!held)receipt('history','ACCEPT');}
   if(unknown&&fault==='forbidden-history'){receipt('history','ACCEPT');faultInjected=true;}
   if(expired&&providerExpiry){context.contacts_request.state='REJECTED';context.history_request.state='REJECTED';provider.sync.attempts.push({kind:'contacts'},{kind:'history'});}
   if(expired&&['expired-contacts','expired-history'].includes(fault)){receipt(fault.slice(8),'ACCEPT');faultInjected=true;}
  }
  return structuredClone(view);
 };
 const dispatch=async(field,data,label,expectedStatus=200)=>{
  effects.push(label);
  if(stopped){assert.equal(expectedStatus,404);if(fault==='stop-effect'){ordinaryEffects.bot_conversations=1;faultInjected=true;}return;}
  if(deleted){if(fault==='privacy-effect'){ordinaryEffects.delivery_outbox=1;faultInjected=true;}return;}
  if(field==='smb_app_state_sync'&&mode==='coex-history-declined'){assert.equal(expectedStatus,404);return;}
  if(field==='smb_app_state_sync'){contacts.push({subject_digest:'subject'});return;}
  if(field==='history'&&data.messages){for(const message of data.messages)pendingMedia.set(message.id,message.image.id);return;}
  if(field==='history'&&data.history[0].errors){context.history_observation='DECLINED';return;}
  const items=field==='smb_message_echoes'?data.message_echoes:data.history.flatMap(chunk=>chunk.threads.flatMap(thread=>thread.messages));
  for(const message of items){if(messages.has(message.id)){if(field==='smb_message_echoes')messages.get(message.id).echo_observed=true;}
   else messages.set(message.id,{external_message_id:message.id,source:field==='smb_message_echoes'?'ECHO':'HISTORY',echo_observed:false,...(pendingMedia.has(message.id)?{media_id:pendingMedia.get(message.id)}:{})});}
  if(field==='history'){const meta=data.history[0].metadata;chunks.add(meta.phase+':'+meta.chunk_order);context.processed_chunks=chunks.size;if(meta.phase===2&&meta.progress===100)context.history_observation='PROVIDER_FINISHED';}
 };
 const observe=async()=>structuredClone({context,connection,operations:[],importedMessages:[...messages.values()],importedContacts:contacts,pendingImports:0,cutoffCount:deleted?1:0,effects:ordinaryEffects});
 return{mode,namespace:'coex-test',expected,customer,businessPhone,control,request,dispatch,observe,
  poll:async(read,accept)=>{const value=await read();assert(accept(value),'Finite fixture must satisfy the intended observation');return value;},
  checkpoint:async row=>{checkpoints.push(structuredClone(row));},uiRead:async()=>{uiReads++;},provider,effects,checkpoints,get uiReads(){return uiReads;},get faultInjected(){return faultInjected;}};
}

for(const mode of signupModes.filter(mode=>mode.startsWith('coex-')))test(`finite ${mode} preserves consent, one-shot receipts and inert observations`,async()=>{
 const f=coexistenceFixture(mode),proof=await runFiniteCoexistence(f);
 assert.equal(proof.registrationAttempts,0);assert.equal(proof.zeroLiveEffects,true);
 assert.equal(f.effects.filter(path=>path.endsWith('/select')).length,mode==='coex-renewal'?2:1);
 assert.equal(f.provider.sync.attempts.length,mode==='coex-expired'?0:['coex-renewal','coex-contacts-unknown','coex-history-declined'].includes(mode)?1:2);
 if(['coex-renewal','coex-contacts-unknown'].includes(mode)){assert.equal(proof.contactsRequest,'UNKNOWN');assert.equal(proof.historyRequest,'HELD_CONTACTS_UNKNOWN');}
 assert.equal(f.uiReads,mode==='coex-success'?2:['coex-renewal','coex-contacts-unknown'].includes(mode)?1:0);
 const before=f.effects.length;await assert.rejects(()=>runFiniteCoexistence(f));assert.equal(f.effects.length,before);
});

test('expired coexistence can retain bounded rejected provider attempts without accepted receipts',async()=>{
 const f=coexistenceFixture('coex-expired',{providerExpiry:true}),proof=await runFiniteCoexistence(f);
 assert.equal(proof.contactsRequest,'REJECTED');assert.equal(proof.historyRequest,'REJECTED');assert.equal(proof.providerAttempts,2);
 assert.deepEqual(f.provider.sync.requests,{contacts:null,history:null});assert.equal(proof.zeroLiveEffects,true);
});

for(const mode of ['coex-contacts-unknown','coex-renewal'])test(`${mode} cannot pass when history was dispatched behind held local state`,async()=>{
 const f=coexistenceFixture(mode,{fault:'forbidden-history'});
 await assert.rejects(()=>runFiniteCoexistence(f),/Unknown contacts must never dispatch history/);
 assert.equal(f.faultInjected,true);const observed=await f.observe();
 assert.equal(observed.context.contacts_request.state,'UNKNOWN');assert.equal(observed.context.history_request.state,'HELD_CONTACTS_UNKNOWN');
 assert(!f.checkpoints.some(row=>row.phase==='coexistence-readback'));
});

for(const kind of ['contacts','history'])test(`expired coexistence cannot pass with an accepted ${kind} receipt`,async()=>{
 const f=coexistenceFixture('coex-expired',{fault:'expired-'+kind});
 await assert.rejects(()=>runFiniteCoexistence(f),/Expired sync must have no accepted receipt/);
 assert.equal(f.faultInjected,true);const observed=await f.observe();
 assert.equal(observed.context.contacts_request.state,'EXPIRED');assert.equal(observed.context.history_request.state,'EXPIRED');
 assert(!f.checkpoints.some(row=>row.phase==='coexistence-readback'));
});

for(const fault of ['privacy-effect','stop-effect'])test(`coexistence cannot pass with a late ${fault}`,async()=>{
 const f=coexistenceFixture('coex-success',{fault});
 await assert.rejects(()=>runFiniteCoexistence(f),/Final import\/privacy\/stop readback must stay outside ordinary effects/);
 assert.equal(f.faultInjected,true);const observed=await f.observe();
 assert.deepEqual(observed.importedMessages,[]);assert.deepEqual(observed.importedContacts,[]);
 assert(Object.values(observed.effects).some(value=>value!==0));assert(!f.checkpoints.some(row=>row.phase==='coexistence-readback'));
});

test('coexistence public config and consumed fixture are not replayable inputs',()=>{
 for(const mode of signupModes.filter(mode=>mode.startsWith('coex-'))){
  assert.doesNotThrow(()=>validateSignupStageConfig({mode,testId:'reviewed-existing-catalog-entry'}));
  assert.throws(()=>validateSignupStageConfig({mode,testId:'reviewed-existing-catalog-entry',coexistence:{contacts:'ACCEPT'}}));
 }
 const f=coexistenceFixture('coex-success');assertFreshCoexistence(f.provider);
 for(const change of [{phoneStatus:'PENDING'},{registrationAttempts:1},{code:{sha256:'private-marker'}},{sync:{attempts:[{kind:'contacts'}],requests:{contacts:null,history:null}}}])assert.throws(()=>assertFreshCoexistence({...f.provider,...change}));
});


// Source-bound client transport tests, with an inert request double. No socket,
// browser, simulator process or provider is started by these cases.
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
async function privateControlFixture(){
 const source=await readFile(new URL('../scripts/release/simulation-meta-signup-stage.mjs',import.meta.url),'utf8');
 const start=source.indexOf('export function signupControl('),end=source.indexOf('export function assertSignupOutcome(',start);assert(start>=0&&end>start);
 const calls=[];let failure=false;
 const httpRequest=(options,receive)=>{calls.push(options);const q=new EventEmitter();q.destroy=()=>q.emit('error',Error('PRIVATE_MARKER'));q.end=bytes=>{
  calls.at(-1).bytes=bytes;const response=new EventEmitter();response.statusCode=failure?503:200;receive(response);
  response.emit('data',Buffer.from(failure?'PRIVATE_MARKER':'{"observed":true}'));response.emit('end');
 };return q;};
 const control=runInNewContext(source.slice(start,end).replace('export function','function')+';signupControl',{assert,httpRequest,Buffer,Error,JSON});
 return{control,calls,fail:()=>{failure=true;}};
}
const finiteControlCalls=[
 ['signup','GET','/signup'],['signup','POST','/signup/code',{}],['signup','POST','/signup/code',{renewal:true}],
 ...['contacts','history'].map(kind=>['signup','POST','/signup/sync-release',{kind,requestId:'SIMSYNC-'+kind}]),
 ...['exchange','register'].map(phase=>['signup','POST','/signup/fault',{id:'finite-'+phase,phase}]),
 ['transition','GET','/signup'],['transition','GET','/transition'],['transition','POST','/signup/code',{renewal:true}],
 ...['INITIATE','COMPLETE'].flatMap(stage=>['MALFORMED_WITH_ID','DISCONNECT_NO_LOCATOR'].map(mode=>['transition','POST','/transition/fault',{id:'original-'+stage,stage,mode}])),
 ['transition','POST','/transition/revoke-original',{}],['templates','GET','/templates'],['templates','POST','/templates/complete-target',{}],
 ['legacy','GET','/templates'],['legacy','GET','/legacy-migration'],['legacy','POST','/signup/code',{legacyMigration:true}],
 ...['ACCEPT','DISCONNECT','MALFORMED','REJECT'].map(mode=>['legacy','POST','/legacy-migration/fault',{mode}]),
];
test('all existing admitted guest control calls reach only their exact finite simulator family',async()=>{
 const f=await privateControlFixture();
 for(const[scope,method,path,body]of finiteControlCalls){const count=f.calls.length;assert.equal((await f.control('/owned/private/control.sock',method,path,body,scope)).observed,true);assert.equal(f.calls.length,count+1);const call=f.calls.at(-1);assert.equal(call.socketPath,'/owned/private/control.sock');assert.equal(call.method,method);assert.equal(call.path,path);assert.equal(call.timeout,10000);assert.equal(call.bytes,body===undefined?undefined:JSON.stringify(body));}
 // Default callers keep signup only; guest wrappers select their explicit family.
 assert.equal((await f.control('/owned/private/control.sock','GET','/signup')).observed,true);
 for(const[name,scope]of [['meta-transition-dev-guest.mjs','transition'],['meta-template-dev-guest.mjs','templates']]){
  const source=await readFile(new URL('../scripts/release/'+name,import.meta.url),'utf8');assert(source.includes(".cfg.controlSocket,method,path,body,'"+scope+"')"));
 }
});
test('private control rejects cross-family, query, extra-field and invented mutation requests before transport',async()=>{
 const f=await privateControlFixture();
 for(const[scope,method,path,body]of [
  ['signup','GET','/transition'],['signup','GET','/templates'],['signup','GET','/legacy-migration'],['signup','POST','/signup/code',{legacyMigration:true}],
  ['transition','GET','/financial'],['transition','POST','/templates/complete-target',{}],['templates','POST','/transition/revoke-original',{}],['legacy','POST','/templates/complete-target',{}],
  ['transition','POST','/signup/code',{}],['transition','POST','/signup/fault',{id:'wrong',phase:'exchange'}],['transition','POST','/transition/fault',{id:'wrong',stage:'INITIATE',mode:'REJECT'}],
  ['transition','POST','/transition/fault',{id:'wrong',stage:'OTHER',mode:'MALFORMED_WITH_ID'}],['legacy','POST','/legacy-migration/fault',{mode:'RESET'}],
  ['signup','POST','/signup/code',[]],['transition','POST','/transition/revoke-original',[]],['templates','POST','/templates/complete-target',{force:true}],['legacy','POST','/signup/code',{legacyMigration:true,renewal:true}],
  ['unknown','GET','/signup'],['transition','DELETE','/transition'],['transition','GET','/transition?reset=true'],['transition','GET','/transition',{}],
 ])assert.throws(()=>f.control('/owned/private/control.sock',method,path,body,scope));
 assert.equal(f.calls.length,0);
 f.fail();await assert.rejects(f.control('/owned/private/control.sock','GET','/transition',undefined,'transition'),error=>/retain state and do not replay/u.test(error.message)&&!error.message.includes('PRIVATE_MARKER'));
 assert.equal(f.calls.length,1,'Unknown transport outcome never retries');
});
