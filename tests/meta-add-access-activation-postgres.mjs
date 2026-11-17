import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {ConnectionOperationRepository} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js';
import {ConnectionOperationProcessor} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js';
import {MetaRoutingService} from '../services/control-api/dist/meta-routing.service.js';
import {requestMetaCustomerPolicy} from '../services/control-api/dist/meta-account-policy.js';
import {metaBillingDiagnosticBinding} from '../packages/core/dist/meta-billing-diagnostic.js';
import {metaAccountFundingProof} from '../packages/core/dist/meta-account-policy.js';
import {metaRoutingRuntime} from '../packages/core/dist/meta-routing.js';

/** Consumes the canonical, actual-role P05 saved-access fixture. No second stack,
 * simulated provider mutation, schema bypass, or substitute grant is created. */
export async function verifyMetaSavedAccessActivation({admin,db,workerPool,controller,request,stored,connectionId,appId}){
 const tenant=request.principal.tenantId,owner=request.principal.userId,oldFetch=globalThis.fetch;
 const operations=new ConnectionOperationRepository(workerPool),runtime=metaRoutingRuntime(process.env);
 const tx=(pool,work)=>{if(pool==='app')return db.withTenant(tenant,work);return(async()=>{const c=await workerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}})();};
 const state=async()=>(await admin.query(`SELECT c.state,c.secret_reference,ps.id AS session_id,ps.state AS session_state,ps.opaque_session_id,ps.provider_state_data,wr.state AS route_state
  FROM connections c JOIN provider_sessions ps ON ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
  JOIN webhook_routes wr ON wr.connection_id=c.id AND wr.provider='META' WHERE c.id=$1`,[connectionId])).rows[0];
 const snapshot=await state(),sessionId=snapshot.session_id,phone=snapshot.opaque_session_id,account=snapshot.provider_state_data.wabaId;
 const business=snapshot.provider_state_data.metaSignup.businessId,token=stored.get(snapshot.secret_reference).accessToken;
 const current=()=>controller.metaSavedAccessActivation(request,connectionId);
 const queue=async(key=randomUUID(),body)=>{const view=await current();return controller.activateMetaSavedAccess(request,connectionId,key,body??{expectedContextVersion:view.contextVersion});};
 const claim=async()=>{const lease=randomUUID(),jobs=await operations.claim(tenant,lease,25);assert.equal(jobs.length,1);assert.equal(jobs[0].connectionId,connectionId);return{job:jobs[0],lease};};
 const routing=new MetaRoutingService(db,{});let ready='AVAILABLE',subscribed=true,registered=true,readHook;
 const requests=[],resolved=[];
 const processor=new ConnectionOperationProcessor(operations,{resolve:async reference=>{resolved.push(reference);return stored.get(reference);}},
  {wahaBaseUrl:'https://unused.example.invalid',publicWebhookBaseUrl:'https://portal.example.invalid',metaGraphVersion:'v24.0',metaAppId:appId,workerIdentity:'saved-access-activation-fixture'});
 const review=async(disposition='REVIEWED')=>{
  const config=await routing.configuration(request,connectionId);
  const body={expectedSessionId:sessionId,expectedConfigurationVersion:config.configurationVersion,expectedReviewVersion:config.reviewVersion,
   disposition,observedAt:new Date().toISOString(),evidenceSha256:'e'.repeat(64),evidenceReference:'synthetic-p05a3-local-observation',scope:'PHONE_OVERRIDE',
   roles:['customer_service'],targets:[],fields:['messages','standby','messaging_handovers'],termsAccepted:true,threadControlEnabled:true,personallyObserved:true};
  await admin.query('BEGIN');try{await admin.query('SET LOCAL ROLE wasalx_platform_operations_client');
   await admin.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9)',[tenant,connectionId,body,appId,runtime,randomUUID(),createHash('sha256').update(JSON.stringify(body)).digest('hex'),'synthetic-p05a3-reviewer','synthetic-p05a3-request']);await admin.query('COMMIT');
  }catch(e){await admin.query('ROLLBACK');throw e;}
 };
 const funded=async()=>{
  const s=await state(),binding=metaBillingDiagnosticBinding(s.secret_reference,{id:sessionId,opaqueSessionId:phone,providerStateData:s.provider_state_data},appId);
  await tx('app',client=>requestMetaCustomerPolicy(client,{tenantId:tenant,connectionId,userId:owner,idempotencyKey:randomUUID(),expectedRevision:0,requestId:'synthetic-activation-funding',binding,proof:s.provider_state_data.metaAccountProof}));
  const diagnostic=await claim(),proof=metaAccountFundingProof(account,{id:account,owner_business:{id:business}},{id:account,primary_funding_id:'synthetic-activation-funding'});
  await operations.completeMetaBillingDiagnostic(diagnostic.job,diagnostic.lease,appId,proof.diagnostic,proof.funding);
 };
 const unchanged=async()=>{const s=await state();assert.equal(s.state,'PAUSED');assert.equal(s.session_state,'PAUSED');assert.equal(s.route_state,'PAUSED');assert.equal(s.secret_reference,snapshot.secret_reference);
  assert.deepEqual(s.provider_state_data.metaAccountProof,snapshot.provider_state_data.metaAccountProof);assert.deepEqual(s.provider_state_data.metaSignup,snapshot.provider_state_data.metaSignup);};
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.method??'GET','GET','Activation has no provider mutation authority');assert.equal(init.headers.authorization,`Bearer ${token}`);
  requests.push({path:url.pathname,fields:url.searchParams.get('fields')});if(readHook){const hook=readHook;readHook=undefined;await hook();}
  if(url.pathname===`/v24.0/${account}`)return Response.json({id:account,owner_business:{id:business}});
  if(url.pathname.endsWith('/owned_whatsapp_business_accounts'))return Response.json({data:[{id:account}]});
  if(url.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:phone,status:registered?'CONNECTED':'PENDING',code_verification_status:'VERIFIED',host_platform:'CLOUD_API',account_mode:'LIVE'}]});
  if(url.pathname.endsWith('/subscribed_apps'))return Response.json({data:subscribed?[{whatsapp_business_api_data:{id:appId}}]:[]});
  if(url.searchParams.get('fields')==='health_status')return Response.json({health_status:{can_send_message:ready,entities:[{entity_type:'PHONE_NUMBER',id:phone,can_send_message:ready},{entity_type:'WABA',id:account,can_send_message:ready},{entity_type:'APP',id:appId,can_send_message:ready}]}});
  if(url.pathname===`/v24.0/${phone}`)return Response.json({id:phone,is_on_biz_app:false,platform_type:'CLOUD_API'});
  assert.fail(`Unexpected saved-access GET ${url.pathname}`);
 };
 try{
  await unchanged();assert.equal((await current()).reason,'FUNDING_REQUIRED');
  await funded();assert.equal((await current()).reason,'ROUTING_REVIEW_REQUIRED');
  const before=await routing.configuration(request,connectionId);await routing.declare(request,connectionId,randomUUID(),{expectedSessionId:sessionId,expectedVersion:before.configurationVersion,fallback:'HOLD'});
  await review();assert.equal((await current()).reason,'READY_TO_CHECK');
  await verifyActivationLookupAndActionScope({admin,tx,tenant,owner,connectionId,sessionId,phone,account,appId,runtime});
  assert.equal((await admin.query('SELECT count(*)::int n FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2',[tenant,connectionId])).rows[0].n,0,'No existing per-thread OWN is required for receiving admission');
  assert.equal((await tx('app',c=>c.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,NULL,$5,$6)',[connectionId,sessionId,phone,account,appId,runtime]))).rows[0].allowed,false,'Sending remains separately held');
  const foreign=randomUUID();assert.equal((await db.withTenant(foreign,c=>c.query('SELECT app.meta_add_access_activation_context($1,$2,$3) value',[connectionId,appId,runtime]))).rows[0].value.reason,'PRIVACY_HOLD');
  const captured=await current(),key=randomUUID();const duplicates=await Promise.all([queue(key,{expectedContextVersion:captured.contextVersion}),queue(key,{expectedContextVersion:captured.contextVersion})]);
  assert.equal(duplicates[0].operation.id,duplicates[1].operation.id);assert.equal(duplicates.filter(x=>x.duplicate).length,1);await unchanged();assert.equal(requests.length,0);
  await assert.rejects(()=>queue(key,{expectedContextVersion:'f'.repeat(64)}),/another operation/);
  await assert.rejects(()=>tx('app',c=>c.query("UPDATE connection_operations SET result='{\"metaAddAccessActivated\":true}' WHERE id=$1",[duplicates[0].operation.id])),/original current worker lease/);
  const supportingOwner=randomUUID();await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Activation supporting owner')",[supportingOwner,`activation-${supportingOwner}`,`${supportingOwner}@example.invalid`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[tenant,supportingOwner]);
  await admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[tenant,owner]);
  const denied=await processor.drainTenant(tenant);assert.equal(denied.failedTerminal,1);assert.equal(resolved.length,0);assert.equal(requests.length,0);await unchanged();
  await admin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2",[tenant,owner]);
  await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[tenant,supportingOwner]);
  await queue();const fenced=await claim();const sessionLease=await operations.acquireProviderSessionLease(fenced.job,fenced.lease,'synthetic-activation-fence');
  await assert.rejects(async()=>operations.complete({...fenced.job,fencingToken:fenced.job.fencingToken+1},fenced.lease,sessionLease,
   {connectionState:'WORKING',providerState:'AVAILABLE',engine:'CLOUD_API',actionReason:null,webhookState:'ACTIVE',providerStateData:(await state()).provider_state_data,
    result:{metaAddAccessActivated:true,providerReadback:{registered:true,subscribed:true,messaging:'AVAILABLE'},conversationPermission:'SEPARATE_REQUIRED'}}),/lease/i);
  await unchanged();await operations.fail(fenced.job,fenced.lease,sessionLease,{retryable:false,code:'SYNTHETIC_FENCE_STOP',safeError:'Synthetic stale-completion fixture finished',connectionState:'PAUSED'});
  const stale=await current();await review('REVOKED');await assert.rejects(()=>queue(randomUUID(),{expectedContextVersion:stale.contextVersion}),e=>e.getResponse?.().code==='META_ADD_ACCESS_ACTIVATION_CHANGED');await review();
  // Before-provider and late-read drift both remain paused. The GET may have
  // completed, but it is not sufficient authority for a local activation.
  for(const scenario of ['unregistered','unsubscribed','blocked','review-drift']){
   registered=scenario!=='unregistered';subscribed=scenario!=='unsubscribed';ready=scenario==='blocked'?'BLOCKED':'AVAILABLE';
   if(scenario==='review-drift')readHook=()=>review('REVOKED');
   await queue();const result=await processor.drainTenant(tenant);assert.equal(result.failedTerminal,1);await unchanged();
   if(scenario==='review-drift')await review();
  }
  registered=true;subscribed=true;ready='AVAILABLE';await queue();const successful=await processor.drainTenant(tenant);assert.equal(successful.succeeded,1);
  const installed=await state();assert.equal(installed.state,'WORKING');assert.equal(installed.session_state,'WORKING');assert.equal(installed.route_state,'ACTIVE');
  assert.deepEqual(installed.provider_state_data.metaAccountProof,snapshot.provider_state_data.metaAccountProof);assert.deepEqual(installed.provider_state_data.metaSignup,snapshot.provider_state_data.metaSignup);
  const visible=await current();assert.equal(visible.operation.locallyActivated,true);assert.equal(visible.readyToCheck,false);assert.equal(visible.reason,'PAUSE_REQUIRED');
  assert.equal((await tx('app',c=>c.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,NULL,$5,$6)',[connectionId,sessionId,phone,account,appId,runtime]))).rows[0].allowed,false,'Activation creates no conversation authority');
  assert.ok(requests.length>0);assert.ok(!requests.some(x=>/register|messages|payment|migration|credit/.test(x.path)));assert.doesNotMatch(JSON.stringify(visible),/secret:|wabaId|credentialFingerprint|proofSha256/);
  return{actualDatabaseRoles:true,providerMode:'SIMULATED_GET_ONLY',receivingActivated:true,sendAuthorityGranted:false};
 }finally{globalThis.fetch=oldFetch;}
}

async function verifyActivationLookupAndActionScope({admin,tx,tenant,owner,connectionId,sessionId,phone,account,appId,runtime}){
 // A real app role can create private temporary relations. Neither those
 // relations nor a caller search path may replace permanent authority tables.
 await tx('app',async c=>{
  for(const name of ['connections','provider_sessions','tenant_memberships','meta_signup_attempts','webhook_routes','connection_operations','meta_messaging_accounts','meta_connection_account_bindings','meta_billing_policy_versions','meta_routing_reviews','meta_thread_control_actions','event_inbox']){
   await c.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS) ON COMMIT DROP`);
  }
  await c.query('SET LOCAL search_path=pg_temp,public,app');
  const read=await c.query('SELECT app.meta_add_access_activation_context($1,$2,$3) value',[connectionId,appId,runtime]);
  assert.equal(read.rows[0].value.reason,'READY_TO_CHECK','Permanent context survives empty temporary shadow relations');
  assert.equal((await c.query('SELECT app.meta_add_access_activation_actor($1) allowed',[owner])).rows[0].allowed,true);
 });
 // A mapped participant's pending action is invisible to the NULL-participant
 // routing call. The dedicated activation query must still hold the whole asset.
 // The admin only prepares an isolated rolled-back relational fixture; app-role
 // alias/action and admission execute their real checks without disabling them.
 await admin.query('BEGIN');try{
  await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
  const participant=randomUUID(),event=randomUUID(),family=randomUUID(),version=randomUUID(),assignment=randomUUID(),conversation=randomUUID(),action=randomUUID(),peer='15550102998';
  const payload={object:'whatsapp_business_account',entry:[{id:account,changes:[{field:'messages',value:{metadata:{phone_number_id:phone},messages:[{id:`synthetic-${event}`,from:peer,type:'text',text:{body:'Synthetic prior conversation'}}]}}]}]};
  const payloadSha=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,attempts,lease_id,lease_expires_at,meta_direct_asset)
    VALUES($1,$2,$3,'META',$1::uuid::text,'messages',$4,$5,'PROCESSING',1,$6,clock_timestamp()+interval '10 minutes',$7)`,[event,tenant,connectionId,payload,payloadSha,randomUUID(),{providerSessionId:sessionId,phoneNumberId:phone,wabaId:account}]);
  await admin.query('INSERT INTO participant_identities(id,tenant_id,connection_id,external_participant_id) VALUES($1,$2,$3,$4)',[participant,tenant,connectionId,peer]);
  await admin.query("INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)",[family,tenant,`activation-${family}`,owner]);
  const definition={schemaVersion:1,name:'Activation fixture',start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]};
  await admin.query(`INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at)
    VALUES($1,$2,$3,1,'ACTIVE',$4,$5,$6,$6,clock_timestamp())`,[version,tenant,family,definition,createHash('sha256').update(JSON.stringify(definition)).digest('hex'),owner]);
  await admin.query(`INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,'Operations','ACTIVE',$6,$6)`,[assignment,tenant,connectionId,family,version,owner]);
  const reference=`BOT-${createHash('sha256').update(`${tenant}:${assignment}:${peer}`).digest('hex').slice(0,12).toUpperCase()}`;
  await admin.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,last_activity_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'BOT','done',clock_timestamp())`,[conversation,tenant,assignment,connectionId,version,peer,reference]);
  await admin.query('SET LOCAL ROLE wasalx_app');
  await admin.query(`INSERT INTO meta_direct_identity_aliases(tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id,source_payload_sha256)
    VALUES($1,$2,$3,$4,$5,$6,'PHONE',$7,$8,$9)`,[tenant,connectionId,participant,sessionId,phone,account,peer,event,payloadSha]);
  await admin.query(`INSERT INTO meta_thread_control_actions(id,tenant_id,connection_id,provider_session_id,participant_identity_id,conversation_id,phone_number_id,account_id,app_id,
    routing_epoch,configuration_version,review_version,action,recipient_snapshot,runtime_binding,credential_context,actor_id,idempotency_key,request_sha256)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,1,r.configuration_version,r.review_version,'take',$10,$11,'{}',$12,$1::uuid::text,repeat('a',64)
    FROM meta_routing_reviews r WHERE tenant_id=$2 AND connection_id=$3 ORDER BY review_version DESC LIMIT 1`,
    [action,tenant,connectionId,sessionId,participant,conversation,phone,account,appId,{kind:'PHONE',value:peer},runtime,owner]);
  for(const state of ['RUNNING','OUTCOME_UNKNOWN']){
   if(state==='OUTCOME_UNKNOWN')await admin.query("UPDATE meta_thread_control_actions SET state='OUTCOME_UNKNOWN',completed_at=clock_timestamp() WHERE id=$1",[action]);
   assert.equal((await admin.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,NULL,$5,$6,NULL,NULL,NULL,false)',[connectionId,sessionId,phone,account,appId,runtime])).rows[0].allowed,true,'Configuration-only routing is not whole-asset unresolved-action admission');
   assert.equal((await admin.query('SELECT app.meta_add_access_activation_context($1,$2,$3) value',[connectionId,appId,runtime])).rows[0].value.reason,'CONTROL_UNRESOLVED');
  }
 }finally{await admin.query('ROLLBACK');}
}
