import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMetaCostScenario} from './meta-cost-scenarios-postgres.mjs';

const code=(...values)=>error=>values.includes(error.code);
const decimal=value=>String(value).replace(/(\.\d*?)0+$/u,'$1').replace(/\.$/u,'');

/** Real platform actions and immutable P08 effect/terms inputs. No admitted
 * attempt, payer or runtime-mode authority is fabricated by this consumer. */
export async function verifyMetaCostTariffAdmissions(options){
 const f=await createMetaCostScenario(options);
 try{
  const definition=f.definition('UPSTREAM_REFERENCE'),body={definition,supersedesId:f.upstreamDraft.id},key=randomUUID();
  const draft=await f.operator('META_COST_DRAFT',null,body,key),replay=await f.operator('META_COST_DRAFT',null,body,key);
  assert.equal(replay.id,draft.id);assert.equal(replay.duplicate,true);
  await assert.rejects(()=>f.operator('META_COST_DRAFT',null,{...body,definition:{...definition,currency:'SAR'}},key),code('23505'));
  for(const change of [{evidenceMode:'UNKNOWN'},{product:'MARKETING_MESSAGES_API'},{pricingModel:'CBP'},{timezone:'Not/AZone'},
   {effectiveFrom:'today'},{effectiveTo:definition.effectiveFrom},{rates:[{...definition.rates[0],unitPrice:0.005}]},
   {rates:[{...definition.rates[0],category:'ai_agent'}]},{rates:[{...definition.rates[0],schedule:'AUTHENTICATION_INTERNATIONAL'}]}])
   await assert.rejects(()=>f.operator('META_COST_DRAFT',null,{definition:{...definition,...change},supersedesId:null}),code('22023','22007','22008'));
  const boundedRates=Array.from({length:128},(_,index)=>({...definition.rates[0],market:'MARKET_'+index}));
  const bounded=await f.operator('META_COST_DRAFT',null,{definition:{...definition,rates:boundedRates},supersedesId:null});assert.equal(bounded.state,'DRAFT');
  await assert.rejects(()=>f.operator('META_COST_DRAFT',null,{definition:{...definition,rates:[...boundedRates,{...definition.rates[0],market:'MARKET_128'}]},supersedesId:null}),code('22023'));
  const unaccepted=await f.operator('META_COST_DRAFT',null,{definition:f.definition('CUSTOMER_TARIFF'),supersedesId:f.customerDraft.id});
  await assert.rejects(()=>f.operator('META_COST_ACTIVATE',unaccepted.id,{expectedDefinitionSha256:unaccepted.definitionSha256,policyVersionId:f.accepted.policyVersionId}),code('55000'));
  const overlap=await f.operator('META_COST_DRAFT',null,{definition,supersedesId:null});
  await assert.rejects(()=>f.operator('META_COST_ACTIVATE',overlap.id,{expectedDefinitionSha256:overlap.definitionSha256,policyVersionId:null}),code('40001'));
  const competitor=await f.operator('META_COST_DRAFT',null,{definition:{...definition,currency:'SAR'},supersedesId:f.upstreamDraft.id});
  const raced=await Promise.allSettled([draft,competitor].map(value=>f.operator('META_COST_ACTIVATE',value.id,{expectedDefinitionSha256:value.definitionSha256,policyVersionId:null})));
  assert.equal(raced.filter(value=>value.status==='fulfilled').length,1);assert.equal(raced.filter(value=>value.status==='rejected'&&value.reason.code==='40001').length,1);
  const active=raced[0].status==='fulfilled'?draft:competitor,old=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT state,definition FROM meta_cost_tariff_versions WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.upstreamDraft.id]))).rows[0];
  assert.equal(old.state,'ACTIVE');assert.equal(old.definition.currency,'USD');
  const stale=await f.operator('META_COST_DRAFT',null,body);
  await assert.rejects(()=>f.operator('META_COST_ACTIVATE',stale.id,{expectedDefinitionSha256:stale.definitionSha256,policyVersionId:null}),code('40001'));
  for(const pool of [f.app,f.worker]){
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query("UPDATE meta_cost_tariff_versions SET definition=jsonb_set(definition,'{currency}','\"EUR\"') WHERE tenant_id=$1 AND id=$2",[f.tenantId,active.id])),code('42501'));
   await assert.rejects(()=>f.tx(pool,f.tenantId,c=>c.query('DELETE FROM meta_cost_tariff_versions WHERE tenant_id=$1 AND id=$2',[f.tenantId,active.id])),code('42501'));
  }
  return{exactDraftReplay:true,changedKeyConflict:true,finiteSupportedDomain:true,rates128Accepted129Rejected:true,acceptedDraftRequired:true,oneConcurrentReplacement:true,oldCurrencyPreserved:true};
 }finally{await f.close();}
}

