import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Client,Pool} from 'pg';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {classifyMetaLifecycleValue,metaLifecyclePayloadSha256,metaLifecycleBlockingReasons} from '../services/connector-worker/dist/packages/core/src/meta-account-relation.js';

// Only called by the existing isolated canonical PostgreSQL gate.
export async function verifyMetaLifecycleWorker(adminUrl,workerConfig){
 const admin=new Client({connectionString:adminUrl});await admin.connect();
 const pool=new Pool(workerConfig),repository=new InboundRepository(pool);
 const tenantId=randomUUID(),connectionId=randomUUID(),providerSessionId=randomUUID();
 const appId='12025550130',phoneNumberId='15550001001',wabaId='987654321098765',displayPhoneNumber='12025550103';
 const asset={providerSessionId,phoneNumberId,wabaId,appId};
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,providerSessionId,phoneNumberId,wabaId,displayPhoneNumber,
   secretReference:`secret://${tenantId}/connections/${connectionId}/meta`,credentialFingerprint:'a'.repeat(64),operationId:randomUUID(),fencingToken:1,
   graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'b'.repeat(64),credentialMetadata:{appId}};
 const baseTime=Math.floor(Date.now()/1000)-300;
 const state=async()=>(await admin.query(`SELECT connection.state AS connection_state,session.state AS session_state,session.ownership_state,session.provider_state_data
   FROM connections connection JOIN provider_sessions session ON session.connection_id=connection.id AND session.tenant_id=connection.tenant_id
   WHERE connection.id=$1 AND session.id=$2`,[connectionId,providerSessionId])).rows[0];
 const guard=revision=>repository.tenant(tenantId,async client=>(await client.query('SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)',[connectionId,providerSessionId,phoneNumberId,wabaId,appId,revision])).rows[0]);
 const add=async(value,offset,{phoneScope='ACCOUNT',entryId,leaseId=randomUUID(),expired=false,mutate}={})=>{
   const id=randomUUID(),classified=classifyMetaLifecycleValue(value,appId),time=baseTime+offset;
   const effective=phoneScope==='UNRESOLVED_DISPLAY'?classified.kind==='BLOCK'?{kind:'BLOCK'}:{kind:'OBSERVATION'}:classified;
   const eventType=`meta.account.lifecycle.${effective.kind.toLowerCase()}`;
   const unit={object:'whatsapp_business_account',entry:[{id:entryId??(classified.event.startsWith('PARTNER_')&&Object.hasOwn(value,'waba_info')?'777777777':wabaId),time,changes:[{field:'account_update',value}]}]};
   const payload={...unit,admission:{schemaVersion:1,observedAt:new Date(time*1000).toISOString(),providerPayloadSha256:metaLifecyclePayloadSha256(unit),
     kind:classified.kind,reasons:classified.reasons,asset,phoneScope}};
   if(mutate)mutate(payload);
   await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,attempts)
     VALUES($1,$2,$3,'META',$4,$5,$6,$7,'PROCESSING',$8,clock_timestamp()+($9::integer * interval '1 second'),1)`,
     [id,tenantId,connectionId,`lifecycle-${id}`,eventType,payload,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),leaseId,expired?-1:60]);
   // Read JSONB back: real key reordering must not invalidate semantic unit identity.
   const stored=(await admin.query('SELECT payload FROM event_inbox WHERE id=$1',[id])).rows[0].payload;
   return{event:{id,tenantId,connectionId,provider:'meta',eventType,providerEventId:`lifecycle-${id}`,payload:stored,attempts:1},leaseId};
 };
 const apply=async(input)=>repository.applyMetaLifecycle(input.event,input.leaseId,appId);
 try{
   await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Lifecycle fixture',$2,'ACTIVE')",[tenantId,`lifecycle-${tenantId}`]);
   await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Lifecycle fixture','META','CLOUD_API','WORKING',$3)",[connectionId,tenantId,proof.secretReference]);
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
     VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[providerSessionId,tenantId,connectionId,phoneNumberId,`meta-cloud://${wabaId}/${phoneNumberId}`,{wabaId,metaAccountProof:proof}]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state,admission_opened_at) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE',$4)",[tenantId,connectionId,phoneNumberId,new Date((baseTime-1)*1000)]));
   const negative=await add({event:'ACCOUNT_OFFBOARDED'},100);
   assert.equal((await guard(0)).unresolved_hold,true,'Accepted signed negative holds every request before worker application');
   const newerOperation=randomUUID();await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,operationId}',to_jsonb($1::text)) WHERE id=$2",[newerOperation,providerSessionId]));
   assert.equal(await apply(negative),'APPLIED','Same-asset rotation must not suppress an admitted negative');
   let current=await state();assert.equal(current.connection_state,'ACTION_REQUIRED');assert.equal(current.session_state,'ACTION_REQUIRED');
   assert.equal(current.provider_state_data.metaAccountProof.operationId,newerOperation);
   assert.deepEqual(metaLifecycleBlockingReasons(current.provider_state_data.metaLifecycle),['ACCOUNT_OFFBOARDED']);
   assert.equal((await guard(current.provider_state_data.metaLifecycle.revision)).blocked,true);
   assert.equal((await guard(current.provider_state_data.metaLifecycle.revision)).unresolved_hold,false);
   assert.equal((await admin.query('SELECT status,payload FROM event_inbox WHERE id=$1',[negative.event.id])).rows[0].payload.redacted,true);
   await apply(await add({event:'ACCOUNT_VIOLATION'},200));
   await apply(await add({event:'PARTNER_REMOVED',waba_info:{waba_id:wabaId}},150));
   const coexistenceValue={event:'PARTNER_REMOVED',phone_number:displayPhoneNumber,disconnection_info:{reason:'PRIMARY_INACTIVITY',initiated_by:'SYSTEM'}};
   const coexistence=await add(coexistenceValue,151,{phoneScope:'EXACT_DISPLAY'});
   assert.equal((await guard((await state()).provider_state_data.metaLifecycle.revision)).unresolved_hold,true,'Coexistence removal holds sends before worker reduction');
   assert.equal(await apply(coexistence),'APPLIED');
   assert.equal((await admin.query('SELECT status,payload FROM event_inbox WHERE id=$1',[coexistence.event.id])).rows[0].payload.redacted,true);
   current=await state();assert.deepEqual(metaLifecycleBlockingReasons(current.provider_state_data.metaLifecycle),['ACCOUNT_OFFBOARDED','PARTNER_REMOVED'],'Newer warning cannot discard an older distinct still-effective negative');
   const beforeMalformed=current.provider_state_data;
   for(const value of [{...coexistenceValue,waba_info:null},{...coexistenceValue,waba_info:{}},{...coexistenceValue,waba_info:{waba_id:'999999999'}},{event:'PARTNER_REMOVED'}]){
     const malformed=await add(value,152,{entryId:wabaId,phoneScope:'EXACT_DISPLAY'});
     await assert.rejects(()=>apply(malformed),/lifecycle reconciliation/u);
     assert.deepEqual((await state()).provider_state_data,beforeMalformed,'Malformed address never falls back or changes lifecycle state');
     assert.equal((await admin.query('SELECT status FROM event_inbox WHERE id=$1',[malformed.event.id])).rows[0].status,'PROCESSING');
     assert.equal((await guard(beforeMalformed.metaLifecycle.revision)).unresolved_hold,true,'Rejected negative keeps its pending effect hold');
     await admin.query('DELETE FROM event_inbox WHERE id=$1',[malformed.event.id]);
   }
   await apply(await add({event:'ACCOUNT_RECONNECTED'},210));
   assert.equal((await state()).connection_state,'ACTION_REQUIRED','A recovery callback is observation, never automatic activation');
   assert.equal((await guard(0)).revision_matches,false,'Pre-event request snapshot is fenced');
   const beforeExpired=(await state()).provider_state_data;
   const expired=await add({event:'ACCOUNT_DELETED'},220,{expired:true});
   await assert.rejects(()=>apply(expired),/lifecycle reconciliation/u);
   assert.deepEqual((await state()).provider_state_data,beforeExpired,'Lease loss rolls back all state writes');
   await admin.query("UPDATE event_inbox SET status='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[expired.event.id]);
   assert.equal((await guard(beforeExpired.metaLifecycle.revision)).unresolved_hold,true,'Terminal negative failure still holds external effects');
   await admin.query('DELETE FROM event_inbox WHERE id=$1',[expired.event.id]);
   const tampered=await add({event:'ACCOUNT_DELETED'},225,{mutate:payload=>{payload.admission.kind='OBSERVATION'}});
   await assert.rejects(()=>apply(tampered),/lifecycle reconciliation/u);assert.deepEqual((await state()).provider_state_data,beforeExpired);
   await admin.query('DELETE FROM event_inbox WHERE id=$1',[tampered.event.id]);
   const foreign=await add({event:'ACCOUNT_DELETED'},227);
   await assert.rejects(()=>repository.applyMetaLifecycle({...foreign.event,tenantId:randomUUID()},foreign.leaseId,appId),/lifecycle reconciliation/u);
   assert.deepEqual((await state()).provider_state_data,beforeExpired,'Worker tenant RLS prevents foreign state application');
   await admin.query('DELETE FROM event_inbox WHERE id=$1',[foreign.event.id]);
   for(const changed of ['phone','account']){
     const drift=await add({event:'ACCOUNT_DELETED'},228);
     if(changed==='phone')await withFixtureTenant(admin,tenantId,()=>admin.query('UPDATE provider_sessions SET opaque_session_id=$1 WHERE id=$2',['15550001002',providerSessionId]));
     else await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{wabaId}',to_jsonb('999999999'::text)) WHERE id=$1",[providerSessionId]));
     await assert.rejects(()=>apply(drift),/lifecycle reconciliation/u,'Current-session asset drift is unresolved, never silently acknowledged as old');
     assert.equal((await admin.query('SELECT status FROM event_inbox WHERE id=$1',[drift.event.id])).rows[0].status,'PROCESSING');
     await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET opaque_session_id=$1,provider_state_data=jsonb_set(provider_state_data,'{wabaId}',to_jsonb($2::text)) WHERE id=$3",[phoneNumberId,wabaId,providerSessionId]));
     await admin.query('DELETE FROM event_inbox WHERE id=$1',[drift.event.id]);
   }
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='REVOKED' WHERE id=$1",[connectionId]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET state='REVOKED',ownership_state='RETIRED',retired_at=now() WHERE id=$1",[providerSessionId]));
   await apply(await add({event:'DISABLED_UPDATE',ban_info:{waba_ban_state:'DISABLE'}},230));
   current=await state();assert.equal(current.connection_state,'REVOKED');assert.equal(current.session_state,'REVOKED');assert.equal(current.ownership_state,'RETIRED');
   assert.ok(metaLifecycleBlockingReasons(current.provider_state_data.metaLifecycle).includes('ACCOUNT_DISABLED'),'Retained authenticated observation preserves manual revocation');
   await apply(await add({event:'ACCOUNT_RESTRICTION',phone_number:'12025550111',restriction_info:[{restriction_type:'RESTRICTED_CUSTOMER_INITIATED_MESSAGING'}]},235,{phoneScope:'UNRESOLVED_DISPLAY'}));
   assert.ok(metaLifecycleBlockingReasons((await state()).provider_state_data.metaLifecycle).includes('UNRESOLVED_PHONE'));
   const retained=(await state()).provider_state_data,successorId=randomUUID(),successorPhone='15550001003';
   const successorData={wabaId,metaAccountProof:{...proof,providerSessionId:successorId,phoneNumberId:successorPhone}};
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='WORKING' WHERE id=$1",[connectionId]));
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
     VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[successorId,tenantId,connectionId,successorPhone,`meta-cloud://${wabaId}/${successorPhone}`,successorData]));
   const oldGeneration=await add(coexistenceValue,240,{phoneScope:'EXACT_DISPLAY'});
   assert.equal(await apply(oldGeneration),'IGNORED_STALE');
   assert.equal((await admin.query('SELECT status FROM event_inbox WHERE id=$1',[oldGeneration.event.id])).rows[0].status,'IGNORED');
   assert.deepEqual((await state()).provider_state_data,retained,'Retired callback cannot alter its historical lifecycle after replacement');
   assert.equal((await state()).connection_state,'WORKING');
   assert.deepEqual((await admin.query('SELECT provider_state_data FROM provider_sessions WHERE id=$1',[successorId])).rows[0].provider_state_data,successorData,'Old callback never targets the successor generation');
   return{sameAssetRotation:true,jsonbSemanticHash:true,perReasonOrdering:true,coexistenceRemoval:true,coexistencePendingHold:true,malformedAddressHeld:true,explicitRecoveryOnly:true,expiredLeaseRollback:true,terminalNegativeHold:true,foreignTenantDenied:true,activeAssetDriftDenied:true,retainedRevocation:true,unresolvedPhoneHold:true,retiredSuccessorIsolation:true};
 }finally{await pool.end();await admin.query('DELETE FROM tenants WHERE id=$1',[tenantId]);await admin.end();}
}

