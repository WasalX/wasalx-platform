import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {dirname,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createMetaCallbacks,privateConfigPath,metaCoexistenceFixtureModes} from './simulation-meta-runtime.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';

const standardSignupModes=['happy','exchange-unknown','registration-unknown'];
export const signupModes=[...standardSignupModes,...Object.keys(metaCoexistenceFixtureModes)];
const base='/api/connections/meta/signup',hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export function validateSignupStageConfig(config){
 assert(signupModes.includes(config?.mode),'One finite signup mode required');
  assert(typeof config.testId==='string'&&config.testId.length>0,'Reviewed catalog test ID required');
  if(Object.hasOwn(metaCoexistenceFixtureModes,config.mode))assert.deepEqual(Object.keys(config).sort(),['mode','testId']);
}
export function assertFreshSignup(state){
 assert.equal(state?.evidenceClass,'simulated-provider-signup');
 assert.equal(state.phoneStatus,'PENDING');assert(state.code===null,'Signup code already issued; preserve context');
 assert(Array.isArray(state.exchangeReceipts)&&state.exchangeReceipts.length===0,'Signup exchange already observed');assert(state.registration===null,'Signup registration already observed');
 assert.equal(state.registrationAttempts,0);assert(state.armedFault===null,'Signup fault already armed');assert(Array.isArray(state.faultEvents)&&state.faultEvents.length===0,'Signup fault history already present');
}

// Exact private simulator control surface. A failed mutation is never retried.
export function signupControl(socketPath,method,path,body,scope='signup'){
 const object=body!==null&&typeof body==='object'&&!Array.isArray(body),fields=object?Object.keys(body).sort().join(','):null;
 // Each admitted guest chooses only its existing finite simulator family.
 // The default retains signup/coexistence; no generic path or mutation passthrough.
 const reads={signup:['/signup'],transition:['/signup','/transition'],templates:['/templates'],legacy:['/templates','/legacy-migration']};
 assert(Object.hasOwn(reads,scope)&&(
   (method==='GET'&&reads[scope].includes(path)&&body===undefined)
   ||(method==='POST'&&path==='/signup/code'&&object&&(
     (scope==='signup'&&(fields===''||fields==='renewal'&&body.renewal===true))
     ||(scope==='transition'&&fields==='renewal'&&body.renewal===true)
     ||(scope==='legacy'&&fields==='legacyMigration'&&body.legacyMigration===true)))
   ||(scope==='signup'&&method==='POST'&&path==='/signup/sync-release'&&fields==='kind,requestId'
     &&['contacts','history'].includes(body.kind)&&body.requestId==='SIMSYNC-'+body.kind)
   ||(scope==='signup'&&method==='POST'&&path==='/signup/fault'&&fields==='id,phase'
     &&typeof body.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(body.id)&&['exchange','register'].includes(body.phase))
   ||(scope==='transition'&&method==='POST'&&path==='/transition/fault'&&fields==='id,mode,stage'
     &&typeof body.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(body.id)&&['INITIATE','COMPLETE'].includes(body.stage)
     &&['MALFORMED_WITH_ID','DISCONNECT_NO_LOCATOR'].includes(body.mode))
   ||(scope==='transition'&&method==='POST'&&path==='/transition/revoke-original'&&fields==='')
   ||(scope==='templates'&&method==='POST'&&path==='/templates/complete-target'&&fields==='')
   ||(scope==='legacy'&&method==='POST'&&path==='/legacy-migration/fault'&&fields==='mode'
     &&['ACCEPT','DISCONNECT','MALFORMED','REJECT'].includes(body.mode))));
 return new Promise((resolve,reject)=>{
  const fail=()=>reject(Error('Private signup control outcome unavailable; retain state and do not replay'));
  const q=httpRequest({socketPath,path,method,timeout:10000,headers:{'content-type':'application/json'}},r=>{
   let size=0;const chunks=[];r.on('error',fail);r.on('data',chunk=>{size+=chunk.length;if(size>128*1024)q.destroy();else chunks.push(chunk);});
   r.on('end',()=>{try{assert.equal(r.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks)));}catch{fail();}});
  });q.on('error',fail);q.on('timeout',()=>q.destroy());q.end(body===undefined?undefined:JSON.stringify(body));
 });
}