export async function verifyMetaCostSelectorSemantics(options){
 const f=await createMetaCostScenario(options);
 try{
  const effect=await f.deliver(),head=()=>f.heads(effect.job.id).then(rows=>rows.find(row=>row.purpose==='UPSTREAM_REFERENCE'));
  const initial=await head(),act=(item,object=f.accountId)=>f.operator('META_COST_REASSESS',object,{purpose:'UPSTREAM_REFERENCE',items:[item]});
  const retained=await act({deliveryId:effect.job.id,expectedHeadId:initial.id});assert.equal(retained.assessmentIds[0],initial.id);
  await act({deliveryId:effect.job.id,expectedHeadId:initial.id,selectorEvidence:null});const withdrawn=await head();
  assert.equal(withdrawn.state,'UNPRICED');assert.equal(withdrawn.selector_evidence,null);
  await act({deliveryId:effect.job.id,expectedHeadId:withdrawn.id,selectorEvidence:f.selector});const restored=await head();assert.equal(restored.state,'ESTIMATED');assert.notEqual(restored.id,initial.id);
  await assert.rejects(()=>act({deliveryId:effect.job.id,expectedHeadId:initial.id,selectorEvidence:null}),code('40001'));
  await assert.rejects(()=>act({deliveryId:effect.job.id,expectedHeadId:restored.id},randomUUID()),code('40001'));
  await assert.rejects(()=>f.operator('META_COST_REASSESS',f.accountId,{purpose:'UPSTREAM_REFERENCE',items:[{deliveryId:effect.job.id,expectedHeadId:restored.id},{deliveryId:effect.job.id,expectedHeadId:restored.id}]}),code('22023'));
  for(const changed of [{evidenceMode:'LIVE'},{market:'UNAVAILABLE'},{schedule:'AUTHENTICATION_INTERNATIONAL'},
   {applicabilityFrom:f.to,applicabilityTo:new Date(Date.parse(f.to)+86400_000).toISOString()}]){
   const previous=await head();await act({deliveryId:effect.job.id,expectedHeadId:previous.id,selectorEvidence:{...f.selector,...changed}});
   const unresolved=await head();assert.equal(unresolved.state,'UNPRICED');assert.equal(unresolved.evidence_mode,'SIMULATED');assert.equal(unresolved.amount,null);
  }
  await act({deliveryId:effect.job.id,expectedHeadId:(await head()).id,selectorEvidence:f.selector});
  const free=await f.begin();await f.complete(free);await f.emit(free.external,{billable:false,pricing_model:'PMP',category:'service',type:'free_customer_service'});await f.drain();
  const freeUpstream=(await f.heads(free.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');assert.equal(freeUpstream.state,'ESTIMATED');assert.equal(freeUpstream.reason,'REPORTED_FREE');assert.equal(decimal(freeUpstream.amount),'0');assert.equal(freeUpstream.selector_evidence,null);
  assert((await f.heads(effect.job.id)).every(row=>row.evidence_mode==='SIMULATED'));assert((await f.usage()).totals.every(row=>row.evidenceMode==='SIMULATED'));
  const authDefinition=f.definition('UPSTREAM_REFERENCE');authDefinition.rates.push({...authDefinition.rates[0],category:'authentication',schedule:'AUTHENTICATION_INTERNATIONAL',unitPrice:'0.123456'});
  const authDraft=await f.operator('META_COST_DRAFT',null,{definition:authDefinition,supersedesId:f.upstreamDraft.id});
  await f.operator('META_COST_ACTIVATE',authDraft.id,{expectedDefinitionSha256:authDraft.definitionSha256,policyVersionId:null});
  const authentication=await f.begin();await f.complete(authentication);const authTime=Math.floor(Date.now()/1000);
  await f.emit(authentication.external,{...f.pricing,category:'authentication'},'delivered',String(authTime));await f.drain();
  const international={...f.selector,schedule:'AUTHENTICATION_INTERNATIONAL',applicabilityFrom:new Date(authTime*1000).toISOString()};
  await f.reassess(authentication.job.id,international);assert.equal((await f.heads(authentication.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE').state,'ESTIMATED');
  for(const changed of [{schedule:'ORDINARY'},{applicabilityFrom:new Date((authTime+1)*1000).toISOString()},{applicabilityFrom:f.from,applicabilityTo:new Date(authTime*1000).toISOString()}]){
   await f.reassess(authentication.job.id,{...international,...changed});assert.equal((await f.heads(authentication.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE').state,'UNPRICED');
  }
  await f.reassess(authentication.job.id,international);assert.equal((await f.heads(authentication.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE').state,'ESTIMATED');
  return{omittedRetainsNullWithdrawsObjectRestores:true,staleAndCrossScopeRejected:true,liveSelectorCannotPromote:true,unsupportedSelectorUnpriced:true,signedFreeWithoutReconstruction:true};
 }finally{await f.close();}
}

export async function verifyMetaCostSnapshotBound(options){
 const f=await createMetaCostScenario(options);
 try{
  const queued=await f.queue();
  // Ordinary unattempted outbox records are sufficient to exercise the bounded
  // unattributed view. The actual birth trigger runs for every INSERT; no
  // attempt/admission/receipt/assessment authority row is seeded.
  const insert=quantity=>f.tx(f.app,f.tenantId,c=>c.query(`INSERT INTO delivery_outbox(tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state)
   SELECT $1,$2,$3,'GROUP_WORKSPACE','Synthetic bounded unattributed effect','text/plain',$4::text||'-'||n::text,'QUEUED' FROM generate_series(1,$5::integer) n`,
   [f.tenantId,f.connectionId,queued.job.groupWorkspaceGroupId,randomUUID(),quantity]));
  await insert(4999);
  const snapshot=()=>f.tx(f.app,f.tenantId,async c=>(await c.query('SELECT app.meta_cost_usage_snapshot($1,NULL,$2,$3) value',[f.tenantId,f.from,f.to])).rows[0].value);
  const exact=await snapshot();assert.equal(exact.complete,true);assert.equal(exact.selectedCount,10000);assert.equal(exact.rows.length,10000);assert.equal(exact.totals.length,0);
  assert(exact.rows.every(row=>row.evidenceMode==='UNKNOWN'&&row.state==='UNATTRIBUTED'&&row.admissionSha256===null));
  await insert(1);const exceeded=await snapshot();assert.equal(exceeded.complete,false);assert.equal(exceeded.selectedCount,10001);assert.deepEqual(exceeded.rows,[]);assert.deepEqual(exceeded.totals,[]);assert.deepEqual(exceeded.coverage,[]);
  return{exact10000Returned:true,limitPlusOneExplicitlyIncomplete:true,noInventedAttemptsOrTotals:true};
 }finally{await f.close();}
}

export async function verifyMetaCostFactAndBatchBounds(options){
 const f=await createMetaCostScenario(options);
 try{
  const selected=[];
  for(let index=0;index<100;index++){
   const effect=await f.begin();await f.complete(effect);
   const head=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');assert(head);
   selected.push({deliveryId:effect.job.id,expectedHeadId:head.id});
  }
  const batch=await f.operator('META_COST_REASSESS',f.accountId,{purpose:'UPSTREAM_REFERENCE',items:selected});assert.equal(batch.count,100);
  await assert.rejects(()=>f.operator('META_COST_REASSESS',f.accountId,{purpose:'UPSTREAM_REFERENCE',items:[...selected,{deliveryId:randomUUID(),expectedHeadId:randomUUID()}]}),code('22023'));
  const effect=await f.deliver(),now=Math.floor(Date.now()/1000);
  // Every fact enters through an authenticated signed Meta envelope and the
  // incumbent inbound worker. Bounded envelopes keep the existing ingress and
  // worker limits intact. READ facts do not replace DELIVERED charge time.
  for(let offset=0;offset<999;offset+=100){
   const count=Math.min(100,999-offset);
   await f.emitStatuses(Array.from({length:count},(_,index)=>({id:effect.external,status:'read',timestamp:String(now-1100+offset+index),
    recipient_user_id:'SA.SyntheticCost',pricing:f.pricing})));
   let drained=0;for(let wave=0;wave<101;wave++){const result=await f.drain();drained+=result.events;if(!result.events)break;if(wave===100)assert.fail('Receipt drain failed its bounded progress limit');}
   assert.equal(drained,count);
  }
  const basis=async()=>(await f.heads(effect.job.id))[0].pricing_basis;
  const count=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT count(*)::integer n FROM delivery_receipts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows[0].n;
  assert.equal(count,1000);assert.equal((await basis()).complete,true);assert.equal((await basis()).state,'COHERENT');
  await f.emit(effect.external,f.pricing,'read',String(now+1));await f.drain();
  const exceeded=await basis();assert.equal(exceeded.complete,false);assert.equal(exceeded.reason,'PRICING_EVIDENCE_LIMIT');
  assert((await f.heads(effect.job.id)).every(row=>row.state==='UNPRICED'&&row.reason==='PRICING_EVIDENCE_LIMIT'&&row.amount===null));
  const attempts=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT count(*)::integer n FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows[0].n;assert.equal(attempts,1);
  return{actualReassessment100Accepted101Rejected:true,signedReceipt1000Complete1001Unpriced:true,oneHistoricalSendEffect:true};
 }finally{await f.close();}
}

export async function verifyMetaCostCustomerHistory(options){
 const f=await createMetaCostScenario(options,{paymentMode:'CUSTOMER'});
 try{
  const effect=await f.deliver(),before=await f.heads(effect.job.id);
  assert.equal(before.find(row=>row.purpose==='UPSTREAM_REFERENCE').state,'ESTIMATED');
  const customer=before.find(row=>row.purpose==='CUSTOMER_TARIFF');assert.equal(customer.state,'UNPRICED');assert.equal(customer.reason,'MISSING_ACCEPTED_TERMS');
  assert(before.every(row=>row.payment_mode==='CUSTOMER'&&row.payer_state==='UNVERIFIED'&&row.evidence_mode==='SIMULATED'));
  const revision=Number((await f.tx(f.app,f.tenantId,c=>c.query('SELECT authority_revision FROM meta_messaging_accounts WHERE tenant_id=$1 AND id=$2',[f.tenantId,f.accountId]))).rows[0].authority_revision);
  const next=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT app.accept_meta_customer_terms($1,$2,NULL,$3,$4,$5) value',[
   f.connectionId,f.commercialTermsVersionId,revision,f.actorId,'cost-historical-policy-'+randomUUID()]))).rows[0].value;
  assert.notEqual(next.policyVersionId,f.accepted.policyVersionId);
  const historical=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[f.tenantId,effect.job.id,effect.external]))).rows[0].value;
  assert.equal(historical.state,'ATTRIBUTED');assert.equal(historical.admission.snapshot.policyVersionId,f.accepted.policyVersionId);
  await f.reassess(effect.job.id);assert.deepEqual((await f.heads(effect.job.id)).map(row=>row.id),before.map(row=>row.id));
  return{customerPayerUnverified:true,noManagedCustomerPriceClaim:true,actualLaterPolicyDoesNotRewritePriorEffect:true};
 }finally{await f.close();}
}
