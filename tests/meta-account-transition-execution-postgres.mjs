import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createMetaTransitionExecutionFixture} from './meta-account-transition-execution-fixture-postgres.mjs';
const queueSql='SELECT app.queue_meta_transition_action($1,$2,$3,$4,$5,$6,$7,$8) AS value';
const resolveSql='SELECT app.resolve_meta_transition_request($1,$2,$3,$4,$5,$6,$7,$8) AS value';
const args=(f,id,body,key,kind='INITIATE')=>[id,f.connectionId,f.actorId,body.expectedRevision,body.expectedPreviewSha256,key,kind,'transition-race'];
async function observeBlocking(pool,blockedPid,blockerPid){
 for(let pass=0;pass<200;pass++){
  const row=(await pool.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked',[blockedPid,blockerPid])).rows[0];
  if(row.blocked===true)return;await delay(10);
 }
 assert.fail('The second exact-key transaction never reached the actual PostgreSQL lock');
}
async function serializedOrder(f,firstSql,secondSql,parameters){
 const first=await f.app.connect(),second=await f.app.connect();let pending;
 try{
  for(const client of [first,second]){await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);}
  const firstPid=(await first.query('SELECT pg_backend_pid() pid')).rows[0].pid,secondPid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const admitted=(await first.query(firstSql,parameters)).rows[0].value;
  pending=second.query(secondSql,parameters);pending.catch(()=>{});
  await observeBlocking(f.app,secondPid,firstPid);await first.query('COMMIT');
  const observed=(await pending).rows[0].value;await second.query('COMMIT');return{admitted,observed};
 }finally{await first.query('ROLLBACK');if(pending)await pending.catch(()=>{});await second.query('ROLLBACK');first.release();second.release();}
}
async function absentEffect(f,id){
 return f.tx(f.app,f.tenantId,async c=>({
  reservations:Number((await c.query('SELECT count(*) n FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2',[f.tenantId,id])).rows[0].n),
  checkpoints:Number((await c.query("SELECT count(*) n FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2",[f.tenantId,id])).rows[0].n),
 }));
}

// Reuse the real claimed INITIATE and runtime admission, then roll back each
// exact response. The original UNKNOWN/no-replay scenario below stays pristine.
async function verifyMigrationCorrelationBounds(f,work,options){
 const context=await f.store.transitionExecutionContext(work.job,work.lease,f.appId);
 const execution=await f.store.resolveTransitionExecution(work.job,context,f.runtimeCandidate,options.runtimeEvidence.transportBindingSha256);
 assert.equal(execution.mode,'SIMULATED');
 const checks=(await f.worker.query(`SELECT pg_get_expr(conbin,conrelid) expression FROM pg_constraint
  WHERE conrelid='public.meta_account_transitions'::regclass AND contype='c'
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.meta_account_transitions'::regclass AND attname='provider_migration_id')]`)).rows;
 assert.equal(checks.length,1);const expression=checks[0].expression;
 assert.equal((await f.worker.query(`SELECT (${expression}) accepted FROM (VALUES(NULL::text)) AS probe(provider_migration_id)`)).rows[0].accepted,null);
 const cases=[['minimum','A',true],['allowed characters','Az09_-',true],['below maximum','A'.repeat(255),true],
  ['maximum','A'.repeat(256),true],['empty','',false],['over maximum','A'.repeat(257),false],
  ['dot','A.B',false],['slash','A/B',false],['space','A B',false],['newline','A\n',false],['unicode','A\u2603',false]];
 const before=await f.plan(context.transitionId),effects=await absentEffect(f,context.transitionId),traffic=f.traffic.length;
 for(const [label,migrationId,valid] of cases){
  assert.equal((await f.worker.query(`SELECT (${expression}) accepted FROM (VALUES($1::text)) AS probe(provider_migration_id)`,[migrationId])).rows[0].accepted,valid,`Stored migration correlation: ${label}`);
  const c=await f.worker.connect();
  try{
   await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
   const slot=(await c.query('SELECT app.reserve_meta_account_transition_stage($1,$2,$3,$4,$5) value',
    [work.job.id,work.lease,work.job.fencingToken,'a'.repeat(64),execution])).rows[0].value;
   assert.equal(slot.disposition,'NEW_ATTEMPT');
   const record=()=>c.query('SELECT app.record_meta_transition_response($1,$2,$3,$4,$5) value',
    [slot.checkpointId,slot.reservationToken,'SUCCEEDED',{migrationId,migrationStatus:'INITIATED'},'b'.repeat(64)]);
   if(valid){assert.equal((await record()).rows[0].value,true);
    assert.equal((await c.query('SELECT provider_migration_id FROM meta_account_transitions WHERE id=$1',[context.transitionId])).rows[0].provider_migration_id,migrationId);
    const receipt=(await c.query('SELECT outcome,result FROM meta_provider_effect_checkpoints WHERE id=$1',[slot.checkpointId])).rows[0];
    assert.equal(receipt.outcome,'SUCCEEDED');assert.equal(receipt.result.migrationId,migrationId);
   }else await assert.rejects(record,error=>error.code==='23514'&&error.message==='Migration correlation is invalid',`Response migration correlation: ${label}`);
  }finally{await c.query('ROLLBACK');c.release();}
 }
 assert.deepEqual(await f.plan(context.transitionId),before);assert.deepEqual(await absentEffect(f,context.transitionId),effects);
 assert.equal(f.traffic.length,traffic,'SQL boundary probes never dispatch a provider request');
}

