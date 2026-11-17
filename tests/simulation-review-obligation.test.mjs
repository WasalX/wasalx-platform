import test from'node:test';import assert from'node:assert/strict';
import{assertOriginalReprocessAttribution}from'../scripts/release/simulation-reprocess-business.mjs';
import{observeUnknownDiagnostics}from'../scripts/release/simulation-unknown-review-readonly.mjs';

const f={tenant_id:'tenant',connection_id:'connection',review_id:'review',source_event_inbox_id:'source',reprocess_event_id:'event',external_group_id:'fixture-0019@example.test',participant:'12025550106@c.us',name:'Original Name',reference:'1234567890'};
const row=()=>({...f,state:'RESOLVED',resolution_code:'REPROCESSED',event_status:'PROCESSED',lease_id:null,original_participant:f.participant,original_from_api:false,original_from_me:false,external_participant_id:f.participant,from_api:false,from_me:false,participant_name:f.name,message_text:f.reference,external_message_id:'review:review:event',message_id:'message',zammad_ticket_id:17,zammad_article_id:29});
test('successful reprocess proof requires original attribution and corrected reference',()=>{assert.equal(assertOriginalReprocessAttribution(f,row()).originalIdentityPreserved,true)});
test('excluded HTTP400 or synthetic participant cannot substitute for successful attribution',()=>{for(const change of[{state:'OPEN'},{external_participant_id:'wasalx-review'},{participant_name:'WasalX review'},{message_text:'wrong'},{original_participant:'other'},{event_status:'QUARANTINED'},{lease_id:'active'},{from_api:true}])assert.throws(()=>assertOriginalReprocessAttribution(f,{...row(),...change}))});
test('reprocess proof binds tenant connection review original event and operation',()=>{for(const key of['tenant_id','connection_id','review_id','source_event_inbox_id','reprocess_event_id','external_group_id','external_message_id'])assert.throws(()=>assertOriginalReprocessAttribution(f,{...row(),[key]:'other'}))});





import{admitCustomerReprocess,assertCustomerReprocessSettled}from'../scripts/release/simulation-reprocess-business.mjs';
const customerProof=()=>({testId:'group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::customer-match',result:'passed',proof:{classification:'customer',input:{participant:'12025550105@c.us'}}});
test('successful review customer is derived from the existing verified customer-match fixture',()=>{assert.equal(admitCustomerReprocess([customerProof()],['12025550106@c.us']),'12025550105@c.us');for(const rows of[[],[customerProof(),customerProof()],[{...customerProof(),result:'failed'}],[{...customerProof(),proof:{classification:'team',input:{participant:'12025550105@c.us'}}}]])assert.throws(()=>admitCustomerReprocess(rows,[]));assert.throws(()=>admitCustomerReprocess([customerProof()],['12025550105@c.us']))});
test('configuration remains held after ambiguous submit until exact reprocess settlement',()=>{assertCustomerReprocessSettled({submitted:false,settled:false});assert.throws(()=>assertCustomerReprocessSettled({submitted:true,settled:false}));assertCustomerReprocessSettled({submitted:true,settled:true})});

