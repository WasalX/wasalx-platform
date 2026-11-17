import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {createMetaLegacyMigrationFixture} from './meta-legacy-migration-fixture-postgres.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const denied=e=>['42501','55000','23514','55P03'].includes(e.code)||[400,403,404,409,503].includes(e.getStatus?.());
const plan=(f,id)=>f.rows(f.worker,'SELECT * FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2',[f.tenantId,id]).then(v=>v[0]);
const checkpoints=(f,id)=>f.rows(f.worker,"SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 AND stage='LEGACY_REGISTER' ORDER BY id",[f.tenantId,id]);
const reservations=(f,id)=>f.rows(f.worker,'SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2 ORDER BY id',[f.tenantId,id]);
const bindings=f=>f.rows(f.worker,'SELECT * FROM meta_connection_account_bindings WHERE tenant_id=$1 ORDER BY id',[f.tenantId]);
const originalHistory=f=>f.rows(f.worker,"SELECT id,requested_by_id,idempotency_key,encode(digest(payload::text,'sha256'),'hex') AS payload_sha,encode(digest(result::text,'sha256'),'hex') AS result_sha FROM connection_operations WHERE tenant_id=$1 AND payload ? 'metaTemplatePreparation' ORDER BY id",[f.tenantId]);
async function completed(f){const created=await f.createLegacy();assert.equal(created.state,'ADMITTED');await f.authorize(created.id,{loseResponse:true});const work=await f.legacyAction(created.id,'register');await f.runLegacy(work);return{id:created.id,work};}