async function rejectedObservationLeavesNoTarget(options){
 const f=await createMetaTransitionExecutionFixture(options);
 try{
  const id=await f.createPreview();await f.authorize(id);await f.run(id,'INITIATE');
  const request=await f.confirmation(id),requestKey=randomUUID(),accepted=await f.action(id,'OBSERVE',requestKey,request),work=await f.claim();
  assert.equal(work.job.id,accepted.operationId);
  const context=await f.store.transitionExecutionContext(work.job,work.lease,f.appId);
  const snapshot=async()=>f.tx(f.worker,f.tenantId,async c=>({
   accounts:(await c.query('SELECT * FROM meta_messaging_accounts WHERE tenant_id=$1 ORDER BY id',[f.tenantId])).rows,
   reservations:(await c.query('SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 ORDER BY id',[f.tenantId])).rows,
   plan:(await c.query('SELECT * FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2',[f.tenantId,id])).rows[0],
   operation:(await c.query('SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2',[f.tenantId,work.job.id])).rows[0],
   checkpoints:(await c.query("SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 ORDER BY stage",[f.tenantId,id])).rows,
  }));
  const before=await snapshot(),posts=f.traffic.filter(row=>row.method==='POST').length;
  const malformed={migrationId:f.migrationId,status:'READY_TO_COMPLETE',destination:{id:f.targetProviderAccountId,currency:'EUR'},
   observedAt:new Date().toISOString(),targetAssets:[],cloneAccess:null,fundingProof:null,allocationProof:null,
   targetReadiness:{assets:'UNAVAILABLE',payment:'VERIFIED',templates:'UNAVAILABLE',continuity:'UNAVAILABLE'}};
  assert.equal(await f.store.recordTransitionObservation(work.job,work.lease,malformed,context.admissionSha256),false);
  assert.deepEqual(await snapshot(),before,'A later proof refusal leaves no account/reservation/plan/result/checkpoint mutation');
  await f.executeQueued(work);
  const after=await snapshot();assert.equal(after.plan.provider_status,'READY_TO_COMPLETE');
  assert.equal(after.accounts.filter(row=>row.provider_account_id===f.targetProviderAccountId).length,1);
  assert.equal(after.reservations.filter(row=>row.account_role==='TARGET').length,1);
  assert.equal(after.operation.state,'SUCCEEDED');assert.equal(after.operation.result.metaTransitionObservation.destination.id,f.targetProviderAccountId);
  assert.deepEqual(after.checkpoints,before.checkpoints);assert.equal(f.traffic.filter(row=>row.method==='POST').length,posts);
  const replay=await f.resolve(id,'OBSERVE',requestKey,request);assert.equal(replay.operationId,work.job.id);
  assert.equal(replay.pendingAction.state,'SUCCEEDED');assert.deepEqual(await snapshot(),after,'Historical resolution does not repeat observation or reserve another target');
  return true;
 }finally{await f.close();}
}

