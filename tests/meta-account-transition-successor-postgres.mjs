import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMetaTransitionExecutionFixture} from './meta-account-transition-execution-fixture-postgres.mjs';

/** Customer-card and managed-line software paths share the same genuine
 * provider-stage ledger and local coordinator. Bounded intercepted Graph data
 * are explicit SIMULATED responses, never migration or finance acceptance. */
export async function verifyMetaTransitionSuccessors(options){
 const results=[];
 for(const requestedMode of ['CUSTOMER','WASALX_MANAGED']){
  const f=await createMetaTransitionExecutionFixture(options,{requestedMode});
  try{
   const authority=(await f.tx(f.worker,f.tenantId,c=>c.query(
    "SELECT has_function_privilege('wasalx_meta_transition_executor','app.meta_terms_receipt_scope(uuid,uuid,uuid,uuid)','EXECUTE') AS terms_reader,pg_has_role(current_user,'wasalx_meta_transition_executor','MEMBER') AS caller_member"))).rows[0];
   assert.equal(authority.terms_reader,true);assert.equal(authority.caller_member,false,'The worker cannot impersonate the sealed coordinator');
   // Each table-specific trigger branch runs under the actual runtime role.
   // Ordinary source updates remain usable before any successor exists.
   await f.tx(f.app,f.tenantId,c=>c.query('UPDATE connections SET updated_at=clock_timestamp() WHERE id=$1',[f.connectionId]));
   await f.tx(f.worker,f.tenantId,c=>c.query('UPDATE provider_sessions SET updated_at=clock_timestamp() WHERE id=$1',[f.providerSessionId]));
   const ordinaryOperation=randomUUID();
   await f.tx(f.app,f.tenantId,async c=>{
    await c.query("INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id) VALUES($1,$2,$3,'VERIFY_META_BILLING',$1::uuid::text,'{}','USER',$4,'ordinary-trigger-branch')",[ordinaryOperation,f.tenantId,f.connectionId,f.actorId]);
    await c.query("UPDATE connection_operations SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[ordinaryOperation]);
   });
   const sourcePolicy=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_billing_policy_versions WHERE tenant_id=$1 AND account_id=$2 ORDER BY version',[f.tenantId,f.accountId]))).rows;
   const id=await f.createPreview(),completed=await f.providerComplete(id);
   assert.equal(completed.execution_state,'PROVIDER_COMPLETED');assert.equal(completed.identity_successor_receipt,null);
   assert.equal(f.traffic.filter(row=>row.method==='POST').length,2,'Exactly the documented INITIATE and COMPLETE stages run');
   const checkpointBefore=(await f.tx(f.app,f.tenantId,c=>c.query("SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 ORDER BY stage",[f.tenantId,id]))).rows;
   assert.equal(checkpointBefore.length,2);assert.ok(checkpointBefore.every(row=>row.outcome==='SUCCEEDED'));
   const body=await f.confirmation(id),accepted=await f.action(id,'RECONCILE',randomUUID(),body),work=await f.claim();assert.equal(work.job.id,accepted.operationId);
   const queued=await f.plan(id);
   assert.equal(work.job.payload.metaAccountTransitionExecution.scopeSha256,queued.execution_scope_sha256);
   assert.deepEqual(work.job.payload.metaAccountTransitionExecution.localIdentityScope,
    queued.execution_scope.bindings.map(row=>({bindingId:row.id,identitySha256:row.identitySha256})));
   const trafficBefore=f.traffic.length;await f.executeQueued(work);assert.equal(f.traffic.length,trafficBefore,'Local reconciliation has no HTTP effect');
   const settled=await f.plan(id);assert.equal(settled.execution_state,'RECONCILED_PAUSED');
   assert.equal(settled.identity_successor_receipt.claim,'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR');
   assert.equal(settled.identity_successor_receipt.transitionId,id);
   assert.equal(settled.execution_scope_sha256,queued.execution_scope_sha256);assert.deepEqual(settled.execution_scope,queued.execution_scope);
   const result=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT state,result FROM connection_operations WHERE id=$1',[work.job.id]))).rows[0];
   assert.equal(result.state,'SUCCEEDED');assert.equal(result.result.metaTransitionIdentityReconciliation.status,'SETTLED');
   const rows=(await f.tx(f.worker,f.tenantId,c=>c.query(`SELECT b.*,s.state AS session_state,s.ownership_state,s.provider_state_data,a.provider_account_id,
     a.state AS account_state,a.authority_revision AS account_authority_revision,p.mode AS policy_mode,p.id AS policy_id,p.commercial_terms_version_id,p.arrangement_version_id
     FROM meta_connection_account_bindings b JOIN provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
     JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
     JOIN meta_billing_policy_versions p ON p.tenant_id=a.tenant_id AND p.id=a.requested_policy_version_id
     WHERE b.tenant_id=$1 AND b.connection_id=$2 ORDER BY b.created_at,b.id`,[f.tenantId,f.connectionId]))).rows;
   const old=rows.find(row=>row.id===f.sourceBindingId),target=rows.find(row=>row.account_transition_id===id);
   assert.equal(old.state,'RETIRED');assert.equal(old.ownership_state,'RETIRED');assert.equal(Number(old.revision),f.sourceBindingRevision+1);
   assert.equal(target.state,'HELD');assert.equal(target.session_state,'PAUSED');assert.equal(target.ownership_state,'ACTIVE');
   assert.equal(target.phone_number_id,f.phoneNumberId);assert.equal(target.provider_account_id,f.targetProviderAccountId);
   assert.equal(target.predecessor_binding_id,old.id);assert.equal(target.account_state,'READY');
   assert.equal(target.policy_mode,requestedMode==='CUSTOMER'?'CUSTOMER':'MANAGED');assert.notEqual(target.policy_id,sourcePolicy.at(-1).id);
   assert.equal(target.provider_state_data.metaRouting,undefined,'Routing ownership/configuration is not copied');
   assert.equal(target.provider_state_data.metaAccountTransition.purpose,'ACCOUNT_SUCCESSOR');
   assert.equal(target.provider_state_data.metaAccountProof.providerSessionId,target.provider_session_id);
   const funding=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM app.meta_billing_send_guard($1,$2,$3,$4,$5,$6)',
    [f.connectionId,target.provider_session_id,f.phoneNumberId,f.targetProviderAccountId,target.account_authority_revision,target.revision]))).rows[0];
   assert.equal(funding.allowed,false,'A ready target account does not activate its HELD connection binding');
   await assert.rejects(()=>f.sqlValue(f.worker,'SELECT app.meta_billing_birth_snapshot($1) AS value',[f.connectionId]),error=>error.code==='55000');
   assert.deepEqual(await f.sqlValue(f.app,'SELECT app.meta_managed_policy_choices($1) AS value',[f.connectionId]),[],'Retired source and HELD successor grant no selectable managed policy');
   assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query('SELECT * FROM meta_billing_policy_versions WHERE tenant_id=$1 AND account_id=$2 ORDER BY version',[f.tenantId,f.accountId]))).rows,sourcePolicy);
   assert.deepEqual((await f.tx(f.app,f.tenantId,c=>c.query("SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=$2 ORDER BY stage",[f.tenantId,id]))).rows,checkpointBefore);
   const reservations=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT account_role,release_reason FROM meta_account_transition_reservations WHERE tenant_id=$1 AND transition_id=$2 ORDER BY account_role',[f.tenantId,id]))).rows;
   assert.deepEqual(reservations,[{account_role:'SOURCE',release_reason:'VERIFIED_SUCCESSOR'},{account_role:'TARGET',release_reason:'VERIFIED_SUCCESSOR'}]);
   await assert.rejects(()=>f.store.reconcileTransition(work.job,work.lease,f.appId),error=>error.code==='55000');
   await assert.rejects(()=>f.tx(f.worker,f.tenantId,c=>c.query("UPDATE connection_operations SET result='{}'::jsonb WHERE id=$1",[work.job.id])),error=>error.code==='42501');
   if(requestedMode==='WASALX_MANAGED'){
    const arrangement=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM meta_funding_arrangement_versions WHERE tenant_id=$1 AND id=$2',[f.tenantId,target.arrangement_version_id]))).rows[0];
    assert.notEqual(arrangement.id,f.sourceArrangement.id);assert.equal(arrangement.account_id,settled.target_account_id);
    assert.notEqual(arrangement.payer_authority_version_id,f.sourceArrangement.payer_authority_version_id);
    assert.notEqual(arrangement.commercial_terms_version_id,f.sourceArrangement.commercial_terms_version_id);
    assert.notEqual(arrangement.allocation_line_version_id,f.sourceArrangement.allocation_line_version_id);
    assert.equal(arrangement.requested_currency,'EUR');assert.equal(arrangement.receiving_business_id,f.sourceArrangement.receiving_business_id);
   }
   results.push({requestedMode,providerPosts:2,localReconcilePosts:0,target:'PAUSED',historicalPolicies:'UNCHANGED',historicalCheckpoints:'UNCHANGED'});
  }finally{await f.close();}
 }
 return{mode:'SIMULATED',paths:results,liveEvidence:false};
}
