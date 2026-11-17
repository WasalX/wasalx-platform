import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {metaRoutingUnits,metaRoutingRuntime} from "../packages/core/dist/meta-routing.js";
import {assertMetaDirectEffectCurrent} from "../packages/core/dist/meta-direct-identity.js";
import {applyMetaPassiveRouting,bindMetaPrimaryRouting} from "../services/connector-worker/dist/services/connector-worker/src/meta-routing.js";
import {MetaThreadControlService} from "../services/control-api/dist/meta-thread-control.service.js";
import {MetaRoutingService} from "../services/control-api/dist/meta-routing.service.js";
import {ConnectionsController} from "../services/control-api/dist/connections.controller.js";
import {BotFlowsService} from "../services/control-api/dist/bot-flows.service.js";
import {HttpMetaGroupsClient} from "../services/control-api/dist/meta-groups.client.js";
import {reserveDirectNativeReply} from "../services/control-api/dist/direct-native-operations.js";
import {PrivacyRepository} from "../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js";
import {Client} from "pg";

// Reuse the actual canonical identity/native fixture and its rollback scopes.
// No second harness, compatibility grants, real provider or fabricated aliases.
export async function verifyMetaRoutingEffects(f){
 const {tx,apiPool,tenantId,connectionId,sessionId,phoneNumberId,wabaId,appId,participantId,conversationId,userId,phone,asset}=f;
 const runtime=metaRoutingRuntime(process.env),originalFetch=globalThis.fetch;
 const request={id:"synthetic-routing-action",headers:{origin:process.env.PORTAL_PUBLIC_ORIGIN},principal:{tenantId,userId,subject:`synthetic-${userId}`,role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
 const guard=(c,epoch=null,sources=null)=>c.query("SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7,$8,$9)",[connectionId,sessionId,phoneNumberId,wabaId,participantId,appId,runtime,epoch,sources]).then(r=>r.rows[0]);
 const scenario=work=>tx(async c=>{await c.query("SAVEPOINT routing_fixture");try{return await work(c)}finally{await c.query("ROLLBACK TO SAVEPOINT routing_fixture")}},tenantId,apiPool);
 const rejected=async(c,work,pattern)=>{await c.query("SAVEPOINT routing_rejection");try{await assert.rejects(work,pattern)}finally{await c.query("ROLLBACK TO SAVEPOINT routing_rejection")}};
 const effect=c=>assertMetaDirectEffectCurrent(c,{tenantId,connectionId,conversationId,appId});
 const observe=async(c,category,time,peer=phone,receivedAt=null)=>{
  const field=category==="PRIMARY_MESSAGE"?"messages":category==="STANDBY_MESSAGE"?"standby":"messaging_handovers";
  const message={id:`synthetic-${randomUUID()}`,from:peer,timestamp:String(time),type:"text",text:{body:"Synthetic routing observation"}};
  const value=field==="messaging_handovers"?{messaging_product:"whatsapp",recipient:{phone_number_id:phoneNumberId},type:category==="CONTROL_TAKEN"?"control_taken":"control_passed",timestamp:String(time),...(peer?{sender:{phone_number:peer}}:{})}
   :{messaging_product:"whatsapp",metadata:{phone_number_id:phoneNumberId},...(field==="standby"?{standby:{messages:[message]}}:{messages:[message]})};
  const unit=metaRoutingUnits(wabaId,field,value)[0],id=randomUUID(),leaseId=randomUUID();
  const payload={object:"whatsapp_business_account",entry:[{id:wabaId,changes:[{field,value:unit.value}]}]};
  const evidence={...unit.evidence,providerSessionId:sessionId,appId};
  await c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,meta_direct_asset,meta_routing_evidence,received_at)
    VALUES($1,$2,$3,'META',$4,$5,$6,$7,'PROCESSING',$8,clock_timestamp()+interval '5 minutes',$9,$10,COALESCE($11::timestamptz,clock_timestamp()))`,
    [id,tenantId,connectionId,`routing-${id}`,field==="messages"?"messages":"meta.routing.passive",payload,evidence.payloadSha256,leaseId,field==="messages"?asset:null,evidence,receivedAt]);
  const event={id,tenantId,connectionId,provider:"meta",providerEventId:`routing-${id}`,eventType:field==="messages"?"messages":"meta.routing.passive",payload,attempts:1};
  return{event,leaseId,evidence};
 };
 try{
  // The actual API projection must carry the exact scope used by the thread inspector.
  // Browser fixtures alone cannot prove that a database-selected field exists.
  const conversations=new BotFlowsService({rows:(scope,sql,values)=>tx(c=>c.query(sql,values).then(result=>result.rows),scope,apiPool)});
  const page=await conversations.listConversations(request.principal,{limit:'50'});
  const listed=page.items.find(row=>row.id===conversationId);assert.ok(listed);
  assert.equal(listed.connection_id,connectionId);assert.equal(listed.connection_provider,'META');
  await verifyMetaRoutingLookupSecurity(f);
  const supportingOwner=randomUUID();
  await f.admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Supporting routing owner')",[supportingOwner,`routing-${supportingOwner}`,`${supportingOwner}@example.invalid`]);
  assert.equal((await f.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[tenantId,supportingOwner])).rowCount,1);
  await scenario(async c=>{
   await c.query('SET LOCAL jit=on');
   await c.query('SET LOCAL jit_above_cost=100000');
   const jitAboveCost=Number((await c.query('SHOW jit_above_cost')).rows[0].jit_above_cost);
   assert.deepEqual((await c.query("SELECT has_any_column_privilege(current_user,'public.tenants','UPDATE') tenant_update,has_function_privilege(current_user,'app.lock_current_active_tenant_for_event_admission()','EXECUTE') tenant_lock")).rows,[{tenant_update:false,tenant_lock:true}]);
   const configuration=new MetaRoutingService({withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(c)}},{});
   let detailPlan;
   const connections=new ConnectionsController({rows:async(scope,sql,values)=>{
    assert.equal(scope,tenantId);
    if(!detailPlan){
     detailPlan=(await c.query(`EXPLAIN (FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0];
     assert.ok(detailPlan.Plan['Total Cost']<jitAboveCost,`Connection detail cost ${detailPlan.Plan['Total Cost']} must stay below JIT threshold ${jitAboveCost}`);
     assert.equal(detailPlan.JIT,undefined,'A single-connection readiness lookup must not compile JIT functions');
    }
    return(await c.query(sql,values)).rows;
   }},{},{},{},{},{});
   const ready=await connections.detail(request,connectionId);
   assert.equal((await c.query('SHOW jit')).rows[0].jit,'on','Readiness does not disable caller JIT');
   assert.equal(ready.meta_routing_configuration_ready,true);
   const list=await connections.list(request);
   assert.equal(list.find(row=>row.id===connectionId).meta_routing_configuration_ready,true);
   const previous=await configuration.configuration(request,connectionId);
   const result=await configuration.declare(request,connectionId,randomUUID(),{expectedSessionId:sessionId,expectedVersion:previous.configurationVersion,fallback:'HOLD'});
   assert.equal(result.configurationVersion,previous.configurationVersion+1);assert.equal(result.readiness,'REVIEW_REQUIRED');
   const held=await connections.detail(request,connectionId);
   assert.equal(held.meta_routing_configuration_ready,false);
   assert.equal(held.meta_routing_reason,'CONFIGURATION_REQUIRED');
   assert.equal((await connections.list(request)).find(row=>row.id===connectionId).meta_routing_configuration_ready,false);
  });
  // Canonical-origin private DNS/TLS remains SIMULATED throughout the actual SQL boundary.
  // No change to tenant/session/configuration authority and no ownership grant from review.
  await f.admin.query('BEGIN');
  try{
   await f.admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   await f.admin.query('SET LOCAL ROLE wasalx_platform_operations_client');
   const inspected=(await f.admin.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4) result',[tenantId,connectionId,'synthetic-routing-provenance',randomUUID()])).rows[0].result;
   const canonical={mode:'SIMULATED',graphOrigin:'https://graph.facebook.com',graphVersion:'v24.0',simulationBindingSha256:'c'.repeat(64)};
   const body={...inspected.review.observation,expectedSessionId:sessionId,expectedConfigurationVersion:inspected.declaration.version,
    expectedReviewVersion:inspected.review.version,disposition:'REVIEWED',observedAt:new Date().toISOString()};
   const record=(input=body,binding=canonical,scope=tenantId)=>f.admin.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
    [scope,connectionId,input,appId,binding,randomUUID(),createHash('sha256').update(JSON.stringify({input,binding})).digest('hex'),'synthetic-routing-provenance',randomUUID()]).then(r=>r.rows[0].result);
   for(const change of [{expectedSessionId:randomUUID()},{expectedConfigurationVersion:0},{expectedReviewVersion:0}])await rejected(f.admin,()=>record({...body,...change}),{code:'40001'});
   await rejected(f.admin,()=>record(body,canonical,randomUUID()),{code:'P0002'});
   for(const binding of [{...canonical,simulationBindingSha256:null},{...canonical,simulationBindingSha256:''},{...canonical,mode:'LIVE'},
    {...canonical,graphOrigin:'http://graph.facebook.com'},{...canonical,extra:true}])await rejected(f.admin,()=>record(body,binding),{code:'22023'});
   const saved=await record();assert.equal(saved.version,body.expectedReviewVersion+1);
   const readback=(await f.admin.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4) result',[tenantId,connectionId,'synthetic-routing-provenance',randomUUID()])).rows[0].result;
   assert.deepEqual(readback.review.runtime,canonical);
   await f.admin.query('RESET ROLE');await f.admin.query('SET LOCAL ROLE wasalx_app');
   const current=(binding=canonical,session=sessionId,own=false)=>f.admin.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,$8)',
    [connectionId,session,phoneNumberId,wabaId,participantId,appId,binding,own]).then(r=>r.rows[0]);
   assert.equal((await current()).allowed,true,'configuration-only activation prerequisite is current');
   assert.equal((await current(canonical,sessionId,true)).allowed,false,'review alone cannot refresh prior OWN');
   for(const binding of [{...canonical,simulationBindingSha256:'d'.repeat(64)},{...canonical,graphVersion:'v25.0'},
    {mode:'LIVE',graphOrigin:'https://graph.facebook.com',graphVersion:'v24.0'},runtime])assert.equal((await current(binding)).allowed,false);
   assert.equal((await current(canonical,randomUUID())).allowed,false);
   await f.admin.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);assert.equal((await current()).allowed,false,'foreign tenant cannot consume observation');
  }finally{await f.admin.query('ROLLBACK')}
  // Execute-only platform role, exact CAS and immutable observation history.
  await f.admin.query('BEGIN');
  try{
   await f.admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   await f.admin.query('SET LOCAL ROLE wasalx_platform_operations_client');
   const inspected=(await f.admin.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4) result',[tenantId,connectionId,'synthetic-routing-reviewer',randomUUID()])).rows[0].result;
   const reviewBody={...inspected.review.observation,expectedSessionId:sessionId,expectedConfigurationVersion:inspected.declaration.version,expectedReviewVersion:inspected.review.version,disposition:'REVOKED',observedAt:new Date().toISOString()};
   const record=(body=reviewBody,key=randomUUID(),scope=tenantId)=>f.admin.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[scope,connectionId,body,appId,runtime,key,createHash('sha256').update(JSON.stringify(body)).digest('hex'),'synthetic-routing-reviewer',randomUUID()]).then(r=>r.rows[0].result);
   for(const change of [{expectedSessionId:randomUUID()},{expectedConfigurationVersion:0},{expectedReviewVersion:0}])await rejected(f.admin,()=>record({...reviewBody,...change}),{code:'40001'});
   for(const change of [{personallyObserved:null},{roles:[null]},{unexpected:true}])await rejected(f.admin,()=>record({...reviewBody,...change}),{code:'22023'});
   await rejected(f.admin,()=>record(reviewBody,randomUUID(),randomUUID()),{code:'P0002'});
   const key=randomUUID(),revoked=await record(reviewBody,key);
   assert.equal(revoked.disposition,'REVOKED');assert.equal((await record(reviewBody,key)).duplicate,true);
   await rejected(f.admin,()=>record({...reviewBody,disposition:'REVIEWED'},key),{code:'23505'});
   await rejected(f.admin,()=>record({...reviewBody,disposition:'REVIEWED'}),{code:'40001'});
   await f.admin.query('RESET ROLE');await f.admin.query('SET LOCAL ROLE wasalx_app');
   assert.equal((await guard(f.admin)).allowed,false,'latest revocation overrides earlier OWN');
   await rejected(f.admin,()=>record(),/permission denied/);
  }finally{await f.admin.query('ROLLBACK')}
  await scenario(async c=>{
   const ownership=()=>c.query(`SELECT epoch,epoch_started_at::text,observed_at::text,last_customer_message_at::text,source_event_id
     FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,
     [tenantId,connectionId,sessionId,participantId]).then(result=>result.rows[0]);
   const before=await ownership();assert.equal((await guard(c)).claim,'OWN');
   const now=Math.floor(Date.now()/1000)+1;
   for(const time of [now,now+1]){
    const source=await observe(c,'PRIMARY_MESSAGE',time);await bindMetaPrimaryRouting(c,source.event,asset,participantId,appId);
    const after=await ownership();
    assert.equal(after.epoch,before.epoch,'A later ordinary message preserves the existing ownership generation');
    assert.equal(after.epoch_started_at,before.epoch_started_at,'The original generation boundary is immutable');
    assert.equal(Date.parse(after.observed_at),time*1000);assert.equal(Date.parse(after.last_customer_message_at),time*1000);
    assert.equal(after.source_event_id,source.event.id);
    assert.equal((await c.query('SELECT meta_routing_epoch FROM event_inbox WHERE id=$1',[source.event.id])).rows[0].meta_routing_epoch,before.epoch);
    assert.equal((await guard(c,null,[source.event.id])).allowed,true);
   }
   const current=await ownership(),older=await observe(c,'PRIMARY_MESSAGE',now);
   await bindMetaPrimaryRouting(c,older.event,asset,participantId,appId);
   assert.deepEqual(await ownership(),current,'An older source does not overwrite the latest same-generation observation');
   await rejected(c,()=>c.query(`UPDATE meta_thread_ownership SET epoch_started_at=observed_at
     WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,
     [tenantId,connectionId,sessionId,participantId]),/generation cannot be rewritten/);
  });
  await scenario(async c=>{
   const baseline=await guard(c);assert.equal(baseline.allowed,true);assert.equal(baseline.claim,"OWN");
   const internal=(await c.query("SELECT state,human_ownership_epoch,fencing_token,customer_control FROM bot_conversations WHERE id=$1",[conversationId])).rows[0];
   const now=Math.floor(Date.now()/1000)+1,negative=await observe(c,"CONTROL_TAKEN",now);
   assert.equal((await guard(c)).reason,"NEGATIVE_PENDING");await rejected(c,()=>effect(c),{code:"META_DIRECT_EFFECT_NOT_ATTEMPTED"});
   await applyMetaPassiveRouting(c,negative.event,negative.leaseId,appId);
   assert.equal((await guard(c)).claim,"STANDBY");assert.equal((await guard(c)).allowed,false);
   const next=await observe(c,"PRIMARY_MESSAGE",now+1);await bindMetaPrimaryRouting(c,next.event,asset,participantId,appId);
   assert.equal((await guard(c)).claim,"OWN");assert.equal((await guard(c,Number(baseline.epoch))).allowed,false);
   assert.equal((await guard(c,null,[f.sourceEventId])).allowed,false,"old source cannot attach to recovered OWN epoch");
   assert.deepEqual((await c.query("SELECT state,human_ownership_epoch,fencing_token,customer_control FROM bot_conversations WHERE id=$1",[conversationId])).rows[0],internal);
   await rejected(c,()=>c.query("UPDATE meta_thread_ownership SET last_customer_message_at=clock_timestamp()+interval '24 hours' WHERE tenant_id=$1 AND connection_id=$2",[tenantId,connectionId]),/customer window|source changed/);
   await rejected(c,()=>c.query("UPDATE event_inbox SET meta_routing_epoch=999 WHERE id=$1",[next.event.id]),/immutable/);
  });
  await scenario(async c=>{
   const now=Math.floor(Date.now()/1000)+1,first=await observe(c,"CONTROL_TAKEN",now);await applyMetaPassiveRouting(c,first.event,first.leaseId,appId);
   const positive=await observe(c,"CONTROL_PASSED",now);await applyMetaPassiveRouting(c,positive.event,positive.leaseId,appId);
   const third=await observe(c,"CONTROL_PASSED",now);await applyMetaPassiveRouting(c,third.event,third.leaseId,appId);
   assert.equal((await guard(c)).claim,"UNKNOWN","same-second conflict stays held after third positive");
  });
  await scenario(async c=>{
   const id=randomUUID(),hash="a".repeat(64);
   await c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_routing_evidence)
    VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.unresolved','{"redacted":true}',$4,'ACCEPTED',$5)`,[id,tenantId,connectionId,hash,{schemaVersion:1,category:"UNRESOLVED_ROUTING",providerSessionId:sessionId,phoneNumberId,accountId:wabaId,appId,observedAt:new Date().toISOString(),payloadSha256:hash}]);
   assert.equal((await guard(c)).reason,"NEGATIVE_PENDING");
   await c.query("UPDATE event_inbox SET status='FAILED_TERMINAL' WHERE id=$1",[id]);assert.equal((await guard(c)).allowed,false,"terminal work does not clear unattributable hold");
  });
  await scenario(async c=>{
   const id=randomUUID(),hash='b'.repeat(64);
   await rejected(c,()=>c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_direct_asset,meta_routing_evidence)
    VALUES($1::uuid,$2,$3,'META',$1::text,'messages','{}',$4,'ACCEPTED',$5,$6)`,[id,tenantId,connectionId,hash,asset,{schemaVersion:1,category:'PRIMARY_MESSAGE',providerSessionId:sessionId,phoneNumberId,accountId:wabaId,appId,observedAt:new Date().toISOString(),payloadSha256:hash,peer:{kind:'PHONE',value:phone}}]),{code:'23514'});
  });
  await scenario(async c=>{
   await c.query('UPDATE bot_conversations SET flow_version_id=$1 WHERE id=$2',[f.effectVersion,conversationId]);
   const operationId=randomUUID();
   await reserveDirectNativeReply(c,{tenantId,instanceId:f.instanceId,operationId,connectionId,chatId:phone,ticketId:'98231',actorId:'3',nativeGroupId:'2',actorFullGroupIds:['2'],requestSha256:'e'.repeat(64),appId});
   assert.equal(Number((await c.query('SELECT meta_routing_epoch FROM direct_native_reply_intents WHERE id=$1',[operationId])).rows[0].meta_routing_epoch),Number((await guard(c)).epoch));
   const negative=await observe(c,'CONTROL_TAKEN',Math.floor(Date.now()/1000)+1);await applyMetaPassiveRouting(c,negative.event,negative.leaseId,appId);
   await rejected(c,()=>assertMetaDirectEffectCurrent(c,{tenantId,conversationId,appId,routingNativeIntentId:operationId}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED'});
  });
  await scenario(async c=>{
   await rejected(c,()=>c.query("INSERT INTO meta_routing_legacy_admissions(tenant_id,connection_id,provider_session_id,phone_number_id,account_id) VALUES($1,$2,$3,$4,$5)",[tenantId,connectionId,sessionId,phoneNumberId,wabaId]),/permission denied/);
   await rejected(c,()=>c.query("UPDATE meta_routing_reviews SET disposition='REVIEWED' WHERE tenant_id=$1",[tenantId]),/permission denied/);
   await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaRouting,version}','2') WHERE id=$1",[sessionId]);
   assert.equal((await guard(c)).allowed,false,"configuration CAS invalidates prior observation");
  });
  for(const outcome of ["accepted","rejected","unknown","malformed","before-fetch-revoke",
   "accepted-after-revoke","rejected-after-revoke","unknown-after-revoke","malformed-after-revoke"]){
   await scenario(async c=>{
    const token="synthetic-routing-fixture-token",proof={...f.proof,credentialFingerprint:createHash("sha256").update(token).digest("hex")};
    await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1) WHERE id=$2",[proof,sessionId]);
    let preciseTimestamp=false,preciseDispatch=false,revocationReached=false,finalGuardDenied=false;
    const revokeAfter=outcome.endsWith('-after-revoke'),providerOutcome=outcome.replace('-after-revoke','');
    const revoke=async()=>{
     assert.equal((await c.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId])).rowCount,1);
     assert.equal((await c.query("SELECT state FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId])).rows[0].state,'SUSPENDED');
     revocationReached=true;
    };
    const bound={query:(sql,parameters)=>{
     // Exercise actual SQL/triggers with deterministic sub-millisecond precision.
     if(outcome==='accepted'&&sql.includes('UPDATE meta_thread_control_actions SET state=$1,provider_request_id=$2')){
      sql=sql.replace('completed_at=clock_timestamp()',"completed_at=date_trunc('milliseconds',clock_timestamp())+interval '123 microseconds'");preciseTimestamp=true;
     }
     if(outcome==='accepted'&&sql.includes('UPDATE meta_thread_control_actions SET dispatched_at=clock_timestamp()')){
      sql=sql.replace('dispatched_at=clock_timestamp()',"dispatched_at=date_trunc('milliseconds',clock_timestamp())+interval '456 microseconds'");preciseDispatch=true;
     }
     return c.query(sql,parameters);
    }};
    const db={withTenant:async(scope,work)=>{assert.equal(scope,tenantId);await c.query("SAVEPOINT routing_api_call");try{const result=await work(bound);await c.query("RELEASE SAVEPOINT routing_api_call");return result}catch(error){await c.query("ROLLBACK TO SAVEPOINT routing_api_call");throw error}}};
    let calls=0;
    globalThis.fetch=async(url,init)=>{calls++;assert.equal(new URL(url).origin,"https://routing-provider.invalid");assert.equal(JSON.parse(init.body).action,"pass");
     if(revokeAfter)await revoke();
     if(providerOutcome==="unknown")throw new Error("synthetic lost response");
     if(outcome==='accepted'){
      const actionId=JSON.parse(init.body).metadata;
      const earlier=(await c.query(`SELECT to_char((dispatched_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') received FROM meta_thread_control_actions WHERE id=$1`,[actionId])).rows[0].received;
      const input=await observe(c,'PRIMARY_MESSAGE',Math.floor(Date.now()/1000),phone,earlier);
      assert.equal((await c.query('SELECT source.received_at<action.dispatched_at AND source.received_at>=date_trunc(\'milliseconds\',action.dispatched_at) earlier_same_millisecond FROM event_inbox source CROSS JOIN meta_thread_control_actions action WHERE source.id=$1 AND action.id=$2',[input.event.id,actionId])).rows[0].earlier_same_millisecond,true);
     }
     return Response.json(providerOutcome==="accepted"?{messaging_product:"whatsapp",request_id:"synthetic-routing-receipt"}:providerOutcome==="rejected"?{error:{code:100,message:"Synthetic rejection"}}:{},{status:providerOutcome==="accepted"?200:400})};
    const factory={create:(_token,p,before)=>new HttpMetaGroupsClient(new URL("https://routing-provider.invalid"),"v24.0",token,p,async()=>{
     if(outcome==="before-fetch-revoke")await revoke();
     try{await before()}catch(error){if(outcome==='before-fetch-revoke'){assert.equal(error.getStatus?.(),403);finalGuardDenied=true}throw error}
    })};
    const service=new MetaThreadControlService(db,{resolveAccessToken:async()=>token},factory);
    const current=await guard(c),body={action:"pass",targetRole:"customer_service",expectedRoutingEpoch:Number(current.epoch),expectedConfigurationVersion:Number(current.configuration_version),expectedReviewVersion:Number(current.review_version)},key=randomUUID();
    for(const badRequest of [
     {...request,headers:{origin:'https://foreign.invalid'}},
     {...request,principal:{...request.principal,role:'agent'}},
     {...request,principal:{...request.principal,authenticationMethods:[]}},
     {...request,principal:{...request.principal,authenticatedAt:0}},
    ])await rejected(c,()=>service.execute(badRequest,conversationId,randomUUID(),body),error=>error.getStatus?.()===403);
    assert.equal(calls,0,'origin, role and recent MFA denials precede dispatch');
    const beforeAction=(await c.query(`SELECT epoch,last_customer_message_at::text FROM meta_thread_ownership
      WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,[tenantId,connectionId,sessionId,participantId])).rows[0];
    assert.notEqual(beforeAction.last_customer_message_at,null,'Thread control begins with a real customer-message window');
    const beforeOwnership=(await c.query('SELECT * FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4',[tenantId,connectionId,sessionId,participantId])).rows;
    const result=await service.execute(request,conversationId,key,body);
    const expectedState=providerOutcome==="accepted"?"SUCCEEDED":["rejected","before-fetch-revoke"].includes(providerOutcome)?"FAILED":"OUTCOME_UNKNOWN";
    assert.equal(calls,outcome==="before-fetch-revoke"?0:1,outcome);
    assert.equal(result.state,expectedState,outcome);
    const settled=(await c.query('SELECT state,dispatched_at,completed_at,provider_request_id,error_code FROM meta_thread_control_actions WHERE id=$1',[result.id])).rows[0];
    assert.equal(settled.state,expectedState,`${outcome}: the finalizer committed its result`);
    assert.ok(settled.completed_at,`${outcome}: completion is durable`);
    assert.equal(settled.dispatched_at===null,outcome==='before-fetch-revoke',outcome);
    assert.equal(settled.provider_request_id,providerOutcome==='accepted'?'synthetic-routing-receipt':null,outcome);
    assert.equal(settled.error_code,expectedState==='SUCCEEDED'?null:expectedState==='FAILED'?'META_THREAD_CONTROL_REJECTED':'META_THREAD_CONTROL_OUTCOME_UNKNOWN',outcome);
    const audits=(await c.query("SELECT actor_type,actor_id,action,new_value FROM audit_events WHERE tenant_id=$1 AND target_type='meta_thread_control' AND target_id=$2 ORDER BY action",[tenantId,result.id])).rows;
    assert.deepEqual(audits,[
     {actor_type:'SYSTEM',actor_id:'control-api',action:'meta.thread_control.completed',new_value:{state:expectedState,requestId:settled.provider_request_id,initiatingActorId:userId}},
     {actor_type:'USER',actor_id:userId,action:'meta.thread_control.reserved',new_value:{action:'pass',epoch:body.expectedRoutingEpoch}},
    ],`${outcome}: reservation retains its actor; settlement records the original attempt`);
    if(outcome!=='accepted')assert.deepEqual((await c.query('SELECT * FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4',[tenantId,connectionId,sessionId,participantId])).rows,beforeOwnership,`${outcome}: settling a receipt gives no new ownership`);
    if(revokeAfter){assert.equal(revocationReached,true);assert.equal(finalGuardDenied,false);}
    if(outcome==='before-fetch-revoke'){
     assert.equal(revocationReached,true);assert.equal(finalGuardDenied,true);
     assert.equal((await c.query('SELECT dispatched_at FROM meta_thread_control_actions WHERE id=$1',[result.id])).rows[0].dispatched_at,null);
    }
    if(outcome==='accepted'){
     assert.equal(preciseTimestamp,true);assert.equal(preciseDispatch,true);
     const exact=(await c.query(`SELECT ownership.observed_at=action.completed_at AND ownership.epoch_started_at=action.completed_at AS exact,
      mod(extract(microseconds FROM action.completed_at)::integer,1000) AS micros FROM meta_thread_control_actions action
      JOIN meta_thread_ownership ownership ON ownership.tenant_id=action.tenant_id AND ownership.source_action_id=action.id WHERE action.id=$1`,[result.id])).rows[0];
     assert.deepEqual(exact,{exact:true,micros:123});
     const projected=(await c.query(`SELECT epoch,last_customer_message_at::text,source_event_id,source_action_id FROM meta_thread_ownership
       WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,[tenantId,connectionId,sessionId,participantId])).rows[0];
     assert.equal(Number(projected.epoch),Number(beforeAction.epoch)+1,'The action starts exactly one new generation');
     assert.equal(projected.last_customer_message_at,beforeAction.last_customer_message_at,'An action preserves the exact existing customer window');
     assert.equal(projected.source_event_id,null);assert.equal(projected.source_action_id,result.id);
    }
    if(revocationReached)await c.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]);
    assert.deepEqual(await service.execute(request,conversationId,key,body),result,"same key reads original result without dispatch");
    assert.equal(calls,outcome==="before-fetch-revoke"?0:1);
    // Simulate a lost POST response and browser reload: reconstruct service,
    // retaining only the original workspace/conversation/key/body client intent.
    const reloaded=new MetaThreadControlService(db,{resolveAccessToken:async()=>{throw new Error('readback cannot resolve provider credentials')}},factory);
    const readback=await reloaded.inspect(request,conversationId,key);
    assert.equal(readback.correlation.state,'MATCHED');assert.deepEqual(readback.correlation.command,body);assert.deepEqual(readback.correlation.action,result);
    assert.equal((await reloaded.inspect(request,conversationId,randomUUID())).correlation.state,'ABSENT');
    await rejected(c,()=>reloaded.inspect({...request,principal:{...request.principal,userId:randomUUID()}},conversationId,key),/correlation is unavailable/);
    assert.equal(calls,outcome==="before-fetch-revoke"?0:1,'readback and absence never dispatch');
    assert.deepEqual((await c.query("SELECT actor_type,actor_id,action,new_value FROM audit_events WHERE tenant_id=$1 AND target_type='meta_thread_control' AND target_id=$2 ORDER BY action",[tenantId,result.id])).rows,audits,'Replay and readback never write another audit receipt');
    if(result.state==="OUTCOME_UNKNOWN"){
     assert.equal((await guard(c)).reason,"ACTION_UNRESOLVED");
     await rejected(c,()=>service.execute(request,conversationId,randomUUID(),body),/requires reconciliation/);
     await rejected(c,()=>c.query("UPDATE meta_thread_control_actions SET state='RUNNING',completed_at=NULL WHERE id=$1",[result.id]),/immutable/);
     const privacyId=randomUUID(),privacyLease=randomUUID();
     await c.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,lease_id,lease_expires_at,fencing_token)
       VALUES($1::uuid,$2::uuid,'DELETE','TENANT',$2::text,'RETENTION_DELETE',$1::text,'RUNNING','DISCOVER',$3,clock_timestamp()+interval '5 minutes',1)`,[privacyId,tenantId,privacyLease]);
     const privacy=new PrivacyRepository({});privacy.tenant=(scope,work)=>{assert.equal(scope,tenantId);return work(c)};
     await c.query('SAVEPOINT routing_barrier_comparison');
     await c.query("UPDATE meta_thread_control_actions SET state='FAILED',error_code='SYNTHETIC_KNOWN_REJECTION' WHERE id=$1",[result.id]);
     await privacy.assertPrivacyWorkDrained(c,{id:privacyId,tenantId,jobType:'DELETE'});
     await c.query('ROLLBACK TO SAVEPOINT routing_barrier_comparison');
     await rejected(c,()=>privacy.discover({id:privacyId,tenantId,jobType:'DELETE',scopeType:'TENANT',scopeValue:tenantId,disposition:'RETENTION_DELETE',state:'RUNNING',stage:'DISCOVER',fencingToken:1,createdAt:new Date().toISOString()},privacyLease),{code:'TENANT_WORK_IN_FLIGHT'});
    }
    if(outcome==="accepted"){
     assert.equal((await guard(c)).claim,"STANDBY");
     const prior=(await c.query(`SELECT epoch,epoch_started_at::text FROM meta_thread_ownership
       WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,[tenantId,connectionId,sessionId,participantId])).rows[0];
     const now=Math.floor(Date.now()/1000)+1;
     for(const time of [now,now+1]){
      const source=await observe(c,'STANDBY_MESSAGE',time);await applyMetaPassiveRouting(c,source.event,source.leaseId,appId);
      const after=(await c.query(`SELECT ownership.epoch,ownership.epoch_started_at::text,ownership.epoch_started_at=action.completed_at AS exact,
        mod(extract(microseconds FROM ownership.epoch_started_at)::integer,1000) AS micros,ownership.source_event_id,ownership.source_action_id,
        ownership.observed_at,ownership.last_customer_message_at FROM meta_thread_ownership ownership CROSS JOIN meta_thread_control_actions action
        WHERE ownership.tenant_id=$1 AND ownership.connection_id=$2 AND ownership.provider_session_id=$3 AND ownership.participant_identity_id=$4 AND action.id=$5`,
        [tenantId,connectionId,sessionId,participantId,result.id])).rows[0];
      assert.equal(after.epoch,prior.epoch);assert.equal(after.epoch_started_at,prior.epoch_started_at);
      assert.equal(after.exact,true,'Passive refresh retains the exact action-receipt generation boundary');assert.equal(after.micros,123);
      assert.equal(after.source_event_id,source.event.id);assert.equal(after.source_action_id,null);
      assert.equal(after.observed_at.getTime(),time*1000);assert.equal(after.last_customer_message_at.getTime(),time*1000);
      assert.equal((await c.query('SELECT status,meta_routing_epoch FROM event_inbox WHERE id=$1',[source.event.id])).rows[0].status,'PROCESSED');
      assert.equal((await guard(c)).claim,'STANDBY');assert.equal((await guard(c)).allowed,false);
     }
     assert.equal(calls,1,'Routing observations do not send another thread-control request');
    }
   });
  }
  // These boundaries use real separate application transactions, so the first
  // tenant lock is released before the administrative suspension commits.
  for(const phase of ['BEFORE_REQUEST','AFTER_REQUEST']){
   const token='synthetic-routing-race-token',proof={...f.proof,credentialFingerprint:createHash('sha256').update(token).digest('hex')};
   await withFixtureTenant(f.admin,tenantId,()=>f.admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1) WHERE id=$2",[proof,sessionId]));
   let calls=0,suspended=false,denied=false;
   const suspend=async()=>{
    assert.equal((await f.admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenantId])).rowCount,1);
    assert.equal((await f.admin.query('SELECT state FROM tenants WHERE id=$1',[tenantId])).rows[0].state,'SUSPENDED');
    assert.equal((await f.admin.query('SELECT state FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[tenantId,userId])).rows[0].state,'ACTIVE');suspended=true;
   };
   const previous=(await f.admin.query('SELECT * FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId])).rows;
   const current=await tx(guard,tenantId,apiPool);
   globalThis.fetch=async()=>{calls++;assert.equal(phase,'AFTER_REQUEST');await suspend();return Response.json({messaging_product:'whatsapp',request_id:'synthetic-late-known-receipt'})};
   const factory={create:(_token,p,before)=>new HttpMetaGroupsClient(new URL('https://routing-provider.invalid'),'v24.0',token,p,async()=>{
    if(phase==='BEFORE_REQUEST')await suspend();
    try{await before()}catch(error){assert.equal(error.getStatus?.(),403);denied=true;throw error}
   })};
   const service=new MetaThreadControlService({withTenant:(scope,work)=>tx(work,scope,apiPool)},{resolveAccessToken:async()=>token},factory);
   const key=randomUUID(),body={action:'pass',targetRole:'customer_service',expectedRoutingEpoch:Number(current.epoch),expectedConfigurationVersion:Number(current.configuration_version),expectedReviewVersion:Number(current.review_version)};
   try{
    const result=await service.execute(request,conversationId,key,body);
    assert.equal(suspended,true);assert.equal(calls,phase==='BEFORE_REQUEST'?0:1);assert.equal(denied,phase==='BEFORE_REQUEST');
    assert.equal(result.state,phase==='BEFORE_REQUEST'?'FAILED':'SUCCEEDED',`inactive tenant ${phase}`);
    const row=(await f.admin.query('SELECT state,dispatched_at,provider_request_id FROM meta_thread_control_actions WHERE id=$1',[result.id])).rows[0];
    assert.equal(row.state,result.state);assert.equal(row.dispatched_at===null,phase==='BEFORE_REQUEST');
    if(phase==='AFTER_REQUEST')assert.equal(row.provider_request_id,'synthetic-late-known-receipt');
    assert.deepEqual((await f.admin.query("SELECT actor_type,actor_id,new_value FROM audit_events WHERE tenant_id=$1 AND action='meta.thread_control.completed' AND target_id=$2",[tenantId,result.id])).rows,
     [{actor_type:'SYSTEM',actor_id:'control-api',new_value:{state:result.state,requestId:row.provider_request_id,initiatingActorId:userId}}],`inactive tenant ${phase}: original result remains auditable`);
    assert.deepEqual((await f.admin.query('SELECT * FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId])).rows,previous,'inactive receipt is historical and cannot project new ownership');
   }finally{
    await f.admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);
    await withFixtureTenant(f.admin,tenantId,()=>f.admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1) WHERE id=$2",[f.proof,sessionId]));
   }
  }
  return{pendingNegative:true,epochSourceBinding:true,equalTimeConflict:true,unattributableHold:true,configurationCas:true,rlsPermissions:true,actualRoleShadowIsolation:true,oneShotRealService:true,unknownNoReplay:true,internalHandoffUnchanged:true,liveProviderEvidence:false};
 }finally{globalThis.fetch=originalFetch}
}

// Fresh real runtime backends: install every shadow before the first target call.
// These are database regressions, never observations of a live Meta provider.
async function verifyMetaRoutingLookupSecurity(f){
 const {admin,tenantId,connectionId,sessionId,participantId,conversationId,phoneNumberId,wabaId,appId,phone}=f;
 const runtime=metaRoutingRuntime(process.env),digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const snapshot=async(table,where,values)=>(await admin.query(`SELECT to_jsonb(item) value FROM public.${table} item WHERE ${where}`,values)).rows.map(row=>row.value);
 const [session]=await snapshot('provider_sessions','id=$1',[sessionId]);
 const [connection]=await snapshot('connections','id=$1',[connectionId]);
 const reviews=await snapshot('meta_routing_reviews','connection_id=$1 ORDER BY review_version DESC',[connectionId]);
 const [ownership]=await snapshot('meta_thread_ownership','connection_id=$1 AND participant_identity_id=$2',[connectionId,participantId]);
 const [conversation]=await snapshot('bot_conversations','id=$1',[conversationId]);
 const [participant]=await snapshot('participant_identities','id=$1',[participantId]);
 const aliases=await snapshot('meta_direct_identity_aliases','participant_identity_id=$1 AND state=\'ACTIVE\'',[participantId]);
 assert.equal(ownership.state,'OWN');assert.equal(reviews[0].disposition,'REVIEWED');
 const phoneAlias=aliases.find(row=>row.kind==='PHONE');assert.equal(phoneAlias.value,phone);
 // Full public column types avoid a malformed shadow failing before its intended oracle.
 // Table names here are finite fixture literals, never external input.
 const shadow=async(c,table,rows=[])=>{
  const columns=(await admin.query(`SELECT quote_ident(attname)||' '||format_type(atttypid,atttypmod) definition
   FROM pg_catalog.pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,['public.'+table])).rows;
  assert.ok(columns.length);await c.query(`CREATE TEMP TABLE ${table}(${columns.map(row=>row.definition).join(',')})`);
  if(rows.length)await c.query(`INSERT INTO pg_temp.${table} SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.${table},$1::jsonb)`,[JSON.stringify(rows)]);
  assert.equal((await c.query(`SELECT count(*)::integer count FROM pg_temp.${table}`)).rows[0].count,rows.length);
 };
 const fresh=async(config,role,work)=>{
  const identities={wasalx_app:['wasalx_runtime','wasalx_runtime'],
   wasalx_connector_worker:['wasalx_connector_worker','wasalx_connector_worker_runtime'],
   wasalx_platform_operations_client:['wasalx_platform_operations_runtime','wasalx_platform_operations_runtime']};
  assert.ok(identities[role]);
  const c=new Client({...config,options:`${config.options??''} -c statement_timeout=5000 -c lock_timeout=3000`});await c.connect();
  try{
   const access=(await c.query(`SELECT current_user,session_user,pg_has_role(current_user,$1,'MEMBER') member,pg_has_role(session_user,$1,'MEMBER') session_member,
    has_database_privilege(current_user,current_database(),'TEMP') temporary,
    has_schema_privilege(current_user,'public','CREATE') public_create,has_schema_privilege(current_user,'app','CREATE') app_create,
    active.rolsuper,active.rolbypassrls,login.rolsuper session_super,login.rolbypassrls session_bypass
    FROM pg_catalog.pg_roles active JOIN pg_catalog.pg_roles login ON login.rolname=session_user WHERE active.rolname=current_user`,[role])).rows[0];
   assert.deepEqual(access,{current_user:identities[role][0],session_user:identities[role][1],member:true,session_member:true,
    temporary:true,public_create:false,app_create:false,rolsuper:false,rolbypassrls:false,session_super:false,session_bypass:false});
   await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);await work(c);
  }finally{await c.query('ROLLBACK');await c.end()}
 };
 const reject=async(c,work,code,message)=>{await c.query('SAVEPOINT routing_shadow_rejection');try{
  await assert.rejects(work,error=>error.code===code&&(!message||message.test(error.message)));
 }finally{await c.query('ROLLBACK TO SAVEPOINT routing_shadow_rejection')}};
 const guard=c=>c.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7)',[connectionId,sessionId,phoneNumberId,wabaId,participantId,appId,runtime]).then(result=>result.rows[0]);
 const appConfig={connectionString:f.appUrl};assert.equal(typeof f.platformOperationsUrl,'string');
 const signatures=[
  ['meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean)',false,['wasalx_app','wasalx_connector_worker']],
  ['operator_meta_routing_review(uuid,uuid,text,text)',true,['wasalx_platform_operations_client']],
  ['operator_record_meta_routing_review(uuid,uuid,jsonb,text,jsonb,text,text,text,text)',true,['wasalx_platform_operations_client']],
  ['resolve_meta_routing_routes(text,text,text,text)',true,['wasalx_app']],
  ['preserve_meta_routing_source()',false,['PUBLIC']],['disable_meta_routing_legacy()',true,[]],
  ['snapshot_meta_routing_delivery()',false,['PUBLIC']],['snapshot_meta_routing_native_intent()',false,['PUBLIC']],
  ['preserve_meta_thread_action()',false,[]],['guard_meta_thread_ownership()',false,[]],
  ['purge_expired_unmatched_events(interval,timestamp with time zone)',true,['wasalx_connector_worker']],
 ];
 for(const[signature,definer,grants]of signatures){
  const row=(await admin.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,pg_get_userbyid(n.nspowner) schema_owner,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,'grantable',acl.is_grantable) ORDER BY acl.grantee)
    FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND acl.privilege_type='EXECUTE'),'[]') grants
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=$1::regprocedure`,['app.'+signature])).rows[0];
  assert.equal(row.prosecdef,definer,signature);assert.equal(row.proconfig.find(value=>value.startsWith('search_path='))?.replaceAll(' ',''),'search_path=pg_catalog,public,app,pg_temp',signature);
  assert.equal(row.owner,signature.startsWith('purge_')?'wasalx_app':row.schema_owner,signature);
  if(definer)assert.ok(row.proconfig.includes(signature.startsWith('purge_')?'row_security=on':'row_security=off'),signature);
  assert.deepEqual(row.grants.map(value=>value.role).sort(),[...grants].sort(),signature);assert.ok(row.grants.every(value=>value.grantable===false),signature);
 }

 // 1. Platform-only observation, genuine persisted audit and exact CAS/idempotency.
 // A dedicated fixture connection keeps committed audit proof separate from the live fixture's review generation.
 const operatorConnection=randomUUID(),operatorSession=randomUUID(),operatorPhone=String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,16)));
 const declaredAt=new Date(Date.now()-10000).toISOString(),subject='synthetic-routing-shadow-'+randomUUID();
 await admin.query("INSERT INTO public.connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Lookup review fixture','META','CLOUD_API','PAUSED',$3)",[operatorConnection,tenantId,`secret://${tenantId}/connections/${operatorConnection}/meta`]);
 await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO public.provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
  VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[operatorSession,tenantId,operatorConnection,operatorPhone,`meta-cloud://${wabaId}/${operatorPhone}`,{wabaId,
   metaAccountProof:{...f.proof,connectionId:operatorConnection,providerSessionId:operatorSession,phoneNumberId:operatorPhone,secretReference:`secret://${tenantId}/connections/${operatorConnection}/meta`},
   metaRouting:{version:1,fallback:'HOLD',declaredAt}}]));
 const [operatorRealConnection]=await snapshot('connections','id=$1',[operatorConnection]);
 const [operatorRealSession]=await snapshot('provider_sessions','id=$1',[operatorSession]);
 const forgedConnection=randomUUID(),forgedSession=randomUUID();
 const viewRequest=randomUUID(),writeRequest=randomUUID(),key=randomUUID();let publicReview;
 await fresh({connectionString:f.platformOperationsUrl},'wasalx_platform_operations_client',async c=>{
  await shadow(c,'connections',[{...operatorRealConnection,provider:'WAHA'},{...operatorRealConnection,id:forgedConnection}]);
  await shadow(c,'provider_sessions',[{...operatorRealSession,opaque_session_id:'999',provider_state_data:{wabaId:'999',metaRouting:{version:99,declaredAt}}},
   {...operatorRealSession,id:forgedSession,connection_id:forgedConnection}]);
  await shadow(c,'meta_routing_reviews',[{...reviews[0],connection_id:operatorConnection,provider_session_id:operatorSession,review_version:99}]);
  await shadow(c,'platform_operations_audit_events');
  const view=(await c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4) value',[tenantId,operatorConnection,subject,viewRequest])).rows[0].value;
  assert.equal(view.sessionId,operatorSession);assert.equal(view.phoneNumberId,operatorPhone);assert.equal(view.declaration.version,1);assert.equal(view.review,null);
  await reject(c,()=>c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4)',[randomUUID(),operatorConnection,subject,randomUUID()]),'P0002');
  await reject(c,()=>c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4)',[tenantId,forgedConnection,subject,randomUUID()]),'P0002');
  const body={...reviews[0].observation,expectedSessionId:operatorSession,expectedConfigurationVersion:1,expectedReviewVersion:0,observedAt:new Date().toISOString()};
  const record=(value=body,k=key)=>c.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9) value',[tenantId,operatorConnection,value,appId,runtime,k,digest(value),subject,writeRequest]).then(result=>result.rows[0].value);
  for(const change of [{expectedSessionId:randomUUID()},{expectedConfigurationVersion:99},{expectedReviewVersion:99}])await reject(c,()=>record({...body,...change},randomUUID()),'40001');
  publicReview=await record();assert.equal(publicReview.version,1);assert.equal(publicReview.disposition,'REVIEWED');assert.equal((await record()).duplicate,true);
  await reject(c,()=>record({...body,disposition:'REVOKED'}),'23505');
  await reject(c,()=>c.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [tenantId,forgedConnection,{...body,expectedSessionId:forgedSession},appId,runtime,randomUUID(),digest(body),subject,randomUUID()]),'P0002');
  await c.query('SAVEPOINT routing_shadow_revocation');
  assert.equal((await record({...body,expectedReviewVersion:1,disposition:'REVOKED'},randomUUID())).disposition,'REVOKED');
  assert.equal((await c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4) value',[tenantId,operatorConnection,subject,randomUUID()])).rows[0].value.review.disposition,'REVOKED');
  await c.query('ROLLBACK TO SAVEPOINT routing_shadow_revocation');
  assert.equal((await c.query('SELECT count(*)::integer count FROM pg_temp.platform_operations_audit_events')).rows[0].count,0);
  assert.equal((await c.query('SELECT review_version FROM pg_temp.meta_routing_reviews')).rows[0].review_version,'99');
  await reject(c,()=>c.query('SELECT * FROM public.meta_routing_reviews'),'42501');
  await c.query('COMMIT');
 });
 const persisted=(await admin.query('SELECT id,review_version,provider_session_id FROM public.meta_routing_reviews WHERE connection_id=$1',[operatorConnection])).rows;
 assert.deepEqual(persisted,[{id:publicReview.id,review_version:'1',provider_session_id:operatorSession}]);
 assert.deepEqual((await admin.query('SELECT request_id,action FROM public.platform_operations_audit_events WHERE operator_subject=$1 ORDER BY action',[subject])).rows,
  [{request_id:viewRequest,action:'platform.meta_routing.inspected'},{request_id:writeRequest,action:'platform.meta_routing.reviewed'}]);

 // 2. Resolver cannot route a caller's temporary asset or hide the real exact route.
 const routeSecret='secret://platform/routing-shadow-'+randomUUID();
 await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO public.webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,$4,'PAUSED')",[tenantId,operatorConnection,operatorPhone,routeSecret]));
 const [realTenant]=await snapshot('tenants','id=$1',[tenantId]);
 const [realRoute]=await snapshot('webhook_routes','connection_id=$1',[operatorConnection]);
 await fresh(appConfig,'wasalx_app',async c=>{
  await shadow(c,'connections',[{...operatorRealConnection,id:forgedConnection}]);
  await shadow(c,'provider_sessions',[{...operatorRealSession,id:forgedSession,connection_id:forgedConnection,opaque_session_id:'999'}]);
  await shadow(c,'tenants',[realTenant]);await shadow(c,'webhook_routes',[{...realRoute,connection_id:forgedConnection,external_key:'999'}]);
  const resolve=(account=wabaId,phoneId=operatorPhone,secret=routeSecret,application=appId)=>c.query('SELECT * FROM app.resolve_meta_routing_routes($1,$2,$3,$4)',[account,phoneId,application,secret]);
  const real=await resolve();assert.equal(real.rowCount,1);assert.equal(real.rows[0].provider_session_id,operatorSession);assert.equal(real.rows[0].connection_id,operatorConnection);
  assert.equal((await resolve('999')).rowCount,0);assert.equal((await resolve(wabaId,'999')).rowCount,0);assert.equal((await resolve(wabaId,operatorPhone,'secret://wrong')).rowCount,0);
  assert.equal((await resolve(wabaId,operatorPhone,routeSecret,'999')).rowCount,0);
  await c.query('SAVEPOINT routing_shadow_retirement');
  assert.equal((await c.query("UPDATE public.provider_sessions SET ownership_state='RETIRED',retired_at=clock_timestamp() WHERE id=$1",[operatorSession])).rowCount,1);
  assert.equal((await resolve()).rowCount,0);await c.query('ROLLBACK TO SAVEPOINT routing_shadow_retirement');
  await reject(c,()=>c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4)',[tenantId,operatorConnection,subject,randomUUID()]),'42501');
  await reject(c,()=>c.query("UPDATE public.meta_routing_reviews SET disposition='REVOKED' WHERE id=$1",[publicReview.id]),'42501');
  assert.equal((await admin.query("UPDATE public.tenants SET state='SUSPENDED' WHERE id=$1",[tenantId])).rowCount,1);
  try{assert.equal((await resolve()).rowCount,0)}finally{assert.equal((await admin.query("UPDATE public.tenants SET state='ACTIVE' WHERE id=$1",[tenantId])).rowCount,1)}
 });

 // Remaining groups use rollback-only state and never create a provider request.
 await verifyRoutingShadowEffects({f,appConfig,runtime,session,connection,reviews,ownership,conversation,participant,aliases,phoneAlias,shadow,fresh,reject,guard,digest});
}

