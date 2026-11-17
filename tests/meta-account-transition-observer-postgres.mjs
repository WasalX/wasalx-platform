import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createMetaTransitionExecutionFixture} from './meta-account-transition-execution-fixture-postgres.mjs';
import {createMetaTransitionObserverHarness} from './meta-account-transition-observer-fixture-postgres.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const checkpoints=f=>id=>f.tx(f.app,f.tenantId,async c=>(await c.query("SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 ORDER BY stage",[f.tenantId,id])).rows);
async function approveCompletion(f,id,observerOperationId,overrides={}){
 const p=await f.plan(id),authority=await f.sqlValue(f.app,'SELECT app.meta_transition_authorization($1) AS value',[id]);
 const review=await f.sqlValue(f.app,'SELECT app.meta_transition_target_review($1) AS value',[id]);
 return f.sqlValue(f.platform,'SELECT app.operator_authorize_meta_transition_completion($1,$2,$3,$4,$5,$6) AS value',
  [id,p.revision,observerOperationId,{mode:'SIMULATED',prerequisiteReceiptId:authority.receiptId,targetReviewReceiptId:review.receiptId,
   evidenceSha256:sha('synthetic-separate-completion-authorization'),expiresAt:new Date(Date.now()+10*60_000).toISOString(),...overrides},
  'synthetic-mfa-operator','transition-renewed-completion']);
}

// Actual LOCAL privacy authority fixture; provider proof and all effect history
// are produced by the real transition/renewal functions before this is called.
async function privacyJob(f,run){
 const id=randomUUID(),lease=randomUUID();
 await f.admin.query("INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot) VALUES($1,$2,'DELETE','TENANT',$2::uuid::text,'DELETE_TICKETS',$1::uuid::text,'RUNNING','LOCAL',1,$3,clock_timestamp()+interval '10 minutes',1,NULL)",[id,f.tenantId,lease]);
 try{return await run({id,lease});}finally{
  await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[id]));
 }
}
const redactSql='SELECT app.redact_meta_transition_observer_proofs($1,$2,$3) AS value';
async function observerPrivacy(f,id,stage,{settled}){
 const before=(await f.tx(f.worker,f.tenantId,c=>c.query("SELECT *,encode(digest((result->'metaTransitionObserverProof')::text,'sha256'),'hex') AS proof_sha FROM connection_operations WHERE id=$1",[stage.id]))).rows[0];
 const slots=await checkpoints(f)(id),plan=await f.plan(id),traffic=f.traffic.length;
 const reservations=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2 ORDER BY id',[f.tenantId,id]))).rows;
 const hold=settled?randomUUID():null;
 // Incumbent 0133 forbids a new hold after deletion has started. Establish the
 // actual legal hold before this LOCAL authority fixture, then release it only
 // after proving that the real redaction function refuses the held tenant.
 if(hold)await f.admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'TENANT',$2::uuid::text,$3,'Synthetic privacy retention oracle',$4)",[hold,f.tenantId,sha(f.tenantId),f.actorId]);
 await privacyJob(f,async job=>{
  await assert.rejects(()=>f.sqlValue(f.app,redactSql,[job.id,job.lease,1]),error=>error.code==='42501');
  await assert.rejects(()=>f.tx(f.worker,f.foreignTenantId,c=>c.query(redactSql,[job.id,job.lease,1])),error=>error.code==='42501');
  await assert.rejects(()=>f.sqlValue(f.worker,redactSql,[job.id,randomUUID(),1]),error=>error.code==='42501');
  await assert.rejects(()=>f.sqlValue(f.worker,redactSql,[job.id,job.lease,2]),error=>error.code==='42501');
  await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE privacy_jobs SET stage='DISCOVER' WHERE id=$1",[job.id]));
  await assert.rejects(()=>f.sqlValue(f.worker,redactSql,[job.id,job.lease,1]),error=>error.code==='42501');
  await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE privacy_jobs SET stage='LOCAL' WHERE id=$1",[job.id]));
  const tombstone={...before.result,metaTransitionObserverProof:{redacted:true,sha256:before.proof_sha}};
  for(const pool of [f.app,f.worker])await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('UPDATE connection_operations SET result=$2 WHERE id=$1',[stage.id,tombstone])),error=>['42501','23514'].includes(error.code));
  if(!settled){
   await assert.rejects(()=>f.sqlValue(f.worker,redactSql,[job.id,job.lease,1]),error=>['42501','55000'].includes(error.code));
   assert.deepEqual((await f.tx(f.worker,f.tenantId,c=>c.query('SELECT result FROM connection_operations WHERE id=$1',[stage.id]))).rows[0].result,before.result);
  }else{
   const lateHold=randomUUID();
   await assert.rejects(()=>f.admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2,'TENANT',$2::uuid::text,$3,'Synthetic late hold denial',$4)",[lateHold,f.tenantId,sha(f.tenantId),f.actorId]),error=>error.code==='55000');
   assert.equal((await f.admin.query('SELECT id FROM privacy_legal_holds WHERE id=$1',[lateHold])).rowCount,0);
   await assert.rejects(()=>f.sqlValue(f.worker,redactSql,[job.id,job.lease,1]),error=>error.code==='42501');
   await f.admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[hold,f.actorId]);
   assert.equal(await f.sqlValue(f.worker,redactSql,[job.id,job.lease,1]),1);
   assert.equal(await f.sqlValue(f.worker,redactSql,[job.id,job.lease,1]),0,'Exact lawful redaction is idempotent');
   const after=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM connection_operations WHERE id=$1',[stage.id]))).rows[0];
   const {proof_sha:ignored,...original}=before;assert.ok(ignored);
   assert.deepEqual(after,{...original,result:tombstone},'Only the private proof becomes its exact PostgreSQL JSONB digest');
   await assert.rejects(()=>f.sqlValue(f.worker,'SELECT app.meta_transition_observer_credential($1,$2,$3) AS value',[id,f.sourceBindingId,stage.id]),error=>error.code==='55000');
   assert.deepEqual(Object.keys(after.result.metaTransitionObserverProof).sort(),['redacted','sha256']);
  }
 });
 assert.deepEqual(await checkpoints(f)(id),slots);assert.deepEqual(await f.plan(id),plan);
 assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2 ORDER BY id',[f.tenantId,id]))).rows,reservations);
 assert.equal(f.traffic.length,traffic,'Privacy makes no provider request or effect recovery');
}