export function assertSignupOutcome(mode,view,provider,db){
 assert(standardSignupModes.includes(mode));assert.equal(provider.evidenceClass,'simulated-provider-signup');
 assert.equal(provider.exchangeReceipts.length,1);assert(Number.isSafeInteger(provider.code?.consumedAt)&&provider.code.consumedAt>0);
 assert(provider.exchangeReceipts[0].codeSha256===provider.code.sha256,'Signup exchange receipt binding changed');assert(provider.armedFault===null,'Signup fault still armed');
 assert.equal(db.attempt.id,view.attemptId);assert.equal(db.attempt.status,view.status);assert.equal(db.attempt.exchange_claimed,true);
 assert.equal(view.readiness.payment.requestedPayer,'CUSTOMER');assert.equal(view.readiness.payment.paymentMethodVerified,false);
 if(mode==='exchange-unknown'){
  assert.equal(view.status,'OUTCOME_UNKNOWN');assert.equal(view.reasonCode,'META_SIGNUP_EXCHANGE_UNKNOWN');
  assert.equal(db.attempt.reason_code,view.reasonCode);assert.equal(db.attempt.credential_stored,false);assert.equal(db.attempt.registration_claimed,false);
  assert.equal(db.attempt.connection_id,null);assert.equal(db.attempt.operation_id,null);assert.deepEqual(db.operations,[]);assert.equal(db.connection,null);
  assert.equal(provider.phoneStatus,'PENDING');assert(provider.registration===null,'Unexpected signup registration after unknown exchange');assert.equal(provider.registrationAttempts,0);
 }else{
  assert(uuid.test(view.connectionId)&&uuid.test(view.operationId));
  assert.equal(db.attempt.connection_id,view.connectionId);assert.equal(db.attempt.operation_id,view.operationId);
  assert.equal(db.attempt.credential_stored,true);assert.equal(db.attempt.registration_claimed,true);
  assert.equal(provider.phoneStatus,'CONNECTED');assert(provider.registration?.acceptedAt);assert.equal(provider.registrationAttempts,1);
  assert.equal(db.operations.length,1);const operation=db.operations[0];
  assert.equal(operation.id,view.operationId);assert.equal(operation.connection_id,view.connectionId);assert.equal(operation.operation_type,'PROVISION');
  assert.equal(Number(operation.attempts),1);assert.equal(operation.lease_id,null);
  assert.equal(db.connection.id,view.connectionId);assert.equal(db.connection.phone_id,provider.binding.phoneId);assert.equal(db.connection.waba_id,provider.binding.wabaId);
  assert.equal(db.connection.signup_attempt_id,view.attemptId);
  if(mode==='happy'){
   assert.equal(view.status,'COMPLETED');assert.equal(view.readiness.authorization,'VERIFIED');assert.equal(view.readiness.number,'REGISTERED');
   assert.equal(view.readiness.subscription,'CONFIRMED');assert.equal(view.readiness.messaging,'AVAILABLE');
   assert.equal(operation.state,'SUCCEEDED');assert.equal(operation.signup_ready,true);assert.equal(db.connection.state,'WORKING');
   assert.equal(db.connection.session_state,'WORKING');assert.equal(db.connection.ownership_state,'ACTIVE');assert.equal(db.connection.route_state,'ACTIVE');
  }else{
   assert.equal(view.status,'OUTCOME_UNKNOWN');assert.equal(view.reasonCode,'META_SIGNUP_REGISTRATION_UNKNOWN');
   assert.equal(db.attempt.reason_code,view.reasonCode);assert.equal(operation.state,'FAILED_TERMINAL');assert.equal(operation.error_code,view.reasonCode);
   assert.equal(db.connection.state,'ACTION_REQUIRED');
  }
 }
 const phase=mode==='exchange-unknown'?'exchange':'register';
 assert.equal(provider.faultEvents.length,mode==='happy'?0:1);
 if(mode!=='happy'){assert.equal(provider.faultEvents[0].phase,phase);assert.equal(provider.faultEvents[0].outcome,'ACCEPTED_DISCONNECTED');}
 // Deliberately project safe evidence: never return PIN/code/challenge/token or provider binding hashes.
 return{attemptId:view.attemptId,status:view.status,reasonCode:view.reasonCode??null,connectionId:view.connectionId??null,
  operationId:view.operationId??null,operationState:db.operations[0]?.state??null,codeConsumptions:1,
  registrationAttempts:provider.registrationAttempts,registrationAccepted:provider.registration!==null,
  providerPhoneStatus:provider.phoneStatus,paymentMethodVerified:false,automaticReplayObserved:false};
}