async function createOrdering(f,resolveFirst){
 const key=randomUUID(),body=f.createBody,c=await f.app.connect();let late;
 try{
  await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  const first=(await c.query('SELECT app.request_meta_legacy_migration($1,$2,$3,$4,$5,$6,$7) AS value',[f.connectionId,f.actorId,f.appId,key,body,'legacy-create-order',resolveFirst])).rows[0].value;
  late=resolveFirst?f.createLegacy(key,body):f.controller.resolveLegacyMigration(f.request,f.connectionId,key,body);
  await c.query('COMMIT');const second=await late;
  assert.equal(second.operationId,first.operationId);assert.equal(second.id,first.id);assert.equal(second.state,first.state);assert.equal(second.duplicate,true);
  assert.deepEqual(second.request,body);assert.equal(second.requestKey,key);
  if(resolveFirst){assert.equal(first.state,'NO_EFFECT');assert.equal(first.id,null);assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0);}
  else{assert.equal(first.state,'ADMITTED');const v=await f.legacyView(first.id);await f.controller.cancelLegacyMigration(f.request,f.connectionId,first.id,{expectedRevision:v.revision});}
  await assert.rejects(()=>f.controller.resolveLegacyMigration(f.request,f.connectionId,key,{...body,expectedSourceBindingRevision:body.expectedSourceBindingRevision+1}),denied);
  assert.equal(f.providerPosts(),0);
 }finally{await c.query('ROLLBACK');c.release();if(late)await late.catch(()=>{});}
}
async function actionOrdering(f,id,resolveFirst){
 const current=await f.legacyView(id),key=randomUUID(),body={expectedRevision:current.revision,expectedReviewSha256:current.reviewSha256,confirmCutover:true};
 const c=await f.app.connect();let late;
 try{
  await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  const first=(await c.query('SELECT app.request_meta_legacy_migration_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',[id,f.connectionId,f.actorId,f.appId,key,'REGISTER',body,'legacy-register-order',resolveFirst])).rows[0].value;
  late=resolveFirst?f.controller.legacyMigrationAction(f.request,f.connectionId,id,'register',key,body):f.controller.resolveLegacyMigrationAction(f.request,f.connectionId,id,'register',key,body);
  await c.query('COMMIT');const second=await late;assert.equal(second.operationId,first.operationId);assert.equal(second.duplicate,true);assert.deepEqual(second.pendingAction,first.pendingAction);
  if(resolveFirst){assert.equal(first.pendingAction.state,'CANCELLED');assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0);assert.equal((await checkpoints(f,id)).length,0);}
  else{const work=await f.claim();assert.equal(work.job.id,first.operationId);await f.runLegacy(work);assert.equal(f.providerPosts(),1);}
 }finally{await c.query('ROLLBACK');c.release();if(late)await late.catch(()=>{});}
}
async function unknown(f,fault,options){
 const created=await f.createLegacy();await f.authorize(created.id);const work=await f.legacyAction(created.id,'register');
 const registerOptions=fault==='receipt-loss'?{storeOverride:{...f.legacyStore,recordOriginalRegister:async()=>{throw Error('Synthetic receipt write lost');}}}:{fault};
 await assert.rejects(()=>f.runLegacy(work,registerOptions));assert.equal(f.providerPosts(),1);
 const retained=await checkpoints(f,created.id),originalReservations=await reservations(f,created.id),beforeBindings=await bindings(f);
 assert.equal(retained.length,1);assert.equal(retained[0].outcome,fault==='receipt-loss'?'ATTEMPTED':'UNKNOWN');
 const duplicate=await f.controller.legacyMigrationAction(f.request,f.connectionId,created.id,'register',work.key,work.body);
 assert.equal(duplicate.operationId,work.job.id);assert.equal(duplicate.duplicate,true);
 const current=await f.legacyView(created.id);assert.equal(current.actions.register,false);assert.equal(current.actions.reconcile,false);
 await assert.rejects(()=>f.controller.legacyMigrationAction(f.request,f.connectionId,created.id,'register',randomUUID(),{expectedRevision:current.revision,expectedReviewSha256:current.reviewSha256,confirmCutover:true}),denied);
 await assert.rejects(()=>f.controller.cancelLegacyMigration(f.request,f.connectionId,created.id,{expectedRevision:current.revision}),denied);
 const fundingBefore=(await f.rows(f.app,'SELECT * FROM meta_messaging_accounts WHERE id=$1',[f.targetAccountId]))[0];
 const forbidden=await f.legacyAction(created.id,'observe');
 await assert.rejects(()=>f.runLegacy(forbidden,{storeOverride:{...f.legacyStore,recordReadback:(job,lease,context,observation)=>
  f.legacyStore.recordReadback(job,lease,context,{...observation,fundingProof:{schemaVersion:1}})}}),denied);
 await f.runLegacy(await f.legacyAction(created.id,'observe'));
 assert.deepEqual((await f.rows(f.app,'SELECT * FROM meta_messaging_accounts WHERE id=$1',[f.targetAccountId]))[0],fundingBefore,'UNKNOWN never refreshes funding authority');
 if(fault==='disconnect'){
  const cleanup=new Client({connectionString:options.cleanupUrl});
  try{await cleanup.connect();const reference=(await f.rows(f.worker,"SELECT result#>>'{metaLegacyAuthorizationProof,secretReference}' AS ref FROM connection_operations WHERE id=$1",[(await plan(f,created.id)).legacy_authorization_operation_id]))[0].ref;
   assert.ok(reference);assert.equal((await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()])).rows.some(row=>row.secret_reference===reference),false,'Original unresolved authorization is retained without a legal hold');
  }finally{await cleanup.end();}
 }
 assert.deepEqual(await checkpoints(f,created.id),retained,'Equivalent readback cannot settle original effect');
 assert.deepEqual(await reservations(f,created.id),originalReservations);assert.deepEqual(await bindings(f),beforeBindings);assert.equal(f.providerPosts(),1);
 assert.equal((await plan(f,created.id)).reconciled_at,null);
 const job=randomUUID(),lease=randomUUID();
 await f.admin.query("INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot) VALUES($1,$2,'DELETE','TENANT',$2::uuid::text,'DELETE_TICKETS',$1::uuid::text,'RUNNING','LOCAL',1,$3,clock_timestamp()+interval '10 minutes',1,NULL)",[job,f.tenantId,lease]);
 await assert.rejects(()=>f.rows(f.worker,'SELECT app.redact_meta_legacy_migrations($1,$2,1)',[job,lease]),denied);
 assert.deepEqual(await checkpoints(f,created.id),retained);assert.deepEqual(await reservations(f,created.id),originalReservations);
}
async function positiveAndRollback(f){
 const history=await originalHistory(f),before=await bindings(f),conversation=(await f.rows(f.app,'SELECT * FROM bot_conversations WHERE id=$1',[f.conversationId]))[0];
 const {id,work}=await completed(f),original=await checkpoints(f,id),reserved=await reservations(f,id),originalPlan=await plan(f,id);
 assert.equal(original[0].outcome,'SUCCEEDED');assert.equal(reserved.length,2);assert.ok(reserved.every(r=>r.released_at===null));
 assert.equal((await f.rows(f.app,'SELECT state FROM connections WHERE id=$1',[f.connectionId]))[0].state,'PAUSED');
 assert.equal((await f.legacyView(id)).actions.reconcile,true);assert.deepEqual(await originalHistory(f),history);
 const reconciliation=await f.legacyAction(id,'reconcile');let afterInside;
 await assert.rejects(()=>f.runLegacy(reconciliation,{storeOverride:{...f.legacyStore,reconcile:async(job,lease,context,observation)=>f.tx(f.worker,f.tenantId,async c=>{
  const value=(await c.query('SELECT app.reconcile_meta_legacy_migration($1,$2,$3,$4,$5) AS value',[job.id,lease,job.fencingToken,context,observation])).rows[0].value;
  assert.equal(value,true);afterInside=(await c.query("SELECT state FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2 AND predecessor_binding_id=$3",[f.tenantId,f.connectionId,f.source.id])).rows[0];
  assert.equal(afterInside.state,'HELD');throw Error('Synthetic final transaction rollback');
 })}}),/Synthetic final transaction rollback/u);
 assert.ok(afterInside);assert.deepEqual(await bindings(f),before);assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);
 assert.equal((await plan(f,id)).identity_successor_receipt,null);assert.equal(f.providerPosts(),1);
 const recovery=await f.legacyAction(id,'reconcile');
 await assert.rejects(()=>f.legacyStore.context(recovery.job,randomUUID(),f.appId,'READBACK'),denied);
 await assert.rejects(()=>f.legacyStore.context({...recovery.job,fencingToken:recovery.job.fencingToken+1},recovery.lease,f.appId,'READBACK'),denied);
 await f.runLegacy(recovery);const settled=await plan(f,id),after=await bindings(f),target=after.find(b=>b.predecessor_binding_id===f.source.id);
 assert.equal(settled.legacy_state,'RECONCILED_PAUSED');assert.equal(settled.execution_state,'RECONCILED_PAUSED');assert.equal(settled.provider_migration_id,null);
 assert.equal(settled.identity_successor_receipt.claim,'SAME_GRAPH_PHONE_LEGACY_SUCCESSOR');
 assert.equal(target.account_id,f.targetAccountId);assert.equal(target.phone_number_id,f.source.phone_number_id);assert.equal(target.state,'HELD');
 assert.equal(target.template_mapping_operation_id,recovery.job.id);assert.equal(after.find(b=>b.id===f.source.id).state,'RETIRED');
 assert.equal(Number(after.find(b=>b.id===f.source.id).revision),Number(f.source.revision)+1);
 assert.deepEqual(settled.execution_scope,originalPlan.execution_scope);assert.equal(settled.execution_scope_sha256,originalPlan.execution_scope_sha256);
 assert.deepEqual(await checkpoints(f,id),original);assert.equal(f.providerPosts(),1);assert.deepEqual(await originalHistory(f),history);
 assert.ok((await reservations(f,id)).every(r=>r.released_at!==null&&r.release_reason==='VERIFIED_SUCCESSOR'));
 const result=(await f.rows(f.worker,'SELECT result FROM connection_operations WHERE id=$1',[recovery.job.id]))[0].result;
 assert.equal(result.metaTransitionIdentityReconciliation.status,'SETTLED');assert.ok(result.metaLegacyMigration.templateMapping.mappings.some(m=>m.flowVersionId===f.flow.id));
 assert.ok(result.metaLegacyMigration.templateMapping.mappings.some(m=>m.flowVersionId===f.pinnedFlow.id));
 assert.equal((await f.rows(f.app,'SELECT flow_version_id FROM bot_conversations WHERE id=$1',[f.conversationId]))[0].flow_version_id,conversation.flow_version_id);
 assert.equal((await f.rows(f.app,'SELECT secret_reference,state FROM connections WHERE id=$1',[f.connectionId]))[0].secret_reference,target.secret_reference);
 assert.equal((await f.rows(f.app,'SELECT state FROM connections WHERE id=$1',[f.connectionId]))[0].state,'PAUSED','No implicit activation or send');
 assert.equal((await f.rows(f.app,'SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2',[f.tenantId,f.connectionId]))[0].state,'PAUSED');
 assert.equal((await f.rows(f.app,'SELECT session_storage_reference FROM provider_sessions WHERE id=$1',[target.provider_session_id]))[0].session_storage_reference,`meta-cloud://${f.targetProviderId}/${f.phoneNumberId}`);
 const activation=(await f.rows(f.app,'SELECT app.meta_account_successor_activation($1) AS value',[f.connectionId]))[0].value;
 assert.equal(activation.transitionId,id);assert.equal(activation.sessionId,target.provider_session_id,'Existing explicit activation remains reachable');
 await assert.rejects(()=>f.rows(f.worker,'SELECT app.meta_billing_birth_snapshot($1)',[f.connectionId]),denied,'HELD successor cannot create a new send birth');
 const duplicate=await f.controller.legacyMigrationAction(f.request,f.connectionId,id,'register',work.key,work.body);assert.equal(duplicate.operationId,work.job.id);
 await assert.rejects(()=>f.rows(f.app,"SELECT app.reconcile_meta_legacy_migration($1,$2,$3,$4,$5)",[recovery.job.id,recovery.lease,recovery.job.fencingToken,'a'.repeat(64),{}]),e=>e.code==='42501');
 assert.deepEqual(await checkpoints(f,id),original);
 await settledPrivacy(f,id);
}

