import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {Module} from '../services/control-api/node_modules/@nestjs/common/index.js';
import {NestFactory} from '../services/control-api/node_modules/@nestjs/core/index.js';
import {FastifyAdapter} from '../services/control-api/node_modules/@nestjs/platform-fastify/index.js';
import {WebhookIngressController} from '../services/control-api/dist/webhook-ingress.controller.js';
import {DatabaseService} from '../services/control-api/dist/database.service.js';
import {WebhookSecretService} from '../services/control-api/dist/webhook-secret.service.js';
import {TenantDrainService} from '../services/control-api/dist/tenant-drain.service.js';
import {RoutingConnectorsConfig} from '../services/control-api/dist/routing-connectors.config.js';
import {SecretProvisioningService} from '../services/control-api/dist/secret-provisioning.service.js';
import {createMetaTemplatePreparationFixture,template} from './meta-template-preparation-fixture-postgres.mjs';
import {parseMetaTemplateInventoryItem} from '../packages/core/dist/meta-template-inventory.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const denied=e=>['42501','55000','23514','55P03'].includes(e.code)||[400,403,409].includes(e.getStatus?.());
const rows=(f,pool,sql,args=[])=>f.tx(pool,f.tenantId,async c=>(await c.query(sql,args)).rows);
const slots=(f,id)=>rows(f,f.worker,"SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 AND stage='TEMPLATE_COPY'",[f.tenantId,id]);
const reservations=(f,id)=>rows(f,f.worker,'SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2 ORDER BY id',[f.tenantId,id]);
const providerPostCount=f=>f.traffic.filter(v=>v.method==='POST').length;
const accounts=f=>rows(f,f.app,'SELECT * FROM meta_connection_account_bindings WHERE tenant_id=$1 ORDER BY id',[f.tenantId]);
async function signedIngress(f){
 const old=process.env.META_APP_SECRET_REFERENCE,secret='synthetic-template-webhook-secret';process.env.META_APP_SECRET_REFERENCE='secret://platform/meta-template-test';
 // Borrow the real app pool without owning it. Resolver and tenant
 // transactions are the actual DatabaseService implementation.
 const database=Object.create(DatabaseService.prototype);database.pool=f.app;
 class TestModule{};
 Module({controllers:[WebhookIngressController],providers:[{provide:DatabaseService,useValue:database},
  {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
  {provide:TenantDrainService,useValue:{wakeInbound:async()=>{throw Error('Template negatives are not ordinary inbox work');}}},
  {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}]})(TestModule);
 const app=await NestFactory.create(TestModule,new FastifyAdapter(),{logger:false,rawBody:true});await app.init();await app.getHttpAdapter().getInstance().ready();
 const event=({account=f.providerAccountId,templateId=Number(f.sourceTemplateId),status='PAUSED',time=100,extra=[]}={})=>({object:'whatsapp_business_account',entry:[{id:account,time,changes:[{field:'message_template_status_update',value:{event:status,...(templateId===undefined?{}:{message_template_id:templateId})}},...extra]}]});
 const send=(body,bad=false)=>{const payload=JSON.stringify(body);return app.inject({method:'POST',url:'/webhooks/meta',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+(bad?'0'.repeat(64):createHmac('sha256',secret).update(payload).digest('hex'))},payload});};
 return{event,send,close:async()=>{await app.close();if(old===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=old;}};
}
async function createRace(f,resolveFirst){
 const key=randomUUID(),body=await f.createBody(),c=await f.app.connect();let late;
 try{
  await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  const first=(await c.query('SELECT app.request_meta_template_preparation($1,$2,$3,$4,$5,$6,$7) AS value',[f.connectionId,f.actorId,f.appId,key,body,'template-order-race',resolveFirst])).rows[0].value;
  // Hold the original-key transaction while the other order reaches it.
  // No timeout is used to infer the outcome.
  late=resolveFirst?f.controller.createTemplatePreparation(f.request,f.connectionId,key,body):f.controller.resolveTemplatePreparation(f.request,f.connectionId,key,body);
  await c.query('COMMIT');const second=await late;
  assert.equal(second.operationId,first.operationId);assert.equal(second.state,first.state);assert.equal(second.id,first.id);assert.equal(second.duplicate,true);
  const operation=(await rows(f,f.app,'SELECT state,payload FROM connection_operations WHERE tenant_id=$1 AND id=$2',[f.tenantId,first.operationId]))[0];
  if(resolveFirst){assert.equal(first.state,'NO_EFFECT');assert.equal(first.id,null);assert.equal(operation.state,'CANCELLED');assert.equal(operation.payload.metaTemplatePreparation.localResolution,'NO_ADMISSION');assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0);}
  else{assert.equal(first.state,'ADMITTED');const work=await f.claim();assert.equal(work.job.id,first.operationId);await f.run(work);const view=await f.view(first.id);await f.controller.cancelTemplatePreparation(f.request,f.connectionId,first.id,{expectedRevision:view.revision});}
  await assert.rejects(()=>f.controller.resolveTemplatePreparation(f.request,f.connectionId,key,{...body,expectedBindingRevision:body.expectedBindingRevision+1}),denied);
 }finally{await c.query('ROLLBACK');c.release();if(late)await late.catch(()=>{});}
}
async function actionTombstone(f,id){
 const v=await f.view(id),key=randomUUID(),body={expectedRevision:v.revision,expectedObservationSha256:v.observationSha256};
 const resolved=await f.controller.resolveTemplateAction(f.request,f.connectionId,id,'observe',key,body);
 assert.equal(resolved.pendingAction.state,'CANCELLED');const before=await f.view(id);
 const late=await f.controller.templateAction(f.request,f.connectionId,id,'observe',key,body);
 assert.equal(late.operationId,resolved.operationId);assert.equal(late.pendingAction.state,'CANCELLED');assert.equal(late.duplicate,true);
 assert.deepEqual(await f.view(id),before);assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0);
}
async function privacy(f,id,unknown){
 const hold=unknown?null:randomUUID(),job=randomUUID(),lease=randomUUID();
 if(hold)await f.admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'TENANT',$2::uuid::text,$3,'Synthetic template retention oracle',$4)",[hold,f.tenantId,sha(f.tenantId),f.actorId]);
 const historical=await rows(f,f.worker,"SELECT id,encode(digest(payload::text,'sha256'),'hex') AS payload_sha,encode(digest(result::text,'sha256'),'hex') AS result_sha,requested_by_id,idempotency_key FROM connection_operations WHERE tenant_id=$1 AND payload ? 'metaTemplatePreparation' ORDER BY id",[f.tenantId]);
 const before=(await rows(f,f.worker,"SELECT template_observation,encode(digest(template_observation::text,'sha256'),'hex') AS digest FROM meta_account_transitions WHERE id=$1",[id]))[0],originalSlots=await slots(f,id);
 await f.admin.query("INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot) VALUES($1,$2,'DELETE','TENANT',$2::uuid::text,'DELETE_TICKETS',$1::uuid::text,'RUNNING','LOCAL',1,$3,clock_timestamp()+interval '10 minutes',1,NULL)",[job,f.tenantId,lease]);
 const redact=(pool,tenant=f.tenantId,l=lease)=>f.tx(pool,tenant,async c=>(await c.query('SELECT app.redact_meta_template_preparations($1,$2,$3) AS value',[job,l,1])).rows[0].value);
 try{
   const executor='wasalx_meta_transition_executor';
   const role=(await f.admin.query('SELECT rolcanlogin,rolinherit FROM pg_catalog.pg_roles WHERE rolname=$1',[executor])).rows[0];assert.deepEqual(role,{rolcanlogin:false,rolinherit:false});
   const writable=(await f.admin.query("SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid='public.privacy_jobs'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege($1,'public.privacy_jobs',attname,'UPDATE') ORDER BY attname",[executor])).rows.map(row=>row.attname);
   assert.deepEqual(writable,['id'],'Private redaction executor receives only the row-lock prerequisite');
   for(const runtime of ['wasalx_app','wasalx_connector_worker','wasalx_platform_operations_client'])assert.equal((await f.admin.query("SELECT pg_has_role($1,$2,'MEMBER') allowed",[runtime,executor])).rows[0].allowed,false);
   assert.equal((await f.admin.query("SELECT has_table_privilege($1,'public.privacy_jobs','INSERT,DELETE') allowed",[executor])).rows[0].allowed,false);
   await assert.rejects(()=>redact(f.app),e=>e.code==='42501');await assert.rejects(()=>redact(f.worker,f.foreignTenantId),e=>e.code==='42501');
  await assert.rejects(()=>redact(f.worker,f.tenantId,randomUUID()),e=>e.code==='42501');await assert.rejects(()=>redact(f.worker),denied);
  if(unknown){assert.deepEqual((await rows(f,f.worker,'SELECT template_observation FROM meta_account_transitions WHERE id=$1',[id]))[0].template_observation,before.template_observation);}
  else{
   await f.admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[hold,f.actorId]);
   assert.ok(await redact(f.worker)>=1);assert.equal(await redact(f.worker),0);
   const p=(await rows(f,f.worker,'SELECT template_observation,template_state FROM meta_account_transitions WHERE id=$1',[id]))[0];
   assert.deepEqual(p.template_observation,{redacted:true,sha256:before.digest});assert.equal(p.template_state,'CANCELLED');
   for(const snapshot of historical){
    const retained=(await rows(f,f.worker,'SELECT payload,result,requested_by_id,idempotency_key FROM connection_operations WHERE tenant_id=$1 AND id=$2',[f.tenantId,snapshot.id]))[0];
    assert.deepEqual(retained.payload,{redacted:true,sha256:snapshot.payload_sha});
    assert.deepEqual(retained.result,snapshot.result_sha===null?null:{redacted:true,sha256:snapshot.result_sha});
    assert.equal(retained.requested_by_id,snapshot.requested_by_id);assert.equal(retained.idempotency_key,snapshot.idempotency_key);
   }
   const original=(await rows(f,f.worker,'SELECT payload,result,requested_by_id,idempotency_key FROM connection_operations WHERE tenant_id=$1 AND id=$2',[f.tenantId,originalSlots[0].original_operation_id]))[0];
   assert.deepEqual(Object.keys(original.payload).sort(),['redacted','sha256']);assert.deepEqual(Object.keys(original.result).sort(),['redacted','sha256']);assert.equal(original.requested_by_id,f.actorId);assert.ok(original.idempotency_key);
  }
  assert.deepEqual(await slots(f,id),originalSlots,'Privacy retains original outcome and no-replay identity');
 }finally{await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[job]));}
}