/** All source data is isolated; no provider HTTP escapes the serial fixture. */
export async function verifyMetaTransitionExecution(options){
 await rejectedObservationLeavesNoTarget(options);
 const f=await createMetaTransitionExecutionFixture(options);
 try{
  const id=await f.createPreview();await f.authorize(id);
  const newConnection=randomUUID(),newSession=randomUUID(),newPhone=String(BigInt(f.phoneNumberId)+100000000000000000000000000000n);
  const newSecret=`secret://${f.tenantId}/connections/${newConnection}/meta`;
  await f.admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Unenrolled reserved candidate','META','CLOUD_API','PAUSED',$3)",[newConnection,f.tenantId,newSecret]);
  const before=await f.plan(id),body=await f.confirmation(id),resolveFirstKey=randomUUID();
  const first=await serializedOrder(f,resolveSql,queueSql,args(f,id,body,resolveFirstKey));
  assert.equal(first.admitted.pendingAction.state,'CANCELLED');assert.equal(first.admitted.operationId,first.observed.operationId);
  assert.equal(first.observed.duplicate,true);assert.deepEqual(await absentEffect(f,id),{reservations:0,checkpoints:0});
  assert.deepEqual(await f.plan(id),before,'A no-admission tombstone never changes the plan or its authority');
  assert.equal((await f.operations.claim(f.tenantId,randomUUID(),1)).length,0,'Late original POST cannot create a dispatch after no-effect resolution');
  await assert.rejects(()=>f.resolve(id,'INITIATE',resolveFirstKey,{...body,expectedPreviewSha256:'0'.repeat(64)}),/another intent/);
  await assert.rejects(()=>f.controller.initiateMetaTransitionResolution({...f.request,principal:{...f.request.principal,userId:randomUUID()}},f.connectionId,id,resolveFirstKey,body));
  await assert.rejects(()=>f.tx(f.app,f.foreignTenantId,c=>c.query(resolveSql,args(f,id,body,resolveFirstKey))));
  const lateKey=randomUUID(),second=await serializedOrder(f,queueSql,resolveSql,args(f,id,body,lateKey));
  assert.equal(second.admitted.operationId,second.observed.operationId);assert.equal(second.observed.pendingAction.state,'QUEUED');
  assert.equal(second.observed.pendingAction.requestKey,lateKey);assert.equal(second.observed.pendingAction.requestRevision,body.expectedRevision);
  const queued=await f.plan(id),reservation=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2',[f.tenantId,id]))).rows[0];
  assert.equal(reservation.scope_sha256,queued.execution_scope_sha256);
  assert.equal(Number(reservation.authority_revision),queued.execution_scope.authorityRevision);
  assert.equal(queued.execution_scope.bindings[0].connectionState,'PAUSED');assert.equal(queued.execution_scope.bindings[0].sessionState,'PAUSED');
  for(const pool of [f.app,f.worker]){
   for(const assignment of ["execution_scope=jsonb_set(execution_scope,'{authorityRevision}','999')","execution_scope_sha256=repeat('0',64)","execution_scope=NULL"])
    await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query(`UPDATE meta_account_transitions SET ${assignment},revision=revision+1 WHERE id=$1`,[id])),
     error=>error.code==='23514'&&error.message==='Original transition execution scope is immutable');
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query("UPDATE meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='VERIFIED_SUCCESSOR',revision=revision+1 WHERE id=$1",[reservation.id])),
    error=>['42501','23514'].includes(error.code));
   await f.tx(pool,f.tenantId,async c=>{
    for(const relation of ['meta_account_transitions','meta_account_transition_reservations','meta_connection_account_bindings','meta_messaging_accounts','connections','provider_sessions','tenant_memberships'])
     await c.query(`CREATE TEMP TABLE ${relation}(poison boolean) ON COMMIT DROP`);
    const exact=(await c.query('SELECT app.meta_transition_scope($1) value',[f.accountId])).rows[0].value;
    assert.equal(exact.accountId,f.accountId,'Privileged scope uses the real tenant relations');
   });
  }
  assert.equal((await f.app.query("SELECT pg_has_role(current_user,'wasalx_meta_transition_executor','member') member")).rows[0].member,false);
  assert.equal((await f.worker.query("SELECT pg_has_role(current_user,'wasalx_meta_transition_executor','member') member")).rows[0].member,false);
  // Every new authority path shares the account reservation. Ordinary readers
  // remain available, but a new customer policy, START and current binding
  // generation cannot silently escape the captured account-wide scope.
  await assert.rejects(()=>f.controller.requestMetaBillingPolicy(f.request,f.connectionId,'reserved-policy',{mode:'CUSTOMER',expectedRevision:queued.execution_scope.authorityRevision}));
  await assert.rejects(()=>f.tx(f.app,f.tenantId,c=>c.query("INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id) VALUES($1,$2,'START',$3,'{}','USER',$4,'reserved-start')",[f.tenantId,f.connectionId,randomUUID(),f.actorId])),error=>['55000','23514'].includes(error.code));
  await assert.rejects(()=>f.tx(f.app,f.tenantId,c=>c.query('UPDATE meta_connection_account_bindings SET revision=revision+1 WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.sourceBindingId])),error=>error.code==='55000');
  // The actual trigger may preserve unchanged state, but cannot exempt an account change.
  const sessionBefore=(await f.admin.query('SELECT provider_state_data FROM public.provider_sessions WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.providerSessionId])).rows[0].provider_state_data;
  const effectsBefore=await absentEffect(f,id),trafficBefore=f.traffic.length;
  for(const pool of [f.app,f.worker]){
   assert.equal((await f.tx(pool,f.tenantId,c=>c.query('UPDATE public.provider_sessions SET provider_state_data=provider_state_data,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.providerSessionId]))).rowCount,1);
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query("UPDATE public.provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{wabaId}',to_jsonb($3::text)),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[f.tenantId,f.providerSessionId,f.targetProviderAccountId])),
    error=>error.code==='55000'&&error.message==='Account transition reserves this authority');
  }
  assert.deepEqual((await f.admin.query('SELECT provider_state_data FROM public.provider_sessions WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.providerSessionId])).rows[0].provider_state_data,sessionBefore);
  assert.deepEqual(await f.plan(id),queued);assert.deepEqual(await absentEffect(f,id),effectsBefore);
  assert.equal(f.traffic.length,trafficBefore,'Session boundary probes never issue provider requests');
  const newProof={...f.sourceProof,connectionId:newConnection,providerSessionId:newSession,phoneNumberId:newPhone,secretReference:newSecret};
  await assert.rejects(()=>f.tx(f.app,f.tenantId,c=>c.query(
   "INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'PAUSED',$5,'ACTIVE',$6)",
   [newSession,f.tenantId,newConnection,newPhone,`meta-cloud://${f.providerAccountId}/${newPhone}`,{wabaId:f.providerAccountId,metaAccountProof:newProof}])),
   error=>error.code==='55000','The first session on an otherwise unbound connection cannot join a reserved account');
  assert.equal((await f.admin.query('SELECT id FROM provider_sessions WHERE id=$1',[newSession])).rowCount,0);
  assert.ok(await f.controller.metaTransitionView(f.request,f.connectionId,id),'Reservation does not deny authorized status reads');
  const work=await f.claim();assert.equal(work.job.id,second.admitted.operationId);
  await assert.rejects(()=>f.store.transitionExecutionContext(work.job,randomUUID(),f.appId),error=>error.code==='55000');
  await verifyMigrationCorrelationBounds(f,work,options);
  await assert.rejects(()=>f.executeQueued(work,{unknownStage:'INITIATE'}));
  assert.equal(f.traffic.filter(row=>row.method==='POST').length,1);
  const original=(await f.tx(f.app,f.tenantId,c=>c.query("SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_id=$2 AND stage='INITIATE'",[f.tenantId,id]))).rows[0];
  assert.equal(original.outcome,'UNKNOWN');assert.equal(original.owner_kind,'ACCOUNT_TRANSITION');
  const terminalResolve=await f.resolve(id,'INITIATE',lateKey,body);assert.equal(terminalResolve.pendingAction.state,'FAILED_TERMINAL');
  const latest=await f.confirmation(id);await assert.rejects(()=>f.action(id,'INITIATE',randomUUID(),latest),/cannot be replayed/);
  await assert.rejects(()=>f.controller.cancelMetaTransition(f.request,f.connectionId,id,{expectedRevision:latest.expectedRevision}));
  assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_provider_effect_checkpoints WHERE id=$1',[original.id]))).rows[0],original,
   'Status resolution, a fresh operation and cancellation never overwrite or reopen UNKNOWN');
  assert.deepEqual(await absentEffect(f,id),{reservations:1,checkpoints:1});
  return{mode:'SIMULATED',actualRoleRequestOrders:2,providerPosts:1,unknownReplayPosts:0,originalScopeImmutable:true,reservationMatchesOriginalScope:true,
   roleIsolation:true,temporaryRelationShadows:true,liveEvidence:false};
 }finally{await f.close();}
}