async function settledPrivacy(f,id){
 const original=await checkpoints(f,id),reserved=await reservations(f,id),beforePlan=await plan(f,id),traffic=f.providerPosts();
 const operations=await f.rows(f.worker,"SELECT *,encode(digest(payload::text,'sha256'),'hex') AS payload_sha,encode(digest(result::text,'sha256'),'hex') AS result_sha,encode(digest((result->'metaLegacyAuthorizationProof')::text,'sha256'),'hex') AS proof_sha FROM connection_operations WHERE tenant_id=$1 AND (payload ? 'metaLegacyMigration' OR payload ? 'metaLegacyAuthorization') ORDER BY id",[f.tenantId]);
 const hold=randomUUID(),job=randomUUID(),lease=randomUUID();
 await f.admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'TENANT',$2::uuid::text,$3,'Synthetic migration privacy oracle',$4)",[hold,f.tenantId,sha(f.tenantId),f.actorId]);
 await f.admin.query("INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot) VALUES($1,$2,'DELETE','TENANT',$2::uuid::text,'DELETE_TICKETS',$1::uuid::text,'RUNNING','LOCAL',1,$3,clock_timestamp()+interval '10 minutes',1,NULL)",[job,f.tenantId,lease]);
 const sql='SELECT app.redact_meta_legacy_migrations($1,$2,$3) AS value';
 try{
  await assert.rejects(()=>f.rows(f.app,sql,[job,lease,1]),e=>e.code==='42501');
  await assert.rejects(()=>f.rows(f.worker,sql,[job,randomUUID(),1]),e=>e.code==='42501');
  await assert.rejects(()=>f.rows(f.worker,sql,[job,lease,2]),e=>e.code==='42501');
  await assert.rejects(()=>f.tx(f.worker,f.foreignTenantId,c=>c.query(sql,[job,lease,1])),e=>e.code==='42501');
  await assert.rejects(()=>f.rows(f.worker,sql,[job,lease,1]),e=>e.code==='42501','Pre-existing legal hold blocks erasure');
  await f.admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[hold,f.actorId]);
  assert.ok((await f.rows(f.worker,sql,[job,lease,1]))[0].value>0);
  assert.equal((await f.rows(f.worker,sql,[job,lease,1]))[0].value,0);
  for(const old of operations){
   const current=(await f.rows(f.worker,'SELECT * FROM connection_operations WHERE id=$1',[old.id]))[0];
   assert.equal(current.idempotency_key,old.idempotency_key);assert.equal(current.requested_by_id,old.requested_by_id);assert.equal(current.state,old.state);
   if(old.payload.metaLegacyAuthorization){assert.deepEqual(current.payload,old.payload);assert.deepEqual(current.result,{...old.result,metaLegacyAuthorizationProof:{redacted:true,sha256:old.proof_sha}});}
   else{assert.deepEqual(current.payload,{redacted:true,sha256:old.payload_sha});assert.deepEqual(current.result,old.result===null?null:{redacted:true,sha256:old.result_sha});}
  }
  await f.rows(f.worker,'SELECT app.redact_meta_transition_private_scope($1,$2,$3)',[job,lease,1]);
  const redacted=await plan(f,id);assert.equal(redacted.execution_scope.redacted,true);assert.equal(redacted.execution_scope.sha256,beforePlan.execution_scope_sha256);
  assert.deepEqual(redacted.identity_successor_receipt,beforePlan.identity_successor_receipt);
  assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);assert.equal(f.providerPosts(),traffic);
 }finally{await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[job]));}
}

