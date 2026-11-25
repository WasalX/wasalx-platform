import { withPostgresClock } from "./support/postgres-clock.mjs";
import assert from 'node:assert/strict';
import {withFixtureTenant,routingFixtureEnvironment,observeRoutingFixture} from './meta-routing-fixture.mjs';
import {metaRoutingUnits} from '../packages/core/dist/meta-routing.js';
import {readMetaTemplateInventory} from '../packages/core/dist/meta-template-inventory.js';
import {bindMetaPrimaryRouting} from '../services/connector-worker/dist/services/connector-worker/src/meta-routing.js';
import {verifyMetaRoutingEffects} from './meta-routing-postgres.mjs';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {metaTestRecipientAdmission,resolveMetaTestRecipientLink,resolveMetaTestStatusRecipientLink} from '../packages/core/dist/meta-test-recipient-link.js';
import {verifyMetaTestPhoneSnapshots} from './meta-test-phone-policy-postgres.mjs';
import {prepareDirectCustomerClose,directCustomerCloseAdmission} from '../packages/core/dist/direct-customer-close.js';
import {reserveDirectNativeReply} from '../services/control-api/dist/direct-native-operations.js';
import {ZammadInternalController} from '../services/control-api/dist/zammad-internal.controller.js';

import {createHash,createHmac,randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {verifyMetaCredentialMetadata} from '../services/connector-worker/dist/packages/core/src/meta-account-relation.js';
import {metaDirectIdentityChangeEvidence,parseMetaDirectIdentity,metaDirectTransitionEvidence} from '../services/connector-worker/dist/packages/core/src/meta-direct-identity.js';
import {Module} from '../services/control-api/node_modules/@nestjs/common/index.js';
import {NestFactory} from '../services/control-api/node_modules/@nestjs/core/index.js';
import {FastifyAdapter} from '../services/control-api/node_modules/@nestjs/platform-fastify/index.js';
import {DatabaseService} from '../services/control-api/dist/database.service.js';
import {WebhookIngressController} from '../services/control-api/dist/webhook-ingress.controller.js';
import {WebhookSecretService} from '../services/control-api/dist/webhook-secret.service.js';
import {TenantDrainService} from '../services/control-api/dist/tenant-drain.service.js';
import {RoutingConnectorsConfig} from '../services/control-api/dist/routing-connectors.config.js';
import {SecretProvisioningService} from '../services/control-api/dist/secret-provisioning.service.js';
import {META_WEBHOOK_MAX_BYTES} from '../services/control-api/dist/webhook-security.js';

// Existing isolated canonical PG gate only. Native/provider callbacks are simulated;
// RLS, triggers, repositories, FK locks, privacy discovery/export/finalization are real.
// The existing identity fixture needs genuine alias-free historical delivery
// state. Seed it before routing171; no app/test-written compatibility grant.
export async function seedMetaDirectLegacyRoutingHistory(admin){
 const tenantId=randomUUID(),connectionId=randomUUID(),sessionId=randomUUID(),userId=randomUUID();
 const familyId=randomUUID(),versionId=randomUUID(),assignmentId=randomUUID();
 const phoneNumberId='1',wabaId='2',secretReference=`secret://${tenantId}/connections/${connectionId}/meta`;
 const prefix=`direct-identity-${tenantId}`,hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
 const reference=chat=>'BOT-'+hash(tenantId+':'+assignmentId+':'+chat).slice(0,12).toUpperCase();
 await admin.query('BEGIN');
 try{
  await admin.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
  await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Direct identity fixture',$2,'ACTIVE')",[tenantId,prefix]);
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Direct identity fixture')",[userId,prefix,`${prefix}@example.invalid`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenantId,userId]);
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Direct identity fixture','META','CLOUD_API','WORKING',$3)",[connectionId,tenantId,secretReference]);
  await admin.query(`INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data)
   VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)`,[sessionId,tenantId,connectionId,phoneNumberId,`meta-cloud://${wabaId}/${phoneNumberId}`,{wabaId}]);
  await admin.query("INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)",[familyId,tenantId,prefix,userId]);
  const definition={schemaVersion:1,name:prefix,start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]};
  await admin.query(`INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at)
   VALUES($1,$2,$3,1,'ACTIVE',$4,$5,$6,$6,clock_timestamp())`,[versionId,tenantId,familyId,definition,hash(definition),userId]);
  await admin.query(`INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by)
   VALUES($1,$2,$3,$4,$5,'Operations','ACTIVE',$6,$6)`,[assignmentId,tenantId,connectionId,familyId,versionId,userId]);
  const legacyCanonical='300',legacyParticipant=(await admin.query("INSERT INTO participant_identities(tenant_id,connection_id,external_participant_id,normalized_phone) VALUES($1,$2,$3,$4) RETURNING id",[tenantId,connectionId,legacyCanonical,'+300'])).rows[0].id;
   const legacyConversation=randomUUID(),legacyTicket='98241',legacyCustomer='98251';
   await admin.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
    VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,$9)`,[legacyConversation,tenantId,assignmentId,connectionId,versionId,legacyCanonical,legacyTicket,reference(legacyCanonical),Number(legacyCustomer)]);
   const history=randomUUID();await admin.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id)
    VALUES($1,$2,$3,$4,$5,$6,'Immutable legacy send history','text/plain',$7,'SENT','HUMAN','98253')`,[history,tenantId,connectionId,legacyConversation,legacyCanonical,legacyTicket,`${prefix}-legacy-unknown`]);
  const historicalBirth=(await admin.query('SELECT meta_direct_recipient,meta_billing_snapshot FROM delivery_outbox WHERE id=$1',[history])).rows[0];
  assert.equal(historicalBirth.meta_direct_recipient.claim,'LEGACY_PHONE_CONTEXT');
  assert.deepEqual(historicalBirth.meta_billing_snapshot,{schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'},'Real pre-routing history receives its tenant-scoped billing birth');
  await admin.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[legacyConversation]);
  await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenantId]);
  await admin.query('COMMIT');
  return{tenantId,connectionId,sessionId,userId,familyId,versionId,assignmentId,legacyParticipant,legacyConversation,legacyDelivery:history};
 }catch(error){await admin.query('ROLLBACK');throw error;}
}

