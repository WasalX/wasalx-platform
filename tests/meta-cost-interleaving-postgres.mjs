import assert from 'node:assert/strict';
import {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {OutboxRepository} from '../services/connector-worker/dist/services/connector-worker/src/repository.js';
import {createMetaCostScenario,createMetaCostPrivacyJob} from './meta-cost-scenarios-postgres.mjs';
import {PrivacyRepository,PrivacyLegalHoldError} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {PrivacyProcessor} from '../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js';
import {PrivacyController} from '../services/control-api/dist/privacy.controller.js';

/** Pause only the test-owned real connection at COMMIT. Domain SQL, trigger
 * scheduling, privileges and transaction isolation are unchanged. */
function commitBarrier(pool){
 let reached,release;const ready=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 return{ready,release,pool:{connect:async()=>{const c=await pool.connect();return{release:()=>c.release(),query:async(sql,...args)=>{
  if(typeof sql==='string'&&sql==='COMMIT'){reached();if(await gate==='ROLLBACK')throw Object.assign(new Error('Synthetic owned transaction rollback'),{code:'SYNTHETIC_ROLLBACK'});}
  return c.query(sql,...args);
 }}}}};
}
const timeout=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned barrier was not reached')),5000);timer.unref();})]);

export async function verifyMetaCostFactInterleavings(options){
 const f=await createMetaCostScenario(options);const proofs=[];
 try{
  for(const disposition of ['COMMIT','ROLLBACK']){
   const effect=await f.begin(),barrier=commitBarrier(f.worker),held=new OutboxRepository(barrier.pool);
   const completion=held.complete(effect.job,effect.lease,'SENT',effect.external).then(()=>({ok:true}),error=>({error}));
   try{
    await timeout(barrier.ready);
    await f.emit(effect.external);await f.drain();
    assert.equal((await f.heads(effect.job.id)).length,0,'Uncommitted success cannot become a priced effect');
    const state=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT external_message_id FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows[0];assert.equal(state.external_message_id,null);
    barrier.release(disposition);const result=await completion;
    if(disposition==='ROLLBACK'){
     assert.equal(result.error?.code,'SYNTHETIC_ROLLBACK');assert.equal((await f.heads(effect.job.id)).length,0);
     await f.complete(effect);
    }else assert.equal(result.ok,true);
    await f.drainWhenDue();await f.reassess(effect.job.id);assert((await f.heads(effect.job.id)).every(row=>row.state==='ESTIMATED'));
    const rows=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT id,external_message_id FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].external_message_id,effect.external);
    proofs.push(disposition);
   }finally{barrier.release('ROLLBACK');await completion;}
  }
  return{realSeparateReceiptAndCompletionTransactions:proofs,automaticPendingReceiptCatchup:true};
 }finally{await f.close();}
}