async function signedReadbackRace(f){
 const {id}=await completed(f),original=await checkpoints(f,id),history=await originalHistory(f);let invalidated=false;
 const work=await f.legacyAction(id,'reconcile');
 await assert.rejects(()=>f.runLegacy(work,{beforeFetch:async({path})=>{
  if(!invalidated&&path===`/${f.targetProviderId}/message_templates`){invalidated=true;
   const value=(await f.rows(f.app,"SELECT app.invalidate_meta_template_account($1,$2,$3,$4,$5,'message_template_status_update',$6) AS value",
    [f.targetConnectionId,f.targetSessionId,f.targetProviderId,f.appId,sha('synthetic-late-template-negative-'+id),f.targetTemplates[0].id]))[0].value;
   assert.equal(value.accepted,true);
  }
 }}));assert.equal(invalidated,true);assert.equal((await plan(f,id)).identity_successor_receipt,null);
 assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await originalHistory(f),history);
 // A deliberate successor read rechecks current target semantic bytes at the
 // new ingress generation; the signed event itself never clears readiness.
 await f.runLegacy(await f.legacyAction(id,'reconcile'));
 const settled=await plan(f,id),result=(await f.rows(f.worker,'SELECT result FROM connection_operations WHERE id=$1',[settled.legacy_readback_operation_id]))[0].result;
 assert.equal(settled.legacy_state,'RECONCILED_PAUSED');assert.equal(result.metaLegacyMigration.templateMapping.targetSafetyRevision,1);
 assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await originalHistory(f),history);assert.equal(f.providerPosts(),1);
}

