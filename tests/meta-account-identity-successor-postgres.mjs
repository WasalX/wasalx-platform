import {withFixtureTenant,routingFixtureEnvironment,observeRoutingFixture} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {Client} from 'pg';
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
import {MetaRoutingService} from '../services/control-api/dist/meta-routing.service.js';
import {ConnectionOperationProcessor} from '../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {resolveMetaDirectMessage,reconsiderMetaIdentityTransitions} from '../services/connector-worker/dist/services/connector-worker/src/meta-direct-identity.js';
import {parseMetaDirectIdentity} from '../services/connector-worker/dist/packages/core/src/meta-direct-identity.js';
import {metaRoutingRuntime} from '../packages/core/dist/meta-routing.js';
import {assertMetaDirectEffectCurrent} from '../packages/core/dist/meta-direct-identity.js';
import {createMetaTransitionExecutionFixture} from './meta-account-transition-execution-fixture-postgres.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const phone='15550003101',bsuid='SA.identitysource',nextBsuid='SA.identitysuccessor',lastBsuid='SA.identitylate';

/** Existing disposable canonical database only. Real controller, role, trigger,
 * operation and privacy consumers; intercepted provider/native fixtures remain
 * SIMULATED. No account receipt, reservation, checkpoint or alias lineage seed. */
