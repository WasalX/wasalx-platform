import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {withFixtureTenant} from './meta-routing-fixture.mjs';
import {metaRoutingUnits,metaRoutingRuntime} from '../packages/core/dist/meta-routing.js';
import {parseMetaDirectIdentity,assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {resolveMetaDirectMessage} from '../services/connector-worker/dist/services/connector-worker/src/meta-direct-identity.js';
import {bindMetaPrimaryRouting} from '../services/connector-worker/dist/services/connector-worker/src/meta-routing.js';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {whatsappMarketingOptedOut} from '../services/connector-worker/dist/services/connector-worker/src/whatsapp-marketing-preferences.js';
import {reserveDirectNativeReply,admitDirectReplyIntent} from '../services/control-api/dist/direct-native-operations.js';
import {queueOutboundParts} from '../services/control-api/dist/zammad-internal.controller.js';
import {MetaThreadControlService} from '../services/control-api/dist/meta-thread-control.service.js';
import {exportMetaRoutingPrivacy,finalizeMetaRoutingPrivacy} from '../services/connector-worker/dist/services/connector-worker/src/meta-routing-privacy.js';

// Runs inside the existing PostgreSQL wave, after a real API/worker manual PROVISION.
// Provider input is synthetic; SQL roles, admission, snapshots and final-send guards are real.
export async function verifyMetaPrimaryDelivery({admin,db,pool,controller,request,connection,appId,wabaId,phoneNumberId,foreignTenant,rotate}){
 const tenantId=request.principal.tenantId,connectionId=connection.id,actor=request.principal.userId;
 const session=(await admin.query("SELECT * FROM provider_sessions WHERE connection_id=$1 AND ownership_state='ACTIVE'",[connectionId])).rows[0];
 const sessionId=session.id,asset={providerSessionId:sessionId,phoneNumberId,wabaId},runtime=metaRoutingRuntime(process.env);
 const family=randomUUID(),version=randomUUID(),assignment=randomUUID(),instance=randomUUID();
 const definition={schemaVersion:1,name:'Primary fixture',start:'done',maxSteps:2,
  keepOpenPolicy:{humanReplyPauseMinutes:120,mainMenu:true,customerResolution:true},nodes:[{id:'done',type:'end'}]};
 await withFixtureTenant(admin,tenantId,async()=>{
  await admin.query("INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,'Primary fixture',$3)",[family,tenantId,actor]);
  await admin.query(`INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at)
   VALUES($1,$2,$3,1,'ACTIVE',$4,$5,$6,$6,clock_timestamp())`,[version,tenantId,family,definition,createHash('sha256').update(JSON.stringify(definition)).digest('hex'),actor]);
  await admin.query(`INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by)
   VALUES($1,$2,$3,$4,$5,'2','ACTIVE',$6,$6)`,[assignment,tenantId,connectionId,family,version,actor]);
  await admin.query(`INSERT INTO zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
   VALUES($1::uuid,$2,'https://native.invalid','6.5.0','WORKING','fixture://db',$1::text,$1::text,$3,$4)`,[instance,tenantId,`secret://tenants/${tenantId}/zammad/service`,`secret://tenants/${tenantId}/zammad/privacy`]);
 });
 const worker=async work=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const r=await work(c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
 const reject=async(c,work,pattern)=>{await c.query('SAVEPOINT primary_rejection');try{await assert.rejects(work,pattern)}finally{await c.query('ROLLBACK TO SAVEPOINT primary_rejection')}};
 const guard=(c,participant,sources=null,application=appId,binding=runtime,sid=sessionId)=>c.query('SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7,NULL,$8)',
  [connectionId,sid,phoneNumberId,wabaId,participant,application,binding,sources]).then(r=>r.rows[0]);
 const repository=new OutboxRepository({});
 const cleanup=()=>withFixtureTenant(admin,tenantId,async()=>{
  await admin.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false WHERE connection_id=$1 AND state='QUEUED'",[connectionId]);
  await admin.query("UPDATE direct_native_reply_intents SET state='CANCELLED_PROVEN_ABSENT',completed_at=now(),reconciliation='{\"native_ticket_locked\":true,\"article_absent\":true}' WHERE conversation_id IN(SELECT id FROM bot_conversations WHERE connection_id=$1) AND state='PENDING'",[connectionId]);
  await admin.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id IN(SELECT id FROM bot_conversations WHERE connection_id=$1)',[connectionId]);
 });
 const failures=[],contexts=[];
 for(const [index,kind] of ['PHONE','BSUID'].entries()){
  try{
  const payload=JSON.parse(readFileSync(new URL('./fixtures/meta-primary-delivery-webhook.json',import.meta.url),'utf8'));
  const value=payload.entry[0].changes[0].value,message=value.messages[0],phone=`15555550${102+index}`;
  payload.entry[0].id=wabaId;value.metadata.phone_number_id=phoneNumberId;
  message.id=`wamid.synthetic-${randomUUID()}`;message.timestamp=String(Math.floor(Date.now()/1000));message.from=phone;value.contacts[0].wa_id=phone;
  if(kind==='PHONE'){delete message.from_user_id;delete value.contacts[0].user_id}
  else{message.from_user_id=`SA.${1234567890123456n+BigInt(index)}`;value.contacts[0].user_id=message.from_user_id}
  const unit=metaRoutingUnits(wabaId,'messages',value)[0];
  const normalizedPayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:unit.value}]}]};
  const id=randomUUID(),lease=randomUUID(),conversation=randomUUID(),ticket=String(80000+index),customer=81000+index;
  const event={id,tenantId,connectionId,provider:'meta',providerEventId:message.id,eventType:'messages',payload:normalizedPayload,attempts:1};
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,meta_direct_asset,meta_routing_evidence)
   VALUES($1,$2,$3,'META',$4,'messages',$5,$6,'PROCESSING',$7,clock_timestamp()+interval '10 minutes',$8,$9)`,
   [id,tenantId,connectionId,message.id,normalizedPayload,unit.evidence.payloadSha256,lease,asset,{...unit.evidence,providerSessionId:sessionId,appId}]));
  let participant,canonical,job,delivery,intent,staleEvent,newPrimaryId;
  await worker(async c=>{
   assert.equal((await guard(c,null)).allowed,false,'No primary source has yet granted replies');
   const resolved=await resolveMetaDirectMessage(c,event,lease,{provider:'meta',connectionId,messageId:message.id,metaIdentity:parseMetaDirectIdentity(message,value.contacts).identity},appId);
   canonical=resolved.chatId;
   participant=(await c.query('SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,connectionId,canonical])).rows[0].id;
   assert.equal((await guard(c,participant,[id])).claim,'PRIMARY_DELIVERY');
   assert.equal((await guard(c,participant,[id])).allowed,true);
   assert.equal((await c.query('SELECT count(*)::int n FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId])).rows[0].n,0);
   await bindMetaPrimaryRouting(c,event,asset,participant,appId);
   assert.equal((await c.query('SELECT count(*)::int n FROM meta_primary_delivery_admissions WHERE tenant_id=$1 AND source_event_id=$2',[tenantId,id])).rows[0].n,1,'Re-entry does not manufacture another receipt');
   await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
    VALUES($1,$2,$3,$4,$5,$6,'BOT','done',$7,$7,clock_timestamp(),$8,$9)`,[conversation,tenantId,assignment,connectionId,version,canonical,ticket,`BOT-${String(index).padStart(12,'0')}`,customer]);
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata)
    VALUES($1,$2,$3,$4,$5,$5,'Synthetic primary fixture',clock_timestamp(),$6)`,[tenantId,id,connectionId,message.id,canonical,{direct:true,input_type:'text',zammad_customer_id:customer}]);
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[id]);
   const enqueue=async(origin='BOT',source=id,created=null)=>{
    const did=randomUUID();return(await c.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,direct_origin,meta_routing_source_event_id,created_at)
     VALUES($1::uuid,$2,$3,$4,$5,$6,$7,'Synthetic reply','text/plain',$1::text,'QUEUED',$8,$9,COALESCE($10::timestamptz,now())) RETURNING *`,
     [did,tenantId,connectionId,conversation,canonical,ticket,origin==='HUMAN'?String(82000+index):null,origin,source,created])).rows[0];
   };
   delivery=await enqueue();assert.equal(delivery.meta_routing_epoch,'0');assert.equal(delivery.meta_routing_source_event_id,id);
   const reference=(await c.query('SELECT secret_reference FROM connections WHERE id=$1',[connectionId])).rows[0].secret_reference;
   job={id:delivery.id,tenantId,connectionId,botConversationId:conversation,groupId:canonical,provider:'meta',recipientType:'DIRECT',connectionSecretReference:reference,
    metaCredentialContext:{...asset,proof:session.provider_state_data.metaAccountProof},metaDirectRecipientSnapshot:delivery.meta_direct_recipient};
   assert.equal(await repository.metaDeliveryContextCurrent(c,job),true);
   await assertMetaDirectEffectCurrent(c,{tenantId,connectionId,conversationId:conversation,appId,sourceEventIds:[id]});
   for(const [sources,application,binding,sid,peer] of [[[randomUUID()],appId,runtime,sessionId,participant],[[id],'999',runtime,sessionId,participant],[[id],appId,{...runtime,graphVersion:'v25.0'},sessionId,participant],[[id],appId,runtime,randomUUID(),participant],[[id],appId,runtime,sessionId,randomUUID()]])
    assert.equal((await guard(c,peer,sources,application,binding,sid)).allowed,false);
   await reject(c,()=>enqueue('BOT',id,'2000-01-01T00:00:00Z'),/predates primary delivery/);
   await reject(c,()=>c.query('UPDATE meta_primary_delivery_admissions SET proof_sha256=$1 WHERE source_event_id=$2',['f'.repeat(64),id]),/permission denied|immutable/);
   await reject(c,()=>c.query('DELETE FROM meta_primary_delivery_admissions WHERE source_event_id=$1',[id]),/privacy authority/);
   // Settle the synthetic queue without issuing a provider request before native reacquisition.
   await c.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false WHERE id=$1",[delivery.id]);
  });
  await db.withTenant(tenantId,async c=>{
   const control=new MetaThreadControlService({withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(c)}},{},{});
   const view=await control.inspect(request,conversation);assert.equal(view.ownership.claim,'PRIMARY_DELIVERY');assert.deepEqual(view.availability.actions,[]);
   const operationId=randomUUID();await reserveDirectNativeReply(c,{tenantId,instanceId:instance,operationId,connectionId,chatId:canonical,ticketId:ticket,actorId:'3',nativeGroupId:'2',actorFullGroupIds:['2'],requestSha256:'e'.repeat(64),appId});
   intent=(await c.query('SELECT * FROM direct_native_reply_intents WHERE id=$1',[operationId])).rows[0];assert.equal(intent.meta_primary_source_event_id,id);
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId:conversation,appId,routingNativeIntentId:intent.id});
   await reject(c,()=>c.query('UPDATE direct_native_reply_intents SET meta_primary_source_event_id=$1 WHERE id=$2',[randomUUID(),intent.id]),/immutable/);
  });
  // A later primary must not replace the source frozen by the native intent.
  const laterValue=structuredClone(value);laterValue.messages[0].id=`wamid.later-${randomUUID()}`;
  laterValue.messages[0].timestamp=String(Number(message.timestamp)+1);
  const laterUnit=metaRoutingUnits(wabaId,'messages',laterValue)[0],laterLease=randomUUID();newPrimaryId=randomUUID();
  const laterPayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:laterUnit.value}]}]};
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,meta_direct_asset,meta_routing_evidence)
   VALUES($1,$2,$3,'META',$4,'messages',$5,$6,'PROCESSING',$7,clock_timestamp()+interval '10 minutes',$8,$9)`,
   [newPrimaryId,tenantId,connectionId,laterValue.messages[0].id,laterPayload,laterUnit.evidence.payloadSha256,laterLease,asset,{...laterUnit.evidence,providerSessionId:sessionId,appId}]));
  await worker(async c=>{
   await resolveMetaDirectMessage(c,{...event,id:newPrimaryId,providerEventId:laterValue.messages[0].id,payload:laterPayload},laterLease,
    {provider:'meta',connectionId,messageId:laterValue.messages[0].id,metaIdentity:parseMetaDirectIdentity(laterValue.messages[0],laterValue.contacts).identity},appId);
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata)
    VALUES($1,$2,$3,$4,$5,$5,'Synthetic later primary',clock_timestamp(),$6)`,[tenantId,newPrimaryId,connectionId,laterValue.messages[0].id,canonical,{direct:true,input_type:'text',zammad_customer_id:customer}]);
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[newPrimaryId]);
  });
  await db.withTenant(tenantId,async c=>{
   const articleId=String(84000+index);
   const admitted=await admitDirectReplyIntent(c,{tenantId,instanceId:instance,conversationId:conversation,operationId:intent.id,ticketId:ticket,articleId,actorId:'3',appId});
   assert.equal(admitted.routingSourceEventId,id);
   const queued=await queueOutboundParts(c,{tenantId,connectionId,groupBindingId:null,workspaceGroupId:null,botConversationId:conversation,externalChatId:canonical,
    ticketId:ticket,articleId,body:'Synthetic native reply',contentType:'text/plain',replyToMessageId:null,idempotencyKey:randomUUID(),requestSha256:'e'.repeat(64),
    agentDisplayName:null,agentPrefixSnapshot:null,agentIdentityPlacementSnapshot:null,deliveryOrigin:'TICKET',directOrigin:'HUMAN',attachments:[{source:'ARTICLE',id:85000+index,filename:'synthetic.txt',mimeType:'text/plain',byteSize:1}],mentions:[],
    directOwnershipEpoch:admitted.epoch,metaRoutingEpoch:admitted.routingEpoch,metaRoutingSourceEventId:admitted.routingSourceEventId});
   const parts=(await c.query('SELECT meta_routing_source_event_id FROM delivery_outbox WHERE tenant_id=$1 AND zammad_article_id=$2',[tenantId,articleId])).rows;
   assert.ok(queued.id);assert.equal(parts.length,2);for(const part of parts)assert.equal(part.meta_routing_source_event_id,id,'Every native part retains the older intent source rather than the newer primary');
  });
  await worker(async c=>{
   const result=(await c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,direct_origin)
    VALUES($1,$2,$3,$4,$5,$6,'Synthetic agent reply','text/plain',$7,'QUEUED','HUMAN') RETURNING *`,[tenantId,connectionId,conversation,canonical,ticket,String(83000+index),randomUUID()])).rows[0];
   assert.equal(result.meta_routing_source_event_id,newPrimaryId);
   assert.equal(await repository.metaDeliveryContextCurrent(c,{...job,id:result.id,metaDirectRecipientSnapshot:result.meta_direct_recipient}),true);
   await c.query('SAVEPOINT agent_reply_signals');
   const laterMessageId=laterValue.messages[0].id;
   // Freeze an ordered inbound pair before the reply's existing outbox timestamp.
   await c.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,direction,created_at)
    VALUES($1,$2,$3,$5,'INBOUND',$6::timestamptz-interval '2 seconds'),
          ($1,$2,$4,$5,'INBOUND',$6::timestamptz-interval '1 second')`,
    [tenantId,connectionId,message.id,laterMessageId,ticket,result.created_at]);
   const replyLease=randomUUID();
   await c.query(`UPDATE delivery_outbox SET state='SENDING',attempts=1,lease_id=$2,
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`,[result.id,replyLease]);
   const signalRepository=Object.create(OutboxRepository.prototype);
   signalRepository.tenant=async(scope,operation)=>{
    assert.equal((await c.query('SELECT app.current_tenant_id() AS tenant')).rows[0].tenant,scope);
    return operation(c);
   };
   const signalJob={...job,id:result.id,attempts:1,metaDirectRecipientSnapshot:result.meta_direct_recipient};
   const read={instanceId:instance,actorId:'3',ticketId:ticket,customerId:String(customer),connectionId,
    openedAt:new Date(result.created_at).getTime()+1000};
   assert.equal(await signalRepository.admitAgentReplySignal(signalJob,randomUUID()),undefined);

   await c.query('SAVEPOINT reply_signal_paused');
   await c.query("UPDATE connections SET state='PAUSED' WHERE tenant_id=$1 AND id=$2",[tenantId,connectionId]);
   assert.equal(await signalRepository.admitAgentReplySignal(signalJob,replyLease),undefined);
   assert.equal(await signalRepository.admitDirectTicketRead(tenantId,read,appId),undefined);
   await c.query('ROLLBACK TO SAVEPOINT reply_signal_paused');

   await c.query('SAVEPOINT reply_signal_other_tenant');
   await c.query("SELECT set_config('app.tenant_id',$1,true)",[foreignTenant]);
   assert.equal(await signalRepository.admitAgentReplySignal({...signalJob,tenantId:foreignTenant},replyLease),undefined);
   assert.equal(await signalRepository.admitDirectTicketRead(foreignTenant,read,appId),undefined);
   await c.query('ROLLBACK TO SAVEPOINT reply_signal_other_tenant');

   await c.query('SAVEPOINT reply_signal_privacy');
   const privacyJobId=randomUUID();
   const privacyJob=await c.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,
    idempotency_key,unmatched_diagnostic_hours_snapshot)
    SELECT $1::uuid,tenant_id,'RETENTION_SWEEP','TENANT',tenant_id::text,'RETENTION_DELETE',$1::text,
      unmatched_diagnostic_hours FROM retention_policies WHERE tenant_id=$2`,[privacyJobId,tenantId]);
   assert.equal(privacyJob.rowCount,1);
   await c.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    SELECT tenant_id,$1,'NORMALIZED_MESSAGE',id::text,encode(digest(id::text,'sha256'),'hex')
    FROM normalized_messages WHERE tenant_id=$2 AND connection_id=$3 AND external_message_id=$4`,
    [privacyJobId,tenantId,connectionId,laterMessageId]);
   assert.equal(await signalRepository.admitAgentReplySignal(signalJob,replyLease),undefined,
    'A privacy target on the latest inbound prevents signaling an older inbound');
   assert.equal(await signalRepository.admitDirectTicketRead(tenantId,read,appId),undefined);
   await c.query('ROLLBACK TO SAVEPOINT reply_signal_privacy');

   await c.query('SAVEPOINT direct_open_wins');
   const opened=await signalRepository.admitDirectTicketRead(tenantId,read,appId);
   assert.equal(opened?.messageId,laterMessageId);
   assert.equal(opened.canType,false);
   assert.equal(await signalRepository.admitDirectTicketRead(tenantId,read,appId),undefined);
   assert.equal(await signalRepository.admitAgentReplySignal(signalJob,replyLease),undefined);
   assert.deepEqual(await signalRepository.admitDirectTicketRead(tenantId,read,appId,opened.id),opened);
   await c.query('ROLLBACK TO SAVEPOINT direct_open_wins');

   const selected=await signalRepository.admitAgentReplySignal(signalJob,replyLease);
   assert.equal(selected?.messageId,laterMessageId);
   assert.equal(selected.canType,true);
   assert.deepEqual(await signalRepository.admitAgentReplySignal(signalJob,replyLease,selected.id),selected);
   assert.equal(await signalRepository.admitAgentReplySignal(signalJob,replyLease),undefined);
   assert.equal(await signalRepository.admitDirectTicketRead(tenantId,read,appId),undefined);
   await c.query(`UPDATE delivery_outbox SET state='SENT',external_message_id='wamid.synthetic-reply',
     lease_id=NULL,lease_expires_at=NULL WHERE id=$1`,[result.id]);
   assert.deepEqual(await signalRepository.admitAgentReplySignal(signalJob,replyLease,selected.id),{...selected,canType:false});
   await c.query('ROLLBACK TO SAVEPOINT agent_reply_signals');
   await c.query('SAVEPOINT primary_config_fence');
   await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaRouting}','{\"version\":1}') WHERE id=$1",[sessionId]);
   assert.equal((await guard(c,participant,[id])).allowed,false);assert.equal(await repository.metaDeliveryContextCurrent(c,job),false);
   await c.query("UPDATE provider_sessions SET provider_state_data=provider_state_data-'metaRouting' WHERE id=$1",[sessionId]);
   assert.equal((await guard(c,participant,[id])).allowed,false,'Removing routing JSON cannot restore primary authority');
   await c.query('ROLLBACK TO SAVEPOINT primary_config_fence');
  });
  await db.withTenant(tenantId,async c=>{
   for(const type of ['control_passed','control_taken']){
    await c.query('SAVEPOINT primary_control_fence');
    const unit=metaRoutingUnits(wabaId,'messaging_handovers',{messaging_product:'whatsapp',recipient:{phone_number_id:phoneNumberId},
     type,timestamp:message.timestamp,sender:{phone_number:phone}})[0];
    const eventId=randomUUID(),payload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messaging_handovers',value:unit.value}]}]};
    await c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_routing_evidence)
     VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.passive',$4,$5,'ACCEPTED',$6)`,[eventId,tenantId,connectionId,payload,unit.evidence.payloadSha256,{...unit.evidence,providerSessionId:sessionId,appId}]);
    assert.equal((await guard(c,participant,[id])).allowed,false,type);
    await c.query('ROLLBACK TO SAVEPOINT primary_control_fence');
   }
   await c.query('SAVEPOINT primary_unknown_action');
   const action=randomUUID();
   await c.query(`INSERT INTO meta_thread_control_actions(id,tenant_id,connection_id,provider_session_id,participant_identity_id,conversation_id,phone_number_id,account_id,app_id,
    routing_epoch,configuration_version,review_version,action,recipient_snapshot,runtime_binding,credential_context,actor_id,idempotency_key,request_sha256)
    VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,0,0,0,'take',$10,$11,$12,$13,$1::text,$14)`,
    [action,tenantId,connectionId,sessionId,participant,conversation,phoneNumberId,wabaId,appId,{kind:'PHONE',value:phone},runtime,
     {secretReference:session.provider_state_data.metaAccountProof.secretReference,proof:session.provider_state_data.metaAccountProof},actor,'d'.repeat(64)]);
   await c.query("UPDATE meta_thread_control_actions SET state='OUTCOME_UNKNOWN',completed_at=clock_timestamp(),error_code='SYNTHETIC_UNKNOWN' WHERE id=$1",[action]);
   assert.equal((await guard(c,participant,[id])).reason,'ACTION_UNRESOLVED');
   await c.query('ROLLBACK TO SAVEPOINT primary_unknown_action');
   const stale=structuredClone(value);stale.messages[0].id=`wamid.expired-${randomUUID()}`;stale.messages[0].timestamp=String(Math.floor(Date.now()/1000)-90000);
   const staleUnit=metaRoutingUnits(wabaId,'messages',stale)[0],staleId=randomUUID(),staleLease=randomUUID();
   const stalePayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:staleUnit.value}]}]};
   await c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,lease_id,lease_expires_at,meta_direct_asset,meta_routing_evidence)
    VALUES($1::uuid,$2,$3,'META',$1::text,'messages',$4,$5,'PROCESSING',$6,clock_timestamp()+interval '10 minutes',$7,$8)`,
    [staleId,tenantId,connectionId,stalePayload,staleUnit.evidence.payloadSha256,staleLease,asset,{...staleUnit.evidence,providerSessionId:sessionId,appId}]);
   await reject(c,()=>bindMetaPrimaryRouting(c,{...event,id:staleId,payload:stalePayload},asset,participant,appId),/permission denied/);
   staleEvent={...event,id:staleId,payload:stalePayload};
   await c.query('SAVEPOINT primary_passive_fence');
   const passive=metaRoutingUnits(wabaId,'standby',{messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},standby:{messages:[message],contacts:value.contacts}})[0];
   const passiveId=randomUUID(),passivePayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'standby',value:passive.value}]}]};
   await c.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_routing_evidence)
    VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.passive',$4,$5,'ACCEPTED',$6)`,[passiveId,tenantId,connectionId,passivePayload,passive.evidence.payloadSha256,{...passive.evidence,providerSessionId:sessionId,appId}]);
   assert.equal((await guard(c,participant,[id])).allowed,false,'Pending negative fences a previously queued reply');
   await assert.rejects(()=>assertMetaDirectEffectCurrent(c,{tenantId,conversationId:conversation,appId,routingNativeIntentId:intent.id}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED'});
   await c.query('ROLLBACK TO SAVEPOINT primary_passive_fence');
  });
  await worker(async c=>{
   await reject(c,()=>bindMetaPrimaryRouting(c,staleEvent,asset,participant,appId),/primary delivery source changed/);
   await c.query("UPDATE event_inbox SET status='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[staleEvent.id]);
  });
  assert.equal((await controller.detail(request,connectionId)).meta_routing_configuration_ready,true);
  await db.withTenant(foreignTenant,async c=>{assert.equal((await guard(c,participant,[id])).allowed,false);assert.equal((await c.query('SELECT count(*)::int n FROM meta_primary_delivery_admissions')).rows[0].n,0)});
  contexts.push({id,participant,canonical,job,message,value});
  }catch(error){failures.push(new Error(`Primary delivery ${kind}`,{cause:error}))}
  finally{try{await cleanup()}catch(error){failures.push(new Error(`Primary fixture cleanup ${kind}`,{cause:error}))}}
 }
 if(failures.length)throw new AggregateError(failures,'Primary delivery failure union');

 const last=contexts.at(-1);
 const route=await db.resolveMetaWebhookRoute(phoneNumberId);
 assert.equal(route?.tenant_id,tenantId);
 const phone=last.message.from;
 const preference=(optedOut,seconds,accountId=wabaId)=>{
  const marketingPreference={phone,bsuid:null,accountId,optedOut,observedAt:new Date(Date.UTC(2026,10,24,10,0,seconds)).toISOString()};
  const payloadSha256=createHash('sha256').update(JSON.stringify(marketingPreference)).digest('hex');
  return{eventType:'user_preferences',providerEventId:'preference:v1:'+payloadSha256,marketingPreference,
   payload:{redacted:true,payload_sha256:payloadSha256},payloadSha256,routeKey:phoneNumberId,providerSessionKey:phoneNumberId,providerEngine:'CLOUD_API'};
 };
 const acceptPreference=(...args)=>db.acceptWebhookEvent(route,preference(...args),appId);
 const optedOut=c=>whatsappMarketingOptedOut(c,tenantId,connectionId,last.job.metaDirectRecipientSnapshot);
 assert.equal(await worker(optedOut),false);
 await assert.rejects(()=>acceptPreference(true,0,'999999'),/Webhook route was not found/);
 const stop=await acceptPreference(true,1);
 assert.equal(stop.duplicate,false);
 assert.deepEqual(await acceptPreference(true,1),{id:stop.id,duplicate:true});
 assert.equal(await worker(optedOut),true,'The signed phone preference is resolved for the verified direct recipient');
 assert.equal(await db.withTenant(foreignTenant,optedOut),false);
 await assert.rejects(()=>db.withTenant(foreignTenant,c=>c.query(
  "UPDATE whatsapp_marketing_preferences SET tenant_id=$1 WHERE tenant_id=$2",[foreignTenant,tenantId])),{code:'42501'});
 await assert.rejects(()=>db.withTenant(tenantId,c=>c.query(
  'UPDATE whatsapp_marketing_preferences SET opted_out=false WHERE tenant_id=$1',[tenantId])),{code:'42501'});
 await assert.rejects(()=>db.withTenant(foreignTenant,c=>c.query(
  "INSERT INTO whatsapp_marketing_preferences (tenant_id,subject_kind,subject,opted_out,observed_at) VALUES ($1,'PHONE',$2,true,$3)",
  [tenantId,phone,'2026-11-24T10:00:00Z'])),{code:'42501'});
 await acceptPreference(false,1);
 assert.equal(await worker(optedOut),true,'Stop wins an ambiguous same-second update');
 const resume=await acceptPreference(false,3);
 assert.equal((await acceptPreference(false,3)).duplicate,true);
 await acceptPreference(true,2);
 assert.equal(await worker(optedOut),false,'An older Stop cannot roll back a confirmed Resume');
 const seedMarketingDelivery=async(context,state,lease,externalId)=>{
  const deliveryId=randomUUID();
  return withFixtureTenant(admin,tenantId,async()=>{
   const inserted=await admin.query(`INSERT INTO delivery_outbox
    (id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
      message_body,content_type,idempotency_key,state,direct_origin,attempts,lease_id,lease_expires_at,external_message_id,meta_routing_source_event_id)
    SELECT $1::uuid,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
      'Synthetic template','text/plain',$1::text,$2,direct_origin,1,$3::uuid,
      CASE WHEN $3::uuid IS NOT NULL THEN now()+interval '10 minutes' END,$4,meta_routing_source_event_id
    FROM delivery_outbox WHERE tenant_id=$5 AND id=$6`,[deliveryId,state,lease,externalId,tenantId,context.job.id]);
   assert.equal(inserted.rowCount,1);
   await admin.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state,started_at) VALUES($1,$2,1,$3,$4)",
    [tenantId,deliveryId,state,'2026-11-24T10:00:04.000Z']);
   return deliveryId;
  });
 };
 const syncLease=randomUUID(),syncDelivery=await seedMarketingDelivery(last,'SENDING',syncLease,null);
 await new OutboxRepository(pool).fail({...last.job,id:syncDelivery,attempts:1,
  template:{name:'synthetic_notice',languageCode:'en_US',bodyParameters:[]}},syncLease,false,
  'Synthetic marketing rejection',undefined,false,'META_MARKETING_OPTED_OUT');
 assert.equal(await worker(optedOut),true);
 await worker(async c=>{
  const observation=(await c.query("SELECT opted_out FROM whatsapp_marketing_preferences WHERE tenant_id=$1 AND subject_kind='PHONE' AND subject=$2",[tenantId,phone])).rows[0];
  assert.deepEqual(observation,{opted_out:true});
  assert.deepEqual((await c.query('SELECT state,provider_code FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[tenantId,syncDelivery])).rows,
    [{state:'FAILED_TERMINAL',provider_code:'META_MARKETING_OPTED_OUT'}]);
  assert.deepEqual((await c.query('SELECT state,lease_id,manual_retry_allowed FROM delivery_outbox WHERE tenant_id=$1 AND id=$2',[tenantId,syncDelivery])).rows,
    [{state:'FAILED_TERMINAL',lease_id:null,manual_retry_allowed:false}]);
 });

 // A status receipt can act only on the recipient of its matched delivery.
 const inbound=new InboundRepository(pool), first=contexts[0], receiptId=randomUUID(), groupReceiptId=randomUUID();
 const statusExternalId='wamid.synthetic-'+randomUUID(), groupExternalId='wamid.synthetic-'+randomUUID();
 await seedMarketingDelivery(first,'SENT',null,statusExternalId);
 await withFixtureTenant(admin,tenantId,async()=>{
  for(const id of [receiptId,groupReceiptId]){
   await admin.query("INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1::uuid,$2,$3,'META',$1::text,'message.status','{}',$4,'PROCESSED')",
    [id,tenantId,connectionId,'a'.repeat(64)]);
  }
  const group=randomUUID(),ruleFamily=randomUUID(),rule=randomUUID(),binding=randomUUID(),delivery=randomUUID();
  await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1::uuid,$2,$3,$1::text,'Synthetic preference group')",[group,tenantId,connectionId]);
  await admin.query("INSERT INTO rule_families(id,tenant_id,name,created_by) VALUES($1::uuid,$2,$1::text,$3)",[ruleFamily,tenantId,actor]);
  await admin.query("INSERT INTO rule_sets(id,tenant_id,family_id,name,version,state,snapshot_sha256,created_by) VALUES($1::uuid,$2,$3,$1::text,1,'DRAFT',$4,$5)",
   [rule,tenantId,ruleFamily,createHash('sha256').update('[]').digest('hex'),actor]);
  await admin.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
   VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Synthetic','Agent',30,'DRAFT')`,[binding,tenantId,group,rule]);
  const {rows}=await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,external_message_id)
   VALUES($1::uuid,$2,$3,$4,'80005','1','Synthetic group message','text/plain',$1::text,'SENT',$5) RETURNING meta_direct_recipient`,[delivery,tenantId,connectionId,binding,groupExternalId]);
  assert.deepEqual(rows,[{meta_direct_recipient:null}]);
 });
 const failedReceipt=(id,externalMessageId)=>inbound.applyDeliveryReceipt(
  {id,tenantId,connectionId,provider:'meta'},
  {provider:'meta',connectionId,externalMessageId,scope:'MESSAGE',status:'FAILED',providerStatus:'FAILED',
   receiptKey:createHash('sha256').update(id).digest('hex'),timestamp:'2026-11-24T10:00:05.000Z',errorCodes:['131050'],metadata:{errorCount:1}});
 const receiptAuditCount=id=>db.withTenant(tenantId,async c=>(await c.query(
  "SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND request_id=$2 AND action='whatsapp.marketing_preference_changed' AND new_value->>'reason'='PROVIDER_131050'",
  [tenantId,id])).rows[0].n);
 const preferenceRows=()=>worker(async c=>(await c.query(
  'SELECT id,subject_kind,opted_out,observed_at FROM whatsapp_marketing_preferences WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows);
 assert.equal(await worker(c=>whatsappMarketingOptedOut(c,tenantId,connectionId,first.job.metaDirectRecipientSnapshot)),false);
 assert.equal(await failedReceipt(receiptId,statusExternalId),'APPLIED');
 assert.equal(await worker(c=>whatsappMarketingOptedOut(c,tenantId,connectionId,first.job.metaDirectRecipientSnapshot)),true);
 assert.equal(await receiptAuditCount(receiptId),1);
 assert.equal(await failedReceipt(receiptId,statusExternalId),'DUPLICATE');
 assert.equal(await receiptAuditCount(receiptId),1,'Receipt replay adds no second preference audit');
 const priorPreferences=await preferenceRows();
 assert.equal(await failedReceipt(groupReceiptId,groupExternalId),'APPLIED');
 assert.deepEqual(await preferenceRows(),priorPreferences,'A receipt without a direct recipient leaves preferences intact');
 assert.equal(await receiptAuditCount(groupReceiptId),0);
 await db.withTenant(tenantId,async c=>{
  const accepted=await withFixtureTenant(admin,tenantId,async()=>(await admin.query(
   'SELECT status,payload,meta_webhook_app_id FROM event_inbox WHERE tenant_id=$1 AND id=$2',[tenantId,stop.id])).rows[0]);
  assert.deepEqual(accepted,{status:'PROCESSED',payload:preference(true,1).payload,meta_webhook_app_id:appId});
  const audit=(await c.query("SELECT target_id,new_value,request_id FROM audit_events WHERE request_id=ANY($1::text[]) AND action='whatsapp.marketing_preference_changed'",
   [[stop.id,resume.id,syncDelivery]])).rows;
  assert.equal(audit.filter(row=>row.request_id===stop.id&&row.new_value.opted_out&&row.new_value.reason==='PREFERENCE_WEBHOOK').length,1);
  assert.equal(audit.filter(row=>row.request_id===resume.id&&!row.new_value.opted_out).length,1);
  assert.ok(audit.some(row=>row.request_id===syncDelivery&&row.new_value.opted_out&&row.new_value.reason==='PROVIDER_131050'));
  assert.ok(audit.every(row=>/^[a-f0-9-]{36}$/u.test(row.target_id)));
  assert.ok(!JSON.stringify(audit).includes(phone),'Audit uses IDs and enumerated reasons only');
 });
 const eligible=c=>c.query('SELECT app.meta_primary_delivery_eligible($1,$2,$3,$4,$5,$6) AS eligible',[connectionId,sessionId,phoneNumberId,wabaId,appId,runtime]).then(r=>r.rows[0].eligible);
 assert.equal(await worker(eligible),true);
 await rotate();
 await worker(async c=>{
  assert.equal(await eligible(c),true,'Supported credential rotation retains primary-delivery eligibility');
  assert.equal((await guard(c,last.participant,[last.id])).reason,'PRIMARY_DELIVERY_REQUIRED','Old receipt cannot acquire the new secret/proof');
  assert.equal(await repository.metaDeliveryContextCurrent(c,last.job),false,'Queued old credentials cannot be repinned');
 });
 let negative,pendingPid;const interleaveErrors=[];
 try{await worker(async c=>{
  const workerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await c.query('SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,connectionId]);
  await c.query('SELECT id FROM provider_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,sessionId]);
  assert.equal(await eligible(c),true);
  const passive=metaRoutingUnits(wabaId,'standby',{messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},standby:{messages:[last.message],contacts:last.value.contacts}})[0];
  const pidReady=Promise.withResolvers();
  negative=db.withTenant(tenantId,async a=>{
   await a.query("SET LOCAL statement_timeout='5s'");
   pendingPid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;pidReady.resolve();
   const id=randomUUID(),payload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'standby',value:passive.value}]}]};
   await a.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_routing_evidence)
    VALUES($1::uuid,$2,$3,'META',$1::text,'meta.routing.passive',$4,$5,'ACCEPTED',$6)`,[id,tenantId,connectionId,payload,passive.evidence.payloadSha256,{...passive.evidence,providerSessionId:sessionId,appId}]);
  }).catch(error=>{pidReady.reject(error);throw error});
  void negative.catch(()=>undefined);
  // Observe the real row-lock wait; do not infer serialization from elapsed time.
  let timer;try{await Promise.race([pidReady.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Primary negative connection readiness timeout')),5000)})])}finally{clearTimeout(timer)}
  let blocked=false;
  for(let i=0;i<100&&!blocked;i++){
   blocked=(await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',[pendingPid,workerPid])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true,'A concurrent negative waits for the current send admission transaction');
 })}catch(error){interleaveErrors.push(error)}finally{if(negative)try{await negative}catch(error){interleaveErrors.push(error)}}
 if(interleaveErrors.length)throw new AggregateError(interleaveErrors,'Primary negative concurrency failure union');
 await worker(async c=>{
  assert.equal(await eligible(c),false,'Committed negative disables primary admission');
  assert.equal(await repository.metaDeliveryContextCurrent(c,last.job),false,'Committed negative cannot restore old queued work');
  const exported=await exportMetaRoutingPrivacy(c,tenantId,true,[]);
  assert.equal(exported.events.find(row=>row.id===last.id).primary_delivery.claim,'PRIMARY_DELIVERY');
 });
 const privacyId=randomUUID();
 try{ await withFixtureTenant(admin,tenantId,async()=>{
  await admin.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token)
   VALUES($1::uuid,$2,'DELETE','PARTICIPANT',$3,'DELETE_TICKETS',$1::text,'RUNNING','DISCOVER',1,$4,clock_timestamp()+interval '10 minutes',1)`,[privacyId,tenantId,last.canonical,randomUUID()]);
  await admin.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
   VALUES($1,$2,'META_ROUTING_EVENT',$3,encode(digest($3,'sha256'),'hex'))`,[tenantId,privacyId,last.id]);
  await admin.query("UPDATE privacy_jobs SET stage='LOCAL' WHERE tenant_id=$1 AND id=$2",[tenantId,privacyId]);
 });
 await worker(async c=>{
  await finalizeMetaRoutingPrivacy(c,{tenantId,id:privacyId});
  assert.equal((await c.query('SELECT count(*)::int n FROM meta_primary_delivery_admissions WHERE source_event_id=$1',[last.id])).rows[0].n,0);
  assert.equal((await c.query('SELECT status FROM event_inbox WHERE id=$1',[last.id])).rows[0].status,'REDACTED');
  assert.equal((await guard(c,last.participant)).allowed,false,'Content erasure cannot restore primary authority');
 });
 }finally{
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,privacyId]));
 }

}