export async function verifyMetaCostActivationInterleaving(options){
 const f=await createMetaCostScenario(options),observer=new Client({connectionString:options.adminUrl});
 let activation,assessment,pending;
 try{
  await observer.connect();const effect=await f.deliver(),before=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');
  const definition=f.definition('UPSTREAM_REFERENCE');definition.rates[0].unitPrice='0.125';
  const draft=await f.operator('META_COST_DRAFT',null,{definition,supersedesId:f.upstreamDraft.id});
  activation=await f.platform.connect();assessment=await f.platform.connect();
  for(const c of [activation,assessment]){await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);}
  const activatePid=(await activation.query('SELECT pg_backend_pid() pid')).rows[0].pid,reassessPid=(await assessment.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await activation.query('SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7)',
   ['META_COST_ACTIVATE',f.tenantId,draft.id,{expectedDefinitionSha256:draft.definitionSha256,policyVersionId:null},randomUUID(),'synthetic-mfa-operator','barrier-activation']);
  pending=assessment.query('SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7) value',
   ['META_COST_REASSESS',f.tenantId,f.accountId,{purpose:'UPSTREAM_REFERENCE',items:[{deliveryId:effect.job.id,expectedHeadId:before.id,selectorEvidence:f.selector}]},randomUUID(),'synthetic-mfa-operator','barrier-assessment'])
   .then(value=>({value}),error=>({error}));
  let blocked=false;
  for(let i=0;i<200&&!blocked;i++){
   blocked=(await observer.query('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) blocked',[reassessPid,activatePid])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(blocked,true,'Actual reassessment waits for the account tariff transaction');
  await activation.query('COMMIT');const settled=await pending;if(settled.error)throw settled.error;await assessment.query('COMMIT');
  const after=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');assert.equal(after.tariff_version_id,draft.id);assert.match(after.amount,/^0\.1250*$/u);
  assert.equal((await f.usage()).totals.find(row=>row.purpose==='UPSTREAM_REFERENCE').quantity,1);
  return{actualDatabaseBarrier:true,committedTariffObserved:true,oneEffectNotRevisionSum:true};
 }finally{
  if(activation){await activation.query('ROLLBACK').catch(()=>{});activation.release();}
  if(pending)await pending;if(assessment){await assessment.query('ROLLBACK').catch(()=>{});assessment.release();}
  await observer.end().catch(()=>{});await f.close();
 }
}

export async function verifyMetaCostPrivacyFences(options){
 const f=await createMetaCostScenario(options),privacy=new PrivacyRepository(f.worker);
 let held;
 try{
  const participant='12025550164@c.us',effect=await f.deliver({mentions:[participant]}),before=(await f.heads(effect.job.id)).map(row=>row.id);
  const exportJob=await createMetaCostPrivacyJob(f,'PARTICIPANT',participant,'EXPORT');
  const expectedHistory=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM public.meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 AND evidence_redacted_at IS NULL ORDER BY created_at,id',[f.tenantId,effect.job.id]))).rows;
   assert(expectedHistory.length>before.length,'Actual assessment revisions include predecessor history, not only current heads');
   const scoped=await privacy.exportData(exportJob,exportJob.lease);
   assert.deepEqual(scoped.metaCostAssessments,expectedHistory,'Subject export retains every permitted revision exactly');
  assert(scoped.metaCostAssessments.every(row=>row.delivery_id===effect.job.id));assert.equal(scoped.ticketIds.length,0);
  let bytes,exportKey,credentialReads=0;const exporting=new PrivacyProcessor(privacy,{resolve:async(reference,context)=>{
   assert.equal(reference,exportJob.zammadPrivacySecretReference);
   assert.deepEqual(context,{kind:'zammad',tenantId:f.tenantId,purpose:'privacy'});credentialReads++;
   return{token:'synthetic-only-privacy-token'};
  }},{put:async(key,value)=>{exportKey=key;bytes=Uint8Array.from(value);},delete:async()=>assert.fail('No delete')});
  const exportFetch=globalThis.fetch;let exportSummary;
  globalThis.fetch=async()=>assert.fail('Local-only export has no external ticket request');
  try{exportSummary=await exporting.process(exportJob,exportJob.lease);}finally{globalThis.fetch=exportFetch;}
  assert.notEqual(exportSummary,'deferred');assert(bytes);assert.equal(credentialReads,1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).local.metaCostAssessments,JSON.parse(JSON.stringify(scoped.metaCostAssessments)));
  assert.equal(await privacy.complete(exportJob,exportJob.lease,exportSummary),true);
  held=await f.worker.connect();await held.query('BEGIN');await held.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  await held.query("SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0))",[f.tenantId]);
  await assert.rejects(()=>f.tx(f.worker,f.tenantId,c=>c.query('SELECT app.assess_meta_delivery_cost($1)',[effect.job.id])),error=>error.code==='40001');
  assert.deepEqual((await f.heads(effect.job.id)).map(row=>row.id),before);await held.query('ROLLBACK');held.release();held=undefined;
  await f.tx(f.worker,f.tenantId,c=>c.query('SELECT app.assess_meta_delivery_cost($1)',[effect.job.id]));
  const request={id:'cost-hold-fixture',principal:{tenantId:f.tenantId,userId:f.actorId,subject:`managed-${f.actorId}`,email:`managed-${f.actorId}@example.invalid`,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  const control=new PrivacyController({withTenant:(tenant,fn)=>f.tx(f.app,tenant,fn)},{wakePrivacy:async()=>{}},{},{privacyTarget:async()=>assert.fail('No native target in this fixture')});
  const hold=await control.createHold(request,{scopeType:'TENANT',scopeValue:f.tenantId,reason:'Synthetic cost evidence hold'}, "privacy-hold-fixture-1");
  const job=await createMetaCostPrivacyJob(f,'TENANT',f.tenantId,'DELETE');
  await assert.rejects(()=>privacy.discover(job,job.lease),error=>error instanceof PrivacyLegalHoldError);
  assert((await f.heads(effect.job.id)).every(row=>row.evidence_redacted_at===null));
  await control.releaseHold(request,hold.id);
  const processor=new PrivacyProcessor(privacy,{resolve:async()=>assert.fail('No ticket in this hold fixture')},{put:async()=>assert.fail('No export'),delete:async key=>assert.equal(key,exportKey)});
  const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert.equal(await privacy.complete(job,job.lease,summary),true);
  assert((await f.heads(effect.job.id)).every(row=>row.evidence_redacted_at!==null));
  await f.emit(effect.external);await f.drain();assert.deepEqual((await f.heads(effect.job.id)).map(row=>row.id),before);
  return{actualCrossConnectionPrivacyFence:true,actualHoldRetainsCostEvidence:true,releaseThenRedaction:true,lateReceiptCannotRestore:true};
 }finally{if(held){await held.query('ROLLBACK').catch(()=>{});held.release();}await f.close();}
}

export async function verifyMetaCostRetention(options){
 const f=await createMetaCostScenario(options),privacy=new PrivacyRepository(f.worker);
 try{
  // Synthetic age is assigned on the initial ordinary outbox INSERT only.
  // No protected row is backdated and the production clock is never replaced.
  const expired=await f.deliver({createdAt:new Date(Date.now()-31*86400_000).toISOString()}),fresh=await f.deliver();
  await f.tx(f.app,f.tenantId,c=>c.query(`INSERT INTO group_workspace_settings(tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by)
   VALUES($1,$2,true,$3,30,'RESTRICTED',$4)`,[f.tenantId,expired.job.groupWorkspaceGroupId,new Date(Date.now()-40*86400_000).toISOString(),f.actorId]));
  const job=await createMetaCostPrivacyJob(f,'TENANT',f.tenantId,'RETENTION_SWEEP');
  const processor=new PrivacyProcessor(privacy,{resolve:async()=>assert.fail('No external target in the cost retention fixture')},{put:async()=>assert.fail('No export'),delete:async()=>assert.fail('No storage objects')});
  const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert.equal(await privacy.complete(job,job.lease,summary),true);
  assert((await f.heads(expired.job.id)).every(row=>row.evidence_redacted_at!==null));assert((await f.heads(fresh.job.id)).every(row=>row.evidence_redacted_at===null));
  const old=(await f.heads(expired.job.id)).map(row=>row.id);await f.emit(expired.external);await f.drain();assert.deepEqual((await f.heads(expired.job.id)).map(row=>row.id),old);
  return{setup:'SYNTHETIC_INITIAL_QUEUE_AGE',actualProductionRetention:true,freshCostRetained:true,expiredProjectionRedacted:true,noLateRestoration:true};
 }finally{await f.close();}
}