async function verifyRoutingShadowEffects({f,appConfig,runtime,session,connection,reviews,ownership,conversation,participant,aliases,phoneAlias,shadow,fresh,reject,guard,digest}){
 const {tenantId,connectionId,sessionId,participantId,conversationId,phoneNumberId,wabaId,appId,phone}=f;
 let sourceSequence=0;
 const signal=async(c,category='CONTROL_TAKEN',boundSession=sessionId)=>{
  const time=Math.floor(Date.now()/1000)+5+(sourceSequence++),value={messaging_product:'whatsapp',recipient:{phone_number_id:phoneNumberId},
   type:category==='CONTROL_TAKEN'?'control_taken':'control_passed',timestamp:String(time),sender:{phone_number:phone}};
  const unit=metaRoutingUnits(wabaId,'messaging_handovers',value)[0];assert.equal(unit.evidence.category,category);
  const payload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messaging_handovers',value:unit.value}]}]};
  const evidence={...unit.evidence,providerSessionId:boundSession,appId},id=randomUUID();
  await c.query(`INSERT INTO public.event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,meta_routing_evidence)
   VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.passive',$4,$5,'PROCESSING',$6,clock_timestamp()+interval '5 minutes',$7)`,
   [id,tenantId,connectionId,payload,evidence.payloadSha256,randomUUID(),evidence]);
  return{id,evidence};
 };
 const reserve=async(c,recipient=phoneAlias.value)=>{
  const id=randomUUID(),hash=digest({id,recipient});
  const row=(await c.query(`INSERT INTO public.meta_thread_control_actions(id,tenant_id,connection_id,provider_session_id,participant_identity_id,conversation_id,
   phone_number_id,account_id,app_id,routing_epoch,configuration_version,review_version,action,recipient_snapshot,runtime_binding,credential_context,actor_id,idempotency_key,request_sha256)
   VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'take',$13,$14,$15,$16,$1::text,$17) RETURNING id`,
   [id,tenantId,connectionId,sessionId,participantId,conversationId,phoneNumberId,wabaId,appId,ownership.epoch,reviews[0].configuration_version,reviews[0].review_version,
    {kind:'PHONE',value:recipient},runtime,{secretReference:f.secretReference,proof:f.proof},f.userId,hash])).rows[0];
  assert.equal(row.id,id);return{id,hash};
 };

 // 3. A temp inventory cannot remove pending signed negatives, UNKNOWN actions,
 // config invalidation or the current immutable source/epoch. Both readers run
 // as real logins; only ingress may insert a signed negative into the inbox.
 for(const[config,role]of [[appConfig,'wasalx_app'],[f.workerConfig,'wasalx_connector_worker']]){
  await fresh(config,role,async c=>{
   await shadow(c,'provider_sessions',[session]);await shadow(c,'connections',[connection]);
   await shadow(c,'meta_routing_reviews',reviews);await shadow(c,'meta_thread_ownership',[{...ownership,epoch:999}]);
   await shadow(c,'event_inbox');await shadow(c,'meta_thread_control_actions');await shadow(c,'meta_routing_legacy_admissions');
   assert.equal((await guard(c)).allowed,true);assert.equal((await guard(c)).epoch,String(ownership.epoch));
   assert.equal((await c.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [connectionId,sessionId,phoneNumberId,wabaId,participantId,appId,runtime,ownership.epoch,[f.sourceEventId]])).rows[0].allowed,true);
   await c.query('SAVEPOINT real_routing_unknown');const action=await reserve(c);
   await c.query("UPDATE public.meta_thread_control_actions SET state='OUTCOME_UNKNOWN',completed_at=clock_timestamp(),error_code='SYNTHETIC_UNKNOWN' WHERE id=$1",[action.id]);
   assert.equal((await guard(c)).reason,'ACTION_UNRESOLVED');
   assert.equal((await c.query('SELECT count(*)::integer count FROM pg_temp.meta_thread_control_actions')).rows[0].count,0);
   await c.query('ROLLBACK TO SAVEPOINT real_routing_unknown');
   if(role==='wasalx_app'){
    await c.query('SAVEPOINT real_routing_negative');const negative=await signal(c);
    assert.equal((await guard(c)).reason,'NEGATIVE_PENDING');
    assert.equal((await c.query('SELECT meta_routing_evidence->>\'category\' category FROM public.event_inbox WHERE id=$1',[negative.id])).rows[0].category,'CONTROL_TAKEN');
    assert.equal((await c.query('SELECT count(*)::integer count FROM pg_temp.event_inbox')).rows[0].count,0);
    await c.query('ROLLBACK TO SAVEPOINT real_routing_negative');
   }else await reject(c,()=>signal(c),'42501');
   await c.query('SAVEPOINT real_routing_config');
   assert.equal((await c.query("UPDATE public.provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaRouting,version}','99') WHERE id=$1",[sessionId])).rowCount,1);
   assert.equal((await guard(c)).reason,'CONFIGURATION_REQUIRED');await c.query('ROLLBACK TO SAVEPOINT real_routing_config');
   assert.equal((await guard(c)).allowed,true);
   await reject(c,()=>c.query('SELECT app.operator_meta_routing_review($1,$2,$3,$4)',[tenantId,connectionId,'synthetic-shadow',randomUUID()]),'42501');
   await reject(c,()=>c.query("UPDATE public.meta_routing_reviews SET disposition='REVOKED' WHERE id=$1",[reviews[0].id]),'42501');
   await reject(c,()=>c.query("INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id) VALUES('synthetic-shadow','platform.meta_routing.reviewed','connection',$1,'{}',$2)",[connectionId,randomUUID()]),'42501');
  });
 }

 // 4. Preserve the real event/session binding, not a well-shaped fake session.
 await fresh(appConfig,'wasalx_app',async c=>{
  const fakeSession=randomUUID();await shadow(c,'provider_sessions',[{...session,id:fakeSession}]);
  await reject(c,()=>signal(c,'CONTROL_TAKEN',fakeSession),'23514',/invalid routing admission/);
  const genuine=await signal(c);
  assert.equal((await c.query("SELECT meta_routing_evidence->>'providerSessionId' session FROM public.event_inbox WHERE id=$1",[genuine.id])).rows[0].session,sessionId);
  assert.equal((await c.query('SELECT id FROM pg_temp.provider_sessions')).rows[0].id,fakeSession);
 });

 // 5. A fake non-Meta row must not skip snapshot admission in either queue.
 await fresh(appConfig,'wasalx_app',async c=>{
  await shadow(c,'connections',[{...connection,provider:'WAHA',engine:'GOWS'}]);
  await shadow(c,'provider_sessions',[session]);await shadow(c,'participant_identities');await shadow(c,'meta_routing_reviews');
  await shadow(c,'bot_conversations',[conversation]);await shadow(c,'delivery_outbox');
  const delivery=async()=>{
   const id=randomUUID();return(await c.query(`INSERT INTO public.delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
    message_body,content_type,idempotency_key,state,direct_origin,meta_routing_source_event_id,zammad_article_id)
    VALUES($1::uuid,$2,$3,$4,$5,'98231','Synthetic lookup queue','text/plain',$1::text,'QUEUED','HUMAN',$6,$7) RETURNING id,meta_routing_epoch,meta_routing_source_event_id,meta_direct_recipient`,
    [id,tenantId,connectionId,conversationId,phone,f.sourceEventId,String(BigInt('0x'+id.replaceAll('-','').slice(0,12))+1n)])).rows[0];
  };
  const native=async()=>{
   const id=randomUUID();return(await c.query(`INSERT INTO public.direct_native_reply_intents(id,tenant_id,conversation_id,instance_id,native_ticket_id,native_actor_id,human_ownership_epoch,request_sha256)
    VALUES($1,$2,$3,$4,'98231','3',$5,$6) RETURNING id,meta_routing_epoch`,[id,tenantId,conversationId,f.instanceId,conversation.human_ownership_epoch,'e'.repeat(64)])).rows[0];
  };
  const queued=await delivery(),intent=await native();
  assert.equal(queued.meta_routing_epoch,String(ownership.epoch));assert.equal(queued.meta_routing_source_event_id,f.sourceEventId);
  // This composes the separately repaired P03 snapshot; routing never replaces it.
  assert.equal(queued.meta_direct_recipient.claim,'ALIAS_VERIFIED');assert.equal(queued.meta_direct_recipient.participantId,participantId);
  assert.deepEqual(queued.meta_direct_recipient.asset,{providerSessionId:sessionId,phoneNumberId,wabaId});
  assert.equal(intent.meta_routing_epoch,String(ownership.epoch));
  assert.equal((await c.query('SELECT count(*)::integer count FROM pg_temp.delivery_outbox')).rows[0].count,0);
  const before=(await c.query('SELECT count(*)::integer count FROM public.delivery_outbox WHERE connection_id=$1',[connectionId])).rows[0].count;
  const nativeBefore=(await c.query('SELECT count(*)::integer count FROM public.direct_native_reply_intents WHERE conversation_id=$1',[conversationId])).rows[0].count;
  await signal(c);
  await reject(c,delivery,'23514',/^routing effect held$/);await reject(c,native,'23514',/^native routing held$/);
  assert.equal((await c.query('SELECT count(*)::integer count FROM public.delivery_outbox WHERE connection_id=$1',[connectionId])).rows[0].count,before);
  assert.equal((await c.query('SELECT count(*)::integer count FROM public.direct_native_reply_intents WHERE conversation_id=$1',[conversationId])).rows[0].count,nativeBefore);
 });

 // 6. Exact public alias, signed source and durable receipt control all projection.
 await fresh(appConfig,'wasalx_app',async c=>{
  await shadow(c,'bot_conversations',[conversation]);await shadow(c,'participant_identities',[participant]);
  await shadow(c,'meta_direct_identity_aliases',aliases.map(row=>({...row,value:'999'})));
  await shadow(c,'meta_routing_reviews',reviews.map(row=>({...row,review_version:999})));
  await shadow(c,'event_inbox');await shadow(c,'meta_thread_control_actions');
  await reject(c,()=>reserve(c,'999'),'23514',/^invalid routing action reservation$/);
  const action=await reserve(c);
  const persisted=(await c.query('SELECT recipient_snapshot FROM public.meta_thread_control_actions WHERE id=$1',[action.id])).rows[0];
  assert.deepEqual(persisted.recipient_snapshot,{kind:'PHONE',value:phone});
  await c.query(`UPDATE public.meta_thread_control_actions SET dispatched_at=clock_timestamp(),state='SUCCEEDED',provider_request_id='synthetic-shadow-receipt',
   completed_at=date_trunc('milliseconds',clock_timestamp())+interval '123 microseconds' WHERE id=$1`,[action.id]);
  await c.query("INSERT INTO pg_temp.meta_thread_control_actions SELECT * FROM public.meta_thread_control_actions WHERE id=$1",[action.id]);
  await c.query("UPDATE pg_temp.meta_thread_control_actions SET request_sha256=$1,completed_at=completed_at+interval '1 second'",['b'.repeat(64)]);
  const projectReceipt=(hash)=>c.query(`UPDATE public.meta_thread_ownership ownership SET state='OWN',epoch=ownership.epoch+1,
   observed_at=action.completed_at,epoch_started_at=action.completed_at,source_hash=$1,source_event_id=NULL,source_action_id=action.id
   FROM public.meta_thread_control_actions action WHERE ownership.tenant_id=$2 AND ownership.connection_id=$3 AND ownership.participant_identity_id=$4 AND action.id=$5
   RETURNING ownership.observed_at=action.completed_at exact`,[hash,tenantId,connectionId,participantId,action.id]);
  await reject(c,()=>projectReceipt('b'.repeat(64)),'23514',/^routing ownership receipt changed$/);
  assert.deepEqual((await projectReceipt(action.hash)).rows,[{exact:true}]);
  assert.equal((await c.query('SELECT mod(extract(microseconds FROM observed_at)::integer,1000) micros FROM public.meta_thread_ownership WHERE connection_id=$1 AND participant_identity_id=$2',[connectionId,participantId])).rows[0].micros,123);
  const positive=await signal(c,'CONTROL_PASSED');
  await c.query('INSERT INTO pg_temp.event_inbox SELECT * FROM public.event_inbox WHERE id=$1',[positive.id]);
  await c.query("UPDATE pg_temp.event_inbox SET payload_sha256=$1,meta_routing_evidence=jsonb_set(meta_routing_evidence,'{payloadSha256}',to_jsonb($1::text))",['c'.repeat(64)]);
  const projectSource=hash=>c.query(`UPDATE public.meta_thread_ownership SET state='OWN',epoch=epoch+1,observed_at=$1::timestamptz,epoch_started_at=$1::timestamptz,
   source_hash=$2,source_action_id=NULL,source_event_id=$3 WHERE tenant_id=$4 AND connection_id=$5 AND participant_identity_id=$6 RETURNING source_hash,source_event_id`,
   [positive.evidence.observedAt,hash,positive.id,tenantId,connectionId,participantId]);
  await reject(c,()=>projectSource('c'.repeat(64)),'23514',/^routing ownership source changed$/);
  assert.deepEqual((await projectSource(positive.evidence.payloadSha256)).rows,[{source_hash:positive.evidence.payloadSha256,source_event_id:positive.id}]);
  await reject(c,()=>c.query('DELETE FROM public.meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),'23514',/requires privacy authority/);
  assert.equal((await c.query('SELECT state FROM public.meta_thread_ownership WHERE connection_id=$1 AND participant_identity_id=$2',[connectionId,participantId])).rows[0].state,'OWN');
 });
}
