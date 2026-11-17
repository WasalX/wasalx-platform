import assert from 'node:assert/strict';
import {withFixtureTenant,observeRoutingFixture,routingFixtureEnvironment} from './meta-routing-fixture.mjs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
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
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {resolveMetaDirectMessage} from '../services/connector-worker/dist/services/connector-worker/src/meta-direct-identity.js';
import {parseMetaDirectIdentity} from '../services/connector-worker/dist/packages/core/src/meta-direct-identity.js';
import {assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {metaRoutingRuntime} from '../packages/core/dist/meta-routing.js';
import {metaCoexistenceUnits,coexistenceSubjectDigest} from '../packages/core/dist/meta-coexistence.js';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const externalTypes="('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')";

// Extends the existing canonical signup fixture. Real signed ingress, ordinary
// identity/native completion and worker-role privacy consumers; native callbacks
// below are explicitly synthetic. No capsule, alias authority or OWN is seeded.
export async function verifyCoexistenceNativePrivacy(fixture){
 const {admin,db,tenantId,context,pool,inbound,drain,appId,request}=fixture;
 const privacy=new PrivacyRepository(pool),http=await signedIngress(fixture);
 const policy=(await admin.query('SELECT state,resolved_case_days,include_open_cases FROM retention_policies WHERE tenant_id=$1',[tenantId])).rows[0];
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const result=await fn(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}};
 let restoreRoutingEnvironment;
 try{
  assert.equal((await db.rows(tenantId,"SELECT pg_has_role(current_user,'wasalx_app','MEMBER') app_role"))[0].app_role,true);
  assert.equal((await tx(c=>c.query('SELECT current_user role'))).rows[0].role,'wasalx_connector_worker');
  const otherContext=await anotherContext(fixture);
  // Complete signup with its original origin before entering the routing fixture scope.
  restoreRoutingEnvironment=routingFixtureEnvironment(appId);
  // Ordinary native evidence uses the same real privileged routing observation
  // as the identity fixture. Imported history/contact rows grant no authority.
  const review=await observeRoutingFixture(admin,{tenantId,connectionId:context.connection_id,sessionId:context.provider_session_id,appId});
  assert.equal(review.disposition,'REVIEWED');
  for(const [index,purgeType] of ['RETENTION_SWEEP','ZAMMAD_TICKET'].entries()){
   const phone=String(15555550880+index),otherPhone=String(15555550870+index),customer=String(98360+index),ticket=String(98460+index),now=Math.floor(Date.now()/1000);
   const prefix='native-import-'+randomUUID(),text=(id,subject=phone)=>({id,from:subject,type:'text',timestamp:String(now),text:{body:'Synthetic inert native privacy data'}});
   const history=(chunk,messages)=>({history:[{metadata:{phase:0,chunk_order:chunk,progress:100},threads:[...new Set(messages.map(m=>m.from))].map(id=>({id,messages:messages.filter(m=>m.from===id)}))}]});
   const contacts=subjects=>({state_sync:subjects.map(subject=>({type:'contact',contact:{phone_number:subject,full_name:'Synthetic imported name'},action:'add',metadata:{timestamp:String(now)}}))});
   const chunk=700+index*10;
   await http.send(context,'history',history(chunk,[text(prefix+'-history'),text(prefix+'-other',otherPhone)]));
   await http.send(context,'smb_app_state_sync',contacts([phone,otherPhone]));await drain.drainTenant(tenantId);
   assert.deepEqual(await exported(customer),{messages:[],contacts:[]},'Imported names/phone alone cannot establish a native customer');
   const ordinary=await nativeOrigin(fixture,http,tx,{phone,customer,ticket,prefix});
   await tx(c=>assertMetaDirectEffectCurrent(c,{tenantId,conversationId:ordinary.current,appId}));
   const authorityBefore=await authorityRows(fixture,context.connection_id);
   const live=await exported(customer);assert(live.messages.some(row=>row.external_message_id===prefix+'-history'));assert.equal(live.contacts.length,1);
   // Same imported phone in another genuine context must not inherit native
   // customer provenance from this connection or share its deletion cutoff.
   await http.send(otherContext,'history',history(chunk,[text(prefix+'-foreign-context')]));
   await http.send(otherContext,'smb_app_state_sync',contacts([phone]));await drain.drainTenant(tenantId);
   assert.deepEqual(await authorityRows(fixture,context.connection_id),authorityBefore,'Imports create no ordinary identity/native/bot/delivery effects');
   const pendingHistory=(await http.send(context,'history',history(chunk+1,[text(prefix+'-pending'),text(prefix+'-pending-other',otherPhone)])))[0];
   const pendingContacts=(await http.send(context,'smb_app_state_sync',{state_sync:contacts([phone,otherPhone]).state_sync.map(row=>({...row,metadata:{timestamp:String(now+1)}}))}))[0];
   const inboxLease=randomUUID(),leased=await inbound.claim(tenantId,inboxLease,2);
   assert.deepEqual(leased.map(row=>row.id).sort(),[pendingHistory.id,pendingContacts.id].sort());
   await admin.query("UPDATE retention_policies SET state='ACTIVE',resolved_case_days=1,include_open_cases=false WHERE tenant_id=$1",[tenantId]);
   const purge=await createJob(purgeType==='RETENTION_SWEEP'?'RETENTION_SWEEP':'DELETE',purgeType==='RETENTION_SWEEP'?'TENANT':'ZAMMAD_TICKET',purgeType==='RETENTION_SWEEP'?tenantId:ticket);
   await privacy.discover(purge,purge.leaseId);purge.stage='EXTERNAL';
   const purgeTargets=(await admin.query('SELECT target_type,target_id FROM privacy_job_targets WHERE job_id=$1',[purge.id])).rows;
   assert(purgeTargets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===ticket),'The old ordinary ticket is selected by the actual purge');
   assert(!purgeTargets.some(row=>row.target_type==='ZAMMAD_TICKET'&&row.target_id===ordinary.currentTicket),'The current native ticket remains outside the content purge');
   const sourceMessage=(await admin.query('SELECT id FROM normalized_messages WHERE tenant_id=$1 AND event_inbox_id=$2',[tenantId,ordinary.event.id])).rows[0];
   assert(sourceMessage,'The ordinary producer persisted its normalized source before purge');
   assert(purgeTargets.some(row=>row.target_type==='NORMALIZED_MESSAGE'&&row.target_id===String(sourceMessage.id)),'The real ticket link selects the ordinary source for deletion');
   await acknowledge(purge);await privacy.finalize(purge,purge.leaseId);
   assert.equal((await admin.query('SELECT count(*)::int n FROM normalized_messages WHERE event_inbox_id=$1',[ordinary.event.id])).rows[0].n,0);
   const retained=(await admin.query('SELECT status,payload,meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[ordinary.event.id])).rows[0];
   assert.equal(retained.status,'REDACTED');assert.deepEqual(retained.payload,{});assert.equal(retained.meta_direct_anchor_retention_job_id,purge.id);
   assert.deepEqual(retained.meta_direct_native_anchor,{schemaVersion:1,participantId:ordinary.participant,nativeCustomerId:customer,payloadSha256:ordinary.event.payload_sha256});
   await tx(async c=>{
    assert.equal((await c.query('SELECT app.meta_direct_transition_anchor_valid($1,$2,$3,false) valid',[ordinary.event.id,ordinary.participant,customer])).rows[0].valid,true);
    assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[ordinary.alias,phone,customer])).rows[0].valid,true);
    // Retained native provenance remains valid for subject privacy. It does not
    // retain OWN after the actual purge removes its routing source and grant.
    assert.equal((await c.query(`SELECT count(*)::int n FROM meta_thread_ownership
      WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4`,
      [tenantId,context.connection_id,context.provider_session_id,ordinary.participant])).rows[0].n,0);
    const routing=(await c.query('SELECT allowed,claim,reason FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [context.connection_id,context.provider_session_id,context.phone_id,context.waba_id,ordinary.participant,appId,JSON.stringify(metaRoutingRuntime(process.env))])).rows[0];
    assert.deepEqual(routing,{allowed:false,claim:'UNKNOWN',reason:'OWNERSHIP_REQUIRED'});
    await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:ordinary.current,appId}),
      error=>error.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED'&&error.reason==='HELD'&&error.outcomeKnown===true);
    await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:ordinary.current,sourceEventIds:[ordinary.event.id],appId}),error=>error.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED');
   });
   const retainedExport=await exported(customer);
   assert.deepEqual(retainedExport.messages.map(row=>row.external_message_id),[prefix+'-history']);assert.deepEqual(retainedExport.contacts.map(row=>row.subject_phone),[phone]);
   if(index===0){
   assert.deepEqual(await exported('99998360'),{messages:[],contacts:[]},'Wrong customer cannot borrow a valid capsule');
   const exportJob=await createJob('EXPORT','ZAMMAD_USER',customer);
   await assert.rejects(privacy.exportData(exportJob,randomUUID()),/lease was lost/);
   await assert.rejects(privacy.exportData({...exportJob,tenantId:randomUUID()},exportJob.leaseId),/lease was lost/);
   await tx(async c=>{
    const scoped=new PrivacyRepository({});scoped.tenant=(id,fn)=>{assert.equal(id,tenantId);return fn(c);};
    for(const status of ['QUARANTINED','UNMATCHED','IGNORED']){
     await c.query('SAVEPOINT invalid_native_provenance');await c.query('UPDATE event_inbox SET status=$2 WHERE id=$1',[ordinary.event.id,status]);
     assert.equal((await c.query('SELECT app.meta_direct_transition_anchor_valid($1,$2,$3,false) valid',[ordinary.event.id,ordinary.participant,customer])).rows[0].valid,false);
     assert.deepEqual((await scoped.exportData(exportJob,exportJob.leaseId)).metaCoexistence,{messages:[],contacts:[]});
     await c.query('ROLLBACK TO SAVEPOINT invalid_native_provenance');
    }
    await c.query('SAVEPOINT forged_native_customer');
    await assert.rejects(c.query("UPDATE event_inbox SET meta_direct_native_anchor=jsonb_set(meta_direct_native_anchor,'{nativeCustomerId}',to_jsonb('99998360'::text)) WHERE id=$1",[ordinary.event.id]),error=>error.code==='23514');
    await c.query('ROLLBACK TO SAVEPOINT forged_native_customer');
   });
   await admin.query('DELETE FROM privacy_jobs WHERE id=$1',[exportJob.id]);
   }
   const hold=index===0?randomUUID():null;
   if(hold)await admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'PARTICIPANT',$3,$4,'Synthetic retained native hold',$5)",[hold,tenantId,phone,sha(phone),request.principal.userId]);
   const deletion=await createJob('DELETE','ZAMMAD_USER',customer);
   if(hold){
   await assert.rejects(privacy.discover(deletion,deletion.leaseId),error=>error.name==='PrivacyLegalHoldError');
   assert.equal((await admin.query('SELECT count(*)::int n FROM privacy_job_targets WHERE job_id=$1',[deletion.id])).rows[0].n,0);
   await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[hold,request.principal.userId]);
   await assert.rejects(privacy.discover(deletion,randomUUID()),/lease was lost/);
   }
   await privacy.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
   const targets=(await admin.query('SELECT target_type,target_id FROM privacy_job_targets WHERE job_id=$1',[deletion.id])).rows;
   const ids=type=>targets.filter(row=>row.target_type===type).map(row=>row.target_id).sort();
   assert.deepEqual(ids('META_COEXISTENCE_SUBJECT_CUTOFF'),[coexistenceSubjectDigest(tenantId,context.app_id,context.phone_id,phone)]);
   assert(ids('META_COEXISTENCE_EVENT').includes(pendingHistory.id));assert(ids('META_COEXISTENCE_EVENT').includes(pendingContacts.id));
   assert.equal(ids('META_COEXISTENCE_MESSAGE').length,1);assert.equal(ids('META_COEXISTENCE_CONTACT').length,1);
   assert(ids('META_DIRECT_IDENTITY_EVENT').includes(ordinary.event.id));assert(ids('META_DIRECT_ALIAS').includes(ordinary.alias));
   if(index===0){
   const beforeDenied=(await admin.query('SELECT id,payload FROM event_inbox WHERE id=ANY($1::uuid[]) ORDER BY id',[[pendingHistory.id,pendingContacts.id]])).rows;
   await assert.rejects(privacy.finalize(deletion,randomUUID()),/lease was lost/);
   await admin.query("UPDATE privacy_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[deletion.id]);
   await assert.rejects(privacy.finalize(deletion,deletion.leaseId),/lease was lost/);
   assert.deepEqual((await admin.query('SELECT id,payload FROM event_inbox WHERE id=ANY($1::uuid[]) ORDER BY id',[[pendingHistory.id,pendingContacts.id]])).rows,beforeDenied);
   await admin.query("UPDATE privacy_jobs SET lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",[deletion.id]);
   }
   await acknowledge(deletion);await privacy.finalize(deletion,deletion.leaseId);
   assert.equal((await admin.query('SELECT state FROM privacy_jobs WHERE id=$1',[deletion.id])).rows[0].state,'SUCCEEDED');
   for(const row of (await admin.query('SELECT payload FROM event_inbox WHERE id=ANY($1::uuid[])',[[pendingHistory.id,pendingContacts.id]])).rows){
    assert.deepEqual([...row.payload.messages,...row.payload.contacts].map(item=>item.subject),[otherPhone]);
   }
   for(const event of leased)await inbound.projectCoexistence(event,inboxLease,appId);
   await http.send(context,'history',history(chunk+2,[text(prefix+'-late')]));
   await http.send(context,'smb_app_state_sync',{state_sync:contacts([phone]).state_sync.map(row=>({...row,metadata:{timestamp:String(now+2)}}))});
   await drain.drainTenant(tenantId);
   for(const table of ['meta_coexistence_messages','meta_coexistence_contacts']){
    assert.equal((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE context_id=$1 AND subject_phone=$2`,[context.id,phone])).rows[0].n,0);
    assert((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE context_id=$1 AND subject_phone=$2`,[context.id,otherPhone])).rows[0].n>0);
    assert((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE context_id=$1 AND subject_phone=$2`,[otherContext.id,phone])).rows[0].n>0);
   }
   await tx(async c=>{
    assert.equal((await c.query('SELECT app.meta_direct_transition_anchor_valid($1,$2,$3,false) valid',[ordinary.event.id,ordinary.participant,customer])).rows[0].valid,false);
    assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[ordinary.alias,phone,customer])).rows[0].valid,false);
    await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId,conversationId:ordinary.current,appId}),error=>error.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED');
   });
   assert.equal((await admin.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[ordinary.event.id])).rows[0].meta_direct_native_anchor.redacted,true);
   assert.deepEqual(await exported(customer),{messages:[],contacts:[]},'Deleted/redacted provenance and late data never restore a native subject');
   for(const [table,column] of [['participant_identities','external_participant_id'],['meta_direct_identity_aliases','value'],['normalized_messages','external_participant_id'],['bot_conversations','external_chat_id'],['delivery_outbox','external_chat_id']])assert.equal((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND connection_id=$2 AND ${column}=$3`,[tenantId,context.connection_id,phone])).rows[0].n,0,table+' has no late restored ordinary authority');
  }
 }finally{
  try{await admin.query('UPDATE retention_policies SET state=$2,resolved_case_days=$3,include_open_cases=$4 WHERE tenant_id=$1',[tenantId,policy.state,policy.resolved_case_days,policy.include_open_cases]);}
  finally{try{await http.close();}finally{restoreRoutingEnvironment?.();}}
 }
 async function createJob(type,scope,value){
  const id=randomUUID(),leaseId=randomUUID(),createdAt=new Date().toISOString(),snapshot=type==='RETENTION_SWEEP'?24:null;
  const disposition=type==='EXPORT'?'EXPORT_ONLY':type==='RETENTION_SWEEP'?'RETENTION_DELETE':scope==='ZAMMAD_USER'?'ZAMMAD_USER_DATA_PRIVACY':'DELETE_TICKETS';
  const row=(await admin.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,created_at,unmatched_diagnostic_hours_snapshot)
   VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$1::text,'RUNNING','DISCOVER',1,$7,clock_timestamp()+interval '5 minutes',1,$8,$9) RETURNING created_at,unmatched_diagnostic_hours_snapshot`,[id,tenantId,type,scope,value,disposition,leaseId,createdAt,snapshot])).rows[0];
  assert.equal(row.created_at.toISOString(),createdAt);assert.equal(row.unmatched_diagnostic_hours_snapshot,snapshot);
  const job={id,tenantId,jobType:type,scopeType:scope,scopeValue:value,disposition,leaseId,createdAt,stage:'DISCOVER',state:'RUNNING',fencingToken:1,attempts:1,maxAttempts:25,unmatchedDiagnosticHours:24,exportTtlHours:24};
  if(type==='EXPORT'){await privacy.discover(job,leaseId);job.stage='EXPORT';}
  return job;
 }
 async function exported(customer){const job=await createJob('EXPORT','ZAMMAD_USER',customer);try{return(await privacy.exportData(job,job.leaseId)).metaCoexistence;}finally{await admin.query('DELETE FROM privacy_jobs WHERE id=$1',[job.id]);}}
 async function acknowledge(job){await admin.query(`UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN ${externalTypes}`,[job.id]);}
}

async function anotherContext(f){
 f.nextPhone();const start=await f.service.start(f.request,{name:'Native privacy isolation context',payerMode:'CUSTOMER',idempotencyKey:randomUUID(),variant:'BUSINESS_APP',coexistenceConsent:{version:'2026-10-07',contacts:true,history:true,echoes:true}});
 const choices=await f.service.exchange(f.request,start.attemptId,{challenge:start.challenge,code:randomUUID(),expectedRevision:start.revision});
 const selected=await f.controller.signupSelect(f.request,start.attemptId,{expectedRevision:choices.revision,selectionRevision:choices.selectionRevision,choiceId:choices.choices[0].choiceId});
 assert.equal((await f.processor.drainTenant(f.tenantId)).succeeded,1);
 assert.equal((await f.service.get(f.request,start.attemptId)).status,'COMPLETED','Normal signup read settles successful provisioning before privacy');
 const lease=randomUUID(),[job]=await f.worker.claim(f.tenantId,lease,1);assert.equal(job.operationType,'SYNC_META_APP');assert.equal(job.connectionId,selected.connectionId);
 const session=await f.worker.acquireProviderSessionLease(job,lease,'native-privacy-isolation');
 for(const kind of ['contacts','history']){assert.equal(await f.worker.coexistenceRequest(job,lease,session,kind,'CLAIMED'),true);await f.worker.coexistenceRequest(job,lease,session,kind,'ACCEPTED','synthetic-'+kind+'-'+randomUUID());}
 await f.worker.finishCoexistence(job,lease,session);
 return(await f.admin.query('SELECT * FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2',[f.tenantId,selected.connectionId])).rows[0];
}

async function signedIngress(f){
 const secret='synthetic-coexistence-native-hmac';
 // Bind the existing actual app pool without transferring its lifecycle to the
 // short-lived HTTP test module. Closing this module must not close f.db.
 const database=Object.fromEntries(['resolveMetaWebhookRoute','resolveMetaIdentityWebhookRoute','acceptWebhookEvent','acceptMetaCoexistenceEvent'].map(name=>[name,f.db[name].bind(f.db)]));
 class NativePrivacyModule{}
 Module({controllers:[WebhookIngressController],providers:[{provide:DatabaseService,useValue:database},{provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
  {provide:TenantDrainService,useValue:{wakeInbound:async()=>{}}},{provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}]})(NativePrivacyModule);
 const app=await NestFactory.create(NativePrivacyModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
 await app.init();await app.getHttpAdapter().getInstance().ready();
 return{close:()=>app.close(),send:async(context,field,data)=>{
  const value={messaging_product:'whatsapp',metadata:{phone_number_id:context.phone_id,display_phone_number:context.business_phone},...data};
  const payload=JSON.stringify({object:'whatsapp_business_account',entry:[{id:context.waba_id,changes:[{field,value}]}]});
  const response=await app.inject({method:'POST',url:'/webhooks/meta',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(payload).digest('hex')},payload});
  assert.equal(response.statusCode,200);
  const ids=field==='messages'?data.messages.map(message=>message.id):metaCoexistenceUnits(context.waba_id,field,value).map(unit=>`coexistence:${unit.kind}:${unit.key}`);
  const rows=(await f.admin.query('SELECT * FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider_event_id=ANY($3::text[]) ORDER BY id',[f.tenantId,context.connection_id,ids])).rows;
  assert.equal(rows.length,ids.length);return rows;
 }};
}

async function nativeOrigin(f,http,tx,{phone,customer,ticket,prefix}){
 const {admin,tenantId,context,request,inbound,appId}=f,connectionId=context.connection_id;
 const message={id:prefix+'-ordinary',from:phone,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Synthetic ordinary native producer'}};
 const contacts=[{wa_id:phone,user_id:'SA.'+prefix.replaceAll('-','')}],event=(await http.send(context,'messages',{messages:[message],contacts}))[0],lease=randomUUID();
 const [claimed]=await inbound.claim(tenantId,lease,1);assert.equal(claimed.id,event.id);
 const input={provider:'meta',connectionId,messageId:message.id,chatId:phone,senderId:phone,senderPhone:'+'+phone,fromMe:false,timestamp:new Date().toISOString(),input:{type:'text',text:message.text.body},metaIdentity:parseMetaDirectIdentity(message,contacts).identity};
 await tx(c=>resolveMetaDirectMessage(c,claimed,lease,input,appId));
 const participant=(await admin.query('SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,connectionId,phone])).rows[0].id;
 const alias=(await admin.query("SELECT id FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 AND kind='PHONE'",[participant])).rows[0].id;
 let assignment=(await admin.query('SELECT id,flow_version_id FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId])).rows[0];
 if(!assignment){
  const family=randomUUID(),version=randomUUID(),id=randomUUID(),definition={schemaVersion:1,name:'Native import privacy',start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]};
  await admin.query('INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)',[family,tenantId,prefix,request.principal.userId]);
  await admin.query("INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at) VALUES($1,$2,$3,1,'ACTIVE',$4,$5,$6,$6,clock_timestamp())",[version,tenantId,family,definition,sha(definition),request.principal.userId]);
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by) VALUES($1,$2,$3,$4,$5,'Operations','ACTIVE',$6,$6)",[id,tenantId,connectionId,family,version,request.principal.userId]));
  assignment={id,flow_version_id:version};
 }
 const conversation=randomUUID(),current=randomUUID(),currentTicket=String(Number(ticket)+100);
 const addConversation=(id,nativeTicket)=>withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,normalized_reference,zammad_customer_id,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,$8,$9,$10::timestamptz)",[id,tenantId,assignment.id,connectionId,assignment.flow_version_id,phone,nativeTicket,'BOT-'+sha(id).slice(0,12).toUpperCase(),Number(customer),input.timestamp]));
 await addConversation(conversation,ticket);
 const directContext={assignmentId:assignment.id,assignmentZammadGroup:'Operations',connectionName:'Business app fixture',zammadGroup:'Operations',zammadBaseUrl:'https://native.invalid',zammadSecretReference:`secret://${tenantId}/native`,connectionSecretReference:`secret://${tenantId}/connections/${connectionId}/meta`,providerSessionId:context.phone_id,mediaEnabled:false,retentionDays:30};
 const result=await inbound.processDirectMessage(claimed,directContext,input,{id:Number(customer),login:prefix+'@example.invalid'},{create:async()=>assert.fail('Existing native conversation must append'),append:async id=>{assert.equal(id,ticket);await inbound.assertMetaDirectIdentityCurrent(claimed,lease,phone,appId);return String(Number(ticket)+200);}});
 assert.equal(result.state,'HUMAN');assert.equal(result.queued,false);
 await tx(async c=>{assert.equal((await c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[event.id])).rows[0].sealed,true);await c.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL,processed_at=clock_timestamp() WHERE id=$1 AND lease_id=$2",[event.id,lease]);});
 await admin.query("UPDATE bot_conversations SET state='RESOLVED',resolved_at='2000-01-01',resolution_kind='OPERATOR',last_activity_at='2000-01-01' WHERE id=$1",[conversation]);
 await addConversation(current,currentTicket);
 // Same synthetic external acknowledgment convention as the incumbent P03 PG
 // fixture. It does not create native/customer/alias provenance.
 await admin.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND conversation_id=ANY($2::uuid[])',[tenantId,[conversation,current]]);
 return{event,participant,alias,current,currentTicket};
}

async function authorityRows(f,connectionId){
 const result={};for(const table of ['normalized_messages','message_links','participant_identities','meta_direct_identity_aliases','bot_conversations','delivery_outbox'])result[table]=(await f.admin.query(`SELECT to_jsonb(row) value FROM ${table} row WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id`,[f.tenantId,connectionId])).rows;
 result.botEvents=(await f.admin.query('SELECT to_jsonb(event) value FROM bot_conversation_events event JOIN bot_conversations conversation ON conversation.tenant_id=event.tenant_id AND conversation.id=event.conversation_id WHERE event.tenant_id=$1 AND conversation.connection_id=$2 ORDER BY event.id',[f.tenantId,connectionId])).rows;
 return result;
}