async function awaitEvidenceExpiry(f,expiresAt){
 const remaining=(await f.admin.query('SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))::float8)+0.02 AS seconds',[expiresAt])).rows[0].seconds;
 assert.ok(remaining<11,'Finite expiry oracle never waits for a full production TTL');
 await f.admin.query('SELECT pg_sleep($1)',[remaining]);
}
async function fundingRecovery(f){
 const expiry=await f.shortTargetFunding(),{id}=await completed(f);
 const original=await checkpoints(f,id),reserved=await reservations(f,id),beforePlan=await plan(f,id);
 await awaitEvidenceExpiry(f,expiry);
 const account=async()=>(await f.rows(f.app,'SELECT * FROM meta_messaging_accounts WHERE id=$1',[f.targetAccountId]))[0];
 const expired=await account(),view=await f.legacyView(id);assert.equal(view.actions.observe,true);assert.equal(view.actions.reconcile,false);
 await assert.rejects(()=>f.controller.requestMetaBillingDiagnostic(f.request,f.targetConnectionId,randomUUID(),{}),denied,'Ordinary funding refresh stays reservation-blocked');
 for(const fundingFault of ['unavailable','foreign','changed']){
  const work=await f.legacyAction(id,'observe');await assert.rejects(()=>f.runLegacy(work,{fundingFault}));
  assert.deepEqual(await account(),expired);assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);
 }
 const stale=await f.legacyAction(id,'observe');
 await assert.rejects(()=>f.runLegacy(stale,{storeOverride:{...f.legacyStore,recordReadback:async(job,lease,context,observation)=>
  f.legacyStore.recordReadback(job,lease,context,{...observation,fundingProof:{...observation.fundingProof,observedAt:new Date(Date.now()-16*60_000).toISOString(),expiresAt:new Date(Date.now()-60_000).toISOString()}})}}),denied);
 assert.deepEqual(await account(),expired);
 const fresh=await f.legacyAction(id,'observe');let actualObservation,actualContext;
 await f.runLegacy(fresh,{storeOverride:{...f.legacyStore,recordReadback:async(job,lease,context,observation)=>{
  actualObservation=observation;actualContext=context;
  await assert.rejects(()=>f.rows(f.app,'SELECT app.record_meta_legacy_readback($1,$2,$3,$4,$5)',[job.id,lease,job.fencingToken,context,observation]),e=>e.code==='42501');
  await assert.rejects(()=>f.legacyStore.recordReadback(job,randomUUID(),context,observation),denied);
  return f.legacyStore.recordReadback(job,lease,context,observation);
 }}});
 const refreshed=await account(),receipt=(await f.rows(f.worker,'SELECT result FROM connection_operations WHERE id=$1',[fresh.job.id]))[0].result;
 assert.deepEqual(receipt.metaLegacyMigration.fundingProof,actualObservation.fundingProof);
 assert.equal(refreshed.last_observation_operation_id,fresh.job.id);assert.ok(new Date(refreshed.funding_expires_at)>new Date());
 for(const key of ['authority_revision','active_policy_version_id','requested_policy_version_id','primary_funding_id','observed_owner_business_id','state'])assert.deepEqual(refreshed[key],expired[key]);
 assert.deepEqual((await plan(f,id)).execution_scope,beforePlan.execution_scope);assert.equal((await plan(f,id)).legacy_target_scope_sha256,beforePlan.legacy_target_scope_sha256);
 assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);assert.equal(f.providerPosts(),1);
 await assert.rejects(()=>f.legacyStore.recordReadback(fresh.job,fresh.lease,actualContext,actualObservation),denied,'Terminal operation cannot replay the refresh');
 assert.equal((await f.legacyView(id)).actions.reconcile,true);await f.runLegacy(await f.legacyAction(id,'reconcile'));
 assert.equal((await plan(f,id)).legacy_state,'RECONCILED_PAUSED');assert.deepEqual(await checkpoints(f,id),original);assert.equal(f.providerPosts(),1);
}