// Finite driver shared with a separately reviewed DEV adapter. All mutation
// callbacks are authenticated production paths or the admitted private socket.
export async function runFiniteSignup({mode,namespace,expected,request,control,observe,poll,checkpoint}){
 assert(standardSignupModes.includes(mode)&&/^[A-Za-z0-9-]{1,40}$/u.test(namespace));
 const providerBefore=await control('GET','/signup');assertFreshSignup(providerBefore);
 const capability=await request(base+'/capabilities');assert.equal(capability.enabled,true);assert.deepEqual(capability.payerModes,['CUSTOMER']);
 assert.deepEqual(capability.sdk,{appId:expected.appId,configId:expected.configId,graphVersion:'v24.0'});
 let view=await request(base+'/attempts','POST',{name:'Synthetic signup '+namespace,payerMode:'CUSTOMER',idempotencyKey:randomUUID()},'signup-start');
 assert.equal(view.status,'AWAITING_AUTHORIZATION');assert(uuid.test(view.attemptId));assert(typeof view.challenge==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(view.challenge),'Signup challenge format invalid');
 const attemptId=view.attemptId,path=base+'/attempts/'+attemptId,challenge=view.challenge;
 await checkpoint({phase:'intent',step:'signup-code',attemptId:view.attemptId});
 const issued=await control('POST','/signup/code',{});assert(typeof issued.code==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(issued.code),'Signup code format invalid');assert(issued.expiresAt>Date.now());
 if(mode==='exchange-unknown'){
  await checkpoint({phase:'intent',step:'signup-exchange-fault',attemptId:view.attemptId});
  await control('POST','/signup/fault',{id:namespace+'-exchange',phase:'exchange'});
 }
 view=await request(path+'/exchange','POST',{challenge,code:issued.code,expectedRevision:view.revision},'signup-exchange');
 assert.equal(view.attemptId,attemptId);
 if(mode!=='exchange-unknown'){
  assert.equal(view.status,'SELECTION_REQUIRED');assert.equal(view.choices.length,1);const choice=view.choices[0];
  assert.equal(choice.mode,'STANDARD');assert.equal(choice.numberState,'REGISTRATION_REQUIRED');assert.equal(choice.selectable,true);
  assert.equal(choice.displayPhoneNumber,expected.displayPhoneNumber);
  if(mode==='registration-unknown'){
   await checkpoint({phase:'intent',step:'signup-register-fault',attemptId:view.attemptId});
   await control('POST','/signup/fault',{id:namespace+'-register',phase:'register'});
  }
  view=await request(path+'/select','POST',{expectedRevision:view.revision,selectionRevision:view.selectionRevision,choiceId:choice.choiceId},'signup-select');
  assert(['PROVISIONING','COMPLETED','OUTCOME_UNKNOWN'].includes(view.status),'Selection did not admit provisioning');
  view=await poll(()=>request(path),row=>!['EXCHANGING','PROVISIONING'].includes(row.status));
 }
 assert.equal(view.attemptId,attemptId);
 const providerAfter=await control('GET','/signup');assert(isDeepStrictEqual(providerAfter.binding,providerBefore.binding),'Signup provider binding changed');
 const first=assertSignupOutcome(mode,view,providerAfter,await observe(view));
 // A read may reconcile a status; it must not resend an uncertain external effect.
 const reread=await request(path),providerReread=await control('GET','/signup');assert.equal(reread.attemptId,attemptId);assert(isDeepStrictEqual(providerReread.binding,providerBefore.binding),'Signup provider binding changed');
 const proof=assertSignupOutcome(mode,reread,providerReread,await observe(reread));
 assert.deepEqual(proof,first);return proof;
}

export function assertFreshCoexistence(state){
 assert.equal(state?.evidenceClass,'simulated-provider-signup');assert.equal(state.phoneStatus,'CONNECTED');
 assert(state.code===null,'Coexistence signup code already issued');assert(Array.isArray(state.exchangeReceipts)&&state.exchangeReceipts.length===0,'Coexistence exchange already observed');assert.equal(state.registration,null);assert.equal(state.registrationAttempts,0);
 assert.equal(state.armedFault,null);assert.deepEqual(state.faultEvents,[]);assert.deepEqual(state.sync,{attempts:[],requests:{contacts:null,history:null}});
}

// One claimed fresh fixture per mode. Every request is an actual authenticated application path.
export async function startFiniteCoexistence({mode,namespace,expected,request,control,observe,poll}){
 assert(Object.hasOwn(metaCoexistenceFixtureModes,mode));const initial=await control('GET','/signup');assertFreshCoexistence(initial);
 const capability=await request(base+'/capabilities');assert.equal(capability.enabled,true);assert.equal(capability.businessAppEnabled,true);
 let view=await request(base+'/attempts','POST',{name:'Synthetic Business App '+namespace,payerMode:'CUSTOMER',idempotencyKey:randomUUID(),variant:'BUSINESS_APP',
   coexistenceConsent:{version:'2026-10-07',contacts:mode!=='coex-history-declined',history:true,echoes:true}},'coex-start');
 assert.equal(view.sdk.configId,expected.businessAppConfigId);assert.equal(view.sdk.extras.featureType,'whatsapp_business_app_onboarding');
 const path=base+'/attempts/'+view.attemptId,issued=await control('POST','/signup/code',{});
 view=await request(path+'/exchange','POST',{challenge:view.challenge,code:issued.code,expectedRevision:view.revision},'coex-exchange');
 assert.equal(view.choices.length,1);assert.equal(view.choices[0].mode,'COEXISTENCE');assert.equal(view.choices[0].numberState,'REGISTERED');assert.equal(view.choices[0].selectable,true);
 view=await request(path+'/select','POST',{expectedRevision:view.revision,selectionRevision:view.selectionRevision,choiceId:view.choices[0].choiceId},'coex-select');
 view=await poll(()=>request(path),row=>row.status==='COMPLETED');
 const observed=await poll(()=>observe(view),row=>!!row.context);const connectionId=view.connectionId,read='/api/connections/'+connectionId+'/meta/coexistence';
 return{initial,view,path,observed,connectionId,read};
}