import{runSenderReprocessEcho}from'../scripts/release/simulation-reprocess-business.mjs';
test('actual ambiguous ingress and customer reprocess POST both hold caller restoration',async()=>{
 for(const caller of['fresh','remaining'])for(const failureAt of['review-original','review-customer','customer-reprocess-once']){
  const state={submitted:false,settled:false},events=new Map(),rules=[],checkpoints=[];let submits=0,drains=0,restores=0;
  const teamReview={id:'team-review',version:1,state:'OPEN',reprocess_event_id:null},customerReview={id:'customer-review',version:1,state:'OPEN',reprocess_event_id:null};
  const primary=Error('Ambiguous POST transport result');
  const s={runId:caller,tenantId:'tenant',connectionId:'connection',groupId:'group',externalGroupId:'123@g.us',participant:'12025550106@c.us',customerParticipant:'12025550105@c.us',nativePage:{},expectedActorId:4,reprocessState:state,
   checkpoint:async row=>checkpoints.push(row),providerRead:async()=>[],drainEffects:async()=>{drains++;},bindingPath:'/binding',bindingBody:()=>({}),
   request:async(path,method='GET',body,step)=>{
    assert(['GET','POST','PUT'].includes(method));
    if(path==='/api/rules'){const rule={id:'rule-'+rules.length,revision:1,rules:[{id:'trigger'}]};rules.push(rule);return rule;}
    if(path.startsWith('/api/rule-sets?'))return rules;
    if(path.includes('/activate')||path==='/binding')return{};
    if(step==='reprocess-excluded')throw Error('HTTP 400; reconcile intent before retry');
    if(step==='customer-reprocess-once'){submits++;assert.equal(state.submitted,true);assert(checkpoints.some(row=>row.phase==='customer-reprocess-intent'&&row.key===`synthetic-${caller}-customer-reprocess-once`&&row.expectedVersion===1&&row.ruleId==='trigger'));assert.equal(body.normalizedReference,'1234567890');throw primary;}
    assert.fail('Unexpected request '+path);
   },
   control:async({input})=>{assert.equal(state.submitted,true);assert(checkpoints.some(row=>row.phase==='owned-ingress-registered'&&row.entry.eventId===input.eventId));if(input.eventId===simulationEventId(caller+'-'+failureAt))throw primary;const id=events.size?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';events.set(input.eventId,{id,status:'QUARANTINED',safe_error:'IDENTIFIER_LIMIT_EXCEEDED',processed_at:'2026-10-03T00:00:00Z',lease_id:null});return{results:[{status:200,receipt:{accepted:true,duplicate:false,event_id:id}}]};},
   scoped:async(sql,args)=>{
    if(sql.includes('app.group_rule_sender'))return[{sender:'customer'}];
    if(sql.includes('provider_event_id_sha256'))return events.has(args[2])?[events.get(args[2])]:[];
    if(sql.includes('FROM normalized_messages'))return sql.includes('external_message_id')?[{id:'customer-normalized',event_inbox_id:args[2],external_message_id:`false_123@g.us_${caller}-review-customer`,external_participant_id:s.customerParticipant,from_api:false,processing_status:'COMPLETE'}]:[{id:'normalized'}];
    if(sql.includes('FROM quarantine_records'))return[sql.includes('tenant_id=$1')?customerReview:teamReview];
    if(sql.includes('FROM delivery_outbox')||sql.includes('FROM message_links')||sql.includes('FROM group_action_executions'))return[];
    assert.fail('Unexpected query '+sql);
   }};
  await assert.rejects(async()=>{try{await runSenderReprocessEcho(s);}finally{assertCustomerReprocessSettled(state);drains++;restores++;}},/preserve configuration/);
  assert.equal(submits,failureAt==='customer-reprocess-once'?1:0);assert.equal(checkpoints.filter(row=>row.phase==='owned-ingress-registered').length,failureAt==='review-original'?1:2);assert.equal(state.submitted,true);assert.equal(state.settled,false);assert.equal(drains,0);assert.equal(restores,0);assert.equal(checkpoints.filter(row=>row.phase==='proof').length,0);
 }
});

import{simulationEventId}from'../scripts/release/synthetic-first-group-driver.mjs';

function reprocessAdmissionFixture(options={}){
 const stopped=Error('Read-only preflight reached'),calls=[];
 return{stopped,calls,s:{customerParticipant:'12025550105@c.us',participant:'12025550106@c.us',reprocessState:{submitted:false,settled:false},drainEffects:async()=>assert.fail('Admission probe must not drain or dispatch'),checkpoint:async()=>{},scoped:async()=>{calls.push('read-only-preflight');throw stopped;},...options}};
}
test('current portal reprocess reaches existing read-only preflight with portal attribution and no native page',async()=>{const f=reprocessAdmissionFixture({operatorSurface:'portal',observeAttribution:async()=>assert.fail('No effect or observation before preflight')});await assert.rejects(()=>runSenderReprocessEcho(f.s),error=>error===f.stopped);assert.deepEqual(f.calls,['read-only-preflight']);assert.equal(f.s.nativePage,undefined);assert.equal(f.s.expectedActorId,undefined);});
test('current reprocess requires its portal observer and explicit known surface before any work',async()=>{for(const options of [{operatorSurface:'portal'},{operatorSurface:'portal',observeAttribution:true},{operatorSurface:'unknown',observeAttribution:async()=>{}},{observeAttribution:async()=>{}}]){const f=reprocessAdmissionFixture(options);await assert.rejects(()=>runSenderReprocessEcho(f.s));assert.deepEqual(f.calls,[]);}});
test('historical reprocess retains both exact native prerequisites',async()=>{for(const options of [{nativePage:{}},{expectedActorId:4}]){const f=reprocessAdmissionFixture(options);await assert.rejects(()=>runSenderReprocessEcho(f.s));assert.deepEqual(f.calls,[]);}const f=reprocessAdmissionFixture({nativePage:{},expectedActorId:4});await assert.rejects(()=>runSenderReprocessEcho(f.s),error=>error===f.stopped);assert.deepEqual(f.calls,['read-only-preflight']);});
test('portal reprocess cannot omit durable uncertain-operation state',async()=>{const f=reprocessAdmissionFixture({operatorSurface:'portal',observeAttribution:async()=>{},reprocessState:null});await assert.rejects(()=>runSenderReprocessEcho(f.s));assert.deepEqual(f.calls,[]);});

const fixture={deliveryId:'delivery',attemptIds:['attempt'],providerCode:'META_NETWORK'};
function page(change={},text='Destination: direct participant — Outcome unconfirmed — Attempt 1'){
 const detail={id:'delivery',state:'OUTCOME_UNKNOWN',attempts:1,manual_retry_allowed:false,delivery_attempts:[{id:'attempt',provider_code:'META_NETWORK'}],...change};let reads=0;
 const leaf={async waitFor(){},getByText(){return this}},dialog={...leaf,locator(){return leaf},async innerText(){return text}};
 return{request:{async get(url){reads++;assert.equal(url,'https://portal.example/api/deliveries/delivery');return{status:()=>200,json:async()=>detail}}},getByRole(role,options){assert.equal(role,'dialog');assert.equal(options.name,'Delivery timeline');return dialog},get reads(){return reads}};
}
test('unknown diagnostics use GET only and require preserved safe code and neutral copy',async()=>{const p=page();assert.deepEqual(await observeUnknownDiagnostics(p,'https://portal.example',fixture),{providerCode:'META_NETWORK',providerNeutralDestination:true,originalAttemptPreserved:true});assert.equal(p.reads,1)});
test('lost provider code, changed attempt, resend permission and group-specific direct copy fail',async()=>{for(const change of[{delivery_attempts:[{id:'attempt',provider_code:null}]},{delivery_attempts:[{id:'other',provider_code:'META_NETWORK'}]},{attempts:2},{manual_retry_allowed:true}])await assert.rejects(()=>observeUnknownDiagnostics(page(change),'https://portal.example',fixture));await assert.rejects(()=>observeUnknownDiagnostics(page({},'WhatsApp group'),'https://portal.example',fixture))});
test('diagnostics reject an unrelated safe code and missing fixture expectation',async()=>{await assert.rejects(()=>observeUnknownDiagnostics(page({delivery_attempts:[{id:'attempt',provider_code:'UNRELATED_SAFE_CODE'}]}),'https://portal.example',fixture));await assert.rejects(()=>observeUnknownDiagnostics(page(),'https://portal.example',{deliveryId:'delivery',attemptIds:['attempt']}));});
test('diagnostics accept an explicitly observed null original code but never a substituted one',async()=>{const nullCode={delivery_attempts:[{id:'attempt',provider_code:null}]};assert.equal((await observeUnknownDiagnostics(page(nullCode),'https://portal.example',{...fixture,providerCode:null})).providerCode,null);await assert.rejects(()=>observeUnknownDiagnostics(page(nullCode),'https://portal.example',fixture));await assert.rejects(()=>observeUnknownDiagnostics(page(),'https://portal.example',{...fixture,providerCode:null}));});