async function fundingRecoveryWithIdentityDrift(f){
 const expiry=await f.shortTargetFunding(),{id}=await completed(f);
 const original=await checkpoints(f,id),reserved=await reservations(f,id),originalPlan=await plan(f,id);
 const account=async()=>(await f.rows(f.app,'SELECT * FROM meta_messaging_accounts WHERE id=$1',[f.targetAccountId]))[0];
 const identity=async()=>({
  aliases:await f.rows(f.worker,'SELECT * FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[f.tenantId,f.connectionId]),
  markers:await f.rows(f.worker,'SELECT id,payload_sha256,meta_direct_asset,meta_direct_identity_transition,meta_direct_identity_resolution FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[f.tenantId,f.connectionId])});
 let prior=f.identityAnchor.bsuid,sequence=0;const identityTimestamp=Math.floor(Date.now()/1000);
 const signedChange=async()=>{
  const next='SA.legacyfunding'+(++sequence),message={id:randomUUID(),type:'system',timestamp:String(identityTimestamp+sequence-1),
   system:{type:'user_changed_user_id',previous_user_id:prior,user_id:next}};
  const row=await f.identityHttp.send(message,f.providerAccountId);prior=next;
  assert.equal(row.meta_direct_asset.providerSessionId,f.source.provider_session_id);
  assert.ok(row.meta_direct_identity_transition);assert.equal(row.meta_direct_identity_resolution,null);return row;
 };
 const currentIdentity=()=>f.rows(f.worker,'SELECT app.meta_transition_identity_snapshot(app.meta_transition_scope($1)) AS value',[f.accountId]).then(v=>v[0].value);
 const unchanged=async()=>{
  const p=await plan(f,id);assert.deepEqual(p.execution_scope,originalPlan.execution_scope);
  assert.equal(p.execution_scope_sha256,originalPlan.execution_scope_sha256);
  assert.equal(p.legacy_target_scope_sha256,originalPlan.legacy_target_scope_sha256);
  assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);assert.equal(f.providerPosts(),1);
 };
 await signedChange();await awaitEvidenceExpiry(f,expiry);
 const expired=await account(),view=await f.legacyView(id);
 assert.equal(view.actions.observe,true,'Signed identity drift cannot strand explicit target funding readback');assert.equal(view.actions.reconcile,false);
 // Every request captures the current identity while retaining original account,
 // binding and flow authority. A later marker invalidates that queued snapshot.
 for(const point of ['before-request','between-requests','before-commit']){
  const work=await f.legacyAction(id,'observe'),queued=work.job.payload.metaLegacyMigration.localIdentityScope;
  assert.deepEqual(queued,await currentIdentity());
  assert.notEqual(queued[0].identitySha256,originalPlan.execution_scope.bindings[0].identitySha256);
  const calls=f.legacyCalls.length;let changed=false,enteredCommit=false;
  if(point==='before-request'){await signedChange();changed=true;}
  const options=point==='between-requests'?{beforeFetch:async()=>{if(!changed){await signedChange();changed=true;}}}:
   point==='before-commit'?{storeOverride:{...f.legacyStore,recordReadback:async(job,lease,context,observation)=>{
    enteredCommit=true;assert.ok(observation.fundingProof);await signedChange();changed=true;
    return f.legacyStore.recordReadback(job,lease,context,observation);
   }}}:{};
  await assert.rejects(()=>f.runLegacy(work,options));assert.equal(changed,true);
  if(point==='before-request')assert.equal(f.legacyCalls.length,calls,'Queue-to-request drift stops before Graph');
  if(point==='between-requests')assert.equal(f.legacyCalls.length,calls+1,'The next guarded request sees the signed marker');
  if(point==='before-commit')assert.equal(enteredCommit,true,'Actual SQL commit currentness is exercised after successful GETs');
  assert.deepEqual(await account(),expired,'Rejected currentness cannot leave a partial funding refresh');
  assert.equal((await f.rows(f.worker,'SELECT result FROM connection_operations WHERE id=$1',[work.job.id]))[0].result,null);
  assert((await identity()).markers.filter(v=>v.meta_direct_identity_transition).every(v=>v.meta_direct_identity_resolution===null));
  await unchanged();
 }
 const fresh=await f.legacyAction(id,'observe'),beforeIdentity=await identity();
 assert.deepEqual(fresh.job.payload.metaLegacyMigration.localIdentityScope,await currentIdentity());
 await f.runLegacy(fresh);
 const refreshed=await account(),observed=(await f.rows(f.worker,'SELECT result FROM connection_operations WHERE id=$1',[fresh.job.id]))[0].result.metaLegacyMigration;
 assert.ok(new Date(refreshed.funding_expires_at)>new Date());assert.equal(refreshed.last_observation_operation_id,fresh.job.id);
 assert.equal(observed.originalOutcome,'SUCCEEDED');assert.equal(observed.fundingProof.accountId,f.targetProviderId);
 assert.deepEqual(await identity(),beforeIdentity,'OBSERVE cannot settle or rewrite identity markers/aliases');await unchanged();
 assert.equal((await f.legacyView(id)).actions.reconcile,true);
 const reconcile=await f.legacyAction(id,'reconcile');await f.runLegacy(reconcile);
 const final=await plan(f,id);assert.equal(final.legacy_state,'RECONCILED_PAUSED');
 assert.deepEqual(final.execution_scope,originalPlan.execution_scope);assert.equal(final.execution_scope_sha256,originalPlan.execution_scope_sha256);
 assert.deepEqual(await checkpoints(f,id),original);assert.equal(f.providerPosts(),1);
 const settled=await identity();assert(settled.markers.filter(v=>v.meta_direct_identity_transition).every(v=>v.meta_direct_identity_resolution!==null));
 assert(settled.aliases.some(v=>v.value===prior&&v.state==='ACTIVE'));
 assert.equal((await f.rows(f.app,'SELECT state FROM connections WHERE id=$1',[f.connectionId]))[0].state,'PAUSED');
}

async function expiredRuntimeRenewal(f,afterEffect){
 const {id}=await f.createLegacy();await f.authorize(id);
 if(afterEffect){const work=await f.legacyAction(id,'register');await assert.rejects(()=>f.runLegacy(work,{fault:'disconnect'}));}
 const original=await checkpoints(f,id),reserved=await reservations(f,id),originalPlan=await plan(f,id);
 await awaitEvidenceExpiry(f,f.candidate.expiresAt);
 const current=await f.legacyView(id);assert.equal(current.actions.register,false);
 if(!afterEffect){assert.equal(current.authorization,null);assert.equal(original.length,0);assert.equal(f.providerPosts(),0);return;}
 assert.equal(current.authorization.targetLegacyMigrationId,id);assert.equal(current.authorization.canPrepare,true);
 assert.equal(current.reasons.includes('LEGACY_PROVIDER_CONTRACT_UNAVAILABLE'),false);
 await f.authorize(id);assert.equal((await f.legacyView(id)).actions.register,false);assert.equal((await f.legacyView(id)).actions.reconcile,false);
 await f.runLegacy(await f.legacyAction(id,'observe'));
 assert.deepEqual(await checkpoints(f,id),original);assert.deepEqual(await reservations(f,id),reserved);
 assert.deepEqual((await plan(f,id)).execution_scope,originalPlan.execution_scope);assert.equal(f.providerPosts(),1);
}
async function rotationHold(options){
 const f=await createMetaLegacyMigrationFixture(options),other=await createMetaLegacyMigrationFixture(options),cleanup=new Client({connectionString:options.cleanupUrl});
 try{
  await cleanup.connect();
  const close=async x=>{const {id}=await x.createLegacy(),authorization=await x.authorize(id),v=await x.legacyView(id);
   await x.controller.cancelLegacyMigration(x.request,x.connectionId,id,{expectedRevision:v.revision});
   const row=(await x.rows(x.worker,"SELECT result->'metaLegacyAuthorizationProof' AS proof FROM connection_operations WHERE id=$1",[authorization.operationId]))[0];
   assert.ok(row.proof.secretReference);return row.proof.secretReference;};
  const ref=await close(f),unrelated=await close(other),hold=randomUUID();
  await f.admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'TENANT',$2::uuid::text,$3,'Synthetic rotation retention',$4)",[hold,f.tenantId,sha(f.tenantId),f.actorId]);
  const first=(await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()])).rows;
  assert.equal(first.some(row=>row.secret_reference===ref),false);assert.equal(first.some(row=>row.secret_reference===unrelated),true);
  await f.admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[hold,f.actorId]);
  const next=(await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()])).rows;
  assert.equal(next.some(row=>row.secret_reference===ref),true,'Only otherwise eligible unreferenced rotation is released');
 }finally{await Promise.allSettled([cleanup.end(),f.close(),other.close()]);}
}

