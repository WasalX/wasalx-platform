import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
// Exercise both real platform admission and the installed storage CHECK. Each
// approval is rolled back; no funding operation or provider request is created.
async function verifyFinancialReferenceBounds(f,arrangementId){
 const source=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM meta_funding_arrangement_versions WHERE id=$1',[arrangementId]))).rows[0];
 const checks=(await f.worker.query(`SELECT pg_get_expr(conbin,conrelid) expression FROM pg_constraint
  WHERE conrelid='public.meta_funding_arrangement_versions'::regclass AND contype='c'
   AND pg_get_expr(conbin,conrelid) LIKE '%financial_secret_reference%'`)).rows;
 assert.equal(checks.length,1);const expression=checks[0].expression;
 const cases=[['minimum','secret://A',true],['allowed punctuation','secret://Aaz09._~:/-',true],
  ['beyond regex bound','secret://'+'A'.repeat(256),true],['below maximum','secret://'+'A'.repeat(502),true],
  ['maximum','secret://'+'A'.repeat(503),true],['empty suffix','secret://',false],
  ['over maximum','secret://'+'A'.repeat(504),false],['punctuation first','secret://_A',false],
  ['wrong scheme','https://A',false],['space','secret://A B',false],['newline','secret://A\n',false],
  ['query','secret://A?B',false],['unicode','secret://A\u2603',false],['unredacted marker','[removed]',false]];
 const inventory=async()=>(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT id FROM meta_funding_arrangement_versions WHERE tenant_id=$1 ORDER BY id',[f.tenantId]))).rows;
 const before=await inventory();
 for(const [label,reference,valid] of cases){
  const stored=(await f.worker.query(`SELECT (${expression}) accepted FROM (VALUES($1::text,NULL::timestamptz)) AS probe(financial_secret_reference,redacted_at)`,[reference])).rows[0].accepted;
  assert.equal(stored,valid,`Stored financial reference: ${label}`);
  const c=await f.platform.connect();
  try{
   await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
   const admission=(await c.query('SELECT app.operator_meta_managed_approval_context($1,$2) value',[f.tenantId,f.accountId])).rows[0].value;
   const candidate={schemaVersion:1,tenantId:f.tenantId,accountId:f.accountId,familyId:null,admission,kind:source.kind,
    appId:source.app_id,holderBusinessId:source.holder_business_id,creditLineId:source.credit_line_id,solutionId:source.solution_id,
    receivingBusinessId:source.receiving_business_id,financialSecretReference:reference,financialCredentialFingerprint:source.financial_credential_fingerprint,
    financialCredentialMetadata:source.financial_credential_metadata,graphVersion:source.graph_version,requestedCurrency:source.requested_currency,
    evidenceMode:'SIMULATED',commercialTermsVersionId:source.commercial_terms_version_id,approvalSha256:source.approval_sha256,expiresAt:source.expires_at.toISOString()};
   const approve=()=>c.query('SELECT app.operator_approve_meta_simulated_arrangement($1,$2,$3) value',[candidate,'synthetic-mfa-operator','reference-boundary']);
   if(valid){const approved=(await approve()).rows[0].value;assert.match(approved.arrangementVersionId,/^[a-f0-9-]{36}$/u);assert.equal(approved.evidenceMode,'SIMULATED');}
   else await assert.rejects(approve,error=>error.code==='23514'&&error.message==='Managed arrangement approval is invalid',`Admission financial reference: ${label}`);
  }finally{await c.query('ROLLBACK');c.release();}
 }
 assert.equal((await f.worker.query(`SELECT (${expression}) accepted FROM (VALUES('[removed]'::text,clock_timestamp())) AS probe(financial_secret_reference,redacted_at)`)).rows[0].accepted,true);
 assert.deepEqual(await inventory(),before,'Rolled-back boundary approvals retain the original arrangement inventory');
}

// Probe the actual readback before normal persistence; each probe rolls back.
async function verifyAllocationReadbackContract(f,job,lease,checkpointId,readback){
 const sql='SELECT app.record_meta_allocation_readback($1,$2,$3,$4,$5) AS accepted';
 const args=value=>[job.id,lease,job.fencingToken,checkpointId,value];
 assert.equal(Object.keys(readback.fundingProof).length,10);
 assert.equal(readback.fundingProof.currency.state,'OBSERVED');
 assert.equal(readback.fundingProof.currency.accountId,f.providerAccountId);
 const change=fn=>{const value=structuredClone(readback);fn(value);return value;};
 const cases=[
  ['observed currency',readback,true],
  ['legacy nine fields',change(v=>{delete v.fundingProof.currency;}),true],
  ['no observed currency',change(v=>{v.fundingProof.currency.state='NONE';v.fundingProof.currency.currency=null;}),true],
  ['unavailable currency',change(v=>{v.fundingProof.currency.state='UNAVAILABLE';v.fundingProof.currency.currency=null;}),true],
  ['unsupported version unavailable',change(v=>{v.fundingProof.currency.state='UNAVAILABLE';v.fundingProof.currency.currency=null;v.fundingProof.currency.graphVersion='v25.0';}),true],
  ['unknown funding field',change(v=>{v.fundingProof.extra=true;}),'23514'],
  ['unknown field replaces currency',change(v=>{delete v.fundingProof.currency;v.fundingProof.extra=true;}),'23514'],
  ['missing required field',change(v=>{delete v.fundingProof.actualPayer;}),'23514'],
  ['null currency evidence',change(v=>{v.fundingProof.currency=null;}),'23514'],
  ['unknown currency field',change(v=>{v.fundingProof.currency.extra=true;}),'23514'],
  ['missing currency field',change(v=>{delete v.fundingProof.currency.source;}),'23514'],
  ['wrong currency account',change(v=>{v.fundingProof.currency.accountId=f.phoneNumberId;}),'23514'],
  ['wrong currency source',change(v=>{v.fundingProof.currency.source='REQUESTED_CURRENCY';}),'23514'],
  ['wrong currency namespace',change(v=>{v.fundingProof.currency.identifierKind='MESSAGING_ACCOUNT_ID';}),'23514'],
  ['wrong currency observation time',change(v=>{v.fundingProof.currency.observedAt=new Date(Date.parse(v.fundingProof.observedAt)-1000).toISOString();}),'23514'],
  ['wrong currency expiry',change(v=>{v.fundingProof.currency.expiresAt=new Date(Date.parse(v.fundingProof.expiresAt)+1000).toISOString();}),'23514'],
  ['unsupported observed version',change(v=>{v.fundingProof.currency.graphVersion='v25.0';}),'23514'],
  ['invalid observed currency',change(v=>{v.fundingProof.currency.currency='US';}),'23514'],
  ['unavailable currency claims value',change(v=>{v.fundingProof.currency.state='UNAVAILABLE';}),'23514'],
  ['wrong funding account',change(v=>{v.fundingProof.accountId=f.phoneNumberId;}),'23514'],
  ['wrong exact receiving credential',change(v=>{v.receivingCredential='different-credential';}),'23514'],
  ['wrong exact owner',change(v=>{v.fundingProof.observedOwnerBusinessId=f.phoneNumberId;}),'23514'],
  ['wrong exact credit line',change(v=>{v.creditLineId=f.phoneNumberId;}),'23514'],
  ['wrong exact allocation',change(v=>{v.allocationConfigId=f.phoneNumberId;}),false],
 ];
 await f.tx(f.worker,f.tenantId,async c=>{
  assert.equal((await c.query('SELECT current_user')).rows[0].current_user,'wasalx_connector_worker');
  const retained=async()=>({arrangement:(await c.query(`SELECT allocation_line_version_id,allocation_observed_at,allocation_expires_at
    FROM meta_funding_arrangement_versions WHERE id=$1`,[job.payload.metaManagedFunding.arrangementVersionId])).rows[0],
   checkpoint:(await c.query('SELECT * FROM meta_provider_effect_checkpoints WHERE id=$1',[checkpointId])).rows[0]});
  const original=await retained();assert.equal(original.arrangement.allocation_line_version_id,null);assert.equal(original.checkpoint.outcome,'SUCCEEDED');
  for(const [label,value,expected] of cases){
   await c.query('SAVEPOINT allocation_contract');
   try{
    if(typeof expected==='string')await assert.rejects(()=>c.query(sql,args(value)),e=>e.code===expected,label);
    else {assert.equal((await c.query(sql,args(value))).rows[0].accepted,expected,label);
     if(expected)assert.ok((await retained()).arrangement.allocation_line_version_id,label);}
   }finally{await c.query('ROLLBACK TO SAVEPOINT allocation_contract');await c.query('RELEASE SAVEPOINT allocation_contract');}
   assert.deepEqual(await retained(),original,`${label}: probe must not alter original evidence`);
  }
  for(const [label,values] of [['stale lease',[job.id,randomUUID(),job.fencingToken,checkpointId,readback]],
   ['stale fence',[job.id,lease,job.fencingToken+1,checkpointId,readback]]]){
   await c.query('SAVEPOINT allocation_contract');
   try{await assert.rejects(()=>c.query(sql,values),e=>e.code==='55000',label);}
   finally{await c.query('ROLLBACK TO SAVEPOINT allocation_contract');await c.query('RELEASE SAVEPOINT allocation_contract');}
  }
  assert.deepEqual(await retained(),original);
 });
 for(const pool of [f.app,f.platform])await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query(sql,args(readback))),e=>e.code==='42501');
 assert.equal((await f.tx(f.worker,f.foreignTenantId,c=>c.query(sql,args(readback)))).rows[0].accepted,false);
}