// Original five-mode tails remain isolated and retain every zero-effect oracle.
export async function runFiniteCoexistence({mode,namespace,expected,request,control,observe,poll,checkpoint,dispatch,customer,businessPhone,uiRead}){
 const started=await startFiniteCoexistence({mode,namespace,expected,request,control,observe,poll});
 let {view,observed}=started;const {initial,path,connectionId,read}=started;
 const now=String(Math.floor(Date.now()/1000)),contact={state_sync:[{type:'contact',action:'add',metadata:{timestamp:now},contact:{phone_number:customer,full_name:'Synthetic coex contact'}}]};
 const message=(suffix,from=customer)=>({id:'wamid.synthetic.'+namespace+'.'+suffix,from,...(from===businessPhone?{to:customer}:{}),timestamp:now,type:'text',text:{body:'Synthetic retained '+suffix}});
 const history=(order,items,phase=0,progress=50)=>({history:[{metadata:{phase,chunk_order:order,progress},threads:[{id:customer,messages:items}]}]});
 if(mode==='coex-success'){
  await poll(()=>control('GET','/signup'),row=>row.sync.requests.contacts?.outcome==='HOLD');
  await dispatch('smb_app_state_sync',contact,'contacts-before-response');
  assert.equal((await request(read)).contactsRequest,'CLAIMED');
  await control('POST','/signup/sync-release',{kind:'contacts',requestId:'SIMSYNC-contacts'});
  await poll(()=>control('GET','/signup'),row=>row.sync.requests.history?.outcome==='HOLD');
  const outbound=message('history-first',businessPhone),echoFirst=message('echo-first',businessPhone);
   const media={...message('media'),type:'image',image:{id:'999999999'}};delete media.text;
   await dispatch('history',{messages:[media]},'media-before-placeholder');
   const late=history(2,[message('incoming'),outbound]);await dispatch('history',late,'history-order-2');
   assert.equal((await request(read)).historyRequest,'CLAIMED');
   await control('POST','/signup/sync-release',{kind:'history',requestId:'SIMSYNC-history'});
   await dispatch('smb_message_echoes',{message_echoes:[echoFirst]},'echo-first');
  await dispatch('history',late,'history-order-2-duplicate');
  await dispatch('smb_message_echoes',{message_echoes:[outbound]},'echo-after-history');
  await dispatch('history',history(1,[echoFirst]),'history-order-1');
  const placeholder={...message('media'),type:'media_placeholder'};delete placeholder.text;
  await dispatch('history',history(3,[placeholder]),'media-placeholder');
  await dispatch('history',history(0,[],2,100),'history-provider-finished');
   // Early supplements use the incumbent five-minute retry. Observe that scheduled work; never force a lease or rewrite available_at.
   observed=await poll(()=>observe(view),row=>row.context?.history_request.state==='ACCEPTED'&&row.importedMessages.length===4&&row.context.processed_chunks===4&&row.importedMessages.some(message=>message.media_id==='999999999'),360000);
  assert.equal(observed.context.contacts_request.state,'ACCEPTED');assert.equal(observed.context.history_observation,'PROVIDER_FINISHED');
  assert.equal(observed.importedMessages.filter(row=>row.source==='ECHO'||row.echo_observed).length,2);
  }else if(mode==='coex-history-declined'){
   await poll(()=>observe(view),row=>row.context?.history_request.state==='ACCEPTED');
   await dispatch('smb_app_state_sync',contact,'unconsented-contact',404);
   await dispatch('history',{history:[{errors:[{code:2593109}]}]},'history-declined');
   observed=await poll(()=>observe(view),row=>row.context?.history_observation==='DECLINED');
   assert.deepEqual(observed.importedMessages,[]);assert.deepEqual(observed.importedContacts,[]);assert.equal(observed.context.contacts_request.state,'NOT_REQUESTED');
   assert.equal((await control('GET','/signup')).sync.requests.contacts,null);
 }else if(mode==='coex-expired'){
  observed=await poll(()=>observe(view),row=>['EXPIRED','REJECTED'].includes(row.context?.history_request.state));
  assert(['EXPIRED','REJECTED'].includes(observed.context.contacts_request.state));assert.deepEqual(observed.importedMessages,[]);
 }else{
  observed=await poll(()=>observe(view),row=>row.context?.contacts_request.state==='UNKNOWN'&&row.context.history_request.state==='HELD_CONTACTS_UNKNOWN');
  const consumed=structuredClone({contacts:observed.context.contacts_request,history:observed.context.history_request});
  await dispatch('smb_app_state_sync',contact,'contacts-after-unknown');
  await dispatch('smb_message_echoes',{message_echoes:[message('unknown-echo',businessPhone)]},'echo-after-unknown');
  observed=await poll(()=>observe(view),row=>row.importedMessages.length===1&&row.importedContacts.length===1);
  assert.deepEqual({contacts:observed.context.contacts_request,history:observed.context.history_request},consumed,'Observed callbacks cannot reconcile an unknown HTTP result');
  if(mode==='coex-renewal'){
   await request('/api/connections/'+connectionId+'/pause','POST',{},'coex-pause');
   await poll(()=>observe(view),row=>row.connection.state==='PAUSED'&&row.operations.every(operation=>!['QUEUED','RUNNING','FAILED_RETRYABLE'].includes(operation.state)));
   const before=(await observe(view)).context,providerBefore=await control('GET','/signup');
   let renewal=await request(base+'/attempts','POST',{name:'Renew Business App access',payerMode:'CUSTOMER',idempotencyKey:randomUUID(),targetConnectionId:connectionId},'coex-renewal-start');
   assert.equal(renewal.sdk.configId,expected.configId);assert.equal(renewal.sdk.extras,undefined);assert.equal(renewal.target.mode,'COEXISTENCE');
   const renewalPath=base+'/attempts/'+renewal.attemptId,code=await control('POST','/signup/code',{renewal:true});
   renewal=await request(renewalPath+'/exchange','POST',{challenge:renewal.challenge,code:code.code,expectedRevision:renewal.revision},'coex-renewal-exchange');
   const choice=renewal.choices.find(row=>row.selectable);assert.equal(choice?.mode,'COEXISTENCE');
   renewal=await request(renewalPath+'/select','POST',{expectedRevision:renewal.revision,selectionRevision:renewal.selectionRevision,choiceId:choice.choiceId},'coex-renewal-select');
   assert.equal(renewal.outcome,'ACCESS_RENEWED_PAUSED');observed=await observe(view);assert.equal(observed.connection.state,'PAUSED');
   const retained=row=>{const result={...row};delete result.credential_fingerprint;delete result.revision;delete result.updated_at;return result;};
   assert.deepEqual(retained(observed.context),retained(before));assert.notEqual(observed.context.credential_fingerprint,before.credential_fingerprint);
   await request(renewalPath);assert.deepEqual((await control('GET','/signup')).sync,providerBefore.sync);
  }
 }
 const provider=await control('GET','/signup');assert.equal(provider.registrationAttempts,0);assert.equal(provider.registration,null);
 assert(isDeepStrictEqual(provider.binding,initial.binding),"Coexistence provider binding changed");
 const requestedKinds=provider.sync.attempts.map(row=>row.kind);
 assert(requestedKinds.every(kind=>['contacts','history'].includes(kind)));assert.equal(requestedKinds.length,new Set(requestedKinds).size);
 if(['coex-contacts-unknown','coex-renewal'].includes(mode)){
  assert.deepEqual(requestedKinds,['contacts'],'Unknown contacts must never dispatch history');
  assert.equal(provider.sync.requests.contacts?.requestId,'SIMSYNC-contacts');assert.equal(provider.sync.requests.contacts.outcome,'DISCONNECT');
  assert.equal(provider.sync.requests.history,null,'Unknown contacts must never receive a history receipt');
 }else if(mode==='coex-history-declined'){
  assert.deepEqual(requestedKinds,['history']);assert.equal(provider.sync.requests.contacts,null);
  assert.equal(provider.sync.requests.history?.requestId,'SIMSYNC-history');assert.equal(provider.sync.requests.history.outcome,'ACCEPT');
 }else if(mode==='coex-success'){
  assert.deepEqual(requestedKinds,['contacts','history']);
  for(const kind of requestedKinds){assert.equal(provider.sync.requests[kind]?.requestId,'SIMSYNC-'+kind);assert.equal(provider.sync.requests[kind].outcome,'RELEASED');}
 }else{
  assert.equal(mode,'coex-expired');assert.deepEqual(provider.sync.requests,{contacts:null,history:null},'Expired sync must have no accepted receipt');
  assert(requestedKinds.length<=2,'Expired sync allows only one rejected attempt per kind');
 }
 for(const value of Object.values(observed.effects))assert.equal(value,0,'Import/echo must stay outside ordinary effects');
 const summary=await request(read);assert.equal(summary.revision,observed.context.revision);
 const contacts=await request(read+'/contacts');
  if(observed.importedMessages.length){const thread=contacts.items.find(row=>row.phone===customer);assert(thread);const transcript=await request(read+'/threads/'+thread.threadId+'/messages');
   assert.equal(transcript.items.length,observed.importedMessages.length);assert(transcript.items.every(row=>['HISTORY','ECHO'].includes(row.source)));await uiRead(connectionId,'Synthetic retained');}
  const projectedMessages=observed.importedMessages.length;
  const syncSnapshot=structuredClone(provider.sync);await request(path);await request(read);assert.deepEqual((await control('GET','/signup')).sync,syncSnapshot);
  if(mode==='coex-success'){
   const deletion=await request('/api/privacy/requests','POST',{requestType:'DELETE',scopeType:'PARTICIPANT',scopeValue:customer,confirmation:'DELETE'},'coex-delete-subject');
   assert(uuid.test(deletion.id));await poll(()=>request('/api/privacy/requests/'+deletion.id),row=>row.state==='SUCCEEDED');
   observed=await poll(()=>observe(view),row=>row.importedMessages.length===0&&row.importedContacts.length===0&&row.cutoffCount>0);
   const requestsBeforePrivacy=structuredClone({contacts:observed.context.contacts_request,history:observed.context.history_request});
   await dispatch('history',history(40,[message('late-deleted')]),'history-after-deletion');
   await dispatch('smb_app_state_sync',{state_sync:[{...contact.state_sync[0],metadata:{timestamp:String(Number(now)+1)},contact:{phone_number:customer,full_name:'Late deleted contact'}}]},'contact-after-deletion');
   const media={...message('late-deleted-media'),type:'image',image:{id:'999999998'}};delete media.text;
   await dispatch('history',{messages:[media]},'media-after-deletion');
   await dispatch('smb_message_echoes',{message_echoes:[message('late-deleted-echo',businessPhone)]},'echo-before-deletion-cutoff');
   observed=await poll(()=>observe(view),row=>row.pendingImports===0);
   assert.deepEqual(observed.importedMessages,[]);assert.deepEqual(observed.importedContacts,[]);
   assert.deepEqual({contacts:observed.context.contacts_request,history:observed.context.history_request},requestsBeforePrivacy);
   assert.deepEqual((await request(read+'/contacts')).items,[]);await uiRead(connectionId,null);
   const current=await request(read);
   const stopped=await request(read+'/consent','POST',{expectedRevision:current.revision,history:false,contacts:false,echoes:false},'coex-stop-capture');
  assert.deepEqual(stopped.consent,{history:false,contacts:false,echoes:false});
  await dispatch('smb_message_echoes',{message_echoes:[message('after-stop',businessPhone)]},'echo-after-stop',404);
  const retained=await observe(view);assert.deepEqual(retained.importedMessages,observed.importedMessages);assert.deepEqual(retained.importedContacts,observed.importedContacts);observed=retained;
  assert.deepEqual((await control('GET','/signup')).sync,syncSnapshot);
 }
 for(const value of Object.values(observed.effects))assert.equal(value,0,'Final import/privacy/stop readback must stay outside ordinary effects');
 await checkpoint({phase:'coexistence-readback',mode,connectionId,contextId:observed.context.id,contactsRequest:summary.contactsRequest,historyRequest:summary.historyRequest,
   importedMessages:projectedMessages,providerAttempts:provider.sync.attempts.length,zeroLiveEffects:true,latePrivacySuppressed:mode==='coex-success'});
 return{mode,connectionId,contextId:observed.context.id,contactsRequest:summary.contactsRequest,historyRequest:summary.historyRequest,
   historyObservation:summary.historyObservation,providerAttempts:provider.sync.attempts.length,registrationAttempts:0,zeroLiveEffects:true,
   latePrivacySuppressed:mode==='coex-success',captureStopped:mode==='coex-success',automaticReplayObserved:false};
}

