import assert from 'node:assert/strict';
import {Client} from 'pg';
import {createMetaCostScenario,createMetaCostPrivacyJob,linkMetaCostReference} from './meta-cost-scenarios-postgres.mjs';
import {metaCostShadowDefinitions,verifyMetaCostTimezoneLookup,verifyMetaCostScopedLookup,verifyMetaCostForgedLookup,
 verifyMetaCostSchemaPrivileges,verifyMetaReceiptLookup,verifyMetaReceiptRedactionWindow} from './meta-cost-lookup-postgres.mjs';
import {assertMetaCostPrivacyArtifact} from './privacy-artifact-oracle.mjs';
import {PrivacyRepository} from '../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js';
import {PrivacyProcessor} from '../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js';

/** Complete orchestration of the independently reviewed lookup/artifact
 * helpers. Admin reads only its isolated fixture rows and catalog definitions;
 * all payer/mode/attempt/tariff/receipt/privacy mutations use their real domains. */
export async function verifyMetaCostLookupAndPrivacy(options){
 const f=await createMetaCostScenario(options),admin=new Client({connectionString:options.adminUrl});
 let foreign,redactionClient;
 try{
  await admin.connect();const participant='12025550165@c.us',reference='P10-SCOPED-730001';
  const kept=await f.deliver({mentions:[participant]}),redacted=await f.deliver(),unrelated=await f.deliver();
  await linkMetaCostReference(f,kept,'730001',reference);
  // Distinct real native ticket references are ordinary fixture correlation;
  // birth, admission, send body/account and successful attempt remain untouched.
  await f.tx(f.app,f.tenantId,c=>c.query('INSERT INTO public.delivery_ticket_links(tenant_id,delivery_id,zammad_ticket_id) VALUES($1,$2,$4),($1,$3,$5)',
   [f.tenantId,redacted.job.id,unrelated.job.id,'730002','730003']));
  const origin=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT id,delivery_origin,zammad_ticket_id,zammad_article_id FROM public.delivery_outbox WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.tenantId,[kept.job.id,redacted.job.id,unrelated.job.id]]))).rows;
  assert.equal(origin.length,3);assert(origin.every(row=>row.delivery_origin==='GROUP_WORKSPACE'&&row.zammad_ticket_id===null&&row.zammad_article_id===null));
  // Retain two real, nonredacted selector revisions for the scoped artifact.
  await f.reassess(kept.job.id,{...f.selector,tier:'UNAVAILABLE'});await f.reassess(kept.job.id);
  const scope={tenantId:f.tenantId,accountId:f.accountId,from:f.from,to:f.to},definitions=await metaCostShadowDefinitions(admin);
  const historical=(await f.tx(f.worker,f.tenantId,c=>c.query('SELECT app.resolve_meta_message_effect($1,$2,$3) value',[f.tenantId,kept.job.id,kept.external]))).rows[0].value;
  assert.equal(historical.state,'ATTRIBUTED');
  const effect={...scope,deliveryId:kept.job.id,externalMessageId:kept.external,attemptId:historical.effect.attemptId,customerTariffId:f.customerDraft.id,policyVersionId:f.accepted.policyVersionId};
  const configs={appConfig:{connectionString:options.appUrl},workerConfig:options.workerConfig,
   platformConfig:{connectionString:options.platformOperationsUrl,options:'-c role=wasalx_platform_operations_client'}};
  await verifyMetaCostSchemaPrivileges(configs);
  await verifyMetaCostTimezoneLookup({...configs,definitions,scope,definition:f.definition('UPSTREAM_REFERENCE')});
  await verifyMetaCostScopedLookup({...configs,definitions,scope,foreignTenantId:f.foreignTenantId,effect});
  const publicRows={};
  for(const name of ['delivery_outbox','delivery_attempts','delivery_receipts','meta_messaging_accounts','meta_connection_account_bindings','meta_billing_policy_versions','meta_cost_tariff_versions','meta_cost_assessments'])
   publicRows[name]=(await admin.query(`SELECT * FROM public.${name} WHERE tenant_id=$1`,[f.tenantId])).rows;
  await verifyMetaCostForgedLookup({...configs,definitions,scope,effect,publicRows,expectedSnapshot:await f.usage()});

  const keptReceipt=publicRows.delivery_receipts.find(row=>row.delivery_id===kept.job.id),redactedReceiptId=publicRows.delivery_receipts.find(row=>row.delivery_id===redacted.job.id).id;
  redactionClient=new Client({...options.workerConfig,statement_timeout:15000,query_timeout:17000});await redactionClient.connect();
  await redactionClient.query('SET search_path=pg_catalog,public,app,pg_temp');
  await redactionClient.query(`CREATE TEMP TABLE delivery_outbox (${definitions.delivery_outbox})`);await redactionClient.query('GRANT SELECT ON pg_temp.delivery_outbox TO PUBLIC');
  const query=redactionClient.query.bind(redactionClient);let redactionCallback=0;
  // The repository's actual delivery UPDATE precedes its actual receipt UPDATE
  // in the same leased transaction. Intercept only that boundary to exercise the
  // reviewed inherited-trigger oracle; no production callback is added.
  redactionClient.query=async(sql,...args)=>{
   if(typeof sql==='string'&&/UPDATE\s+delivery_receipts\b/iu.test(sql)&&redactionCallback===0){
    await verifyMetaReceiptRedactionWindow({query},f.tenantId,redactedReceiptId);redactionCallback++;
   }
   return query(sql,...args);
  };
  const leasedClient={query:(...args)=>redactionClient.query(...args),release:()=>{}},privacy=new PrivacyRepository({connect:async()=>leasedClient});
  const deletion=await createMetaCostPrivacyJob(f,'ZAMMAD_TICKET','730002','DELETE'),previousFetch=globalThis.fetch;let ticketDeletes=0;
  globalThis.fetch=async(url,init)=>{
   assert.equal(String(url),'https://privacy.invalid/api/v1/wasalx/privacy');assert.equal(init.method,'POST');
   const body=JSON.parse(init.body),target=(await privacy.targets(deletion)).find(row=>row.type==='ZAMMAD_TICKET'&&row.targetId==='730002');assert(target);
   assert.deepEqual(body,{job_id:deletion.id,lease_id:deletion.lease,fencing_token:deletion.fencingToken,target_id:target.id,attempt:target.attempts,operation:'DELETE_TICKET',native_id:'730002'});
   assert.equal(target.attempts,1);ticketDeletes++;return new Response(null,{status:204});
  };
  try{
   const processor=new PrivacyProcessor(privacy,{resolve:async()=>({token:'synthetic-only-privacy-token'})},{put:async()=>assert.fail('Deletion cannot upload'),delete:async()=>assert.fail('No storage target was created')});
   const summary=await processor.process(deletion,deletion.lease);assert.notEqual(summary,'deferred');assert.equal(await privacy.complete(deletion,deletion.lease,summary),true);
  }finally{globalThis.fetch=previousFetch;}
  assert.equal(ticketDeletes,1);assert.equal(redactionCallback,1);
  const actualRedactedReceipt=(await admin.query('SELECT * FROM public.delivery_receipts WHERE id=$1',[redactedReceiptId])).rows[0];
  const actualRedactedDelivery=(await admin.query('SELECT * FROM public.delivery_outbox WHERE id=$1',[redacted.job.id])).rows[0];
  const actualKeptDelivery=(await admin.query('SELECT * FROM public.delivery_outbox WHERE id=$1',[kept.job.id])).rows[0];
  await verifyMetaReceiptLookup({...configs,definitions,scope,unredactedReceipt:keptReceipt,redactedReceipt:actualRedactedReceipt,
   unredactedDelivery:actualKeptDelivery,redactedDelivery:actualRedactedDelivery});
  // Append-only assessment history retains its original state. The scoped
  // projection masks the amount and exposes EVIDENCE_REDACTED instead.
  assert((await f.heads(redacted.job.id)).every(row=>row.evidence_redacted_at!==null));
  const redactedProjection=(await f.usage()).rows.filter(row=>row.deliveryId===redacted.job.id);
  assert.equal(redactedProjection.length,2);assert(redactedProjection.every(row=>row.state==='UNATTRIBUTED'&&row.reason==='EVIDENCE_REDACTED'&&row.amount===null));
  const before=(await f.heads(redacted.job.id)).map(row=>row.id);await f.emit(redacted.external);await f.drain();assert.deepEqual((await f.heads(redacted.job.id)).map(row=>row.id),before);

  // A second constructor produces actual foreign effects. Its simulated fetch
  // is serialized and restored by the P08 owner before returning.
  foreign=await createMetaCostScenario(options);const foreignEffect=await foreign.deliver();
  const foreignIds=(await foreign.heads(foreignEffect.job.id)).map(row=>row.id);assert.equal(foreignIds.length,2);
  const redactedIds=(await admin.query('SELECT id FROM meta_cost_assessments WHERE tenant_id=$1 AND delivery_id=$2',[f.tenantId,redacted.job.id])).rows.map(row=>row.id);
  const unrelatedIds=(await f.heads(unrelated.job.id)).map(row=>row.id),regularPrivacy=new PrivacyRepository(f.worker);
  for(const scopeType of ['TENANT','ZAMMAD_TICKET','PARTICIPANT','REFERENCE']){
   const scopeValue=scopeType==='TENANT'?f.tenantId:scopeType==='PARTICIPANT'?participant:scopeType==='REFERENCE'?reference:'730001';
   const job=await createMetaCostPrivacyJob(f,scopeType,scopeValue,'EXPORT');
   const expected=await regularPrivacy.exportData(job,job.lease);assert(expected.metaCostAssessments.length>=2);assert(expected.metaCostAssessments.every(row=>row.evidence_redacted_at===null));
   if(scopeType==='TENANT')assert(unrelatedIds.every(id=>expected.metaCostAssessments.some(row=>row.id===id)));
   else assert(expected.metaCostAssessments.every(row=>row.delivery_id===kept.job.id));
   let uploaded;const previous=globalThis.fetch;
   globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://privacy.invalid/api/v1/wasalx/privacy');assert.equal(init.method,'POST');const body=JSON.parse(init.body);
    assert(['730001','730003'].includes(body.native_id));assert(['READ_TICKET','READ_ARTICLES'].includes(body.operation));
    assert.deepEqual(body,{job_id:job.id,lease_id:job.lease,fencing_token:job.fencingToken,attempt:0,operation:body.operation,native_id:body.native_id});
    return body.operation==='READ_TICKET'?Response.json({id:Number(body.native_id),title:'Synthetic export ticket'}):Response.json([]);
   };
   try{
    const processor=new PrivacyProcessor(regularPrivacy,{resolve:async()=>({token:'synthetic-only-privacy-token'})},{put:async(_key,bytes)=>{uploaded=Uint8Array.from(bytes);},delete:async()=>assert.fail('Export cannot delete')});
    const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert(uploaded);
    assertMetaCostPrivacyArtifact({bytes:uploaded,summary,expectedAssessments:expected.metaCostAssessments,expectedTariffs:expected.metaCostTariffs,
     scopeType,excludedAssessmentIds:[...redactedIds,...foreignIds,...(scopeType==='TENANT'?[]:unrelatedIds)]});
    assert.equal(await regularPrivacy.complete(job,job.lease,summary),true);
   }finally{globalThis.fetch=previous;}
  }
  return{timezoneFreshSessionNegative:true,forgedLookupIgnored:true,realScopedPositive:true,receiptInheritedCallback:true,
   actualRedactionNoRestoration:true,actualScopedSerializedArtifacts:true,providerAndStorage:'DETERMINISTIC_TEST_DOUBLES'};
 }finally{if(foreign)await foreign.close();if(redactionClient)await redactionClient.end().catch(()=>undefined);await admin.end().catch(()=>undefined);await f.close();}
}