/** Canonical SQL gate supplies explicitly synthetic runtime registry inputs and
 * no-tariff terms; the integrated P10 gate supplies its actual draft callback.
 * Both use real roles/functions, never installed-runtime proof or authority seeds. */
export async function verifyMetaManagedDomain(options,createDraftTariff){
 assert.equal(typeof createDraftTariff,'function','Explicit actual tariff callback or no-tariff terms callback is required');
 const admin=new Client({connectionString:options.adminUrl});await admin.connect();
 const fixtures=[];
 const construct=async()=>{const f=await createMetaManagedFundingFixture(options);fixtures.push(f);return f;};
 const checkpoint=async(f,operationId)=>(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND original_operation_id=$2',[f.tenantId,operationId]))).rows[0];
 const platform=async(f,sql,args)=>(await f.tx(f.platform,f.tenantId,c=>c.query(sql,args))).rows[0].value;
 const rejectedWrite=async(f,pool,sql,args)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);await assert.rejects(()=>c.query(sql,args));}finally{await c.query('ROLLBACK');c.release();}};
 const job=async(f,type,scopeType='TENANT',scopeValue=f.tenantId)=>{const id=randomUUID(),leaseId=randomUUID();const created=(await admin.query(`INSERT INTO privacy_jobs
  (id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,lease_id,lease_expires_at,fencing_token)
  VALUES($1,$2::uuid,$3,$4,$5,$6,$7,'RUNNING','DISCOVER',1,$8,clock_timestamp()+interval '10 minutes',1) RETURNING created_at`,
  [id,f.tenantId,type,scopeType,scopeValue,type==='EXPORT'?'EXPORT_ONLY':'DELETE_TICKETS',`managed-privacy-${id}`,leaseId])).rows[0].created_at;
  return{id,tenantId:f.tenantId,leaseId,jobType:type,scopeType,scopeValue,disposition:type==='EXPORT'?'EXPORT_ONLY':'DELETE_TICKETS',state:'RUNNING',stage:'DISCOVER',attempts:1,maxAttempts:25,fencingToken:1,createdAt:created.toISOString(),unmatchedDiagnosticHours:24,exportTtlHours:24,zammadBaseUrl:'https://privacy.invalid',zammadPrivacySecretReference:`secret://${f.tenantId}/zammad/privacy`};};
 try{
  const successful=await construct(),successDraft=await createDraftTariff(successful,'MANAGED');
  const accepted=await successful.acceptManagedTariff(successDraft,{beforeAttach:async({operations})=>{
   const originalReadback=operations.recordAllocationReadback.bind(operations);
   operations.recordAllocationReadback=async(job,lease,id,value)=>{
    operations.recordAllocationReadback=originalReadback;
    await verifyAllocationReadbackContract(successful,job,lease,id,value);
    return originalReadback(job,lease,id,value);
   };
  }}),original=await checkpoint(successful,accepted.fundingOperationId);
  await verifyFinancialReferenceBounds(successful,accepted.arrangementVersionId);
  const originalJsonbDigest=(await successful.tx(successful.worker,successful.tenantId,c=>c.query("SELECT encode(digest(result::text,'sha256'),'hex') sha FROM meta_provider_effect_checkpoints WHERE id=$1",[original.id]))).rows[0].sha;
  assert.equal(original.outcome,'SUCCEEDED');assert.equal(original.runtime_execution.mode,'SIMULATED');
  assert.ok(original.result.allocationConfigId);assert.equal(original.result.messagingAccountId,successful.providerAccountId);
  assert.equal((await successful.tx(successful.app,successful.foreignTenantId,c=>c.query('SELECT id FROM meta_messaging_accounts WHERE id=$1',[successful.accountId]))).rowCount,0);
  await rejectedWrite(successful,successful.app,'UPDATE meta_provider_effect_checkpoints SET result=$1 WHERE id=$2',[{allocationConfigId:'forged'},original.id]);
  await rejectedWrite(successful,successful.worker,"UPDATE meta_funding_arrangement_versions SET state='REVOKED' WHERE id=$1",[accepted.arrangementVersionId]);
  const beforeHistory=(await successful.tx(successful.app,successful.tenantId,c=>c.query('SELECT authority_revision FROM meta_messaging_accounts WHERE id=$1',[successful.accountId]))).rows[0];
  const history=(await successful.tx(successful.app,successful.tenantId,c=>c.query('SELECT app.accept_meta_managed_policy($1,$2,$3,$4,$5,$6,$7) value',
    [successful.connectionId,accepted.arrangementVersionId,accepted.commercialTermsVersionId,null,Number(beforeHistory.authority_revision),successful.actorId,'managed-history-no-delivery']))).rows[0].value;
  assert.notEqual(history.policyVersionId,accepted.policyVersionId);
  assert.equal((await successful.tx(successful.worker,successful.tenantId,c=>c.query('SELECT count(*)::int count FROM delivery_outbox WHERE connection_id=$1',[successful.connectionId]))).rows[0].count,0);
  const privacy=new PrivacyRepository(successful.worker),exportedJob=await job(successful,'EXPORT');
  await privacy.discover(exportedJob,exportedJob.leaseId);exportedJob.stage='EXPORT';
  const exported=await privacy.exportData(exportedJob,exportedJob.leaseId);
  assert.ok(exported.metaManagedAuthority.some(v=>v.id===accepted.arrangementVersionId&&v.evidence_mode==='SIMULATED'));
  assert.ok(exported.metaFinancialEffects.some(v=>v.id===original.id&&v.outcome==='SUCCEEDED'));
  for(const [policyId,tariff] of [[accepted.policyVersionId,successDraft],[history.policyVersionId,null]]){
   const rows=exported.metaAccountPolicies.filter(v=>v.policy_id===policyId);assert.ok(rows.length>0);
   for(const row of rows){assert.equal(row.commercial_terms_version_id,accepted.commercialTermsVersionId);
    assert.equal(row.accepted_tariff_version_id,tariff);assert.equal(row.arrangement_version_id,accepted.arrangementVersionId);}
  }
  const subjectJob=await job(successful,'EXPORT','PARTICIPANT','15550100001');
  await privacy.discover(subjectJob,subjectJob.leaseId);subjectJob.stage='EXPORT';
  const subject=await privacy.exportData(subjectJob,subjectJob.leaseId);assert.deepEqual(subject.metaAccountPolicies,[]);
  await withFixtureTenant(admin,successful.tenantId,()=>admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[subjectJob.id]));
  const safe=JSON.stringify(exported.metaManagedAuthority);assert.equal(safe.includes('financial_secret_reference'),false);assert.equal(safe.includes('financial_credential_metadata'),false);
  await withFixtureTenant(admin,successful.tenantId,()=>admin.query("UPDATE privacy_jobs SET state='SUCCEEDED',stage='DONE',completed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[exportedJob.id]));
  const hold=randomUUID();await admin.query(`INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
   VALUES($1,$2::uuid,'TENANT',$2::uuid::text,$3,'Managed historical evidence hold',$4)`,[hold,successful.tenantId,sha(successful.tenantId),successful.actorId]);
  const deletion=await job(successful,'DELETE');await assert.rejects(()=>privacy.discover(deletion,deletion.leaseId),{name:'PrivacyLegalHoldError'});
  await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$1 WHERE id=$2",[successful.actorId,hold]);
  await privacy.discover(deletion,deletion.leaseId);deletion.stage='EXTERNAL';
  await withFixtureTenant(admin,successful.tenantId,()=>admin.query("UPDATE privacy_job_targets SET state='EXTERNAL_COMPLETE' WHERE job_id=$1 AND target_type IN('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT')",[deletion.id]));
  await assert.rejects(()=>privacy.finalize({...deletion,fencingToken:2},deletion.leaseId),/lease/i);
  await privacy.finalize(deletion,deletion.leaseId);
  const redacted=await checkpoint(successful,accepted.fundingOperationId);assert.equal(redacted.result.redacted,true);assert.equal(redacted.result.sha256,originalJsonbDigest);
  const retained=(await successful.tx(successful.worker,successful.tenantId,c=>c.query('SELECT state,financial_secret_reference,redacted_at,payer_authority_version_id FROM meta_funding_arrangement_versions WHERE id=$1',[accepted.arrangementVersionId]))).rows[0];
  assert.equal(retained.state,'REVOKED');assert.equal(retained.financial_secret_reference,'[removed]');assert.ok(retained.redacted_at);assert.ok(retained.payer_authority_version_id);
  assert.equal(redacted.result_sha256,original.result_sha256);assert.equal(redacted.request_sha256,original.request_sha256);
  await rejectedWrite(successful,successful.worker,'UPDATE meta_provider_effect_checkpoints SET result=$1 WHERE id=$2',[original.result,original.id]);

  const unresolved=await construct(),unknownDraft=await createDraftTariff(unresolved,'MANAGED');
  const unknown=await unresolved.acceptManagedTariff(unknownDraft,{simulateUnknown:true}),unknownReceipt=await checkpoint(unresolved,unknown.fundingOperationId);
  assert.equal(unknownReceipt.outcome,'UNKNOWN');assert.equal(unknownReceipt.runtime_execution.mode,'SIMULATED');
  const revision=Number((await unresolved.tx(unresolved.app,unresolved.tenantId,c=>c.query('SELECT authority_revision FROM meta_messaging_accounts WHERE id=$1',[unresolved.accountId]))).rows[0].authority_revision);
  await assert.rejects(()=>platform(unresolved,'SELECT app.operator_queue_meta_funding_attachment($1,$2,$3,$4,$5) value',[unknown.arrangementVersionId,revision,`new-${randomUUID()}`,'synthetic-mfa-operator','unknown-no-repost']));
  await assert.rejects(()=>platform(unresolved,'SELECT app.operator_queue_meta_funding_readback($1,$2,$3,$4,$5) value',[unknownReceipt.id,revision,`read-${randomUUID()}`,'synthetic-mfa-operator','unknown-no-readback']));
  const unknownPrivacy=new PrivacyRepository(unresolved.worker),blocked=await job(unresolved,'DELETE');
  await assert.rejects(()=>unknownPrivacy.discover(blocked,blocked.leaseId),e=>e.code==='META_FINANCIAL_OUTCOME_UNRESOLVED'&&e.retryable===true);
  assert.deepEqual((await checkpoint(unresolved,unknown.fundingOperationId)).result,unknownReceipt.result);

  const drifted=await construct(),driftDraft=await createDraftTariff(drifted,'MANAGED');
  await drifted.acceptManagedTariff(driftDraft,{beforeAttach:async({job,lease,appId,worker,tenantId,connectionId,providerSessionId,runtimeCandidate,operations,transportBindingSha256})=>{
   const earlier=await operations.managedFundingContext(job,lease,appId);
   const execution=await operations.resolveFinancialExecution(job,earlier,runtimeCandidate,transportBindingSha256);
   assert.equal(execution.mode,'SIMULATED');
   await drifted.tx(worker,tenantId,async c=>{
    assert.equal((await c.query('SELECT current_user')).rows[0].current_user,'wasalx_connector_worker');
    const mutations=[
     ['binding', 'UPDATE meta_connection_account_bindings SET revision=revision+1 WHERE connection_id=$1',[connectionId]],
     ['session', "UPDATE provider_sessions SET state='ACTION_REQUIRED' WHERE id=$1",[providerSessionId]],
     ['secret', "UPDATE connections SET secret_reference='secret://'||tenant_id::text||'/connections/'||id::text||'/meta/rotations/'||repeat('f',64) WHERE id=$1",[connectionId]],
     ['proof', "UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,credentialFingerprint}',to_jsonb(repeat('f',64))) WHERE id=$1",[providerSessionId]],
     ['lifecycle', "UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaLifecycle}','null'::jsonb) WHERE id=$1",[providerSessionId]]
    ];
    for(const [name,sql,args] of mutations){
     await c.query('SAVEPOINT context_drift');
     assert.equal((await c.query('SELECT app.meta_funding_operation_context($1,$2,$3,$4) value',[job.id,lease,job.fencingToken,appId])).rows[0].value.accountId,earlier.accountId);
     assert.equal((await c.query(sql,args)).rowCount,1,name);
     await c.query('SAVEPOINT denied_slot');
     await assert.rejects(()=>c.query('SELECT app.reserve_meta_funding_attachment($1,$2,$3,$4)',[job.id,lease,sha('synthetic-currentness-'+name),execution]),e=>e.code==='55000',name);
     await c.query('ROLLBACK TO SAVEPOINT denied_slot');
     assert.equal((await c.query('SELECT count(*)::int n FROM meta_provider_effect_checkpoints WHERE owner_id=$1',[job.id])).rows[0].n,0,name);
     await c.query('ROLLBACK TO SAVEPOINT context_drift');await c.query('RELEASE SAVEPOINT context_drift');
    }
   });
  }});
  const recovery=await construct(),recoveryDraft=await createDraftTariff(recovery,'MANAGED');
  const pending=await recovery.acceptManagedTariff(recoveryDraft,{simulateReadbackFailure:true}),known=await checkpoint(recovery,pending.fundingOperationId);
  assert.equal(known.outcome,'SUCCEEDED');await recovery.readback(known.id);
  assert.equal((await checkpoint(recovery,pending.fundingOperationId)).id,known.id);
  assert.equal((await recovery.tx(recovery.worker,recovery.tenantId,c=>c.query('SELECT count(*)::int count FROM meta_provider_effect_checkpoints WHERE account_id=$1',[recovery.accountId]))).rows[0].count,1);
  const liveDenied=(await recovery.tx(recovery.worker,recovery.tenantId,c=>c.query('SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) value',[recovery.tenantId,recovery.accountId,recovery.runtimeCandidate.receiptId,{...recovery.runtimeCandidate.descriptor,sourceTree:'0'.repeat(40)},recovery.runtimeCandidate.descriptorSha256,recovery.runtimeCandidate.descriptor.transportBindingSha256]))).rows[0].value;
  assert.equal(liveDenied.mode,'UNKNOWN');
  // A queued birth cannot resurrect after local arrangement revocation. This
  // is not a provider credit DELETE; original checkpoint/economic refs stay.
  const preRevoke=await recovery.queue();
  const revoked=await platform(recovery,'SELECT app.operator_revoke_meta_arrangement($1,$2,$3) value',
   [pending.arrangementVersionId,'synthetic-mfa-operator','local-managed-revoke']);
  assert.equal(revoked.state,'REVOKED');
  await assert.rejects(()=>recovery.outbox.beginSend(preRevoke.job,preRevoke.lease),e=>e.code==='META_BILLING_SEND_HELD'&&e.outcomeKnown===true);
  assert.equal((await recovery.tx(recovery.worker,recovery.tenantId,c=>c.query('SELECT state FROM delivery_outbox WHERE id=$1',[preRevoke.job.id]))).rows[0].state,'CLAIMED');
  assert.equal((await checkpoint(recovery,pending.fundingOperationId)).outcome,'SUCCEEDED');
  const historical=(await recovery.tx(recovery.worker,recovery.tenantId,c=>c.query('SELECT app.reserve_meta_funding_attachment($1,$2,$3,$4) value',
    [pending.fundingOperationId,randomUUID(),sha('historical-no-post'),known.runtime_execution]))).rows[0].value;
  assert.equal(historical.disposition,'HISTORICAL_NO_POST');assert.equal(historical.checkpointId,known.id);assert.equal(historical.outcome,'SUCCEEDED');
 }finally{for(const f of fixtures.reverse())await f.close();await admin.end();}
}