async function actionRace(f,id,resolveFirst){
 const view=await f.view(id),key=randomUUID(),body={expectedRevision:view.revision,expectedObservationSha256:view.observationSha256};
 const client=await f.app.connect();let late;
 try{
  await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  const first=(await client.query('SELECT app.request_meta_template_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
   [id,f.connectionId,f.actorId,f.appId,key,'OBSERVE',body,'template-action-race',resolveFirst])).rows[0].value;
  late=resolveFirst?f.controller.templateAction(f.request,f.connectionId,id,'observe',key,body):f.controller.resolveTemplateAction(f.request,f.connectionId,id,'observe',key,body);
  await client.query('COMMIT');const second=await late;
  assert.equal(second.operationId,first.operationId);assert.deepEqual(second.pendingAction,first.pendingAction);assert.equal(second.duplicate,true);
  if(resolveFirst){assert.equal(first.pendingAction.state,'CANCELLED');assert.deepEqual(await f.view(id),view);assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0);}
  else{assert.equal(first.pendingAction.state,'QUEUED');const work=await f.claim();assert.equal(work.job.id,first.operationId);await f.run(work);}
  await assert.rejects(()=>f.controller.resolveTemplateAction(f.request,f.connectionId,id,'observe',key,{...body,expectedRevision:body.expectedRevision+1}),denied);
  await assert.rejects(()=>f.controller.resolveTemplateAction(f.request,f.connectionId,id,'reconcile',key,body),denied);
  await assert.rejects(()=>f.controller.resolveTemplateAction(f.request,f.connectionId,randomUUID(),'observe',key,body),denied);
  await assert.rejects(()=>f.controller.resolveTemplateAction(f.request,f.targetConnectionId,id,'observe',key,body),denied);
  await assert.rejects(()=>f.controller.resolveTemplateAction({...f.request,principal:{...f.request.principal,tenantId:f.foreignTenantId}},f.connectionId,id,'observe',key,body),denied);
  const otherActor=randomUUID();
  await f.admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$1::uuid::text,$2,'Synthetic template other actor')",[otherActor,`template-${otherActor}@example.invalid`]);
  await f.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[f.tenantId,otherActor]);
  await assert.rejects(()=>f.controller.resolveTemplateAction({...f.request,principal:{...f.request.principal,userId:otherActor}},f.connectionId,id,'observe',key,body),denied);
  assert.equal(providerPostCount(f),0);
 }finally{await client.query('ROLLBACK');client.release();if(late)await late.catch(()=>{});}
}
async function operationObservation(f,operationId){
 return(await rows(f,f.worker,"SELECT id,payload,result,encode(digest(result::text,'sha256'),'hex') AS result_sha FROM connection_operations WHERE tenant_id=$1 AND id=$2",[f.tenantId,operationId]))[0];
}
const actionBody=view=>({expectedRevision:view.revision,expectedObservationSha256:view.observationSha256,choices:view.choices.filter(c=>c.selectable).map(c=>c.id)});
// The unresolved slot, rather than a stale request or missing choice, must be
// what fences a new public COPY intent. The second source item was deliberately
// not in the original POST and remains a valid MISSING item in the latest GET.
async function unresolvedCopyCommands(f,id,work,outcome){
 const original=(await rows(f,f.app,'SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2',[f.tenantId,work.job.id]))[0];
 const intent=original.payload.metaTemplatePreparation,view=await f.view(id);
 assert.equal(intent.stage,'COPY');assert.equal(original.state,'FAILED_TERMINAL');
 assert.equal(view.state,'OUTCOME_UNKNOWN');assert.equal(view.originalCopy.outcome,outcome);
 const status=(await rows(f,f.app,'SELECT app.meta_template_preparation_status($1,$2,$3) AS value',[id,f.actorId,f.appId]))[0].value;
 assert.equal(status.permitted,true);assert.equal(status.current,true);assert.equal(status.safetyCurrent,true);assert.equal(status.scopeCurrent,true);
 assert.ok(Date.parse(view.expiresAt)>Date.now());
 const observation=(await rows(f,f.app,'SELECT template_observation FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2',[f.tenantId,id]))[0].template_observation;
 const choice=observation.choices.find(c=>c.name==='uncopied_notice');
 assert.equal(choice.compatibility,'MISSING');assert.equal(choice.selectable,true);
 assert.equal(view.choices.find(c=>c.id===choice.id).selectable,false,'Public capability remains held by the original unresolved copy');
 const snapshot={slots:await slots(f,id),reservations:await reservations(f,id),operations:await rows(f,f.app,'SELECT * FROM connection_operations WHERE tenant_id=$1 ORDER BY id',[f.tenantId]),posts:providerPostCount(f)};
 assert.equal(snapshot.slots.length,1);assert.equal(snapshot.slots[0].outcome,outcome);
 assert.equal(snapshot.slots[0].original_operation_id,work.job.id);assert.match(snapshot.slots[0].request_sha256,/^[a-f0-9]{64}$/u);
 assert.ok(snapshot.reservations.length>0&&snapshot.reservations.every(r=>r.released_at===null));assert.equal(snapshot.posts,1);
 const duplicate=await f.controller.templateAction(f.request,f.connectionId,id,'copy',original.idempotency_key,intent.actionRequest);
 assert.equal(duplicate.id,id);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.operationId,work.job.id);
 assert.deepEqual(duplicate.pendingAction,{operationId:work.job.id,requestKey:original.idempotency_key,action:'COPY',requestRevision:intent.requestRevision,state:'FAILED_TERMINAL'});
 const freshKey=randomUUID(),body={expectedRevision:view.revision,expectedObservationSha256:view.observationSha256,choices:[choice.id]};
 assert.notEqual(body.expectedRevision,intent.actionRequest.expectedRevision);
 // This is the exact post-scope checkpoint/selection guard, not syntax, old
 // revision, changed scope, queued work, or an opaque-choice mismatch.
 await assert.rejects(()=>f.controller.templateAction(f.request,f.connectionId,id,'copy',freshKey,body),
  e=>e.code==='55000'&&e.message==='Template copy requires a fresh unchanged selection');
 assert.deepEqual(await slots(f,id),snapshot.slots,'Original checkpoint, outcome, request digest and token remain unchanged');
 assert.deepEqual(await reservations(f,id),snapshot.reservations,'Original reservations cannot be replaced or released');
 assert.deepEqual(await rows(f,f.app,'SELECT * FROM connection_operations WHERE tenant_id=$1 ORDER BY id',[f.tenantId]),snapshot.operations,'Neither command creates a new dispatch operation');
 assert.equal((await rows(f,f.app,'SELECT id FROM connection_operations WHERE tenant_id=$1 AND idempotency_key=$2',[f.tenantId,freshKey])).length,0);
 assert.equal(providerPostCount(f),snapshot.posts);assert.deepEqual(await f.view(id),view);
}