// Append to the existing meta-lifecycle-postgres helper and call from the canonical gate.
// Actual DB/RLS/repository/controller finalization; provider and secret-manager boundaries simulated.
export async function verifyMetaLifecycleConsumers(adminUrl,workerConfig,appUrl){
 const {ConnectionOperationRepository}=await import('../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js');
 const {OutboxRepository}=await import('../services/connector-worker/dist/services/connector-worker/src/repository.js');
 const {ConnectionsController}=await import('../services/control-api/dist/connections.controller.js');
 const {MetaGroupsService}=await import('../services/control-api/dist/meta-groups.service.js');
 const {metaCredentialRotationReference}=await import('../services/control-api/dist/connection-secret-reference.js');
 const {applyMetaLifecycleObservation,verifyMetaCredentialMetadata}=await import('../services/connector-worker/dist/packages/core/src/meta-account-relation.js');
 const admin=new Client({connectionString:adminUrl});await admin.connect();
 const workerPool=new Pool(workerConfig),apiPool=new Pool({connectionString:appUrl});
 const outbox=new OutboxRepository(workerPool),operations=new ConnectionOperationRepository(workerPool),inbound=new InboundRepository(workerPool);
 const tenantId=randomUUID(),connectionId=randomUUID(),providerSessionId=randomUUID(),groupId=randomUUID(),userId=randomUUID();
 const appId='12025550130',phoneNumberId='15550002001',wabaId='987654321098765',token='synthetic-meta-consumer-token-only';
 const ref=`secret://${tenantId}/connections/${connectionId}/meta`,time=Date.now()-900_000;
 const priorEnv=Object.fromEntries(['META_APP_ID','META_APP_SECRET_REFERENCE','META_GRAPH_VERSION'].map(key=>[key,process.env[key]]));
 const appDatabase={withTenant:async(actualTenant,callback)=>{const client=await apiPool.connect();try{
   await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[actualTenant]);const result=await callback(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}};
 const current=async()=>(await admin.query(`SELECT c.state AS connection_state,c.action_reason,c.secret_reference,ps.state AS session_state,ps.provider_state_data
   FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id WHERE c.id=$1 AND ps.id=$2`,[connectionId,providerSessionId])).rows[0];
 const relation={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',phoneNumberId,wabaId,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:'a'.repeat(64),
   credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 const proof={...relation,tenantId,connectionId,providerSessionId,secretReference:ref,credentialFingerprint:createHash('sha256').update(token).digest('hex'),operationId:randomUUID(),fencingToken:1};
 const observation=(event,offset,kind)=>({event,observedAt:new Date(time+offset).toISOString(),payloadSha256:createHash('sha256').update(event+offset).digest('hex'),kind,reasons:['ACCOUNT_OFFBOARDED']});
 const initial=applyMetaLifecycleObservation(undefined,observation('ACCOUNT_OFFBOARDED',0,'BLOCK')).state;
 const recoverable=applyMetaLifecycleObservation(initial,observation('ACCOUNT_RECONNECTED',1_000,'RECOVERY')).state;
 const jobFor=async({recovery=false,local=false}={})=>{
   const snapshot=await current(),id=randomUUID(),leaseId=randomUUID(),workerIdentity=`lifecycle-consumer:${id}`;
   const revision=snapshot.provider_state_data.metaLifecycle?.revision??0;
   const payload={metaLifecycleExpectedRevision:revision,metaBinding:{secretReference:snapshot.secret_reference,providerSessionId,phoneNumberId,wabaId},
     ...(recovery?{metaLifecycleRecovery:{expectedRevision:revision,reasons:['ACCOUNT_OFFBOARDED']}}:{})};
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,attempts,lease_id,lease_expires_at,fencing_token,requested_by_type,requested_by_id,request_id)
     VALUES($1,$2,$3,$4,$5,$6,'RUNNING',1,$7,now()+interval '120 seconds',1,'SYSTEM','canonical-pg','canonical-pg')`,[id,tenantId,connectionId,local?'PAUSE':'START',`consumer-${id}`,payload,leaseId]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET worker_id=$1,lease_expires_at=now()+interval '120 seconds',fencing_token=fencing_token+1 WHERE id=$2",[workerIdentity,providerSessionId]));
   const session=(await admin.query('SELECT fencing_token FROM provider_sessions WHERE id=$1',[providerSessionId])).rows[0];
   return{job:{id,tenantId,connectionId,operationType:local?'PAUSE':'START',idempotencyKey:`consumer-${id}`,provider:'META',connectionState:snapshot.connection_state,connectionSecretReference:snapshot.secret_reference,
     attempts:1,maxAttempts:8,fencingToken:1,payload,providerSession:{id:providerSessionId,opaqueSessionId:phoneNumberId,state:snapshot.session_state,fencingToken:Number(session.fencing_token),providerStateData:snapshot.provider_state_data}},
     leaseId,sessionLease:{id:providerSessionId,workerIdentity,fencingToken:Number(session.fencing_token)}};
 };
 const completion=()=>({connectionState:'WORKING',providerState:'AVAILABLE',providerStateData:{wabaId,metaAccountProof:proof},result:{actualProviderReceipt:'simulated-known-subscription'}});
 const addNegative=async()=>{
   const id=randomUUID(),leaseId=randomUUID(),value={event:'ACCOUNT_OFFBOARDED'};
   const unit={object:'whatsapp_business_account',entry:[{id:wabaId,time:Math.floor((time+2_000)/1000),changes:[{field:'account_update',value}]}]};
   const payload={...unit,admission:{schemaVersion:1,observedAt:new Date(unit.entry[0].time*1000).toISOString(),providerPayloadSha256:metaLifecyclePayloadSha256(unit),kind:'BLOCK',reasons:['ACCOUNT_OFFBOARDED'],
     asset:{providerSessionId,phoneNumberId,wabaId,appId},phoneScope:'ACCOUNT'}};
   await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,attempts)
     VALUES($1,$2,$3,'META',$4,'meta.account.lifecycle.block',$5,$6,'PROCESSING',$7,now()+interval '120 seconds',1)`,[id,tenantId,connectionId,`consumer-negative-${id}`,payload,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),leaseId]);
   const stored=(await admin.query('SELECT payload FROM event_inbox WHERE id=$1',[id])).rows[0].payload;
   return{event:{id,tenantId,connectionId,provider:'meta',eventType:'meta.account.lifecycle.block',providerEventId:`consumer-negative-${id}`,payload:stored,attempts:1},leaseId};
 };
 const deliveryFor=async()=>{
   const snapshot=await current(),id=randomUUID(),leaseId=randomUUID();
   await admin.query('BEGIN');
   try{
    await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   const birth=(await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
     VALUES($1,$2,$3,$4,'GROUP_WORKSPACE','Canonical lifecycle receipt','text/plain',$5,'SENDING',1,$6,now()+interval '120 seconds') RETURNING meta_billing_snapshot`,[id,tenantId,connectionId,groupId,`lifecycle-receipt-${id}`,leaseId])).rows[0].meta_billing_snapshot;
   const attempt=(await admin.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,1,'SENDING') RETURNING id",[tenantId,id])).rows[0];
   assert.equal(birth.claim,'LEGACY_UNATTRIBUTED','Lifecycle setup retains its actual unenrolled billing birth');
   await admin.query('COMMIT');
   return{leaseId,attemptId:attempt.id,job:{id,tenantId,connectionId,groupWorkspaceGroupId:groupId,groupId:'synthetic-group',recipientType:'GROUP',text:'Canonical lifecycle receipt',contentType:'text/plain',idempotencyKey:`lifecycle-receipt-${id}`,attempts:1,metaBillingSnapshot:birth,
     provider:'meta',sessionId:phoneNumberId,connectionSecretReference:snapshot.secret_reference,metaCredentialContext:{providerSessionId,phoneNumberId,wabaId,proof:snapshot.provider_state_data.metaAccountProof,lifecycle:snapshot.provider_state_data.metaLifecycle},
     zammadBaseUrl:'https://zammad.invalid',zammadSecretReference:'secret://synthetic-zammad'}};
   }catch(error){await admin.query('ROLLBACK');throw error;}
 };
 const apiContext=snapshot=>({tenantId,connectionId,secretReference:snapshot.secret_reference,providerSessionId,phoneNumberId,wabaId,proof:snapshot.provider_state_data.metaAccountProof,lifecycle:snapshot.provider_state_data.metaLifecycle,disclosureVersion:null,requireWorking:false});
 const groups=new MetaGroupsService(appDatabase,{},{});
 try{
   process.env.META_APP_ID=appId;process.env.META_APP_SECRET_REFERENCE='secret://platform/meta-webhook';process.env.META_GRAPH_VERSION='v24.0';
   await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Lifecycle consumers',$2,'ACTIVE')",[tenantId,`lifecycle-consumers-${tenantId}`]);
   await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'lifecycle@example.invalid','Lifecycle fixture')",[userId,`lifecycle-${userId}`]);
   await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenantId,userId]);
   await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Lifecycle consumers','META','CLOUD_API','ACTION_REQUIRED',$3)",[connectionId,tenantId,ref]);
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
     VALUES($1,$2,$3,$4,'ACTION_REQUIRED',$5,'ACTIVE',$6)`,[providerSessionId,tenantId,connectionId,phoneNumberId,`meta-cloud://${wabaId}/${phoneNumberId}`,{wabaId,metaAccountProof:proof,metaLifecycle:recoverable,latestDiagnostic:'retained'}]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state,admission_opened_at) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE',$4)",[tenantId,connectionId,phoneNumberId,new Date(time-1000)]));
   await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,'synthetic-group','Lifecycle fixture')",[groupId,tenantId,connectionId]);
   const fresh=await jobFor({recovery:true});
   await operations.renewLeases(fresh.job,fresh.leaseId,fresh.sessionLease);
   await operations.complete(fresh.job,fresh.leaseId,fresh.sessionLease,completion());
   let snapshot=await current();assert.equal(snapshot.connection_state,'WORKING');assert.equal(snapshot.provider_state_data.latestDiagnostic,'retained');
   assert.deepEqual(metaLifecycleBlockingReasons(snapshot.provider_state_data.metaLifecycle),[]);
   assert.ok(snapshot.provider_state_data.metaLifecycle.reasonStates[0].clearedThrough,'Successful activation, not observation, creates clearance watermark');
   const clearSnapshot=snapshot,context=apiContext(snapshot);
   assert.equal(await appDatabase.withTenant(tenantId,client=>groups.contextCurrent(client,context)),true,'Actual API context query with app role');
   const delivery=await deliveryFor();await outbox.assertMetaDeliveryContextCurrent(delivery.job,delivery.leaseId);
   await verifyInheritedTemplatePrivacyBoundary({outbox,admin,tenantId,delivery});
   // Actual repository admission while clear; the provider outcome below is simulated.
   const requestSha256=createHash('sha256').update(JSON.stringify({messaging_product:'whatsapp',recipient_type:'group',to:delivery.job.groupId,type:'text',text:{body:delivery.job.text}})).digest('hex');
   await outbox.admitMetaMessageRequest(delivery.job,delivery.leaseId,requestSha256);
   const admitted=(await admin.query('SELECT meta_billing_admission FROM delivery_attempts WHERE id=$1',[delivery.attemptId])).rows[0].meta_billing_admission;
   assert.equal(admitted.claim,'MESSAGES_REQUEST_ADMITTED');assert.equal(admitted.attemptId,delivery.attemptId);
   assert.equal(admitted.deliveryId,delivery.job.id);assert.equal(admitted.attemptNumber,1);assert.equal(admitted.requestSha256,requestSha256);
   assert.deepEqual(admitted.snapshot,delivery.job.metaBillingSnapshot,'Admission retains the actual immutable database birth');
   const stale=await jobFor(),negative=await addNegative();
   await assert.rejects(()=>outbox.assertMetaDeliveryContextCurrent(delivery.job,delivery.leaseId),/changed before dispatch/);
   assert.equal(await appDatabase.withTenant(tenantId,client=>groups.contextCurrent(client,context)),false,'Pending signed negative fences API before worker projection');
   await assert.rejects(()=>operations.renewLeases(stale.job,stale.leaseId,stale.sessionLease),/superseded/u,'Pending signed negative also fences operation requests');
   assert.equal(await inbound.applyMetaLifecycle(negative.event,negative.leaseId,appId),'APPLIED');
   const held=await current();assert.equal(held.connection_state,'ACTION_REQUIRED');
   const staleResult=await operations.complete(stale.job,stale.leaseId,stale.sessionLease,completion());
   assert.equal(staleResult.result.superseded,true);assert.equal(staleResult.result.originalResult.actualProviderReceipt,'simulated-known-subscription');
   assert.deepEqual((await current()).provider_state_data,held.provider_state_data,'Late activation must not overwrite newer lifecycle authority');
   const storedOperation=(await admin.query('SELECT state,result FROM connection_operations WHERE id=$1',[stale.job.id])).rows[0];
   assert.equal(storedOperation.state,'SUCCEEDED');assert.equal(storedOperation.result.superseded,true,'Known result recorded without claiming current activation');
   await outbox.complete(delivery.job,delivery.leaseId,'SENT','simulated-known-provider-id');
   assert.deepEqual((await admin.query('SELECT external_message_id,meta_billing_admission FROM delivery_attempts WHERE id=$1',[delivery.attemptId])).rows[0],{external_message_id:'simulated-known-provider-id',meta_billing_admission:admitted},'Late success preserves the exact pre-hold admission');
   assert.deepEqual((await admin.query('SELECT state,external_message_id FROM delivery_outbox WHERE id=$1',[delivery.job.id])).rows[0],{state:'SENT',external_message_id:'simulated-known-provider-id'});
   assert.deepEqual((await current()).provider_state_data,held.provider_state_data,'Known send receipt never changes lifecycle');
   assert.equal(await appDatabase.withTenant(tenantId,client=>groups.contextCurrent(client,context)),false,'Applied revision fences earlier API snapshot');
   const failed=await deliveryFor();
   await outbox.fail(failed.job,failed.leaseId,false,'Synthetic expired credential',undefined,false,'META_AUTHENTICATION_FAILED');
   assert.equal((await current()).action_reason,held.action_reason,'Old auth outcome cannot replace lifecycle reason');
   assert.equal((await admin.query('SELECT state FROM delivery_outbox WHERE id=$1',[failed.job.id])).rows[0].state,'FAILED_TERMINAL');
   const heldFailure=await jobFor();
   await operations.fail(heldFailure.job,heldFailure.leaseId,heldFailure.sessionLease,{retryable:false,code:'META_AUTHENTICATION_FAILED',safeError:'Synthetic stale authentication',connectionState:'ACTION_REQUIRED'});
   assert.equal((await current()).action_reason,held.action_reason,'Operation auth failure cannot replace the authoritative lifecycle reason');
   assert.deepEqual((await current()).provider_state_data,held.provider_state_data);
   const pause=await jobFor({local:true});
   await operations.complete(pause.job,pause.leaseId,pause.sessionLease,{connectionState:'PAUSED',providerState:'PAUSED_LOCAL',providerStateData:{wabaId},result:{paused:true}});
   assert.deepEqual((await current()).provider_state_data.metaLifecycle,held.provider_state_data.metaLifecycle);
   const rotationId=randomUUID(),rotationKey=`lifecycle-rotation-${rotationId}`,nextToken='synthetic-rotated-meta-token-only';
   const nextReference=metaCredentialRotationReference(tenantId,connectionId,rotationKey);
   const rotationPayload={metaBinding:{secretReference:ref,providerSessionId,phoneNumberId,wabaId},metaLifecycleExpectedRevision:held.provider_state_data.metaLifecycle.revision,
     oldSecretReference:ref,newSecretReference:nextReference,request:{credentialFingerprint:createHash('sha256').update(nextToken).digest('hex')}};
   const rotation=(await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
     VALUES($1,$2,$3,'ROTATE_META_CREDENTIAL',$4,$5,'STAGED','SYSTEM','canonical-pg','canonical-pg') RETURNING *`,[rotationId,tenantId,connectionId,rotationKey,rotationPayload]))).rows[0];
   let stores=0;const controller=new ConnectionsController(appDatabase,{storeMetaCredential:async(reference)=>{assert.equal(reference,nextReference);stores++;}},
     {wakeConnection:async()=>assert.fail('Paused rotation must not activate')},{},{},{});
   await controller.finishMetaRotation({id:'lifecycle-consumer-rotation',principal:{tenantId,userId}},rotation,nextToken,false,relation);
   snapshot=await current();assert.equal(stores,1);assert.equal(snapshot.secret_reference,nextReference);assert.equal(snapshot.connection_state,'PAUSED');
   assert.deepEqual(snapshot.provider_state_data.metaLifecycle,held.provider_state_data.metaLifecycle,'Same-asset token rotation preserves blockers');
   assert.equal((await admin.query("SELECT count(*)::integer AS count FROM connection_operations WHERE tenant_id=$1 AND payload->>'sourceOperationId'=$2",[tenantId,rotationId])).rows[0].count,0);
   assert.equal((await admin.query('SELECT state FROM connection_operations WHERE id=$1',[rotationId])).rows[0].state,'SUCCEEDED');
   const legacyPhone='15550002002',legacyId=randomUUID(),legacySession=randomUUID(),legacyRef=`secret://${tenantId}/connections/${legacyId}/meta`;
   const legacyProof={...proof,connectionId:legacyId,providerSessionId:legacySession,phoneNumberId:legacyPhone,secretReference:legacyRef};delete legacyProof.credentialMetadata;
   await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Legacy lifecycle','META','CLOUD_API','WORKING',$3)",[legacyId,tenantId,legacyRef]);
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
     VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[legacySession,tenantId,legacyId,legacyPhone,`meta-cloud://${wabaId}/${legacyPhone}`,{wabaId,metaAccountProof:legacyProof}]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state,admission_opened_at) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','ACTIVE',$4)",[tenantId,legacyId,legacyPhone,new Date(time-1000)]));
   delete process.env.META_APP_ID;
   const legacyJob={...delivery.job,connectionId:legacyId,sessionId:legacyPhone,connectionSecretReference:legacyRef,metaCredentialContext:{providerSessionId:legacySession,phoneNumberId:legacyPhone,wabaId,proof:legacyProof}};
   assert.equal(await outbox.tenant(tenantId,client=>outbox.metaDeliveryContextCurrent(client,legacyJob)),true,'Genuine legacy metadata absence and unset app retains clear read admission');
   const legacyEvent=randomUUID(),legacyPayload={admission:{asset:{providerSessionId:legacySession,phoneNumberId:legacyPhone,wabaId,appId}}};
   await admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
     VALUES($1,$2,$3,'META',$4,'meta.account.lifecycle.block',$5,$6,'ACCEPTED')`,[legacyEvent,tenantId,legacyId,`legacy-${legacyEvent}`,legacyPayload,'a'.repeat(64)]);
   assert.equal(await outbox.tenant(tenantId,client=>outbox.metaDeliveryContextCurrent(client,legacyJob)),false,'Unset legacy app must conservatively hold same-session negative');
   await admin.query('DELETE FROM event_inbox WHERE id=$1',[legacyEvent]);
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,credentialMetadata}',$1::jsonb) WHERE id=$2",[JSON.stringify(relation.credentialMetadata),legacySession]));
   assert.equal((await outbox.tenant(tenantId,client=>client.query('SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)',[legacyId,legacySession,legacyPhone,wabaId,'',0]))).rowCount,0,'Unset app does not admit fresh verified metadata');
   assert.equal(clearSnapshot.provider_state_data.metaLifecycle.reasonStates[0].blocked,false,'Historical snapshot is not mutated');
   return{actualWorkerRequestFence:true,actualAppRoleContextFence:true,freshExplicitActivation:true,newNegativeFinalizationSuperseded:true,knownReceiptRetained:true,staleAuthReasonPreserved:true,localPausePreserved:true,actualPausedRotationFinalization:true,legacyUnsetAppClearAndPending:true,freshProofUnsetAppDenied:true};
 }finally{
   for(const[key,value]of Object.entries(priorEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
   // Rotation's append-only audit is intentionally retained until the canonical owned DB is removed.
   // Do not disable append-only triggers to clean synthetic history within the running gate.
   await workerPool.end();await apiPool.end();await admin.end();
 }
}

// Append beside verifyMetaLifecycleWorker/verifyMetaLifecycleConsumers and call from
// the existing isolated PostgreSQL gate after migration 0161 and the control-api build.
export async function verifyMetaLifecycleIngress(adminUrl,appUrl,workerConfig){
  const admin=new Client({connectionString:adminUrl});await admin.connect();
  const previousUrl=process.env.DATABASE_URL,previousPool=process.env.DATABASE_POOL_SIZE;
  process.env.DATABASE_URL=appUrl;process.env.DATABASE_POOL_SIZE='2';
  const {DatabaseService}=await import('../services/control-api/dist/database.service.js');
  const database=new DatabaseService(),workerPool=new Pool(workerConfig);
  const inbound=new InboundRepository(workerPool);
  const tenantId=randomUUID(),appId='12025550130',wabaId='987654321098775';
  const connections=[randomUUID(),randomUUID()],sessions=[randomUUID(),randomUUID()];
  const phones=['15550003001','15550003002'],displays=['12025550170','12025550171'];
  const refs=connections.map(id=>`secret://${tenantId}/connections/${id}/meta-webhook`);
  const proof=(index,sessionId=sessions[index],phone=phones[index],waba=wabaId)=>({
    schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId:connections[index],providerSessionId:sessionId,
    phoneNumberId:phone,wabaId:waba,displayPhoneNumber:displays[index],secretReference:`secret://${tenantId}/connections/${connections[index]}/meta`,
    credentialFingerprint:'a'.repeat(64),operationId:randomUUID(),fencingToken:1,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),
    responseSha256:'b'.repeat(64),credentialMetadata:{appId},
  });
  const resolve=()=>database.resolveMetaLifecycleRoutes(wabaId,appId);
  try{
    await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Lifecycle ingress',$2,'ACTIVE')",[tenantId,`lifecycle-ingress-${tenantId}`]);
    for(let index=0;index<2;index++){
      await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,$3,'META','CLOUD_API','WORKING',$4)",[connections[index],tenantId,`Lifecycle ingress ${index}`,`secret://${tenantId}/connections/${connections[index]}/meta`]);
      await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,$4,'ACTIVE')",[tenantId,connections[index],phones[index],refs[index]]));
      await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)",[sessions[index],tenantId,connections[index],phones[index],`meta-cloud://${wabaId}/${phones[index]}`,{wabaId,metaAccountProof:proof(index)}]));
    }

    const routes=await resolve();assert.equal(routes.length,2);assert.deepEqual(routes.map(row=>row.display_phone_number).sort(),displays);
    await admin.query('BEGIN');
    try{
      await admin.query('SET LOCAL ROLE wasalx_connector_worker');
      await assert.rejects(()=>admin.query('SELECT * FROM app.resolve_meta_lifecycle_routes($1,$2)',[wabaId,appId]),/permission denied/u);
    }finally{await admin.query('ROLLBACK')}
    await admin.query('BEGIN');
    try{await admin.query('SET LOCAL ROLE wasalx_app');assert.equal((await admin.query('SELECT count(*)::integer AS count FROM app.resolve_meta_lifecycle_routes($1,$2)',[wabaId,appId])).rows[0].count,2)}finally{await admin.query('ROLLBACK')}

    const route=routes.find(row=>row.connection_id===connections[0]),providerEventId=`lifecycle-ingress-${randomUUID()}`;
    const unit={object:'whatsapp_business_account',entry:[{id:wabaId,time:Math.floor(Date.now()/1000),changes:[{field:'account_update',value:{event:'ACCOUNT_OFFBOARDED'}}]}]};
    const payloadSha256=metaLifecyclePayloadSha256(unit);
    const payload={...unit,admission:{schemaVersion:1,observedAt:new Date(unit.entry[0].time*1000).toISOString(),providerPayloadSha256:payloadSha256,
      kind:'BLOCK',reasons:['ACCOUNT_OFFBOARDED'],asset:{providerSessionId:route.provider_session_id,phoneNumberId:route.phone_number_id,wabaId,appId},phoneScope:'ACCOUNT'}};
    const input={providerEventId,eventType:'meta.account.lifecycle.block',payload,payloadSha256};
    const first=await database.acceptMetaLifecycleEvent(route,input,appId);assert.equal(first.duplicate,false);
    const duplicate=await database.acceptMetaLifecycleEvent(route,input);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.id,first.id);
    await assert.rejects(()=>database.acceptMetaLifecycleEvent(route,{...input,payloadSha256:'f'.repeat(64)}),/conflicts/u);
    assert.equal((await admin.query('SELECT count(*)::integer AS count FROM event_inbox WHERE tenant_id=$1 AND id=$2',[tenantId,first.id])).rows[0].count,1);
    const claimed=await inbound.claim(tenantId,randomUUID());
    assert.deepEqual(claimed.map(event=>[event.id,event.metaWebhookAppId]),[[first.id,appId]]);

    const baseData={wabaId,metaAccountProof:proof(0)};
    const setData=data=>withFixtureTenant(admin,tenantId,()=>admin.query('UPDATE provider_sessions SET provider_state_data=$2::jsonb WHERE id=$1',[sessions[0],JSON.stringify(data)]));
    const messageRoute=await database.resolveMetaWebhookRoute(phones[0]);
    const admitStatus=()=>database.acceptWebhookEvent(messageRoute,{
      providerEventId:`webhook-app-binding-${randomUUID()}`,eventType:'message.status',
      payload:{entry:[{changes:[{value:{statuses:[{id:'wamid.synthetic',status:'delivered'}]}}]}]},
      payloadSha256:'c'.repeat(64),routeKey:phones[0],providerSessionKey:phones[0],providerEngine:'CLOUD_API',
    },appId);
    await setData({...baseData,metaAccountProof:{...baseData.metaAccountProof,credentialMetadata:{appId:'999999999'}}});
    await assert.rejects(admitStatus,{status:404},'A session bound to another app rejects the signed event');
    const legacyProof={...baseData.metaAccountProof};delete legacyProof.credentialMetadata;
    await setData({...baseData,metaAccountProof:legacyProof});
    assert.equal((await admitStatus()).duplicate,false,'A legacy session without credential metadata can use its app-bound route');
    await setData(baseData);
    assert.equal((await admitStatus()).duplicate,false,'A session bound to the signing app remains admissible');
    const check=(await admin.query("SELECT convalidated FROM pg_constraint WHERE conrelid='public.event_inbox'::regclass AND conname='event_inbox_meta_webhook_app'")).rows[0];
    assert.equal(check?.convalidated,true);
    const guard=()=>database.withTenant(tenantId,async client=>(await client.query('SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)',[connections[0],sessions[0],phones[0],wabaId,appId,0])).rows);
    for(const status of ['ACCEPTED','PROCESSING','FAILED_RETRYABLE','FAILED_TERMINAL']){
      await admin.query('UPDATE event_inbox SET status=$2 WHERE id=$1',[first.id,status]);assert.equal((await guard())[0].unresolved_hold,true,`${status} negative holds before projection`);
    }
    await admin.query("UPDATE event_inbox SET status='PROCESSED' WHERE id=$1",[first.id]);assert.equal((await guard())[0].unresolved_hold,false);
    for(const malformed of [null,{},[],{schemaVersion:1,revision:1,reasonStates:{}},{schemaVersion:1,revision:1,reasonStates:[{}]},{schemaVersion:1,revision:9007199254740992,reasonStates:[]}]){
      await setData({...baseData,metaLifecycle:malformed});assert.deepEqual(await guard(),[],'Malformed lifecycle denies without unsafe SQL cast/array evaluation');
    }
    await setData({...baseData,metaAccountProof:null});assert.equal(Number((await guard())[0].lifecycle_revision),0,'Legacy null proof without lifecycle remains compatible');
    for(const [field,value] of [['tenantId',randomUUID()],['connectionId',randomUUID()],['providerSessionId',randomUUID()],['phoneNumberId','15550003009'],['wabaId','987654321098776'],['credentialMetadata',{appId:'999999999'}]]){
      await setData({...baseData,metaAccountProof:{...baseData.metaAccountProof,[field]:value}});assert.equal((await resolve()).some(row=>row.connection_id===connections[0]),false,`Resolver rejects ${field} mismatch`);
    }
    await setData({...baseData,wabaId:'987654321098776'});assert.equal((await resolve()).some(row=>row.connection_id===connections[0]),false,'Proof and provider state must agree');
    await setData({wabaId});assert.equal((await resolve()).some(row=>row.connection_id===connections[0]),false,'Lifecycle routing needs verified relation');await setData(baseData);
    const freshInput=()=>({...input,providerEventId:`lifecycle-ingress-${randomUUID()}`});
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='PAUSED' WHERE id=$1",[connections[0]]));await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='PAUSED' WHERE connection_id=$1",[connections[0]]));
    await assert.rejects(()=>database.acceptMetaLifecycleEvent(route,freshInput()),/Webhook route was not found/u,'Admission rechecks stale planned route');
    let retained=(await resolve()).find(row=>row.connection_id===connections[0]);assert.equal(retained.route_state,'PAUSED');
    assert.equal(await database.resolveMetaWebhookRoute(phones[0]),null,'Normal messages remain denied while paused');
    assert.equal((await database.acceptMetaLifecycleEvent(retained,freshInput())).duplicate,false);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='REVOKED' WHERE id=$1",[connections[0]]));await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='REVOKED' WHERE connection_id=$1",[connections[0]]));
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET ownership_state='RETIRED',state='REVOKED',retired_at=now() WHERE id=$1",[sessions[0]]));
    retained=(await resolve()).find(row=>row.connection_id===connections[0]);assert.equal(retained.session_ownership_state,'RETIRED');
    assert.equal(await database.resolveMetaWebhookRoute(phones[0]),null);
    assert.equal((await database.acceptMetaLifecycleEvent(retained,freshInput())).duplicate,false);
    assert.equal((await admin.query('SELECT state FROM connections WHERE id=$1',[connections[0]])).rows[0].state,'REVOKED','Lifecycle admission does not reactivate');
    await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenantId]);
    await assert.rejects(()=>database.acceptMetaLifecycleEvent(retained,freshInput()),/Webhook route was not found/u);await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);

    // Ranking precedes proof/WABA filtering: a newer ACTIVE different asset blocks fallback to an older matching RETIRED asset.
    const retiredId=randomUUID(),differentWaba='987654321098776';
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET ownership_state='RETIRED',state='REVOKED',retired_at=now(),created_at=now()-interval '2 minutes' WHERE id=$1",[sessions[1]]));
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='REVOKED' WHERE id=$1",[connections[1]]));await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='REVOKED' WHERE connection_id=$1",[connections[1]]));
    await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data,created_at) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6,now())",[retiredId,tenantId,connections[1],'15550003999',`meta-cloud://${differentWaba}/15550003999`,{wabaId:differentWaba,metaAccountProof:proof(1,retiredId,'15550003999',differentWaba)}]));
    assert.equal((await resolve()).some(row=>row.connection_id===connections[1]),false);

    // Two latest RETIRED sessions with the same creation time are ambiguous and must not fall through after filtering.
    const tiedAt=new Date(Date.now()+1_000);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET ownership_state='RETIRED',state='REVOKED',retired_at=now() WHERE id=$1",[retiredId]));
    await withFixtureTenant(admin,tenantId,()=>admin.query('UPDATE provider_sessions SET created_at=$2 WHERE id=$1',[sessions[1],tiedAt]));
    assert.equal((await resolve()).some(row=>row.provider_session_id===sessions[1]),true,'Unique latest retained matching asset resolves');
    await withFixtureTenant(admin,tenantId,()=>admin.query('UPDATE provider_sessions SET created_at=$2 WHERE id=$1',[retiredId,tiedAt]));
    assert.equal((await resolve()).some(row=>row.connection_id===connections[1]),false);
    return{resolverFanout:true,roleBoundary:true,admissionIdempotency:true,admissionConflict:true,admittedAppClaimed:true,pendingNegativeStatuses:true,malformedStateDenied:true,proofBindingMatrix:true,retainedPauseRevokeAdmission:true,staleRouteDenied:true,suspendedTenantDenied:true,newGenerationNoFallback:true,tiedRetainedRejected:true};
  }finally{
    await database.onModuleDestroy();
    await workerPool.end();
    if(previousUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousUrl;
    if(previousPool===undefined)delete process.env.DATABASE_POOL_SIZE;else process.env.DATABASE_POOL_SIZE=previousPool;
    await admin.query('DELETE FROM tenants WHERE id=$1',[tenantId]);await admin.end();
  }
}

