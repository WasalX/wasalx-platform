import assert from 'node:assert/strict';
import {createMetaCostScenario} from './meta-cost-scenarios-postgres.mjs';

/** Real restricted domain paths in the disposable database. Graph responses
 * are explicitly synthetic; no tariff/account/admission authority is seeded. */
export async function verifyMetaCostHistoricalRepair(options){
 const results=[];
 const f=await createMetaCostScenario(options);
 try{
  const earlier=await f.deliver(),oldHead=(await f.heads(earlier.job.id)).find(r=>r.purpose==='CUSTOMER_TARIFF');
  assert.equal(oldHead.tariff_version_id,f.customerDraft.id);
  const beforeAdmission=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT meta_billing_admission FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,earlier.job.id]))).rows[0].meta_billing_admission;
  assert.equal(beforeAdmission.providerContext.phoneNumberId,f.phoneNumberId);assert.equal(beforeAdmission.providerContext.envelopeAccount.id,f.providerAccountId);
  assert.equal(beforeAdmission.providerContext.currencyEvidence.observation.currency,'USD');
  const definition=f.definition('CUSTOMER_TARIFF');definition.currency='JPY';definition.minorUnits=0;definition.rates[0].unitPrice='7';
  const successor=await f.operator('META_COST_DRAFT',null,{definition,supersedesId:f.customerDraft.id});
  const acceptance=await f.acceptReplacementTariff(successor.id);
  await f.operator('META_COST_ACTIVATE',successor.id,{expectedDefinitionSha256:successor.definitionSha256,policyVersionId:acceptance.policyVersionId});
  const later=await f.deliver();
  await f.reassess(earlier.job.id);await f.emit(earlier.external,f.pricing,'read');await f.drain();
  const old=(await f.heads(earlier.job.id)).find(r=>r.purpose==='CUSTOMER_TARIFF'),next=(await f.heads(later.job.id)).find(r=>r.purpose==='CUSTOMER_TARIFF');
  assert.equal(old.state,'ESTIMATED');assert.equal(old.tariff_version_id,f.customerDraft.id);assert.equal(old.currency,'USD');
  assert.equal(next.state,'ESTIMATED');assert.equal(next.tariff_version_id,successor.id);assert.equal(next.currency,'JPY');assert.match(next.amount,/^7(?:\.0+)?$/u);
  // A later observation is intentionally different. It cannot rewrite the
  // currency evidence captured on either already-admitted request.
  await f.refreshCurrency('KWD');await f.reassess(earlier.job.id);
  assert.equal((await f.heads(earlier.job.id)).find(r=>r.purpose==='UPSTREAM_REFERENCE').state,'ESTIMATED');
  assert.deepEqual((await f.tx(f.worker,f.tenantId,c=>c.query('SELECT meta_billing_admission FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,earlier.job.id]))).rows[0].meta_billing_admission,beforeAdmission);
  const totals=(await f.usage()).totals.filter(r=>r.purpose==='CUSTOMER_TARIFF');assert.equal(totals.length,2);assert.equal(totals.reduce((n,r)=>n+r.quantity,0),2);
  await f.tx(f.platform,f.tenantId,client=>client.query('SELECT app.operator_withdraw_meta_runtime($1,$2,$3)',[f.runtimeCandidate.receiptId,'synthetic-mfa-operator','historical-cost-withdrawal']));
  await f.reassess(earlier.job.id);await f.reassess(later.job.id);
  assert.equal((await f.heads(earlier.job.id)).find(r=>r.purpose==='CUSTOMER_TARIFF').tariff_version_id,f.customerDraft.id);
  assert.equal((await f.heads(later.job.id)).find(r=>r.purpose==='CUSTOMER_TARIFF').tariff_version_id,successor.id);
  assert((await f.heads(earlier.job.id)).every(r=>r.evidence_mode==='SIMULATED'));
  results.push('HISTORICAL_ACCEPTED_TARIFF_CURRENCY_AND_WITHDRAWN_RUNTIME');
 }finally{await f.close();}
 for(const kind of ['MISSING','DENIED','MALFORMED','WRONG_ACCOUNT','EXPLICIT_NONE','WRONG_CURRENCY']){
  const c=await createMetaCostScenario(options,{currencyResponseKind:kind==='WRONG_CURRENCY'?'OBSERVED':kind,observedCurrency:kind==='WRONG_CURRENCY'?'KWD':'USD'});
  try{
   const effect=await c.deliver(),heads=await c.heads(effect.job.id),upstream=heads.find(r=>r.purpose==='UPSTREAM_REFERENCE');
   assert.equal(upstream.state,'UNPRICED');assert.equal(upstream.amount,null);assert.equal(upstream.currency,null);
   assert.equal(upstream.reason,kind==='WRONG_CURRENCY'?'UPSTREAM_CURRENCY_MISMATCH':'MISSING_UPSTREAM_CURRENCY');
   assert.equal(heads.find(r=>r.purpose==='CUSTOMER_TARIFF').state,'ESTIMATED','Separately accepted commercial currency is independent');
   const free=await c.begin();await c.complete(free);await c.emit(free.external,{pricing_model:'PMP',category:'service',type:'free_customer_service',billable:false});await c.drain();
   const freeHead=(await c.heads(free.job.id)).find(r=>r.purpose==='UPSTREAM_REFERENCE');assert.equal(freeHead.reported_free,true);assert.equal(freeHead.amount,null);assert.equal(freeHead.currency,null);
   results.push(`OPTIONAL_CURRENCY_${kind}`);
  }finally{await c.close();}
 }
 const c=await createMetaCostScenario(options);
 try{
  const evidence=()=>c.tx(c.worker,c.tenantId,async client=>{
   const snapshot={};for(const name of ['event_inbox','delivery_receipts','meta_cost_assessments'])
    snapshot[name]=(await client.query(`SELECT * FROM public.${name} WHERE tenant_id=$1 ORDER BY id`,[c.tenantId])).rows;
   return snapshot;
  });
  const rejectForeign=async(statuses)=>{
   const before=await evidence();
   await assert.rejects(()=>c.emitStatuses(statuses,{envelopeAccountId:'99999999999999999999999999999999'}),error=>error.getStatus?.()===404);
   assert.deepEqual(await evidence(),before,'Signed foreign account never changes inbox, receipts or assessment history');
  };
  for(const order of ['RECEIPT_FIRST','SUCCESS_FIRST']){
   const effect=await c.begin();if(order==='SUCCESS_FIRST')await c.complete(effect);
   await rejectForeign([{id:effect.external,status:'delivered',timestamp:String(Math.floor(Date.now()/1000)),pricing:c.pricing}]);
   await c.emit(effect.external);await c.drain();
   if(order==='RECEIPT_FIRST'){await c.complete(effect);await c.drainWhenDue();}
   await c.reassess(effect.job.id);const attributed=await c.heads(effect.job.id);assert.equal(attributed.length,2);assert(attributed.every(r=>r.state==='ESTIMATED'&&r.amount!==null),'Only the later valid account observation is admitted');
  }
  const effect=await c.deliver();
  await rejectForeign([{id:effect.external,status:'read',timestamp:String(Math.floor(Date.now()/1000)),pricing:c.pricing}]);
  const reverse=await c.begin();await c.complete(reverse);
  const timestamp=String(Math.floor(Date.now()/1000));
  await rejectForeign([{id:reverse.external,status:'delivered',timestamp,pricing:c.pricing}]);
  // The intended valid observation uses the incumbent delivered producer and recipient context.
  await c.emit(reverse.external,c.pricing,'delivered',timestamp);await c.drain();
  const reverseHeads=await c.heads(reverse.job.id);assert.equal(reverseHeads.length,2);
  await c.reassess(reverse.job.id);assert((await c.heads(reverse.job.id)).every(r=>r.state==='ESTIMATED'),'Rejected foreign evidence does not contaminate a later valid observation');
  const alternate=String(BigInt(c.phoneNumberId)+7n),queued=await c.queue();await c.outbox.beginSend(queued.job,queued.lease);
  await assert.rejects(()=>c.outbox.admitMetaMessageRequest(queued.job,queued.lease,'a'.repeat(64),c.runtimeCandidate,alternate),error=>error.code==='META_MESSAGE_NOT_ATTEMPTED'&&error.outcomeKnown===true);
  assert.equal((await c.tx(c.worker,c.tenantId,client=>client.query('SELECT meta_billing_admission FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[c.tenantId,queued.job.id]))).rows[0].meta_billing_admission,null);
  await c.outbox.admitMetaMessageRequest(queued.job,queued.lease,'a'.repeat(64),c.runtimeCandidate,c.phoneNumberId);
  const wrongPhone={...queued,external:'wamid.synthetic-phone-'+queued.job.id};await c.complete(wrongPhone);
  const preserved=await c.deliver(),before=await c.heads(preserved.job.id);
  // An unverified current-session edit is a negative fixture, not a new account
  // or send authority. It cannot change the old immutable successful admission.
  // Ingress still enforces its actual active route/session ownership contract.
  await c.tx(c.app,c.tenantId,async client=>{
   assert.equal((await client.query("UPDATE webhook_routes SET external_key=$3 WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND state='ACTIVE'",[c.tenantId,c.connectionId,alternate])).rowCount,1);
   await client.query("UPDATE provider_sessions SET opaque_session_id=$3 WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'",[c.tenantId,c.connectionId,alternate]);
  });
  await c.reassess(preserved.job.id);assert.deepEqual((await c.heads(preserved.job.id)).map(r=>r.id),before.map(r=>r.id));
  await c.emitStatuses([{id:wrongPhone.external,status:'delivered',timestamp:String(Math.floor(Date.now()/1000)),pricing:c.pricing}],{phoneNumberId:alternate});await c.drain();
  const wrongPhoneHeads=await c.heads(wrongPhone.job.id);assert.equal(wrongPhoneHeads.length,2);assert(wrongPhoneHeads.every(r=>r.state==='CONFLICTED'&&r.reason==='CONFLICTING_SOURCE_CONTEXT'));
  const attempts=(await c.tx(c.worker,c.tenantId,client=>client.query('SELECT count(*)::integer count FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[c.tenantId,wrongPhone.job.id]))).rows[0].count;assert.equal(attempts,1);
  results.push('FOREIGN_ACCOUNT_REJECTED_BOTH_ORDERS_AND_ADMITTED_PHONE_CONFLICT');
 }finally{await c.close();}
 return{mode:'SIMULATED',results};
}