/** Real tenant app, worker, platform and cleanup login boundaries; no fake
 * observer proof or completed provider slot is written by the fixture admin. */
export async function verifyMetaTransitionObserverRenewal(options){
 const outcomes=[];
 for(const requestedMode of ['CUSTOMER','WASALX_MANAGED']){
  const f=await createMetaTransitionExecutionFixture(options,{requestedMode}),cleanup=new Client({connectionString:options.cleanupUrl});
  try{
   await cleanup.connect();const id=await f.createPreview();await f.authorize(id);await f.run(id,'INITIATE');await f.run(id,'OBSERVE');await f.reviewTarget(id);await f.run(id,'OBSERVE');
   const before=await f.plan(id),initialSlots=await checkpoints(f)(id);assert.equal(initialSlots.length,1);assert.equal(initialSlots[0].outcome,'SUCCEEDED');
   const sourceBefore=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT secret_reference,provider_session_id,credential_fingerprint,revision FROM meta_connection_account_bindings WHERE id=$1',[f.sourceBindingId]))).rows[0];
   f.revokeOriginalCredential();const h=createMetaTransitionObserverHarness(f,id),begun=await h.start(),choices=await h.exchange(begun);
   assert.equal(begun.targetTransitionId,id);assert.equal(choices.purpose,'TRANSITION_READBACK');assert.equal(choices.choices[0].selectable,true);
   await assert.rejects(()=>h.invoke(()=>h.service.exchange(h.request,begun.attemptId,{challenge:begun.challenge,code:randomUUID(),expectedRevision:begun.revision})),/changed/);
   await assert.rejects(()=>h.invoke(()=>h.controller.signupSelect(h.request,choices.attemptId,{choiceId:choices.choices[0].choiceId,
    expectedRevision:choices.revision,selectionRevision:choices.selectionRevision,registrationPin:'123456'})),/invalid/);
   if(requestedMode==='CUSTOMER'){
    h.loseWrite();const lostResponse=await h.select(choices);
    assert.equal(lostResponse.status,'SELECTION_REQUIRED');assert.ok(lostResponse.operationId);
    const staged=await h.get(choices.attemptId);assert.equal(staged.status,'SELECTION_REQUIRED');assert.equal(staged.operationId,lostResponse.operationId);
    const originalWrites=[...h.writes],originalReads=[...h.reads],originalReference=originalWrites.find(ref=>ref.includes('/connections/'));
    assert.equal(originalWrites.filter(ref=>ref.includes('/connections/')).length,1);
    assert.equal(originalReads.includes(originalReference),false,'Lost store returns the durable stage before any original-reference read');
    await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE connection_operations SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1",[staged.operationId]));
    await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
    assert.equal((await f.tx(f.app,f.tenantId,c=>c.query('SELECT state FROM connection_operations WHERE id=$1',[staged.operationId]))).rows[0].state,'STAGED');
    h.restoreWrite();await h.select(await h.get(choices.attemptId));
    assert.equal(h.reads.includes(originalReference),true,'Resume checks the original stored reference');
    assert.equal(h.writes.filter(ref=>ref===originalReference).length,1,'Resume never repeats the unknown store');
   }else await h.select(choices);
   const renewed=await h.get(choices.attemptId);assert.equal(renewed.outcome,'READBACK_ACCESS_RENEWED');assert.equal(renewed.status,'COMPLETED');
   assert.equal(h.calls.filter(path=>path==='/oauth/access_token').length,1);
   const stage=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM connection_operations WHERE id=$1',[renewed.operationId]))).rows[0];
   const ref=stage.payload.newSecretReference;assert.equal(h.writes.filter(value=>value===ref).length,1,'Lost PUT response is reconciled by exact read, never a second write');
   assert.notEqual(ref,f.secretReference);assert.equal(stage.result.metaTransitionObserverReady,true);
   await observerPrivacy(f,id,stage,{settled:false});
   const after=await f.plan(id);assert.deepEqual(after.execution_scope,before.execution_scope);assert.equal(after.execution_scope_sha256,before.execution_scope_sha256);
   assert.deepEqual(await checkpoints(f)(id),initialSlots);assert.equal(after.observer_operations[f.sourceBindingId],stage.id);
   assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query('SELECT secret_reference,provider_session_id,credential_fingerprint,revision FROM meta_connection_account_bindings WHERE id=$1',[f.sourceBindingId]))).rows[0],sourceBefore);
   await assert.rejects(()=>f.tx(f.app,f.tenantId,c=>c.query("UPDATE meta_account_transitions SET observer_operations='{}' WHERE id=$1",[id])),error=>error.code==='42501');
   await assert.rejects(()=>f.sqlValue(f.worker,'SELECT app.meta_transition_observer_credential($1,$2,$3) AS value',[id,f.sourceBindingId,randomUUID()]),error=>error.code==='55000');
   const claimed=await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
   assert.equal(claimed.rows.some(row=>row.secret_reference===ref),false,'Selected completed observer survives while the original reservation is unresolved');
   const denied=await f.confirmation(id);await assert.rejects(()=>f.action(id,'COMPLETE',randomUUID(),denied));
   assert.equal((await checkpoints(f)(id)).length,1,'Renewal itself creates no COMPLETE slot');
   await f.run(id,'OBSERVE');const observed=await f.plan(id);
   const observation=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT result FROM connection_operations WHERE id=$1',[observed.provider_observation_operation_id]))).rows[0].result.metaTransitionObservation;
   assert.equal(observation.targetReadiness.assets,'CLONE_ACCESS_VERIFIED');assert.deepEqual(observation.targetAssets,[]);
   assert.equal(observation.cloneAccess.observerOperationId,stage.id);assert.equal(f.traffic.some(row=>row.path.endsWith('/phone_numbers')),false);
   await assert.rejects(()=>approveCompletion(f,id,stage.id,{expiresAt:new Date(Date.now()-1_000).toISOString()}),error=>error.code==='55000');
   await assert.rejects(()=>approveCompletion(f,id,randomUUID()),error=>error.code==='55000');
   await approveCompletion(f,id,stage.id);await f.run(id,'COMPLETE');await f.run(id,'OBSERVE');
   const completed=await f.plan(id),completedSlots=await checkpoints(f)(id);
   assert.equal(completed.provider_status,'COMPLETED');assert.equal(completedSlots.length,2);assert.deepEqual(completedSlots.find(row=>row.stage==='INITIATE'),initialSlots[0]);
   const finalObservation=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT result FROM connection_operations WHERE id=$1',[completed.provider_observation_operation_id]))).rows[0].result.metaTransitionObservation;
   assert.equal(finalObservation.targetAssets[0].observerOperationId,stage.id);assert.equal(finalObservation.targetAssets[0].secretReference,ref);
   const beforeReconcile=f.traffic.length;await f.run(id,'RECONCILE');assert.equal(f.traffic.length,beforeReconcile);
   const settled=await f.plan(id);assert.equal(settled.execution_state,'RECONCILED_PAUSED');assert.equal(settled.identity_successor_receipt.claim,'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR');
   const target=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT secret_reference,credential_fingerprint FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2 AND state=\'HELD\'',[f.tenantId,f.connectionId]))).rows[0];
   assert.equal(target.secret_reference,ref);assert.equal(target.credential_fingerprint,stage.result.metaTransitionObserverProof.credentialFingerprint);
   const currentConnection=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT secret_reference FROM connections WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.connectionId]))).rows[0];
   assert.equal(currentConnection.secret_reference,ref,'Atomic successor uses the renewed reference while the target remains held');
   const finalClaim=await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
   assert.equal(finalClaim.rows.some(row=>row.secret_reference===ref),false,'Promoted current target reference survives after reservation release');
   await observerPrivacy(f,id,stage,{settled:true});
   assert.equal(f.traffic.filter(row=>row.method==='POST').length,2);outcomes.push({requestedMode,exchanges:1,credentialWrites:1,providerPosts:2,renewedTarget:'PAUSED'});
  }finally{await Promise.allSettled([cleanup.end(),f.close()]);}
 }
 const f=await createMetaTransitionExecutionFixture(options);
 try{
  const id=await f.createPreview();await f.authorize(id);await f.run(id,'INITIATE');await f.run(id,'OBSERVE');await f.reviewTarget(id);
  const h=createMetaTransitionObserverHarness(f,id),renewed=await h.renew();await f.run(id,'OBSERVE');await approveCompletion(f,id,renewed.operationId);
  await assert.rejects(()=>f.run(id,'COMPLETE',{unknownStage:'COMPLETE'}));const original=await checkpoints(f)(id);
  assert.equal(original.find(row=>row.stage==='COMPLETE').outcome,'UNKNOWN');
  const next=await h.renew();assert.notEqual(next.operationId,renewed.operationId);await f.run(id,'OBSERVE');
  const uncertainObserver=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM connection_operations WHERE id=$1',[next.operationId]))).rows[0];
  await observerPrivacy(f,id,uncertainObserver,{settled:false});
  await assert.rejects(()=>approveCompletion(f,id,next.operationId),error=>error.code==='55000');
  const blockedBody=await f.confirmation(id);await assert.rejects(()=>f.action(id,'COMPLETE',randomUUID(),blockedBody));
  assert.deepEqual(await checkpoints(f)(id),original);assert.equal(f.traffic.filter(row=>row.method==='POST').length,2);
  outcomes.push({unresolvedComplete:'RETAINED',renewalDidNotReopenSlot:true});
 }finally{await f.close();}
 return{mode:'SIMULATED',outcomes,liveEvidence:false};
}