// Existing clear legacy delivery traverses the actual definer -> invoker privacy
// read. No inherited mapping or template compatibility is fabricated here.
async function verifyInheritedTemplatePrivacyBoundary({outbox,admin,tenantId,delivery}){
 const executor='wasalx_meta_transition_executor';
 const flags=(await admin.query('SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1',[executor])).rows[0];
 assert.deepEqual(flags,{rolcanlogin:false,rolinherit:false,rolsuper:false,rolbypassrls:false});
 for(const privilege of ['INSERT','UPDATE','DELETE'])assert.equal((await admin.query("SELECT has_table_privilege($1,'public.delivery_ticket_links',$2) allowed",[executor,privilege])).rows[0].allowed,false,'Privacy read dependency grants no direct ticket-link write');
 for(const column of ['tenant_id','delivery_id','zammad_ticket_id'])assert.equal((await admin.query("SELECT has_column_privilege($1,'public.delivery_ticket_links',$2,'SELECT') allowed",[executor,column])).rows[0].allowed,true);
 await outbox.tenant(tenantId,async c=>{
  assert.equal((await c.query('SELECT current_user AS role')).rows[0].role,'wasalx_connector_worker');
  assert.equal((await c.query("SELECT pg_has_role(current_user,$1,'MEMBER') allowed",[executor])).rows[0].allowed,false,'Worker cannot adopt the internal executor');
  const context=()=>c.query('SELECT app.meta_inherited_template_send_context($1,$2) value',[delivery.job.id,delivery.leaseId]);
  assert.equal((await context()).rows[0].value,null,'Actual clear unenrolled delivery returns no inherited mapping');
  await c.query('SAVEPOINT inherited_foreign');
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);
  await assert.rejects(context,{code:'55000'},'Foreign tenant cannot obtain inherited delivery context');
  await c.query('ROLLBACK TO SAVEPOINT inherited_foreign');await c.query('RELEASE SAVEPOINT inherited_foreign');
  await c.query('SAVEPOINT inherited_lease');
  await assert.rejects(()=>c.query('SELECT app.meta_inherited_template_send_context($1,$2)',[delivery.job.id,randomUUID()]),{code:'55000'},'Original delivery lease is required');
  await c.query('ROLLBACK TO SAVEPOINT inherited_lease');await c.query('RELEASE SAVEPOINT inherited_lease');
  await c.query('SAVEPOINT inherited_privacy');
  const ticket=`inherited-privacy-${randomUUID()}`,jobId=randomUUID();
  await c.query('INSERT INTO public.delivery_ticket_links(tenant_id,delivery_id,zammad_ticket_id) VALUES($1,$2,$3)',[tenantId,delivery.job.id,ticket]);
  await c.query(`INSERT INTO public.privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot)
   VALUES($1,$2::uuid,'RETENTION_SWEEP','TENANT',$2::uuid::text,'RETENTION_DELETE',$3,'RUNNING','DISCOVER',1,$4,clock_timestamp()+interval '5 minutes',1,24)`,[jobId,tenantId,ticket,randomUUID()]);
  await c.query(`INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,state)
   VALUES($1,$2,'ZAMMAD_TICKET',$3,$4,'PENDING')`,[tenantId,jobId,ticket,createHash('sha256').update(ticket).digest('hex')]);
  assert.equal((await c.query('SELECT app.delivery_has_active_privacy_target($1) held',[delivery.job.id])).rows[0].held,true,'Real ticket-link target fences the exact delivery');
  await c.query('SAVEPOINT inherited_denied');
  await assert.rejects(context,e=>e.code==='55000'&&e.message==='Current template delivery is unavailable','Definer privacy read preserves the real ticket-link hold');
  await c.query('ROLLBACK TO SAVEPOINT inherited_denied');await c.query('RELEASE SAVEPOINT inherited_denied');
  await c.query('ROLLBACK TO SAVEPOINT inherited_privacy');await c.query('RELEASE SAVEPOINT inherited_privacy');
  assert.equal((await context()).rows[0].value,null,'Rollback restores the original clear delivery without changing its request authority');
 });
}