export async function verifyMetaLegacyMigration(options){
 {const f=await createMetaLegacyMigrationFixture(options,{withIdentity:true});try{await fundingRecoveryWithIdentityDrift(f);}finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{await fundingRecovery(f);}finally{await f.close();}}
 for(const afterEffect of [false,true]){const f=await createMetaLegacyMigrationFixture(options,{runtimeLifetimeMs:10000});try{await expiredRuntimeRenewal(f,afterEffect);}finally{await f.close();}}
 await rotationHold(options);
 for(const resolveFirst of [true,false]){const f=await createMetaLegacyMigrationFixture(options);try{await createOrdering(f,resolveFirst);}finally{await f.close();}}
 for(const resolveFirst of [true,false]){const f=await createMetaLegacyMigrationFixture(options);try{const created=await f.createLegacy();await f.authorize(created.id);await actionOrdering(f,created.id,resolveFirst);}finally{await f.close();}}
 for(const fault of ['disconnect','malformed','receipt-loss']){const f=await createMetaLegacyMigrationFixture(options);try{await unknown(f,fault,options);}finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{await positiveAndRollback(f);}finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{await signedReadbackRace(f);}finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{
  const created=await f.createLegacy();await f.authorize(created.id);const work=await f.legacyAction(created.id,'register');
  await assert.rejects(()=>f.runLegacy(work,{fault:'reject'}));const original=await checkpoints(f,created.id);assert.equal(original[0].outcome,'REJECTED');
  const current=await f.legacyView(created.id);assert.equal(current.actions.register,false);assert.equal(current.actions.cancel,true);
  await assert.rejects(()=>f.controller.cancelLegacyMigration(f.request,f.connectionId,created.id,{expectedRevision:current.revision-1}),denied);
  await assert.rejects(()=>f.controller.cancelLegacyMigration({...f.request,principal:{...f.request.principal,tenantId:f.foreignTenantId}},f.connectionId,created.id,{expectedRevision:current.revision}),denied);
  await f.controller.cancelLegacyMigration(f.request,f.connectionId,created.id,{expectedRevision:current.revision});
  assert.equal((await f.rows(f.app,'SELECT state FROM connections WHERE id=$1',[f.connectionId]))[0].state,'PAUSED');
  assert.equal((await f.rows(f.app,'SELECT state FROM provider_sessions WHERE id=$1',[f.source.provider_session_id]))[0].state,'PAUSED');
  const duplicateClose=await f.controller.cancelLegacyMigration(f.request,f.connectionId,created.id,{expectedRevision:current.revision});
  assert.equal(duplicateClose.duplicate,true);
  assert.equal((await f.legacyView(created.id)).state,'CANCELLED');assert.ok((await reservations(f,created.id)).every(r=>r.released_at!==null));
  assert.deepEqual(await checkpoints(f,created.id),original);assert.equal(f.providerPosts(),1);
 }finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{
  const audit=async()=>(await f.admin.query("SELECT id FROM platform_operations_audit_events WHERE action='meta.runtime.simulated.registered' AND safe_metadata->>'tenantId'=$1 ORDER BY id",[f.tenantId])).rows;
  const before=await audit();
  await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE meta_connection_account_bindings SET state='HELD',revision=revision+1 WHERE id=$1",[f.source.id]));
  await assert.rejects(()=>f.registerRuntime(f.candidate),denied);assert.deepEqual(await audit(),before,'A stale source binding cannot register eligibility');
 }finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{
  await f.duplicateSourceBinding();
  const count=(await f.rows(f.worker,"SELECT count(*)::integer AS count FROM meta_connection_account_bindings WHERE tenant_id=$1 AND account_id=$2 AND phone_number_id=$3 AND state='ACTIVE'",[f.tenantId,f.accountId,f.phoneNumberId]))[0].count;
  assert.equal(count,2,'The actual registrar must see ambiguous current same-phone scope');
  await assert.rejects(()=>f.registerRuntime(f.candidate),e=>e.code==='55000');assert.equal(f.providerPosts(),0);
 }finally{await f.close();}}
 {const f=await createMetaLegacyMigrationFixture(options);try{
  const audit=async()=>(await f.admin.query("SELECT id FROM platform_operations_audit_events WHERE action='meta.runtime.simulated.registered' AND safe_metadata->>'tenantId'=$1 ORDER BY id",[f.tenantId])).rows;
  const initial=await audit();
  for(const change of [{phoneId:'999999999'},{appId:'999999998'},{graphVersion:'v25.0'},{tenantId:f.foreignTenantId},{targetAccountId:f.accountId},{sourceProviderAccountId:f.targetProviderId},{sourceAccountId:f.accountId}])
   await assert.rejects(()=>f.registerRuntime({...f.candidate,legacyMigration:{...f.candidate.legacyMigration,...change}}),denied);
  assert.deepEqual(await audit(),initial,'Invalid tuples cannot create synthetic eligibility');
  const created=await f.createLegacy();await f.authorize(created.id);
  const supportingOwner=randomUUID();await f.admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$1::uuid::text,$2,'Synthetic migration support')",[supportingOwner,`legacy-${supportingOwner}@example.invalid`]);
  await f.admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[f.tenantId,supportingOwner]);
  await f.admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.actorId]);
  try{const held=await f.legacyView(created.id);assert.equal(held.actions.register,false);assert.equal(held.actions.cancel,false);
   await assert.rejects(()=>f.controller.cancelLegacyMigration(f.request,f.connectionId,created.id,{expectedRevision:held.revision}),denied);
  }finally{await f.admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[f.tenantId,f.actorId]);}
  await assert.rejects(()=>f.controller.legacyMigrationView({...f.request,principal:{...f.request.principal,tenantId:f.foreignTenantId}},f.connectionId,created.id),denied);
  const newFlow=await f.nextFlow(f.pinnedFlow,f.sourceTemplates[0].name);
  // nextFlow invokes the real activation producer, which migrates the assignment.
  // Existing conversations retain their immutable original flow snapshot.
  assert.deepEqual(await f.rows(f.app,'SELECT flow_family_id,flow_version_id,state FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2',[f.tenantId,f.connectionId]),
   [{flow_family_id:newFlow.family,flow_version_id:newFlow.id,state:'ACTIVE'}]);
  assert.equal((await f.rows(f.app,'SELECT flow_version_id FROM bot_conversations WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.conversationId]))[0].flow_version_id,f.flow.id);
  const current=await f.legacyView(created.id);await assert.rejects(()=>f.controller.legacyMigrationAction(f.request,f.connectionId,created.id,'register',randomUUID(),{expectedRevision:current.revision,expectedReviewSha256:current.reviewSha256,confirmCutover:true}),denied);
  assert.equal((await checkpoints(f,created.id)).length,0);assert.equal((await reservations(f,created.id)).length,0);assert.equal(f.providerPosts(),0);
 }finally{await f.close();}}
 return{mode:'SIMULATED',actualRoles:true,typedLegacySuccessor:true,originalUnknownPreserved:true,liveEligibility:false};
}
