import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
import {DatabaseService} from '../services/control-api/dist/database.service.js';
import {WebhookIngressController} from '../services/control-api/dist/webhook-ingress.controller.js';
import {InboundRepository} from '../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js';
import {InboundProcessor} from '../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
/** Actual P08 domain producer + P10 platform tariff actions. Only ordinary
 * fixture tenant/connection/outbox rows are seeded by the P08 owner. */
export async function createMetaCostScenario(options,{paymentMode='MANAGED',rounding='PERIOD',currency='USD',minorUnits=2,unitPrice='0.005',observedCurrency=currency,currencyResponseKind='OBSERVED'}={}){
 assert.ok(['MANAGED','CUSTOMER'].includes(paymentMode),'Explicit supported payment mode is required');
 const fixture=await createMetaManagedFundingFixture({...options,observedCurrency,currencyResponseKind}),priorDatabase=process.env.DATABASE_URL,priorSecret=process.env.META_APP_SECRET_REFERENCE;
 let database,closed=false;
 try{
  process.env.DATABASE_URL=options.appUrl;database=new DatabaseService();
  if(priorDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorDatabase;
  process.env.META_APP_SECRET_REFERENCE='secret://synthetic/meta-cost-scenario';
  const signatureSecret='synthetic-meta-cost-hmac',ingress=new WebhookIngressController(database,{resolveHmac:async()=>signatureSecret},{wakeInbound:async()=>{}});
  const inbound=new InboundRepository(fixture.worker),processor=new InboundProcessor(inbound,{resolve:async()=>assert.fail('Receipt processing cannot resolve sending secrets')});
  const now=new Date(),from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(),to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
  const definition=purpose=>({tenantId:fixture.tenantId,accountId:fixture.accountId,purpose,evidenceMode:'SIMULATED',sourceSha256:sha('Synthetic complete P10 tariff scenario'),
   currency,minorUnits,timezone:'UTC',effectiveFrom:from,effectiveTo:to,rounding,product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',policyFamily:'ORDINARY_BUSINESS_MESSAGING',
   commercialTermsVersionId:purpose==='CUSTOMER_TARIFF'?fixture.commercialTermsVersionId:null,
   rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'SYNTHETIC',tier:'REFERENCE',unitPrice}]});
  const operator=async(action,object,body,key=randomUUID())=>fixture.tx(fixture.platform,fixture.tenantId,async c=>(await c.query(
   'SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7) value',[action,fixture.tenantId,object,body,key,'synthetic-mfa-operator','meta-cost-scenario'])).rows[0].value);
  const customerDraft=await operator('META_COST_DRAFT',null,{definition:definition('CUSTOMER_TARIFF'),supersedesId:null});
  const accepted=paymentMode==='MANAGED'?await fixture.acceptManagedTariff(customerDraft.id):await fixture.acceptCustomerTariff(customerDraft.id);
  await operator('META_COST_ACTIVATE',customerDraft.id,{expectedDefinitionSha256:customerDraft.definitionSha256,policyVersionId:accepted.policyVersionId});
  const upstreamDraft=await operator('META_COST_DRAFT',null,{definition:definition('UPSTREAM_REFERENCE'),supersedesId:null});
  await operator('META_COST_ACTIVATE',upstreamDraft.id,{expectedDefinitionSha256:upstreamDraft.definitionSha256,policyVersionId:null});
  const selector={sourceSha256:sha('Synthetic authoritative effect market and approved reference tier'),evidenceMode:'SIMULATED',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',
   policyFamily:'ORDINARY_BUSINESS_MESSAGING',market:'SYNTHETIC',marketBasis:'AUTHORITATIVE_EFFECT_MARKET',schedule:'ORDINARY',applicabilityFrom:from,applicabilityTo:to,
   tier:'REFERENCE',tierBasis:'APPROVED_PROVISIONAL_REFERENCE',timeBasis:'PROVIDER_DELIVERED_TIMESTAMP'};
  const heads=async deliveryId=>(await fixture.tx(fixture.app,fixture.tenantId,c=>c.query(`SELECT a.* FROM meta_cost_assessments a WHERE a.tenant_id=$1 AND a.delivery_id=$2
   AND NOT EXISTS(SELECT 1 FROM meta_cost_assessments next WHERE next.tenant_id=a.tenant_id AND next.predecessor_id=a.id) ORDER BY a.purpose`,[fixture.tenantId,deliveryId]))).rows;
  const usage=async(start=from,end=to)=>(await fixture.tx(fixture.app,fixture.tenantId,c=>c.query('SELECT app.meta_cost_usage_snapshot($1,$2,$3,$4) value',[fixture.tenantId,fixture.accountId,start,end]))).rows[0].value;
  const reassess=async(deliveryId,evidence=selector)=>{
   const existing=await heads(deliveryId);
   for(const head of existing)await operator('META_COST_REASSESS',fixture.accountId,{purpose:head.purpose,items:[{deliveryId,expectedHeadId:head.id,selectorEvidence:evidence}]});
   return heads(deliveryId);
  };
  const pricing={billable:true,pricing_model:'PMP',category:'utility',type:'regular'};
  const emitStatuses=async(statuses,{envelopeAccountId=fixture.providerAccountId,phoneNumberId=fixture.phoneNumberId}={})=>{
   assert(statuses.length>=1&&statuses.length<=100,'Bound each signed fixture envelope');
   const payload={object:'whatsapp_business_account',entry:[{id:envelopeAccountId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneNumberId},statuses}}]}]};
   const rawBody=Buffer.from(JSON.stringify(payload));return ingress.meta({rawBody,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',signatureSecret).update(rawBody).digest('hex')}},payload);
  };
  const emit=async(external,observed=pricing,status='delivered',timestamp=String(Math.floor(Date.now()/1000)))=>{
   return emitStatuses([{id:external,status,timestamp,recipient_user_id:'SA.SyntheticCost',...(observed===undefined?{}:{pricing:observed})}]);
  };
  const drain=()=>processor.drainTenant(fixture.tenantId);
  const drainWhenDue=async()=>{
   const row=(await fixture.tx(fixture.worker,fixture.tenantId,c=>c.query("SELECT min(available_at) due FROM event_inbox WHERE tenant_id=$1 AND status='FAILED_RETRYABLE'",[fixture.tenantId]))).rows[0];
   if(row?.due){const delay=Math.max(0,new Date(row.due).getTime()-Date.now()+10);assert.ok(delay<=60_000,'Unexpected receipt retry delay');if(delay)await new Promise(resolve=>setTimeout(resolve,delay));}
   return drain();
  };
  const begin=async(queueOptions)=>{const queued=await fixture.queue(queueOptions);await fixture.outbox.beginSend(queued.job,queued.lease);await fixture.outbox.admitMetaMessageRequest(queued.job,queued.lease,sha('Synthetic exact final Messages request'),fixture.runtimeCandidate);return{...queued,external:`wamid.synthetic-cost-${randomUUID()}`};};
  const complete=async effect=>fixture.outbox.complete(effect.job,effect.lease,'SENT',effect.external);
  const deliver=async(queueOptions)=>{const effect=await begin(queueOptions);await complete(effect);await emit(effect.external);await drain();await reassess(effect.job.id);return effect;};
  const close=async()=>{if(closed)return;closed=true;if(priorSecret===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=priorSecret;await database.onModuleDestroy();await fixture.close();};
  return{...fixture,database,from,to,definition,operator,accepted,customerDraft,upstreamDraft,selector,pricing,heads,usage,reassess,emit,emitStatuses,drain,drainWhenDue,begin,complete,deliver,close};
 }catch(error){if(priorDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorDatabase;if(priorSecret===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=priorSecret;await database?.onModuleDestroy();await fixture.close();throw error;}
}

function decimal(value){return String(value).replace(/(\.\d*?)0+$/u,'$1').replace(/\.$/u,'');}
export async function verifyMetaCostMoneyAndCorrections(options){
 const proofs=[];
 for(const [rounding,currency,minorUnits,unitPrice,count,expected] of [['LINE','USD',2,'0.005',2,'0.02'],['PERIOD','USD',2,'0.005',2,'0.01'],['LINE','KWD',3,'0.0005',1,'0.001'],['LINE','JPY',0,'0.5',1,'1']]){
  const f=await createMetaCostScenario(options,{rounding,currency,minorUnits,unitPrice});
  try{
   const effects=[];for(let i=0;i<count;i++)effects.push(await f.deliver());
   const snapshot=await f.usage();assert.equal(snapshot.complete,true);
   for(const purpose of ['UPSTREAM_REFERENCE','CUSTOMER_TARIFF']){
    const totals=snapshot.totals.filter(row=>row.purpose===purpose);assert.equal(totals.length,1);assert.equal(decimal(totals[0].amount),expected);assert.equal(totals[0].evidenceMode,'SIMULATED');assert.equal(totals[0].quantity,count);
   }
   if(rounding==='PERIOD'){
    const partial=await f.usage(f.from,new Date(Date.parse(f.to)-1).toISOString());assert.equal(partial.totals.length,2);assert(partial.totals.every(row=>row.partialPeriod&&row.amount===null));
    const effect=effects[0],before=await f.heads(effect.job.id),upstream=before.find(row=>row.purpose==='UPSTREAM_REFERENCE');
    const body={purpose:'UPSTREAM_REFERENCE',items:[{deliveryId:effect.job.id,expectedHeadId:upstream.id,selectorEvidence:{...f.selector,tier:'UNAVAILABLE'}}]};
    const raced=await Promise.allSettled([f.operator('META_COST_REASSESS',f.accountId,body),f.operator('META_COST_REASSESS',f.accountId,body)]);
    assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);assert.equal(raced.filter(result=>result.status==='rejected'&&result.reason.code==='40001').length,1);
    const after=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');assert.equal(after.state,'UNPRICED');
    await f.operator('META_COST_REASSESS',f.accountId,{purpose:'UPSTREAM_REFERENCE',items:[{deliveryId:effect.job.id,expectedHeadId:after.id,selectorEvidence:f.selector}]});
    const restored=(await f.heads(effect.job.id)).find(row=>row.purpose==='UPSTREAM_REFERENCE');assert.equal(restored.state,'ESTIMATED');assert.notEqual(restored.id,upstream.id);
    const history=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT id,predecessor_id FROM meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2 AND purpose=$3',[f.tenantId,effect.job.id,'UPSTREAM_REFERENCE']))).rows;
    assert.equal(history.filter(row=>row.predecessor_id===upstream.id).length,1);assert.equal(history.filter(row=>row.predecessor_id===after.id).length,1);
    const attempts=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT state,external_message_id FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,effect.job.id]))).rows;assert.equal(attempts.length,1);assert.equal(attempts[0].external_message_id,effect.external);
   }
   proofs.push({rounding,currency,minorUnits,count,expected,mode:'SIMULATED'});
  }finally{await f.close();}
 }
 return proofs;
}