async function repairOracles(options){
 const outcomes=[];
 // F1: both signed envelope orders, account fallback and a complete-vs-incomplete
 // GET are exercised through the real controller and generation CAS.
 {
  const f=await createMetaTemplatePreparationFixture(options);let ingress;
  try{
   const id=await f.create();ingress=await signedIngress(f);
   for(const invalidFirst of [true,false]){
    const work=await f.action(id,'observe');let sent=false;
    await assert.rejects(()=>f.run(work,{beforeFetch:async req=>{
     if(sent||req.path!==`/${f.targetProviderId}/message_templates`)return;sent=true;
     const valid=ingress.event({templateId:'invalid-template-identity',time:invalidFirst?301:302}).entry[0];
     const invalid=ingress.event({account:'invalid-account',time:invalidFirst?401:402}).entry[0];
     assert.equal((await ingress.send({object:'whatsapp_business_account',entry:invalidFirst?[invalid,valid]:[valid,invalid]})).statusCode,400);
    }}));assert.equal(sent,true);
    const safety=(await rows(f,f.app,'SELECT revision,observed_revision FROM meta_template_account_safety WHERE account_id=$1',[f.accountId]))[0];
    assert.ok(Number(safety.revision)>Number(safety.observed_revision));assert.ok((await f.view(id)).reasons.includes('SIGNED_TEMPLATE_CHANGE'));
    const sourceMarker=(await rows(f,f.app,'SELECT template_id,source_connection_id,source_session_id FROM meta_template_safety_markers WHERE account_id=$1 ORDER BY received_at DESC LIMIT 1',[f.accountId]))[0];
    assert.equal(sourceMarker.template_id,null);assert.equal(sourceMarker.source_connection_id,f.connectionId);assert.equal(sourceMarker.source_session_id,f.sourceSessionId);
    const incomplete=await f.action(id,'observe');await f.run(incomplete,{incompleteSource:true});
    assert.ok((await f.view(id)).reasons.includes('INVENTORY_INCOMPLETE'));
    const held=(await rows(f,f.app,'SELECT revision,observed_revision FROM meta_template_account_safety WHERE account_id=$1',[f.accountId]))[0];
    assert.equal(held.observed_revision,safety.observed_revision,'Incomplete inventory cannot clear a signed account hold');
    await f.run(await f.action(id,'observe'));
   }
   assert.equal((await rows(f,f.app,'SELECT revision FROM meta_template_account_safety WHERE account_id=$1',[f.targetAccountId]))[0].revision,'0');
   assert.equal((await f.tx(f.app,f.foreignTenantId,c=>c.query('SELECT * FROM meta_template_safety_markers WHERE account_id=$1',[f.accountId]))).rowCount,0);
   assert.equal(providerPostCount(f),0);outcomes.push({case:'signed-envelope-both-orders-incomplete-cas',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await ingress?.close();await f.close();}
 }
 // F2: real immutable versions include both current assignments and an older
 // conversation pin. Later reads cannot overwrite their operation receipt.
 {
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   f.sourceTemplates.push(template(String(BigInt(f.sourceTemplateId)+1n),'old_notice'));
   const older=await f.createFlow('old_notice'),current=await f.nextFlow(older,'preparation_notice'),assignment=await f.assignFlow(current);
   await f.pinConversation(assignment,older);
   const id=await f.create(),firstView=await f.view(id),first=await operationObservation(f,firstView.pendingAction.operationId);
   const receipt=first.result.metaTemplatePreparation;
   assert.equal(receipt.observation.observationOperationId,first.id);assert.equal(receipt.observation.dependencies.length,2);
   assert.deepEqual(new Set(receipt.observation.dependencies.map(d=>d.flowVersionId)),new Set([older.id,current.id]));
   assert.equal(first.payload.metaTemplatePreparation.source.flows.length,2);assert.match(receipt.scopeSha256,/^[a-f0-9]{64}$/u);
   for(const pool of [f.app,f.worker])await assert.rejects(()=>rows(f,pool,"UPDATE connection_operations SET result=jsonb_set(result,'{metaTemplatePreparation,observation,dependencies}','[]') WHERE id=$1",[first.id]),denied);
   const work=await f.action(id,'copy');await f.run(work);assert.equal((await f.view(id)).state,'READY');
   const copy=await operationObservation(f,work.job.id);assert.equal(copy.result.metaTemplatePreparation.observation.dependencies.length,2);
   await f.nextFlow(current,'old_notice');await f.run(await f.action(id,'observe'));
   const latest=await f.view(id);assert.notEqual(latest.pendingAction.operationId,first.id);
   assert.deepEqual(await operationObservation(f,first.id),first);assert.deepEqual(await operationObservation(f,copy.id),copy);
   assert.equal((await operationObservation(f,latest.pendingAction.operationId)).result.metaTemplatePreparation.observation.dependencies.some(d=>d.flowVersionId===current.id),false);
   await privacy(f,id,false);outcomes.push({case:'immutable-nonempty-assigned-and-pinned-history',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 // F3: the provider's original batch result and current dependency readiness
 // are independent. Equal later content never authorizes a subset retry.
 for(const failure of ['mixed','all','full-but-incompatible']){
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   const second=template(String(BigInt(f.sourceTemplateId)+1n),'second_notice');f.sourceTemplates.push(second);
   if(failure==='full-but-incompatible')await f.assignFlow(await f.createFlow('unrelated_missing_notice'));
   const id=await f.create(),work=await f.action(id,'copy');
   const failed=failure==='mixed'?[second.id]:failure==='all'?f.sourceTemplates.map(v=>v.id):[];
   await f.run(work,{failedSourceIds:failed});const original=await slots(f,id),first=await f.view(id);
   assert.equal(original[0].outcome,'SUCCEEDED');assert.deepEqual(original[0].result.failedSourceTemplateIds,failed.slice().sort());
   assert.equal(first.state,failed.length?'PARTIAL':'REVIEW');assert.equal(first.reasons.includes('COPY_PARTIAL'),failed.length>0);
   assert.equal(first.actions.copy,false);assert.equal(first.canCutOver,false);
   for(const [index,item] of f.sourceTemplates.entries())if(!f.targetTemplates.some(v=>v.name===item.name))f.targetTemplates.push({...structuredClone(item),id:String(BigInt(f.targetTemplateId)+100n+BigInt(index))});
   await f.run(await f.action(id,'reconcile'));const after=await f.view(id);
   assert.equal(after.state,failed.length?'PARTIAL':'REVIEW');assert.equal(after.reasons.includes('COPY_PARTIAL'),failed.length>0);
   assert.ok(after.choices.every(c=>c.compatibility==='EQUIVALENT'&&!c.selectable));assert.deepEqual(await slots(f,id),original);
   await assert.rejects(()=>f.controller.templateAction(f.request,f.connectionId,id,'copy',randomUUID(),{expectedRevision:after.revision,expectedObservationSha256:after.observationSha256,choices:[after.choices[0].id]}),denied);
   if(failed.length){await f.run(await f.action(id,'observe'),{incompleteSource:true});const incomplete=await f.view(id);
    assert.equal(incomplete.state,'HELD');assert.ok(incomplete.reasons.includes('COPY_PARTIAL'));assert.ok(incomplete.reasons.includes('INVENTORY_INCOMPLETE'));}
   assert.equal(providerPostCount(f),1);outcomes.push({case:'original-batch-'+failure,mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 // F4: three independent local scope changes cannot inherit old confirmation.
 // The assigned-version case additionally changes scope after queueing COPY.
 for(const drift of ['assigned','conversation-pinned','account-phone']){
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   f.sourceTemplates.push(template(String(BigInt(f.sourceTemplateId)+1n),'old_notice'));
   const older=await f.createFlow('old_notice'),current=await f.nextFlow(older,'preparation_notice'),assignment=await f.assignFlow(current);
   const id=await f.create(),old=await f.view(id),body=actionBody(old);
   if(drift==='assigned')await f.nextFlow(current,'old_notice');
   else if(drift==='conversation-pinned')await f.pinConversation(assignment,older);
   else await f.addSourcePhone();
   const held=await f.view(id);assert.equal(held.actions.copy,false);assert.ok(held.reasons.includes('BINDING_CHANGED'));assert.equal(held.actions.observe,true);
   await assert.rejects(()=>f.controller.templateAction(f.request,f.connectionId,id,'copy',randomUUID(),body),denied);
   assert.equal((await slots(f,id)).length,0);assert.equal(providerPostCount(f),0);
   await f.run(await f.action(id,'observe'));assert.equal((await f.view(id)).actions.copy,true);
   if(drift==='assigned'){
    const queued=await f.action(id,'copy'),context=await f.store.templatePreparationContext(queued.job,queued.lease,f.appId);
    const execution=await f.store.resolveTemplateExecution(queued.job,context,f.runtimeCandidate,options.runtimeEvidence.transportBindingSha256);
    assert.equal(execution.mode,'SIMULATED');await f.pinConversation(assignment,older);
    await assert.rejects(()=>f.store.reserveTemplateCopy(queued.job,queued.lease,'a'.repeat(64),execution,f.appId),e=>e.code==='55000'&&/Observed template scope changed/u.test(e.message));
    await assert.rejects(()=>f.run(queued));assert.equal((await slots(f,id)).length,0);assert.equal(providerPostCount(f),0);
    await f.run(await f.action(id,'observe'));assert.equal((await f.view(id)).actions.copy,true);
   }
   outcomes.push({case:'observed-scope-drift-'+drift,mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 // F5: resolve wins or admission wins under the same actual key lock. A known
 // response whose local write failed, or whose lease expired, keeps one slot.
 for(const expireLease of [false,true]){
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   f.sourceTemplates.push(template(String(BigInt(f.sourceTemplateId)+1n),'uncopied_notice'));
   const id=await f.create();await actionRace(f,id,true);await actionRace(f,id,false);
   const originalChoice=(await f.view(id)).choices.find(c=>c.name==='preparation_notice');assert.equal(originalChoice.selectable,true);
   const work=await f.action(id,'copy',[originalChoice.id]);let captured;
   const faultStore={...f.store,recordTemplateCopyResponse:async(job,slot,outcome,result)=>{
    captured={job,slot,outcome,result};throw new Error('Synthetic local response-record failure');
   }};
   await assert.rejects(()=>f.run(work,{storeOverride:faultStore,afterAcceptedCopy:expireLease?async()=>{
    await f.admin.query("UPDATE connection_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenantId,work.job.id]);
   }:undefined}));assert.ok(captured);assert.equal(captured.outcome,'SUCCEEDED');
   const original=(await slots(f,id))[0];assert.equal(original.outcome,'ATTEMPTED');assert.equal(providerPostCount(f),1);
   if(expireLease)assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0,'Exhausted original lease becomes terminal, never another POST slot');
   assert.equal((await rows(f,f.worker,'SELECT state FROM connection_operations WHERE id=$1',[work.job.id]))[0].state,'FAILED_TERMINAL');
   const replacement=await f.action(id,'reconcile');assert.notEqual(replacement.job.id,work.job.id);assert.notEqual(replacement.lease,work.lease);
   await f.run(replacement);const before=await f.view(id);assert.equal(before.state,'OUTCOME_UNKNOWN');assert.equal(before.actions.cancel,false);
   await unresolvedCopyCommands(f,id,work,'ATTEMPTED');
   await assert.rejects(()=>f.run(work));assert.equal(providerPostCount(f),1);
   const historical=await f.store.reserveTemplateCopy(work.job,randomUUID(),original.request_sha256,original.runtime_execution,f.appId);
   assert.equal(historical.disposition,'HISTORICAL_NO_POST');assert.equal(historical.id,original.id);assert.equal(historical.outcome,'ATTEMPTED');
   await assert.rejects(()=>f.store.reserveTemplateCopy(replacement.job,replacement.lease,original.request_sha256,original.runtime_execution,f.appId),denied,'Replacement read operation has no COPY stage authority');
   assert.ok((await reservations(f,id)).every(v=>v.released_at===null));assert.equal((await slots(f,id)).length,1);
   await f.store.recordTemplateCopyResponse(captured.job,captured.slot,captured.outcome,captured.result);
   await f.store.recordTemplateCopyResponse(captured.job,captured.slot,captured.outcome,captured.result);
   const afterLate=await f.view(id);assert.equal(afterLate.revision,before.revision);assert.equal(afterLate.state,'OUTCOME_UNKNOWN','Late original evidence does not publish current readiness');
   assert.equal((await slots(f,id))[0].request_sha256,original.request_sha256);
   const previous=await operationObservation(f,replacement.job.id);
   await assert.rejects(()=>f.store.completeTemplateObservation(work.job,work.lease,'0'.repeat(64),previous.result.metaTemplatePreparation.observation,f.appId),denied);
   const after=await f.action(id,'reconcile');await f.run(after);assert.equal((await f.view(id)).state,'READY');
   assert.ok((await reservations(f,id)).every(v=>v.released_at!==null));assert.equal(providerPostCount(f),1);
   assert.equal((await slots(f,id))[0].original_operation_id,work.job.id);outcomes.push({case:expireLease?'original-copy-expired-lease-late-result':'original-copy-local-record-loss',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 return outcomes;
}

/** Actual-role oracles consumed by the existing canonical runner.
 * Fetches are synthetic responses; this never supplies installed/live credit. */
export async function verifyMetaTemplatePreparation(options){
 const outcomes=[];
 {
  const f=await createMetaTemplatePreparationFixture(options);let ingress;
  try{
   const initialAccounts=await accounts(f);await createRace(f,true);await createRace(f,false);
   const id=await f.create(),view=await f.view(id);assert.equal(view.choices.length,1);assert.equal(view.choices[0].compatibility,'MISSING');assert.equal(view.choices[0].selectable,true);assert.equal(view.canCutOver,false);
   const binding=(await accounts(f)).find(v=>v.connection_id===f.connectionId);
   const authority=(await rows(f,f.app,'SELECT authority_revision FROM meta_messaging_accounts WHERE id=$1',[f.accountId]))[0];
   await assert.rejects(()=>f.controller.createTemplatePreparation(f.request,f.connectionId,randomUUID(),{targetConnectionId:f.targetConnectionId,
    expectedAccountRevision:Number(authority.authority_revision),expectedBindingRevision:Number(binding.revision)}),denied,'A direct caller must close the same active review too');
   await actionTombstone(f,id);
   await assert.rejects(()=>f.controller.templatePreparationView({...f.request,principal:{...f.request.principal,tenantId:f.foreignTenantId}},f.connectionId,id),e=>e.getStatus?.()===404);
   const foreignRows=await f.tx(f.worker,f.foreignTenantId,c=>c.query('SELECT id FROM meta_account_transitions WHERE id=$1',[id]));assert.equal(foreignRows.rowCount,0);
   await assert.rejects(()=>f.tx(f.app,f.tenantId,c=>c.query("UPDATE meta_account_transitions SET template_state='READY',revision=revision+1 WHERE id=$1",[id])),denied);
   const operatorList=await f.tx(f.platform,f.tenantId,async c=>(await c.query('SELECT app.operator_meta_transition_list($1) AS value',[f.tenantId])).rows[0].value);
   assert.equal(operatorList.plans.some(v=>v.id===id),false,'Currency review cannot reinterpret template preparation');
   const work=await f.action(id,'copy');await assert.rejects(()=>f.store.templatePreparationContext(work.job,randomUUID(),f.appId),denied);
   const selected=await f.store.templatePreparationContext(work.job,work.lease,f.appId),freshSource=parseMetaTemplateInventoryItem(f.sourceTemplates[0]);
   assert.deepEqual(selected.selectedInventory.items[0],freshSource);
   assert.notEqual(JSON.stringify(selected.selectedInventory.items[0]),JSON.stringify(freshSource),'Actual stored JSONB key order differs from the fresh parser');
   const freshTarget={accountId:f.targetProviderId,items:[],complete:true};assert.deepEqual(selected.selectedTargetInventory,freshTarget);
   assert.notEqual(JSON.stringify(selected.selectedTargetInventory),JSON.stringify(freshTarget),'Empty target inventory also crosses JSONB key ordering');
   for(const pool of [f.app,f.worker])await f.tx(pool,f.tenantId,async client=>{
    for(const relation of ['tenants','tenant_memberships','connections','provider_sessions','webhook_routes','privacy_jobs',
     'meta_messaging_accounts','meta_connection_account_bindings','meta_account_transitions','meta_provider_effect_checkpoints',
     'meta_account_transition_reservations','meta_template_account_safety','meta_template_safety_markers','connection_operations'])
      await client.query(`CREATE TEMP TABLE ${relation}(poison boolean) ON COMMIT DROP`);
    if(pool===f.app){const status=(await client.query('SELECT app.meta_template_preparation_status($1,$2,$3) AS value',[id,f.actorId,f.appId])).rows[0].value;assert.equal(status.current,true);}
    else{const context=(await client.query('SELECT app.meta_template_operation_context($1,$2,$3,$4) AS value',[work.job.id,work.lease,work.job.fencingToken,f.appId])).rows[0].value;assert.equal(context.transitionId,id);}
   });
   const supportingOwner=randomUUID();
   await f.admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$1::uuid::text,$2,'Synthetic template support owner')",[supportingOwner,`template-${supportingOwner}@example.invalid`]);
   await f.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[f.tenantId,supportingOwner]);
   await f.admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.actorId]);
   try{
    await assert.rejects(()=>f.store.templatePreparationContext(work.job,work.lease,f.appId),denied);
    const held=await f.view(id);assert.equal(held.actions.copy,false);assert.equal(held.actions.cancel,false);
    await assert.rejects(()=>f.controller.cancelTemplatePreparation(f.request,f.connectionId,id,{expectedRevision:held.revision}),denied);
   }finally{await f.admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.actorId]);}
   await f.run(work);assert.equal(providerPostCount(f),1);let ready=await f.view(id);
   assert.equal(ready.state,'READY');assert.equal(ready.originalCopy.outcome,'SUCCEEDED');assert.equal(ready.actions.copy,false);assert.equal(ready.choices[0].compatibility,'EQUIVALENT');
   assert.ok((await reservations(f,id)).every(r=>r.released_at!==null));assert.deepEqual(await accounts(f),initialAccounts,'Template copy never transfers phone, credential or billing policy');
   const originalSlots=await slots(f,id);assert.equal(originalSlots.length,1);
   ingress=await signedIngress(f);const event=ingress.event();
   assert.equal((await ingress.send(event,true)).statusCode,401);
   assert.equal((await rows(f,f.app,'SELECT revision FROM meta_template_account_safety WHERE account_id=$1',[f.accountId]))[0].revision,'0');
   assert.equal((await ingress.send(event)).statusCode,200);assert.equal((await ingress.send(event)).json().duplicates,1);
   ready=await f.view(id);assert.equal(ready.state,'HELD');assert.ok(ready.reasons.includes('SIGNED_TEMPLATE_CHANGE'));
   for(const time of [100,1])assert.equal((await ingress.send(ingress.event({status:'APPROVED',time}))).statusCode,200);
   assert.equal((await rows(f,f.app,'SELECT revision FROM meta_template_account_safety WHERE account_id=$1',[f.accountId]))[0].revision,'3','Positive/equal-time/older callbacks invalidate, never clear');
   const malformed=ingress.event({templateId:'not-an-integer',time:101,extra:[{field:'account_update',value:null}]});
   assert.equal((await ingress.send(malformed)).statusCode,400,'Sibling parser denial follows durable conservative negative');
   const marker=(await rows(f,f.app,'SELECT template_id FROM meta_template_safety_markers WHERE account_id=$1 ORDER BY received_at DESC LIMIT 1',[f.accountId]))[0];assert.equal(marker.template_id,null);
   assert.equal((await rows(f,f.app,'SELECT revision FROM meta_template_account_safety WHERE account_id=$1',[f.targetAccountId]))[0].revision,'0','Malformed source identity cannot hold another account');
   const observe=await f.action(id,'observe');let changed=false;
   await assert.rejects(()=>f.run(observe,{beforeFetch:async v=>{if(!changed&&v.path===('/'+f.targetProviderId+'/message_templates')){changed=true;assert.equal((await ingress.send(ingress.event({status:'REJECTED',time:102}))).statusCode,200);}}}));
   assert.equal((await f.view(id)).state,'HELD','Older GET cannot clear concurrent signed generation');
   const current=await f.action(id,'reconcile');await f.run(current);assert.equal((await f.view(id)).state,'READY');assert.equal(providerPostCount(f),1);assert.deepEqual(await slots(f,id),originalSlots);
   await privacy(f,id,false);outcomes.push({case:'known-copy-signed-generation-privacy',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await ingress?.close();await f.close();}
 }
 for(const malformedCopy of [false,true]){
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   f.sourceTemplates.push(template(String(BigInt(f.sourceTemplateId)+1n),'uncopied_notice'));
   const id=await f.create(),before=await accounts(f),originalChoice=(await f.view(id)).choices.find(c=>c.name==='preparation_notice');
   assert.equal(originalChoice.selectable,true);const work=await f.action(id,'copy',[originalChoice.id]);
   await assert.rejects(()=>f.run(work,{loseCopyResponse:!malformedCopy,malformedCopy}));
   const original=await slots(f,id);assert.equal(original[0].outcome,'UNKNOWN');assert.equal(providerPostCount(f),1);
   const observed=await f.action(id,'reconcile');await f.run(observed);const held=await f.view(id);
   await unresolvedCopyCommands(f,id,work,'UNKNOWN');
   assert.equal(held.state,'OUTCOME_UNKNOWN');assert.equal(held.choices[0].compatibility,'EQUIVALENT');assert.equal(held.actions.copy,false);assert.equal(held.actions.cancel,false);assert.equal(held.canCutOver,false);
   await assert.rejects(()=>f.controller.cancelTemplatePreparation(f.request,f.connectionId,id,{expectedRevision:held.revision}),denied);
   assert.ok((await reservations(f,id)).every(r=>r.released_at===null));assert.deepEqual(await slots(f,id),original);assert.deepEqual(await accounts(f),before);
   await privacy(f,id,true);assert.equal(providerPostCount(f),1);outcomes.push({case:malformedCopy?'malformed-copy-response':'lost-copy-response',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 {
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   const id=await f.create(),work=await f.action(id,'copy');f.targetTemplates.push({...f.sourceTemplates[0],id:f.targetTemplateId,components:[{type:'BODY',text:'An existing different target.'}]});
   await assert.rejects(()=>f.run(work));assert.equal(providerPostCount(f),0);assert.equal((await slots(f,id)).length,0,'Target collision holds before external checkpoint');
   const current=await f.view(id);const cancelled=await f.controller.cancelTemplatePreparation(f.request,f.connectionId,id,{expectedRevision:current.revision});assert.equal(cancelled.duplicate,false);
   assert.equal((await f.controller.cancelTemplatePreparation(f.request,f.connectionId,id,{expectedRevision:current.revision})).duplicate,true,'Deliberate exact local CAS is repeatable');
   outcomes.push({case:'collision-cancel',mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 // Object keys are semantically unordered; content and component arrays are not.
 for(const changed of ['source-content','source-component-order','target-content','target-component-order']){
  const f=await createMetaTemplatePreparationFixture(options);
  try{
   f.sourceTemplates[0].components=[{type:'HEADER',format:'TEXT',text:'Header'},{type:'BODY',text:'Your request is ready.'}];
   if(changed.startsWith('target'))f.targetTemplates.push({...template(f.targetTemplateId,'different_target_notice'),components:[{type:'HEADER',format:'TEXT',text:'Header'},{type:'BODY',text:'Existing unrelated target.'}]});
   const id=await f.create(),work=await f.action(id,'copy'),item=changed.startsWith('source')?f.sourceTemplates[0]:f.targetTemplates[0];
   if(changed.endsWith('content'))item.components[1].text+=' Changed';else item.components.reverse();
   await assert.rejects(()=>f.run(work),error=>error.code==='META_TEMPLATE_NOT_ATTEMPTED'&&error.outcomeKnown===true);
   assert.equal(providerPostCount(f),0);assert.equal((await slots(f,id)).length,0,'Changed semantic inventory has no external slot');
   outcomes.push({case:changed,mode:'LOCAL_SIMULATED',passed:true});
  }finally{await f.close();}
 }
 outcomes.push(...await repairOracles(options));
 return outcomes;
}