export async function verifyMetaAccountIdentitySuccessorPostgres(options){
 for(const scenario of ['ordinary-working','ordinary-working-preblocked','settlement','marker-after-queue','bridged-history']){
  const fixture=await createMetaTransitionExecutionFixture(options);let http;
  try{
   http=await identityHttp(fixture,options.appUrl);
   const original=await seedOrdinaryAnchor(fixture,http);
   await exactExecutorBoundary(fixture,options);
   if(scenario.startsWith('ordinary-working')){await ordinaryWorkingDrain(fixture,http,original,scenario==='ordinary-working-preblocked');continue;}
   const planId=await fixture.createPreview();await fixture.providerComplete(planId);
   await pausedIngressFences(fixture,http);
   const before=await snapshot(fixture,planId),originalScope=(await fixture.plan(planId)).execution_scope;
   const changed=await http.send(change(randomUUID(),bsuid,nextBsuid),fixture.providerAccountId);
   const prepared=await fixture.action(planId,'RECONCILE',randomUUID(),await fixture.confirmation(planId)),work=await fixture.claim();
   assert.equal(work.job.id,prepared.operationId);
   assert.deepEqual(work.job.payload.metaAccountTransitionExecution.observerOperationIds,{},'The no-renewal path still pins an explicit empty observer map');
   const observation=(await fixture.admin.query('SELECT result FROM connection_operations WHERE id=$1',[(await fixture.plan(planId)).provider_observation_operation_id])).rows[0].result.metaTransitionObservation;
   assert(observation.targetAssets.every(asset=>Object.hasOwn(asset,'observerOperationId')&&asset.observerOperationId===null));
   await fixture.tx(fixture.worker,fixture.tenantId,async c=>{
    assert.equal((await c.query('SELECT app.meta_transition_observer_credential($1,$2,NULL) value',[planId,fixture.sourceBindingId])).rows[0].value,null);
    await c.query('SAVEPOINT unselected_observer');
    await assert.rejects(c.query('SELECT app.meta_transition_observer_credential($1,$2,$3)',[planId,fixture.sourceBindingId,randomUUID()]),error=>error.code==='55000'&&error.message==='Selected observer changed');
    await c.query('ROLLBACK TO SAVEPOINT unselected_observer');
   });
   assert.deepEqual((await fixture.plan(planId)).execution_scope,originalScope,'Provider reservation scope is never refreshed by local recovery');
   assert.notEqual(work.job.payload.metaAccountTransitionExecution.localIdentityScope[0].identitySha256,originalScope.bindings[0].identitySha256);
   for(const pool of [fixture.app,fixture.worker])await fixture.tx(pool,fixture.tenantId,async client=>{
    for(const signature of ['app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint)','app.meta_account_transition_identity_reconciliation(uuid,uuid,uuid,bigint)'])
     assert.equal((await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') allowed',[signature])).rows[0].allowed,false);
    assert.equal((await client.query('SELECT app.meta_account_identity_metadata_current($1,$2) allowed',[fixture.connectionId,changed.meta_direct_asset])).rows[0].allowed,false);
   });
   if(scenario==='marker-after-queue'){
    const laterMarker=await http.send(change(randomUUID(),nextBsuid,lastBsuid,1),fixture.providerAccountId);
    assert.deepEqual(laterMarker.meta_direct_asset,changed.meta_direct_asset,'The post-queue marker is attributed to the exact source asset');
    assert.equal(laterMarker.meta_direct_identity_resolution,null,'The signed post-queue marker remains unresolved');
    const unchanged=await snapshot(fixture,planId),traffic=structuredClone(fixture.traffic);
    const staleContext=await fixture.store.transitionExecutionContext(work.job,work.lease,fixture.appId);
    assert.equal(staleContext.facts.scopeCurrent,false,'A post-queue signed marker invalidates the queued identity scope');
    assert.equal(await fixture.store.reconcileTransition(work.job,work.lease,fixture.appId),false,'Stale identity scope denies reconciliation through the boolean admission contract');
    assert.deepEqual(await snapshot(fixture,planId),unchanged,'A post-queue signed marker invalidates local CAS without partial successor writes');
    assert.deepEqual(fixture.traffic,traffic,'Local reconciliation cannot replay a provider request');
    for(const account of [null,'999999999991']){
     const held=await http.send(change(randomUUID(),nextBsuid,'SA.unattributed'),account);
     assert.equal(held.meta_direct_identity_change.scope,'ASSET');assert.equal(held.meta_direct_identity_transition,null);
     assert.equal(held.payload.entry[0].id,account??undefined,'Unknown account attribution never replaces the signed source');
    }
    await http.send(change(randomUUID(),nextBsuid,'SA.unsigned'),fixture.providerAccountId,{signed:false,expected:401});
    continue;
   }
   const operationSnapshot=await snapshot(fixture,planId);
   for(const denied of [{...work,lease:randomUUID()},{...work,job:{...work.job,fencingToken:work.job.fencingToken+1}}]){
    await assert.rejects(()=>fixture.store.reconcileTransition(denied.job,denied.lease,fixture.appId));
    assert.deepEqual(await snapshot(fixture,planId),operationSnapshot);
   }
   // Inject one finite failure at each actual write boundary. Production guards
   // remain installed; each failure must roll back the entire coordinator call.
   for(const point of ['alias','receipt','resolution'])await rollbackAt(fixture,planId,work,point);
   const posts=fixture.traffic.filter(row=>row.method==='POST');
   await fixture.executeQueued(work);
   assert.deepEqual(fixture.traffic.filter(row=>row.method==='POST'),posts);
   const plan=await fixture.plan(planId),after=await snapshot(fixture,planId);
   assert.equal(plan.execution_state,'RECONCILED_PAUSED');assert.equal(plan.identity_successor_receipt.operationId,work.job.id);
   assert.deepEqual(plan.execution_scope,originalScope);
   assert.equal(after.sessions.filter(row=>row.ownership_state==='ACTIVE').length,1);
   const target=after.sessions.find(row=>row.ownership_state==='ACTIVE');
   assert.equal(target.state,'PAUSED');assert.notEqual(target.id,fixture.providerSessionId);
   assert.equal(after.connection.state,'PAUSED');assert.equal(after.aliases.filter(row=>row.provider_session_id===fixture.providerSessionId&&row.state==='RETIRED').length,2);
   for(const pool of [fixture.app,fixture.worker]){
    assert.equal((await fixture.tx(pool,fixture.tenantId,c=>c.query("SELECT has_function_privilege(current_user,'app.meta_add_access_activating(uuid)','EXECUTE') allowed"))).rows[0].allowed,false);
    await assert.rejects(()=>fixture.tx(pool,fixture.tenantId,c=>c.query("UPDATE connections SET state='WORKING' WHERE tenant_id=$1 AND id=$2",[fixture.tenantId,fixture.connectionId])),error=>error.code==='55000'&&error.message==='Successor activation is not current');
   }
   for(const retired of after.aliases.filter(row=>row.provider_session_id===fixture.providerSessionId&&row.state==='RETIRED')){
    assert.equal((await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.meta_account_alias_has_valid_successor($1) valid',[retired.id]))).rows[0].valid,true,'Exact completed successor lineage validates the retired alias');
    assert.equal((await fixture.tx(fixture.worker,fixture.foreignTenantId,c=>c.query('SELECT app.meta_account_alias_has_valid_successor($1) valid',[retired.id]))).rows[0].valid,false,'Foreign tenant cannot observe predecessor lineage authority');
   }
   assert(after.aliases.some(row=>row.provider_session_id===target.id&&row.value===nextBsuid&&row.state==='ACTIVE'));
   assert.deepEqual(after.participants,before.participants);assert.deepEqual(after.conversations,before.conversations);
   assert.deepEqual(after.normalized,before.normalized);assert.deepEqual(after.links,before.links);
   const signed=(await fixture.admin.query('SELECT * FROM event_inbox WHERE id=$1',[changed.id])).rows[0];
   assert.deepEqual(signed.meta_direct_asset,changed.meta_direct_asset);assert.equal(signed.payload_sha256,changed.payload_sha256);
   assert.equal(signed.meta_direct_identity_resolution.accountTransitionId,planId);
   assert.equal(signed.meta_direct_identity_resolution.targetAsset.providerSessionId,target.id);
   assert.equal((await fixture.admin.query('SELECT result FROM connection_operations WHERE id=$1',[work.job.id])).rows[0].result.metaTransitionIdentityReconciliation.status,'SETTLED');
   assert.equal((await fixture.admin.query('SELECT count(*)::int n FROM meta_account_transition_reservations WHERE transition_id=$1 AND released_at IS NULL',[planId])).rows[0].n,0);
   await assert.rejects(()=>fixture.tx(fixture.worker,fixture.tenantId,c=>c.query("UPDATE connection_operations SET result='{}' WHERE id=$1",[work.job.id])));
   const historical=structuredClone(after),historicalPlan=structuredClone(plan);
   assert.equal((await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.meta_account_identity_receipt_valid($1) valid',[planId]))).rows[0].valid,true);
   assert.deepEqual(await snapshot(fixture,planId),historical);assert.deepEqual(await fixture.plan(planId),historicalPlan);
   if(scenario==='bridged-history'){
    await bridgedDuplicateAndFork(fixture,http,planId,target,changed);continue;
   }
   await pausedLateRecovery(fixture,http,planId,target,original);
   await privacyLineage(fixture,original);
   await privacyRetentionAndDeletion(fixture,http,original,planId);
  }finally{if(http)await http.close();await fixture.close();}
 }
}

async function snapshot(fixture,planId){
 const {admin,tenantId,connectionId}=fixture;
 const rows=async(table,where,args)=>(await admin.query(`SELECT to_jsonb(t) value FROM ${table} t WHERE ${where} ORDER BY t.id`,args)).rows.map(row=>row.value);
 return{connection:(await rows('connections','id=$1',[connectionId]))[0],sessions:await rows('provider_sessions','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  bindings:await rows('meta_connection_account_bindings','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  aliases:await rows('meta_direct_identity_aliases','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  participants:await rows('participant_identities','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  conversations:await rows('bot_conversations','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  normalized:await rows('normalized_messages','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  links:await rows('message_links','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  inbox:await rows('event_inbox','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  operations:await rows('connection_operations','tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]),
  checkpoints:await rows('meta_provider_effect_checkpoints','tenant_id=$1 AND owner_id=$2',[tenantId,planId]),
  reservations:await rows('meta_account_transition_reservations','tenant_id=$1 AND transition_id=$2',[tenantId,planId]),
  plan:await fixture.plan(planId)};
}

async function rollbackAt(fixture,planId,work,point){
 const table=point==='alias'?'meta_direct_identity_aliases':point==='receipt'?'meta_account_transitions':'event_inbox';
 const when=point==='alias'?'NEW.account_transition_id IS NOT NULL':point==='receipt'?'NEW.identity_successor_receipt IS NOT NULL':'NEW.meta_direct_identity_resolution IS NOT NULL';
 const name='p09_fault_'+randomUUID().replaceAll('-','');
 await fixture.admin.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${fixture.tenantId}'::uuid AND ${when} THEN ${point==='alias'?"IF app.meta_account_alias_has_valid_successor(NEW.predecessor_alias_id) THEN RAISE EXCEPTION 'Incomplete account lineage became valid' USING ERRCODE='P0001'; END IF;":""}RAISE EXCEPTION 'Synthetic identity atomicity fault' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
 try{
  await fixture.admin.query(`CREATE TRIGGER ${name} AFTER INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  const before=await snapshot(fixture,planId);
  await assert.rejects(()=>fixture.store.reconcileTransition(work.job,work.lease,fixture.appId),error=>error.code==='P0001'&&error.message==='Synthetic identity atomicity fault');
  assert.deepEqual(await snapshot(fixture,planId),before,point+' failure rolls back source/target/session/alias/receipt together');
 }finally{await fixture.admin.query(`DROP TRIGGER IF EXISTS ${name} ON public.${table}`);await fixture.admin.query(`DROP FUNCTION public.${name}()`);}
}

function change(id,previous,current,offset=0){return{id,type:'system',timestamp:String(Math.floor(Date.now()/1000)+offset),system:{type:'user_changed_user_id',previous_user_id:previous,user_id:current}};}

export async function identityHttp(fixture,appUrl){
 const keys=['DATABASE_URL','DATABASE_POOL_SIZE','META_APP_SECRET_REFERENCE','META_APP_ID'],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.DATABASE_URL=appUrl;process.env.DATABASE_POOL_SIZE='2';process.env.META_APP_SECRET_REFERENCE='secret://platform/meta-webhook';process.env.META_APP_ID=fixture.appId;
 const restoreRouting=routingFixtureEnvironment(fixture.appId);process.env.META_GRAPH_BASE_URL='https://graph.facebook.com';
  const database=new DatabaseService(),secret='synthetic-p09-identity-hmac';let app;
 try{
  class IdentityModule{}
  Module({controllers:[WebhookIngressController],providers:[{provide:DatabaseService,useValue:database},
   {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},{provide:TenantDrainService,useValue:{wakeInbound:async()=>{}}},
   {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}]})(IdentityModule);
  app=await NestFactory.create(IdentityModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  await app.init();await app.getHttpAdapter().getInstance().ready();
  const send=async(message,account=fixture.providerAccountId,{signed=true,expected=200,admitted=true,contacts,phoneNumberId=fixture.phoneNumberId}={})=>{
   const body={object:'whatsapp_business_account',entry:[{...(account===null?{}:{id:account}),changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},messages:[message],...(contacts?{contacts}:{})}}]}]},payload=JSON.stringify(body);
   const response=await app.inject({method:'POST',url:'/webhooks/meta',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+(signed?createHmac('sha256',secret).update(payload).digest('hex'):'0'.repeat(64))},payload});
   assert.equal(response.statusCode,expected);
   const row=(await fixture.admin.query('SELECT * FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider_event_id=$3',[fixture.tenantId,fixture.connectionId,message.id])).rows[0];
   if(expected===200&&admitted)assert(row);else assert.equal(row,undefined);
   return row;
  };
  return{send,database,close:async()=>{await app.close();restoreRouting();for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}};
 }catch(error){if(app)await app.close();else await database.onModuleDestroy();restoreRouting();for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];throw error;}
}

async function pausedIngressFences(fixture,http){
 const route=async()=>(await fixture.admin.query('SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2',[fixture.tenantId,fixture.connectionId])).rows[0].state;
 assert.equal(await route(),'PAUSED','Provider completion leaves ordinary ingress disabled');
 const ordinary=()=>({id:randomUUID(),from:phone,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Paused ordinary message'}});
 await http.send(ordinary(),fixture.providerAccountId,{admitted:false});
 await http.send({...ordinary(),timestamp:'0'},fixture.providerAccountId,{admitted:false});
 await http.send({id:randomUUID(),type:'unsupported',timestamp:'not-a-time'},fixture.providerAccountId,{admitted:false});
 await http.send(ordinary(),fixture.targetProviderAccountId,{admitted:false});
 await http.send(change(randomUUID(),bsuid,nextBsuid),fixture.providerAccountId,{signed:false,expected:401});
 await http.send(change(randomUUID(),bsuid,nextBsuid,-8*86400),fixture.providerAccountId,{expected:401});
 await http.send(change(randomUUID(),bsuid,nextBsuid),fixture.providerAccountId,{phoneNumberId:'99999999999999999999999999999999',admitted:false});
 const appId=process.env.META_APP_ID;process.env.META_APP_ID=fixture.appId==='99999999999999999999999999999999'?'99999999999999999999999999999998':'99999999999999999999999999999999';
 try{await http.send(change(randomUUID(),bsuid,nextBsuid),fixture.providerAccountId,{expected:404});}finally{process.env.META_APP_ID=appId;}
 assert.equal(await route(),'PAUSED','Safety probes cannot activate ordinary ingress');
}

export async function seedOrdinaryAnchor(fixture,http){
 const {admin,tenantId,connectionId,actorId}=fixture;
  // Ordinary simulated declaration plus the incumbent actual platform review.
  // Only the subsequent signed primary producer establishes thread OWN.
  const sourceSessionId=fixture.providerSessionId??fixture.sourceSessionId;
  assert.equal(typeof sourceSessionId,'string','Ordinary anchor uses the actual fixture source session');
  assert.equal((await admin.query("SELECT count(*)::integer n FROM public.provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND ownership_state='ACTIVE'",[tenantId,connectionId,sourceSessionId])).rows[0].n,1);
  await observeRoutingFixture(admin,{tenantId,connectionId,sessionId:sourceSessionId,appId:fixture.appId});
  const message={id:randomUUID(),from:phone,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Synthetic retained native identity'}};
 const row=await http.send(message,fixture.providerAccountId,{contacts:[{wa_id:phone,user_id:bsuid}]}),lease=randomUUID(),inbound=new InboundRepository(fixture.worker);
 const claimed=await inbound.claim(tenantId,lease,1);assert.equal(claimed[0]?.id,row.id);
 const input={provider:'meta',connectionId,messageId:message.id,chatId:phone,senderId:phone,senderPhone:'+'+phone,fromMe:false,timestamp:new Date().toISOString(),input:{type:'text',text:message.text.body},
  metaIdentity:parseMetaDirectIdentity(message,[{wa_id:phone,user_id:bsuid}]).identity};
 const resolved=await fixture.tx(fixture.worker,tenantId,c=>resolveMetaDirectMessage(c,claimed[0],lease,input,fixture.appId));
 assert.equal(resolved.chatId,phone);
 const participant=(await admin.query('SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,connectionId,phone])).rows[0].id;
 const family=randomUUID(),version=randomUUID(),assignment=randomUUID(),conversation=randomUUID(),ticket='98341',definition={schemaVersion:1,name:'Identity successor fixture',start:'done',maxSteps:2,nodes:[{id:'done',type:'end'}]};
 await admin.query('INSERT INTO bot_flow_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)',[family,tenantId,'Identity successor fixture',actorId]);
 await admin.query("INSERT INTO bot_flow_versions(id,tenant_id,family_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at) VALUES($1,$2,$3,1,'ACTIVE',$4,$5,$6,$6,clock_timestamp())",[version,tenantId,family,definition,sha(definition),actorId]);
 await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO bot_assignments(id,tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,state,created_by,updated_by) VALUES($1,$2,$3,$4,$5,'Operations','ACTIVE',$6,$6)",[assignment,tenantId,connectionId,family,version,actorId]));
 await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,normalized_reference,zammad_customer_id,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done',$7,$7,$8,98341,clock_timestamp())",[conversation,tenantId,assignment,connectionId,version,phone,ticket,'BOT-'+sha(tenantId+':'+assignment+':'+phone).slice(0,12).toUpperCase()]));
 // Synthetic ordinary native completion, then the actual worker capsule seal.
 // These rows establish fixture evidence; they do not grant routing OWN.
 await admin.query("INSERT INTO normalized_messages(tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,message_text,provider_timestamp,provider_metadata,processing_status) VALUES($1,$2,$3,$4,$5,$5,'Synthetic ordinary completion',clock_timestamp(),$6,'COMPLETE')",[tenantId,row.id,connectionId,message.id,phone,{direct:true,zammad_customer_id:98341}]);
 await admin.query("INSERT INTO message_links(tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction) VALUES($1,$2,$3,$4,'98342','INBOUND')",[tenantId,connectionId,message.id,ticket]);
 await fixture.tx(fixture.worker,tenantId,async c=>{assert.equal((await c.query('SELECT app.seal_meta_direct_native_anchor($1) sealed',[row.id])).rows[0].sealed,true);
  await c.query("UPDATE event_inbox SET status='PROCESSED',processed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_id=$3",[tenantId,row.id,lease]);});
 // Explicit synthetic acknowledgment of the seeded native projection, using
 // the same fixture convention as the incumbent P03 PostgreSQL helper.
 await admin.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND conversation_id=$2',[tenantId,conversation]);
 return{eventId:row.id,participant,conversation,ticket,phone,bsuid,assignment,version};
}

async function pausedLateRecovery(fixture,http,planId,target,original){
 const late=await http.send(change(randomUUID(),nextBsuid,lastBsuid,1),fixture.providerAccountId);
 assert.equal(late.meta_direct_asset.providerSessionId,fixture.providerSessionId,'Retired signed source remains the original session');
 assert.equal((await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) clear',[fixture.connectionId,target.id,fixture.phoneNumberId,fixture.targetProviderAccountId,original.participant]))).rows[0].clear,false);
 const inbound=new InboundRepository(fixture.worker),lease=randomUUID(),claimed=await inbound.claim(fixture.tenantId,lease,1);assert.equal(claimed[0].id,late.id);
 await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.drain_meta_direct_transitions($1,$2,false)',[late.id,lease]));
 const held=(await fixture.admin.query('SELECT status,safe_error,lease_id,meta_direct_identity_transition,meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[late.id])).rows[0];
 assert.equal(held.status,'QUARANTINED');assert.equal(held.safe_error,'META_IDENTITY_TRANSITION_PENDING_CURRENT');assert.equal(held.lease_id,null);assert(held.meta_direct_identity_transition);assert.equal(held.meta_direct_identity_resolution,null);
 assert.deepEqual(await inbound.claim(fixture.tenantId,randomUUID(),1),[],'PAUSED metadata never returns to generic inbox processing');
 const scan=()=>fixture.tx(fixture.worker,fixture.tenantId,async c=>(await c.query('SELECT app.scan_meta_direct_transition_work(32,NULL) value')).rows[0].value);
 assert(!(await scan()).ready.some(row=>row.eventId===late.id));
 await fixture.tx(fixture.worker,fixture.tenantId,c=>reconsiderMetaIdentityTransitions(c,fixture.tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[late.id]},fixture.appId));
 assert.deepEqual((await fixture.admin.query('SELECT status,safe_error,lease_id,meta_direct_identity_transition,meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[late.id])).rows[0],held);
 await activateSuccessor(fixture,target);
 assert((await scan()).ready.some(row=>row.eventId===late.id),'Explicit GET-only START unblocks normal metadata recovery without requiring identity-clear');
 await fixture.tx(fixture.worker,fixture.tenantId,c=>reconsiderMetaIdentityTransitions(c,fixture.tenantId,{conversationIds:[],deliveryIds:[],ticketIds:[],sourceEventIds:[late.id]},fixture.appId));
 const settled=(await fixture.admin.query('SELECT status,meta_direct_identity_resolution FROM event_inbox WHERE id=$1',[late.id])).rows[0];
 assert.equal(settled.status,'PROCESSED');assert.equal(settled.meta_direct_identity_resolution.state,'APPLIED');
 assert.equal((await fixture.plan(planId)).identity_successor_receipt.operationId,(await fixture.plan(planId)).execution_operation_id);
 const retiredOrdinaryBefore=await snapshot(fixture,planId);
 // Ordinary routing evidence must match the current WABA; only signed system
 // identity recovery can use the sealed predecessor exception.
 await http.send({id:randomUUID(),from:phone,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Retired ordinary input'}},fixture.providerAccountId,{expected:404});
 assert.deepEqual(await snapshot(fixture,planId),retiredOrdinaryBefore,'Retired ordinary input creates no inbox, identity, native link or provider operation effect');
 const counters=await fixture.admin.query('SELECT (SELECT count(*) FROM normalized_messages WHERE tenant_id=$1) normalized,(SELECT count(*) FROM delivery_outbox WHERE tenant_id=$1) deliveries',[fixture.tenantId]);
 assert.equal(counters.rows[0].normalized,'1');assert.equal(counters.rows[0].deliveries,'0');
}

async function activateSuccessor(fixture,target){
 const db={withTenant:(tenant,fn)=>fixture.tx(fixture.app,tenant,fn)},routing=new MetaRoutingService(db,{}),runtime=metaRoutingRuntime(process.env);
 const config=await routing.configuration(fixture.request,fixture.connectionId);
 await routing.declare({...fixture.request,headers:{origin:process.env.PORTAL_PUBLIC_ORIGIN}},fixture.connectionId,randomUUID(),{expectedSessionId:target.id,expectedVersion:config.configurationVersion,fallback:'HOLD'});
 const declared=await routing.configuration(fixture.request,fixture.connectionId),body={expectedSessionId:target.id,expectedConfigurationVersion:declared.configurationVersion,expectedReviewVersion:declared.reviewVersion,
  disposition:'REVIEWED',observedAt:new Date().toISOString(),evidenceSha256:sha('synthetic-identity-routing-review'),evidenceReference:'synthetic-p09-identity',scope:'PHONE_OVERRIDE',roles:['customer_service'],targets:[],fields:['messages','standby','messaging_handovers'],termsAccepted:true,threadControlEnabled:true,personallyObserved:true};
 await fixture.tx(fixture.platform,fixture.tenantId,c=>c.query('SELECT app.operator_record_meta_routing_review($1,$2,$3,$4,$5,$6,$7,$8,$9)',[fixture.tenantId,fixture.connectionId,body,fixture.appId,runtime,randomUUID(),sha(body),'synthetic-p09-reviewer','synthetic-p09-request']));
 const view=await fixture.controller.metaSavedAccessActivation(fixture.request,fixture.connectionId);assert.equal(view.reason,'READY_TO_CHECK');
 const activation=await fixture.controller.activateMetaSavedAccess({...fixture.request,headers:{origin:process.env.PORTAL_PUBLIC_ORIGIN}},fixture.connectionId,randomUUID(),{expectedContextVersion:view.contextVersion});
 const originalFetch=globalThis.fetch,gets=[];
 globalThis.fetch=async(raw,init={})=>{const url=new URL(String(raw));assert.equal(url.origin,'https://graph.facebook.com');assert.equal(init.method??'GET','GET');gets.push(url.pathname);
  if(url.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:fixture.phoneNumberId,status:'CONNECTED',code_verification_status:'VERIFIED',host_platform:'CLOUD_API',account_mode:'LIVE'}]});
  if(url.pathname.endsWith('/subscribed_apps'))return Response.json({data:[{whatsapp_business_api_data:{id:fixture.appId}}]});
  if(url.searchParams.get('fields')==='health_status')return Response.json({health_status:{can_send_message:'AVAILABLE',entities:[['PHONE_NUMBER',fixture.phoneNumberId],['WABA',fixture.targetProviderAccountId],['APP',fixture.appId]].map(([entity_type,id])=>({entity_type,id,can_send_message:'AVAILABLE'}))}});
  if(url.pathname===`/v24.0/${fixture.phoneNumberId}`)return Response.json({id:fixture.phoneNumberId,is_on_biz_app:false,platform_type:'CLOUD_API'});
  assert.fail('Unexpected successor activation GET '+url.pathname);};
 try{const processor=new ConnectionOperationProcessor(fixture.operations,{resolve:async reference=>{assert.equal(reference,fixture.secretReference);return{accessToken:'synthetic-managed-account-token'};}},
   {wahaBaseUrl:'https://unused.example.invalid',publicWebhookBaseUrl:'https://portal.example.invalid',metaGraphVersion:'v24.0',metaAppId:fixture.appId,workerIdentity:'successor-activation-fixture'});
  const drained=await processor.drainTenant(fixture.tenantId);
  const disposition=(await fixture.admin.query("SELECT state,error_code,safe_error,result->>'superseded' AS superseded,result->>'reason' AS reason FROM connection_operations WHERE tenant_id=$1 AND id=$2",[fixture.tenantId,activation.operation.id])).rows[0];
  assert.equal(drained.succeeded,1,JSON.stringify({drained,disposition}));assert.equal(disposition.state,'SUCCEEDED');assert.notEqual(disposition.superseded,'true');assert(gets.length>0);
 }finally{globalThis.fetch=originalFetch;}
 assert.equal((await fixture.admin.query('SELECT state FROM connections WHERE id=$1',[fixture.connectionId])).rows[0].state,'WORKING');
 // Read actual current authority after the real activation producer. A retained
 // source binding must neither provide funding nor win the new birth lookup.
 const bindings=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query(`SELECT b.*,a.provider_account_id,a.authority_revision
  FROM public.meta_connection_account_bindings b JOIN public.meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
  WHERE b.tenant_id=$1 AND b.connection_id=$2 ORDER BY b.created_at,b.id`,[fixture.tenantId,fixture.connectionId]))).rows;
 const active=bindings.filter(row=>row.state==='ACTIVE');assert.equal(active.length,1);assert.equal(active[0].provider_session_id,target.id);
 assert(bindings.some(row=>row.id===fixture.sourceBindingId&&row.state==='RETIRED'));
 const birth=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.meta_billing_birth_snapshot($1) value',[fixture.connectionId]))).rows[0].value;
 assert.equal(birth.bindingId,active[0].id);assert.equal(birth.accountId,active[0].account_id);assert.equal(birth.providerAccountId,fixture.targetProviderAccountId);
 const funding=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT * FROM app.meta_billing_send_guard($1,$2,$3,$4,$5,$6)',
  [fixture.connectionId,target.id,fixture.phoneNumberId,fixture.targetProviderAccountId,active[0].authority_revision,active[0].revision]))).rows[0];
 assert.equal(funding.allowed,true,'Current funding is distinct from per-message routing OWN admission');
 assert.equal(funding.account_id,active[0].account_id);
}


async function privacyLineage(fixture,original){
 const privacy=new PrivacyRepository(fixture.worker),id=randomUUID(),lease=randomUUID();
 const created=(await fixture.admin.query("INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,created_at) VALUES($1,$2,'EXPORT','PARTICIPANT',$3,'EXPORT_ONLY',$1::uuid::text,'RUNNING','DISCOVER',1,$4,clock_timestamp()+interval '10 minutes',1,clock_timestamp()) RETURNING created_at",[id,fixture.tenantId,original.phone,lease])).rows[0].created_at;
 const job={id,tenantId:fixture.tenantId,leaseId:lease,jobType:'EXPORT',scopeType:'PARTICIPANT',scopeValue:original.phone,disposition:'EXPORT_ONLY',state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:1,createdAt:created.toISOString(),unmatchedDiagnosticHours:24,exportTtlHours:24,zammadBaseUrl:'https://native.invalid',zammadPrivacySecretReference:`secret://${fixture.tenantId}/native/privacy`};
 await privacy.discover(job,lease);job.stage='EXPORT';const exported=await privacy.exportData(job,lease),serialized=JSON.parse(JSON.stringify(exported));
 const inherited=serialized.metaDirectAliases.filter(row=>row.account_transition_id);
 assert.equal(inherited.length,2);assert(inherited.every(row=>row.predecessor_alias_id&&row.account_identity_receipt.asset.connectionId===fixture.connectionId));
 assert(inherited.every(row=>!('assets' in row.account_identity_receipt)),'Subject export cannot expose another connection from account-wide receipt');
 assert.equal(serialized.metaDirectIdentityEvents.filter(row=>row.meta_direct_identity_resolution?.state==='APPLIED').length,2);
 await withFixtureTenant(fixture.admin,fixture.tenantId,()=>fixture.admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[id]));
}

async function exactExecutorBoundary(fixture,options){
 const projectionPrivileges=(await fixture.admin.query(`SELECT
  has_column_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox','delivery_state','SELECT') state_read,
  has_column_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox','safe_error','SELECT') error_read,
  has_table_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox','SELECT') table_read,
  has_column_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox','external_message_id','SELECT') external_read,
  has_column_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox','id','SELECT') id_read,
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.zammad_status_outbox'::regclass) tenant_rls,
  (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='wasalx_meta_transition_executor') sealed_owner`)).rows[0];
 assert.deepEqual(projectionPrivileges,{state_read:true,error_read:true,table_read:false,external_read:false,id_read:false,tenant_rls:true,sealed_owner:true},'Batch projection gets only its two EXCLUDED-column reads, never broad status access');
 const activationGuard=(await fixture.admin.query("SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig FROM pg_proc WHERE oid='app.guard_meta_successor_activation()'::regprocedure")).rows[0];
 assert.equal(activationGuard.owner,'wasalx_meta_transition_executor');assert.equal(activationGuard.prosecdef,true);
 assert(activationGuard.proconfig.includes('row_security=on'));assert(activationGuard.proconfig.some(value=>value.replaceAll(' ','')==='search_path=pg_catalog,public,app,pg_temp'));
 const untouched=await snapshot(fixture,randomUUID());
 const source={providerSessionId:fixture.providerSessionId,phoneNumberId:fixture.phoneNumberId,wabaId:fixture.providerAccountId};
 // Fresh actual sessions, before these invoker predicates have cached plans.
 // App has the incumbent tenant SELECT grant; worker does not. Neither can
 // update tenants or become the executor. False invoker results must be
 // procedural, not a 42501 hidden by a savepoint or elevated role.
 for(const [kind,config] of [['app',{connectionString:options.appUrl}],['worker',{...options.workerConfig}]]){
  const client=new Client(config);await client.connect();
  try{
   await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[fixture.tenantId]);
   const authority=(await client.query(`SELECT current_user,session_user,
    pg_has_role(session_user,'wasalx_meta_transition_executor','MEMBER') executor_member,
    has_table_privilege(current_user,'public.tenants','SELECT') tenant_select,
    has_any_column_privilege(current_user,'public.tenants','SELECT') tenant_column_select,
    has_any_column_privilege(current_user,'public.tenants','UPDATE') tenant_column_update,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser`)).rows[0];
   assert.equal(authority.current_user,kind==='app'?decodeURIComponent(new URL(options.appUrl).username):'wasalx_connector_worker');
   if(kind==='app')assert.equal((await client.query("SELECT pg_has_role(current_user,'wasalx_app','MEMBER') app_member")).rows[0].app_member,true);
   assert.equal(authority.session_user,kind==='app'?decodeURIComponent(new URL(options.appUrl).username):'wasalx_connector_worker_runtime');
   for(const field of ['executor_member','tenant_column_update','superuser'])assert.equal(authority[field],false,kind+' '+field);
   for(const field of ['tenant_select','tenant_column_select'])assert.equal(authority[field],kind==='app',kind+' '+field);
   for(const signature of ['app.meta_account_identity_metadata_current(uuid,jsonb)','app.meta_account_identity_apply_pending(uuid)']){
    const catalog=(await client.query('SELECT prosecdef,lanname FROM pg_proc JOIN pg_language ON pg_language.oid=prolang WHERE pg_proc.oid=$1::regprocedure',[signature])).rows[0];
    assert.deepEqual(catalog,{prosecdef:false,lanname:'plpgsql'});
   }
   assert.deepEqual((await client.query('SELECT app.meta_account_identity_metadata_current($1,$2) metadata_current,app.meta_account_identity_apply_pending($3) apply_pending',[fixture.connectionId,source,randomUUID()])).rows[0],{metadata_current:false,apply_pending:false});
   await client.query('COMMIT');
  }finally{await client.end();}
 }
 assert.deepEqual(await snapshot(fixture,randomUUID()),untouched,'Rejected invoker predicates write no source/session/identity/operation state');
 const worker=new Client({...options.workerConfig});await worker.connect();
 try{
  await worker.query('BEGIN');await worker.query("SELECT set_config('app.tenant_id',$1,true)",[fixture.tenantId]);
  const identity=(await worker.query('SELECT current_user,session_user')).rows[0];
  assert.equal(identity.current_user,'wasalx_connector_worker');assert.equal(identity.session_user,'wasalx_connector_worker_runtime');
  const catalog=(await worker.query(`SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig FROM pg_proc
   WHERE oid='app.apply_meta_direct_transition_edge(uuid,uuid,boolean)'::regprocedure`)).rows[0];
  assert.equal(catalog.owner,'wasalx_meta_transition_executor');assert.equal(catalog.prosecdef,true);
  assert(catalog.proconfig.includes('row_security=on'));assert(catalog.proconfig.some(value=>value.replaceAll(' ','')==='search_path=pg_catalog,public,app,pg_temp'));
  const role=(await worker.query("SELECT rolcanlogin,rolbypassrls,rolsuper FROM pg_roles WHERE rolname='wasalx_meta_transition_executor'")).rows[0];
  assert.deepEqual(role,{rolcanlogin:false,rolbypassrls:false,rolsuper:false});
  assert.equal((await worker.query("SELECT pg_has_role(session_user,'wasalx_meta_transition_executor','MEMBER') member,has_table_privilege('wasalx_meta_transition_executor','public.tenants','UPDATE') tenant_write")).rows[0].member,false);
  assert.equal((await worker.query("SELECT has_table_privilege('wasalx_meta_transition_executor','public.tenants','UPDATE') allowed")).rows[0].allowed,false);
  for(const column of ['delivery_state','safe_error'])assert.equal((await worker.query("SELECT has_column_privilege('wasalx_meta_transition_executor','public.zammad_status_outbox',$1,'SELECT') allowed",[column])).rows[0].allowed,true,'Exact sealed native projection column grant: '+column);
  await worker.query('SAVEPOINT role_denied');await assert.rejects(worker.query('SET LOCAL ROLE wasalx_meta_transition_executor'),error=>error.code==='42501');await worker.query('ROLLBACK TO SAVEPOINT role_denied');
  // Fresh session, before helper plans exist. A fabricated temp relation cannot
  // supply ancestry or an executor context; the real current asset remains readable.
  for(const table of ['meta_connection_account_bindings','meta_account_transitions','provider_sessions','event_inbox'])
   await worker.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WHERE false`);
  const source={providerSessionId:fixture.providerSessionId,phoneNumberId:fixture.phoneNumberId,wabaId:fixture.providerAccountId};
  assert.deepEqual((await worker.query('SELECT app.meta_account_identity_target_asset($1,$2) value',[fixture.connectionId,source])).rows[0].value,source);
  assert.equal((await worker.query('SELECT app.meta_account_identity_receipt_valid($1) value',[randomUUID()])).rows[0].value,false);
  assert.equal((await worker.query('SELECT app.meta_account_identity_metadata_current($1,$2) value',[fixture.connectionId,source])).rows[0].value,false);
  await worker.query("SELECT set_config('app.tenant_id',$1,true)",[fixture.foreignTenantId]);
  assert.equal((await worker.query('SELECT app.meta_account_identity_target_asset($1,$2) value',[fixture.connectionId,source])).rows[0].value,null);
  assert.equal((await worker.query('SELECT app.meta_account_identity_receipt_valid($1) value',[randomUUID()])).rows[0].value,false);
 }finally{await worker.query('ROLLBACK');await worker.end();}
 await fixture.tx(fixture.app,fixture.tenantId,async client=>{
  assert.equal((await client.query("SELECT has_function_privilege(current_user,'app.apply_meta_direct_transition_edge(uuid,uuid,boolean)','EXECUTE') allowed")).rows[0].allowed,false);
 });
}

async function ordinaryWorkingDrain(fixture,http,original,preblockedSuccessor=false){
 const batch=randomUUID(),ids=[randomUUID(),randomUUID()];
 for(let index=0;index<ids.length;index++)await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query(`INSERT INTO delivery_outbox
  (id,tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,message_body,content_type,idempotency_key,state,direct_origin,zammad_article_id,batch_id,batch_sequence,batch_part_count,blocked_by_delivery_id)
  VALUES($1,$2,$3,$4,$5,$6,'Immutable queued part','text/plain',$1::uuid::text,$10,'HUMAN',$7,$8,$9,2,$11::uuid)`,
  [ids[index],fixture.tenantId,fixture.connectionId,original.conversation,phone,original.ticket,'984'+index,batch,index,
   preblockedSuccessor&&index===1?'BLOCKED':'QUEUED',preblockedSuccessor&&index===1?ids[0]:null]));
 // Seed an existing native projection for the blocked-recovery denial oracle.
 if(preblockedSuccessor)await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query(`INSERT INTO zammad_status_outbox
  (tenant_id,delivery_id,zammad_ticket_id,delivery_state) VALUES($1,$2,$3,'QUEUED')`,[fixture.tenantId,ids[1],original.ticket]));
 const before=(await fixture.admin.query('SELECT id,message_body,idempotency_key,meta_direct_recipient FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
 const event=await http.send(change(randomUUID(),bsuid,nextBsuid)),lease=randomUUID(),inbound=new InboundRepository(fixture.worker);
 assert.equal((await inbound.claim(fixture.tenantId,lease,1))[0].id,event.id);
 const originalSource=(await fixture.admin.query('SELECT * FROM event_inbox WHERE id=$1',[event.id])).rows[0];
 if(preblockedSuccessor){
  const capture=async()=>({
   source:(await fixture.admin.query('SELECT * FROM event_inbox WHERE id=$1',[event.id])).rows,
   aliases:(await fixture.admin.query('SELECT * FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND participant_identity_id=$2 ORDER BY id',[fixture.tenantId,original.participant])).rows,
   deliveries:(await fixture.admin.query('SELECT * FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
   projections:(await fixture.admin.query('SELECT * FROM zammad_status_outbox WHERE delivery_id=ANY($1::uuid[]) ORDER BY delivery_id,zammad_ticket_id',[ids])).rows});
  const heldBefore=await capture();
  // Read-only negative through the existing sealed edge. drain's legitimate
  // quarantine side effects are separate and are not claimed to be unchanged.
  const held=await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.apply_meta_direct_transition_edge($1,$2,false) value',[event.id,lease]));
  assert.deepEqual(held.rows[0].value,{state:'HELD',reason:'PENDING_EFFECT'});
  assert.deepEqual(await capture(),heldBefore,'Blocked recovery prevents sealed edge mutation');
  return;
 }

 await fixture.admin.query('BEGIN');
 try{
  await fixture.admin.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[fixture.tenantId]);
  const busy=await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[event.id,lease]));
  assert.deepEqual(busy.rows[0].value,{state:'HELD',reason:'BUSY'});
 }finally{await fixture.admin.query('ROLLBACK');}
 assert.deepEqual((await fixture.admin.query('SELECT * FROM event_inbox WHERE id=$1',[event.id])).rows[0],originalSource,'Lock contention never quarantines a live source');
 assert.equal((await fixture.admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1 RETURNING state",[fixture.tenantId])).rows[0].state,'SUSPENDED');
 try{
  const unavailable=await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[event.id,lease]));
  assert.deepEqual(unavailable.rows[0].value,{state:'HELD',reason:'TENANT_UNAVAILABLE'});
 }finally{await fixture.admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[fixture.tenantId]);}
 assert.deepEqual((await fixture.admin.query('SELECT * FROM event_inbox WHERE id=$1',[event.id])).rows[0],originalSource);
 const denied=await fixture.tx(fixture.worker,fixture.foreignTenantId,c=>c.query('SELECT app.apply_meta_direct_transition_edge($1,$2,false) value',[event.id,lease]));
 assert.equal(denied.rows[0].value.reason,'SOURCE_UNAVAILABLE');
 await fixture.tx(fixture.worker,fixture.tenantId,async c=>{
  assert.equal((await c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[event.id,randomUUID()])).rows[0].value.state,'HELD');
  const applied=(await c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[event.id,lease])).rows[0].value;
  assert.equal(applied.state,'APPLIED',JSON.stringify({scenario:'ordinary-working',result:applied}));
 });
 const states=(await fixture.admin.query('SELECT id,state,attempts,lease_id FROM delivery_outbox WHERE id=ANY($1::uuid[])',[ids])).rows;
 assert(states.every(row=>['FAILED_TERMINAL','BLOCKED'].includes(row.state)&&row.attempts===0&&row.lease_id===null));
 // Bulk cancellation has no SQL row-order guarantee. The inherited trigger
 // projects successors it actually blocks; already-cancelled successors have
 // no BLOCKED projection. Bind the exact projection to the resulting states.
 const projected=(await fixture.admin.query('SELECT delivery_id,zammad_ticket_id,delivery_state,safe_error FROM zammad_status_outbox WHERE delivery_id=ANY($1::uuid[]) ORDER BY delivery_id',[ids])).rows;
 const expected=states.filter(row=>row.state==='BLOCKED').map(row=>({delivery_id:row.id,zammad_ticket_id:original.ticket,
  delivery_state:'BLOCKED',safe_error:'Blocked because an earlier article part requires recovery.'})).sort((a,b)=>a.delivery_id.localeCompare(b.delivery_id));
 assert.deepEqual(projected,expected,'Only the exact trigger-blocked successors receive a native status projection');
 assert.deepEqual((await fixture.admin.query('SELECT id,message_body,idempotency_key,meta_direct_recipient FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,before);
 assert.equal((await fixture.admin.query('SELECT state FROM connections WHERE id=$1',[fixture.connectionId])).rows[0].state,'WORKING');
 assert.deepEqual(fixture.traffic,[],'Ordinary metadata settlement needs no provider operation');
}

async function bridgedDuplicateAndFork(fixture,http,planId,target,changed){
 await activateSuccessor(fixture,target);
 const before=await snapshot(fixture,planId),traffic=structuredClone(fixture.traffic),inbound=new InboundRepository(fixture.worker);
 const duplicate=await http.send(change(randomUUID(),bsuid,nextBsuid,2),fixture.providerAccountId),duplicateLease=randomUUID();
 assert.deepEqual(duplicate.meta_direct_asset,changed.meta_direct_asset);
 assert.equal((await inbound.claim(fixture.tenantId,duplicateLease,1))[0].id,duplicate.id);
 const bounded=fn=>fixture.tx(fixture.worker,fixture.tenantId,async c=>{
  await c.query("SET LOCAL statement_timeout='5s'");
  assert.equal((await c.query("SELECT current_setting('statement_timeout') value")).rows[0].value,'5s');
  return fn(c);
 });
 const replay=await bounded(async c=>(await c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[duplicate.id,duplicateLease])).rows[0].value);
 assert.equal(replay.state,'DUPLICATE');assert.equal(replay.receipt.appliedEventId,changed.id);
 assert.equal(replay.receipt.accountTransitionId,planId);assert.equal(replay.receipt.targetAsset.providerSessionId,target.id);
 assert.equal((await bounded(c=>c.query('SELECT app.meta_direct_transition_receipt_valid($1) valid',[duplicate.id]))).rows[0].valid,true);
 assert.deepEqual((await snapshot(fixture,planId)).aliases,before.aliases,'A source-account semantic duplicate never reapplies its target edge');
 // Two signed unresolved branches share a real current predecessor but span
 // predecessor/current accounts. The one streamed edge set must see both.
 const forkA=await http.send(change(randomUUID(),nextBsuid,'SA.bridgeforka',3),fixture.providerAccountId);
 const forkB=await http.send(change(randomUUID(),nextBsuid,'SA.bridgeforkb',4),fixture.targetProviderAccountId);
 assert.equal(forkA.meta_direct_asset.providerSessionId,fixture.providerSessionId);
 assert.equal(forkB.meta_direct_asset.providerSessionId,target.id);
 const lease=randomUUID(),claimed=await inbound.claim(fixture.tenantId,lease,2);
 assert.deepEqual(claimed.map(row=>row.id).sort(),[forkA.id,forkB.id].sort());
 const conflict=await bounded(async c=>(await c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[forkA.id,lease])).rows[0].value);
 assert.equal(conflict.state,'HELD');assert.equal(conflict.reason,'CONFLICT');
 for(const row of (await fixture.admin.query('SELECT meta_direct_identity_resolution FROM event_inbox WHERE id=ANY($1::uuid[])',[[forkA.id,forkB.id]])).rows)assert.equal(row.meta_direct_identity_resolution,null);
 const after=await snapshot(fixture,planId);
 const identity=rows=>rows.map(({id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id})=>({id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id}));
 assert.deepEqual(identity(after.aliases),identity(before.aliases),'A bridged fork only holds existing aliases; it creates or retires none');
 assert.deepEqual(after.aliases.filter(row=>row.state==='RETIRED'),before.aliases.filter(row=>row.state==='RETIRED'));
 for(const field of ['participants','conversations','normalized','links','plan','checkpoints','reservations'])assert.deepEqual(after[field],before[field],field+' is immutable under duplicate/fork metadata');
 assert.deepEqual(fixture.traffic,traffic,'Metadata history cannot replay an account/provider effect');
}

async function privacyRetentionAndDeletion(fixture,http,original,planId){
 const job=async(client,type,scopeType='TENANT',scopeValue=fixture.tenantId,requestedAt=null)=>{
  const id=randomUUID(),leaseId=randomUUID(),snapshot=type==='RETENTION_SWEEP'?24:null;
  const row=(await client.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,'RUNNING','DISCOVER',1,$7,clock_timestamp()+interval '10 minutes',1,$8,COALESCE($9::timestamptz,clock_timestamp())) RETURNING created_at`,
   [id,fixture.tenantId,type,scopeType,scopeValue,type==='RETENTION_SWEEP'?'RETENTION_DELETE':'DELETE_TICKETS',leaseId,snapshot,requestedAt])).rows[0];
  return{id,tenantId:fixture.tenantId,leaseId,jobType:type,scopeType,scopeValue,disposition:type==='RETENTION_SWEEP'?'RETENTION_DELETE':'DELETE_TICKETS',state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:1,createdAt:row.created_at.toISOString(),unmatchedDiagnosticHours:24,exportTtlHours:24,zammadBaseUrl:'https://native.invalid',zammadPrivacySecretReference:`secret://${fixture.tenantId}/native/privacy`};
 };
 const requestedAt=(await fixture.admin.query('SELECT clock_timestamp() requested_at')).rows[0].requested_at.toISOString();
 // A signed message has whole-second precision. Wait for its actual timestamp
 // to reach the precise current review; never invent a future provider time.
 const review=(await fixture.admin.query('SELECT observed_at FROM meta_routing_reviews WHERE tenant_id=$1 AND connection_id=$2 ORDER BY review_version DESC LIMIT 1',[fixture.tenantId,fixture.connectionId])).rows[0];
 const reviewMs=review.observed_at.getTime(),deadline=performance.now()+2000;
 while(Math.floor(Date.now()/1000)*1000<reviewMs){
  assert(performance.now()<deadline,'The actual producer clock did not reach the current routing review');
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 const message={id:randomUUID(),from_user_id:lastBsuid,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Synthetic current successor primary routing'}};
 const contacts=[{user_id:lastBsuid}];
 const source=await http.send(message,fixture.targetProviderAccountId,{contacts}),sourceLease=randomUUID(),inboundSource=new InboundRepository(fixture.worker);
 const ordering=(await fixture.admin.query(`SELECT (source.meta_routing_evidence->>'observedAt')::timestamptz >= review.observed_at AS current
  FROM event_inbox source JOIN LATERAL (SELECT observed_at FROM meta_routing_reviews
   WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id ORDER BY review_version DESC LIMIT 1) review ON true
  WHERE source.tenant_id=$1 AND source.connection_id=$2 AND source.id=$3`,[fixture.tenantId,fixture.connectionId,source.id])).rows[0];
 assert.equal(ordering?.current,true,'The signed successor message does not predate its current routing review');
 const claimed=await inboundSource.claim(fixture.tenantId,sourceLease,1);assert.equal(claimed[0]?.id,source.id);
 const input={provider:'meta',connectionId:fixture.connectionId,messageId:message.id,chatId:lastBsuid,senderId:lastBsuid,fromMe:false,timestamp:new Date().toISOString(),input:{type:'text',text:message.text.body},metaIdentity:parseMetaDirectIdentity(message,contacts).identity};
 const consumePrimary=async c=>{
  const boundaryAliases=(await c.query("SELECT kind,value,state FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 AND participant_identity_id=$3 AND phone_number_id=$4 AND waba_id=$5 AND ((kind='PHONE' AND value=$6) OR (kind='BSUID' AND value=$7)) ORDER BY kind,value",[fixture.tenantId,fixture.connectionId,original.participant,fixture.phoneNumberId,fixture.targetProviderAccountId,phone,lastBsuid])).rows;
  assert.deepEqual(boundaryAliases.filter(row=>row.kind==='PHONE').map(row=>row.state),['RETIRED'],'The absent phone in the signed BSUID transition remains retired at the producer boundary');
  assert.deepEqual(boundaryAliases.filter(row=>row.kind==='BSUID').map(row=>row.state),['ACTIVE'],'Only the verified current successor BSUID supplies this producer identity');
  const resolved=await resolveMetaDirectMessage(c,claimed[0],sourceLease,input,fixture.appId);assert.equal(resolved.chatId,phone);assert.equal(resolved.senderPhone,undefined,'A BSUID-only successor does not revive the retired phone alias');
  await c.query("UPDATE event_inbox SET status='PROCESSED',processed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_id=$3",[fixture.tenantId,source.id,sourceLease]);
 };
 // Same actual repository, leased LOCAL guard and forward seal as P03. The
 // only acknowledgments below are synthetic external ticket/privacy completion.
 await fixture.tx(fixture.worker,fixture.tenantId,async c=>{
  await c.query('SAVEPOINT retained_successor');
  const repository=new PrivacyRepository({});repository.tenant=(tenant,fn)=>{assert.equal(tenant,fixture.tenantId);return fn(c);};
  await c.query("UPDATE retention_policies SET state='ACTIVE',resolved_case_days=1,include_open_cases=false WHERE tenant_id=$1",[fixture.tenantId]);
  await c.query("UPDATE bot_conversations SET state='RESOLVED',resolved_at='2000-01-01',resolution_kind='OPERATOR',last_activity_at='2000-01-01' WHERE id=$1",[original.conversation]);
  const current=randomUUID();await c.query(`INSERT INTO bot_conversations(id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at,normalized_reference,zammad_customer_id)
   VALUES($1,$2,$3,$4,$5,$6,'HUMAN','done','98351','98351',clock_timestamp(),$7,98341)`,[current,fixture.tenantId,original.assignment,fixture.connectionId,original.version,phone,'BOT-'+sha(current).slice(0,12).toUpperCase()]);
  await c.query('UPDATE zammad_conversation_state_outbox SET completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND conversation_id IN($2,$3)',[fixture.tenantId,original.conversation,current]);
  const retention=await job(c,'RETENTION_SWEEP','TENANT',fixture.tenantId,requestedAt);assert.equal((await c.query('SELECT received_at>$2::timestamptz newer FROM event_inbox WHERE id=$1',[source.id,retention.createdAt])).rows[0].newer,true);await repository.discover(retention,retention.leaseId);retention.stage='EXTERNAL';
  const targets=(await c.query('SELECT target_type,target_id FROM privacy_job_targets WHERE job_id=$1',[retention.id])).rows;
  assert(targets.some(row=>row.target_type==='NORMALIZED_MESSAGE'));assert(!targets.some(row=>row.target_type==='META_DIRECT_ALIAS'));
  await c.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[retention.id]);
  await repository.finalize(retention,retention.leaseId);
  const retained=(await c.query('SELECT payload,meta_direct_native_anchor,meta_direct_anchor_retention_job_id FROM event_inbox WHERE id=$1',[original.eventId])).rows[0];
  assert.deepEqual(retained.payload,{});assert.equal(retained.meta_direct_native_anchor.participantId,original.participant);assert.equal(retained.meta_direct_anchor_retention_job_id,retention.id);
  const currentAlias=(await c.query("SELECT id FROM meta_direct_identity_aliases WHERE participant_identity_id=$1 AND value=$2 AND state='ACTIVE'",[original.participant,lastBsuid])).rows[0];assert(currentAlias);
  assert.equal((await c.query('SELECT app.meta_direct_alias_source_valid($1,$2,$3) valid',[currentAlias.id,phone,'98341'])).rows[0].valid,true,'Account ancestry retains the actual ordinary native root through content expiry');
  // Valid identity ancestry alone grants no routing/account effect authority.
  // Only the actual current primary producer below establishes routing OWN.
  await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId:fixture.tenantId,conversationId:current,appId:fixture.appId}),error=>error?.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED'&&error.outcomeKnown===true,'Retained ancestry cannot manufacture current primary routing');
  await consumePrimary(c);
  await assertMetaDirectEffectCurrent(c,{tenantId:fixture.tenantId,conversationId:current,appId:fixture.appId});
  await assert.rejects(assertMetaDirectEffectCurrent(c,{tenantId:fixture.tenantId,conversationId:current,sourceEventIds:[original.eventId],appId:fixture.appId}),
   error=>error?.code==='META_DIRECT_EFFECT_NOT_ATTEMPTED'&&error.outcomeKnown===true,'A retained native anchor never makes an old explicit source current');
  await c.query('ROLLBACK TO SAVEPOINT retained_successor');
 });
 // The retention branch rolled back; finish this real claimed source before the
 // separate deletion branch, without provider requests or synthesized OWN.
 await fixture.tx(fixture.worker,fixture.tenantId,consumePrimary);
 const privacy=new PrivacyRepository(fixture.worker),deletion=await job(fixture.admin,'DELETE','PARTICIPANT',phone);
 await privacy.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
 const targets=(await fixture.admin.query("SELECT target_id FROM privacy_job_targets WHERE job_id=$1 AND target_type='META_DIRECT_ALIAS'",[deletion.id])).rows;
 const allAliases=(await fixture.admin.query('SELECT id FROM meta_direct_identity_aliases WHERE participant_identity_id=$1',[original.participant])).rows;
 assert.deepEqual(targets.map(row=>row.target_id).sort(),allAliases.map(row=>row.id).sort(),'Deletion targets every retained predecessor and current successor alias');
 await withFixtureTenant(fixture.admin,fixture.tenantId,()=>fixture.admin.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]));
 const accountReceipt=(await fixture.plan(planId)).identity_successor_receipt;
 await privacy.finalize(deletion,deletion.leaseId);
 assert.equal((await fixture.admin.query('SELECT count(*)::int n FROM meta_direct_identity_aliases WHERE participant_identity_id=$1',[original.participant])).rows[0].n,0);
 assert.equal((await fixture.admin.query('SELECT meta_direct_native_anchor FROM event_inbox WHERE id=$1',[original.eventId])).rows[0].meta_direct_native_anchor.redacted,true);
 assert.deepEqual((await fixture.plan(planId)).identity_successor_receipt,accountReceipt,'Subject deletion preserves nonpersonal account execution history');
 const late=await http.send(change(randomUUID(),lastBsuid,'SA.deletedsuccessor',2),fixture.providerAccountId),lease=randomUUID(),inbound=new InboundRepository(fixture.worker);
 assert.equal((await inbound.claim(fixture.tenantId,lease,1))[0].id,late.id);
 const outcome=await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query('SELECT app.drain_meta_direct_transitions($1,$2,false) value',[late.id,lease]));
 assert.equal(outcome.rows[0].value.state,'HELD');
 assert.equal((await fixture.admin.query('SELECT count(*)::int n FROM meta_direct_identity_aliases WHERE tenant_id=$1',[fixture.tenantId])).rows[0].n,0,'Late signed source cannot recreate a deleted identity or native root');
 assert.equal((await fixture.admin.query('SELECT count(*)::int n FROM normalized_messages WHERE tenant_id=$1',[fixture.tenantId])).rows[0].n,0);
}