export async function prepareMetaSignupStage(s,{namespace,config}){
 validateSignupStageConfig({mode:config.mode,testId:config.testId});assert.equal(namespace,s.runId);assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);
 const coex=Object.hasOwn(metaCoexistenceFixtureModes,config.mode);
 // DEV receives its own separately reviewed adapter; never broaden this fence.
 assert(s.model.name.startsWith('wasalx-simulation-'));
 await s.ensurePrivilegedOwner();const h=await createMetaCallbacks(s,config),{cfg}=h,expected=cfg.signup;
 assert(expected);assert.equal(expected.origin,s.portalOrigin);assert.equal(expected.appId,cfg.appId);assert.equal(expected.graphVersion,'v24.0');
 const env=s.model.services['control-api'].environment;
 assert.equal(env.PORTAL_PUBLIC_ORIGIN,s.portalOrigin);assert.equal(env.META_SIGNUP_ENABLED,'true');assert.equal(env.META_SIGNUP_CUSTOMER_CONFIG_ID,expected.configId);
 assert.equal(env.META_APP_ID,expected.appId);assert.equal(env.META_GRAPH_VERSION,'v24.0');
 if(new URL(s.portalOrigin).protocol==='http:'){assert.equal(env.NODE_ENV,'development');assert.equal(new URL(s.portalOrigin).hostname,'127.0.0.1');}
 for(const service of ['control-api','connector-worker']){
  const declared=s.model.services[service].environment,installed=Object.fromEntries(s.containers[service].Config.Env.map(value=>{const i=value.indexOf('=');return[value.slice(0,i),value.slice(i+1)];}));
  for(const key of ['PORTAL_PUBLIC_ORIGIN','META_SIGNUP_ENABLED','META_SIGNUP_CUSTOMER_CONFIG_ID','META_APP_ID','META_GRAPH_VERSION','META_APP_SECRET_REFERENCE']){
   assert.equal(declared[key],env[key],'Signup consumer configuration mismatch: '+key);assert.equal(installed[key],declared[key],'Installed signup configuration mismatch: '+key);
  }
  assert.equal(installed.NODE_ENV,declared.NODE_ENV,'Installed runtime mode mismatch');
 }
 const control=(method,path,body)=>signupControl(cfg.controlSocket,method,path,body),before=await control('GET','/signup');
 if(coex)assertFreshCoexistence(before);else assertFreshSignup(before);
 assert(isDeepStrictEqual(before.binding,{businessId:expected.businessId,userId:expected.userId,wabaId:cfg.binding.wabaId,appId:cfg.appId,phoneId:cfg.binding.phoneId,
   phone:expected.displayPhoneNumber,version:'v24.0',...(coex?{coexistence:expected.coexistence}:{}),...(expected.reauthorizationToken?{reauthorization:true}:{}),
   credentialSha256:hash(JSON.stringify(expected.reauthorizationToken?[cfg.token,cfg.appSecret,expected.reauthorizationToken]:[cfg.token,cfg.appSecret]))}),'Signup private provider binding mismatch');
 const available=await s.scoped('SELECT app.meta_signup_phone_available($1) AS available',[cfg.binding.phoneId]);assert.equal(available[0]?.available,true,'Fresh phone already bound; preserve previous effects');
 const startedAt=new Date().toISOString(),claim=await open(join(dirname(privateConfigPath(s.privateDir,config.privateConfigPath)),'meta-signup.claim.json'),'wx',0o600);
 try{await claim.writeFile(JSON.stringify({namespace,mode:config.mode,tenantId:s.tenantId,phoneId:cfg.binding.phoneId,startedAt,disposition:'retain-and-reconcile-no-replay'}));await claim.sync();}finally{await claim.close();}
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace,checkpoint:s.checkpoint});
 const observe=async view=>{
  const rows=await s.scoped(`SELECT id,status,reason_code,connection_id,operation_id,exchange_claimed_at IS NOT NULL AS exchange_claimed,
   credential_stored_at IS NOT NULL AS credential_stored,registration_claimed_at IS NOT NULL AS registration_claimed
   FROM meta_signup_attempts WHERE tenant_id=$1 AND id=$2 AND requested_by=$3`,[s.tenantId,view.attemptId,s.ownerId]);assert.equal(rows.length,1);
  const attempt=rows[0];if(!attempt.connection_id)return{attempt,operations:[],connection:null};
  const operations=await s.scoped(`SELECT id,connection_id,operation_type,state,attempts,lease_id,error_code,result->>'metaSignupReady'='true' AS signup_ready
   FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at,id`,[s.tenantId,attempt.connection_id]);
  const connections=await s.scoped(`SELECT c.id,c.state,p.state AS session_state,p.ownership_state,p.opaque_session_id AS phone_id,
   p.provider_state_data->>'wabaId' AS waba_id,p.provider_state_data->'metaSignup'->>'attemptId' AS signup_attempt_id,r.state AS route_state
   FROM connections c JOIN provider_sessions p ON p.tenant_id=c.tenant_id AND p.connection_id=c.id
   LEFT JOIN webhook_routes r ON r.tenant_id=c.tenant_id AND r.connection_id=c.id AND r.provider='META' AND r.external_key=p.opaque_session_id
   WHERE c.tenant_id=$1 AND c.id=$2`,[s.tenantId,attempt.connection_id]);assert.equal(connections.length,1);
   if(!coex)return{attempt,operations,connection:connections[0]};
   const [context]=await s.scoped('SELECT * FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2',[s.tenantId,attempt.connection_id]);
   const importedMessages=context?await s.scoped('SELECT external_message_id,source,echo_observed,media_id,message_type FROM meta_coexistence_messages WHERE tenant_id=$1 AND context_id=$2 ORDER BY external_message_id',[s.tenantId,context.id]):[];
    const importedContacts=context?await s.scoped('SELECT subject_digest,action FROM meta_coexistence_contacts WHERE tenant_id=$1 AND context_id=$2 ORDER BY subject_digest',[s.tenantId,context.id]):[];
    const [pending]=await s.scoped("SELECT count(*)::integer AS n FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND event_type LIKE 'meta.coexistence.%' AND status NOT IN ('PROCESSED','DUPLICATE','IGNORED')",[s.tenantId,attempt.connection_id]);
    const [cutoff]=await s.scoped("SELECT count(*)::integer AS n FROM privacy_job_targets target JOIN privacy_jobs job ON job.tenant_id=target.tenant_id AND job.id=target.job_id WHERE target.tenant_id=$1 AND target.target_type='META_COEXISTENCE_SUBJECT_CUTOFF' AND target.target_id=app.meta_coexistence_subject_digest($2,$3,$4) AND job.state='SUCCEEDED'",[s.tenantId,cfg.appId,cfg.binding.phoneId,cfg.binding.customer]);
   const effects={};for(const table of ['normalized_messages','message_links','bot_conversations','delivery_outbox','participant_identities','meta_direct_identity_aliases']){
    const [count]=await s.scoped(`SELECT count(*)::integer AS n FROM ${table} WHERE tenant_id=$1 AND connection_id=$2`,[s.tenantId,attempt.connection_id]);effects[table]=count.n;
   }
    return{attempt,operations,connection:connections[0],context,importedMessages,importedContacts,effects,pendingImports:pending.n,cutoffCount:cutoff.n};
  };
 const dispatch=async(field,data,label,expectedStatus=200)=>{
  assert(coex&&['history','smb_app_state_sync','smb_message_echoes'].includes(field)&&/^[a-z0-9-]{1,80}$/u.test(label));
  assert([200,404].includes(expectedStatus));
  const bytes=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:cfg.binding.wabaId,changes:[{field,value:{messaging_product:'whatsapp',
   metadata:{phone_number_id:cfg.binding.phoneId,display_phone_number:expected.displayPhoneNumber},...data}}]}]}));
  const raw=await open(join(s.output,'coex-'+label+'.raw.json'),'wx',0o600);try{await raw.writeFile(bytes);await raw.sync();}finally{await raw.close();}
  await s.checkpoint({phase:'intent',step:label,bodySha256:hash(bytes)});
  const response=await h.postRaw('/webhooks/meta',bytes,{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',cfg.appSecret).update(bytes).digest('hex')});
  assert.equal(response.status,expectedStatus);await s.checkpoint({phase:expectedStatus===200?'accepted':'rejected',step:label,bodySha256:hash(bytes),receipt:response.receipt});return response;
 };
 const uiRead=async(connectionId,marker)=>{
  await s.ownerPage.goto(s.portalOrigin+'/app?view=connections&connection='+connectionId);
  const section=s.ownerPage.locator('section[aria-labelledby="meta-coexistence-title"]');await section.waitFor({state:'visible',timeout:20000});
   await section.getByRole('button',{name:'View received conversations',exact:true}).click();
   if(marker===null){await section.getByText('No contacts or conversation observations are available yet. This does not confirm an empty or completed import.',{exact:true}).waitFor({state:'visible',timeout:20000});return;}
  await section.getByRole('button',{name:/Synthetic coex contact/u}).click();
  await section.getByText(new RegExp(marker,'u')).first().waitFor({state:'visible',timeout:20000});
  assert.equal(await section.getByRole('textbox').count(),0,'Inert transcript exposes no composer');
 };
 return{coex,h,cfg,expected,request,control,observe,dispatch,uiRead,startedAt};
}

export async function metaSignupStage(s,{namespace,config}){
 const {coex,h,expected,request,control,observe,dispatch,uiRead,startedAt}=await prepareMetaSignupStage(s,{namespace,config});
 const cfg=h.cfg;
 const proof=coex?await runFiniteCoexistence({mode:config.mode,namespace,expected,request,control,observe,poll:h.poll,checkpoint:s.checkpoint,dispatch,
  customer:cfg.binding.customer,businessPhone:expected.displayPhoneNumber.replace(/[^0-9]/gu,''),uiRead})
  :await runFiniteSignup({mode:config.mode,namespace,expected,request,control,observe,poll:h.poll,checkpoint:s.checkpoint});
 const finishedAt=new Date().toISOString();
 return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,runtimeBinding:h.binding,
  limitations:['Code-only synthetic Meta callback; not Facebook popup or real provider acceptance','Customer payer requested; no card, liability or funding verified'],
  proofs:[{testId:config.testId,result:'passed',startedAt,finishedAt,contextId:'tenant_owner-en-desktop',proof}]};
}