export async function verifyMetaCostCausalOrders(options){
 const f=await createMetaCostScenario(options);
 try{
  const early=await f.begin();await f.emit(early.external);await f.drain();assert.equal((await f.heads(early.job.id)).length,0);
  await f.complete(early);const beforeReceipt=await f.heads(early.job.id);assert(beforeReceipt.length>0&&beforeReceipt.every(row=>row.state!=='ESTIMATED'));
  await f.drainWhenDue();await f.reassess(early.job.id);assert((await f.heads(early.job.id)).every(row=>row.state==='ESTIMATED'));
  const unknown=await f.begin();await f.outbox.outcomeUnknown(unknown.job,unknown.lease,'Synthetic Messages uncertainty');await f.emit(unknown.external);await f.drain();
  const unresolved=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[f.tenantId,unknown.job.id,unknown.external]))).rows[0].value;
  assert.equal(unresolved.state,'UNKNOWN_ATTRIBUTION');assert.equal((await f.heads(unknown.job.id)).some(row=>row.state==='ESTIMATED'),false);
  const late=await f.begin();await f.complete(late);assert((await f.heads(late.job.id)).every(row=>row.state==='UNPRICED'&&row.reason==='NOT_DELIVERED'));
  const timestamp=String(Math.floor(Date.now()/1000));await f.emit(late.external,f.pricing,'delivered',timestamp);await f.drain();await f.reassess(late.job.id);
  const first=(await f.heads(late.job.id)).map(row=>row.id);await f.emit(late.external,f.pricing,'delivered',timestamp);await f.drain();assert.deepEqual((await f.heads(late.job.id)).map(row=>row.id),first);
  await f.emit(late.external,{...f.pricing,billable:false,category:'utility',type:'free_customer_service'},'delivered',timestamp);await f.drain();
  assert((await f.heads(late.job.id)).every(row=>row.state==='CONFLICTED'));
  const ordered=await f.begin();await f.complete(ordered);
  await f.emitStatuses([{id:ordered.external,status:'read',timestamp}]);await f.drain();
  assert((await f.heads(ordered.job.id)).every(row=>row.state==='UNPRICED'&&row.amount===null));
  await f.emit(ordered.external,f.pricing,'read',timestamp);await f.drain();
  assert((await f.heads(ordered.job.id)).every(row=>row.reason==='MISSING_DELIVERY_TIME'));
  await f.emit(ordered.external,f.pricing,'delivered',timestamp);await f.drain();await f.reassess(ordered.job.id);
  const state=async()=>(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT state,external_message_id FROM delivery_outbox WHERE tenant_id=$1 AND id=$2',[f.tenantId,ordered.job.id]))).rows[0];
  const beforeFailed=await state();await f.emitStatuses([{id:ordered.external,status:'failed',timestamp:String(Number(timestamp)+1),errors:[{code:131000,title:'Synthetic late failure'}]}]);await f.drain();
  assert.deepEqual(await state(),beforeFailed);assert((await f.heads(ordered.job.id)).every(row=>row.state==='ESTIMATED'));
  return{beforeResponseCatchup:true,successWithoutPricing:true,unknownNotGuessed:true,duplicateOneEffect:true,pricingConflict:true};
 }finally{await f.close();}
}