export async function verifyMetaDirectIdentityPostgres(adminUrl,workerConfig,appUrl,platformOperationsUrl,routingHistory){
 const admin=new Client({connectionString:adminUrl,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await admin.connect();
 const applicationName=`meta-direct-${randomUUID()}`;
 const pool=new Pool({...workerConfig,application_name:applicationName,options:`${workerConfig.options??''} -c statement_timeout=5000 -c lock_timeout=3000`});
 assert.equal(typeof appUrl,'string');assert(appUrl.length,'Existing application database URL is required');
 const apiPool=new Pool({connectionString:appUrl,options:'-c statement_timeout=5000 -c lock_timeout=3000'});
 const inbound=new InboundRepository(pool),privacy=new PrivacyRepository(pool);
 assert(routingHistory?.legacyDelivery,'Actual pre-routing migration history seed is required');
 const {tenantId,connectionId,sessionId,userId,familyId,versionId,assignmentId}=routingHistory;
 const appId='123456789',phoneNumberId='1',wabaId='2',phone='15558880100',bsuid=`SA.${'a'.repeat(128)}`;
 const restoreRoutingEnvironment=routingFixtureEnvironment(appId);
 const asset={providerSessionId:sessionId,phoneNumberId,wabaId};
 const secretReference=`secret://${tenantId}/connections/${connectionId}/meta`;
 const templateAccessToken='simulated-ticket-template-access-token';
 const metadata=verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId});
 const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId,...asset,secretReference,
  graphVersion:'v24.0',verifiedAt:metadata.verifiedAt,responseSha256:'a'.repeat(64),credentialFingerprint:createHash('sha256').update(templateAccessToken).digest('hex'),
  operationId:randomUUID(),fencingToken:1,credentialMetadata:metadata};
 const conversationId=randomUUID();
 const prefix=`direct-identity-${tenantId}`,ticketId='98231';
 const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
 const reference=chat=>'BOT-'+hash(tenantId+':'+assignmentId+':'+chat).slice(0,12).toUpperCase();
 const tx=async(work,scope=tenantId,usingPool=pool)=>{
  const client=await usingPool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[scope]);
   const result=await work(client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 };
 const add=async(message,contacts,{pin=asset,marker,provider='META',transition=false,eventId,bindRouting=true}={})=>{
  message={timestamp:String(Math.floor(Date.now()/1000)),...message};
  const id=eventId??randomUUID(),leaseId=randomUUID(),payload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},messages:[message],...(contacts===undefined?{}:{contacts})}}]}]};
  const payloadHash=hash(payload),routing=message.type==='system'?null:metaRoutingUnits(wabaId,'messages',payload.entry[0].changes[0].value)[0]?.evidence, routingEvidence=routing?{...routing,payloadSha256:payloadHash,providerSessionId:sessionId,appId}:null;
  const evidence=marker===undefined?metaDirectIdentityChangeEvidence(payload,payloadHash):marker;
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,attempts,lease_id,lease_expires_at,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_routing_evidence)
   VALUES($1,$2,$3,$4,$5,'messages',$6,$7,'PROCESSING',1,$8,clock_timestamp()+interval '10 minutes',$9,$10,$11,$12)`,
   [id,tenantId,connectionId,provider,message.id,payload,payloadHash,leaseId,pin,evidence,transition?metaDirectTransitionEvidence(payload,payloadHash,pin):null,provider==='META'?routingEvidence:null]));
  const event={id,tenantId,connectionId,provider:'meta',providerEventId:message.id,eventType:'messages',payload,attempts:1};
  if(routingEvidence&&provider==='META'&&bindRouting){
   const current=(await admin.query("SELECT DISTINCT participant_identity_id FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 AND state='ACTIVE' AND kind=$3 AND value=$4",[tenantId,connectionId,routing.peer.kind,routing.peer.value])).rows;
   if(current.length===1)await tx(c=>bindMetaPrimaryRouting(c,event,asset,current[0].participant_identity_id,appId));
  }
  return{event,leaseId,payloadHash};
 };
 const ordinary=(id,from=phone)=>({id,from,type:'text',text:{body:'Synthetic direct privacy fixture'}});
 const aliasInsert=(client,participantId,input,kind,value)=>client.query(`INSERT INTO meta_direct_identity_aliases
  (tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id,source_payload_sha256)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[tenantId,connectionId,participantId,sessionId,phoneNumberId,wabaId,kind,value,input.event.id,input.payloadHash]);
 const createJob=async(scopeType,scopeValue,jobType='EXPORT',usingClient=admin,requestedAt=null)=>{
  const id=randomUUID(),leaseId=randomUUID();
  const disposition=jobType==='EXPORT'?'EXPORT_ONLY':jobType==='RETENTION_SWEEP'?'RETENTION_DELETE':'DELETE_TICKETS';
  const row=(await usingClient.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,created_at,unmatched_diagnostic_hours_snapshot)
   VALUES($1,$2,$3,$4,$5,$6,$7,'RUNNING','DISCOVER',1,$8,clock_timestamp()+interval '10 minutes',1,COALESCE($10::timestamptz,clock_timestamp()),$9) RETURNING created_at`,
   [id,tenantId,jobType,scopeType,scopeValue,disposition,`${prefix}-${id}`,leaseId,jobType==='RETENTION_SWEEP'?24:null,requestedAt])).rows[0];
  const job={id,tenantId,leaseId,jobType,scopeType,scopeValue,disposition,state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:1,
   createdAt:requestedAt??row.created_at.toISOString(),unmatchedDiagnosticHours:24,exportTtlHours:24,zammadBaseUrl:'https://privacy.invalid',zammadPrivacySecretReference:`secret://${tenantId}/zammad/privacy`};
  if(jobType==='EXPORT'){await privacy.discover(job,leaseId);job.stage='EXPORT';}
  return job;
 };
 const finishExport=job=>withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]));
 try{
  assert.equal((await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1 AND state='SUSPENDED' RETURNING id",[tenantId])).rowCount,1);
  assert.equal((await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}',$1::jsonb) WHERE id=$2 RETURNING id",[proof,sessionId]))).rowCount,1);
  assert.deepEqual((await admin.query('SELECT meta_routing_epoch,state FROM delivery_outbox WHERE id=$1',[routingHistory.legacyDelivery])).rows[0],{meta_routing_epoch:'0',state:'SENT'},'Real migration preserves old history, never a new send');
  await observeRoutingFixture(admin,{tenantId,connectionId,sessionId,appId});
  assert.equal((await tx(c=>c.query("SELECT app.meta_direct_identifier_valid('PHONE','100') phone,app.meta_direct_identifier_valid('BSUID',$1) bsuid",[bsuid]))).rows[0].phone,true);
  assert.equal((await tx(c=>c.query("SELECT app.meta_direct_identifier_valid('BSUID',$1) good,app.meta_direct_identifier_valid('BSUID',$2) bad",[bsuid,`${bsuid}a`]))).rows[0].good,true);
  assert.equal((await tx(c=>c.query("SELECT app.meta_direct_identifier_valid('BSUID',$1) bad",[`${bsuid}a`]))).rows[0].bad,false);
  await verifyMetaDirectHttpProducer(admin,appUrl,tenantId,appId,prefix);
  const input=await add(ordinary(`${prefix}-joint`),[{wa_id:phone,user_id:bsuid}]);
  const participantId=(await admin.query("INSERT INTO participant_identities(tenant_id,connection_id,external_participant_id,normalized_phone) VALUES($1,$2,$3,$4) RETURNING id",[tenantId,connectionId,phone,`+${phone}`])).rows[0].id;
  await assert.rejects(()=>tx(c=>aliasInsert(c,participantId,input,'PHONE','101')),/signed canonical identity/);
  const malformed={...ordinary(`${prefix}-nonjoint`),from_user_id:bsuid};
  const noJoint=await add(malformed);
  await assert.rejects(()=>tx(c=>aliasInsert(c,participantId,noJoint,'BSUID',bsuid)),/signed canonical identity/);
  await admin.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[noJoint.event.id]);
  for(const [field,bad] of [['schemaVersion',2],['tenantId',randomUUID()],['connectionId',randomUUID()],['secretReference','secret://copied/foreign']]){
   await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}', $1::jsonb) WHERE id=$2",[{...proof,[field]:bad},sessionId]));
   await assert.rejects(()=>tx(c=>aliasInsert(c,participantId,input,'PHONE',phone)),/source asset/);
  }
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof}', $1::jsonb) WHERE id=$2",[proof,sessionId]));
  const phoneAlias=(await tx(c=>aliasInsert(c,participantId,input,'PHONE',phone))).rows[0].id;
  const bsuidAlias=(await tx(c=>aliasInsert(c,participantId,input,'BSUID',bsuid))).rows[0].id;
  await assert.rejects(()=>tx(c=>aliasInsert(c,participantId,input,'PHONE',phone),randomUUID()),/row-level security|source asset/);
  await assert.rejects(()=>admin.query('UPDATE event_inbox SET meta_direct_asset=$1 WHERE id=$2',[{...asset,phoneNumberId:'9'},input.event.id]),/immutable/);
  await assert.rejects(()=>add(ordinary(`${prefix}-badpin`),undefined,{pin:{...asset,phoneNumberId:'9'}}),/pin.*signed source session/);
  await admin.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[input.event.id]);
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
   VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,98231)`,[conversationId,tenantId,assignmentId,connectionId,versionId,phone,ticketId,reference(phone)]));
  const callbackInput=await add(ordinary(`${prefix}-callback`),[{wa_id:phone,user_id:bsuid}]);
  const identity=parseMetaDirectIdentity(callbackInput.event.payload.entry[0].changes[0].value.messages[0],callbackInput.event.payload.entry[0].changes[0].value.contacts).identity;
  const message={provider:'meta',connectionId,messageId:callbackInput.event.providerEventId,chatId:phone,senderId:phone,senderPhone:`+${phone}`,fromMe:false,timestamp:new Date().toISOString(),input:{type:'text',text:'Synthetic callback lock'},metaIdentity:identity};
  let callbacks=0;
  const context={assignmentId,assignmentZammadGroup:'Operations',connectionName:'Fixture',zammadGroup:'Operations',zammadBaseUrl:'https://native.invalid',zammadSecretReference:`secret://${tenantId}/native`,connectionSecretReference:secretReference,providerSessionId:phoneNumberId,mediaEnabled:false,retentionDays:30};
  const processed=await inbound.processDirectMessage(callbackInput.event,context,message,{id:98231,login:`${prefix}@example.invalid`},{
   create:async()=>{throw new Error('Existing HUMAN fixture must append')},
   append:async id=>{assert.equal(id,ticketId);callbacks++;await inbound.assertMetaDirectIdentityCurrent(callbackInput.event,callbackInput.leaseId,phone,appId);return '98232'}
  });
  const windowAt=async now=>tx(async c=>(await c.query(
    'SELECT app.meta_customer_window_open($1,$2,$3) AS open',[connectionId,phone,now])).rows[0].open);
  const deadline=Date.parse(message.timestamp)+24*60*60*1000;
  assert.equal(await windowAt(new Date(deadline-1)),true);
  assert.equal(await windowAt(new Date(deadline)),false);
  assert.equal(await windowAt(new Date(deadline+1)),false);
  assert.equal(await tx(async c=>(await c.query(
    "SELECT app.meta_customer_window_open($1,'15558880999',$2) AS open",[connectionId,new Date(deadline)])).rows[0].open),null);
  assert.equal(callbacks,1);assert.equal(processed.state,'HUMAN');assert.equal(processed.queued,false);
  assert.equal((await admin.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[callbackInput.event.id])).rows[0].meta_direct_native_anchor,null,'Later unrelated ordinary turns cannot replace immutable original alias provenance');
  assert.equal((await admin.query('SELECT id FROM normalized_messages WHERE event_inbox_id=$1',[callbackInput.event.id])).rowCount,1,'Independent guard is compatible with actual outer normalized FK KEY SHARE');
  // Existing currentness uses connection→session→inbox locks. Each writer remains serialized.
  for(const [table,id] of [['connections',connectionId],['provider_sessions',sessionId],['event_inbox',callbackInput.event.id]]){
   const blocker=await pool.connect();let pending;
   try{await blocker.query('BEGIN');await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await blocker.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE`,[tenantId,id]);
    const change=table==='event_inbox'?"lease_expires_at=clock_timestamp()-interval '1 second'":"state='PAUSED'";
    await blocker.query(`UPDATE ${table} SET ${change} WHERE tenant_id=$1 AND id=$2`,[tenantId,id]);
    let settled=false;pending=inbound.assertMetaDirectIdentityCurrent(callbackInput.event,callbackInput.leaseId,phone,appId).then(()=>{settled=true;throw new Error('Stale guard unexpectedly passed')},error=>{settled=true;return error});
    let observedWaiting=false;
    for(let attempt=0;attempt<50&&!observedWaiting;attempt++){
     observedWaiting=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",[applicationName,`%FROM ${table}%FOR NO KEY UPDATE%`])).rowCount>0;
     if(!observedWaiting)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(observedWaiting,true,`${table} currentness query actually waits for the held writer lock`);
    assert.equal(settled,false,`${table} writer must retain serialization`);
    await blocker.query('COMMIT');assert.match((await pending).message,/Meta direct identity/i);
   }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending}
   await withFixtureTenant(admin,tenantId,()=>admin.query(`UPDATE ${table} SET ${table==='event_inbox'?"lease_expires_at=clock_timestamp()+interval '10 minutes'":"state='WORKING'"} WHERE id=$1`,[id]));
  }
  await admin.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[callbackInput.event.id]);
  const deliveries=[];
  for(const origin of ['BOT','HUMAN'])for(const writer of ['reply','control']){
   const id=randomUUID();await tx(c=>c.query(`INSERT INTO delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id,meta_routing_source_event_id)
    VALUES($1,$2,$3,$4,$5,$6,'Synthetic direct reply','text/plain',$7,'SENT',$8,$9,$10)`,[id,tenantId,connectionId,conversationId,phone,ticketId,`${prefix}-${origin}-${writer}`,origin,origin==='HUMAN'?(writer==='reply'?'98233':'98234'):null,origin==='BOT'?callbackInput.event.id:null]));deliveries.push(id);
  }
  const snapshots=(await admin.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=ANY($1::uuid[])',[deliveries])).rows;
  assert.equal(snapshots.length,4);for(const row of snapshots){assert.deepEqual(row.meta_direct_recipient.recipient,{kind:'BSUID',value:bsuid});assert.equal(row.meta_direct_recipient.aliasId,bsuidAlias);assert.deepEqual(row.meta_direct_recipient.asset,asset)}
  await verifyMetaTestPhoneSnapshots({tx,pool,tenantId,connectionId,sessionId,appId,phoneNumberId,wabaId,phone,bsuid,
    phoneAlias,bsuidAlias,conversationId,ticketId,sourceEventId:callbackInput.event.id,originalDeliveryId:deliveries[0]});
  await assert.rejects(()=>admin.query("UPDATE delivery_outbox SET meta_direct_recipient=jsonb_set(meta_direct_recipient,'{recipient,value}',to_jsonb('SA.forged'::text)) WHERE id=$1",[deliveries[0]]),/immutable/);
  await assert.rejects(()=>tx(async c=>{
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE tenant_id=$1 AND id=$2",[tenantId,phoneAlias]);
   await c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_ticket_id,zammad_article_id)
    VALUES($1,$2,$3,$4,'Never falls back','text/plain',$5,'QUEUED','HUMAN',$6,'98235')`,[tenantId,connectionId,conversationId,phone,`${prefix}-held-alias`,ticketId]);
  }),/reconciliation|held/,'One held alias prevents fallback to the other active alias');
  await tx(async c=>{
   await c.query('SAVEPOINT legacy_scope');const legacyConversation=randomUUID();
   await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,last_activity_at,normalized_reference,zammad_ticket_id)
    VALUES($1,$2,$3,$4,$5,'200','HUMAN','done',clock_timestamp(),$6,$7)`,[legacyConversation,tenantId,assignmentId,connectionId,versionId,reference('200'),ticketId]);
   await assert.rejects(()=>c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_ticket_id,meta_routing_source_event_id)
    VALUES($1,$2,$3,'200','Unobserved new peer','text/plain',$4,'QUEUED','BOT',$5,$6) RETURNING meta_direct_recipient`,[tenantId,connectionId,legacyConversation,`${prefix}-legacy`,ticketId,callbackInput.event.id]),/routing effect held/);
   // This is a new post-migration peer. Original manual compatibility is proved
   // separately against a generation seeded before the real migration runner.
   await c.query('ROLLBACK TO SAVEPOINT legacy_scope');
  });
  const receiptId=randomUUID();await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO delivery_receipts(id,tenant_id,delivery_id,connection_id,event_inbox_id,provider,external_message_id,receipt_key_sha256,receipt_scope,receipt_status,provider_status,provider_timestamp,applied_state)
   VALUES($1,$2,$3,$4,$7,'META',$5,$6,'MESSAGE','SENT','SENT',clock_timestamp(),'SENT')`,[receiptId,tenantId,deliveries[0],connectionId,`${prefix}-sent`,hash(`${prefix}-receipt`),callbackInput.event.id]));
  const receiptBefore=(await admin.query('SELECT * FROM delivery_receipts WHERE id=$1',[receiptId])).rows[0];
  const groupId=randomUUID();await admin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Fixture group')",[groupId,tenantId,connectionId,`${prefix}@g.us`]);
  const rosterId='12025550167@c.us';
  await admin.query("INSERT INTO group_workspace_participants(tenant_id,whatsapp_group_id,external_participant_id,display_name) VALUES($1,$2,$3,'Raw group fixture')",[tenantId,groupId,rosterId]);
  const otherPhone='15558880199';
  const readMarketingPreferences=async c=>(await c.query(`SELECT id,subject_kind,subject,opted_out,observed_at
   FROM whatsapp_marketing_preferences WHERE tenant_id=$1 ORDER BY id`,[tenantId])).rows;
  const marketingPreferences=await tx(async c=>{
   for(const [number,alias] of [[phone,bsuid],[otherPhone,null]]){
    await c.query("SELECT app.record_whatsapp_marketing_preference($1,$2,true,$3,'PREFERENCE_WEBHOOK',$4,$5)",
     [number,alias,'2026-01-01T00:00:00Z',connectionId,randomUUID()]);
   }
   return readMarketingPreferences(c);
  });
  assert.deepEqual(marketingPreferences.map(row=>[row.subject_kind,row.subject,row.opted_out]).sort(),
   [['BSUID',bsuid,true],['PHONE',phone,true],['PHONE',otherPhone,true]]);
  const contactPreferences=marketingPreferences.filter(row=>row.subject!==otherPhone);
  const unrelatedPreferences=marketingPreferences.filter(row=>row.subject===otherPhone);
  for(const [scope,value] of [['TENANT',tenantId],['PARTICIPANT',phone],['PARTICIPANT',bsuid],['ZAMMAD_TICKET',ticketId],['ZAMMAD_USER','98231']]){
   const job=await createJob(scope,value);const exported=await privacy.exportData(job,job.leaseId);
   assert.equal(exported.metaDirectRecipients.length,scope==='TENANT'?5:4,`${scope} export includes exactly its snapshot and receipt history`);
   assert.equal(exported.metaDirectRecipients.some(row=>row.delivery_id===routingHistory.legacyDelivery),scope==='TENANT','Only whole-tenant export includes separate original legacy history');
   assert.equal(exported.metaDirectRecipients.find(row=>row.receipt_id===receiptId).receipt_status,'SENT');
   assert.equal(exported.metaDirectAliases.length,2);
   if(scope==='TENANT')assert.deepEqual(exported.whatsappMarketingPreferences,marketingPreferences);
   if(scope==='PARTICIPANT'){
    assert.equal(exported.groupWorkspaceParticipants.length,0,'Groups roster uses exact ID, not DIRECT alias closure');
    assert.deepEqual(exported.whatsappMarketingPreferences,contactPreferences,'Both participant identifiers export the same two opt-outs');
   }
   await finishExport(job);
  }
  const rosterExport=await createJob('PARTICIPANT',rosterId);const rosterResult=await privacy.exportData(rosterExport,rosterExport.leaseId);
  assert.equal(rosterResult.groupWorkspaceParticipants.length,1);assert.equal(rosterResult.metaDirectRecipients.length,0);await finishExport(rosterExport);
  // Empty current retention scope still crosses the same guarded LOCAL boundary;
  // DELETE below proves the nonempty alias/snapshot redaction authority.
  const retention=await createJob('TENANT',tenantId,'RETENTION_SWEEP');
  await privacy.discover(retention,retention.leaseId);retention.stage='EXTERNAL';
  await privacy.finalize(retention,retention.leaseId);
  assert.equal((await admin.query('SELECT state,stage FROM privacy_jobs WHERE id=$1',[retention.id])).rows[0].state,'SUCCEEDED');
  // Actual queue adapters/core/native API admission with synthetic native claims;
  // no provider/native HTTP. Roll back each owned scenario and never rewrite receipts.
  const conversationBefore=(await admin.query('SELECT state,current_node_id,flow_version_id,fencing_token,human_ownership_epoch,customer_control FROM bot_conversations WHERE id=$1',[conversationId])).rows[0];
  const aliasesBefore=(await admin.query('SELECT id,state,revision FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 ORDER BY id',[participantId])).rows;
  const normalizedSource=await admin.query(`INSERT INTO normalized_messages
   (tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata)
   VALUES($1,$2,$3,$4,$5,$5,'Synthetic joint identity mapping',clock_timestamp(),$6) RETURNING id`,
   [tenantId,input.event.id,connectionId,input.event.providerEventId,phone,{direct:true,zammad_customer_id:98231}]);
  assert.equal(normalizedSource.rowCount,1);
  await tx(async c=>{
   const repository=new PrivacyRepository({});
   repository.tenant=(scope,work)=>{assert.equal(scope,tenantId);return work(c)};
   for(const [scope,value,label] of [['PARTICIPANT',phone,'participant phone'],['PARTICIPANT',bsuid,'participant BSUID'],['ZAMMAD_USER','98231','Zammad user']]){
    await c.query('SAVEPOINT marketing_preference_delete');
    try{
     const job=await createJob(scope,value,'DELETE',c);
     await repository.discover(job,job.leaseId);
     job.stage='EXTERNAL';
     await c.query(`UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE'
      WHERE job_id=$1 AND target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')`,[job.id]);
     await repository.finalize(job,job.leaseId);
     assert.deepEqual(await readMarketingPreferences(c),unrelatedPreferences,`${label} deletion removes both linked opt-outs only`);
    }finally{
     await c.query('ROLLBACK TO SAVEPOINT marketing_preference_delete');
     await c.query('RELEASE SAVEPOINT marketing_preference_delete');
    }
   }
  });
  // Independent invoker boundary: temp evidence must never seal invented native-customer authority.
  // A fresh worker backend ensures the trigger/validator is first planned with shadows present.
  const capsuleShadow=new Client({...workerConfig,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await capsuleShadow.connect();
  try {
   await capsuleShadow.query('BEGIN');await capsuleShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   await capsuleShadow.query("UPDATE public.event_inbox SET status='PROCESSING',lease_id=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[input.event.id,input.leaseId]);
   await capsuleShadow.query(`INSERT INTO public.message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
    VALUES($1,$2,$3,$4,'98236','INBOUND') ON CONFLICT DO NOTHING`,[tenantId,connectionId,input.event.providerEventId,ticketId]);
   await capsuleShadow.query('CREATE TEMP TABLE normalized_messages AS SELECT * FROM public.normalized_messages WHERE event_inbox_id=$1',[input.event.id]);
   await capsuleShadow.query('CREATE TEMP TABLE message_links AS SELECT * FROM public.message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.event.providerEventId]);
   await capsuleShadow.query('CREATE TEMP TABLE bot_conversations AS SELECT * FROM public.bot_conversations WHERE id=$1',[conversationId]);
   await capsuleShadow.query(`UPDATE pg_temp.normalized_messages SET provider_metadata=jsonb_set(provider_metadata,'{zammad_customer_id}',to_jsonb('98288'::text));
    UPDATE pg_temp.bot_conversations SET zammad_customer_id=98288`);
   await capsuleShadow.query('SAVEPOINT forged_anchor');
   await assert.rejects(capsuleShadow.query('UPDATE public.event_inbox SET meta_direct_native_anchor=$2 WHERE id=$1',
    [input.event.id,{schemaVersion:1,participantId,nativeCustomerId:'98288',payloadSha256:input.payloadHash}]),error=>error.code==='23514');
   await capsuleShadow.query('ROLLBACK TO SAVEPOINT forged_anchor');
   assert.equal((await capsuleShadow.query('SELECT meta_direct_native_anchor FROM public.event_inbox WHERE id=$1',[input.event.id])).rows[0].meta_direct_native_anchor,null);
   // Correct ordinary completion stays usable with contradictory temp evidence still present.
   assert.equal((await capsuleShadow.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[input.event.id])).rows[0].sealed,true);
   assert.deepEqual((await capsuleShadow.query('SELECT meta_direct_native_anchor FROM public.event_inbox WHERE id=$1',[input.event.id])).rows[0].meta_direct_native_anchor,
    {schemaVersion:1,participantId,nativeCustomerId:'98231',payloadSha256:input.payloadHash});
   await capsuleShadow.query('CREATE TEMP TABLE event_inbox AS SELECT * FROM public.event_inbox WHERE id=$1',[input.event.id]);
   await capsuleShadow.query("UPDATE pg_temp.event_inbox SET meta_direct_native_anchor=jsonb_set(meta_direct_native_anchor,'{nativeCustomerId}',to_jsonb('98288'::text))");
   await capsuleShadow.query('CREATE TEMP TABLE meta_direct_identity_aliases AS SELECT * FROM public.meta_direct_identity_aliases WHERE participant_identity_id=$1',[participantId]);
   await capsuleShadow.query("UPDATE pg_temp.meta_direct_identity_aliases SET value='SA.forged' WHERE kind='BSUID'");
   await capsuleShadow.query('CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WHERE false');
   await capsuleShadow.query('CREATE TEMP TABLE privacy_job_targets AS SELECT * FROM public.privacy_job_targets WHERE false');
   const forgedPrivacyJob=randomUUID();
   await capsuleShadow.query(`INSERT INTO pg_temp.privacy_jobs(id,tenant_id,job_type,stage,state,lease_id,lease_expires_at)
    VALUES($1,$2,'DELETE','LOCAL','RUNNING',$3,clock_timestamp()+interval '10 minutes')`,[forgedPrivacyJob,tenantId,randomUUID()]);
   await capsuleShadow.query(`INSERT INTO pg_temp.privacy_job_targets(tenant_id,job_id,target_type,target_id,state)
    VALUES($1,$2,'META_DIRECT_IDENTITY_EVENT',$3,'PENDING')`,[tenantId,forgedPrivacyJob,input.event.id]);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98288'])).rows[0].valid,false);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98231'])).rows[0].valid,true);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[bsuidAlias,phone,'98288'])).rows[0].valid,false);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[bsuidAlias,phone,'98231'])).rows[0].valid,true);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_participant_matches($1,$2,$3) valid',[connectionId,phone,'SA.forged'])).rows[0].valid,false);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_participant_matches($1,$2,$3) valid',[connectionId,phone,bsuid])).rows[0].valid,true);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_event_matches_scope($1,$2) valid',[input.event.id,'SA.forged'])).rows[0].valid,false);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_event_matches_scope($1,$2) valid',[input.event.id,bsuid])).rows[0].valid,true);
   assert.equal((await capsuleShadow.query("SELECT app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',$1) valid",[input.event.id])).rows[0].valid,false);
   assert.equal((await capsuleShadow.query('SELECT app.meta_direct_anchor_needed($1) needed',[input.event.id])).rows[0].needed,true);
   const lookupFunctions=['meta_direct_anchor_needed','guard_meta_direct_native_anchor','seal_meta_direct_native_anchor','meta_direct_native_anchor_valid',
    'meta_direct_alias_source_valid','meta_direct_event_matches_scope','meta_direct_participant_matches','meta_direct_privacy_target_authorized',
    'preserve_meta_direct_asset','meta_direct_identity_guard','guard_meta_direct_alias','snapshot_meta_direct_recipient',
    'has_applicable_privacy_hold','delivery_has_active_privacy_target'];
   const functions=(await capsuleShadow.query(`SELECT p.proname,p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY($1::text[])`,[lookupFunctions])).rows;
   assert.equal(functions.length,lookupFunctions.length);
   for(const fn of functions){assert.equal(fn.prosecdef,false,fn.proname);assert(fn.proconfig.includes('search_path=pg_catalog, public, app, pg_temp'),fn.proname);}
   assert.deepEqual((await capsuleShadow.query("SELECT has_schema_privilege(current_user,'public','CREATE') public_create,has_schema_privilege(current_user,'app','CREATE') app_create")).rows[0],{public_create:false,app_create:false});
  } finally {await capsuleShadow.query('ROLLBACK');await capsuleShadow.end();}

  // Six inherited invoker readers: plan on fresh actual-role backends with shadows already present.
  // All real writes/oracles are public-qualified; each scenario rolls back without provider work.
  const sourceShadow=new Client({connectionString:appUrl,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await sourceShadow.connect();
  try {
   await sourceShadow.query('BEGIN');await sourceShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   const fakeSession=randomUUID(),sourceId=randomUUID(),sourceLease=randomUUID(),sourceParticipant=randomUUID();
   const sourcePhone='201',sourceBsuid='SA.'+hash(randomUUID()),fakeBsuid='SA.'+hash(randomUUID());
   const sourceMessage=ordinary(`${prefix}-shadow-source`,sourcePhone);
   const sourcePayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneNumberId},messages:[sourceMessage],contacts:[{wa_id:sourcePhone,user_id:sourceBsuid}]}}]}]};
   const sourceHash=hash(sourcePayload);
   await sourceShadow.query('CREATE TEMP TABLE provider_sessions AS SELECT * FROM public.provider_sessions WHERE id=$1',[sessionId]);
   await sourceShadow.query('UPDATE pg_temp.provider_sessions SET id=$1',[fakeSession]);
   const insertSource=(id,pin)=>sourceShadow.query(`INSERT INTO public.event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,attempts,lease_id,lease_expires_at,meta_direct_asset)
    VALUES($1,$2,$3,'META',$4,'messages',$5,$6,'PROCESSING',1,$7,clock_timestamp()+interval '10 minutes',$8)`,
    [id,tenantId,connectionId,sourceMessage.id,sourcePayload,sourceHash,sourceLease,pin]);
   await sourceShadow.query('SAVEPOINT fake_session');
   await assert.rejects(insertSource(randomUUID(),{...asset,providerSessionId:fakeSession}),error=>error.code==='23514'&&/signed source session/.test(error.message));
   await sourceShadow.query('ROLLBACK TO SAVEPOINT fake_session');
   // The genuine public session succeeds even though the only temp session has a different ID.
   await insertSource(sourceId,asset);
   assert.deepEqual((await sourceShadow.query('SELECT meta_direct_asset FROM public.event_inbox WHERE id=$1',[sourceId])).rows[0].meta_direct_asset,asset);
   await sourceShadow.query(`INSERT INTO public.participant_identities(id,tenant_id,connection_id,external_participant_id,normalized_phone)
    VALUES($1,$2,$3,$4,$5)`,[sourceParticipant,tenantId,connectionId,sourcePhone,'+'+sourcePhone]);
   await sourceShadow.query('UPDATE pg_temp.provider_sessions SET id=$1',[sessionId]);
   await sourceShadow.query('CREATE TEMP TABLE event_inbox AS SELECT * FROM public.event_inbox WHERE id=$1',[sourceId]);
   const fakePayload=structuredClone(sourcePayload);fakePayload.entry[0].changes[0].value.contacts[0].user_id=fakeBsuid;
   await sourceShadow.query('UPDATE pg_temp.event_inbox SET payload=$1,payload_sha256=$2',[fakePayload,hash(fakePayload)]);
   await sourceShadow.query('CREATE TEMP TABLE participant_identities AS SELECT * FROM public.participant_identities WHERE id=$1',[sourceParticipant]);
   await sourceShadow.query('CREATE TEMP TABLE meta_direct_identity_aliases AS SELECT * FROM public.meta_direct_identity_aliases WHERE false');
   const sourceAlias=(value,digest)=>sourceShadow.query(`INSERT INTO public.meta_direct_identity_aliases
    (tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id,source_payload_sha256)
    VALUES($1,$2,$3,$4,$5,$6,'BSUID',$7,$8,$9) RETURNING id,value,source_event_id,source_payload_sha256`,
    [tenantId,connectionId,sourceParticipant,sessionId,phoneNumberId,wabaId,value,sourceId,digest]);
   await sourceShadow.query('SAVEPOINT fake_alias');
   await assert.rejects(sourceAlias(fakeBsuid,hash(fakePayload)),error=>error.code==='23514'&&/source asset/.test(error.message));
   await sourceShadow.query('ROLLBACK TO SAVEPOINT fake_alias');
   assert.equal((await sourceShadow.query('SELECT id FROM public.meta_direct_identity_aliases WHERE participant_identity_id=$1',[sourceParticipant])).rowCount,0);
   await sourceShadow.query("UPDATE pg_temp.participant_identities SET external_participant_id='999'");
   const realAlias=(await sourceAlias(sourceBsuid,sourceHash)).rows[0];
   assert.equal(realAlias.value,sourceBsuid);assert.equal(realAlias.source_event_id,sourceId);assert.equal(realAlias.source_payload_sha256,sourceHash);
   // A genuine signed change stays held even when temp source/alias/participant inventories hide it.
   const changeId=randomUUID(),changeMessage={id:`${prefix}-shadow-change`,type:'system',system:{type:'user_changed_user_id',previous_user_id:bsuid,user_id:fakeBsuid}};
   const changePayload={object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneNumberId},messages:[changeMessage]}}]}]};
   const changeHash=hash(changePayload),changeMarker=metaDirectIdentityChangeEvidence(changePayload,changeHash);
   assert.equal(changeMarker.scope,'ALIASES');
   await sourceShadow.query(`INSERT INTO public.event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_direct_asset,meta_direct_identity_change)
    VALUES($1,$2,$3,'META',$4,'messages',$5,$6,'ACCEPTED',$7,$8)`,[changeId,tenantId,connectionId,changeMessage.id,changePayload,changeHash,asset,changeMarker]);
   assert.equal((await sourceShadow.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,false);
   await sourceShadow.query('SAVEPOINT signed_change_delivery');
   await assert.rejects(sourceShadow.query(`INSERT INTO public.delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,meta_routing_source_event_id)
    VALUES($1,$2,$3,$4,$5,'No hidden change dispatch','text/plain',$6,'QUEUED','BOT',$7)`,[tenantId,connectionId,conversationId,phone,ticketId,`${prefix}-shadow-signed-change`,callbackInput.event.id]),error=>error.code==='55000');
   await sourceShadow.query('ROLLBACK TO SAVEPOINT signed_change_delivery');
  } finally {await sourceShadow.query('ROLLBACK');await sourceShadow.end();}

  const recipientShadow=new Client({...workerConfig,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await recipientShadow.connect();
  try {
   await recipientShadow.query('BEGIN');await recipientShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   await recipientShadow.query('CREATE TEMP TABLE meta_direct_identity_aliases AS SELECT * FROM public.meta_direct_identity_aliases WHERE false');
   await recipientShadow.query('CREATE TEMP TABLE event_inbox AS SELECT * FROM public.event_inbox WHERE false');
   const insertDelivery=key=>recipientShadow.query(`INSERT INTO public.delivery_outbox
    (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,meta_routing_source_event_id)
    VALUES($1,$2,$3,$4,$5,'Public recipient only','text/plain',$6,'QUEUED','BOT',$7) RETURNING id,meta_direct_recipient,meta_routing_source_event_id`,[tenantId,connectionId,conversationId,phone,ticketId,key,callbackInput.event.id]);
   await recipientShadow.query('SAVEPOINT real_held_alias');
   await recipientShadow.query("UPDATE public.meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[bsuidAlias]);
   assert.equal((await recipientShadow.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,false);
   await recipientShadow.query('SAVEPOINT held_delivery');
   await assert.rejects(insertDelivery(`${prefix}-shadow-held`),error=>error.code==='55000');
   await recipientShadow.query('ROLLBACK TO SAVEPOINT held_delivery');
   await recipientShadow.query('ROLLBACK TO SAVEPOINT real_held_alias');
   // No illegal HELD→ACTIVE rewrite: rollback restores the real authoritative row.
   await recipientShadow.query('INSERT INTO pg_temp.meta_direct_identity_aliases SELECT * FROM public.meta_direct_identity_aliases WHERE participant_identity_id=$1',[participantId]);
   await recipientShadow.query("UPDATE pg_temp.meta_direct_identity_aliases SET value='SA.'||repeat('z',128) WHERE kind='BSUID'");
   assert.equal((await recipientShadow.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,true);
   const delivered=(await insertDelivery(`${prefix}-shadow-current`)).rows[0];
   assert.equal(delivered.meta_routing_source_event_id,callbackInput.event.id,'The real original ordinary event remains bound through empty temp source inventory');
   assert.deepEqual(delivered.meta_direct_recipient,{schemaVersion:1,claim:'ALIAS_VERIFIED',recipient:{kind:'BSUID',value:bsuid},asset,participantId,aliasId:bsuidAlias,aliasRevision:1});
   assert.deepEqual((await recipientShadow.query('SELECT meta_direct_recipient FROM public.delivery_outbox WHERE id=$1',[delivered.id])).rows[0].meta_direct_recipient,delivered.meta_direct_recipient);
  } finally {await recipientShadow.query('ROLLBACK');await recipientShadow.end();}

  const privacyShadow=new Client({...workerConfig,options:'-c statement_timeout=5000 -c lock_timeout=3000'});await privacyShadow.connect();
  const shadowHold=randomUUID();let shadowHoldCreated=false;
  try {
   await admin.query(`INSERT INTO public.privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
    VALUES($1,$2,'PARTICIPANT',$3,$4,'Synthetic inherited lookup boundary',$5)`,[shadowHold,tenantId,phone,hash(phone),userId]);shadowHoldCreated=true;
   await privacyShadow.query('BEGIN');await privacyShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   await privacyShadow.query('CREATE TEMP TABLE privacy_legal_holds AS SELECT * FROM public.privacy_legal_holds WHERE false');
   assert.equal((await privacyShadow.query("SELECT app.has_applicable_privacy_hold('PARTICIPANT',$1) held",[phone])).rows[0].held,true,'Empty temp evidence cannot hide an active real legal hold');
   await privacyShadow.query('CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WHERE false');
   await privacyShadow.query('CREATE TEMP TABLE privacy_job_targets AS SELECT * FROM public.privacy_job_targets WHERE false');
   await privacyShadow.query('CREATE TEMP TABLE delivery_outbox AS SELECT * FROM public.delivery_outbox WHERE id=$1',[deliveries[0]]);
   const fakeJob=randomUUID();
   await privacyShadow.query(`INSERT INTO pg_temp.privacy_jobs(id,tenant_id,job_type,state,stage,scope_type,scope_value)
    VALUES($1,$2::uuid,'RETENTION_SWEEP','RUNNING','DISCOVER','TENANT',$2::uuid::text)`,[fakeJob,tenantId]);
   await privacyShadow.query(`INSERT INTO pg_temp.privacy_job_targets(tenant_id,job_id,target_type,target_id,state)
    VALUES($1,$2,'DELIVERY',$3,'PENDING')`,[tenantId,fakeJob,deliveries[0]]);
   assert.equal((await privacyShadow.query('SELECT app.delivery_has_active_privacy_target($1) held',[deliveries[0]])).rows[0].held,false,'A temp job/target cannot fence an unprotected real delivery');
   const realJob=randomUUID();
   await privacyShadow.query(`INSERT INTO public.privacy_jobs
    (id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot)
    VALUES($1,$2::uuid,'RETENTION_SWEEP','TENANT',$2::uuid::text,'RETENTION_DELETE',$3,'RUNNING','DISCOVER',1,$4,clock_timestamp()+interval '10 minutes',1,24)`,
    [realJob,tenantId,`${prefix}-shadow-privacy-${realJob}`,randomUUID()]);
   await privacyShadow.query(`INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,state)
    VALUES($1,$2,'DELIVERY',$3,$4,'PENDING')`,[tenantId,realJob,deliveries[0],hash(deliveries[0])]);
   assert.equal((await privacyShadow.query('SELECT app.delivery_has_active_privacy_target($1) held',[deliveries[0]])).rows[0].held,true,'The genuine public target wins over contradictory temp job inventory');
  } finally {
   await privacyShadow.query('ROLLBACK');await privacyShadow.end();
   if(shadowHoldCreated)await admin.query("UPDATE public.privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[shadowHold,userId]);
  }

  await admin.query("UPDATE normalized_messages SET processing_status='COMPLETE' WHERE id=$1",[normalizedSource.rows[0].id]);
  await admin.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
   VALUES($1,$2,$3,$4,'98236','INBOUND') ON CONFLICT DO NOTHING`,[tenantId,connectionId,input.event.providerEventId,ticketId]);
  const confirm=await add(ordinary(`${prefix}-effect-confirm`),[{wa_id:phone,user_id:bsuid}]);
  await admin.query(`INSERT INTO normalized_messages
   (tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata)
   VALUES($1,$2,$3,$4,$5,$5,'Synthetic bound confirmation',clock_timestamp(),$6)`,
   [tenantId,confirm.event.id,connectionId,confirm.event.providerEventId,phone,{direct:true,zammad_customer_id:98231}]);
  await admin.query(`UPDATE event_inbox SET status='PROCESSED',payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),
   lease_id=NULL,lease_expires_at=NULL WHERE id=$1`,[confirm.event.id]);
  const instanceId=randomUUID(),actionId=randomUUID(),actionRevisionId=randomUUID();
  await admin.query(`INSERT INTO zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
   VALUES($1,$2,'https://native.invalid','6.5.0','WORKING','fixture://db',$3,$3,$4,$5)`,[instanceId,tenantId,prefix,`secret://tenants/${tenantId}/zammad/service`,`secret://tenants/${tenantId}/zammad/privacy`]);
  await admin.query('BEGIN');
  try{
   await admin.query(`INSERT INTO bot_action_definitions(id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,headers,response_mapping,active_revision_id,created_by,updated_by)
    VALUES($1,$2,'p03.identity','Synthetic identity action','HTTP_JSON','https://action.invalid/api','POST','NONE','{}','{}',$3,$4,$4)`,[actionId,tenantId,actionRevisionId,userId]);
   await admin.query(`INSERT INTO bot_action_revisions(id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
    VALUES($1,$2,$3,1,'Synthetic identity action','HTTP_JSON','https://action.invalid/api','POST','NONE','{}','{}',5000,262144,'ACTIVE',$4,$5)`,[actionRevisionId,tenantId,actionId,'d'.repeat(64),userId]);
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error}
  // New draft version is only a synthetic queue fixture, never activated or assigned.
  const effectVersion=randomUUID(),effectDefinition={schemaVersion:1,name:prefix+' effect',start:'lookup',maxSteps:4,
   keepOpenPolicy:{humanReplyPauseMinutes:120,mainMenu:true,customerResolution:true},nodes:[
    {id:'lookup',type:'action',actionId:'p03.identity',input:{},onSuccess:'handoff',onFailure:'done'},
    {id:'handoff',type:'handoff',target:'FIXED',zammadGroupId:'2',priority:'2 normal'},
    {id:'done',type:'end'}]};
  await admin.query(`INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by)
   VALUES($1,$2,$3,2,'DRAFT',$4,$5,$6)`,[effectVersion,tenantId,familyId,effectDefinition,hash(effectDefinition),userId]);
  const queueScenario=async(work,usingPool=pool)=>tx(async c=>{
   await c.query('SAVEPOINT queue_effect_fixture');
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   try{return await work(c,repository)}finally{await c.query('ROLLBACK TO SAVEPOINT queue_effect_fixture')}
  },tenantId,usingPool);
  const deny=error=>error.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED'&&error.outcomeKnown===true;
  const routingFixtureSources=[];
  const currentPrimary=async(c,participant,currentAlias,preparedSource)=>{
   // Independent, signed ordinary source through the real reducer. Identity
   // transition/retention never manufactures external conversation ownership.
   const source=preparedSource??await add(ordinary(`${prefix}-current-routing-${randomUUID()}`,currentAlias),undefined,{bindRouting:false});
   routingFixtureSources.push(source.event.id);
   await bindMetaPrimaryRouting(c,source.event,asset,participant,appId);
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[source.event.id]);
   return source;
  };
  await tx(c=>assertMetaDirectEffectCurrent(c,{tenantId,conversationId,connectionId,ticketId,sourceEventIds:[callbackInput.event.id],appId}));
  // Test-scope authority comes from this conversation's actual signed turn,
  // independently of the earlier alias-source event and provider receipt data.
  const testScope=new Set([phone+'@c.us']),foreignScope=new Set(['12025550168@c.us']);
  const linkInput={tenantId,connectionId,deliveryId:deliveries[0],appId,scope:testScope};
  await queueScenario(async(c,repository)=>{
   const sourceLease=randomUUID(),deliveryId=randomUUID(),deliveryLease=randomUUID();
   await c.query("UPDATE public.event_inbox SET status='PROCESSING',lease_id=$1,lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=$2",[sourceLease,callbackInput.event.id]);
   assert.equal(await resolveMetaTestRecipientLink(c,linkInput),undefined,'PROCESSING never grants send authority');
   assert.deepEqual(await metaTestRecipientAdmission(c,linkInput),{state:'PENDING'});
   assert.deepEqual(await metaTestRecipientAdmission(c,{...linkInput,scope:foreignScope}),{state:'DENIED'});
   await c.query(`INSERT INTO public.delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
    message_body,content_type,idempotency_key,state,direct_origin,meta_routing_source_event_id,attempts)
    VALUES($1,$2,$3,$4,$5,$6,'Synthetic waiting welcome','text/plain',$7,'QUEUED','BOT',$8,1)`,
    [deliveryId,tenantId,connectionId,conversationId,phone,ticketId,prefix+'-processing-welcome',callbackInput.event.id]);
   await c.query("INSERT INTO public.delivery_attempts(tenant_id,delivery_id,attempt_number,state,safe_error,finished_at) VALUES($1,$2,1,'FAILED_RETRYABLE','Synthetic prior pre-dispatch failure',now())",[tenantId,deliveryId]);
   const history=(await c.query('SELECT to_jsonb(attempt) AS row FROM public.delivery_attempts attempt WHERE delivery_id=$1',[deliveryId])).rows[0].row;
   const claimed=(await c.query('SELECT id,attempts FROM app.claim_delivery_jobs($1,100)',[deliveryLease])).rows.find(row=>row.id===deliveryId);
   assert(claimed,'The ordinary claim can race inbound completion');assert.equal(claimed.attempts,2);
   // Same CLAIMED bookkeeping inserted by OutboxRepository.claimDeliveries.
   await c.query("INSERT INTO public.delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES($1,$2,$3,'CLAIMED')",[tenantId,deliveryId,claimed.attempts]);
   assert.equal((await c.query('SELECT 1 FROM public.delivery_attempts WHERE delivery_id=$1',[deliveryId])).rowCount,2);
   await repository.deferMetaTestRecipient({id:deliveryId,tenantId,attempts:claimed.attempts},deliveryLease);
   const deferred=(await c.query('SELECT state,attempts,lease_id,lease_expires_at,available_at>now() AS deferred FROM public.delivery_outbox WHERE id=$1',[deliveryId])).rows[0];
   assert.deepEqual(deferred,{state:'QUEUED',attempts:1,lease_id:null,lease_expires_at:null,deferred:true});
   assert.deepEqual((await c.query('SELECT to_jsonb(attempt) AS row FROM public.delivery_attempts attempt WHERE delivery_id=$1',[deliveryId])).rows,[{row:history}],'Only the unused CLAIMED attempt is deleted; completed history is unchanged');
   await c.query("UPDATE public.event_inbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[callbackInput.event.id]);
   assert.deepEqual(await metaTestRecipientAdmission(c,linkInput),{state:'DENIED'},'Expired processing cannot even defer');
   await c.query("UPDATE public.event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[callbackInput.event.id]);
   assert.equal((await metaTestRecipientAdmission(c,linkInput)).state,'READY');
  });
  for(const runtimePool of [pool,apiPool])await queueScenario(async c=>{
   const link=await resolveMetaTestRecipientLink(c,linkInput);
   assert(link,'Actual runtime role can resolve its signed conversation pair');
   assert.equal(link.conversationId,conversationId);assert.equal(link.participantId,participantId);
   assert.equal(link.phone,phone);assert.equal(link.bsuid,bsuid);
   assert.equal(link.bsuidAliasId,bsuidAlias);assert.equal(link.phoneAliasId,phoneAlias);
   assert.equal(link.sourceEventId,callbackInput.event.id);assert.equal(link.sourcePayloadSha256,callbackInput.payloadHash);
   assert.notEqual(link.sourceEventId,input.event.id,'Alias origin is not relabeled as conversation evidence');
   assert.equal(await resolveMetaTestRecipientLink(c,{...linkInput,scope:foreignScope}),undefined);
   const sentId=prefix+'-guarded-bsuid-receipt';
   await c.query('UPDATE public.delivery_outbox SET external_message_id=$1 WHERE id=$2',[sentId,deliveries[0]]);
   const status={id:sentId,recipient_user_id:bsuid,recipient_id:phone};
   const statusInput={...linkInput,status};
   assert.deepEqual(await resolveMetaTestStatusRecipientLink(c,statusInput),link);
   for(const changed of [{...status,id:sentId+'-unknown'},{...status,recipient_user_id:'SA.forged'},
    {...status,recipient_id:'12025550168'},{...status,recipient_parent_user_id:'SA.ENT.parent'},{...status,group_id:phone}])
    assert.equal(await resolveMetaTestStatusRecipientLink(c,{...statusInput,status:changed}),undefined);
   // Shadowing must not replace a genuine pair or forge an allowlisted phone.
   await c.query('CREATE TEMP TABLE meta_direct_identity_aliases AS SELECT * FROM public.meta_direct_identity_aliases WHERE participant_identity_id=$1',[participantId]);
   await c.query("UPDATE pg_temp.meta_direct_identity_aliases SET value='12025550168' WHERE kind='PHONE'");
   await c.query('CREATE TEMP TABLE bot_conversation_events AS SELECT * FROM public.bot_conversation_events WHERE false');
   await c.query('CREATE TEMP TABLE event_inbox AS SELECT * FROM public.event_inbox WHERE id=$1',[callbackInput.event.id]);
   const forged=structuredClone(callbackInput.event.payload);
   forged.entry[0].changes[0].value.messages[0].from='12025550168';
   forged.entry[0].changes[0].value.contacts[0].wa_id='12025550168';
   await c.query('UPDATE pg_temp.event_inbox SET payload=$1,payload_sha256=$2',[forged,hash(forged)]);
   assert.equal(await resolveMetaTestRecipientLink(c,{...linkInput,scope:foreignScope}),undefined);
   assert.deepEqual(await resolveMetaTestRecipientLink(c,linkInput),link);
  },runtimePool);
  for(const aliasId of [phoneAlias,bsuidAlias])await queueScenario(async c=>{
   await c.query("UPDATE public.meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[aliasId]);
   assert.equal(await resolveMetaTestRecipientLink(c,linkInput),undefined);
   const sentId=prefix+'-guarded-denied-'+randomUUID();
   await c.query('UPDATE public.delivery_outbox SET external_message_id=$1 WHERE id=$2',[sentId,deliveries[0]]);
   assert.equal(await resolveMetaTestStatusRecipientLink(c,{...linkInput,status:{id:sentId,recipient_user_id:bsuid,recipient_id:phone}}),undefined);
  });
  await queueScenario(async c=>{
   await c.query("UPDATE public.event_inbox SET status='QUARANTINED' WHERE id=$1",[callbackInput.event.id]);
   assert.equal(await resolveMetaTestRecipientLink(c,linkInput),undefined);
   const sentId=prefix+'-guarded-denied-'+randomUUID();
   await c.query('UPDATE public.delivery_outbox SET external_message_id=$1 WHERE id=$2',[sentId,deliveries[0]]);
   assert.equal(await resolveMetaTestStatusRecipientLink(c,{...linkInput,status:{id:sentId,recipient_user_id:bsuid,recipient_id:phone}}),undefined);
  });
  await queueScenario(async c=>{
   await c.query("UPDATE public.provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,credentialMetadata,appId}',to_jsonb('999999'::text)) WHERE id=$1",[sessionId]);
   assert.equal(await resolveMetaTestRecipientLink(c,linkInput),undefined);
   const sentId=prefix+'-guarded-denied-'+randomUUID();
   await c.query('UPDATE public.delivery_outbox SET external_message_id=$1 WHERE id=$2',[sentId,deliveries[0]]);
   assert.equal(await resolveMetaTestStatusRecipientLink(c,{...linkInput,status:{id:sentId,recipient_user_id:bsuid,recipient_id:phone}}),undefined);
  });
  await queueScenario(async c=>{
   const other=randomUUID(),delivery=randomUUID();
   await c.query(`INSERT INTO public.bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,
    normalized_reference,zammad_ticket_id,zammad_ticket_number,zammad_customer_id,last_activity_at,resolved_at,resolution_kind,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'RESOLVED','done',$7,$8,$8,98231,clock_timestamp(),clock_timestamp(),'FLOW',clock_timestamp()+interval '1 minute')`,
    [other,tenantId,assignmentId,connectionId,versionId,phone,reference(phone),ticketId]);
   await c.query(`INSERT INTO public.delivery_outbox(id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,
    message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id)
    VALUES($1,$2,$3,$4,$5,$6,'Synthetic unlinked conversation','text/plain',$7,'SENT','HUMAN','98239')`,
    [delivery,tenantId,connectionId,other,phone,ticketId,prefix+'-test-scope-other']);
   assert.equal(await resolveMetaTestRecipientLink(c,{...linkInput,deliveryId:delivery}),undefined,
    'Another conversation cannot borrow the same participant alias pair');
  });
  const foreignTenant=randomUUID();
  assert.equal(await tx(c=>resolveMetaTestRecipientLink(c,{...linkInput,tenantId:foreignTenant}),foreignTenant),undefined);

  await assert.rejects(()=>tx(c=>assertMetaDirectEffectCurrent(c,{tenantId,conversationId,connectionId,ticketId:'98299',appId})),deny);
  await queueScenario(async(c,repository)=>{
   const id=randomUUID(),lease=randomUUID();
   await c.query("UPDATE bot_conversations SET state='ACTION_PENDING',current_node_id='lookup',flow_version_id=$1 WHERE id=$2",[effectVersion,conversationId]);
   await c.query(`INSERT INTO bot_action_jobs(id,tenant_id,conversation_id,action_definition_id,action_revision_id,source_event_id,action_node_id,request_input,on_success_node_id,on_failure_node_id,state,attempts,fencing_token,lease_id,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'lookup','{}','handoff','done','RUNNING',1,1,$7,clock_timestamp()+interval '10 minutes')`,[id,tenantId,conversationId,actionId,actionRevisionId,callbackInput.event.id,lease]);
   const job={origin:'DIRECT_FLOW',id,tenantId,conversationId,sourceEventId:callbackInput.event.id,actionNodeId:'lookup',zammadTicketId:ticketId,fencingToken:1};
   await repository.assertBotActionIdentityCurrent(job,lease,appId);
   await assert.rejects(repository.assertBotActionIdentityCurrent({...job,fencingToken:2},lease,appId),deny);
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[bsuidAlias]);
   await assert.rejects(repository.assertBotActionIdentityCurrent(job,lease,appId),deny);
   assert.equal((await c.query('SELECT state,execution_result_state FROM bot_action_jobs WHERE id=$1',[id])).rows[0].state,'RUNNING','Admission itself makes no effect/result mutation');
   await repository.holdUnattemptedBotActionIdentity(job,lease);
   assert.deepEqual((await c.query('SELECT state,execution_result_state FROM bot_action_jobs WHERE id=$1',[id])).rows[0],{state:'FAILED_TERMINAL',execution_result_state:null});
   assert.equal((await c.query('SELECT state FROM bot_conversations WHERE id=$1',[conversationId])).rows[0].state,'ACTION_PENDING','No onFailure or next-node effect may be invented');
  });
  await queueScenario(async(c,repository)=>{
   const id=randomUUID(),lease=randomUUID();
   await c.query("UPDATE bot_conversations SET state='HANDOFF_PENDING',current_node_id='handoff',flow_version_id=$1 WHERE id=$2",[effectVersion,conversationId]);
   await c.query(`INSERT INTO bot_handoff_jobs(id,tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,priority,state,attempts,fencing_token,lease_id,lease_expires_at)
    VALUES($1,$2,$3,$4,'handoff','2','2 normal','RUNNING',1,1,$5,clock_timestamp()+interval '10 minutes')`,[id,tenantId,conversationId,callbackInput.event.id,lease]);
   const job={id,tenantId,conversationId,handoffNodeId:'handoff',zammadTicketId:ticketId,zammadGroupId:'2',priority:'2 normal',fencingToken:1};
   await repository.assertBotHandoffIdentityCurrent(job,lease,appId);
   await assert.rejects(repository.assertBotHandoffIdentityCurrent({...job,zammadGroupId:'9'},lease,appId),deny);
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[phoneAlias]);
   await assert.rejects(repository.assertBotHandoffIdentityCurrent(job,lease,appId),deny);
   assert.equal((await c.query('SELECT state FROM bot_handoff_jobs WHERE id=$1',[id])).rows[0].state,'RUNNING');
   await repository.failBotHandoff(job,lease,'Synthetic known identity hold');
   assert.equal((await c.query('SELECT state FROM bot_handoff_jobs WHERE id=$1',[id])).rows[0].state,'FAILED_TERMINAL');
   assert.equal((await c.query('SELECT state FROM bot_conversations WHERE id=$1',[conversationId])).rows[0].state,'HANDOFF_PENDING');
  });
  await queueScenario(async(c,repository)=>{
   const id=randomUUID(),lease=randomUUID();
   await c.query('UPDATE bot_conversations SET flow_version_id=$1 WHERE id=$2',[effectVersion,conversationId]);
   const current=(await c.query('SELECT human_ownership_epoch,fencing_token FROM bot_conversations WHERE id=$1',[conversationId])).rows[0];
   await c.query(`INSERT INTO direct_customer_close_commands(id,tenant_id,conversation_id,request_event_id,confirmation_event_id,confirmation_prompt_delivery_id,human_ownership_epoch,conversation_fencing_token,request_sha256,lease_id,lease_expires_at,fencing_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '10 minutes',1)`,[id,tenantId,conversationId,callbackInput.event.id,confirm.event.id,deliveries[0],current.human_ownership_epoch,current.fencing_token,'e'.repeat(64),lease]);
   const job={id,tenantId,instanceId,ticketId,state:'QUEUED',fencingToken:1};
   await repository.assertDirectCustomerCloseIdentityCurrent(job,lease,appId);
   const snapshot=await prepareDirectCustomerClose(c,{tenantId,instanceId,commandId:id,leaseId:lease,fencingToken:1,appId,
    context:{updated_at:new Date().toISOString(),state_id:'2',last_article_id:'98232',native_group_id:'2',connection_id:connectionId,external_chat_id:phone,customer_id:'98231',closed:false}});
   assert.equal(snapshot.command_id,id);assert.equal((await directCustomerCloseAdmission(c,{tenantId,instanceId,commandId:id,appId})).effects_clear,true);
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[bsuidAlias]);
   await assert.rejects(repository.assertDirectCustomerCloseIdentityCurrent(job,lease,appId),deny);
   await assert.rejects(directCustomerCloseAdmission(c,{tenantId,instanceId,commandId:id,appId}),deny);
   await c.query("UPDATE direct_customer_close_commands SET state='OUTCOME_UNKNOWN' WHERE id=$1",[id]);
   const unknownBefore=(await c.query('SELECT state,native_action_snapshot,native_attempted_at,native_result FROM direct_customer_close_commands WHERE id=$1',[id])).rows[0];
   await assert.rejects(repository.holdUnattemptedDirectCustomerCloseIdentity(job,lease),/unattempted identity hold lease was lost/);
   assert.deepEqual((await c.query('SELECT state,native_action_snapshot,native_attempted_at,native_result FROM direct_customer_close_commands WHERE id=$1',[id])).rows[0],unknownBefore,'UNKNOWN evidence cannot be reclassified as unattempted');
   const receiptRead=await directCustomerCloseAdmission(c,{tenantId,instanceId,commandId:id,appId});
   assert.equal(receiptRead.effects_clear,false);assert.equal(receiptRead.native_action_state,'OUTCOME_UNKNOWN');
  },apiPool);
  await queueScenario(async(c,repository)=>{
   const id=randomUUID(),lease=randomUUID(),current=(await c.query('SELECT human_ownership_epoch,fencing_token FROM bot_conversations WHERE id=$1',[conversationId])).rows[0];
   await c.query(`INSERT INTO direct_customer_close_commands(id,tenant_id,conversation_id,request_event_id,confirmation_event_id,confirmation_prompt_delivery_id,human_ownership_epoch,conversation_fencing_token,request_sha256,lease_id,lease_expires_at,fencing_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '10 minutes',1)`,[id,tenantId,conversationId,callbackInput.event.id,confirm.event.id,deliveries[0],current.human_ownership_epoch,current.fencing_token,'e'.repeat(64),lease]);
   const job={id,tenantId,instanceId,ticketId,state:'QUEUED',fencingToken:1};
   await repository.assertDirectCustomerCloseIdentityCurrent(job,lease,appId);
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[bsuidAlias]);
   await assert.rejects(repository.assertDirectCustomerCloseIdentityCurrent(job,lease,appId),deny);
   await repository.holdUnattemptedDirectCustomerCloseIdentity(job,lease);
   const held=(await c.query('SELECT state,native_attempted_at,native_result FROM direct_customer_close_commands WHERE id=$1',[id])).rows[0];
   assert.equal(held.state,'FAILED_TERMINAL');assert.equal(held.native_attempted_at,null);assert.equal(held.native_result.state,'NOT_ATTEMPTED');
   assert.equal((await c.query('SELECT state FROM bot_conversations WHERE id=$1',[conversationId])).rows[0].state,'HUMAN');
  });
  await queueScenario(async c=>{
   await c.query('UPDATE bot_conversations SET flow_version_id=$1 WHERE id=$2',[effectVersion,conversationId]);
   const nativeInput={tenantId,instanceId,operationId:randomUUID(),connectionId,chatId:phone,ticketId,actorId:'3',nativeGroupId:'2',actorFullGroupIds:['2'],requestSha256:'f'.repeat(64),appId};
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[phoneAlias]);
   await assert.rejects(reserveDirectNativeReply(c,nativeInput),deny);
   assert.equal((await c.query('SELECT id FROM direct_native_reply_intents WHERE id=$1',[nativeInput.operationId])).rowCount,0);
  },apiPool);
  // A newer historical RESOLVED generation may never displace the authorized live one.
  const historical=randomUUID();
  await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,
   normalized_reference,zammad_ticket_id,zammad_ticket_number,zammad_customer_id,last_activity_at,resolved_at,resolution_kind,created_at)
   VALUES($1,$2,$3,$4,$5,$6,'RESOLVED','done',$7,$8,$8,98231,clock_timestamp(),clock_timestamp(),'FLOW',clock_timestamp()+interval '1 minute')`,
   [historical,tenantId,assignmentId,connectionId,versionId,phone,reference(phone),ticketId]));
  const database={withTenant:(scope,fn)=>tx(fn,scope,apiPool),rows:(scope,sql,values)=>tx(async c=>(await c.query(sql,values)).rows,scope,apiPool)};
  const controller=new ZammadInternalController(database,{verify:async()=>({tenantId,instanceId,userId:'3',groupIds:['2'],groupAdmin:false})},{wake:async()=>{throw new Error('Read-only preflight cannot enqueue')}});
  await queueScenario(async c=>{
   await c.query("UPDATE normalized_messages SET provider_timestamp='2035-01-15T19:00:00Z' WHERE tenant_id=$1 AND id=$2",
    [tenantId,normalizedSource.rows[0].id]);
   await c.query("UPDATE normalized_messages SET provider_timestamp='2035-01-15T20:00:00Z',from_me=true WHERE tenant_id=$1 AND event_inbox_id=$2",
    [tenantId,confirm.event.id]);
   const db={withTenant:async(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)},
    rows:async(scope,sql,values)=>{assert.equal(scope,tenantId);return(await c.query(sql,values)).rows}};
   const ticketContext=new ZammadInternalController(db,{verify:async()=>({tenantId,instanceId})},
    {wake:async()=>assert.fail('context cannot wake workers')});
   const context=await ticketContext.ticketContext('Synthetic native claims',ticketId);
   assert.equal(context.service_window_expires_at,'2035-01-16T19:00:00.000Z');
  },apiPool);
  const previousMetaAppId=process.env.META_APP_ID;process.env.META_APP_ID=appId;
  try{
   assert.deepEqual(await controller.outboundPreflight('Synthetic native claims',connectionId,phone,ticketId),{available:true,keep_open:false});
   await queueScenario(async c=>{
    // Keep the database's microsecond precision at the exact 24-hour boundary.
    const clock=(await c.query(`SELECT (max(provider_timestamp)+interval '24 hours'-interval '1 microsecond')::text AS before_end,
      (max(provider_timestamp)+interval '24 hours')::text AS ends_at
      FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND external_group_id=$3`,
      [tenantId,connectionId,phone])).rows[0];
    assert(clock.ends_at);
    let now=clock.before_end,inventoryReads=0;
    const query=(sql,values)=>sql==='SELECT app.meta_customer_window_open($1,$2) AS open'
      ? c.query('SELECT app.meta_customer_window_open($1,$2,$3) AS open',[...values,now])
      : c.query(sql,values);
    const db={rows:async(scope,sql,values)=>{assert.equal(scope,tenantId);return (await query(sql,values)).rows},
      withTenant:async(scope,fn)=>{assert.equal(scope,tenantId);return fn({query})}};
    const signed={verify:async()=>({tenantId,instanceId,userId:'3',groupIds:['2'],groupAdmin:false})};
    const clients={create:(token,phoneId,beforeRequest)=>{
      assert.equal(token,templateAccessToken);
      assert.equal(phoneId,phoneNumberId);
      return {templateInventory:account=>readMetaTemplateInventory(account,async path=>{
        await beforeRequest();inventoryReads++;
        assert.equal(path,'/'+wabaId+'/message_templates');
        return {data:['APPROVED','PAUSED'].map((status,index)=>({id:String(341+index),name:'order_update_'+index,language:'ar',
          category:'UTILITY',status,parameter_format:'POSITIONAL',components:[{type:'BODY',text:'Order {{1}}'}]}))};
      })};
    }};
    const service=new ZammadInternalController(db,signed,{wake:async()=>{}},
      {resolveAccessToken:async()=>templateAccessToken},clients);
    const target={tenant_id:tenantId,connection_id:connectionId,group_id:phone,ticket_id:ticketId};
    await assert.rejects(service.ticketTemplates('Synthetic native claims',{...target,tenant_id:randomUUID()}),{status:401});
    assert.deepEqual(await service.ticketTemplates('Synthetic native claims',target),{window:'OPEN',templates:[]});
    assert.equal(inventoryReads,0);
    now=clock.ends_at;
    const catalog=await service.ticketTemplates('Synthetic native claims',target);
    assert.equal(catalog.window,'CLOSED');
    assert.deepEqual(catalog.templates.map(item=>[item.id,item.parameterCount]),[['341',1]]);
    const selection={...target,template_id:'341',request_token:randomUUID(),
      template_sha256:catalog.templates[0].semanticSha256,parameters:['42']};
    await assert.rejects(service.sendTicketTemplate('Synthetic native claims',{...selection,template_id:'342'}),{status:409});
    await assert.rejects(service.outbound('Synthetic native claims',{...target,article_id:9988,body:'Free text',
      agent:{id:'3'},idempotency_key:randomUUID()}),{status:409});
    const queued=await service.sendTicketTemplate('Synthetic native claims',selection);
    assert.equal(queued.state,'QUEUED');
    const readsAfterSend=inventoryReads;
    assert.deepEqual(await service.sendTicketTemplate('Synthetic native claims',selection),queued);
    assert.equal(inventoryReads,readsAfterSend);
    await assert.rejects(service.sendTicketTemplate('Synthetic native claims',{...selection,parameters:['43']}),{status:409});
    const delivery=(await c.query('SELECT bot_content,zammad_ticket_id,zammad_article_id FROM delivery_outbox WHERE tenant_id=$1 AND id=$2',
      [tenantId,queued.id])).rows[0];
    assert.equal(delivery.zammad_ticket_id,ticketId);
    assert.equal(delivery.zammad_article_id,null);
    assert.equal(delivery.bot_content.type,'template');
    assert.deepEqual(delivery.bot_content.bodyParameters,['42']);
    const context=await service.ticketContext('Synthetic native claims',ticketId);
    assert.equal(context.delivery_id,queued.id);
    assert.equal(context.delivery_state,'QUEUED');
    assert.equal(context.zammad_article_id,null);
    assert.equal(context.delivery_retry_allowed,false);
    assert.equal((await c.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND target_id=$2 AND action='delivery.template_queued'",
      [tenantId,queued.id])).rows[0].count,1);
   },apiPool);
   await queueScenario(async c=>{
   await c.query("UPDATE meta_direct_identity_aliases SET state='HELD',revision=revision+1 WHERE id=$1",[bsuidAlias]);
   // Reuse this transaction for the API adapter so its held alias is visible.
   const db={withTenant:async(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)},rows:async(scope,sql,values)=>{assert.equal(scope,tenantId);return(await c.query(sql,values)).rows}};
   const heldController=new ZammadInternalController(db,{verify:async()=>({tenantId,instanceId,userId:'3',groupIds:['2'],groupAdmin:false})},{wake:async()=>{throw new Error('Denied preflight cannot enqueue')}});
   await assert.rejects(heldController.outboundPreflight('Synthetic native claims',connectionId,phone,ticketId),deny);
   await assert.rejects(heldController.replyPreview('Synthetic native claims',{tenant_id:tenantId,connection_id:connectionId,group_id:phone,ticket_id:ticketId,body:'Synthetic unsent preview',content_type:'text/plain',agent:{id:'3',display_name:'Synthetic agent'},has_attachments:false}),deny);
   },apiPool);
  }finally{
   if(previousMetaAppId===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=previousMetaAppId;
   await admin.query('DELETE FROM bot_conversations WHERE id=$1',[historical]);
  }
  assert.deepEqual((await admin.query('SELECT state,current_node_id,flow_version_id,fencing_token,human_ownership_epoch,customer_control FROM bot_conversations WHERE id=$1',[conversationId])).rows[0],conversationBefore);
  assert.deepEqual((await admin.query('SELECT id,state,revision FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 ORDER BY id',[participantId])).rows,aliasesBefore,'Rollback fixtures preserve original canonical ownership and alias evidence');

  // Record the request cutoff before admitting the genuinely newer inert source.
  // Its real received_at remains newer; no terminal source is reopened.
  const beforeRetentionSource=await add(ordinary(`${prefix}-before-retention-routing-${randomUUID()}`,phone),undefined,{bindRouting:false});
  const retentionRequestedAt=(await admin.query('SELECT clock_timestamp() requested_at')).rows[0].requested_at.toISOString();
  // Stage inert source data before the worker transaction owns its privacy fence.
  // Only the real routing reducer below may grant OWN after retention succeeds.
  const afterRetentionSource=await add(ordinary(`${prefix}-after-retention-routing-${randomUUID()}`,phone),undefined,{bindRouting:false});
  // Actual worker-role PrivacyRepository discovery/finalization. Native deletes
  // are explicitly synthetic acknowledgments; SQL/CAS/privacy are real.
  await tx(async c=>{
   await c.query('SAVEPOINT actual_capsule_retention');
   const repository=new PrivacyRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   assert.equal((await c.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[input.event.id])).rows[0].meta_direct_native_anchor,null,'Original P03a provenance may have no capsule');
   for(const status of ['QUARANTINED','UNMATCHED','IGNORED']){
    await c.query('SAVEPOINT excluded_source');await c.query('UPDATE event_inbox SET status=$2 WHERE id=$1',[input.event.id,status]);
    assert.equal((await c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[input.event.id])).rows[0].sealed,false);
    assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[bsuidAlias,phone,'98231'])).rows[0].valid,false);
    await c.query('ROLLBACK TO SAVEPOINT excluded_source');
   }

   await c.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
     VALUES($1,$2,$3,$4,'98236','INBOUND') ON CONFLICT DO NOTHING`,[tenantId,connectionId,input.event.providerEventId,ticketId]);
   // First genuine alias-origin completion exercises the normal producer seal
   // branch, not the separate privacy forward-seal authority. No HTTP or replay.
   await c.query('SAVEPOINT first_origin_seal');
   await c.query("UPDATE event_inbox SET status='PROCESSING',lease_id=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[input.event.id,input.leaseId]);
   assert.equal((await c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[input.event.id])).rows[0].sealed,true);
   const firstSeal=(await c.query('SELECT meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[input.event.id])).rows[0];
   assert.deepEqual(firstSeal.meta_direct_native_anchor,{schemaVersion:1,participantId,nativeCustomerId:'98231',payloadSha256:input.payloadHash});
   assert.equal(firstSeal.meta_direct_anchor_retention_job_id,null,'Ordinary completion does not invent retention authority');
   await c.query('ROLLBACK TO SAVEPOINT first_origin_seal');
   const policyUpdate=await c.query("UPDATE retention_policies SET state='ACTIVE',resolved_case_days=1,include_open_cases=false WHERE tenant_id=$1",[tenantId]);
   assert.equal(policyUpdate.rowCount,1);
   await c.query("UPDATE bot_conversations SET state='RESOLVED',resolved_at='2000-01-01',resolution_kind='OPERATOR',last_activity_at='2000-01-01' WHERE id=$1",[conversationId]);
   const current=randomUUID(),currentTicket='98239';
   await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
     VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,98231)`,[current,tenantId,assignmentId,connectionId,versionId,phone,currentTicket,reference(phone)]);
   const routedRetained=await currentPrimary(c,participantId,phone,beforeRetentionSource);
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
    VALUES($1,$2,$3,$4,$5,$5,'Synthetic routed source for expired ticket',clock_timestamp(),$6,'COMPLETE')`,[tenantId,routedRetained.event.id,connectionId,routedRetained.event.providerEventId,phone,{direct:true,zammad_customer_id:98231}]);
   await c.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
    VALUES($1,$2,$3,$4,'98237','INBOUND')`,[tenantId,connectionId,routedRetained.event.providerEventId,ticketId]);
   const retention=await createJob('TENANT',tenantId,'RETENTION_SWEEP',c,retentionRequestedAt);
   assert.equal((await c.query('SELECT received_at>$2::timestamptz newer FROM event_inbox WHERE id=$1',[afterRetentionSource.event.id,retention.createdAt])).rows[0].newer,true,'Only genuinely post-request source may remain in flight');
   await repository.discover(retention,retention.leaseId);retention.stage='EXTERNAL';
   const targets=(await c.query('SELECT target_type,target_id FROM privacy_job_targets WHERE job_id=$1',[retention.id])).rows;
   assert.equal((await c.query('SELECT received_at<=$2::timestamptz older FROM event_inbox WHERE id=$1',[beforeRetentionSource.event.id,retention.createdAt])).rows[0].older,true,'Expired routing fixture source is genuinely before request cutoff');
   assert(targets.some(row=>row.target_type==='META_ROUTING_EVENT'&&row.target_id===beforeRetentionSource.event.id),'Expired exact routing source is discovered');
   assert(targets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===ticketId));
   assert(!targets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===currentTicket));
   assert(targets.some(row=>row.target_type==='NORMALIZED_MESSAGE'&&row.target_id===String(normalizedSource.rows[0].id)));
   assert(!targets.some(row=>row.target_type==='META_DIRECT_ALIAS'),'Current T2 reference preserves original alias evidence');
   await c.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[retention.id]);
   await repository.finalize(retention,retention.leaseId);
   const retained=(await c.query('SELECT payload,meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[input.event.id])).rows[0];
   assert.deepEqual(retained.payload,{});
   assert.deepEqual(retained.meta_direct_native_anchor,{schemaVersion:1,participantId,nativeCustomerId:'98231',payloadSha256:input.payloadHash});
   assert.equal(retained.meta_direct_anchor_retention_job_id,retention.id);
   assert.equal((await c.query('SELECT id FROM normalized_messages WHERE event_inbox_id=$1',[input.event.id])).rowCount,0,'Expired content is removed, not exempted');
   assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[bsuidAlias,phone,'98231'])).rows[0].valid,true,'Retention preserves identity independently of external routing');
   assert.equal((await c.query('SELECT 1 FROM meta_thread_ownership WHERE tenant_id=$1 AND participant_identity_id=$2',[tenantId,participantId])).rowCount,0,'Expired routing source loses OWN');
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId}),deny,'Retained anchor alone cannot restore routing');
   await currentPrimary(c,participantId,phone,afterRetentionSource);
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId});
   // A preserved capsule is usable only in the exact authorized retention
   // tombstone state, never an ignored/quarantined/unmatched source.
   for(const status of ['QUARANTINED','UNMATCHED','IGNORED']){
    await c.query('SAVEPOINT retained_source_status');await c.query('UPDATE event_inbox SET status=$2 WHERE id=$1',[input.event.id,status]);
    assert.equal((await c.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98231'])).rows[0].valid,false);
    assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[bsuidAlias,phone,'98231'])).rows[0].valid,false);
    await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId}),deny);
    await c.query('ROLLBACK TO SAVEPOINT retained_source_status');
   }

   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,sourceEventIds:[input.event.id],appId}),deny,'Expired explicit queued source remains denied');
   for(const statement of ["UPDATE event_inbox SET meta_direct_native_anchor=NULL WHERE id=$1","UPDATE event_inbox SET meta_direct_anchor_retention_job_id=NULL WHERE id=$1","UPDATE event_inbox SET meta_direct_native_anchor=jsonb_set(meta_direct_native_anchor,'{nativeCustomerId}',to_jsonb('999'::text)) WHERE id=$1"]){
    await c.query('SAVEPOINT forged_capsule');await assert.rejects(c.query(statement,[input.event.id]),/immutable/);await c.query('ROLLBACK TO SAVEPOINT forged_capsule');
   }
   const deletion=await createJob('TENANT',tenantId,'DELETE',c);
   await repository.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
   await c.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]);
   await repository.finalize(deletion,deletion.leaseId);
   const revoked=(await c.query('SELECT meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[input.event.id])).rows[0];
   assert.equal(revoked.meta_direct_native_anchor.redacted,true);assert.equal(revoked.meta_direct_anchor_retention_job_id,null);
   assert.equal((await c.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98231'])).rows[0].valid,false);
   await c.query('ROLLBACK TO SAVEPOINT actual_capsule_retention');
  });
  // Signed metadata transition SQL uses the real worker role. Synthetic source
  // insertion is setup only; each scenario restores aliases/customer/job history
  // and removes only its new synthetic events after rollback.
  const nextBsuid=`SA.${'b'.repeat(128)}`,lastBsuid=`SA.${'c'.repeat(128)}`;
  const transitionRows=[],transitionBaseTimestamp=Math.floor(Date.now()/1000);
  const transition=async(previous,current,offset=0,stablePhone,eventId)=>{
   const item=await add({id:`${prefix}-transition-${randomUUID()}`,type:'system',...(stablePhone===undefined?{}:{from:stablePhone}),timestamp:String(transitionBaseTimestamp+offset),
    system:{type:'user_changed_user_id',previous_user_id:previous,user_id:current,...(stablePhone===undefined?{}:{wa_id:stablePhone})}},undefined,{transition:true,eventId});
   transitionRows.push(item.event.id);return item;
  };
  const transitionScenario=async(work)=>{
   let primaryError;
   try{await tx(async c=>{await c.query('SAVEPOINT signed_transition_scenario');
    await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[conversationId]);
    await work(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT signed_transition_scenario');});}
   catch(error){primaryError=error;}
   const cleanup=[...transitionRows.splice(0),...routingFixtureSources.splice(0)];
   if(cleanup.length){
    try{await admin.query('DELETE FROM event_inbox WHERE id=ANY($1::uuid[])',[cleanup]);}
    catch(cleanupError){if(primaryError)throw new AggregateError([primaryError,cleanupError],'Transition scenario and cleanup failed');throw cleanupError;}
   }
   if(primaryError)throw primaryError;
  };
  const scan=async(c,cursor=null)=>(await c.query('SELECT app.scan_meta_direct_transition_work(32,$1) page',[cursor])).rows[0].page;
  const drain=async(c,item)=>(await c.query('SELECT app.drain_meta_direct_transitions($1,$2) result',[item.event.id,item.leaseId])).rows[0].result;
  const transitionSnapshot=async c=>{
   const entries=[];
   for(const table of ['event_inbox','meta_direct_identity_aliases','participant_identities','bot_conversations','connections','provider_sessions',
    'delivery_outbox','delivery_attempts','delivery_receipts','normalized_messages','message_links','zammad_conversation_state_outbox','direct_native_reply_intents'])
    entries.push([table,(await c.query(`SELECT to_jsonb(item) row FROM ${table} item WHERE tenant_id=$1 ORDER BY to_jsonb(item)::text`,[tenantId])).rows.map(row=>row.row)]);
   return Object.fromEntries(entries);
  };
  // Denied leases cannot even persist a conservative hold. These are real
  // worker calls and full persisted snapshots, not only returned-reason mocks.
  for(const shape of ['missing-lease','missing-expiry','expired','wrong-lease'])await transitionScenario(async c=>{
   const item=await transition(bsuid,nextBsuid,1);
   if(shape==='missing-lease'){
    assert.equal((await c.query('UPDATE event_inbox SET lease_id=NULL WHERE id=$1',[item.event.id])).rowCount,1);item.leaseId=null;
   }else if(shape==='missing-expiry')assert.equal((await c.query('UPDATE event_inbox SET lease_expires_at=NULL WHERE id=$1',[item.event.id])).rowCount,1);
   else if(shape==='expired')assert.equal((await c.query("UPDATE event_inbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[item.event.id])).rowCount,1);
   else item.leaseId=randomUUID();
   const before=await transitionSnapshot(c);
   assert.deepEqual((await c.query('SELECT app.meta_direct_transition_admission($1,$2,false) result',[item.event.id,item.leaseId])).rows[0].result,{state:'HELD',reason:'SOURCE_UNAVAILABLE'});
   assert.deepEqual(await drain(c,item),{state:'HELD',reason:'SOURCE_UNAVAILABLE'});
   const repository=new InboundRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   assert.equal((await repository.applyMetaIdentityTransition(item.event,item.leaseId,metaDirectTransitionEvidence(item.event.payload,item.payloadHash,asset).change,appId)).state,'HELD');
   assert.deepEqual(await transitionSnapshot(c),before,shape+' cannot mutate source, alias or native/effect history');
  });
  for(const status of ['PROCESSING','QUARANTINED']){
   const item=await transition(bsuid,nextBsuid,1);
   if(status==='QUARANTINED')await admin.query("UPDATE event_inbox SET status='QUARANTINED',safe_error='META_IDENTITY_TRANSITION_PREDECESSOR_MISSING',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[item.event.id]);
   const blocker=await pool.connect();
   try{
    await blocker.query('BEGIN');
    assert.equal((await blocker.query("SELECT pg_try_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0)) acquired",[tenantId])).rows[0].acquired,true);
    await transitionScenario(async c=>{
     const before=await transitionSnapshot(c);
     assert.deepEqual(await drain(c,item),{state:'HELD',reason:'BUSY'});
     if(status==='PROCESSING'){
      const repository=new InboundRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
      const change=metaDirectTransitionEvidence(item.event.payload,item.payloadHash,asset).change;
      assert.equal((await repository.applyMetaIdentityTransition(item.event,item.leaseId,change,appId)).state,'HELD');
      await repository.holdMetaIdentityChange(item.event,item.leaseId,change,appId);
     }
     assert.deepEqual(await transitionSnapshot(c),before,status+' BUSY leaves source, quarantine reason and all authority unchanged');
     if(status==='QUARANTINED'){
      assert.equal((await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,secretReference}',to_jsonb('secret://foreign/proof'::text)) WHERE id=$1 RETURNING provider_state_data#>>'{metaAccountProof,secretReference}' proof",[sessionId])).rows[0].proof,'secret://foreign/proof');
      const stale=await transitionSnapshot(c),repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
      await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[item.event.id]},appId);
      assert.deepEqual(await transitionSnapshot(c),stale,'Failed local proof grants no source relabel while privacy is BUSY');
      assert.equal((await scan(c)).ready.some(row=>row.eventId===item.event.id),false,'Preserved held source with stale proof is not repeatedly READY');
     }
    });
   }finally{await blocker.query('ROLLBACK');blocker.release();}
  }
  // A previously READY scheduler hint never survives a tenant suspension.
  try{await transitionScenario(async c=>{
   const item=await transition(bsuid,nextBsuid,1);
   await c.query("UPDATE event_inbox SET status='QUARANTINED',safe_error='META_IDENTITY_TRANSITION_PREDECESSOR_MISSING',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[item.event.id]);
   assert((await scan(c)).ready.some(row=>row.eventId===item.event.id));
   assert.equal((await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1 RETURNING state",[tenantId])).rows[0].state,'SUSPENDED');
   const before=await transitionSnapshot(c);
   assert.deepEqual((await c.query('SELECT app.apply_meta_direct_transition_edge($1,NULL) result',[item.event.id])).rows[0].result,{state:'HELD',reason:'TENANT_UNAVAILABLE'});
   assert.deepEqual(await drain(c,{...item,leaseId:null}),{state:'HELD',reason:'TENANT_UNAVAILABLE'});
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[item.event.id]},appId);
   assert.deepEqual(await transitionSnapshot(c),before,'Suspended queued/direct paths cannot write metadata or relabel its source');
   assert.equal((await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,secretReference}',to_jsonb('secret://foreign/proof'::text)) WHERE id=$1 RETURNING provider_state_data#>>'{metaAccountProof,secretReference}' proof",[sessionId])).rows[0].proof,'secret://foreign/proof');
   const stale=await transitionSnapshot(c);
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[item.event.id]},appId);
   assert.deepEqual(await transitionSnapshot(c),stale,'Suspended stale-proof hint preserves its existing held source and all authority');
   assert.equal((await scan(c)).ready.some(row=>row.eventId===item.event.id),false);
  });}finally{await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);}
  for(const state of ['ACTIVE','PROVISIONING']){
   await admin.query('UPDATE tenants SET state=$2 WHERE id=$1',[tenantId,state]);
   try{await transitionScenario(async c=>{
    const item=await transition(bsuid,nextBsuid,1);
    if(state==='ACTIVE'){
     const repository=new InboundRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
     assert.equal((await repository.applyMetaIdentityTransition(item.event,item.leaseId,metaDirectTransitionEvidence(item.event.payload,item.payloadHash,asset).change,appId)).state,'APPLIED','Valid initial worker uses the positive sealed mode');
    }else assert.equal((await drain(c,item)).state,'APPLIED');
    const before=await transitionSnapshot(c);
    // A real second transaction cannot revoke tenant state while the admitted
    // transition transaction holds its tenant authority lock.
    await admin.query('BEGIN');
    try{
     await admin.query("SET LOCAL lock_timeout='100ms'");
     await assert.rejects(admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenantId]),error=>error.code==='55P03');
    }finally{await admin.query('ROLLBACK');}
    assert.equal((await admin.query('SELECT state FROM tenants WHERE id=$1',[tenantId])).rows[0].state,state);
    assert.deepEqual(await transitionSnapshot(c),before,'Denied concurrent state change does not alter admitted history');
   });}finally{await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);}
  }

  const initialRepository=c=>{const repository=new InboundRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};return repository;};
  const initialChange=item=>metaDirectTransitionEvidence(item.event.payload,item.payloadHash,asset).change;
  const conservativeItem=async legacy=>{
   if(!legacy)return transition(bsuid,nextBsuid,1);
   const item=await add({id:`${prefix}-legacy-hold-${randomUUID()}`,type:'system',timestamp:String(transitionBaseTimestamp+1),
    system:{type:'user_changed_user_id',previous_user_id:bsuid,user_id:nextBsuid}});
   transitionRows.push(item.event.id);return item;
  };
  const staleInitialProof=async c=>assert.equal((await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,secretReference}',to_jsonb('secret://foreign/proof'::text)) WHERE id=$1 RETURNING provider_state_data#>>'{metaAccountProof,secretReference}' proof",[sessionId])).rows[0].proof,'secret://foreign/proof');
  const assertInitialHold=async(c,item,before)=>{
   const after=await transitionSnapshot(c),source=after.event_inbox.find(row=>row.id===item.event.id);
   assert.equal(source.status,'QUARANTINED');assert.equal(source.safe_error,'META_IDENTITY_CHANGE_REQUIRES_REVIEW');
   assert.equal(source.meta_direct_identity_resolution,null);assert.equal(source.lease_id,null);assert.equal(source.lease_expires_at,null);
   assert(source.processed_at);assert(source.updated_at);
   const expected={...before,meta_direct_identity_aliases:before.meta_direct_identity_aliases.map(row=>row.state==='ACTIVE'&&row.participant_identity_id===participantId?{...row,state:'HELD',revision:row.revision+1}:row),
    event_inbox:before.event_inbox.map(row=>row.id===item.event.id?{...row,status:'QUARANTINED',payload:{redacted:true,payload_sha256:row.payload_sha256},provider_event_id:`redacted:${row.provider_event_id_sha256}`,
     processed_at:source.processed_at,updated_at:source.updated_at,lease_id:null,lease_expires_at:null,safe_error:'META_IDENTITY_CHANGE_REQUIRES_REVIEW'}:row)};
   for(const key of ['meta_direct_identity_aliases','event_inbox'])for(const snapshot of [expected,after])snapshot[key].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   assert.deepEqual(after,expected,'Conservative admission changes only existing alias holds and its terminal source; no receipt, successor, native or delivery changes');
   assert.equal((await scan(c)).ready.some(row=>row.eventId===item.event.id),false,'Terminal conservative source cannot become READY again');
  };
  // Exercise both production initial paths and the retained direct-hold export.
  // Each case varies the authority boundary, not an artificial full Cartesian set.
  for(const scenario of [{state:'ACTIVE',legacy:false,stale:true,direct:false},
   {state:'PROVISIONING',legacy:true,stale:false,direct:false},{state:'ACTIVE',legacy:false,stale:false,direct:true}]){
   assert.equal((await admin.query('UPDATE tenants SET state=$2 WHERE id=$1 RETURNING state',[tenantId,scenario.state])).rows[0].state,scenario.state);
   try{await transitionScenario(async c=>{
    const item=await conservativeItem(scenario.legacy),repository=initialRepository(c);
    if(scenario.stale)await staleInitialProof(c);
    const before=await transitionSnapshot(c);
    if(scenario.direct)await repository.holdMetaIdentityChange(item.event,item.leaseId,initialChange(item),appId);
    else assert.equal((await repository.applyMetaIdentityTransition(item.event,item.leaseId,initialChange(item),appId)).state,'HELD');
    await assertInitialHold(c,item,before);
   });}finally{await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);}
  }
  for(const direct of [false,true]){
   try{await transitionScenario(async c=>{
    const item=await conservativeItem(direct),repository=initialRepository(c);await staleInitialProof(c);
    assert.equal((await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1 RETURNING state",[tenantId])).rows[0].state,'SUSPENDED');
    const before=await transitionSnapshot(c);
    if(direct)await repository.holdMetaIdentityChange(item.event,item.leaseId,initialChange(item),appId);
    else assert.equal((await repository.applyMetaIdentityTransition(item.event,item.leaseId,initialChange(item),appId)).state,'HELD');
    assert.deepEqual(await transitionSnapshot(c),before,'Suspended initial typed/legacy or exported hold leaves all source and identity state unchanged');
   });}finally{await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);}
  }
  // The caller already holds source/privacy rows before entering sealed SQL.
  // A competing tenant lock therefore must return without waiting or writing.
  await transitionScenario(async c=>{
   const item=await conservativeItem(false);await staleInitialProof(c);
   await admin.query('BEGIN');
   try{
    await admin.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenantId]);
    const before=await transitionSnapshot(c);
    assert.equal((await initialRepository(c).applyMetaIdentityTransition(item.event,item.leaseId,initialChange(item),appId)).state,'HELD');
    assert.deepEqual((await c.query('SELECT app.drain_meta_direct_transitions($1,$2,true) result',[item.event.id,item.leaseId])).rows[0].result,{state:'HELD',reason:'BUSY'});
    assert.deepEqual(await transitionSnapshot(c),before,'Reversed caller tenant lock is NOWAIT/BUSY with zero mutation');
   }finally{await admin.query('ROLLBACK');}
  });
  // A real alias lock delays the final source CAS past lease expiry. Releasing
  // that lock must roll back the preceding alias hold, not commit half a fence.
  await withPostgresClock(admin,'app.drain_meta_direct_transitions(uuid,uuid,boolean)',advance=>transitionScenario(async c=>{
   const item=await conservativeItem(false),blocker=await pool.connect();
   try{
    await blocker.query('BEGIN');await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    await blocker.query('SELECT id FROM meta_direct_identity_aliases WHERE id=$1 FOR UPDATE',[bsuidAlias]);
    const lease=(await c.query("UPDATE event_inbox SET lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1 RETURNING lease_expires_at::text",[item.event.id])).rows[0];assert(lease.lease_expires_at);
    const before=await transitionSnapshot(c),pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await c.query('SAVEPOINT initial_hold_expiry');
    const pending=c.query('SELECT app.drain_meta_direct_transitions($1,$2,true) result',[item.event.id,item.leaseId]).then(value=>({value}),error=>({error}));
    let blocked=false;
    const deadline=performance.now()+1000;
    do{
     blocked=(await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;
    }while(!blocked&&performance.now()<deadline);
    assert.equal(blocked,true,'Expiry oracle must reach the actual alias lock after admission');
    await advance(lease.lease_expires_at);
    await blocker.query('ROLLBACK');
    const settled=await pending;assert.equal(settled.error?.code,'55000','Final live-lease CAS denies partial mutation');
    await c.query('ROLLBACK TO SAVEPOINT initial_hold_expiry');
    assert.deepEqual(await transitionSnapshot(c),before,'Expired final CAS rolls back all alias/source changes');
   }finally{await blocker.query('ROLLBACK');blocker.release();}
  }));

  await transitionScenario(async c=>{
   const before=(await c.query('SELECT * FROM bot_conversations WHERE id=$1',[conversationId])).rows[0];
   const later=await transition(nextBsuid,lastBsuid,2);
   assert.deepEqual(await drain(c,later),{state:'HELD',reason:'PREDECESSOR_MISSING'});
   assert.equal((await c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,false);
   const first=await transition(bsuid,nextBsuid,1),applied=await drain(c,first);
   assert.equal(applied.state,'APPLIED');assert.equal(applied.appliedEventIds.length,2,'Anchored metadata apply drains its formerly unresolvable follower');
   const rows=(await c.query('SELECT id,state,value,revision FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 ORDER BY id',[participantId])).rows;
   assert.equal(rows.find(row=>row.value===bsuid).state,'RETIRED');assert.equal(rows.find(row=>row.value===nextBsuid).state,'RETIRED');
   assert.equal(rows.find(row=>row.value===lastBsuid).state,'ACTIVE');
   assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,true,'Consumed successor remains valid historical bridge');
   assert.equal((await c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,true);
   assert.deepEqual((await c.query('SELECT * FROM bot_conversations WHERE id=$1',[conversationId])).rows[0],before,'No ticket/customer/state/flow/ownership/pause changes');
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId,appId});
   const duplicate=await transition(bsuid,nextBsuid,3),dup=await drain(c,duplicate);
   assert.equal(dup.state,'DUPLICATE');assert.equal(dup.receipt.appliedEventId,first.event.id);
   assert.notEqual(dup.receipt.evidenceSha256,applied.receipt.evidenceSha256,'New duplicate seals its own source hash');
   assert.deepEqual((await c.query('SELECT id,state,value,revision FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 ORDER BY id',[participantId])).rows,rows);
   await c.query("UPDATE provider_sessions SET state='PAUSED' WHERE id=$1",[sessionId]);
   assert.equal((await drain(c,first)).state,'DUPLICATE','Exact historical read needs no new lease/current credential');
  });
  await transitionScenario(async c=>{
   const later=await transition(nextBsuid,lastBsuid,2,phone);
   assert.equal((await drain(c,later)).reason,'PREDECESSOR_MISSING','Shared stable phone does not turn an unproven later BSUID into terminal conflict');
   const first=await transition(bsuid,nextBsuid,1,phone),applied=await drain(c,first);
   assert.equal(applied.state,'APPLIED');assert.equal(applied.appliedEventIds.length,2,'Stable-phone chain is not a fork merely because both signed edges share that phone');
   assert.equal((await c.query('SELECT state FROM meta_direct_identity_aliases WHERE id=$1',[phoneAlias])).rows[0].state,'ACTIVE');
   assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,true);
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId,appId});
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1),fork=await transition(bsuid,lastBsuid,2);
   assert.equal((await drain(c,first)).reason,'CONFLICT');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution,null);
   assert.equal((await c.query("SELECT count(*)::int n FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 AND state='RETIRED'",[participantId])).rows[0].n,0);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[fork.event.id])).rows[0].meta_direct_identity_resolution,null);
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);
   assert.equal((await c.query('SELECT app.drain_meta_direct_transitions($1,$2) result',[first.event.id,randomUUID()])).rows[0].result.reason,'SOURCE_UNAVAILABLE','Wrong lease cannot mutate identity');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution,null);
   await c.query('SAVEPOINT immutable_transition_source');
   await assert.rejects(c.query("UPDATE event_inbox SET meta_direct_identity_transition=jsonb_set(meta_direct_identity_transition,'{change,current,bsuid}',to_jsonb($2::text)) WHERE id=$1",[first.event.id,lastBsuid]),/immutable/);
   await c.query('ROLLBACK TO SAVEPOINT immutable_transition_source');
   assert.equal((await tx(other=>other.query('SELECT app.drain_meta_direct_transitions($1,$2) result',[first.event.id,first.leaseId]),randomUUID())).rows[0].result.reason,'SOURCE_UNAVAILABLE','Tenant role cannot see/apply foreign event');
   assert.equal((await c.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,secretReference}',to_jsonb('secret://foreign/proof'::text)) WHERE id=$1 RETURNING provider_state_data#>>'{metaAccountProof,secretReference}' proof",[sessionId])).rows[0].proof,'secret://foreign/proof');
   const before=await transitionSnapshot(c);
   assert.deepEqual(await drain(c,first),{state:'HELD',reason:'SOURCE_UNAVAILABLE'},'Stale proof is a conservative held result, never an applied transition');
   const after=await transitionSnapshot(c),source=after.event_inbox.find(row=>row.id===first.event.id);
   assert.equal(source.meta_direct_identity_resolution,null);assert.equal(source.status,'QUARANTINED');
   assert.equal(source.safe_error,'META_IDENTITY_TRANSITION_SOURCE_UNAVAILABLE');assert(source.processed_at);assert(source.updated_at);
   const expected={...before,meta_direct_identity_aliases:before.meta_direct_identity_aliases.map(row=>row.state==='ACTIVE'&&row.participant_identity_id===participantId?{...row,state:'HELD',revision:row.revision+1}:row),
    event_inbox:before.event_inbox.map(row=>row.id===first.event.id?{...row,status:'QUARANTINED',payload:{redacted:true,payload_sha256:row.payload_sha256},provider_event_id:`redacted:${row.provider_event_id_sha256}`,
     processed_at:source.processed_at,updated_at:source.updated_at,lease_id:null,lease_expires_at:null,safe_error:'META_IDENTITY_TRANSITION_SOURCE_UNAVAILABLE'}:row)};
   for(const key of ['meta_direct_identity_aliases','event_inbox'])expected[key].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   for(const key of ['meta_direct_identity_aliases','event_inbox'])after[key].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   assert.deepEqual(after,expected,'Only existing ACTIVE aliases become HELD and the source is quarantined; identity/source pins, native customer, conversation and delivery history do not change');
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId,appId}),deny);
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);assert.equal((await drain(c,first)).state,'APPLIED');
   const equalTime=await transition(nextBsuid,lastBsuid,1);
   assert.equal(equalTime.event.payload.entry[0].changes[0].value.messages[0].timestamp,first.event.payload.entry[0].changes[0].value.messages[0].timestamp,'Conflict fixture uses one exact provider time');
   assert.equal((await drain(c,equalTime)).reason,'CONFLICT','Equal-time successor cannot silently win ordering');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[equalTime.event.id])).rows[0].meta_direct_identity_resolution,null);
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);assert.equal((await drain(c,first)).state,'APPLIED');
   const cycle=await transition(nextBsuid,bsuid,2);
   assert.equal((await drain(c,cycle)).reason,'CONFLICT','Returning identifier never revives a retired alias or old recipient snapshot');
   assert.equal((await c.query('SELECT state FROM meta_direct_identity_aliases WHERE id=$1',[bsuidAlias])).rows[0].state,'RETIRED');
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);
   for(let index=0;index<32;index++)await transition(bsuid,`SA.overflow${index}`,index+2);
   assert.equal((await drain(c,first)).reason,'CONTENDER_LIMIT','Thirty-third distinct owned semantic contender is explicit overflow, never silently truncated');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution,null);
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);
   for(let index=0;index<33;index++)await transition(`SA.unresolved${index}`,`SA.unrelated${index}`,index+2);
   assert.equal((await drain(c,first)).state,'APPLIED','Unrelated whole-asset edges do not consume this participant contender bound');
   assert.equal((await c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId])).rows[0].clear,false,'Truly unresolved prior identities still conservatively hold send admission');
  });
  for(const origin of ['BOT','HUMAN'])await transitionScenario(async c=>{
   const delivery=deliveries[origin==='BOT'?0:2];await c.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[delivery]);
   const changed=await transition(bsuid,nextBsuid,1),held=await drain(c,changed);
   assert.equal(held.reason,'PENDING_EFFECT');
   assert.equal((await c.query('SELECT state FROM delivery_outbox WHERE id=$1',[delivery])).rows[0].state,'OUTCOME_UNKNOWN');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[changed.event.id])).rows[0].meta_direct_identity_resolution,null);
   await c.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[delivery]);
   assert.equal((await drain(c,changed)).state,'APPLIED','Only metadata reconsideration after known settlement; no old HTTP replay');
  });


  // Exact function/role admission: read-only READY never mints a resolution;
  // neither application nor worker direct UPDATE may bypass the sealed algorithm.
  const forge=await transition(bsuid,nextBsuid,1);
  try{
   for(const selectedPool of [pool,apiPool])await tx(async c=>{
    await c.query('SAVEPOINT forged_resolution');
    await assert.rejects(c.query(`UPDATE event_inbox SET status='PROCESSED',meta_direct_identity_resolution=$2 WHERE id=$1`,
     [forge.event.id,{schemaVersion:1,state:'APPLIED'}]),error=>error.code==='42501');
    await c.query('ROLLBACK TO SAVEPOINT forged_resolution');
    assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[forge.event.id])).rows[0].meta_direct_identity_resolution,null);
    if(selectedPool===apiPool){
     assert.equal((await c.query("SELECT has_function_privilege(current_user,'app.apply_meta_direct_transition_edge(uuid,uuid,boolean)','EXECUTE') allowed")).rows[0].allowed,false);
     assert.equal((await c.query("SELECT has_function_privilege(current_user,'app.drain_meta_direct_transitions(uuid,uuid,boolean)','EXECUTE') allowed")).rows[0].allowed,false);
     assert.equal((await c.query("SELECT has_function_privilege(current_user,'app.meta_direct_transition_admission(uuid,uuid,boolean)','EXECUTE') allowed")).rows[0].allowed,false);
    }
   },tenantId,selectedPool);
  }finally{await admin.query('DELETE FROM event_inbox WHERE id=$1',[forge.event.id]);transitionRows.splice(transitionRows.indexOf(forge.event.id),1);}

  await transitionScenario(async c=>{
   const changed=await transition(bsuid,nextBsuid,1);
   await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=NULL,lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[conversationId]);
   assert.equal((await drain(c,changed)).reason,'PENDING_EFFECT','Unleased pending native projection is still an external effect fence');
   assert.equal((await scan(c)).ready.length,0);
   const snapshot=(await c.query('SELECT * FROM bot_conversations WHERE id=$1',[conversationId])).rows[0];
   await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp() WHERE conversation_id=$1',[conversationId]);
   const ready=(await scan(c)).ready;
   assert(ready.some(row=>row.eventId===changed.event.id),'Known projection completion makes metadata due');
   const saved=(await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value;
   await c.query('SET LOCAL jit=on');
   const caller=(await c.query("SELECT pg_backend_pid() backend_pid,current_user,session_user,current_setting('app.tenant_id',true) tenant,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,current_setting('jit') jit,current_setting('jit_above_cost') jit_above_cost,current_setting('work_mem') work_mem")).rows[0];
   assert.equal(caller.statement_timeout,'5s','Ordinary discovery keeps the existing five-second execution guard');
   const definition=(await admin.query("SELECT p.prosrc,p.proconfig,p.prosecdef,r.rolname AS owner,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app.list_due_worker_tenants(integer)'::regprocedure")).rows[0];
   assert.equal(definition.owner,'wasalx_scheduler_reader');
   assert.equal(definition.rolbypassrls,true);
   assert.equal(definition.prosecdef,true);
   assert.deepEqual([...definition.proconfig].sort(),['jit=off','row_security=off','search_path=pg_catalog, public, app'].sort(),'Only function-local compilation changes; scheduler security settings remain intact');
   let due;const started=performance.now();
   try{due=(await c.query('SELECT * FROM app.list_due_worker_tenants(200)')).rows;}
   finally{console.error(JSON.stringify({ordinarySchedulerExecution:{elapsedMs:performance.now()-started,statementTimeout:caller.statement_timeout}}));}
   assert(due.length>0&&due.length<=200,'Existing ordinary scheduler returns bounded due work beside metadata discovery');
   assert.equal(new Set(due.map(row=>`${row.tenant_id}:${row.work_type}`)).size,due.length,'Each tenant queue is discovered once');
   for(const row of due)assert(['inbound','delivery','connection','privacy','routing'].includes(row.work_type),'Ordinary scheduler keeps the established queue types');
   assert.deepEqual((await c.query("SELECT current_setting('jit') jit,current_setting('statement_timeout') statement_timeout,current_setting('app.tenant_id',true) tenant")).rows[0],{jit:'on',statement_timeout:'5s',tenant:caller.tenant},'Function-local JIT configuration restores the caller and leaves its execution budget unchanged');
   assert((await scan(c)).ready.some(row=>row.tenantId===tenantId&&row.eventId===changed.event.id),'Read-only metadata discovery supplies exact delivery wake sources');
   const grants=(await c.query(`SELECT has_function_privilege('wasalx_scheduler_reader','app.apply_meta_direct_transition_edge(uuid,uuid,boolean)','EXECUTE') mutate,
    has_function_privilege('wasalx_scheduler_reader','app.drain_meta_direct_transitions(uuid,uuid,boolean)','EXECUTE') drain,
    has_table_privilege('wasalx_scheduler_reader','event_inbox','UPDATE') write,
    has_column_privilege('wasalx_scheduler_reader','participant_identities','display_name','SELECT') profile`)).rows[0];
   assert.deepEqual(grants,{mutate:false,drain:false,write:false,profile:false},'Scheduler reader has no mutation or unnecessary profile authority');
   await c.query('SAVEPOINT scheduler_error_context');
   await assert.rejects(c.query('SELECT * FROM app.list_due_worker_tenants(0)'),error=>error.code==='22023');
   await c.query('ROLLBACK TO SAVEPOINT scheduler_error_context');
   assert.equal((await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,saved,'Private cross-tenant scheduler restores caller context');
   assert.deepEqual((await c.query("SELECT current_setting('jit') jit,current_setting('statement_timeout') statement_timeout")).rows[0],{jit:'on',statement_timeout:'5s'},'Rejected scheduler calls also retain the caller settings');
   // Force a real dependency permission error after the scan changed tenant
   // context. This is an isolated reversible ACL fault, never a product grant.
   await admin.query('REVOKE SELECT(revision) ON meta_direct_identity_aliases FROM wasalx_scheduler_reader');
   try{
    await c.query('SAVEPOINT scheduler_dependency_error');
    await assert.rejects(scan(c),error=>error.code==='42501');
    await c.query('ROLLBACK TO SAVEPOINT scheduler_dependency_error');
    assert.equal((await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,saved,'Internal-error exit preserves original tenant context');
   }finally{await admin.query('GRANT SELECT(revision) ON meta_direct_identity_aliases TO wasalx_scheduler_reader');}
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:(await scan(c)).ready.filter(row=>row.tenantId===tenantId).map(row=>row.eventId)},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[changed.event.id])).rows[0].meta_direct_identity_resolution.state,'APPLIED');
   assert.deepEqual((await c.query('SELECT * FROM bot_conversations WHERE id=$1',[conversationId])).rows[0],snapshot,'No action replay or conversation advancement');
  });
  const callbackIntent=randomUUID();
  await tx(c=>c.query(`INSERT INTO direct_native_reply_intents(id,tenant_id,conversation_id,instance_id,native_ticket_id,native_actor_id,human_ownership_epoch,request_sha256)
    SELECT $1,tenant_id,id,$2,zammad_ticket_id,'3',human_ownership_epoch,$3 FROM bot_conversations WHERE id=$4`,[callbackIntent,instanceId,'f'.repeat(64),conversationId]),tenantId,apiPool);
  try{await transitionScenario(async c=>{
   const changed=await transition(bsuid,nextBsuid,1),intent=callbackIntent;
   await c.query('SAVEPOINT forbidden_intent_write');
   await assert.rejects(c.query("UPDATE direct_native_reply_intents SET state='OUTCOME_UNKNOWN' WHERE id=$1",[intent]),error=>error.code==='42501');
   await c.query('ROLLBACK TO SAVEPOINT forbidden_intent_write');
   assert.equal((await drain(c,changed)).reason,'PENDING_EFFECT');
   await tx(app=>app.query("UPDATE direct_native_reply_intents SET state='OUTCOME_UNKNOWN' WHERE id=$1",[intent]),tenantId,apiPool);
   assert.equal((await scan(c)).ready.length,0,'UNKNOWN never makes metadata due');
   await tx(app=>app.query(`UPDATE direct_native_reply_intents SET state='CANCELLED_PROVEN_ABSENT',completed_at=clock_timestamp(),reconciliation=$2 WHERE id=$1`,[intent,{native_ticket_locked:true,article_absent:true}]),tenantId,apiPool);
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:(await scan(c)).ready.filter(row=>row.tenantId===tenantId).map(row=>row.eventId)},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[changed.event.id])).rows[0].meta_direct_identity_resolution.state,'APPLIED','Callback-only proven absence wakes metadata without another external job');
   assert.equal((await c.query('SELECT state FROM direct_native_reply_intents WHERE id=$1',[intent])).rows[0].state,'CANCELLED_PROVEN_ABSENT');
});}finally{await admin.query('DELETE FROM direct_native_reply_intents WHERE id=$1',[callbackIntent]);}
  // Invalid newest receipts must not hide an older valid ordering watermark.
  // All receipts are produced by sealed worker admission. The temporary source
  // status fault is rolled back before deferred integrity checks; no forged
  // receipt, disabled trigger or administrator-created authority is used.
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1),applied=await drain(c,first);
   assert.equal(applied.state,'APPLIED');
   const receipt=(await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution;
   for(const fault of ['invalid-anchor','foreign-tenant']){
    await c.query('SAVEPOINT deferred_receipt_fault');
    if(fault==='invalid-anchor'){
     assert.equal((await c.query("UPDATE event_inbox SET status='IGNORED' WHERE id=$1",[receipt.anchorEventId])).rowCount,1);
     assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,false);
    }else{
     await c.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);
     assert.equal((await c.query('SELECT id FROM event_inbox WHERE id=$1',[first.event.id])).rowCount,0);
    }
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),error=>error.code==='23514'&&error.message==='Meta transition receipt is incomplete');
    await c.query('ROLLBACK TO SAVEPOINT deferred_receipt_fault');
    assert.deepEqual((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution,receipt);
    assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,true);
   }
   const tombstone=(await c.query("SELECT jsonb_build_object('redacted',true,'sha256',encode(digest(meta_direct_identity_resolution::text,'sha256'),'hex')) value FROM event_inbox WHERE id=$1",[first.event.id])).rows[0].value;
   for(const replacement of [null,{redacted:true},tombstone]){
    await c.query('SAVEPOINT unauthorized_receipt_redaction');
    await assert.rejects(c.query("UPDATE event_inbox SET status='REDACTED',payload='{}',meta_direct_identity_resolution=$2 WHERE id=$1",[first.event.id,replacement]),error=>error.code==='23514'&&/immutable/.test(error.message));
    await c.query('ROLLBACK TO SAVEPOINT unauthorized_receipt_redaction');
   }
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1);assert.equal((await drain(c,first)).state,'APPLIED');
   const middle=await transition(nextBsuid,lastBsuid,3);assert.equal((await drain(c,middle)).state,'APPLIED');
   const latest=await transition(lastBsuid,'SA.orderLatest',5);assert.equal((await drain(c,latest)).state,'APPLIED');
   await c.query('SAVEPOINT invalid_latest_receipt');
   assert.equal((await c.query("UPDATE event_inbox SET status='IGNORED' WHERE id=$1",[latest.event.id])).rowCount,1);
   for(const [item,valid] of [[first,true],[middle,false],[latest,false]])
    assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[item.event.id])).rows[0].valid,valid);
   for(const [offset,state] of [[1,'HELD'],[2,'READY']]){
    const pending=await transition('SA.orderLatest','SA.orderNext',offset),before=await transitionSnapshot(c);
    const result=(await c.query('SELECT app.meta_direct_transition_admission($1,$2,false) result',[pending.event.id,pending.leaseId])).rows[0].result;
    assert.equal(result.state,state,'Ordering falls back to the actual older valid timestamp');
    if(state==='HELD')assert.equal(result.reason,'CONFLICT');
    assert.deepEqual(await transitionSnapshot(c),before,'Ordering read does not change source or identity authority');
    // A separate signed candidate avoids inventing a same-predecessor fork.
    assert.equal((await admin.query('DELETE FROM event_inbox WHERE id=$1',[pending.event.id])).rowCount,1);
    transitionRows.splice(transitionRows.indexOf(pending.event.id),1);
   }
   await c.query('ROLLBACK TO SAVEPOINT invalid_latest_receipt');
  });
  await transitionScenario(async c=>{
   const first=await transition(bsuid,nextBsuid,1),sameEdge=await transition(bsuid,nextBsuid,2);
   assert.equal((await drain(c,first)).state,'APPLIED','Distinct signed copies of one unresolved semantic edge are not a fork');
   const repeated=await drain(c,sameEdge);assert.equal(repeated.state,'DUPLICATE');assert.equal(repeated.receipt.appliedEventId,first.event.id);
   assert.notEqual(repeated.receipt.evidenceSha256,(await drain(c,first)).receipt.evidenceSha256);
  });
  await transitionScenario(async c=>{
    // The full 32-edge batch uses the existing worker/API budget, unlike the 5s scheduler probe.
    await c.query("SET LOCAL statement_timeout='15s'");
    assert.equal((await c.query("SELECT current_setting('statement_timeout') timeout")).rows[0].timeout,'15s','The complete bounded drain uses the production worker execution budget');
   const schedulerAcl=(await c.query(`SELECT
    has_column_privilege('wasalx_scheduler_reader','public.meta_direct_identity_aliases','predecessor_alias_id','SELECT') predecessor,
    has_function_privilege('wasalx_scheduler_reader','app.meta_account_alias_has_valid_successor(uuid)','EXECUTE') verdict`)).rows[0];
   assert.deepEqual(schedulerAcl,{predecessor:false,verdict:true},'Scanner consumes a sealed verdict without private lineage-column access');
   assert.equal((await c.query('SELECT app.meta_account_alias_has_valid_successor($1) valid',[randomUUID()])).rows[0].valid,false);
   const drainConfig=(await c.query("SELECT proconfig FROM pg_proc WHERE oid='app.drain_meta_direct_transitions(uuid,uuid,boolean)'::regprocedure")).rows[0].proconfig;
   assert(drainConfig.includes('jit=off'),'The bounded drain retains its function-local compilation setting');
   const callerJit=(await c.query("SELECT current_setting('jit') jit")).rows[0].jit;
   const chain=[];let previous=bsuid;
   for(let step=0;step<33;step++){
    const current=`SA.chain${String(step).padStart(4,'0')}`;
    const item=await transition(previous,current,step+1);chain.push(item);previous=current;
   }
   // Later edges have already been received and held for missing predecessors.
   for(const item of chain.slice(1))await c.query(`UPDATE event_inbox SET status='QUARANTINED',safe_error='META_IDENTITY_TRANSITION_PREDECESSOR_MISSING',lease_id=NULL,lease_expires_at=NULL WHERE id=$1`,[item.event.id]);
   const boundedStarted=performance.now();
   const first=await drain(c,chain[0]);assert.equal(first.state,'APPLIED');
    console.error(JSON.stringify({boundedIdentityDrain:{elapsedMs:performance.now()-boundedStarted,statementTimeout:'15s'}}));
   assert.equal((await c.query("SELECT current_setting('jit') jit")).rows[0].jit,callerJit,'Function-local JIT configuration does not leak to its caller');
   assert.equal(first.appliedEventIds.length,32);assert.equal(first.reason,'DRAIN_LIMIT');assert.equal(first.remainingHeld,true);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[chain[32].event.id])).rows[0].meta_direct_identity_resolution,null);
   assert((await scan(c)).ready.some(row=>row.eventId===chain[32].event.id),'Reachable 33rd source has existing durable metadata wake');
   assert.equal((await drain(c,chain[0])).state,'DUPLICATE');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[chain[32].event.id])).rows[0].meta_direct_identity_resolution,null,'Historical receipt read cannot grant follower mutation');
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:(await scan(c)).ready.filter(row=>row.tenantId===tenantId).map(row=>row.eventId)},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[chain[32].event.id])).rows[0].meta_direct_identity_resolution.state,'APPLIED');
  });
  await transitionScenario(async c=>{
   assert.equal((await c.query("SELECT current_setting('statement_timeout') timeout")).rows[0].timeout,'5s','The batch budget must not leak to later scenarios');
   const changed=await transition(bsuid,nextBsuid,1);
   await c.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[deliveries[0]]);
   assert.equal((await drain(c,changed)).reason,'PENDING_EFFECT');
   await transition(bsuid,lastBsuid,2);
   await c.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[deliveries[0]]);
   assert.equal((await drain(c,changed)).reason,'CONFLICT');
   assert.equal((await c.query('SELECT safe_error FROM event_inbox WHERE id=$1',[changed.event.id])).rows[0].safe_error,'META_IDENTITY_TRANSITION_CONFLICT','Changed permanent denial cannot retain retryable metadata label');
   assert.equal((await scan(c)).ready.length,0,'No unchanged deterministic wake');
  });

  // Privileged call graph ignores caller-created temporary relations/catalogs.
  // All relation-reading paths pin pg_temp last; the delivered capsule bytes stay unchanged.
  await transitionScenario(async c=>{
   const changed=await transition(bsuid,nextBsuid,1);
   for(const table of ['event_inbox','provider_sessions','participant_identities','meta_direct_identity_aliases','normalized_messages','message_links','bot_conversations'])
    await c.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`);
   await c.query(`CREATE TEMP TABLE pg_proc AS SELECT oid,current_user::regrole::oid AS proowner FROM pg_catalog.pg_proc WHERE oid='app.apply_meta_direct_transition_edge(uuid,uuid,boolean)'::regprocedure`);
   const functions=['app.apply_meta_direct_transition_edge(uuid,uuid,boolean)','app.drain_meta_direct_transitions(uuid,uuid,boolean)','app.meta_direct_transition_admission(uuid,uuid,boolean)',
    'app.scan_meta_direct_transition_work(integer,uuid)','app.guard_meta_direct_alias()',
    'app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean)','app.guard_meta_direct_native_anchor()',
    'app.seal_meta_direct_native_anchor(uuid)','app.meta_direct_transition_receipt_valid(uuid)'];
   for(const signature of functions){
    const config=(await c.query('SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].proconfig;
    assert(config.includes('search_path=pg_catalog, public, app, pg_temp'),signature+' has a closed relation search path');
   }
   assert.equal((await drain(c,changed)).state,'APPLIED','Real public root and aliases remain authoritative despite empty caller shadows');
   assert.equal((await c.query('SELECT count(*) count FROM pg_temp.meta_direct_identity_aliases')).rows[0].count,'0');
   assert.equal((await c.query('SELECT count(*) count FROM public.meta_direct_identity_aliases WHERE source_event_id=$1',[changed.event.id])).rows[0].count,'1');
  });
  // A complete source-bound candidate receipt cannot use a forged pg_proc owner
  // to mint resolution through ordinary UPDATE, for either app or worker.
  const ownerForgery=await transition(bsuid,nextBsuid,1);
  try{
   const planned=await tx(async c=>{
    await c.query('SAVEPOINT planned_forgery');
    await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[conversationId]);
    const result=await c.query('SELECT app.meta_direct_transition_admission($1,$2,false) plan',[ownerForgery.event.id,ownerForgery.leaseId]);
    await c.query('ROLLBACK TO SAVEPOINT planned_forgery');return result;
   });
   assert.equal(planned.rows[0].plan.state,'READY');const plan=planned.rows[0].plan;
   const receipt={schemaVersion:1,state:'APPLIED',participantId:plan.participantId,canonical:plan.canonical,
    nativeCustomerId:plan.nativeCustomerId,anchorEventId:plan.anchorEventId,predecessorAliases:plan.predecessorAliases,
    successorAliases:plan.successorAliases,appliedEventId:ownerForgery.event.id};
   for(const selectedPool of [pool,apiPool])await tx(async c=>{
    await c.query(`CREATE TEMP TABLE pg_proc AS SELECT oid,current_user::regrole::oid AS proowner FROM pg_catalog.pg_proc WHERE oid='app.apply_meta_direct_transition_edge(uuid,uuid,boolean)'::regprocedure`);
    await c.query('SAVEPOINT no_catalog_spoof');
    await assert.rejects(c.query(`UPDATE public.event_inbox SET status='PROCESSED',meta_direct_identity_resolution=$2::jsonb||
     jsonb_build_object('evidenceSha256',encode(digest(meta_direct_identity_transition::text,'sha256'),'hex')) WHERE id=$1`,[ownerForgery.event.id,receipt]),error=>error.code==='42501');
    await c.query('ROLLBACK TO SAVEPOINT no_catalog_spoof');
    assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM public.event_inbox WHERE id=$1',[ownerForgery.event.id])).rows[0].meta_direct_identity_resolution,null);
    await c.query('DROP TABLE pg_temp.pg_proc');
   },tenantId,selectedPool);
  }finally{await admin.query('DELETE FROM event_inbox WHERE id=$1',[ownerForgery.event.id]);transitionRows.splice(transitionRows.indexOf(ownerForgery.event.id),1);}

  // Same-ticket direct deliveries remain isolated by their actual connection.
  const foreignCancellationConnection=randomUUID(),foreignAssignment=randomUUID(),foreignConversation=randomUUID(),ownQueued=randomUUID(),foreignQueued=randomUUID();
  await admin.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference)
    VALUES($1,$2,'Foreign cancellation fixture','WAHA','GOWS','WORKING',$3)`,[foreignCancellationConnection,tenantId,`secret://${tenantId}/connections/${foreignCancellationConnection}/waha`]);
  try{
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,'Operations','ACTIVE',$6,$6)`,[foreignAssignment,tenantId,foreignCancellationConnection,familyId,versionId,userId]));
   await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
    VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,98271)`,[foreignConversation,tenantId,foreignAssignment,foreignCancellationConnection,versionId,phone,ticketId,'BOT-'+hash(tenantId+':'+foreignAssignment+':'+phone).slice(0,12).toUpperCase()]));
   // Queue birth takes the real routing connection lock. Commit that original
   // work before an independent signed source arrives: awaiting admin INSERT
   // while holding this lock would self-block on the source's connection FK.
   const queuedBefore=await tx(async c=>{
    for(const [id,connection,conversation] of [[ownQueued,connectionId,conversationId],[foreignQueued,foreignCancellationConnection,foreignConversation]])await c.query(`INSERT INTO delivery_outbox
     (id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id)
     VALUES($1,$2,$3,$4,$5,$6,'Immutable direct HUMAN fixture','text/plain',$7,'QUEUED','HUMAN','98270')`,[id,tenantId,connection,conversation,phone,ticketId,`${prefix}-cancel-${id}`]);
    const rows=(await c.query('SELECT * FROM delivery_outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[tenantId,[ownQueued,foreignQueued]])).rows;
    assert.equal(rows.length,2);assert(rows.every(row=>row.state==='QUEUED'));
    return rows;
   });
   await transitionScenario(async c=>{
   const foreignBefore=(await c.query('SELECT * FROM delivery_outbox WHERE id=$1',[foreignQueued])).rows[0];
   const changed=await transition(bsuid,nextBsuid,1);assert.equal((await drain(c,changed)).state,'APPLIED');
   assert.equal((await c.query('SELECT state FROM delivery_outbox WHERE id=$1',[ownQueued])).rows[0].state,'FAILED_TERMINAL');
   assert.deepEqual((await c.query('SELECT * FROM delivery_outbox WHERE id=$1',[foreignQueued])).rows[0],foreignBefore,'Other connection keeps exact recipient/content/idempotency/state');
  });
   assert.deepEqual((await tx(c=>c.query('SELECT * FROM delivery_outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[tenantId,[ownQueued,foreignQueued]]))).rows,queuedBefore,'Scenario rollback preserves both original queued snapshots');
   assert.equal((await tx(c=>c.query('SELECT id FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=ANY($2::uuid[])',[tenantId,[ownQueued,foreignQueued]]))).rowCount,0,'Metadata cancellation does not dispatch either delivery');
  }finally{
   // The drain transaction and its locks are finished before exact owned cleanup.
   await admin.query('DELETE FROM delivery_outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenantId,[ownQueued,foreignQueued]]);
   await admin.query('DELETE FROM bot_conversations WHERE id=$1',[foreignConversation]);
   await withFixtureTenant(admin,tenantId,()=>admin.query('DELETE FROM bot_assignments WHERE id=$1',[foreignAssignment]));
   await admin.query('DELETE FROM connections WHERE id=$1',[foreignCancellationConnection]);
  }

  // More than 32 sources with an all-held prefix: real least-privileged scans
  // continue from actual examined IDs, independent of polling clock/cadence.
  await transitionScenario(async c=>{
   const ids=Array.from({length:96},(_,index)=>`eeeeeeee-eeee-4eee-8eee-${String(index+1).padStart(12,'0')}`);
   for(let index=0;index<95;index++)await transition(`SA.unresolved${index}`,`SA.unresolvedNext${index}`,1,undefined,ids[index]);
   const ready=await transition(bsuid,nextBsuid,1,undefined,ids[95]);
   await c.query(`UPDATE event_inbox SET status='QUARANTINED',safe_error='META_IDENTITY_TRANSITION_PREDECESSOR_MISSING',lease_id=NULL,lease_expires_at=NULL WHERE id=ANY($1::uuid[])`,[ids]);
   const context=(await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value;
   for(const limit of [null,0,33]){
    await c.query('SAVEPOINT scan_limit_denied');
    await assert.rejects(c.query('SELECT app.scan_meta_direct_transition_work($1::integer,NULL)',[limit]),error=>error.code==='22023');
    await c.query('ROLLBACK TO SAVEPOINT scan_limit_denied');
    assert.equal((await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,context);
   }
   const single=(await c.query('SELECT app.scan_meta_direct_transition_work(1,NULL) page')).rows[0].page;
   assert.equal(single.examined,1);assert.equal(single.nextCursor,ids[0]);
   assert.equal((await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,context);
   // The API scheduler caller has the same finite contract and no implicit NULL default.
   await tx(async appClient=>{
    const previous=(await appClient.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value;
    for(const limit of [null,0,33]){
     await appClient.query('SAVEPOINT app_scan_limit_denied');
     await assert.rejects(appClient.query('SELECT app.scan_meta_direct_transition_work($1::integer,NULL)',[limit]),error=>error.code==='22023');
     await appClient.query('ROLLBACK TO SAVEPOINT app_scan_limit_denied');
     assert.equal((await appClient.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,previous);
    }
    for(const limit of [1,32]){
     const page=(await appClient.query('SELECT app.scan_meta_direct_transition_work($1::integer,NULL) page',[limit])).rows[0].page;
     assert(page.examined>=0&&page.examined<=limit);assert(page.ready.length<=page.examined);
     assert.equal((await appClient.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,previous);
    }
   },tenantId,apiPool);
   let cursor=null;const seen=[],readyIds=[];
   for(let page=0;page<3;page++){
    const result=await scan(c,cursor);assert.equal(result.examined,32);cursor=result.nextCursor;seen.push(cursor);
    readyIds.push(...result.ready.map(row=>row.eventId));
    assert.equal((await c.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,context);
   }
   assert.deepEqual(seen,[ids[31],ids[63],ids[95]]);assert.deepEqual(readyIds,[ready.event.id]);
   assert.equal((await scan(c,cursor)).nextCursor,ids[31],'End wraps to retained first page');
   assert.equal((await scan(c)).nextCursor,ids[31],'Restart only reinspects retained work');
   const repository=new OutboxRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   const nonexistent=randomUUID();await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[nonexistent]},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution,null,'Source hints never invent authority or pick an unrelated source');
   const foreignScope=randomUUID();
   await c.query("SELECT set_config('app.tenant_id',$1,true)",[foreignScope]);
   repository.tenant=(scope,fn)=>{assert.equal(scope,foreignScope);return fn(c)};
   await repository.reconsiderMetaIdentityTransitions(foreignScope,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[ready.event.id]},appId);
   await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
   repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution,null,'A real foreign source hint cannot cross tenant isolation');
   await c.query('SAVEPOINT source_terminal_after_enqueue');
   await c.query("UPDATE event_inbox SET status='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[ready.event.id]);
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[ready.event.id]},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution,null,'A queued hint cannot replay a now-terminal source');
   await c.query('ROLLBACK TO SAVEPOINT source_terminal_after_enqueue');
   await c.query('SAVEPOINT privacy_after_enqueue');
   await createJob('PARTICIPANT',bsuid,'DELETE',c);
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[ready.event.id]},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution,null,'Current privacy admission is repeated after enqueue');
   await c.query('ROLLBACK TO SAVEPOINT privacy_after_enqueue');
   await c.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[deliveries[0]]);
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[ready.event.id]},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution,null,'Authority/effect changes after enqueue remain held');
   await c.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[deliveries[0]]);
   await repository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[ready.event.id]},appId);
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[ready.event.id])).rows[0].meta_direct_identity_resolution.state,'APPLIED');
  });

  // Legacy numeric customer has no alias to copy. Its first signed transition
  // must independently prove the original completed ordinary/native mapping.
  const legacyCanonical='300',legacyParticipant=routingHistory.legacyParticipant;
  try{await transitionScenario(async c=>{
   const root=await add(ordinary(`${prefix}-legacy-root`,legacyCanonical));transitionRows.push(root.event.id);
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[root.event.id]);
   const legacyConversation=routingHistory.legacyConversation,legacyTicket='98241',legacyCustomer='98251';
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
    VALUES($1,$2,$3,$4,$5,$5,'Original legacy ordinary content',clock_timestamp(),$6,'COMPLETE')`,[tenantId,root.event.id,connectionId,root.event.providerEventId,legacyCanonical,{direct:true,zammad_customer_id:Number(legacyCustomer)}]);
   await c.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction) VALUES($1,$2,$3,$4,'98252','INBOUND')`,[tenantId,connectionId,root.event.providerEventId,legacyTicket]);
   await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[legacyConversation]);
   const customerBefore=(await c.query('SELECT * FROM participant_identities WHERE id=$1',[legacyParticipant])).rows[0];
   const conversationSnapshot=(await c.query('SELECT * FROM bot_conversations WHERE id=$1',[legacyConversation])).rows[0];
   assert.equal((await c.query('SELECT count(*)::int n FROM meta_direct_identity_aliases WHERE participant_identity_id=$1',[legacyParticipant])).rows[0].n,0);
   await c.query('SAVEPOINT no_new_legacy_send');
   await assert.rejects(c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id)
    VALUES($1,$2,$3,$4,$5,'No new alias-free send','text/plain',$6,'QUEUED','HUMAN','98254')`,[tenantId,connectionId,legacyConversation,legacyCanonical,legacyTicket,`${prefix}-new-legacy-denied`]),error=>error.code==='23514'&&error.message==='routing effect held');
   await c.query('ROLLBACK TO SAVEPOINT no_new_legacy_send');
   assert.equal((await c.query('SELECT id FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,`${prefix}-new-legacy-denied`])).rowCount,0);
   const history=routingHistory.legacyDelivery;
   assert.equal((await c.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1 AND state='SENT' RETURNING id",[history])).rowCount,1,'Original pre-routing history enters the existing ambiguity scenario without another send');
   const oldSnapshot=(await c.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=$1',[history])).rows[0].meta_direct_recipient;
   assert.deepEqual(oldSnapshot,{schemaVersion:1,claim:'LEGACY_PHONE_CONTEXT',recipient:{kind:'PHONE',value:legacyCanonical},asset},'Existing no-alias send history is admitted before the signed transition');
   const first=await add({id:`${prefix}-legacy-transition`,type:'system',from:legacyCanonical,timestamp:String(Math.floor(Date.now()/1000)),system:{type:'user_changed_number',wa_id:'301',user_id:`SA.${'d'.repeat(128)}`}},undefined,{transition:true});transitionRows.push(first.event.id);
   await c.query('SAVEPOINT missing_legacy_history');
   await c.query("UPDATE event_inbox SET status='REDACTED',payload='{}' WHERE id=$1",[root.event.id]);
   assert.equal((await drain(c,first)).reason,'SOURCE_UNAVAILABLE','Already redacted history without capsule cannot be reconstructed');
   await c.query('ROLLBACK TO SAVEPOINT missing_legacy_history');
   assert.equal((await drain(c,first)).reason,'PENDING_EFFECT','Legacy unknown outcome is never retargeted or replayed');
   assert.equal((await c.query('SELECT state FROM delivery_outbox WHERE id=$1',[history])).rows[0].state,'OUTCOME_UNKNOWN');
   assert.equal((await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution,null);
   assert.deepEqual((await c.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=$1',[history])).rows[0].meta_direct_recipient,oldSnapshot,'Pending identity admission does not alter historical recipient authority');
   await c.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[history]);
   const settledRepository=new OutboxRepository({});settledRepository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await settledRepository.reconsiderMetaIdentityTransitions(tenantId,{conversationIds:[],deliveryIds:[history],ticketIds:[]},appId);
   const applied={state:'APPLIED',receipt:(await c.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0].meta_direct_identity_resolution};
   assert.equal(applied.receipt.state,'APPLIED');assert.equal(applied.receipt.anchorEventId,root.event.id);assert.equal(applied.receipt.participantId,legacyParticipant);
   assert.deepEqual((await c.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=$1',[history])).rows[0].meta_direct_recipient,oldSnapshot,'Historical settlement never retargets an immutable recipient');
   assert.equal((await c.query('SELECT meta_routing_epoch FROM delivery_outbox WHERE id=$1',[history])).rows[0].meta_routing_epoch,'0','Known settlement never adopts a new routing epoch');
   assert.deepEqual((await c.query('SELECT * FROM participant_identities WHERE id=$1',[legacyParticipant])).rows[0],customerBefore,'Phone/profile/canonical customer remain unchanged');
   assert.deepEqual((await c.query('SELECT * FROM bot_conversations WHERE id=$1',[legacyConversation])).rows[0],conversationSnapshot,'Signed metadata never updates native ticket or bot ownership');
   assert.equal((await c.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[root.event.id])).rows[0].meta_direct_native_anchor,null,'First transition does not fabricate an ordinary capsule');
   assert.equal((await tx(other=>other.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id]),randomUUID())).rows[0].valid,false,'Foreign tenant cannot consume the bridge');
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:legacyConversation,appId}),deny,'Identity bridge alone does not establish routing OWN');
   const routedLegacy=await currentPrimary(c,legacyParticipant,'301');
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
    VALUES($1,$2,$3,$4,$5,$5,'Synthetic current routing content',clock_timestamp(),$6,'COMPLETE')`,[tenantId,routedLegacy.event.id,connectionId,routedLegacy.event.providerEventId,legacyCanonical,{direct:true,zammad_customer_id:Number(legacyCustomer)}]);
   await c.query(`INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
    VALUES($1,$2,$3,$4,'98255','INBOUND')`,[tenantId,connectionId,routedLegacy.event.providerEventId,legacyTicket]);
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId:legacyConversation,appId});
   // Admit inert data before the policy mirror owns the tenant row lock.
   // Keep the actual database cutoff at full precision for worker discovery.
   const legacyRetentionRequestedAt=(await admin.query('SELECT clock_timestamp()::text requested_at')).rows[0].requested_at;
   const afterLegacyRetentionSource=await add(ordinary(`${prefix}-after-legacy-retention-${randomUUID()}`,'301'),undefined,{bindRouting:false});
   transitionRows.push(afterLegacyRetentionSource.event.id);
   const repository=new PrivacyRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
   await c.query("UPDATE retention_policies SET state='ACTIVE',resolved_case_days=1,include_open_cases=false WHERE tenant_id=$1",[tenantId]);
   await c.query("UPDATE bot_conversations SET state='RESOLVED',resolved_at='2000-01-01',resolution_kind='OPERATOR',last_activity_at='2000-01-01' WHERE id=$1",[legacyConversation]);
   const current=randomUUID(),currentTicket='98242';await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
    VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,$9)`,[current,tenantId,assignmentId,connectionId,versionId,legacyCanonical,currentTicket,reference(legacyCanonical),Number(legacyCustomer)]);
   const retention=await createJob('TENANT',tenantId,'RETENTION_SWEEP',c,legacyRetentionRequestedAt);
   assert.equal((await c.query('SELECT created_at=$2::timestamptz exact FROM privacy_jobs WHERE id=$1',[retention.id,retention.createdAt])).rows[0].exact,true,'Worker uses the exact database request cutoff');
   assert.equal((await c.query('SELECT received_at<=$2::timestamptz older FROM event_inbox WHERE id=$1',[root.event.id,retention.createdAt])).rows[0].older,true,'Original legacy history predates the real retention request');
   assert.equal((await c.query('SELECT received_at>$2::timestamptz newer FROM event_inbox WHERE id=$1',[afterLegacyRetentionSource.event.id,retention.createdAt])).rows[0].newer,true);
   await repository.discover(retention,retention.leaseId);retention.stage='EXTERNAL';
   const targets=(await c.query('SELECT target_type,target_id FROM privacy_job_targets WHERE job_id=$1',[retention.id])).rows;
   assert(targets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===legacyTicket));
   assert(!targets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===currentTicket));
   assert(!targets.some(row=>row.target_type==='META_DIRECT_ALIAS'&&applied.receipt.successorAliases.some(slot=>slot.id===row.target_id)));
   await c.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[retention.id]);
   await repository.finalize(retention,retention.leaseId);
   const retained=(await c.query('SELECT status,payload,meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[root.event.id])).rows[0];
   assert.equal(retained.status,'REDACTED');assert.deepEqual(retained.payload,{});
   assert.deepEqual(retained.meta_direct_native_anchor,{schemaVersion:1,participantId:legacyParticipant,nativeCustomerId:legacyCustomer,payloadSha256:root.payloadHash});
   assert.equal(retained.meta_direct_anchor_retention_job_id,retention.id);
   assert.equal((await c.query('SELECT id FROM normalized_messages WHERE event_inbox_id=$1',[root.event.id])).rowCount,0);
   assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,true,'Immutable bridge retains its actual ordinary root after content expiry');
   assert.equal((await c.query('SELECT 1 FROM meta_thread_ownership WHERE tenant_id=$1 AND participant_identity_id=$2',[tenantId,legacyParticipant])).rowCount,0);
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId}),deny,'Retained bridge cannot restore expired routing');
   await currentPrimary(c,legacyParticipant,'301',afterLegacyRetentionSource);
   await assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId});
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,sourceEventIds:[root.event.id],appId}),deny,'Retention root does not revive an explicit old queued source');
   const tombstone=(await c.query("SELECT jsonb_build_object('redacted',true,'sha256',encode(digest(meta_direct_identity_resolution::text,'sha256'),'hex')) value FROM event_inbox WHERE id=$1",[first.event.id])).rows[0].value;
   const deletion=await createJob('TENANT',tenantId,'DELETE',c);await repository.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
   await c.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]);
   await repository.finalize(deletion,deletion.leaseId);
   assert.equal((await c.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[root.event.id])).rows[0].meta_direct_native_anchor.redacted,true);
   assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,false,'Explicit identity deletion revokes the bridge');
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId}),deny);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   assert.deepEqual((await c.query('SELECT status,payload,meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[first.event.id])).rows[0],{status:'REDACTED',payload:{},meta_direct_identity_resolution:tombstone},'Deferred completion preserves the exact authorized final tombstone');
   assert.equal((await c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[first.event.id])).rows[0].valid,false,'Constraint completion does not revive deleted receipt authority');
   await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:current,appId}),deny);
  });}finally{assert.equal((await admin.query('SELECT state FROM delivery_outbox WHERE id=$1',[routingHistory.legacyDelivery])).rows[0].state,'SENT','Rollback preserves original historical row');}

  // Commit one independently anchored synthetic participant so a later real
  // tenant suspension can test historical reads across transaction boundaries.
  // The existing final TENANT privacy job below deletes this exact fixture too.
  const historicalCanonical='400',historicalConversation=randomUUID(),historicalTicket='98261',historicalCustomer='98262';
  const historicalParticipant=(await admin.query("INSERT INTO participant_identities(tenant_id,connection_id,external_participant_id,normalized_phone) VALUES($1,$2,$3,'+400') RETURNING id",[tenantId,connectionId,historicalCanonical])).rows[0].id;
  const historicalRoot=await add(ordinary(`${prefix}-historical-root`,historicalCanonical));
  const historicalSource=await add({id:`${prefix}-historical-transition`,type:'system',from:historicalCanonical,timestamp:String(transitionBaseTimestamp),system:{type:'user_changed_number',wa_id:'401',user_id:'SA.historical'}},undefined,{transition:true});
  await tx(async c=>{
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[historicalRoot.event.id]);
   await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
    VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,clock_timestamp(),$8,$9)`,[historicalConversation,tenantId,assignmentId,connectionId,versionId,historicalCanonical,historicalTicket,reference(historicalCanonical),Number(historicalCustomer)]);
   await c.query(`INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status)
    VALUES($1,$2,$3,$4,$5,$5,'Historical receipt source',clock_timestamp(),$6,'COMPLETE')`,[tenantId,historicalRoot.event.id,connectionId,historicalRoot.event.providerEventId,historicalCanonical,{direct:true,zammad_customer_id:Number(historicalCustomer)}]);
   await c.query("INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction) VALUES($1,$2,$3,$4,'98263','INBOUND')",[tenantId,connectionId,historicalRoot.event.providerEventId,historicalTicket]);
   await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE conversation_id=$1',[historicalConversation]);
   const applied=await drain(c,historicalSource);assert.equal(applied.state,'APPLIED');assert.equal(applied.receipt.participantId,historicalParticipant);
  });
  const historyBlocker=await pool.connect();
  try{
   assert.equal((await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1 RETURNING state",[tenantId])).rows[0].state,'SUSPENDED');
   await historyBlocker.query('BEGIN');
   assert.equal((await historyBlocker.query("SELECT pg_try_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0)) acquired",[tenantId])).rows[0].acquired,true);
   await tx(async c=>{
    const before=await transitionSnapshot(c),historical=await drain(c,{...historicalSource,leaseId:null});
    assert.equal(historical.state,'DUPLICATE');assert.equal(historical.receipt.appliedEventId,historicalSource.event.id);
    assert.deepEqual((await c.query('SELECT app.drain_meta_direct_transitions($1,NULL,true) result',[historicalSource.event.id])).rows[0].result,historical,'Conservative mode also preserves historical receipt-first behavior');
    const repository=new InboundRepository({});repository.tenant=(scope,fn)=>{assert.equal(scope,tenantId);return fn(c)};
    assert.equal((await repository.applyMetaIdentityTransition(historicalSource.event,null,metaDirectTransitionEvidence(historicalSource.event.payload,historicalSource.payloadHash,asset).change,appId)).state,'DUPLICATE');
    await repository.holdMetaIdentityChange(historicalSource.event,null,metaDirectTransitionEvidence(historicalSource.event.payload,historicalSource.payloadHash,asset).change,appId);
    assert.deepEqual(await transitionSnapshot(c),before,'A sealed historical receipt remains readable during tenant/privacy holds with no new grant or writes');
   });
  }finally{await historyBlocker.query('ROLLBACK');historyBlocker.release();await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenantId]);}

  const absentCapsule=await add(ordinary(`${prefix}-expired-without-anchor`));
  await admin.query("UPDATE event_inbox SET status='REDACTED',payload='{}',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[absentCapsule.event.id]);
  assert.equal((await tx(c=>c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[absentCapsule.event.id]))).rows[0].sealed,false,'Already redacted history cannot be forward-sealed');
  await assert.rejects(()=>tx(c=>c.query("UPDATE event_inbox SET meta_direct_native_anchor=$2 WHERE id=$1",[absentCapsule.event.id,{schemaVersion:1,participantId,nativeCustomerId:'98231',payloadSha256:absentCapsule.payloadHash}])),/ordinary completion/);

  // Preserve a real original-source seal for the final cross-transaction
  // deletion oracle; earlier sealer/retention scenarios deliberately roll back.
  const originalAnchorTombstone=await tx(async c=>{
   await c.query("UPDATE event_inbox SET status='PROCESSING',lease_id=$2,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",[input.event.id,input.leaseId]);
   assert.equal((await c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[input.event.id])).rows[0].sealed,true);
   assert.deepEqual((await c.query('SELECT meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[input.event.id])).rows[0],{
    meta_direct_native_anchor:{schemaVersion:1,participantId,nativeCustomerId:'98231',payloadSha256:input.payloadHash},meta_direct_anchor_retention_job_id:null});
   await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[input.event.id]);
   assert.equal((await c.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98231'])).rows[0].valid,true);
   return (await c.query("SELECT jsonb_build_object('redacted',true,'sha256',encode(digest(meta_direct_native_anchor::text,'sha256'),'hex')) value FROM event_inbox WHERE id=$1",[input.event.id])).rows[0].value;
  });
  await verifyMetaRoutingEffects({tx,admin,apiPool,appUrl,workerConfig,platformOperationsUrl,tenantId,connectionId,sessionId,phoneNumberId,wabaId,appId,participantId,conversationId,userId,phone,asset,proof,secretReference,instanceId,effectVersion,sourceEventId:confirm.event.id});

  const changed=await add({id:`${prefix}-changed`,from:phone,type:'system',system:{type:'user_changed_user_id',previous_user_id:bsuid,user_id:'SA.new'}});
  assert.equal((await tx(c=>c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[connectionId,sessionId,phoneNumberId,wabaId,participantId]))).rows[0].clear,false);
  await assert.rejects(()=>tx(c=>c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,bot_conversation_id,external_chat_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_ticket_id,meta_routing_source_event_id)
   VALUES($1,$2,$3,$4,'Never dispatched','text/plain',$5,'QUEUED','BOT',$6,$7)`,[tenantId,connectionId,conversationId,phone,`${prefix}-held`,ticketId,confirm.event.id])),/reconciliation/);
  await admin.query("UPDATE event_inbox SET status='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[changed.event.id]);
  const markerExport=await createJob('PARTICIPANT',bsuid);assert.equal((await privacy.exportData(markerExport,markerExport.leaseId)).metaDirectIdentityEvents.filter(row=>row.meta_direct_identity_change!==null).length,1);await finishExport(markerExport);
  const holdId=randomUUID();
  const insertHold=id=>admin.query(`INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
   VALUES($1,$2,'PARTICIPANT',$3,$4,'Synthetic alias hold',$5)`,[id,tenantId,bsuid,hash(bsuid),userId]);
  await insertHold(holdId);
  assert.equal((await tx(c=>c.query("SELECT app.has_applicable_privacy_hold('PARTICIPANT',$1) held",[phone]))).rows[0].held,true,'BSUID hold protects its canonical phone');
  const deletion=await createJob('TENANT',tenantId,'DELETE');
  await assert.rejects(()=>privacy.discover(deletion,deletion.leaseId),{name:'PrivacyLegalHoldError'});
  await assert.rejects(()=>privacy.finalize(deletion,deletion.leaseId),{name:'PrivacyLegalHoldError'});
  assert.deepEqual(await tx(readMarketingPreferences),marketingPreferences,'An active hold preserves the stored opt-outs');
  assert.equal((await admin.query('SELECT stage FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].stage,'DISCOVER');
  assert.equal((await admin.query('SELECT id FROM privacy_job_targets WHERE job_id=$1',[deletion.id])).rowCount,0);
  assert.equal((await admin.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=$1',[deliveries[0]])).rows[0].meta_direct_recipient.redacted,undefined);
  await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$1 WHERE id=$2",[userId,holdId]);
  await privacy.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
  await assert.rejects(()=>privacy.finalize(deletion,deletion.leaseId),/external.*pending|external.*complete|external.*incomplete/i);
  assert.equal((await admin.query('SELECT stage FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].stage,'EXTERNAL');
  // Fixture external acknowledgments, not real native/media deletion evidence.
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE id=$1",[deliveries[0]]));
  await assert.rejects(()=>privacy.finalize(deletion,deletion.leaseId),{code:'DELIVERY_OUTCOME_UNRESOLVED',retryable:true});
  assert.equal((await admin.query('SELECT stage FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].stage,'EXTERNAL');
  assert.equal((await admin.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=$1',[deliveries[0]])).rows[0].meta_direct_recipient.redacted,undefined);
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[deliveries[0]]));
  await assert.rejects(()=>privacy.finalize({...deletion,fencingToken:2},deletion.leaseId),/lease/i);
  const lateHoldId=randomUUID();
  await assert.rejects(()=>insertHold(lateHoldId),{code:'55000',message:'a privacy deletion is already running'});
  assert.equal((await admin.query('SELECT id FROM privacy_legal_holds WHERE id=$1',[lateHoldId])).rowCount,0);
  assert.equal((await admin.query('SELECT stage FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].stage,'EXTERNAL');
  const result=await privacy.finalize(deletion,deletion.leaseId);
  assert.deepEqual(await tx(readMarketingPreferences),[],'Tenant privacy deletion removes its opt-outs once the hold is released');
  assert.equal((await admin.query('SELECT state,stage FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].state,'SUCCEEDED');
  assert.equal((await admin.query('SELECT id FROM meta_direct_identity_aliases WHERE tenant_id=$1',[tenantId])).rowCount,0);
  const removedAnchor=(await admin.query('SELECT meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[input.event.id])).rows[0];
  assert.deepEqual(removedAnchor,{meta_direct_native_anchor:originalAnchorTombstone,meta_direct_anchor_retention_job_id:null});
  assert.equal((await tx(c=>c.query('SELECT app.meta_direct_native_anchor_valid($1,$2,$3) valid',[input.event.id,participantId,'98231']))).rows[0].valid,false,'Explicit full privacy deletion revokes ordinary native authority');
  assert.deepEqual((await admin.query('SELECT meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[callbackInput.event.id])).rows[0],{meta_direct_native_anchor:null,meta_direct_anchor_retention_job_id:null},'Deletion does not invent provenance on an unrelated later turn');
  assert.equal((await admin.query('SELECT 1 FROM meta_thread_ownership WHERE tenant_id=$1',[tenantId])).rowCount,0);
  for(const row of(await admin.query("SELECT meta_routing_evidence,meta_routing_participant_id FROM event_inbox WHERE tenant_id=$1 AND meta_routing_evidence IS NOT NULL",[tenantId])).rows){assert.equal(row.meta_routing_evidence.peer,undefined);assert.equal(row.meta_routing_evidence.redacted,true);assert.equal(row.meta_routing_participant_id,null)}
  for(const row of (await admin.query('SELECT meta_direct_recipient FROM delivery_outbox WHERE id=ANY($1::uuid[])',[deliveries])).rows){assert.equal(row.meta_direct_recipient.redacted,true);assert.match(row.meta_direct_recipient.sha256,/^[a-f0-9]{64}$/)}
  const redacted=(await admin.query('SELECT payload,meta_direct_identity_change FROM event_inbox WHERE id=$1',[changed.event.id])).rows[0];
  assert.deepEqual(redacted.payload,{});assert.equal(redacted.meta_direct_identity_change.scope,'ASSET');assert.equal(redacted.meta_direct_identity_change.payloadSha256,changed.payloadHash);
  assert.equal((await tx(c=>c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,NULL) clear',[connectionId,sessionId,phoneNumberId,wabaId]))).rows[0].clear,false,'Redaction cannot silently release unresolved signed change');
  assert.deepEqual((await admin.query('SELECT * FROM delivery_receipts WHERE id=$1',[receiptId])).rows[0],{...receiptBefore,external_message_id:null},'Only existing privacy external-ID redaction changes immutable receipt history');
  const afterExport=await createJob('TENANT',tenantId);const afterPrivacy=await privacy.exportData(afterExport,afterExport.leaseId);assert.equal(afterPrivacy.metaDirectRecipients.length,0,'Redacted recipient snapshots are not exported');assert.deepEqual(afterPrivacy.metaRouting,{events:[],actions:[]},'Redacted routing evidence is not exported');await finishExport(afterExport);
  return{delayedEffects:true,apiPreflightHistoricalGeneration:true,signedAliasAdmission:true,identifierBounds:true,rls:true,callbackFkCurrentness:true,threeWriterLocks:true,recipientExportScopes:true,unknownPreserved:true,privacyLocalTransition:true,markerAntiResurrection:true,aliases:2,deliveries:4,finalized:result};
 }finally{restoreRoutingEnvironment();await Promise.all([pool.end(),apiPool.end()]);await admin.end()}
}

// Native/provider work is deliberately absent. HTTP parsing/HMAC, the real
// DatabaseService/app role, RLS and all installed PostgreSQL triggers are real.
async function verifyMetaDirectHttpProducer(admin,appUrl,tenantId,appId,prefix){
 const connectionId=randomUUID(),sessionId=randomUUID(),phoneNumberId=BigInt('0x'+randomUUID().replaceAll('-','').slice(0,20)).toString(),wabaId='987654321987654';
 const asset={providerSessionId:sessionId,phoneNumberId,wabaId},reference=`secret://${tenantId}/http-meta/app`,secret='synthetic-canonical-meta-hmac';
 const priorEnv=Object.fromEntries(['DATABASE_URL','DATABASE_POOL_SIZE','META_APP_SECRET_REFERENCE','META_APP_ID'].map(key=>[key,process.env[key]]));
 let database,app,wakes=0;const errors=[];
 try{
  process.env.DATABASE_URL=appUrl;process.env.DATABASE_POOL_SIZE='2';process.env.META_APP_SECRET_REFERENCE=reference;process.env.META_APP_ID=appId;
  database=new DatabaseService();
  const authority=await database.withTenant(tenantId,async c=>(await c.query("SELECT pg_has_role(current_user,'wasalx_app','MEMBER') app_role,(SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) superuser")).rows[0]);
  assert.deepEqual(authority,{app_role:true,superuser:false},'HTTP persistence must use the actual application runtime authority');
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Signed HTTP identity producer','META','CLOUD_API','WORKING',$3)",[connectionId,tenantId,`secret://${tenantId}/connections/${connectionId}/meta`]);
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'WORKING',$5,'ACTIVE',$6)",[sessionId,tenantId,connectionId,phoneNumberId,`meta-cloud://${wabaId}/${phoneNumberId}`,{wabaId}]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,$4,'ACTIVE')",[tenantId,connectionId,phoneNumberId,reference]));
  // Record only PostgreSQL error codes; do not replace queries, role or admission.
  const accept=database.acceptWebhookEvent.bind(database);
  database.acceptWebhookEvent=async(...args)=>{try{return await accept(...args)}catch(error){errors.push(error.code);throw error}};
  class HttpIdentityModule{}
  Module({controllers:[WebhookIngressController],providers:[
   {provide:DatabaseService,useValue:database},{provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
   {provide:TenantDrainService,useValue:{wakeInbound:async scope=>{assert.equal(scope,tenantId);wakes++;}}},
   {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}
  ]})(HttpIdentityModule);
  app=await NestFactory.create(HttpIdentityModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  await app.init();await app.getHttpAdapter().getInstance().ready();
  const now=String(Math.floor(Date.now()/1000));
  const ordinary=id=>({id,type:'text',from:'12025550138',timestamp:now,text:{body:'Synthetic signed ordinary message'}});
  const identity=(id,type)=>({id,type:'system',timestamp:now,...(type==='user_changed_number'?{from:'12025550138'}:{}),
   system:type==='user_changed_number'?{type,wa_id:'12025550163',user_id:'SA.current'}:{type,previous_user_id:'SA.previous',user_id:'SA.current'}});
  const value=message=>({messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},messages:[message]});
  const envelope=(message,id=wabaId)=>({object:'whatsapp_business_account',entry:[{...(id===null?{}:{id}),changes:[{field:'messages',value:value(message)}]}]});
  const inject=(body,signed=true)=>{const payload=JSON.stringify(body);return app.inject({method:'POST',url:'/webhooks/meta',headers:{'content-type':'application/json','x-hub-signature-256':`sha256=${signed?createHmac('sha256',secret).update(payload).digest('hex'):'0'.repeat(64)}`},payload})};
  const rows=async()=>(await admin.query('SELECT to_jsonb(source) row FROM event_inbox source WHERE connection_id=$1 ORDER BY id',[connectionId])).rows.map(row=>row.row);
  const state=async()=>({rows:await rows(),connection:(await admin.query('SELECT to_jsonb(connection) row FROM connections connection WHERE id=$1',[connectionId])).rows[0].row});
  for(const [kind,message] of [['ordinary',ordinary(`${prefix}-http-ordinary`)],
   ...['user_changed_number','user_changed_user_id'].map(type=>[type,identity(`${prefix}-http-${type}`,type)])]){
   const before=(await rows()).length,response=await inject(envelope(message));
   assert.equal(response.statusCode,200);assert.equal(response.json().count,1);
   const current=await rows();assert.equal(current.length,before+1);
   const persisted=current.find(row=>row.provider_event_id===message.id);
   assert(persisted);assert.equal(persisted.payload.entry[0].id,wabaId);assert.deepEqual(persisted.meta_direct_asset,asset);assert.equal(persisted.status,'ACCEPTED');
   assert.equal(persisted.payload_sha256,createHash('sha256').update(JSON.stringify({entry:[{id:wabaId,changes:[{field:'messages',value:value(message)}]}]})).digest('hex'));
   if(kind==='ordinary'){assert.equal(persisted.meta_direct_identity_transition,null);assert.equal(persisted.meta_direct_identity_change,null);
    assert.equal(persisted.meta_routing_evidence.category,'PRIMARY_MESSAGE');assert.equal(persisted.meta_routing_evidence.payloadSha256,persisted.payload_sha256);
    assert.equal(persisted.meta_routing_evidence.providerSessionId,sessionId);assert.equal(persisted.meta_routing_evidence.appId,appId);
   }
   else{assert.deepEqual(persisted.meta_direct_identity_transition,metaDirectTransitionEvidence(persisted.payload,persisted.payload_sha256,asset));assert(persisted.meta_direct_identity_transition);}
   const beforeRepeat=await state(),wakeBefore=wakes;
   assert.equal((await inject(envelope(message))).json().duplicates,1);
   const rebatch=envelope(message);rebatch.entry[0].time=Number(now);rebatch.padding='ignored transport metadata';
   assert.equal((await inject(rebatch)).json().duplicates,1);assert.deepEqual(await state(),beforeRepeat);assert.equal(wakes,wakeBefore);
  }
  // Ordinary routing validates account context before insertion; identity units
  // retain the actual asset-trigger denial. The direct real-adapter negatives
  // additionally prove every pinned shape is still rejected by PostgreSQL.
  for(const kind of ['ordinary','identity'])for(const [label,id] of [['foreign','987654321987655'],['missing',null],['malformed',{bad:true}]]){
   const message=kind==='ordinary'?ordinary(`${prefix}-http-${kind}-${label}`):identity(`${prefix}-http-${kind}-${label}`,'user_changed_user_id');
   const before=await state(),errorCount=errors.length,wakeBefore=wakes,response=await inject(envelope(message,id));
   assert.equal(response.statusCode,kind==='identity'?500:label==='foreign'?404:400);
   if(kind==='identity'){assert.equal(errors.length,errorCount+1);assert.equal(errors.at(-1),'23514');}
   else assert.equal(errors.length,errorCount+(label==='foreign'?1:0));
   assert.deepEqual(await state(),before,'Unavailable account cannot insert or update a source/connection');assert.equal(wakes,wakeBefore);
   const payload={entry:envelope(message,id).entry},payloadSha256=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   const route=await database.resolveMetaWebhookRoute(phoneNumberId);assert(route);
   await assert.rejects(accept(route,{providerEventId:message.id,eventType:'messages',payload,payloadSha256,routeKey:phoneNumberId,providerSessionKey:phoneNumberId,providerEngine:'CLOUD_API'}),error=>error.code==='23514');
   assert.deepEqual(await state(),before,'Actual database asset trigger still rejects foreign/missing/malformed account without a routing parser');

  }
  const beforeUnsigned=await state(),wakeBeforeUnsigned=wakes,errorCount=errors.length;
  assert.equal((await inject(envelope(ordinary(`${prefix}-http-unsigned`)),false)).statusCode,401);
  assert.deepEqual(await state(),beforeUnsigned);assert.equal(wakes,wakeBeforeUnsigned);assert.equal(errors.length,errorCount);
  // A pre-migration unpinned row represents historical projection bytes. No
  // backfill or new key is allowed when the ordinary projection now gains id.
  const oldMessage=ordinary(`${prefix}-http-old-projection`),oldPayload={entry:[{changes:[{field:'messages',value:value(oldMessage)}]}]},oldHash=createHash('sha256').update(JSON.stringify(oldPayload)).digest('hex');
  await admin.query("INSERT INTO event_inbox(tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES($1,$2,'META',$3,'messages',$4,$5,'PROCESSED')",[tenantId,connectionId,oldMessage.id,oldPayload,oldHash]);
  const beforeLegacy=await state(),wakeBeforeLegacy=wakes;
  assert.equal((await inject(envelope(oldMessage))).statusCode,409);assert.deepEqual(await state(),beforeLegacy);assert.equal(wakes,wakeBeforeLegacy);
  // Receipt pricing observations retain the signed account context; error units
  // still redact that context and private diagnostics. Neither pins direct identity.
  const statusValue={messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},statuses:[{id:`${prefix}-http-status`,status:'delivered',timestamp:now,recipient_id:'12025550138'}]};
  assert.equal((await inject({object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:statusValue}]}]})).statusCode,200);
  const status=(await rows()).find(row=>row.event_type==='message.status');assert(status);assert.equal(status.meta_direct_asset,null);
  assert.deepEqual(status.payload,{entry:[{id:wabaId,changes:[{field:'messages',value:statusValue}]}]});
  assert.equal(status.meta_routing_evidence.payloadSha256,status.payload_sha256,'Status routing evidence binds the exact observed account projection bytes');
  const errorValue={messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},errors:[{code:131000,error_subcode:2494010,title:'private title',error_data:{details:'private detail'}}]};
  assert.equal((await inject({object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:errorValue}]}]})).statusCode,200);
  const diagnostic=(await rows()).find(row=>row.event_type==='meta.error');assert(diagnostic);assert.equal(diagnostic.meta_direct_asset,null);
  assert.equal(diagnostic.payload.entry[0].id,undefined);assert.equal(JSON.stringify(diagnostic.payload).includes(wabaId),false);assert.equal(JSON.stringify(diagnostic.payload).includes('private'),false);
  assert.equal((await admin.query('SELECT id FROM normalized_messages WHERE connection_id=$1',[connectionId])).rowCount,0);
  assert.equal((await admin.query('SELECT id FROM meta_direct_identity_aliases WHERE connection_id=$1',[connectionId])).rowCount,0);
 }finally{
  try{if(app)await app.close();else if(database)await database.onModuleDestroy();}
  finally{
   for(const[key,value]of Object.entries(priorEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
   // Only fixture-owned rows, without native work, aliases or external effects.
   await admin.query('DELETE FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);
   await admin.query('DELETE FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);
   await admin.query('DELETE FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);
   await admin.query('DELETE FROM connections WHERE tenant_id=$1 AND id=$2',[tenantId,connectionId]);
  }
 }
}