/** Ordinary queued privacy request + the incumbent real lease function. This
 * never seeds a RUNNING job, finance authority, admitted attempt or outcome. */
export async function createMetaCostPrivacyJob(f,scopeType,scopeValue,jobType='EXPORT'){
 assert.ok(['EXPORT','DELETE','RETENTION_SWEEP'].includes(jobType));
 const id=randomUUID(),requestId=jobType==='RETENTION_SWEEP'?null:randomUUID(),disposition=jobType==='EXPORT'?'EXPORT_ONLY':jobType==='DELETE'?'DELETE_TICKETS':'RETENTION_DELETE';
 await f.tx(f.app,f.tenantId,async client=>{
  if(requestId)await client.query(`INSERT INTO privacy_requests(id,tenant_id,request_type,scope_type,scope_value,scope_sha256,disposition,idempotency_key,request_sha256,requested_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[requestId,f.tenantId,jobType,scopeType,scopeValue,sha(scopeType+'\0'+scopeValue),disposition,randomUUID(),sha(id),f.actorId]);
  await client.query(`INSERT INTO privacy_jobs(id,tenant_id,request_id,job_type,scope_type,scope_value,disposition,idempotency_key,unmatched_diagnostic_hours_snapshot)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,f.tenantId,requestId,jobType,scopeType,scopeValue,disposition,randomUUID(),jobType==='RETENTION_SWEEP'?24:null]);
 });
 return claimMetaCostPrivacyJob(f,id);
}

export async function claimMetaCostPrivacyJob(f,id){
 const lease=randomUUID();
 const rows=(await f.tx(f.worker,f.tenantId,client=>client.query(`SELECT j.*,to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_text FROM app.claim_privacy_jobs($1,1) j`,[lease]))).rows;
 assert.equal(rows.length,1);const row=rows[0];assert.equal(row.id,id);
 const requestId=row.request_id,jobType=row.job_type,scopeType=row.scope_type,scopeValue=row.scope_value,disposition=row.disposition;
 // No installed Zammad instance exists in this domain fixture. Mirror the
 // repository claim's request-state update after the real lease is returned.
 if(requestId)await f.tx(f.worker,f.tenantId,client=>client.query("UPDATE privacy_requests SET state='RUNNING',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='QUEUED'",[f.tenantId,requestId]));
 const job={id,tenantId:f.tenantId,requestId:requestId??undefined,lease,jobType,scopeType,scopeValue,disposition,state:row.state,stage:row.stage,
  attempts:row.attempts,maxAttempts:row.max_attempts,fencingToken:Number(row.fencing_token),createdAt:row.created_at_text,
  zammadBaseUrl:'https://privacy.invalid',zammadPrivacySecretReference:'secret://synthetic/privacy',unmatchedDiagnosticHours:24,exportTtlHours:24};
 if(jobType==='EXPORT'){await new PrivacyRepository(f.worker).discover(job,lease);job.stage='EXPORT';}
 return job;
}

/** Ordinary case correlation only. Financial birth/admission and selected
 * effects continue to come from the actual P08/P10 producers. */
export async function linkMetaCostReference(f,effect,ticket,reference){
 const family=randomUUID(),rule=randomUUID(),binding=randomUUID();
 // These ordinary correlation rows are explicitly synthetic admin setup.
 // App/worker tariff, receipt, admission and effect authority remains unchanged.
 await withFixtureTenant(f.admin,f.tenantId,async()=>{
  const c=f.admin;
  await c.query('INSERT INTO public.rule_families(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)',[family,f.tenantId,`cost-reference-${family}`,f.actorId]);
  await c.query("INSERT INTO public.rule_sets(id,tenant_id,family_id,name,version,state,snapshot_sha256,created_by) VALUES($1,$2,$3,$4,1,'DRAFT',encode(digest('[]','sha256'),'hex'),$5)",[rule,f.tenantId,family,`cost-reference-${rule}`,f.actorId]);
  await c.query(`INSERT INTO group_bindings(id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
   VALUES($1,$2,$3,$4,'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'DRAFT')`,[binding,f.tenantId,effect.job.groupWorkspaceGroupId,rule]);
  await c.query("INSERT INTO case_correlations(tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state) VALUES($1,$2,$3,$4,$4,'RESOLVED')",[f.tenantId,binding,reference,ticket]);
  await c.query('INSERT INTO public.delivery_ticket_links(tenant_id,delivery_id,zammad_ticket_id) VALUES($1,$2,$3)',[f.tenantId,effect.job.id,ticket]);
 });
 return binding;
}
